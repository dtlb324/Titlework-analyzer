import { randomUUID } from 'crypto';
import { neon } from '@neondatabase/serverless';

const ALLOWED_STATUSES = new Set([
  'created',
  'uploading',
  'ready',
  'queued',
  'planning',
  'abstracting',
  'synthesizing',
  'complete',
  'partial_failed',
  'failed',
  'canceled',
]);
const TERMINAL_STATUSES = new Set(['complete', 'partial_failed', 'failed', 'canceled']);
const VALID_TRANSITIONS = {
  created: new Set(['created', 'uploading', 'abstracting', 'failed', 'canceled']),
  uploading: new Set(['uploading', 'ready', 'abstracting', 'failed', 'canceled']),
  ready: new Set(['ready', 'queued', 'planning', 'abstracting', 'failed', 'canceled']),
  queued: new Set(['queued', 'planning', 'abstracting', 'failed', 'canceled']),
  planning: new Set(['planning', 'abstracting', 'failed', 'canceled']),
  abstracting: new Set(['abstracting', 'synthesizing', 'partial_failed', 'failed', 'canceled']),
  synthesizing: new Set(['synthesizing', 'complete', 'partial_failed', 'failed', 'canceled']),
  complete: new Set(['complete']),
  partial_failed: new Set(['partial_failed', 'abstracting', 'synthesizing', 'complete', 'failed', 'canceled']),
  failed: new Set(['failed', 'abstracting', 'canceled']),
  canceled: new Set(['canceled']),
};
const MAX_TOTAL_DOCUMENTS = 400;
const MAX_FILENAME_LENGTH = 255;
const MAX_MEDIA_TYPE_LENGTH = 100;
const MAX_FINGERPRINT_LENGTH = 512;
const MAX_BLOB_REF_LENGTH = 2048;
const DOCUMENT_UPLOAD_STATUSES = new Set(['pending', 'uploading', 'uploaded', 'failed', 'skipped']);
const CHUNK_UPLOAD_STATUSES = new Set(['pending', 'uploading', 'uploaded', 'failed']);
const CHUNK_ABSTRACTION_STATUSES = new Set(['pending', 'processing', 'completed', 'failed', 'split_superseded', 'retry_wait']);
const JOB_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const JOB_RATE_LIMIT_MAX_REQUESTS = 120;
const RAW_PAYLOAD_KEYS = new Set([
  'data',
  'base64',
  'csvText',
  'abstract',
  'abstractText',
  'finalTitleOpinion',
  'titleOpinion',
  'opinion',
]);

let cachedStore = null;
const jobRateLimitMap = new Map();

export class JobApiError extends Error {
  constructor(message, statusCode = 500) {
    super(message);
    this.statusCode = statusCode;
  }
}

export function setJobSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

export function createRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export function parseJsonBody(body) {
  if (typeof body !== 'string') return body || {};
  return JSON.parse(body || '{}');
}

export function secureCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const maxLen = Math.max(a.length, b.length);
  let diff = a.length !== b.length ? 1 : 0;
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function requireJobPassword(req, res, requestId) {
  const requiredPassword = process.env.APP_PASSWORD;
  if (!requiredPassword) return true;
  const providedPassword = req.headers['x-app-password'];
  if (secureCompare(providedPassword || '', requiredPassword)) return true;
  res.status(401).json({ error: 'Invalid password.', requestId });
  return false;
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || req.headers['x-real-ip']
    || req.socket?.remoteAddress
    || 'unknown';
}

export function enforceJobRateLimit(req, res, requestId) {
  const ip = getClientIp(req);
  const now = Date.now();
  const entry = jobRateLimitMap.get(ip) || { count: 0, windowStart: now };
  if (now - entry.windowStart > JOB_RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count += 1;
  jobRateLimitMap.set(ip, entry);
  for (const [storedIp, storedEntry] of jobRateLimitMap.entries()) {
    if (now - storedEntry.windowStart > JOB_RATE_LIMIT_WINDOW_MS * 2) {
      jobRateLimitMap.delete(storedIp);
    }
  }
  if (entry.count <= JOB_RATE_LIMIT_MAX_REQUESTS) return true;
  res.setHeader('Retry-After', '60');
  res.status(429).json({ error: 'Job metadata rate limit exceeded. Wait 60 seconds and try again.', requestId });
  return false;
}

export function hasRawPayloadFields(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(hasRawPayloadFields);
  for (const [key, nested] of Object.entries(value)) {
    if (RAW_PAYLOAD_KEYS.has(key)) return true;
    if (hasRawPayloadFields(nested)) return true;
  }
  return false;
}

function truncateText(value, maxLength) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLength);
}

function toInteger(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return NaN;
  return parsed;
}

function isSafeMetadataString(value, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= maxLength;
}

function isAllowedMediaType(value) {
  return value === 'application/pdf' || value === 'text/csv' || /^image\/[-+.a-z0-9]+$/i.test(value || '');
}

function normalizeMediaType(value, filename = '') {
  const provided = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (provided) return provided;
  if (/\.pdf$/i.test(filename)) return 'application/pdf';
  if (/\.csv$/i.test(filename)) return 'text/csv';
  return 'application/octet-stream';
}

function normalizeChecksum(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-f0-9]{32,128}$/i.test(value.trim())) return false;
  return value.trim().toLowerCase();
}

function isAllowedBlobUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol === 'https:' && (host === 'blob.vercel-storage.com' || host.endsWith('.blob.vercel-storage.com'));
  } catch {
    return false;
  }
}

function sanitizeFilenameForBlob(name) {
  const base = String(name || 'document')
    .normalize('NFKD')
    .replace(/[^\w.\- ()]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120);
  return base || 'document';
}

export function buildChunkBlobKey(jobId, chunkId, originalFilename) {
  return `jobs/${jobId}/chunks/${chunkId}/${sanitizeFilenameForBlob(originalFilename)}`;
}

