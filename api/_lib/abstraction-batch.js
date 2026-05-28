// Server-side multi-chunk abstraction batches (mirrors browser fallback batching).

import {
  ABSTRACTION_PROMPT,
  BATCH_ABSTRACT_RESPONSE_SCHEMA,
  buildAbstractMessagesForChunks,
  enrichVisualDeliveryForModel,
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
const MAX_DOCS_PER_BATCH = clampInt(process.env.ABSTRACTION_BATCH_MAX_DOCS, 24, 1, 48);
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

function isCsvChunk(chunk) {
  return chunk.mediaType === 'text/csv' || /\.csv$/i.test(chunk.originalFilename || '');
}

function isPdfChunk(chunk) {
  return chunk.mediaType === 'application/pdf' || /\.pdf$/i.test(chunk.originalFilename || '');
}

export function estimateChunkPayloadBytes(chunk, payloadBytes = null, delivery = null) {
  return estimateAbstractPayloadBytes(chunk, payloadBytes, delivery);
}

export function chunkRequiresSoloBatch(chunk, estimatedPayload = null) {
  const payload = estimatedPayload ?? estimateChunkPayloadBytes(chunk);
  if (payload > LARGE_CHUNK_BYTES) return true;
  if (chunk.pageStart && chunk.pageEnd && isPdfChunk(chunk)) {
    const span = chunk.pageEnd - chunk.pageStart + 1;
    if (span > MAX_BATCH_PAGE_SPAN) return true;
  }
  return false;
}

/**
 * Group ready chunks into multi-doc batches and solo queues.
 */
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

async function claimChunkWithLease(store, chunk, workerId, leaseMs) {
  if (store.claimChunkForAbstraction) {
    return await store.claimChunkForAbstraction(chunk.jobId, chunk.id, { workerId, leaseMs });
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

/**
 * Abstract multiple chunks in one Anthropic request.
 */
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
  const globalStart = Number.isInteger(options.globalStart) ? options.globalStart : (chunks[0].chunkOrder || 0);
  const startedAt = Date.now();
  const blobLoader = getBlobLoader(options);

  const claimed = [];
  for (const chunk of chunks) {
    const processing = await claimChunkWithLease(store, chunk, workerId, leaseMs);
    if (!processing) {
      claimed.push({ status: 'skipped', chunkId: chunk.id });
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
    return [...finished, await processChunkAbstraction(ready[0].chunk, { ...options, workerId, leaseMs })];
  }

  try {
    const preparedItems = await Promise.all(ready.map(async entry => {
      const payload = await blobLoader(entry.chunk);
      const delivery = await enrichVisualDeliveryForModel(
        await resolveChunkDelivery(entry.chunk, payload.bytes),
        entry.chunk,
        payload.bytes,
        config.model,
      );
      return {
        chunk: entry.chunk,
        payloadBytes: payload.bytes,
        delivery,
      };
    }));

    const messages = buildAbstractMessagesForChunks(preparedItems, globalStart);
    const payloadBytes = estimateRequestBytes(config.model, config.maxTokens, ABSTRACTION_PROMPT, messages);
    if (payloadBytes > REQUEST_ENVELOPE_SAFE_BYTES) {
      if (ready.length > 2) {
        const mid = Math.ceil(ready.length / 2);
        const leftResults = await processMultiChunkAbstraction(
          ready.slice(0, mid).map(entry => entry.chunk),
          { ...options, globalStart, workerId, leaseMs },
        );
        const rightResults = await processMultiChunkAbstraction(
          ready.slice(mid).map(entry => entry.chunk),
          { ...options, globalStart: globalStart + mid, workerId, leaseMs },
        );
        return [...finished, ...leftResults, ...rightResults];
      }
      return [...finished, ...await fallbackToSingles(ready.map(entry => entry.chunk), options, 'payload_too_large')];
    }

    const modelResult = await runModelAbstraction({
      messages,
      model: config.model,
      maxTokens: config.maxTokens,
      payloadBytes,
      escalationModel: config.escalationModel,
      escalationMaxTokens: config.escalationMaxTokens,
      responseSchema: BATCH_ABSTRACT_RESPONSE_SCHEMA,
      options,
    });
    const parsed = parseBatchAbstracts(modelResult.text, preparedItems, globalStart);
    const perChunkPayload = Math.floor(payloadBytes / preparedItems.length);
    const batchResults = [];
    const fallbackChunks = [];
    for (let i = 0; i < preparedItems.length; i++) {
      const item = preparedItems[i];
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
              ? Math.floor(modelResult.usage.inputTokens / preparedItems.length)
              : null,
            outputTokens: modelResult.usage.outputTokens != null
              ? Math.floor(modelResult.usage.outputTokens / preparedItems.length)
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
        options,
        `batch_parse_partial:${fallbackChunks.length}/${preparedItems.length}`,
      );
      batchResults.push(...partialResults);
    }
    return [...finished, ...batchResults];
  } catch (err) {
    return [...finished, ...await fallbackToSingles(ready.map(entry => entry.chunk), options, err?.message || String(err))];
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
