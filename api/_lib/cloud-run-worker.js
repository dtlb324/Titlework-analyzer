import { getJobStore } from './jobs.js';
import { processAbstractionBatch, processSynthesisBatch } from './queue.js';

export function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    let onAbort;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function clampPollMs(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function getWorkerPollIntervals(options = {}) {
  const legacy = options.pollIntervalMs ?? process.env.WORKER_POLL_INTERVAL_MS;
  const idleMs = clampPollMs(
    options.idlePollIntervalMs ?? process.env.WORKER_POLL_IDLE_MS ?? legacy,
    2000,
    100,
    60_000,
  );
  const activeMs = clampPollMs(
    options.activePollIntervalMs ?? process.env.WORKER_POLL_ACTIVE_MS,
    0,
    0,
    5000,
  );
  return { idleMs, activeMs };
}

async function listJobIds(store, methodName) {
  if (typeof store?.[methodName] !== 'function') return [];
  const ids = await store[methodName]();
  return Array.isArray(ids) ? ids.filter(Boolean) : [];
}

async function maybeRunSynthesisAfterAbstraction(store, jobId, processSynthesis, options = {}) {
  if (!store?.getJob) return;
  const job = await store.getJob(jobId);
  if (job?.status !== 'synthesizing') return;
  try {
    await processSynthesis(jobId);
  } catch (err) {
    console.error(JSON.stringify({
      event: 'worker_synthesis_after_abstraction_error',
      jobId,
      reason: err?.message || String(err),
    }));
    if (options.collectErrors) options.collectErrors.push({ jobId, phase: 'synthesis', error: err });
  }
}

export async function runWorkerOnce(options = {}) {
  const store = options.store || getJobStore();
  if (!store) throw new Error('A job store is required for the Cloud Run worker.');
  const processAbstraction = options.processAbstraction || ((jobId) => processAbstractionBatch(jobId, { ...options, store }));
  const processSynthesis = options.processSynthesis || ((jobId) => processSynthesisBatch(jobId, { ...options, store }));

  const abstractionIds = await listJobIds(store, 'listRunnableAbstractionJobIds');
  const synthesisIds = await listJobIds(store, 'listRunnableSynthesisJobIds');
  const synthesisSet = new Set(synthesisIds);
  const errors = [];
  let succeeded = 0;

  for (const jobId of abstractionIds) {
    try {
      await processAbstraction(jobId);
      succeeded += 1;
      synthesisSet.delete(jobId);
      await maybeRunSynthesisAfterAbstraction(store, jobId, processSynthesis, {
        collectErrors: errors,
      });
    } catch (err) {
      errors.push({ jobId, phase: 'abstraction', error: err });
      console.error(JSON.stringify({ event: 'worker_abstraction_error', jobId, reason: err?.message || String(err) }));
    }
  }

  for (const jobId of synthesisSet) {
    try {
      await processSynthesis(jobId);
      succeeded += 1;
    } catch (err) {
      errors.push({ jobId, phase: 'synthesis', error: err });
      console.error(JSON.stringify({ event: 'worker_synthesis_error', jobId, reason: err?.message || String(err) }));
    }
  }

  return {
    abstractionJobs: abstractionIds.length,
    synthesisJobs: synthesisIds.length,
    errors,
    succeeded,
    hasWork: abstractionIds.length + synthesisIds.length > 0,
  };
}

export async function runWorkerDrain(options = {}) {
  const controller = new AbortController();
  const budgetMs = clampPollMs(options.drainBudgetMs ?? process.env.WORKER_DRAIN_BUDGET_MS, 1_500_000, 10_000, 3_300_000);
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const externalSignal = options.signal;
  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
  }
  try {
    return await runWorkerLoop({
      ...options,
      signal: controller.signal,
      maxIdleCycles: 1,
      maxConsecutiveErrorCycles: options.maxConsecutiveErrorCycles ?? 3,
    });
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

export async function runWorkerLoop(options = {}) {
  const { idleMs, activeMs } = getWorkerPollIntervals(options);
  const maxIdleCycles = Number.isFinite(Number(options.maxIdleCycles)) ? Number(options.maxIdleCycles) : Infinity;
  const maxIterations = Number.isFinite(Number(options.maxIterations)) ? Number(options.maxIterations) : Infinity;
  const maxConsecutiveErrorCycles = Number.isFinite(Number(options.maxConsecutiveErrorCycles))
    ? Number(options.maxConsecutiveErrorCycles)
    : Infinity;
  const sleep = options.sleep || defaultSleep;
  let idleCycles = 0;
  let iterations = 0;
  let consecutiveErrorCycles = 0;

  while (!options.signal?.aborted && iterations < maxIterations) {
    iterations += 1;
    let result;
    try {
      result = await runWorkerOnce(options);
    } catch (err) {
      console.error(JSON.stringify({
        event: 'worker_loop_error',
        reason: err?.message || String(err),
      }));
      consecutiveErrorCycles += 1;
      if (consecutiveErrorCycles >= maxConsecutiveErrorCycles) break;
      await sleep(idleMs, options.signal);
      continue;
    }
    if (result.hasWork) {
      idleCycles = 0;
      if (result.errors.length) {
        if ((result.succeeded ?? 0) === 0) {
          consecutiveErrorCycles += 1;
          if (consecutiveErrorCycles >= maxConsecutiveErrorCycles) break;
        } else {
          consecutiveErrorCycles = 0;
        }
        await sleep(activeMs || idleMs, options.signal);
      } else {
        consecutiveErrorCycles = 0;
      }
      continue;
    }
    consecutiveErrorCycles = 0;
    idleCycles += 1;
    if (idleCycles >= maxIdleCycles) break;
    await sleep(idleMs, options.signal);
  }

  return {
    iterations,
    idleCycles,
    aborted: Boolean(options.signal?.aborted),
  };
}