export function validateCreateJobInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, reason: 'Invalid job request body.' };
  }
  if (hasRawPayloadFields(input)) {
    return { valid: false, reason: 'Phase 1 job metadata must not include raw documents, abstracts, CSV text, base64 payloads, or title opinions.' };
  }
  const totalDocuments = toInteger(input.totalDocuments, Array.isArray(input.documents) ? input.documents.length : 0);
  if (!Number.isInteger(totalDocuments) || totalDocuments < 0 || totalDocuments > MAX_TOTAL_DOCUMENTS) {
    return { valid: false, reason: `totalDocuments must be an integer from 0 to ${MAX_TOTAL_DOCUMENTS}.` };
  }
  return {
    valid: true,
    value: {
      subjectTract: truncateText(input.subjectTract ?? input.tractDescription, 500),
      contextNotes: truncateText(input.contextNotes, 2000),
      totalDocuments,
    },
  };
}

export function validatePatchJobInput(input, existingJob) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, statusCode: 400, reason: 'Invalid job update body.' };
  }
  if (hasRawPayloadFields(input)) {
    return { valid: false, statusCode: 400, reason: 'Phase 1 job updates must not include raw documents, abstracts, CSV text, base64 payloads, or title opinions.' };
  }

  const patch = {};
  if (input.status !== undefined) {
    if (!ALLOWED_STATUSES.has(input.status)) {
      return { valid: false, statusCode: 400, reason: 'Invalid job status.' };
    }
    if (!isValidStatusTransition(existingJob.status, input.status)) {
      return { valid: false, statusCode: 409, reason: `Invalid job status transition from ${existingJob.status} to ${input.status}.` };
    }
    patch.status = input.status;
  }

  for (const [field, max] of [
    ['completedDocuments', existingJob.totalDocuments],
    ['failedDocuments', existingJob.totalDocuments],
  ]) {
    if (input[field] !== undefined) {
      const value = toInteger(input[field]);
      if (!Number.isInteger(value) || value < 0 || value > max) {
        return { valid: false, statusCode: 400, reason: `${field} must be an integer from 0 to totalDocuments.` };
      }
      patch[field] = value;
    }
  }

  const completedDocuments = patch.completedDocuments ?? existingJob.completedDocuments;
  const failedDocuments = patch.failedDocuments ?? existingJob.failedDocuments;
  if (completedDocuments + failedDocuments > existingJob.totalDocuments) {
    return { valid: false, statusCode: 400, reason: 'completedDocuments plus failedDocuments cannot exceed totalDocuments.' };
  }

  if (input.currentPhase !== undefined) patch.currentPhase = truncateText(input.currentPhase, 200) || existingJob.currentPhase;
  if (input.errorMessage !== undefined) patch.errorMessage = truncateText(input.errorMessage, 1000);
  return { valid: true, patch };
}

export function validateCreateDocumentInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, reason: 'Invalid document request body.' };
  }
  if (hasRawPayloadFields(input)) {
    return { valid: false, reason: 'Durable document metadata must not include raw document contents, base64 payloads, CSV text, abstracts, or title opinions.' };
  }
  if (!isSafeMetadataString(input.originalFilename, MAX_FILENAME_LENGTH)) {
    return { valid: false, reason: 'originalFilename is required.' };
  }
  const mediaType = normalizeMediaType(input.mediaType, input.originalFilename);
  if (!isAllowedMediaType(mediaType) || mediaType.length > MAX_MEDIA_TYPE_LENGTH) {
    return { valid: false, reason: 'mediaType must be application/pdf, text/csv, or image/*.' };
  }
  const sizeBytes = toInteger(input.sizeBytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    return { valid: false, reason: 'sizeBytes must be a non-negative integer.' };
  }
  const pageStart = toInteger(input.pageStart, null);
  const pageEnd = toInteger(input.pageEnd, null);
  if ((pageStart !== null || pageEnd !== null) && (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd) || pageStart < 1 || pageEnd < pageStart)) {
    return { valid: false, reason: 'pageStart and pageEnd must be a valid 1-based range.' };
  }
  const checksumSha256 = normalizeChecksum(input.checksumSha256 ?? input.checksum);
  if (checksumSha256 === false) {
    return { valid: false, reason: 'checksumSha256 must be a hex checksum string.' };
  }
  return {
    valid: true,
    value: {
      originalFilename: truncateText(input.originalFilename, MAX_FILENAME_LENGTH),
      mediaType,
      sizeBytes,
      pageStart,
      pageEnd,
      splitFrom: truncateText(input.splitFrom, MAX_FILENAME_LENGTH),
      fingerprint: truncateText(input.fingerprint, MAX_FINGERPRINT_LENGTH),
      checksumSha256,
      uploadStatus: DOCUMENT_UPLOAD_STATUSES.has(input.uploadStatus) ? input.uploadStatus : 'pending',
    },
  };
}

