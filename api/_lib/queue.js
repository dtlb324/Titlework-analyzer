// Phase 4 — durable background workflow / queue for server-side abstraction.
//
// The default driver runs in-process: chunks live in Postgres (see jobs.js),
// the start/process endpoints claim them under a short lease, and bounded
// concurrency drives the work. The adapter pattern leaves a single seam for
// plugging in Inngest or a similar workflow tool later via WORKFLOW_DRIVER.
//
// Required env vars for the default driver:
//   - DATABASE_URL (or POSTGRES_URL / POSTGRES_PRISMA_URL)
//   - GCS_BUCKET (so workers can fetch chunks from Google Cloud Storage)
//   - GEMINI_API_KEY or ANTHROPIC_API_KEY (so workers can call the abstraction model)
//
// To select a different driver in the future, set WORKFLOW_DRIVER=inngest
// and provide INNGEST_EVENT_KEY plus INNGEST_SIGNING_KEY. Until that adapter
// ships, requests with WORKFLOW_DRIVER=inngest return a 503 setup error.

import { processChunkAbstraction } from './abstraction.js';
import {
  isAbstractionBatchingEnabled,
  planAbstractionWork,
  processMultiChunkAbstraction,
} from './abstraction-batch.js';
import { runWithConcurrency } from './concurrency.js';
import { createBlobReadCache } from './storage.js';
import { processSynthesisJob, planJobSynthesis } from './synthesis.js';

const DEFAULT_BATCH_LIMIT = clampInt(process.env.WORKFLOW_BATCH_LIMIT, 12, 1, 64);
const ABSTRACTION_FETCH_MULTIPLIER = clampInt(process.env.ABSTRACTION_BATCH_FETCH_MULTIPLIER, 4, 1, 16);
const DEFAULT_CONCURRENCY = clampInt(process.env.WORKFLOW_CONCURRENCY, 4, 1, 16);
const DEFAULT_BUDGET_MS = clampInt(process.env.WORKFLOW_BUDGET_MS, 20 * 60_000, 1_000, 55 * 60_000);
const DEFAULT_UPSTREAM_TIMEOUT_MS = clampInt(process.env.ABSTRACTION_UPSTREAM_TIMEOUT_MS || process.env.SYNTHESIS_UPSTREAM_TIMEOUT_MS || process.env.CLOUD_RUN_UPSTREAM_TIMEOUT_MS, 240_000, 10_000, 300_000);
const DEFAULT_LEASE_MS = clampInt(process.env.WORKFLOW_LEASE_MS, DEFAULT_UPSTREAM_TIMEOUT_MS + 60_000, 5_000, 600_000);
const DEFAULT_MAX_ATTEMPTS = clampInt(process.env.ABSTRACTION_MAX_ATTEMPTS, 5, 1, 12);
const DEFAULT_STALE_LEASE_MS = clampInt(process.env.WORKFLOW_STALE_LEASE_MS, DEFAULT_LEASE_MS + 60_000, 5_000, 600_000);
const DEFAULT_KICK_BUDGET_MS = clampInt(process.env.WORKFLOW_KICK_BUDGET_MS, 50_000, 5_000, 55_000);

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function getWorkflowConfig() {
  return {
    driver: (process.env.WORKFLOW_DRIVER || 'inprocess').toLowerCase(),
    batchLimit: DEFAULT_BATCH_LIMIT,
    concurrency: DEFAULT_CONCURRENCY,
    budgetMs: DEFAULT_BUDGET_MS,
    leaseMs: DEFAULT_LEASE_MS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    staleLeaseMs: DEFAULT_STALE_LEASE_MS,
  };
}

export function workflowSetupError() {
  const driver = (process.env.WORKFLOW_DRIVER || 'inprocess').toLowerCase();
  if (driver === 'inprocess') return null;
  if (driver === 'inngest') {
    if (!process.env.INNGEST_EVENT_KEY || !process.env.INNGEST_SIGNING_KEY) {
      return 'WORKFLOW_DRIVER=inngest requires INNGEST_EVENT_KEY and INNGEST_SIGNING_KEY. Configure both env vars or unset WORKFLOW_DRIVER to use the in-process queue.';
    }
    return 'WORKFLOW_DRIVER=inngest is not implemented in this deployment. Set WORKFLOW_DRIVER=inprocess (default) to use the durable Postgres-backed queue.';
  }
  return `WORKFLOW_DRIVER=${driver} is not supported. Use "inprocess" (default) or configure Inngest.`;
}

