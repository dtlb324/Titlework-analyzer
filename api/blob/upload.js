import {
  createRequestId,
  getJobStore,
  parseJsonBody,
  requireJobPassword,
  setJobSecurityHeaders,
} from '../_lib/jobs.js';
import {
  ALLOWED_CONTENT_TYPES,
  createSignedUpload,
  getStorageConfig,
  storageIsConfigured,
} from '../_lib/storage.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 15,
};

export default async function handler(req, res) {
  setJobSecurityHeaders(res);
  const requestId = req.headers['x-request-id'] || createRequestId();
  res.setHeader('X-Request-Id', requestId);

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed.', requestId });
  }

  if (req.method === 'GET') {
    if (!requireJobPassword(req, res, requestId)) return;
    const config = getStorageConfig();
    return res.status(200).json({
      available: storageIsConfigured(),
      provider: 'gcs',
      maxUploadBytes: config.maxUploadBytes,
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

  if (!requireJobPassword(req, res, requestId)) return;

  if (!storageIsConfigured()) {
    return res.status(503).json({
      error: 'Google Cloud Storage is not configured. Set GCS_BUCKET to enable durable file uploads.',
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
    const jobId = body?.jobId;
    const chunkId = body?.chunkId;
    const mediaType = body?.mediaType || body?.contentType;
    if (!jobId?.startsWith('job_') || !chunkId?.startsWith('chk_')) {
      return res.status(400).json({ error: 'Invalid upload payload.', requestId });
    }
    if (!ALLOWED_CONTENT_TYPES.includes(mediaType)) {
      return res.status(400).json({ error: 'Unsupported upload content type.', requestId });
    }
    const job = await store.getJob(jobId);
    const chunk = job && store.getChunk
      ? await store.getChunk(jobId, chunkId)
      : (job ? (await store.listChunks(jobId)).find(item => item.id === chunkId) : null);
    if (!job || !chunk) {
      return res.status(404).json({ error: 'Upload chunk not found.', requestId });
    }
    if (mediaType !== chunk.mediaType) {
      return res.status(400).json({ error: 'Upload media type does not match chunk metadata.', requestId });
    }
    const signedUpload = await createSignedUpload({
      jobId,
      chunkId,
      originalFilename: chunk.originalFilename,
      objectKey: chunk.blobKey,
      contentType: mediaType,
      sizeBytes: chunk.sizeBytes,
    });
    return res.status(200).json({ upload: signedUpload, requestId });
  } catch (err) {
    console.error(JSON.stringify({
      event: 'gcs_upload_sign_error',
      requestId,
      reason: err?.message || String(err),
    }));
    return res.status(err?.statusCode || 400).json({ error: err?.message || 'Could not prepare durable upload.', requestId });
  }
}