export function validateCreateChunkInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, reason: 'Invalid chunk request body.' };
  }
  if (hasRawPayloadFields(input)) {
    return { valid: false, reason: 'Durable chunk metadata must not include raw document contents, base64 payloads, CSV text, abstracts, or title opinions.' };
  }
  const chunkOrder = toInteger(input.chunkOrder ?? input.sequenceIndex, 0);
  if (!Number.isInteger(chunkOrder) || chunkOrder < 0 || chunkOrder >= MAX_TOTAL_DOCUMENTS * 20) {
    return { valid: false, reason: 'chunkOrder must be a non-negative integer.' };
  }
  if (!isSafeMetadataString(input.originalFilename, MAX_FILENAME_LENGTH)) {
    return { valid: false, reason: 'originalFilename is required.' };
  }
  const mediaType = normalizeMediaType(input.mediaType, input.originalFilename);
  if (!isAllowedMediaType(mediaType) || mediaType.length > MAX_MEDIA_TYPE_LENGTH) {
    return { valid: false, reason: 'mediaType must be application/pdf, text/csv, or image/*.' };
  }
  const sizeBytes = toInteger(input.sizeBytes);
  if (!Number.isInteger(sizeBytes) || sizeBytes < 0) {
    return { valid: false, reason: 'sizeBytes must be a non-negative integer.' };
  }
  const pageStart = toInteger(input.pageStart, null);
  const pageEnd = toInteger(input.pageEnd, null);
  if ((pageStart !== null || pageEnd !== null) && (!Number.isInteger(pageStart) || !Number.isInteger(pageEnd) || pageStart < 1 || pageEnd < pageStart)) {
    return { valid: false, reason: 'pageStart and pageEnd must be a valid 1-based range.' };
  }
  if (!isSafeMetadataString(input.fingerprint, MAX_FINGERPRINT_LENGTH)) {
    return { valid: false, reason: 'fingerprint is required.' };
  }
  const checksumSha256 = normalizeChecksum(input.checksumSha256 ?? input.checksum);
  if (checksumSha256 === false) {
    return { valid: false, reason: 'checksumSha256 must be a hex checksum string.' };
  }
  return {
    valid: true,
    value: {
      chunkOrder,
      originalFilename: truncateText(input.originalFilename, MAX_FILENAME_LENGTH),
      mediaType,
      sizeBytes,
      pageStart,
      pageEnd,
      splitFrom: truncateText(input.splitFrom, MAX_FILENAME_LENGTH),
      fingerprint: truncateText(input.fingerprint, MAX_FINGERPRINT_LENGTH),
      checksumSha256,
      uploadStatus: CHUNK_UPLOAD_STATUSES.has(input.uploadStatus) ? input.uploadStatus : 'pending',
    },
  };
}

export function validatePatchChunkInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, reason: 'Invalid chunk update body.' };
  }
  if (hasRawPayloadFields(input)) {
    return { valid: false, reason: 'Durable chunk updates must not include raw document contents, base64 payloads, CSV text, abstracts, or title opinions.' };
  }
  const patch = {};
  if (input.uploadStatus !== undefined) {
    if (!CHUNK_UPLOAD_STATUSES.has(input.uploadStatus)) {
      return { valid: false, reason: 'Invalid chunk uploadStatus.' };
    }
    patch.uploadStatus = input.uploadStatus;
  }
  if (input.blobKey !== undefined) {
    if (!isSafeMetadataString(input.blobKey, MAX_BLOB_REF_LENGTH) || input.blobKey.includes('..')) {
      return { valid: false, reason: 'Invalid blobKey.' };
    }
    patch.blobKey = input.blobKey;
  }
  if (input.blobUrl !== undefined) {
    if (!isSafeMetadataString(input.blobUrl, MAX_BLOB_REF_LENGTH) || !isAllowedBlobUrl(input.blobUrl)) {
      return { valid: false, reason: 'Invalid blobUrl.' };
    }
    patch.blobUrl = input.blobUrl;
  }
  const checksumSha256 = normalizeChecksum(input.checksumSha256 ?? input.checksum);
  if (checksumSha256 === false) {
    return { valid: false, reason: 'checksumSha256 must be a hex checksum string.' };
  }
  if (checksumSha256) patch.checksumSha256 = checksumSha256;
  if (input.lastErrorMessage !== undefined || input.errorMessage !== undefined) {
    patch.lastErrorMessage = truncateText(input.lastErrorMessage ?? input.errorMessage, 1000);
  }
  return { valid: true, patch };
}

export function isValidStatusTransition(fromStatus, toStatus) {
  return Boolean(VALID_TRANSITIONS[fromStatus]?.has(toStatus));
}

export function assertValidStatusTransition(fromStatus, toStatus) {
  if (!isValidStatusTransition(fromStatus, toStatus)) {
    throw new JobApiError(`Invalid job status transition from ${fromStatus} to ${toStatus}.`, 409);
  }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    status: row.status,
    subjectTract: row.subject_tract,
    contextNotes: row.context_notes,
    totalDocuments: row.total_documents,
    totalChunks: row.total_chunks ?? 0,
    completedDocuments: row.completed_documents,
    failedDocuments: row.failed_documents,
    completedChunks: row.completed_chunks ?? 0,
    failedChunks: row.failed_chunks ?? 0,
    abstractChunkTotal: row.abstract_chunk_total ?? row.total_chunks ?? 0,
    abstractChunkCompleted: row.abstract_chunk_completed ?? 0,
    abstractChunkFailed: row.abstract_chunk_failed ?? 0,
    currentPhase: row.current_phase,
    errorMessage: row.error_message,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
  };
}

function rowToDocument(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    originalFilename: row.original_filename,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    splitFrom: row.split_from,
    fingerprint: row.fingerprint,
    checksumSha256: row.checksum_sha256,
    uploadStatus: row.upload_status,
    chunkCount: row.chunk_count,
    completedChunkCount: row.completed_chunk_count,
    failedChunkCount: row.failed_chunk_count,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function rowToChunk(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    documentId: row.document_id,
    chunkOrder: row.chunk_order,
    originalFilename: row.original_filename,
    blobKey: row.blob_key,
    blobUrl: row.blob_url,
    mediaType: row.media_type,
    sizeBytes: row.size_bytes,
    pageStart: row.page_start,
    pageEnd: row.page_end,
    splitFrom: row.split_from,
    fingerprint: row.fingerprint,
    checksumSha256: row.checksum_sha256,
    uploadStatus: row.upload_status,
    uploadAttempts: row.upload_attempts,
    lastErrorMessage: row.last_error_message,
    abstractionStatus: row.abstraction_status || 'pending',
    abstractionAttempts: row.abstraction_attempts ?? 0,
    abstractionErrorType: row.abstraction_error_type,
    abstractionErrorMessage: row.abstraction_error_message,
    abstractionClaimedAt: row.abstraction_claimed_at instanceof Date ? row.abstraction_claimed_at.toISOString() : row.abstraction_claimed_at,
    abstractionLeaseExpiresAt: row.abstraction_lease_expires_at instanceof Date ? row.abstraction_lease_expires_at.toISOString() : row.abstraction_lease_expires_at,
    abstractionWorkerId: row.abstraction_worker_id,
    abstractionRetryAt: row.abstraction_retry_at instanceof Date ? row.abstraction_retry_at.toISOString() : row.abstraction_retry_at,
    payloadBytes: row.payload_bytes,
    latencyMs: row.latency_ms,
    modelUsed: row.model_used,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
    abstractionCompletedAt: row.abstraction_completed_at instanceof Date ? row.abstraction_completed_at.toISOString() : row.abstraction_completed_at,
  };
}