function createWorkerId() {
  return `wkr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function chunkIsClaimable(chunk, now) {
  const status = chunk.abstractionStatus || 'pending';
  if (status === 'pending') return true;
  if (status === 'retry_wait') {
    const retryAt = chunk.abstractionRetryAt ? Date.parse(chunk.abstractionRetryAt) : 0;
    return !retryAt || retryAt <= now;
  }
  if (status === 'processing') {
    const expires = chunk.abstractionLeaseExpiresAt ? Date.parse(chunk.abstractionLeaseExpiresAt) : 0;
    return !expires || expires <= now;
  }
  return false;
}

async function getJobOrThrow(store, jobId) {
  const job = await store.getJob(jobId);
  if (!job) {
    const error = new Error('Job not found.');
    error.statusCode = 404;
    throw error;
  }
  return job;
}

function isJobCanceled(job) {
  return job?.status === 'canceled';
}

async function refreshAbstractionRollup(store, jobId) {
  if (store.refreshAbstractionRollup) {
    return await store.refreshAbstractionRollup(jobId);
  }
  if (store.getAbstractionStatus) {
    const status = await store.getAbstractionStatus(jobId);
    return status?.job || (await store.getJob(jobId));
  }
  return await store.getJob(jobId);
}

export async function enqueueAbstractionJob(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to enqueue abstraction.');
  const job = await getJobOrThrow(store, jobId);
  if (isJobCanceled(job)) {
    const error = new Error('Job has been canceled.');
    error.statusCode = 409;
    throw error;
  }
  // Recover any leases that were stranded across deploys / function restarts
  // before we move the job into the "abstracting" state.
  if (store.resetStaleProcessingChunks) {
    await store.resetStaleProcessingChunks(jobId, options.staleLeaseMs || DEFAULT_STALE_LEASE_MS);
  }
  if (['created', 'uploading'].includes(job.status)) {
    const error = new Error('Uploads must be finalized before starting server-side abstraction.');
    error.statusCode = 409;
    throw error;
  }
  const enqueueable = ['ready', 'queued', 'planning', 'partial_failed', 'failed'];
  if (store.updateJob && enqueueable.includes(job.status)) {
    try {
      await store.updateJob(jobId, { status: 'abstracting', currentPhase: 'Queued for server-side abstraction' });
    } catch {
      // status transition already advanced; fine.
    }
  }
  return await getAbstractionSnapshot(store, jobId);
}

async function getAbstractionSnapshot(store, jobId) {
  const status = store.getAbstractionStatus ? await store.getAbstractionStatus(jobId) : null;
  if (!status) {
    return { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, retry_wait: 0, failedChunks: [], job: await store.getJob(jobId) };
  }
  return {
    total: status.total ?? 0,
    pending: status.pending ?? 0,
    processing: status.processing ?? 0,
    completed: status.completed ?? 0,
    failed: status.failed ?? 0,
    retry_wait: status.retry_wait ?? 0,
    failedChunks: status.failedChunks || [],
    job: status.job || (await store.getJob(jobId)),
  };
}

async function listReadyChunks(store, jobId, limit, now) {
  if (store.listReadyAbstractionChunks) {
    return await store.listReadyAbstractionChunks(jobId, limit);
  }
  const chunks = await store.listChunks(jobId);
  return chunks
    .filter(chunk => chunk.uploadStatus === 'uploaded' && chunkIsClaimable(chunk, now))
    .slice(0, limit);
}

export async function processAbstractionBatch(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to process abstraction.');
  const blobLoader = options.blobLoader || createBlobReadCache(options);
  const config = {
    batchLimit: options.batchLimit ?? DEFAULT_BATCH_LIMIT,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS,
    leaseMs: options.leaseMs ?? DEFAULT_LEASE_MS,
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    staleLeaseMs: options.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS,
  };
  const workerId = options.workerId || createWorkerId();
  const startedAt = Date.now();
  const deadline = startedAt + config.budgetMs;

  if (store.resetStaleProcessingChunks) {
    await store.resetStaleProcessingChunks(jobId, config.staleLeaseMs);
  }

  let completed = 0;
  let failed = 0;
  let retryScheduled = 0;
  let splits = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    let job = await getJobOrThrow(store, jobId);
    if (isJobCanceled(job)) break;
    const now = Date.now();
    const fetchLimit = isAbstractionBatchingEnabled()
      ? Math.min(64, config.batchLimit * ABSTRACTION_FETCH_MULTIPLIER)
      : config.batchLimit;
    const ready = await listReadyChunks(store, jobId, fetchLimit, now);
    if (!ready.length) break;

    let results = [];
    if (isAbstractionBatchingEnabled()) {
      const { batches, singles } = planAbstractionWork(ready);
      const tasks = [
        ...batches.map(batch => async () => {
          if (!job || isJobCanceled(job)) {
            return batch.chunks.map(chunk => ({ status: 'skipped', chunkId: chunk.id, reason: 'canceled' }));
          }
          return await processMultiChunkAbstraction(batch.chunks, {
            ...options,
            store,
            blobLoader,
            workerId,
            leaseMs: config.leaseMs,
            maxAttempts: config.maxAttempts,
            globalStart: batch.globalStart,
          });
        }),
        ...singles.map(chunk => async () => {
          if (!job || isJobCanceled(job)) {
            return [{ status: 'skipped', chunkId: chunk.id, reason: 'canceled' }];
          }
          return [await processChunkAbstraction(chunk, {
            ...options,
            store,
            blobLoader,
            workerId,
            leaseMs: config.leaseMs,
            maxAttempts: config.maxAttempts,
            sequenceIndex: chunk.chunkOrder || 0,
          })];
        }),
      ];
      const nested = await runWithConcurrency(tasks, config.concurrency, async task => task());
      results = nested.flat(2);
    } else {
      results = await runWithConcurrency(ready, config.concurrency, async chunk => {
        if (!job || isJobCanceled(job)) {
          return { status: 'skipped', chunkId: chunk.id, reason: 'canceled' };
        }
        return await processChunkAbstraction(chunk, {
          ...options,
          store,
          blobLoader,
          workerId,
          leaseMs: config.leaseMs,
          maxAttempts: config.maxAttempts,
          sequenceIndex: chunk.chunkOrder || 0,
        });
      });
    }

    let anyClaimed = false;
    for (const result of results) {
      if (!result) continue;
      if (result.status === 'completed') {
        anyClaimed = true;
        completed += 1;
      } else if (result.status === 'failed') {
        anyClaimed = true;
        failed += 1;
        lastError = result.failure || lastError;
      } else if (result.status === 'retry_wait') {
        anyClaimed = true;
        retryScheduled += 1;
        lastError = result.failure || lastError;
      } else if (result.status === 'split_superseded') {
        anyClaimed = true;
        splits += 1;
      } else if (result.status === 'error') {
        lastError = result.error;
      }
    }
    if (!anyClaimed) break;
    job = await store.getJob(jobId);
  }

  await refreshAbstractionRollup(store, jobId);
  const finalSnapshot = await getAbstractionSnapshot(store, jobId);
  return {
    ...finalSnapshot,
    workerId,
    completedInBatch: completed,
    failedInBatch: failed,
    retryScheduledInBatch: retryScheduled,
    splitsInBatch: splits,
    elapsedMs: Date.now() - startedAt,
    hasMore: finalSnapshot.pending > 0 || finalSnapshot.processing > 0 || finalSnapshot.retry_wait > 0,
    lastError: lastError ? sanitize(lastError) : null,
    snapshot: finalSnapshot,
  };
}

function sanitize(err) {
  if (!err) return null;
  if (err.errorType || err.errorMessage) {
    return { errorType: err.errorType, errorMessage: err.errorMessage };
  }
  return { errorType: 'unknown', errorMessage: String(err.message || err).slice(0, 500) };
}

const backgroundPromises = new Map();
const synthesisBackgroundPromises = new Map();

export function getBackgroundPromise(jobId) {
  return backgroundPromises.get(jobId) || null;
}

export function getSynthesisBackgroundPromise(jobId) {
  return synthesisBackgroundPromises.get(jobId) || null;
}

export function isWorkflowKickOnStartEnabled() {
  return process.env.WORKFLOW_KICK_ON_START !== 'false';
}

export function kickWorkflowOnStart(jobId, phase, options = {}) {
  if (!isWorkflowKickOnStartEnabled()) return null;
  const budgetMs = options.budgetMs ?? DEFAULT_KICK_BUDGET_MS;
  const waitUntil = options.waitUntil || globalThis.__TITLE_ANALYZER_WAIT_UNTIL__;
  const kickOptions = { ...options, budgetMs };
  if (phase === 'synthesis') {
    return scheduleBackgroundSynthesis(jobId, kickOptions);
  }
  return scheduleBackgroundProcessing(jobId, kickOptions);
}

export function scheduleBackgroundProcessing(jobId, options = {}) {
  // Legacy in-process fallback for local/manual use. Cloud Run deployments
  // should use worker.js so route handlers only enqueue durable work.
  const waitUntil = options.waitUntil || globalThis.__TITLE_ANALYZER_WAIT_UNTIL__;
  const existing = backgroundPromises.get(jobId);
  if (existing) return existing;
  const promise = (async () => {
    try {
      return await processAbstractionBatch(jobId, {
        ...options,
        budgetMs: options.budgetMs ?? options.batchBudgetMs,
      });
    } catch (err) {
      console.error(JSON.stringify({
        event: 'workflow_background_error',
        jobId,
        reason: err?.message || String(err),
      }));
      return null;
    } finally {
      backgroundPromises.delete(jobId);
    }
  })();
  backgroundPromises.set(jobId, promise);
  if (typeof waitUntil === 'function') {
    try { waitUntil(promise); } catch { /* waitUntil may not be available in tests */ }
  }
  return promise;
}

function publicSynthesisStatus(status) {
  if (!status) return null;
  return {
    total: status.total || 0,
    pending: status.pending || 0,
    processing: status.processing || 0,
    complete: status.complete || 0,
    failed: status.failed || 0,
    retry_wait: status.retry_wait || 0,
    planId: status.planId || null,
    hasResult: Boolean(status.hasResult),
    mergeInProgress: Boolean(status.mergeInProgress),
  };
}

export async function enqueueSynthesisJob(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to enqueue synthesis.');
  const job = await getJobOrThrow(store, jobId);
  if (isJobCanceled(job)) {
    const error = new Error('Job has been canceled.');
    error.statusCode = 409;
    throw error;
  }
  if (store.resetStaleSynthesisSegments) {
    await store.resetStaleSynthesisSegments(jobId, options.staleLeaseMs || 180_000);
  }
  // Plan (or reuse plan) and persist segments before the worker picks them up.
  const planResult = await planJobSynthesis(jobId, options);
  const planId = planResult?.plan?.planId;
  if (job.status === 'failed') {
    if (planId && store.resetFailedSynthesisSegments) {
      await store.resetFailedSynthesisSegments(jobId, planId);
    }
    if (store.clearJobResult) {
      await store.clearJobResult(jobId);
    }
  }
  if (store.updateJob && !['synthesizing', 'complete', 'partial_failed', 'failed'].includes(job.status)) {
    try {
      await store.updateJob(jobId, { status: 'synthesizing', currentPhase: 'Queued for server-side synthesis' });
    } catch {
      // status transition already advanced; fine.
    }
  } else if (store.updateJob && job.status === 'failed') {
    // allow resuming from failed
    try {
      await store.updateJob(jobId, { status: 'synthesizing', currentPhase: 'Resuming synthesis after failure' });
    } catch { /* ignore */ }
  }
  const status = await store.getSynthesisStatus(jobId, { lightweight: true });
  return {
    job: status?.job || (await store.getJob(jobId)),
    status: publicSynthesisStatus(status),
    raw: status,
  };
}

export async function synthesisSnapshot(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to read synthesis status.');
  await getJobOrThrow(store, jobId);
  if (store.resetStaleSynthesisSegments) {
    await store.resetStaleSynthesisSegments(jobId, options.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS);
  }
  const status = await store.getSynthesisStatus(jobId, {
    lightweight: options.lightweight !== false,
    includeSegments: options.includeSegments === true,
    includeResult: options.includeResult === true,
  });
  return {
    job: status?.job || (await store.getJob(jobId)),
    status: publicSynthesisStatus(status),
    raw: status,
  };
}

export async function processSynthesisBatch(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to process synthesis.');
  const config = {
    batchLimit: options.batchLimit ?? Math.max(1, Math.min(4, DEFAULT_BATCH_LIMIT)),
    budgetMs: options.budgetMs ?? DEFAULT_BUDGET_MS,
    leaseMs: options.leaseMs ?? Math.max(60_000, DEFAULT_LEASE_MS),
    maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    staleLeaseMs: options.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS,
  };
  const result = await processSynthesisJob(jobId, {
    ...options,
    store,
    budgetMs: config.budgetMs,
    leaseMs: config.leaseMs,
    mergeLeaseMs: options.mergeLeaseMs ?? config.leaseMs,
    staleLeaseMs: config.staleLeaseMs,
    batchLimit: config.batchLimit,
    config: { maxAttempts: config.maxAttempts, ...(options.config || {}) },
  });
  return {
    ...result,
    status: publicSynthesisStatus(result.status),
    rawStatus: result.status,
  };
}

export function scheduleBackgroundSynthesis(jobId, options = {}) {
  // Legacy in-process fallback for local/manual use. Cloud Run deployments
  // should use worker.js so route handlers only enqueue durable work.
  const waitUntil = options.waitUntil || globalThis.__TITLE_ANALYZER_WAIT_UNTIL__;
  const existing = synthesisBackgroundPromises.get(jobId);
  if (existing) return existing;
  const promise = (async () => {
    try {
      return await processSynthesisBatch(jobId, {
        ...options,
        budgetMs: options.budgetMs ?? options.batchBudgetMs,
      });
    } catch (err) {
      console.error(JSON.stringify({
        event: 'workflow_synthesis_background_error',
        jobId,
        reason: err?.message || String(err),
      }));
      return null;
    } finally {
      synthesisBackgroundPromises.delete(jobId);
    }
  })();
  synthesisBackgroundPromises.set(jobId, promise);
  if (typeof waitUntil === 'function') {
    try { waitUntil(promise); } catch { /* waitUntil may not be available in tests */ }
  }
  return promise;
}

export async function cancelAbstractionJob(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to cancel a job.');
  const job = await getJobOrThrow(store, jobId);
  if (isJobCanceled(job)) {
    return { job, alreadyCanceled: true };
  }
  if (store.cancelJob) {
    const canceledJob = await store.cancelJob(jobId, options.reason || 'User canceled job.');
    return { job: canceledJob || job, alreadyCanceled: false };
  }
  if (store.updateJob) {
    const canceledJob = await store.updateJob(jobId, {
      status: 'canceled',
      currentPhase: 'canceled',
      errorMessage: options.reason || 'User canceled job.',
    });
    return { job: canceledJob || job, alreadyCanceled: false };
  }
  return { job, alreadyCanceled: false };
}

export async function retryFailedAbstractionChunks(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to retry failed chunks.');
  const job = await getJobOrThrow(store, jobId);
  if (isJobCanceled(job)) {
    const error = new Error('Job has been canceled.');
    error.statusCode = 409;
    throw error;
  }
  let reset = 0;
  if (store.retryFailedChunks) {
    reset = await store.retryFailedChunks(jobId);
  } else if (store.listChunks && store.resetChunkAbstraction) {
    const chunks = await store.listChunks(jobId);
    for (const chunk of chunks) {
      if (chunk.abstractionStatus === 'failed' || chunk.abstractionStatus === 'retry_wait') {
        const updated = await store.resetChunkAbstraction(jobId, chunk.id);
        if (updated) reset += 1;
      }
    }
  }
  if (reset > 0 && store.updateJob) {
    const refreshed = await store.getJob(jobId);
    if (refreshed && ['failed', 'partial_failed'].includes(refreshed.status)) {
      try {
        await store.updateJob(jobId, { status: 'abstracting', currentPhase: 'Retrying failed chunks' });
      } catch { /* ignore invalid transitions */ }
    }
  }
  const snapshot = await getAbstractionSnapshot(store, jobId);
  return { reset, snapshot, requeuedAt: nowIso() };
}

export async function abstractionSnapshot(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to read abstraction status.');
  await getJobOrThrow(store, jobId);
  if (store.resetStaleProcessingChunks) {
    await store.resetStaleProcessingChunks(jobId, options.staleLeaseMs || DEFAULT_STALE_LEASE_MS);
  }
  return await getAbstractionSnapshot(store, jobId);
}

export { DEFAULT_LEASE_MS, DEFAULT_MAX_ATTEMPTS, DEFAULT_BATCH_LIMIT, DEFAULT_CONCURRENCY, DEFAULT_BUDGET_MS, DEFAULT_STALE_LEASE_MS };
