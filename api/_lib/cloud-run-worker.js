import { getJobStore } from './jobs.js';
import { processAbstractionBatch, processSynthesisBatch } from './queue.js';

function defaultSleep(ms, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

async function listJobIds(store, methodName) {
  if (typeof store?.[methodName] !== 'function') return [];
  const ids = await store[methodName]();
  return Array.isArray(ids) ? ids.filter(Boolean) : [];
}

export async function runWorkerOnce(options = {}) {
  const store = options.store || getJobStore();
  if (!store) throw new Error('A job store is required for the Cloud Run worker.');
  const processAbstraction = options.processAbstraction || ((jobId) => processAbstractionBatch(jobId, { ...options, store }));
  const processSynthesis = options.processSynthesis || ((jobId) => processSynthesisBatch(jobId, { ...options, store }));

  const abstractionIds = await listJobIds(store, 'listRunnableAbstractionJobIds');
  const synthesisIds = await listJobIds(store, 'listRunnableSynthesisJobIds');
  const errors = [];

  for (const jobId of abstractionIds) {
    try {
      await processAbstraction(jobId);
    } catch (err) {
      errors.push({ jobId, phase: 'abstraction', error: err });
      console.error(JSON.stringify({ event: 'worker_abstraction_error', jobId, reason: err?.message || String(err) }));
    }
  }

  for (const jobId of synthesisIds) {
    try {
      await processSynthesis(jobId);
    } catch (err) {
      errors.push({ jobId, phase: 'synthesis', error: err });
      console.error(JSON.stringify({ event: 'worker_synthesis_error', jobId, reason: err?.message || String(err) }));
    }
  }

  return {
    abstractionJobs: abstractionIds.length,
    synthesisJobs: synthesisIds.length,
    errors,
    hasWork: abstractionIds.length + synthesisIds.length > 0,
  };
}

export async function runWorkerLoop(options = {}) {
  const pollIntervalMs = Math.max(1, Number(options.pollIntervalMs ?? process.env.WORKER_POLL_INTERVAL_MS ?? 5000));
  const maxIdleCycles = Number.isFinite(Number(options.maxIdleCycles)) ? Number(options.maxIdleCycles) : Infinity;
  const maxIterations = Number.isFinite(Number(options.maxIterations)) ? Number(options.maxIterations) : Infinity;
  const sleep = options.sleep || defaultSleep;
  let idleCycles = 0;
  let iterations = 0;

  while (!options.signal?.aborted && iterations < maxIterations) {
    iterations += 1;
    const result = await runWorkerOnce(options);
    if (result.hasWork) {
      idleCycles = 0;
      if (result.errors.length) {
        await sleep(pollIntervalMs, options.signal);
      }
      continue;
    }
    idleCycles += 1;
    if (idleCycles >= maxIdleCycles) break;
    await sleep(pollIntervalMs, options.signal);
  }

  return {
    iterations,
    idleCycles,
    aborted: Boolean(options.signal?.aborted),
  };
}
