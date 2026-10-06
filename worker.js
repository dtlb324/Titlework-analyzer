import { createServer } from 'http';
import { runWorkerLoop, runWorkerDrain } from './api/_lib/cloud-run-worker.js';
import { secureCompare } from './api/_lib/jobs.js';
import { getRuntimeInfo, isProductionRuntime } from './api/_lib/runtime-info.js';

export { isProductionRuntime };

// Cloud Scheduler is the production caller. It already presents an OIDC bearer
// token to Cloud Run IAM; this header is the in-app secret, sent alongside it.
export const INTERNAL_DRAIN_HEADER = 'x-internal-drain-token';

function configuredDrainToken(env) {
  const raw = env.INTERNAL_DRAIN_TOKEN;
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

// Fails closed in production (Dockerfile sets NODE_ENV=production; Cloud Run
// also sets K_SERVICE) when INTERNAL_DRAIN_TOKEN is missing. Outside production
// an unset token stays open so local drain POSTs keep working; a configured
// token is required in every environment.
export function authorizeInternalDrain(req, env = process.env) {
  const secret = configuredDrainToken(env);
  if (!secret) {
    if (isProductionRuntime(env)) {
      return { ok: false, status: 401, error: 'INTERNAL_DRAIN_TOKEN is required.' };
    }
    return { ok: true };
  }
  const header = req?.headers?.[INTERNAL_DRAIN_HEADER];
  const provided = typeof header === 'string' ? header.trim() : '';
  if (secureCompare(provided, secret)) return { ok: true };
  return { ok: false, status: 401, error: 'Unauthorized.' };
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function closeServer(server) {
  return new Promise(resolve => {
    try {
      server.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function waitForAbort(signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    signal?.addEventListener('abort', resolve, { once: true });
  });
}

export function isWorkerLoopDisabled(env = process.env) {
  const value = String(env.WORKER_DISABLED || '').trim().toLowerCase();
  return value === 'true' || value === '1' || value === 'yes';
}

export function createWorkerHealthServer({ drain } = {}) {
  const runDrain = drain || (() => runWorkerDrain());
  let draining = false;
  return createServer((req, res) => {
    if (req.url === '/healthz') {
      const body = JSON.stringify({ ok: true, service: 'title-analyzer-worker', release: { version: getRuntimeInfo().version } });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && req.url === '/internal/drain') {
      const auth = authorizeInternalDrain(req);
      if (!auth.ok) {
        writeJson(res, auth.status, { ok: false, error: auth.error });
        return;
      }
      if (draining) {
        writeJson(res, 200, { ok: true, busy: true });
        return;
      }
      draining = true;
      runDrain()
        .then(result => {
          writeJson(res, 200, { ok: true, ...result });
        })
        .catch(err => {
          console.error(JSON.stringify({
            event: 'worker_drain_error',
            reason: err?.message || String(err),
          }));
          writeJson(res, 500, { ok: false, error: 'Drain failed.' });
        })
        .finally(() => { draining = false; });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found.' }));
  });
}

export async function startWorker() {
  const controller = new AbortController();
  const port = Number(process.env.PORT || 8080);
  const healthServer = createWorkerHealthServer();
  await new Promise(resolve => healthServer.listen(port, '0.0.0.0', resolve));
  const shutdown = signal => {
    console.log(JSON.stringify({ event: 'worker_shutdown_requested', signal }));
    controller.abort();
    closeServer(healthServer);
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
  console.log(JSON.stringify({ event: 'worker_starting', port }));
  if (isWorkerLoopDisabled()) {
    console.log(JSON.stringify({ event: 'worker_disabled', reason: 'WORKER_DISABLED' }));
    await waitForAbort(controller.signal);
    await closeServer(healthServer);
    console.log(JSON.stringify({ event: 'worker_stopped', disabled: true, aborted: Boolean(controller.signal.aborted) }));
    return { disabled: true, aborted: Boolean(controller.signal.aborted) };
  }
  const result = await runWorkerLoop({ signal: controller.signal });
  await closeServer(healthServer);
  console.log(JSON.stringify({ event: 'worker_stopped', ...result }));
  return result;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  startWorker().catch(err => {
    console.error(JSON.stringify({ event: 'worker_fatal_error', reason: err?.message || String(err) }));
    process.exit(1);
  });
}
