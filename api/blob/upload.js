import {
  createRequestId,
  getJobStore,
  parseJsonBody,
  requireJobPassword,
  setJobSecurityHeaders,
} from '../_lib/jobs.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

const DEFAULT_MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = ['application/pdf', 'text/csv', 'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/tiff'];

function getMaxUploadBytes() {
  const configured = Number(process.env.BLOB_MAX_UPLOAD_BYTES || DEFAULT_MAX_UPLOAD_BYTES);
  return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : DEFAULT_MAX_UPLOAD_BYTES;
}

function blobIsConfigured() {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN);
}

function parsePayload(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return {}; }
  }
  if (typeof value === 'object') return value;
  return {};
}

function toWebHeaders(headers) {
  const webHeaders = new Headers();
  for (const [key, value] of Object.entries(headers || {})) {
    if (Array.isArray(value)) {
      for (const item of value) webHeaders.append(key, String(item));
    } else if (value !== undefined) {
      webHeaders.set(key, String(value));
    }
  }
  return webHeaders;
}

export default async function handler(req, res) {
  setJobSecurityHeaders(res);
  const requestId = req.headers['x-request-id'] || createRequestId();
  res.setHeader('X-Request-Id', requestId);

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed.', requestId });
  }

  if (req.method === 'GET') {
    if (!requireJobPassword(req, res, requestId)) return;
    return res.status(200).json({
      available: blobIsConfigured(),
      maxUploadBytes: getMaxUploadBytes(),
      access: 'private',
      requestId,
    });
  }

  let body;
  try {
    body = parseJsonBody(req.body);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON in upload request.', requestId });
  }

  const uploadEventType = body?.type || body?.event || body?.action;
  const isBlobCompletionCallback = uploadEventType === 'blob.upload-completed';
  if (!isBlobCompletionCallback && !requireJobPassword(req, res, requestId)) return;

  if (!blobIsConfigured()) {
    return res.status(503).json({
      error: 'Vercel Blob storage is not configured. Set BLOB_READ_WRITE_TOKEN to enable durable file uploads.',
      available: false,
      requestId,
    });
  }

  const store = getJobStore();
  if (!store) {
    return res.status(503).json({
      error: 'DATABASE_URL or POSTGRES_URL is required for durable upload metadata.',
      requestId,
    });
  }

  try {
    const { handleUpload } = await import('@vercel/blob/client');
    const json = await handleUpload({
      body,
      request: new Request(`https://${req.headers.host || 'localhost'}${req.url || '/api/blob/upload'}`, {
        method: req.method,
        headers: toWebHeaders(req.headers),
      }),
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const payload = parsePayload(clientPayload);
        const jobId = payload.jobId;
        const chunkId = payload.chunkId;
        const mediaType = payload.mediaType;
        if (!jobId?.startsWith('job_') || !chunkId?.startsWith('chk_')) {
          throw new Error('Invalid upload payload.');
        }
        const job = await store.getJob(jobId);
        const chunks = job ? await store.listChunks(jobId) : [];
        const chunk = chunks.find(item => item.id === chunkId);
        if (!job || !chunk) {
          throw new Error('Upload chunk not found.');
        }
        const expectedPrefix = `jobs/${jobId}/chunks/${chunkId}/`;
        if (!String(pathname || '').startsWith(expectedPrefix) || String(pathname || '').includes('..')) {
          throw new Error('Invalid upload pathname.');
        }
        if (mediaType && mediaType !== chunk.mediaType) {
          throw new Error('Upload media type does not match chunk metadata.');
        }
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: getMaxUploadBytes(),
          tokenPayload: JSON.stringify({ jobId, chunkId }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const payload = parsePayload(tokenPayload);
        if (!payload.jobId || !payload.chunkId || !blob?.url || !blob?.pathname) return;
        await store.updateChunk(payload.jobId, payload.chunkId, {
          uploadStatus: 'uploaded',
          blobUrl: blob.url,
          blobKey: blob.pathname,
        });
      },
    });
    return res.status(200).json(json);
  } catch (err) {
    console.error(JSON.stringify({
      event: 'blob_upload_token_error',
      requestId,
      reason: err?.message || String(err),
    }));
    return res.status(400).json({ error: 'Could not prepare durable upload.', requestId });
  }
}