function rowToAbstract(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    documentId: row.document_id,
    chunkId: row.chunk_id,
    chunkOrder: row.chunk_order,
    originalFilename: row.original_filename,
    abstractText: row.abstract_text,
    modelUsed: row.model_used,
    payloadBytes: row.payload_bytes,
    latencyMs: row.latency_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    status: row.status,
    attemptCount: row.attempt_count,
    errorType: row.error_type,
    errorMessage: row.error_message,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
  };
}

function getDatabaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.POSTGRES_PRISMA_URL || '';
}

function createPostgresJobStore() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    return null;
  }
  const sql = neon(databaseUrl);
  let initialized = null;

  async function ensureSchema() {
    if (!initialized) {
      initialized = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS analysis_jobs (
            id text PRIMARY KEY,
            status text NOT NULL,
            subject_tract text,
            context_notes text,
            total_documents integer NOT NULL CHECK (total_documents >= 0),
            total_chunks integer NOT NULL DEFAULT 0 CHECK (total_chunks >= 0),
            completed_documents integer NOT NULL DEFAULT 0 CHECK (completed_documents >= 0),
            failed_documents integer NOT NULL DEFAULT 0 CHECK (failed_documents >= 0),
            completed_chunks integer NOT NULL DEFAULT 0 CHECK (completed_chunks >= 0),
            failed_chunks integer NOT NULL DEFAULT 0 CHECK (failed_chunks >= 0),
            current_phase text NOT NULL,
            error_message text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            started_at timestamptz,
            completed_at timestamptz
          )
        `;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS total_chunks integer NOT NULL DEFAULT 0 CHECK (total_chunks >= 0)`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS completed_chunks integer NOT NULL DEFAULT 0 CHECK (completed_chunks >= 0)`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS failed_chunks integer NOT NULL DEFAULT 0 CHECK (failed_chunks >= 0)`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS abstract_chunk_total integer NOT NULL DEFAULT 0 CHECK (abstract_chunk_total >= 0)`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS abstract_chunk_completed integer NOT NULL DEFAULT 0 CHECK (abstract_chunk_completed >= 0)`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS abstract_chunk_failed integer NOT NULL DEFAULT 0 CHECK (abstract_chunk_failed >= 0)`;
        await sql`
          CREATE TABLE IF NOT EXISTS job_documents (
            id text PRIMARY KEY,
            job_id text NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
            original_filename text NOT NULL,
            media_type text NOT NULL,
            size_bytes integer NOT NULL CHECK (size_bytes >= 0),
            page_start integer,
            page_end integer,
            split_from text,
            fingerprint text,
            checksum_sha256 text,
            upload_status text NOT NULL DEFAULT 'pending',
            chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
            completed_chunk_count integer NOT NULL DEFAULT 0 CHECK (completed_chunk_count >= 0),
            failed_chunk_count integer NOT NULL DEFAULT 0 CHECK (failed_chunk_count >= 0),
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `;
        await sql`
          CREATE TABLE IF NOT EXISTS document_chunks (
            id text PRIMARY KEY,
            job_id text NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
            document_id text NOT NULL REFERENCES job_documents(id) ON DELETE CASCADE,
            chunk_order integer NOT NULL CHECK (chunk_order >= 0),
            original_filename text NOT NULL,
            blob_key text NOT NULL,
            blob_url text,
            media_type text NOT NULL,
            size_bytes integer NOT NULL CHECK (size_bytes >= 0),
            page_start integer,
            page_end integer,
            split_from text,
            fingerprint text NOT NULL,
            checksum_sha256 text,
            upload_status text NOT NULL DEFAULT 'pending',
            upload_attempts integer NOT NULL DEFAULT 0 CHECK (upload_attempts >= 0),
            last_error_message text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            completed_at timestamptz
          )
        `;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS abstraction_status text NOT NULL DEFAULT 'pending'`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS abstraction_attempts integer NOT NULL DEFAULT 0 CHECK (abstraction_attempts >= 0)`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS abstraction_error_type text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS abstraction_error_message text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS payload_bytes integer CHECK (payload_bytes IS NULL OR payload_bytes >= 0)`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0)`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS model_used text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0)`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0)`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS abstraction_completed_at timestamptz`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS split_parent_chunk_id text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS split_reason text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS abstraction_claimed_at timestamptz`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS abstraction_lease_expires_at timestamptz`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS abstraction_worker_id text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS abstraction_retry_at timestamptz`;
        await sql`
          CREATE TABLE IF NOT EXISTS document_abstracts (
            id text PRIMARY KEY,
            job_id text NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
            document_id text NOT NULL REFERENCES job_documents(id) ON DELETE CASCADE,
            chunk_id text NOT NULL REFERENCES document_chunks(id) ON DELETE CASCADE UNIQUE,
            abstract_text text NOT NULL,
            model_used text,
            payload_bytes integer NOT NULL CHECK (payload_bytes >= 0),
            latency_ms integer NOT NULL CHECK (latency_ms >= 0),
            input_tokens integer,
            output_tokens integer,
            status text NOT NULL,
            attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count >= 0),
            error_type text,
            error_message text,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now()
          )
        `;
        await sql`CREATE INDEX IF NOT EXISTS idx_job_documents_job_status ON job_documents(job_id, upload_status)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_job_status ON document_chunks(job_id, upload_status)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_abstraction_status ON document_chunks(job_id, abstraction_status)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_abstraction_lease ON document_chunks(job_id, abstraction_status, abstraction_lease_expires_at)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_abstraction_retry ON document_chunks(job_id, abstraction_status, abstraction_retry_at)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_job_order ON document_chunks(job_id, chunk_order)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON document_chunks(document_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_abstracts_job_chunk_order ON document_abstracts(job_id, chunk_id)`;
      })();
    }
    await initialized;
  }

  async function refreshUploadCounts(jobId) {
    const jobRows = await sql`
      UPDATE analysis_jobs
      SET
        total_chunks = (SELECT COUNT(*)::integer FROM document_chunks WHERE job_id = ${jobId}),
        completed_chunks = (SELECT COUNT(*)::integer FROM document_chunks WHERE job_id = ${jobId} AND upload_status = 'uploaded'),
        failed_chunks = (SELECT COUNT(*)::integer FROM document_chunks WHERE job_id = ${jobId} AND upload_status = 'failed'),
        updated_at = now()
      WHERE id = ${jobId}
      RETURNING *
    `;
    return rowToJob(jobRows[0]);
  }

  async function refreshDocumentCounts(jobId, documentId) {
    const rows = await sql`
      WITH counts AS (
        SELECT
          COUNT(*)::integer AS total,
          COUNT(*) FILTER (WHERE upload_status = 'uploaded')::integer AS uploaded,
          COUNT(*) FILTER (WHERE upload_status = 'failed')::integer AS failed
        FROM document_chunks
        WHERE document_id = ${documentId} AND job_id = ${jobId}
      )
      UPDATE job_documents
      SET
        chunk_count = counts.total,
        completed_chunk_count = counts.uploaded,
        failed_chunk_count = counts.failed,
        upload_status = CASE
          WHEN counts.total > 0 AND counts.uploaded = counts.total THEN 'uploaded'
          WHEN counts.failed > 0 THEN 'failed'
          WHEN counts.total > 0 THEN 'uploading'
          ELSE upload_status
        END,
        updated_at = now()
      FROM counts
      WHERE id = ${documentId} AND job_id = ${jobId}
      RETURNING job_documents.*
    `;
    return rowToDocument(rows[0]);
  }

  async function refreshAbstractionCounts(jobId) {
    const rows = await sql`
      WITH counts AS (
        SELECT
          COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status <> 'split_superseded')::integer AS total,
          COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'completed')::integer AS completed,
          COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'failed')::integer AS failed,
          COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'retry_wait')::integer AS retry_wait,
          COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'processing')::integer AS processing,
          COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'pending')::integer AS pending
        FROM document_chunks
        WHERE job_id = ${jobId}
      )
      UPDATE analysis_jobs
      SET
        abstract_chunk_total = counts.total,
        abstract_chunk_completed = counts.completed,
        abstract_chunk_failed = counts.failed,
        completed_documents = counts.completed,
        failed_documents = counts.failed,
        current_phase = CASE
          WHEN counts.total > 0 AND counts.completed + counts.failed = counts.total
            THEN 'Server abstraction finished: ' || counts.completed || ' completed, ' || counts.failed || ' failed'
          WHEN counts.total > 0 AND counts.processing + counts.pending + counts.retry_wait > 0
            THEN 'Server abstraction ' || counts.completed || '/' || counts.total || ' (' || counts.processing || ' running, ' || counts.retry_wait || ' awaiting retry)'
          ELSE 'Server abstraction ' || counts.completed || '/' || counts.total
        END,
        status = CASE
          WHEN status = 'canceled' THEN 'canceled'
          WHEN counts.total > 0 AND counts.completed + counts.failed = counts.total AND counts.completed > 0 AND counts.failed > 0 THEN 'partial_failed'
          WHEN counts.total > 0 AND counts.completed + counts.failed = counts.total AND counts.completed > 0 THEN 'synthesizing'
          WHEN counts.total > 0 AND counts.completed + counts.failed = counts.total AND counts.completed = 0 THEN 'failed'
          ELSE 'abstracting'
        END,
        updated_at = now()
      FROM counts
      WHERE id = ${jobId}
      RETURNING analysis_jobs.*
    `;
    return rowToJob(rows[0]);
  }

  return {
    async createJob(input) {
      await ensureSchema();
      const id = `job_${randomUUID()}`;
      const rows = await sql`
        INSERT INTO analysis_jobs (
          id, status, subject_tract, context_notes, total_documents,
          completed_documents, failed_documents, current_phase
        )
        VALUES (
          ${id}, 'created', ${input.subjectTract}, ${input.contextNotes}, ${input.totalDocuments},
          0, 0, 'created'
        )
        RETURNING *
      `;
      return rowToJob(rows[0]);
    },

    async getJob(id) {
      await ensureSchema();
      const rows = await sql`SELECT * FROM analysis_jobs WHERE id = ${id} LIMIT 1`;
      return rowToJob(rows[0]);
    },

    async updateJob(id, patch) {
      await ensureSchema();
      const existing = await this.getJob(id);
      if (!existing) return null;
      const nextStatus = patch.status ?? existing.status;
      assertValidStatusTransition(existing.status, nextStatus);
      const completedAt = TERMINAL_STATUSES.has(nextStatus)
        ? (existing.completedAt || new Date().toISOString())
        : null;
      const startedAt = existing.startedAt || (nextStatus !== 'created' ? new Date().toISOString() : null);
      const rows = await sql`
        UPDATE analysis_jobs
        SET
          status = ${nextStatus},
          completed_documents = ${patch.completedDocuments ?? existing.completedDocuments},
          failed_documents = ${patch.failedDocuments ?? existing.failedDocuments},
          current_phase = ${patch.currentPhase ?? existing.currentPhase},
          error_message = ${patch.errorMessage === undefined ? existing.errorMessage : patch.errorMessage},
          started_at = ${startedAt},
          completed_at = ${completedAt},
          updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      return rowToJob(rows[0]);
    },

    async createDocument(jobId, input) {
      await ensureSchema();
      const existingJob = await this.getJob(jobId);
      if (!existingJob) return null;
      const id = `doc_${randomUUID()}`;
      const rows = await sql`
        INSERT INTO job_documents (
          id, job_id, original_filename, media_type, size_bytes,
          page_start, page_end, split_from, fingerprint, checksum_sha256, upload_status
        )
        VALUES (
          ${id}, ${jobId}, ${input.originalFilename}, ${input.mediaType}, ${input.sizeBytes},
          ${input.pageStart}, ${input.pageEnd}, ${input.splitFrom}, ${input.fingerprint}, ${input.checksumSha256}, ${input.uploadStatus}
        )
        RETURNING *
      `;
      if (existingJob.status === 'created') {
        await sql`
          UPDATE analysis_jobs
          SET status = 'uploading', current_phase = 'Uploading document chunks', updated_at = now()
          WHERE id = ${jobId}
        `;
      }
      return rowToDocument(rows[0]);
    },

    async getDocument(jobId, documentId) {
      await ensureSchema();
      const rows = await sql`
        SELECT * FROM job_documents
        WHERE job_id = ${jobId} AND id = ${documentId}
        LIMIT 1
      `;
      return rowToDocument(rows[0]);
    },

    async createChunk(jobId, documentId, input) {
      await ensureSchema();
      const document = await this.getDocument(jobId, documentId);
      if (!document) return null;
      const id = `chk_${randomUUID()}`;
      const blobKey = buildChunkBlobKey(jobId, id, input.originalFilename);
      const rows = await sql`
        INSERT INTO document_chunks (
          id, job_id, document_id, chunk_order, original_filename, blob_key,
          media_type, size_bytes, page_start, page_end, split_from,
          fingerprint, checksum_sha256, upload_status
        )
        VALUES (
          ${id}, ${jobId}, ${documentId}, ${input.chunkOrder}, ${input.originalFilename}, ${blobKey},
          ${input.mediaType}, ${input.sizeBytes}, ${input.pageStart}, ${input.pageEnd}, ${input.splitFrom},
          ${input.fingerprint}, ${input.checksumSha256}, ${input.uploadStatus}
        )
        RETURNING *
      `;
      await refreshDocumentCounts(jobId, documentId);
      await refreshUploadCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async updateChunk(jobId, chunkId, patch) {
      await ensureSchema();
      const existingRows = await sql`
        SELECT * FROM document_chunks
        WHERE job_id = ${jobId} AND id = ${chunkId}
        LIMIT 1
      `;
      const existing = rowToChunk(existingRows[0]);
      if (!existing) return null;
      const nextStatus = patch.uploadStatus ?? existing.uploadStatus;
      const nextAttempts = patch.uploadStatus && patch.uploadStatus !== existing.uploadStatus
        ? existing.uploadAttempts + 1
        : existing.uploadAttempts;
      const rows = await sql`
        UPDATE document_chunks
        SET
          upload_status = ${nextStatus},
          blob_key = ${patch.blobKey ?? existing.blobKey},
          blob_url = ${patch.blobUrl === undefined ? existing.blobUrl : patch.blobUrl},
          checksum_sha256 = ${patch.checksumSha256 === undefined ? existing.checksumSha256 : patch.checksumSha256},
          upload_attempts = ${nextAttempts},
          last_error_message = ${patch.lastErrorMessage === undefined ? existing.lastErrorMessage : patch.lastErrorMessage},
          completed_at = ${nextStatus === 'uploaded' ? (existing.completedAt || new Date().toISOString()) : null},
          updated_at = now()
        WHERE job_id = ${jobId} AND id = ${chunkId}
        RETURNING *
      `;
      await refreshDocumentCounts(jobId, existing.documentId);
      await refreshUploadCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async listChunks(jobId) {
      await ensureSchema();
      const rows = await sql`
        SELECT * FROM document_chunks
        WHERE job_id = ${jobId}
        ORDER BY chunk_order ASC, created_at ASC
      `;
      return rows.map(rowToChunk);
    },

    async getChunk(jobId, chunkId) {
      await ensureSchema();
      const rows = await sql`
        SELECT * FROM document_chunks
        WHERE job_id = ${jobId} AND id = ${chunkId}
        LIMIT 1
      `;
      return rowToChunk(rows[0]);
    },

    async markChunkAbstractionProcessing(jobId, chunkId) {
      await ensureSchema();
      const rows = await sql`
        UPDATE document_chunks
        SET
          abstraction_status = 'processing',
          abstraction_attempts = abstraction_attempts + 1,
          abstraction_error_type = NULL,
          abstraction_error_message = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}
          AND id = ${chunkId}
          AND upload_status = 'uploaded'
          AND abstraction_status = 'pending'
        RETURNING *
      `;
      return rowToChunk(rows[0]);
    },

    async claimChunkForAbstraction(jobId, chunkId, options = {}) {
      await ensureSchema();
      const workerId = options.workerId || `wkr_${Math.random().toString(36).slice(2, 10)}`;
      const leaseSeconds = Math.max(1, Math.ceil(Number(options.leaseMs || 90000) / 1000));
      const rows = await sql`
        UPDATE document_chunks
        SET
          abstraction_status = 'processing',
          abstraction_attempts = abstraction_attempts + 1,
          abstraction_error_type = NULL,
          abstraction_error_message = NULL,
          abstraction_claimed_at = now(),
          abstraction_lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
          abstraction_worker_id = ${workerId},
          abstraction_retry_at = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}
          AND id = ${chunkId}
          AND upload_status = 'uploaded'
          AND (
            abstraction_status = 'pending'
            OR (abstraction_status = 'retry_wait' AND (abstraction_retry_at IS NULL OR abstraction_retry_at <= now()))
            OR (abstraction_status = 'processing' AND (abstraction_lease_expires_at IS NULL OR abstraction_lease_expires_at <= now()))
          )
        RETURNING *
      `;
      return rowToChunk(rows[0]);
    },

    async markChunkAbstractionRetryWait(jobId, chunkId, failure) {
      await ensureSchema();
      const retryAt = failure?.retryAtIso ? new Date(failure.retryAtIso) : null;
      const rows = await sql`
        UPDATE document_chunks
        SET
          abstraction_status = 'retry_wait',
          abstraction_error_type = ${failure.errorType},
          abstraction_error_message = ${failure.errorMessage},
          abstraction_retry_at = ${retryAt},
          abstraction_claimed_at = NULL,
          abstraction_lease_expires_at = NULL,
          abstraction_worker_id = NULL,
          payload_bytes = ${failure.payloadBytes ?? null},
          latency_ms = ${failure.latencyMs ?? null},
          model_used = ${failure.modelUsed ?? null},
          updated_at = now()
        WHERE job_id = ${jobId} AND id = ${chunkId}
        RETURNING *
      `;
      await refreshAbstractionCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async listReadyAbstractionChunks(jobId, limit = 8) {
      await ensureSchema();
      const safeLimit = Math.max(1, Math.min(Number(limit) || 8, 64));
      const rows = await sql`
        SELECT * FROM document_chunks
        WHERE job_id = ${jobId}
          AND upload_status = 'uploaded'
          AND (
            abstraction_status = 'pending'
            OR (abstraction_status = 'retry_wait' AND (abstraction_retry_at IS NULL OR abstraction_retry_at <= now()))
            OR (abstraction_status = 'processing' AND (abstraction_lease_expires_at IS NULL OR abstraction_lease_expires_at <= now()))
          )
        ORDER BY chunk_order ASC, created_at ASC
        LIMIT ${safeLimit}
      `;
      return rows.map(rowToChunk);
    },

    async refreshAbstractionRollup(jobId) {
      await ensureSchema();
      return await refreshAbstractionCounts(jobId);
    },

    async cancelJob(jobId, reason = null) {
      await ensureSchema();
      const rows = await sql`
        UPDATE analysis_jobs
        SET status = 'canceled',
            current_phase = 'canceled',
            error_message = ${reason || 'Job canceled by user.'},
            completed_at = COALESCE(completed_at, now()),
            updated_at = now()
        WHERE id = ${jobId}
        RETURNING *
      `;
      await sql`
        UPDATE document_chunks
        SET abstraction_claimed_at = NULL,
            abstraction_lease_expires_at = NULL,
            abstraction_worker_id = NULL,
            updated_at = now()
        WHERE job_id = ${jobId}
          AND abstraction_status = 'processing'
      `;
      return rowToJob(rows[0]);
    },

    async retryFailedChunks(jobId) {
      await ensureSchema();
      const rows = await sql`
        UPDATE document_chunks
        SET abstraction_status = 'pending',
            abstraction_error_type = NULL,
            abstraction_error_message = NULL,
            abstraction_retry_at = NULL,
            abstraction_claimed_at = NULL,
            abstraction_lease_expires_at = NULL,
            abstraction_worker_id = NULL,
            updated_at = now()
        WHERE job_id = ${jobId}
          AND abstraction_status IN ('failed', 'retry_wait')
        RETURNING id
      `;
      if (rows.length) await refreshAbstractionCounts(jobId);
      return rows.length;
    },

    async markChunkAbstractionFailed(jobId, chunkId, failure) {
      await ensureSchema();
      const rows = await sql`
        UPDATE document_chunks
        SET
          abstraction_status = 'failed',
          abstraction_error_type = ${failure.errorType},
          abstraction_error_message = ${failure.errorMessage},
          payload_bytes = ${failure.payloadBytes ?? null},
          latency_ms = ${failure.latencyMs ?? null},
          model_used = ${failure.modelUsed ?? null},
          abstraction_claimed_at = NULL,
          abstraction_lease_expires_at = NULL,
          abstraction_worker_id = NULL,
          abstraction_retry_at = NULL,
          updated_at = now()
        WHERE job_id = ${jobId} AND id = ${chunkId}
        RETURNING *
      `;
      await refreshAbstractionCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async markChunkAbstractionSplitSuperseded(jobId, chunkId, reason) {
      await ensureSchema();
      const rows = await sql`
        UPDATE document_chunks
        SET
          abstraction_status = 'split_superseded',
          abstraction_error_type = ${reason},
          abstraction_error_message = 'PDF chunk was split into smaller child chunks for retry.',
          updated_at = now()
        WHERE job_id = ${jobId} AND id = ${chunkId}
        RETURNING *
      `;
      await refreshAbstractionCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async createSplitChunk(jobId, documentId, input) {
      await ensureSchema();
      const id = `chk_${randomUUID()}`;
      const rows = await sql`
        INSERT INTO document_chunks (
          id, job_id, document_id, chunk_order, original_filename, blob_key,
          blob_url, media_type, size_bytes, page_start, page_end, split_from,
          fingerprint, checksum_sha256, upload_status, abstraction_status,
          split_parent_chunk_id, split_reason
        )
        VALUES (
          ${id}, ${jobId}, ${documentId}, ${input.chunkOrder}, ${input.originalFilename}, ${input.blobKey},
          ${input.blobUrl}, ${input.mediaType}, ${input.sizeBytes}, ${input.pageStart}, ${input.pageEnd}, ${input.splitFrom},
          ${input.fingerprint}, ${input.checksumSha256}, 'uploaded', 'pending',
          ${input.splitParentChunkId}, ${input.splitReason}
        )
        RETURNING *
      `;
      await refreshDocumentCounts(jobId, documentId);
      await refreshUploadCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async saveDocumentAbstract(record) {
      await ensureSchema();
      const id = `abs_${randomUUID()}`;
      const rows = await sql`
        INSERT INTO document_abstracts (
          id, job_id, document_id, chunk_id, abstract_text, model_used,
          payload_bytes, latency_ms, input_tokens, output_tokens,
          status, attempt_count, error_type, error_message
        )
        VALUES (
          ${id}, ${record.jobId}, ${record.documentId}, ${record.chunkId}, ${record.abstractText}, ${record.modelUsed},
          ${record.payloadBytes}, ${record.latencyMs}, ${record.inputTokens}, ${record.outputTokens},
          ${record.status}, ${record.attemptCount}, ${record.errorType ?? null}, ${record.errorMessage ?? null}
        )
        ON CONFLICT (chunk_id) DO UPDATE
        SET
          abstract_text = EXCLUDED.abstract_text,
          model_used = EXCLUDED.model_used,
          payload_bytes = EXCLUDED.payload_bytes,
          latency_ms = EXCLUDED.latency_ms,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          status = EXCLUDED.status,
          attempt_count = EXCLUDED.attempt_count,
          error_type = EXCLUDED.error_type,
          error_message = EXCLUDED.error_message,
          updated_at = now()
        RETURNING *
      `;
      await sql`
        UPDATE document_chunks
        SET
          abstraction_status = 'completed',
          abstraction_error_type = NULL,
          abstraction_error_message = NULL,
          payload_bytes = ${record.payloadBytes},
          latency_ms = ${record.latencyMs},
          model_used = ${record.modelUsed},
          input_tokens = ${record.inputTokens},
          output_tokens = ${record.outputTokens},
          abstraction_completed_at = now(),
          abstraction_claimed_at = NULL,
          abstraction_lease_expires_at = NULL,
          abstraction_worker_id = NULL,
          abstraction_retry_at = NULL,
          updated_at = now()
        WHERE job_id = ${record.jobId} AND id = ${record.chunkId}
      `;
      await refreshAbstractionCounts(record.jobId);
      return rowToAbstract(rows[0]);
    },

    async listDocumentAbstracts(jobId) {
      await ensureSchema();
      const rows = await sql`
        SELECT
          da.*,
          dc.chunk_order,
          dc.original_filename
        FROM document_abstracts da
        JOIN document_chunks dc ON dc.id = da.chunk_id
        WHERE da.job_id = ${jobId}
        ORDER BY dc.chunk_order ASC, da.created_at ASC
      `;
      return rows.map(rowToAbstract);
    },

    async resetChunkAbstraction(jobId, chunkId) {
      await ensureSchema();
      const rows = await sql`
        UPDATE document_chunks
        SET
          abstraction_status = 'pending',
          abstraction_error_type = NULL,
          abstraction_error_message = NULL,
          abstraction_retry_at = NULL,
          abstraction_claimed_at = NULL,
          abstraction_lease_expires_at = NULL,
          abstraction_worker_id = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}
          AND id = ${chunkId}
          AND abstraction_status IN ('failed', 'retry_wait')
        RETURNING *
      `;
      if (rows.length) await refreshAbstractionCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async getAbstractionStatus(jobId) {
      await ensureSchema();
      const chunks = (await this.listChunks(jobId)).filter(chunk => chunk.abstractionStatus !== 'split_superseded');
      const counts = chunks.reduce((acc, chunk) => {
        const status = chunk.abstractionStatus || 'pending';
        acc[status] = (acc[status] || 0) + 1;
        return acc;
      }, {});
      return {
        total: chunks.length,
        pending: counts.pending || 0,
        processing: counts.processing || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        retry_wait: counts.retry_wait || 0,
        failedChunks: chunks.filter(chunk => chunk.abstractionStatus === 'failed'),
        job: await this.getJob(jobId),
      };
    },

    async resetStaleProcessingChunks(jobId, staleMs = 120000) {
      await ensureSchema();
      const staleSeconds = Math.max(1, Math.ceil(Number(staleMs) / 1000));
      const rows = await sql`
        UPDATE document_chunks
        SET
          abstraction_status = 'pending',
          abstraction_error_type = 'stale_processing_recovered',
          abstraction_error_message = 'Previous server-side abstraction attempt was interrupted and has been requeued.',
          abstraction_claimed_at = NULL,
          abstraction_lease_expires_at = NULL,
          abstraction_worker_id = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}
          AND abstraction_status = 'processing'
          AND (
            (abstraction_lease_expires_at IS NOT NULL AND abstraction_lease_expires_at <= now())
            OR (abstraction_lease_expires_at IS NULL AND updated_at < now() - make_interval(secs => ${staleSeconds}))
          )
        RETURNING *
      `;
      if (rows.length) await refreshAbstractionCounts(jobId);
      return rows.map(rowToChunk);
    },

    async finalizeUploads(jobId) {
      await ensureSchema();
      const chunks = await this.listChunks(jobId);
      const pendingChunks = chunks.filter(chunk => chunk.uploadStatus !== 'uploaded').length;
      if (!chunks.length || pendingChunks > 0) {
        return { ready: false, job: await refreshUploadCounts(jobId), pendingChunks: pendingChunks || 1 };
      }
      const existing = await this.getJob(jobId);
      if (!existing) return null;
      if (existing.status !== 'ready') {
        assertValidStatusTransition(existing.status, 'ready');
      }
      const rows = await sql`
        UPDATE analysis_jobs
        SET status = 'ready', current_phase = 'ready', updated_at = now()
        WHERE id = ${jobId}
        RETURNING *
      `;
      return { ready: true, job: rowToJob(rows[0]), pendingChunks: 0 };
    },
  };
}

export function getJobStore() {
  if (globalThis.__TITLE_ANALYZER_JOB_STORE__) {
    return globalThis.__TITLE_ANALYZER_JOB_STORE__;
  }
  if (!cachedStore) cachedStore = createPostgresJobStore();
  return cachedStore;
}

export function sendStorageNotConfigured(res, requestId) {
  return res.status(503).json({
    error: 'DATABASE_URL or POSTGRES_URL is required for durable job metadata.',
    requestId,
  });
}
