
import {
  ABSTRACTION_PROMPT,
  BATCH_ABSTRACT_RESPONSE_SCHEMA,
  buildAbstractMessagesForChunks,
  estimateAbstractPayloadBytes,
  estimateRequestBytes,
  getAbstractionConfig,
  parseBatchAbstracts,
  persistCompletedAbstract,
  processChunkAbstraction,
  resolveChunkDelivery,
  runModelAbstraction,
  getBlobLoader,
  stripDocumentLabel,
  tryReuseExistingAbstract,
  validateAbstractPersistenceInput,
} from './abstraction.js';

const REQUEST_ENVELOPE_SAFE_BYTES = clampInt(process.env.REQUEST_ENVELOPE_SAFE_BYTES, 18_000_000, 100_000, 20_000_000);
const MAX_PAYLOAD_BYTES = REQUEST_ENVELOPE_SAFE_BYTES - 350_000;
const MAX_DOCS_PER_BATCH = clampInt(process.env.ABSTRACTION_BATCH_MAX_DOCS, 6, 1, 48);
const LARGE_CHUNK_BYTES = clampInt(process.env.ABSTRACTION_BATCH_LARGE_BYTES, 2_000_000, 100_000, 8_000_000);
const MAX_BATCH_PAGE_SPAN = clampInt(process.env.ABSTRACTION_BATCH_MAX_PAGE_SPAN, 32, 4, 120);
function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function isAbstractionBatchingEnabled() {
  return process.env.ABSTRACTION_BATCH_ENABLED !== 'false';
}

function isImageChunk(chunk) {
  return Boolean(chunk?.renderedImages) || /^image\/[-+.a-z0-9]+$/i.test(chunk?.mediaType || '');
}

function isPdfChunk(chunk) {
  return !chunk?.renderedImages && (chunk?.mediaType === 'application/pdf' || /\.pdf$/i.test(chunk?.originalFilename || ''));
}

function isCsvChunk(chunk) {
  return !chunk?.renderedImages && (chunk?.mediaType === 'text/csv' || /\.csv$/i.test(chunk?.originalFilename || ''));
}

function isTextBatchableItem(item) {
  if (isCsvChunk(item.chunk)) return true;
  return isPdfChunk(item.chunk) && item.delivery?.mode === 'text' && Boolean(String(item.delivery.extractedText || '').trim());
}

export function estimateChunkPayloadBytes(chunk, payloadBytes = null, delivery = null) {
  return estimateAbstractPayloadBytes(chunk, payloadBytes, delivery);
}

export function chunkRequiresSoloBatch(chunk, estimatedPayload = null) {
  if (isImageChunk(chunk)) return true;
  if (isPdfChunk(chunk)) {
    const largePdfSoloBytes = clampInt(process.env.GEMINI_FILE_API_MIN_BYTES, 1_500_000, 250_000, 10_000_000);
    if (Number.isFinite(Number(chunk?.sizeBytes)) && Number(chunk.sizeBytes) >= largePdfSoloBytes) {
      return true;
    }
    if (chunk.pageStart && chunk.pageEnd) {
      const span = chunk.pageEnd - chunk.pageStart + 1;
      if (span > MAX_BATCH_PAGE_SPAN) return true;
    }
  }
  const payload = estimatedPayload ?? estimateChunkPayloadBytes(chunk);
  if (payload > LARGE_CHUNK_BYTES) return true;
  return false;
}

export function planAbstractionWork(chunks) {
  const singles = [];
  const batches = [];
  if (!isAbstractionBatchingEnabled() || !chunks.length) {
    return { batches, singles: chunks.slice() };
  }

  let current = [];
  let currentPayload = 0;
  let globalStart = 0;

  for (const chunk of chunks) {
    const estimated = estimateChunkPayloadBytes(chunk);
    const solo = chunkRequiresSoloBatch(chunk, estimated);

    if (solo && !current.length) {
      singles.push(chunk);
      continue;
    }

    if (current.length && (
      current.length >= MAX_DOCS_PER_BATCH
      || currentPayload + estimated > MAX_PAYLOAD_BYTES
      || solo
    )) {
      batches.push({ chunks: current.slice(), globalStart });
      globalStart += current.length;
      current = [];
      currentPayload = 0;
    }

    if (solo) {
      singles.push(chunk);
      continue;
    }

    current.push(chunk);
    currentPayload += estimated;
  }

  if (current.length) {
    batches.push({ chunks: current.slice(), globalStart });
  }

  return { batches, singles };
}

