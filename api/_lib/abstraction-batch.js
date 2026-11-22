
import { callLeaseMs, chunkLeaseLostError, isChunkLeaseLostError, renewChunkLeases } from './abstraction-lease.js';
import {
  ABSTRACTION_PROMPT,
  BATCH_ABSTRACT_RESPONSE_SCHEMA,
  addUsage,
  buildAbstractMessagesForChunks,
  buildEscalationQualityContext,
  classifyAbstractionError,
  computeRetryBackoff,
  estimateAbstractPayloadBytes,
  estimateRequestBytes,
  evaluateAbstractEscalation,
  extractRetryAfterMs,
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
  sanitizeErrorMessage,
  splitPdfChunk,
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

  const model = options.model || config.model;
  const escalationModel = options.escalationModel ?? resolveEscalationModel();
  const escalationMaxTokens = options.escalationMaxTokens ?? resolveEscalationMaxTokens();
  const escalationEnabled = isAbstractionEscalationEnabled({ model, escalationModel, options });

  // Chunks this worker claimed and has not finished. Their leases only live as long as the last renewal, so
  // renew them before every billable call. A 'lost' answer is final: never pay for that chunk again.
  const held = new Map(ready.map(entry => [entry.chunk.id, entry.chunk]));
  const lostIds = new Set();
  const renewState = new Map();
  const renewMs = callLeaseMs(leaseMs, options.upstreamTimeoutMs ?? config.upstreamTimeoutMs);
  const renewHeld = async (activeChunk = null, activeLeaseMs = null) => {
    if (activeChunk && lostIds.has(activeChunk.id)) return 'lost';
    const targets = activeChunk && !held.has(activeChunk.id)
      ? [...held.values(), activeChunk]
      : [...held.values()];
    const outcomes = await renewChunkLeases(store, targets, {
      workerId,
      leaseMs: Math.max(renewMs, Number(activeLeaseMs) || 0),
    });
    for (const [id, state] of outcomes) {
      renewState.set(id, state);
      if (state === 'lost' && held.has(id)) {
        lostIds.add(id);
        held.delete(id);
      }
    }
    await options.chunkLeaseGuard?.();
    return activeChunk ? outcomes.get(activeChunk.id) : undefined;
  };
  const stale = chunk => ({ status: 'stale', chunkId: chunk.id });
  const release = results => {
    for (const result of results) held.delete(result?.chunkId);
    return results;
  };
  const soloOptions = { ...options, chunkLeaseGuard: renewHeld };
  const escalationGuard = chunk => async () => {
    if (lostIds.has(chunk.id)) throw chunkLeaseLostError(chunk.id);
    await renewHeld();
    if (lostIds.has(chunk.id)) throw chunkLeaseLostError(chunk.id);
    if (renewState.get(chunk.id) === 'unavailable') {
      // No renewal available on this store: fall back to the status/worker check.
      let latestChunk = chunk;
      try {
        if (store.getChunk) latestChunk = await store.getChunk(chunk.jobId, chunk.id);
      } catch (_) {
        latestChunk = chunk;
      }
      if (
        !latestChunk
        || latestChunk.abstractionStatus !== 'processing'
        || (latestChunk.abstractionWorkerId && latestChunk.abstractionWorkerId !== workerId)
      ) {
        throw chunkLeaseLostError(chunk.id);
      }
    }
    await options.modelCallGuard?.();
  };

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
    return [...finished, ...await fallbackToSingles(ready.map(entry => entry.chunk), { ...soloOptions, workerId, leaseMs, maxAttempts }, err?.message || String(err), { held, lostIds, renewHeld })];
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
    await renewHeld();
    if (lostIds.has(item.chunk.id)) {
      visualResults.push(stale(item.chunk));
      continue;
    }
    visualResults.push(release([await runSoloPreparedItem(item, soloOptions, { workerId, leaseMs, maxAttempts, globalStart })])[0]);
  }

  // Slow solos above may have outlived a text chunk's lease: drop those, no model call for them.
  await renewHeld();
  const lostText = textItems.filter(item => lostIds.has(item.chunk.id));
  const lostTextResults = lostText.map(item => stale(item.chunk));
  if (lostText.length) {
    for (let i = textItems.length - 1; i >= 0; i--) {
      if (lostIds.has(textItems[i].chunk.id)) textItems.splice(i, 1);
    }
  }

  if (!textItems.length) {
    return [...finished, ...visualResults, ...lostTextResults];
  }
  if (textItems.length === 1) {
    const soloText = await runSoloPreparedItem(textItems[0], soloOptions, { workerId, leaseMs, maxAttempts, globalStart });
    return [...finished, ...visualResults, soloText, ...lostTextResults];
  }

  try {
    const messages = buildAbstractMessagesForChunks(textItems, globalStart);
    const payloadBytes = estimateRequestBytes(model, config.maxTokens, ABSTRACTION_PROMPT, messages);
    if (payloadBytes > REQUEST_ENVELOPE_SAFE_BYTES) {
      if (textItems.length > 2) {
        const mid = Math.ceil(textItems.length / 2);
        // The right half stays in `held` (renewed through the guard) while the left half runs.
        for (const item of textItems.slice(0, mid)) held.delete(item.chunk.id);
        const leftResults = await processMultiChunkAbstraction(
          textItems.slice(0, mid).map(item => item.chunk),
          { ...soloOptions, globalStart, workerId, leaseMs, maxAttempts },
        );
        await renewHeld();
        const rightItems = textItems.slice(mid);
        const rightResults = rightItems.map(item => (lostIds.has(item.chunk.id)
          ? stale(item.chunk)
          : null));
        const rightLive = rightItems.filter(item => !lostIds.has(item.chunk.id));
        for (const item of rightLive) held.delete(item.chunk.id);
        const rightDone = rightLive.length
          ? await processMultiChunkAbstraction(
            rightLive.map(item => item.chunk),
            { ...options, globalStart: globalStart + mid, workerId, leaseMs, maxAttempts },
          )
          : [];
        return [...finished, ...visualResults, ...lostTextResults, ...leftResults, ...rightResults.filter(Boolean), ...rightDone];
      }
      return [...finished, ...visualResults, ...lostTextResults, ...await fallbackToSingles(textItems.map(item => item.chunk), { ...soloOptions, workerId, leaseMs, maxAttempts }, 'payload_too_large', { held, lostIds, renewHeld })];
    }

    const batchMaxTokens = Math.min(config.maxTokens * textItems.length, 65536);
    const modelResult = await runModelAbstraction({
      messages,
      model,
      maxTokens: batchMaxTokens,
      payloadBytes,
      escalationModel,
      escalationMaxTokens,
      responseSchema: BATCH_ABSTRACT_RESPONSE_SCHEMA,
      options: {
        ...options,
        // Last check before the paid batch call: if a member was taken, do not pay for a batch that cannot be saved.
        modelCallGuard: async () => {
          await renewHeld();
          const lost = textItems.find(item => lostIds.has(item.chunk.id));
          if (lost) throw chunkLeaseLostError(lost.chunk.id);
          if (!held.size) throw chunkLeaseLostError(null);
          await options.modelCallGuard?.();
        },
      },
    });
    const parsed = parseBatchAbstracts(modelResult.text, textItems, globalStart);
    const perChunkPayload = Math.floor(payloadBytes / textItems.length);
    const batchResults = [];
    const fallbackChunks = [];
    const noEscalateFallbackChunks = [];
    for (let i = 0; i < textItems.length; i++) {
      const item = textItems[i];
      const parsedItem = parsed[i];
      const text = String(parsedItem?.abstractText || '').trim();
      if (!text) {
        item.payloadBytes = null;
        fallbackChunks.push(item.chunk);
        continue;
      }
      const perChunkUsage = {
        inputTokens: modelResult.usage.inputTokens != null
          ? Math.floor(modelResult.usage.inputTokens / textItems.length)
          : null,
        outputTokens: modelResult.usage.outputTokens != null
          ? Math.floor(modelResult.usage.outputTokens / textItems.length)
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
            escalationAttempted = true;
            const escalated = await runChunkEscalation({
              chunk: item.chunk,
              payloadBytes: item.payloadBytes,
              sequenceIndex: globalStart + i,
              escalationModel,
              escalationMaxTokens,
              reasons: assessment.reasons,
              mediaResolution: options.mediaResolution,
              options: { ...options, modelCallGuard: escalationGuard(item.chunk) },
            });
            if (escalated.usage) {
              finalUsage = addUsage(perChunkUsage, escalated.usage);
            }
            if (escalated.ok) {
              finalText = escalated.text;
              finalModel = escalated.model;
              finalPayloadBytes = escalated.payloadBytes ?? finalPayloadBytes;
            } else if (escalated.truncated) {
              const split = item.payloadBytes
                ? await splitPdfChunk(item.chunk, item.payloadBytes, 'output_truncated', { ...options, store, workerId }).catch(() => false)
                : false;
              item.payloadBytes = null;
              held.delete(item.chunk.id);
              if (split) {
                batchResults.push({ status: 'split_superseded', chunkId: item.chunk.id });
              } else {
                const failure = {
                  errorType: 'output_truncated',
                  errorMessage: 'Escalated model output was truncated at the token limit (max_tokens).',
                  latencyMs: Date.now() - startedAt,
                  modelUsed: escalated.model || escalationModel,
                  workerId,
                };
                if (store.markChunkAbstractionFailed) {
                  const updated = await store.markChunkAbstractionFailed(item.chunk.jobId, item.chunk.id, failure);
                  batchResults.push(updated ? { status: 'failed', chunkId: item.chunk.id, failure } : stale(item.chunk));
                } else {
                  batchResults.push({ status: 'failed', chunkId: item.chunk.id, failure });
                }
              }
              continue;
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
        held.delete(item.chunk.id);
      } catch (err) {
        item.payloadBytes = null;
        if (isChunkLeaseLostError(err)) {
          held.delete(item.chunk.id);
          batchResults.push({ status: 'stale', chunkId: item.chunk.id });
          continue;
        }
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
        { ...soloOptions, workerId, leaseMs, maxAttempts },
        `batch_parse_partial:${fallbackChunks.length}/${textItems.length}`,
        { held, lostIds, renewHeld },
      );
      batchResults.push(...partialResults);
    }
    if (noEscalateFallbackChunks.length) {
      const partialResults = await fallbackToSingles(
        noEscalateFallbackChunks,
        { ...soloOptions, escalationEnabled: false, workerId, leaseMs, maxAttempts },
        `batch_persist_partial:${noEscalateFallbackChunks.length}/${textItems.length}`,
        { held, lostIds, renewHeld },
      );
      batchResults.push(...partialResults);
    }
    return [...finished, ...visualResults, ...lostTextResults, ...release(batchResults)];
  } catch (err) {
    // Nothing was paid when the guard fired. Members taken by another worker are stale; the rest retry as singles.
    const lostNow = isChunkLeaseLostError(err);
    const results = [];
    const rest = [];
    for (const item of textItems) {
      if (lostNow && lostIds.has(item.chunk.id)) results.push(stale(item.chunk));
      else rest.push(item.chunk);
    }
    if (rest.length) {
      const errorType = classifyAbstractionError(err);
      // A missing or rejected key fails every call the same way, so fanning out to singles only repeats it.
      if (!lostNow && (errorType === 'rate_limit' || errorType === 'upstream_timeout' || errorType === 'auth_error')) {
        const retryAfterMs = extractRetryAfterMs(err);
        const failure = {
          errorType,
          errorMessage: sanitizeErrorMessage(err),
          latencyMs: Date.now() - startedAt,
          modelUsed: model,
          workerId,
        };
        for (const chunk of rest) {
          held.delete(chunk.id);
          const attemptCount = Math.max(1, Number(chunk.abstractionAttempts) || 1);
          if (errorType !== 'auth_error' && attemptCount < maxAttempts && store.markChunkAbstractionRetryWait) {
            const retryAtMs = Date.now() + computeRetryBackoff(attemptCount, retryAfterMs);
            const updated = await store.markChunkAbstractionRetryWait(chunk.jobId, chunk.id, {
              ...failure,
              retryAtIso: new Date(retryAtMs).toISOString(),
            });
            results.push(updated
              ? { status: 'retry_wait', chunkId: chunk.id, failure, retryAt: retryAtMs }
              : stale(chunk));
          } else if (store.markChunkAbstractionFailed) {
            const updated = await store.markChunkAbstractionFailed(chunk.jobId, chunk.id, failure);
            results.push(updated
              ? { status: 'failed', chunkId: chunk.id, failure }
              : stale(chunk));
          } else {
            results.push({ status: 'failed', chunkId: chunk.id, failure });
          }
        }
      } else {
        results.push(...await fallbackToSingles(rest, { ...soloOptions, workerId, leaseMs, maxAttempts }, err?.message || String(err), { held, lostIds, renewHeld }));
      }
    }
    return [...finished, ...visualResults, ...lostTextResults, ...results];
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

async function fallbackToSingles(chunks, options, reason, lease = null) {
  console.warn(JSON.stringify({
    event: 'abstraction_batch_fallback',
    chunkIds: chunks.map(chunk => chunk.id),
    reason,
  }));
  const results = [];
  const pending = lease?.held || new Map(chunks.map(chunk => [chunk.id, chunk]));
  const renewMs = callLeaseMs(options.leaseMs, options.upstreamTimeoutMs ?? getAbstractionConfig().upstreamTimeoutMs);
  const guard = lease?.renewHeld || (async (activeChunk = null, activeLeaseMs = null) => {
    const targets = activeChunk && !pending.has(activeChunk.id)
      ? [...pending.values(), activeChunk]
      : [...pending.values()];
    const outcomes = await renewChunkLeases(options.store, targets, {
      workerId: options.workerId,
      leaseMs: Math.max(renewMs, Number(activeLeaseMs) || 0),
    });
    await options.chunkLeaseGuard?.();
    return activeChunk ? outcomes.get(activeChunk.id) : undefined;
  });
  for (const chunk of chunks) {
    if (lease?.lostIds?.has(chunk.id)) {
      results.push({ status: 'stale', chunkId: chunk.id });
      continue;
    }
    try {
      results.push(await processChunkAbstraction(chunk, { ...options, chunkLeaseGuard: guard }));
    } finally {
      pending.delete(chunk.id);
    }
  }
  return results;
}
