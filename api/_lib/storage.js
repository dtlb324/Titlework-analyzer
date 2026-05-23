const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const DEFAULT_SIGNED_URL_TTL_MS = 15 * 60 * 1000;
export const ALLOWED_CONTENT_TYPES = ['application/pdf', 'text/csv', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function getStorageConfig() {
  const bucket = process.env.GCS_BUCKET || process.env.GOOGLE_CLOUD_STORAGE_BUCKET || process.env.STORAGE_BUCKET || '';
  return {
    provider: 'gcs',
    bucket,
    maxUploadBytes: clampInt(process.env.STORAGE_MAX_UPLOAD_BYTES || process.env.GCS_MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD_BYTES, 1, 1024 * 1024 * 1024),
    signedUrlTtlMs: clampInt(process.env.GCS_SIGNED_URL_TTL_MS, DEFAULT_SIGNED_URL_TTL_MS, 60_000, 60 * 60_000),
  };
}

export function storageIsConfigured() {
  return Boolean(getStorageConfig().bucket);
}

function sanitizeFilename(name) {
  const base = String(name || 'document')
    .normalize('NFKD')
    .replace(/[^\w.\- ()]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return base || 'document';
}

export function buildObjectKey(jobId, chunkId, originalFilename) {
  return `jobs/${jobId}/chunks/${chunkId}/${sanitizeFilename(originalFilename)}`;
}

export function buildObjectUrl(bucket, objectKey) {
  return `gs://${bucket}/${objectKey}`;
}

export function isAllowedStorageUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'gs:') {
      return Boolean(parsed.hostname) && parsed.pathname.startsWith('/jobs/');
    }
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:') return false;
    if (host === 'storage.googleapis.com') {
      const [, bucket, firstSegment] = parsed.pathname.split('/');
      return Boolean(bucket) && firstSegment === 'jobs';
    }
    if (host.endsWith('.storage.googleapis.com')) {
      return parsed.pathname.startsWith('/jobs/');
    }
    return false;
  } catch {
    return false;
  }
}

export function parseStorageUrl(objectUrl, fallbackBucket = '') {
  const parsed = new URL(objectUrl);
  if (parsed.protocol === 'gs:') {
    return { bucket: parsed.hostname, objectKey: parsed.pathname.replace(/^\/+/, '') };
  }
  if (parsed.hostname.toLowerCase() === 'storage.googleapis.com') {
    const [, bucket, ...parts] = parsed.pathname.split('/');
    return { bucket, objectKey: parts.join('/') };
  }
  if (parsed.hostname.toLowerCase().endsWith('.storage.googleapis.com')) {
    return { bucket: parsed.hostname.split('.')[0], objectKey: parsed.pathname.replace(/^\/+/, '') };
  }
  return { bucket: fallbackBucket, objectKey: '' };
}

export function validateObjectRef({ jobId, chunkId, objectKey, objectUrl }, config = getStorageConfig()) {
  const expectedPrefix = `jobs/${jobId}/chunks/${chunkId}/`;
  if (typeof objectKey !== 'string' || !objectKey.startsWith(expectedPrefix) || objectKey.includes('..')) {
    return { valid: false, reason: 'objectKey must match the job and chunk upload prefix.' };
  }
  if (typeof objectUrl !== 'string' || !isAllowedStorageUrl(objectUrl)) {
    return { valid: false, reason: 'objectUrl must be a Google Cloud Storage object URL.' };
  }
  const parsed = parseStorageUrl(objectUrl, config.bucket);
  if (parsed.objectKey !== objectKey) {
    return { valid: false, reason: 'objectUrl must point to the same objectKey.' };
  }
  if (config.bucket && parsed.bucket !== config.bucket) {
    return { valid: false, reason: 'objectUrl must point to the configured GCS bucket.' };
  }
  return { valid: true };
}

async function getStorageClient() {
  const { Storage } = await import('@google-cloud/storage');
  return new Storage();
}

async function getBucket(config = getStorageConfig()) {
  if (!config.bucket) {
    const error = new Error('Google Cloud Storage is not configured. Set GCS_BUCKET to enable durable file storage.');
    error.statusCode = 503;
    throw error;
  }
  const client = await getStorageClient();
  return client.bucket(config.bucket);
}

