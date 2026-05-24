import { createServer } from 'http';
import { runWorkerLoop } from './api/_lib/cloud-run-worker.js';
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

export function createWorkerHealthServer() {
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
