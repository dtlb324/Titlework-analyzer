import { createReadStream } from 'fs';
import { readFile, stat } from 'fs/promises';
import { createServer as createHttpServer } from 'http';
import { extname, isAbsolute, join, normalize, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { callApiHandler } from './api/_lib/node-http-adapter.js';
import analyzeHandler from './api/analyze.js';
import jobsHandler from './api/jobs.js';
import jobPathHandler from './api/jobs/[...path].js';
import blobUploadHandler from './api/blob/upload.js';
import { getRuntimeInfo } from './api/_lib/runtime-info.js';
import { createOcrCompareHandler } from './api/ocr-compare.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');
const PDFJS_FILES = new Map(['pdf.mjs', 'pdf.worker.mjs'].map(name => [`/vendor/pdfjs/${name}`, join(__dirname, 'node_modules', 'pdfjs-dist', 'build', name)]));
// Scanned PDFs may need JBIG2/JPEG2000 decoders. Expose only known renderer
// assets, never a general node_modules directory or user-controlled file path.
const PDFJS_ASSETS = {
  wasm: ['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm', 'openjpeg_nowasm_fallback.js', 'qcms_bg.wasm'],
  iccs: ['CGATS001Compat-v2-micro.icc'],
  standard_fonts: ['FoxitDingbats.pfb', 'FoxitFixed.pfb', 'FoxitFixedBold.pfb', 'FoxitFixedBoldItalic.pfb', 'FoxitFixedItalic.pfb', 'FoxitSerif.pfb', 'FoxitSerifBold.pfb', 'FoxitSerifBoldItalic.pfb', 'FoxitSerifItalic.pfb', 'FoxitSymbol.pfb', 'LiberationSans-Regular.ttf', 'LiberationSans-Bold.ttf', 'LiberationSans-BoldItalic.ttf', 'LiberationSans-Italic.ttf'],
};
for (const [directory, names] of Object.entries(PDFJS_ASSETS)) {
  for (const name of names) PDFJS_FILES.set(`/vendor/pdfjs/${directory}/${name}`, join(__dirname, 'node_modules', 'pdfjs-dist', directory, name));
}

function publicHealth(serviceName) {
  const info = getRuntimeInfo();
  return {
    ok: true,
    service: serviceName,
    release: { version: info.version },
  };
}

function staticSecurityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  };
}

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

export function safePublicPath(pathname, publicDir = PUBLIC_DIR) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relativePath = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const resolved = normalize(join(publicDir, relativePath));
  const fromRoot = relative(publicDir, resolved);
  if (!fromRoot || isAbsolute(fromRoot) || fromRoot === '..' || fromRoot.startsWith(`..${sep}`)) return null;
  return resolved;
}

async function serveStatic(req, res, url) {
  const filePath = safePublicPath(url.pathname);
  if (!filePath) return sendJson(res, 403, { error: 'Forbidden.' });
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    if (!url.pathname.startsWith('/api/') && url.pathname !== '/') {
      return serveStatic(req, res, new URL('/', url));
    }
    return sendJson(res, 404, { error: 'Not found.' });
  }
  if (!fileStat.isFile()) return sendJson(res, 404, { error: 'Not found.' });
  res.writeHead(200, {
    'content-type': MIME_TYPES.get(extname(filePath).toLowerCase()) || 'application/octet-stream',
    'content-length': fileStat.size,
    ...staticSecurityHeaders(),
  });
  createReadStream(filePath).pipe(res);
}

export function createServer({ ocrCompareModelClient } = {}) {
  const ocrCompareHandler = createOcrCompareHandler({ modelClient: ocrCompareModelClient });
  return createHttpServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/healthz' || url.pathname === '/api/healthz') {
        return sendJson(res, 200, publicHealth('title-analyzer'));
      }
      if (url.pathname === '/api/analyze') return await callApiHandler(analyzeHandler, req, res, url);
      if (url.pathname === '/api/ocr-compare') return await callApiHandler(ocrCompareHandler, req, res, url);
      if (url.pathname === '/api/jobs') return await callApiHandler(jobsHandler, req, res, url);
      if (url.pathname.startsWith('/api/jobs/')) return await callApiHandler(jobPathHandler, req, res, url);
      if (url.pathname === '/api/blob/upload') return await callApiHandler(blobUploadHandler, req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed.' });
      if (url.pathname.startsWith('/vendor/pdfjs/')) {
        const filePath = PDFJS_FILES.get(url.pathname);
        if (!filePath) return sendJson(res, 404, { error: 'Not found.' });
        const contentType = /\.(mjs|js)$/.test(filePath) ? 'text/javascript; charset=utf-8' : filePath.endsWith('.wasm') ? 'application/wasm' : 'application/octet-stream';
        res.writeHead(200, { 'content-type': contentType, ...staticSecurityHeaders() });
        if (req.method === 'HEAD') return res.end();
        return createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
      }
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