export async function createSignedUpload({ jobId, chunkId, originalFilename, objectKey, contentType, sizeBytes }, options = {}) {
  const config = options.config || getStorageConfig();
  if (!config.bucket) {
    const error = new Error('Google Cloud Storage is not configured. Set GCS_BUCKET to enable durable file uploads.');
    error.statusCode = 503;
    throw error;
  }
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    const error = new Error('Unsupported upload content type.');
    error.statusCode = 400;
    throw error;
  }
  const size = Number(sizeBytes);
  if (Number.isFinite(size) && size > config.maxUploadBytes) {
    const error = new Error(`Upload is too large. Maximum object size is ${config.maxUploadBytes} bytes.`);
    error.statusCode = 413;
    throw error;
  }
  const key = objectKey || buildObjectKey(jobId, chunkId, originalFilename);
  const validation = validateObjectRef({
    jobId,
    chunkId,
    objectKey: key,
    objectUrl: buildObjectUrl(config.bucket, key),
  });
  if (!validation.valid) {
    const error = new Error(validation.reason);
    error.statusCode = 400;
    throw error;
  }

  const expiresAt = Date.now() + config.signedUrlTtlMs;
  const bucket = options.bucket || await getBucket(config);
  const file = bucket.file(key);
  const [uploadUrl] = await file.getSignedUrl({
    version: 'v4',
    action: 'write',
    expires: expiresAt,
    contentType,
  });
  return {
    provider: 'gcs',
    method: 'PUT',
    uploadUrl,
    headers: { 'content-type': contentType },
    objectKey: key,
    objectUrl: buildObjectUrl(config.bucket, key),
    blobKey: key,
    blobUrl: buildObjectUrl(config.bucket, key),
    maxUploadBytes: config.maxUploadBytes,
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export async function readObject(chunk, options = {}) {
  if (options.objectReader || globalThis.__TITLE_ANALYZER_OBJECT_READER__) {
    return await (options.objectReader || globalThis.__TITLE_ANALYZER_OBJECT_READER__)(chunk);
  }
  if (!chunk?.blobUrl && !chunk?.objectUrl) {
    const error = new Error(`Chunk ${chunk?.id || ''} is missing a storage URL.`);
    error.statusCode = 500;
    throw error;
  }
  const objectUrl = chunk.objectUrl || chunk.blobUrl;
  if (!isAllowedStorageUrl(objectUrl)) {
    const error = new Error('Chunk storage URL must be a Google Cloud Storage object URL.');
    error.statusCode = 400;
    throw error;
  }
  const config = options.config || getStorageConfig();
  const ref = parseStorageUrl(objectUrl, config.bucket);
  const bucket = options.bucket || await getBucket({ ...config, bucket: ref.bucket || config.bucket });
  const file = bucket.file(chunk.objectKey || chunk.blobKey || ref.objectKey);
  const [bytes] = await file.download();
  const [metadata] = await file.getMetadata().catch(() => [{}]);
  return {
    bytes: Buffer.from(bytes),
    mediaType: metadata.contentType || chunk.mediaType,
  };
}

export async function objectExists(chunk, options = {}) {
  const objectUrl = chunk.objectUrl || chunk.blobUrl;
  const objectKey = chunk.objectKey || chunk.blobKey;
  if (!objectUrl || !objectKey || !isAllowedStorageUrl(objectUrl)) return false;
  const config = options.config || getStorageConfig();
  const validation = validateObjectRef({
    jobId: chunk.jobId,
    chunkId: chunk.id,
    objectKey,
    objectUrl,
  }, config);
  if (!validation.valid) return false;
  const ref = parseStorageUrl(objectUrl, config.bucket);
  const bucket = options.bucket || await getBucket({ ...config, bucket: ref.bucket || config.bucket });
  const [exists] = await bucket.file(objectKey).exists();
  return Boolean(exists);
}

export async function writeObject(parentChunk, childName, bytes, options = {}) {
  const config = options.config || getStorageConfig();
  if (!config.bucket) {
    const error = new Error('Google Cloud Storage is not configured. Set GCS_BUCKET to enable PDF split uploads.');
    error.statusCode = 503;
    throw error;
  }
  const suffix = `${parentChunk.id}-split-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const objectKey = buildObjectKey(parentChunk.jobId, suffix, childName);
  const bucket = options.bucket || await getBucket(config);
  await bucket.file(objectKey).save(bytes, { contentType: 'application/pdf', resumable: false });
  const objectUrl = buildObjectUrl(config.bucket, objectKey);
  return { blobKey: objectKey, blobUrl: objectUrl, objectKey, objectUrl };
}
