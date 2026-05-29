import { createServer } from 'http';
import { runWorkerLoop, runWorkerDrain } from './api/_lib/cloud-run-worker.js';
import { getRuntimeInfo } from './api/_lib/runtime-info.js';

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
      const body = JSON.stringify({ ok: true, service: 'title-analyzer-worker', release: getRuntimeInfo() });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && req.url === '/internal/drain') {
      if (draining) {
        const body = JSON.stringify({ ok: true, busy: true });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      draining = true;
      runDrain()
        .then(result => {
          const body = JSON.stringify({ ok: true, ...result });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
          res.end(body);
        })
        .catch(err => {
          const body = JSON.stringify({ ok: false, error: err?.message || String(err) });
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
          res.end(body);
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