async function claimChunkWithLease(store, chunk, workerId, leaseMs, maxAttempts) {
  if (store.claimChunkForAbstraction) {
    return await store.claimChunkForAbstraction(chunk.jobId, chunk.id, { workerId, leaseMs, maxAttempts });
  }
  if (store.markChunkAbstractionProcessing) {
    return await store.markChunkAbstractionProcessing(chunk.jobId, chunk.id);
  }
  return chunk;
}

async function completeReusedAbstract(store, chunk, workerId, reuse, sequenceIndex, startedAt) {
  const record = {
    jobId: chunk.jobId,
    documentId: chunk.documentId,
    chunkId: chunk.id,
    abstractText: stripDocumentLabel(reuse.abstractText, sequenceIndex + 1),
    modelUsed: reuse.modelUsed,
    payloadBytes: 0,
    latencyMs: Date.now() - startedAt,
    inputTokens: 0,
    outputTokens: 0,
    status: 'completed',
    attemptCount: Math.max(1, Number(chunk.abstractionAttempts) || 1),
    workerId,
  };
  const validation = validateAbstractPersistenceInput(record);
  if (!validation.valid) {
    const error = new Error(validation.reason);
    error.status = 500;
    throw error;
  }
  const saved = await store.saveDocumentAbstract(record, { reuseSource: reuse.source });
  if (!saved) return { status: 'stale', chunkId: chunk.id };
  return { status: 'completed', chunkId: chunk.id, abstract: record, reused: true };
}

