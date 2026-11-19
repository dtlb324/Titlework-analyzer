
import {
  ABSTRACTION_PROMPT,
  BATCH_ABSTRACT_RESPONSE_SCHEMA,
  addUsage,
  buildAbstractMessagesForChunks,
  buildEscalationQualityContext,
  enrichVisualDeliveryForModel,
  estimateAbstractPayloadBytes,
  estimateRequestBytes,
  evaluateAbstractEscalation,
  getAbstractionConfig,
  isAbstractionEscalationEnabled,
  parseBatchAbstracts,
  persistCompletedAbstract,
  processChunkAbstraction,
  resolveChunkDelivery,
  resolveEscalationMaxTokens,
  resolveEscalationModel,
  runChunkEscalation,
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

  const model = options.model || config.model;
  const escalationModel = options.escalationModel ?? resolveEscalationModel();
  const escalationMaxTokens = options.escalationMaxTokens ?? resolveEscalationMaxTokens();
  const escalationEnabled = isAbstractionEscalationEnabled({ model, escalationModel, options });

  try {
    const preparations = await Promise.allSettled(ready.map(async entry => {
      const payload = await blobLoader(entry.chunk);
      const delivery = await enrichVisualDeliveryForModel(
        await resolveChunkDelivery(entry.chunk, payload.bytes),
        entry.chunk,
        payload.bytes,
        model,
      );
      return {
        chunk: entry.chunk,
        payloadBytes: payload.bytes,
        delivery,
      };
    }));
    const failedPreparation = preparations.find(result => result.status === 'rejected');
    if (failedPreparation) {
      preparations.length = 0;
      throw failedPreparation.reason;
    }
    const preparedItems = preparations.map(result => result.value);
    preparations.length = 0;

    const messages = buildAbstractMessagesForChunks(preparedItems, globalStart);
    const payloadBytes = estimateRequestBytes(model, config.maxTokens, ABSTRACTION_PROMPT, messages);
    if (payloadBytes > REQUEST_ENVELOPE_SAFE_BYTES) {
      if (ready.length > 2) {
        const mid = Math.ceil(ready.length / 2);
        const leftResults = await processMultiChunkAbstraction(
          ready.slice(0, mid).map(entry => entry.chunk),
          { ...options, globalStart, workerId, leaseMs, maxAttempts },
        );
        const rightResults = await processMultiChunkAbstraction(
          ready.slice(mid).map(entry => entry.chunk),
          { ...options, globalStart: globalStart + mid, workerId, leaseMs, maxAttempts },
        );
        return [...finished, ...leftResults, ...rightResults];
      }
      return [...finished, ...await fallbackToSingles(ready.map(entry => entry.chunk), { ...options, workerId, leaseMs, maxAttempts }, 'payload_too_large')];
    }

    const batchMaxTokens = Math.min(config.maxTokens * preparedItems.length, 65536);
    const modelResult = await runModelAbstraction({
      messages,
      model,
      maxTokens: batchMaxTokens,
      payloadBytes,
      escalationModel,
      escalationMaxTokens,
      responseSchema: BATCH_ABSTRACT_RESPONSE_SCHEMA,
      options,
    });
    const parsed = parseBatchAbstracts(modelResult.text, preparedItems, globalStart);
    const perChunkPayload = Math.floor(payloadBytes / preparedItems.length);
    const batchResults = [];
    const fallbackChunks = [];
    const noEscalateFallbackChunks = [];
    for (let i = 0; i < preparedItems.length; i++) {
      const item = preparedItems[i];
      const parsedItem = parsed[i];
      const text = String(parsedItem?.abstractText || '').trim();
      if (!text) {
        item.payloadBytes = null;
        fallbackChunks.push(item.chunk);
        continue;
      }
      const perChunkUsage = {
        inputTokens: modelResult.usage.inputTokens != null
          ? Math.floor(modelResult.usage.inputTokens / preparedItems.length)
          : null,
        outputTokens: modelResult.usage.outputTokens != null
          ? Math.floor(modelResult.usage.outputTokens / preparedItems.length)
          : null,
      };
      let finalText = text;
      let finalModel = modelResult.model;
      let finalPayloadBytes = perChunkPayload;
      let finalUsage = perChunkUsage;
      let escalationAttempted = false;
      try {
        if (escalationEnabled) {
          const assessment = evaluateAbstractEscalation(
            text,
            perChunkUsage,
            config.maxTokens,
            buildEscalationQualityContext(item.chunk, item.delivery),
          );
          if (assessment.shouldEscalate) {
            const latestChunk = store.getChunk
              ? await store.getChunk(item.chunk.jobId, item.chunk.id)
              : item.chunk;
            if (
              !latestChunk
              || latestChunk.abstractionStatus !== 'processing'
              || (latestChunk.abstractionWorkerId && latestChunk.abstractionWorkerId !== workerId)
            ) {
              item.payloadBytes = null;
              batchResults.push({ status: 'stale', chunkId: item.chunk.id });
              continue;
            }
            escalationAttempted = true;
            const escalated = await runChunkEscalation({
              chunk: item.chunk,
              payloadBytes: item.payloadBytes,
              sequenceIndex: globalStart + i,
              escalationModel,
              escalationMaxTokens,
              reasons: assessment.reasons,
              options,
            });
            if (escalated.usage) {
              finalUsage = addUsage(perChunkUsage, escalated.usage);
            }
            if (escalated.ok) {
              finalText = escalated.text;
              finalModel = escalated.model;
              finalPayloadBytes = escalated.payloadBytes ?? finalPayloadBytes;
            }
          }
        }
        item.payloadBytes = null;
        const saved = await persistCompletedAbstract({
          store,
          chunk: item.chunk,
          workerId,
          sequenceIndex: globalStart + i,
          abstractText: finalText,
          modelUsed: finalModel,
          payloadBytes: finalPayloadBytes,
          usage: finalUsage,
          latencyMs: Date.now() - startedAt,
          attemptCount: Math.max(1, Number(item.chunk.abstractionAttempts) || 1),
        });
        batchResults.push(saved);
      } catch (err) {
        item.payloadBytes = null;
        if (escalationAttempted) {
          noEscalateFallbackChunks.push(item.chunk);
        } else {
          fallbackChunks.push(item.chunk);
        }
      }
    }
    if (fallbackChunks.length) {
      const partialResults = await fallbackToSingles(
        fallbackChunks,
        { ...options, workerId, leaseMs, maxAttempts },
        `batch_parse_partial:${fallbackChunks.length}/${preparedItems.length}`,
      );
      batchResults.push(...partialResults);
    }
    if (noEscalateFallbackChunks.length) {
      const partialResults = await fallbackToSingles(
        noEscalateFallbackChunks,
        { ...options, escalationEnabled: false, workerId, leaseMs, maxAttempts },
        `batch_persist_partial:${noEscalateFallbackChunks.length}/${preparedItems.length}`,
      );
      batchResults.push(...partialResults);
    }
    return [...finished, ...batchResults];
  } catch (err) {
    return [...finished, ...await fallbackToSingles(ready.map(entry => entry.chunk), { ...options, workerId, leaseMs, maxAttempts }, err?.message || String(err))];
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
