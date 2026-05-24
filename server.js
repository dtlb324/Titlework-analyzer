import { createReadStream } from 'fs';
import { readFile, stat } from 'fs/promises';
import { createServer as createHttpServer } from 'http';
import { extname, join, normalize } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { callApiHandler } from './api/_lib/node-http-adapter.js';
import analyzeHandler from './api/analyze.js';
import jobsHandler from './api/jobs.js';
import jobPathHandler from './api/jobs/[...path].js';
import blobUploadHandler from './api/blob/upload.js';
import { getRuntimeInfo } from './api/_lib/runtime-info.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

function sendJson(res, statusCode, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function safePublicPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = normalize(join(PUBLIC_DIR, relative));
  return resolved.startsWith(PUBLIC_DIR) ? resolved : null;
}

async function serveStatic(req, res, url) {
  const filePath = safePublicPath(url.pathname);
  if (!filePath) return sendJson(res, 403, { error: 'Forbidden.' });
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    if (!url.pathname.startsWith('/api/')) {
      return serveStatic(req, res, new URL('/', url));
    }
    return sendJson(res, 404, { error: 'Not found.' });
  }
  if (!fileStat.isFile()) return sendJson(res, 404, { error: 'Not found.' });
  res.writeHead(200, {
    'content-type': MIME_TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
    'content-length': fileStat.size,
  });
  createReadStream(filePath).pipe(res);
}

export function createServer() {
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true, service: 'title-analyzer', release: getRuntimeInfo() });
      }
      if (url.pathname === '/api/analyze') return await callApiHandler(analyzeHandler, req, res, url);
      if (url.pathname === '/api/jobs') return await callApiHandler(jobsHandler, req, res, url);
      if (url.pathname.startsWith('/api/jobs/')) return await callApiHandler(jobPathHandler, req, res, url);
      if (url.pathname === '/api/blob/upload') return await callApiHandler(blobUploadHandler, req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
      return await serveStatic(req, res, url);
    } catch (err) {
      console.error(JSON.stringify({
        event: 'cloud_run_server_error',
        path: url.pathname,
        reason: err?.message || String(err),
      }));
      const statusCode = err?.statusCode || 500;
      return sendJson(res, statusCode, { error: statusCode < 500 ? err.message : 'Internal server error.' });
    }
  });
}

export async function startServer() {
  await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
  const port = Number(process.env.PORT || 8080);
  const server = createServer();
  await new Promise(resolve => server.listen(port, '0.0.0.0', resolve));
  console.log(JSON.stringify({ event: 'server_listening', port }));
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch(err => {
    console.error(JSON.stringify({ event: 'server_start_error', reason: err?.message || String(err) }));
    process.exit(1);
  });
}