export async function processMultiChunkAbstraction(chunks, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to process abstraction batches.');
  if (!chunks.length) return [];
  if (chunks.length === 1) {
    return [await processChunkAbstraction(chunks[0], options)];
  }

  const config = getAbstractionConfig();
  const workerId = options.workerId || `wkr_${Math.random().toString(36).slice(2, 10)}`;
  const leaseMs = options.leaseMs || 90_000;
  const maxAttempts = options.maxAttempts || config.maxAttempts;
  const globalStart = Number.isInteger(options.globalStart) ? options.globalStart : (chunks[0].chunkOrder || 0);
  const startedAt = Date.now();
  const blobLoader = getBlobLoader(options);

  const claimed = [];
  for (const chunk of chunks) {
    const processing = await claimChunkWithLease(store, chunk, workerId, leaseMs, maxAttempts);
    if (!processing) {
      claimed.push({ status: 'skipped', chunkId: chunk.id });
      continue;
    }
    if (processing.abstractionStatus === 'failed') {
      claimed.push({
        status: 'failed',
        chunkId: processing.id,
        failure: {
          errorType: processing.abstractionErrorType || 'max_attempts',
          errorMessage: processing.abstractionErrorMessage || 'Abstraction attempt limit exceeded.',
        },
      });
      continue;
    }
    const reuse = await tryReuseExistingAbstract(store, processing, workerId);
    if (reuse) {
      claimed.push(await completeReusedAbstract(store, processing, workerId, reuse, processing.chunkOrder || 0, startedAt));
      continue;
    }
    claimed.push({ status: 'claimed', chunk: processing });
  }

  const ready = claimed.filter(entry => entry.status === 'claimed');
  const finished = claimed.filter(entry => entry.status !== 'claimed');
  if (!ready.length) return finished;
  if (ready.length === 1) {
    return [...finished, await processChunkAbstraction(ready[0].chunk, { ...options, workerId, leaseMs, maxAttempts })];
  }

  let preparedItems;
  try {
    const preparations = await Promise.allSettled(ready.map(async (entry, batchPosition) => {
      const payload = await blobLoader(entry.chunk);
      const delivery = await resolveChunkDelivery(entry.chunk, payload.bytes);
      return {
        chunk: entry.chunk,
        payload,
        payloadBytes: payload.bytes,
        delivery,
        batchPosition,
      };
    }));
    const failedPreparation = preparations.find(result => result.status === 'rejected');
    if (failedPreparation) {
      preparations.length = 0;
      throw failedPreparation.reason;
    }
    preparedItems = preparations.map(result => result.value);
    preparations.length = 0;
  } catch (err) {
    return [...finished, ...await fallbackToSingles(ready.map(entry => entry.chunk), { ...options, workerId, leaseMs, maxAttempts }, err?.message || String(err))];
  }

  const textItems = [];
  const visualItems = [];
  for (const item of preparedItems) {
    if (isTextBatchableItem(item)) textItems.push(item);
    else visualItems.push(item);
  }
  preparedItems.length = 0;

  const visualResults = [];
  for (const item of visualItems) {
    visualResults.push(await runSoloPreparedItem(item, options, { workerId, leaseMs, maxAttempts, globalStart }));
  }

  if (!textItems.length) {
    return [...finished, ...visualResults];
  }
  if (textItems.length === 1) {
    const soloText = await runSoloPreparedItem(textItems[0], options, { workerId, leaseMs, maxAttempts, globalStart });
    return [...finished, ...visualResults, soloText];
  }

  try {
    const messages = buildAbstractMessagesForChunks(textItems, globalStart);
    const payloadBytes = estimateRequestBytes(config.model, config.maxTokens, ABSTRACTION_PROMPT, messages);
    if (payloadBytes > REQUEST_ENVELOPE_SAFE_BYTES) {
      if (textItems.length > 2) {
        const mid = Math.ceil(textItems.length / 2);
        const leftResults = await processMultiChunkAbstraction(
          textItems.slice(0, mid).map(item => item.chunk),
          { ...options, globalStart, workerId, leaseMs, maxAttempts },
        );
        const rightResults = await processMultiChunkAbstraction(
          textItems.slice(mid).map(item => item.chunk),
          { ...options, globalStart: globalStart + mid, workerId, leaseMs, maxAttempts },
        );
        return [...finished, ...visualResults, ...leftResults, ...rightResults];
      }
      return [...finished, ...visualResults, ...await fallbackToSingles(textItems.map(item => item.chunk), { ...options, workerId, leaseMs, maxAttempts }, 'payload_too_large')];
    }

    const batchMaxTokens = Math.min(config.maxTokens * textItems.length, 65536);
    const modelResult = await runModelAbstraction({
      messages,
      model: config.model,
      maxTokens: batchMaxTokens,
      payloadBytes,
      escalationModel: config.escalationModel,
      escalationMaxTokens: config.escalationMaxTokens,
      responseSchema: BATCH_ABSTRACT_RESPONSE_SCHEMA,
      options,
    });
    const parsed = parseBatchAbstracts(modelResult.text, textItems, globalStart);
    const perChunkPayload = Math.floor(payloadBytes / textItems.length);
    const batchResults = [];
    const fallbackChunks = [];
    for (let i = 0; i < textItems.length; i++) {
      const item = textItems[i];
      const parsedItem = parsed[i];
      const text = String(parsedItem?.abstractText || '').trim();
      if (!text) {
        fallbackChunks.push(item.chunk);
        continue;
      }
      try {
        const saved = await persistCompletedAbstract({
          store,
          chunk: item.chunk,
          workerId,
          sequenceIndex: globalStart + i,
          abstractText: text,
          modelUsed: modelResult.model,
          payloadBytes: perChunkPayload,
          usage: {
            inputTokens: modelResult.usage.inputTokens != null
              ? Math.floor(modelResult.usage.inputTokens / textItems.length)
              : null,
            outputTokens: modelResult.usage.outputTokens != null
              ? Math.floor(modelResult.usage.outputTokens / textItems.length)
              : null,
          },
          latencyMs: Date.now() - startedAt,
          attemptCount: Math.max(1, Number(item.chunk.abstractionAttempts) || 1),
        });
        batchResults.push(saved);
      } catch (err) {
        fallbackChunks.push(item.chunk);
      }
    }
    if (fallbackChunks.length) {
      const partialResults = await fallbackToSingles(
        fallbackChunks,
        { ...options, workerId, leaseMs, maxAttempts },
        `batch_parse_partial:${fallbackChunks.length}/${textItems.length}`,
      );
      batchResults.push(...partialResults);
    }
    return [...finished, ...visualResults, ...batchResults];
  } catch (err) {
    return [...finished, ...visualResults, ...await fallbackToSingles(textItems.map(item => item.chunk), { ...options, workerId, leaseMs, maxAttempts }, err?.message || String(err))];
  }
}

async function runSoloPreparedItem(item, options, { workerId, leaseMs, maxAttempts, globalStart }) {
  try {
    return await processChunkAbstraction(item.chunk, {
      ...options,
      workerId,
      leaseMs,
      maxAttempts,
      sequenceIndex: Number.isInteger(item.chunk.chunkOrder)
        ? item.chunk.chunkOrder
        : (globalStart + item.batchPosition),
      preloadedPayload: { chunkId: item.chunk.id, payload: item.payload },
      preloadedDelivery: { chunkId: item.chunk.id, delivery: item.delivery },
    });
  } finally {
    item.payload = null;
    item.payloadBytes = null;
    item.delivery = null;
  }
}

async function fallbackToSingles(chunks, options, reason) {
  console.warn(JSON.stringify({
    event: 'abstraction_batch_fallback',
    chunkIds: chunks.map(chunk => chunk.id),
    reason,
  }));
  const results = [];
  for (const chunk of chunks) {
    results.push(await processChunkAbstraction(chunk, options));
  }
  return results;
}
