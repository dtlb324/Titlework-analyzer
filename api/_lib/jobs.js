import { randomUUID } from 'crypto';
import { neon } from '@neondatabase/serverless';
import { buildObjectKey, isAllowedStorageUrl, validateObjectRef } from './storage.js';

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
  failed: new Set(['failed', 'abstracting', 'synthesizing', 'canceled']),
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
const JOB_RATE_LIMIT_MAX_REQUESTS = 1500;
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
const SYNTHESIS_SEGMENT_STATUSES = new Set(['pending', 'processing', 'complete', 'failed', 'retry_wait']);
const JOB_RESULT_STATUSES = new Set(['complete', 'partial_failed', 'failed']);
const MAX_FOLLOWUP_QUESTION_CHARS = 2000;
const MAX_RESULT_WARNINGS = 100;
const MAX_RESULT_FAILED_DOCUMENTS = 1000;
const MAX_TITLE_OPINION_CHARS = 4_000_000;
const ALLOWED_IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

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
  return value === 'application/pdf' || value === 'text/csv' || ALLOWED_IMAGE_MEDIA_TYPES.has(value || '');
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
  return isAllowedStorageUrl(value);
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
  return buildObjectKey(jobId, chunkId, originalFilename);
}

function buildChunkBlobPrefix(jobId, chunkId) {
  return `jobs/${jobId}/chunks/${chunkId}/`;
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

  if (input.subjectTract !== undefined || input.tractDescription !== undefined) {
    patch.subjectTract = truncateText(input.subjectTract ?? input.tractDescription, 500);
  }
  if (input.currentPhase !== undefined) patch.currentPhase = truncateText(input.currentPhase, 200) || existingJob.currentPhase;
  if (input.errorMessage !== undefined) patch.errorMessage = truncateText(input.errorMessage, 1000);
  return { valid: true, patch };
}

function sanitizeResultWarning(value) {
  if (typeof value === 'string') return truncateText(value, 1000);
  if (value && typeof value === 'object') return truncateText(value.message || value.error || JSON.stringify(value), 1000);
  return null;
}

function sanitizeResultFailedDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    const label = truncateText(String(value || ''), MAX_FILENAME_LENGTH);
    return label ? { name: label } : null;
  }
  return {
    id: truncateText(value.id, 200),
    documentId: truncateText(value.documentId || value.document_id, 200),
    originalFilename: truncateText(value.originalFilename || value.filename || value.name, MAX_FILENAME_LENGTH),
    errorMessage: truncateText(value.errorMessage || value.lastError || value.error, 1000),
  };
}

export function inferSynthesisDriver(result) {
  if (!result) return null;
  if (result.synthesisDriver === 'browser' || result.synthesisDriver === 'server') return result.synthesisDriver;
  const warnings = (result.warnings || []).map(w => String(w));
  if (warnings.includes('synthesis_driver:browser')) return 'browser';
  if (warnings.includes('synthesis_driver:server')) return 'server';
  if (result.finalTitleOpinion) return 'server';
  return null;
}

export function validateSaveJobResultInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, statusCode: 400, reason: 'Invalid job result body.' };
  }
  const finalTitleOpinion = truncateText(
    input.finalTitleOpinion ?? input.titleOpinion ?? input.opinion,
    MAX_TITLE_OPINION_CHARS
  );
  if (!finalTitleOpinion) {
    return { valid: false, statusCode: 400, reason: 'finalTitleOpinion is required.' };
  }
  const status = JOB_RESULT_STATUSES.has(input.status) ? input.status : 'complete';
  const warnings = Array.isArray(input.warnings)
    ? input.warnings.map(sanitizeResultWarning).filter(Boolean).slice(0, MAX_RESULT_WARNINGS)
    : [];
  const failedDocuments = Array.isArray(input.failedDocuments)
    ? input.failedDocuments.map(sanitizeResultFailedDocument).filter(Boolean).slice(0, MAX_RESULT_FAILED_DOCUMENTS)
    : [];
  const inputTokens = toInteger(input.inputTokens, null);
  const outputTokens = toInteger(input.outputTokens, null);
  const payloadBytes = toInteger(input.payloadBytes, null);
  const synthesisDurationMs = toInteger(input.synthesisDurationMs, null);
  const synthesisDriver = input.synthesisDriver === 'browser' ? 'browser' : null;
  if (synthesisDriver === 'browser' && !warnings.some(w => String(w).startsWith('synthesis_driver:'))) {
    warnings.unshift('synthesis_driver:browser');
  }
  return {
    valid: true,
    payload: {
      planId: truncateText(input.planId, 200),
      status,
      finalTitleOpinion,
      warnings,
      failedDocuments,
      modelUsed: truncateText(input.modelUsed, 100),
      inputTokens: Number.isInteger(inputTokens) && inputTokens >= 0 ? inputTokens : null,
      outputTokens: Number.isInteger(outputTokens) && outputTokens >= 0 ? outputTokens : null,
      payloadBytes: Number.isInteger(payloadBytes) && payloadBytes >= 0 ? payloadBytes : null,
      synthesisDurationMs: Number.isInteger(synthesisDurationMs) && synthesisDurationMs >= 0 ? synthesisDurationMs : null,
      synthesisDriver,
    },
  };
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
    return { valid: false, reason: 'mediaType must be application/pdf, text/csv, image/jpeg, image/png, image/gif, or image/webp.' };
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
    return { valid: false, reason: 'mediaType must be application/pdf, text/csv, image/jpeg, image/png, image/gif, or image/webp.' };
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

export function validateImportContinuationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, reason: 'Invalid import-continuation request body.' };
  }
  if (hasRawPayloadFields(input)) {
    return { valid: false, reason: 'Import-continuation must not include raw documents, abstracts, CSV text, base64 payloads, or title opinions.' };
  }
  const sourceJobId = truncateText(input.sourceJobId, 200);
  if (!sourceJobId || !/^job_[a-z0-9_]+$/i.test(sourceJobId)) {
    return { valid: false, reason: 'sourceJobId must be a valid job id.' };
  }
  return { valid: true, value: { sourceJobId } };
}

export function validatePatchChunkInput(input, context = {}) {
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
    if (input.uploadStatus === 'uploaded' && (!input.blobUrl || !input.blobKey)) {
      return { valid: false, reason: 'Uploaded chunks must include blobKey and blobUrl.' };
    }
    patch.uploadStatus = input.uploadStatus;
  }
  if (input.blobKey !== undefined) {
    if (!isSafeMetadataString(input.blobKey, MAX_BLOB_REF_LENGTH) || input.blobKey.includes('..')) {
      return { valid: false, reason: 'Invalid blobKey.' };
    }
    if (context.jobId && context.chunkId && !input.blobKey.startsWith(buildChunkBlobPrefix(context.jobId, context.chunkId))) {
      return { valid: false, reason: 'blobKey must match the job and chunk upload prefix.' };
    }
    patch.blobKey = input.blobKey;
  }
  if (input.blobUrl !== undefined) {
    if (!isSafeMetadataString(input.blobUrl, MAX_BLOB_REF_LENGTH) || !isAllowedBlobUrl(input.blobUrl)) {
      return { valid: false, reason: 'Invalid blobUrl.' };
    }
    if (context.jobId && context.chunkId && input.blobKey) {
      const storageRef = validateObjectRef({
        jobId: context.jobId,
        chunkId: context.chunkId,
        objectKey: input.blobKey,
        objectUrl: input.blobUrl,
      });
      if (!storageRef.valid) return { valid: false, reason: storageRef.reason };
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
    synthesisPlanId: row.synthesis_plan_id || null,
    synthesisMergeWorkerId: row.synthesis_merge_worker_id || null,
    synthesisMergeLeaseExpiresAt: row.synthesis_merge_lease_expires_at instanceof Date
      ? row.synthesis_merge_lease_expires_at.toISOString()
      : row.synthesis_merge_lease_expires_at,
    synthesisPreviewText: row.synthesis_preview_text || null,
    synthesisPreviewComplete: Boolean(row.synthesis_preview_complete),
    synthesisPreviewBytes: row.synthesis_preview_bytes ?? 0,
    synthesisPreviewUpdatedAt: row.synthesis_preview_updated_at instanceof Date
      ? row.synthesis_preview_updated_at.toISOString()
      : row.synthesis_preview_updated_at,
    synthesisPreviewModelUsed: row.synthesis_preview_model_used || null,
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
    splitParentChunkId: row.split_parent_chunk_id,
    splitReason: row.split_reason,
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
    pageStart: row.page_start,
    pageEnd: row.page_end,
    splitFrom: row.split_from,
    sourceFilename: row.source_filename,
    blobKey: row.blob_key,
    blobUrl: row.blob_url,
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

function rowToSynthesisSegment(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    planId: row.plan_id,
    segmentIndex: row.segment_index,
    startSequenceIndex: row.start_sequence_index,
    endSequenceIndex: row.end_sequence_index,
    documentIds: Array.isArray(row.document_ids) ? row.document_ids : (row.document_ids ? JSON.parse(row.document_ids) : []),
    filenames: Array.isArray(row.filenames) ? row.filenames : (row.filenames ? JSON.parse(row.filenames) : []),
    estimatedBytes: row.estimated_bytes,
    status: row.status,
    attemptCount: row.attempt_count,
    summaryText: row.summary_text,
    modelUsed: row.model_used,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    payloadBytes: row.payload_bytes,
    latencyMs: row.latency_ms,
    errorType: row.error_type,
    errorMessage: row.error_message,
    warnings: Array.isArray(row.warnings) ? row.warnings : (row.warnings ? JSON.parse(row.warnings) : []),
    leaseExpiresAt: row.lease_expires_at instanceof Date ? row.lease_expires_at.toISOString() : row.lease_expires_at,
    claimedAt: row.claimed_at instanceof Date ? row.claimed_at.toISOString() : row.claimed_at,
    workerId: row.worker_id,
    retryAt: row.retry_at instanceof Date ? row.retry_at.toISOString() : row.retry_at,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
  };
}

function rowToJobResult(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    planId: row.plan_id,
    status: row.status,
    finalTitleOpinion: row.final_title_opinion,
    warnings: Array.isArray(row.warnings_json) ? row.warnings_json : (row.warnings_json ? JSON.parse(row.warnings_json) : []),
    failedDocuments: Array.isArray(row.failed_documents_json) ? row.failed_documents_json : (row.failed_documents_json ? JSON.parse(row.failed_documents_json) : []),
    modelUsed: row.model_used,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    payloadBytes: row.payload_bytes,
    synthesisDurationMs: row.synthesis_duration_ms,
    generatedAt: row.generated_at instanceof Date ? row.generated_at.toISOString() : row.generated_at,
  };
}

function rowToFollowupMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    question: row.question,
    answer: row.answer,
    modelUsed: row.model_used,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    payloadBytes: row.payload_bytes,
    retrievedDocumentIds: Array.isArray(row.retrieved_document_ids) ? row.retrieved_document_ids : (row.retrieved_document_ids ? JSON.parse(row.retrieved_document_ids) : []),
    truncationWarning: row.truncation_warning,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

export function validateFollowupRequestInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, reason: 'Invalid follow-up request body.' };
  }
  if (hasRawPayloadFields(input)) {
    return { valid: false, reason: 'Follow-up requests must not include raw documents, abstracts, CSV text, base64 payloads, or title opinions.' };
  }
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (!question) return { valid: false, reason: 'question is required.' };
  if (question.length > MAX_FOLLOWUP_QUESTION_CHARS) {
    return { valid: false, reason: `question must be ${MAX_FOLLOWUP_QUESTION_CHARS} characters or fewer.` };
  }
  return { valid: true, value: { question } };
}

export function validateSynthesisRequestInput(input) {
  if (input === undefined || input === null || input === '') return { valid: true, value: {} };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, reason: 'Invalid synthesis request body.' };
  }
  if (hasRawPayloadFields(input)) {
    return { valid: false, reason: 'Synthesis endpoints must not accept raw documents, abstracts, CSV text, base64 payloads, or title opinions. The server reads stored abstracts directly.' };
  }
  return { valid: true, value: {} };
}

export function getDatabaseUrl(env = process.env) {
  return env.DATABASE_URL || env.POSTGRES_URL || env.POSTGRES_PRISMA_URL || '';
}

export function createSqlClient(databaseUrl) {
  return neon(databaseUrl);
}

function createPostgresJobStore() {
  const databaseUrl = getDatabaseUrl();
  if (!databaseUrl) {
    return null;
  }
  const sql = createSqlClient(databaseUrl);
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
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS original_filename text`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS job_id text`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS media_type text`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS size_bytes integer CHECK (size_bytes IS NULL OR size_bytes >= 0)`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS page_start integer`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS page_end integer`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS split_from text`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS fingerprint text`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS checksum_sha256 text`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS upload_status text NOT NULL DEFAULT 'pending'`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS chunk_count integer NOT NULL DEFAULT 0 CHECK (chunk_count >= 0)`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS completed_chunk_count integer NOT NULL DEFAULT 0 CHECK (completed_chunk_count >= 0)`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS failed_chunk_count integer NOT NULL DEFAULT 0 CHECK (failed_chunk_count >= 0)`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`;
        await sql`ALTER TABLE job_documents ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`;
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
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS chunk_order integer CHECK (chunk_order IS NULL OR chunk_order >= 0)`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS job_id text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS document_id text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS original_filename text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS blob_key text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS blob_url text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS media_type text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS size_bytes integer CHECK (size_bytes IS NULL OR size_bytes >= 0)`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS page_start integer`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS page_end integer`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS split_from text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS fingerprint text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS checksum_sha256 text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS upload_status text NOT NULL DEFAULT 'pending'`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS upload_attempts integer NOT NULL DEFAULT 0 CHECK (upload_attempts >= 0)`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS last_error_message text`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`;
        await sql`ALTER TABLE document_chunks ADD COLUMN IF NOT EXISTS completed_at timestamptz`;
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
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS abstract_text text`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS job_id text`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS document_id text`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS chunk_id text`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS model_used text`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS payload_bytes integer CHECK (payload_bytes IS NULL OR payload_bytes >= 0)`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS latency_ms integer CHECK (latency_ms IS NULL OR latency_ms >= 0)`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS input_tokens integer`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS output_tokens integer`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS status text`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count >= 0)`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS error_type text`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS error_message text`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`;
        await sql`ALTER TABLE document_abstracts ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`;
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_document_abstracts_chunk_unique ON document_abstracts(chunk_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_job_documents_job_status ON job_documents(job_id, upload_status)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_job_status ON document_chunks(job_id, upload_status)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_abstraction_status ON document_chunks(job_id, abstraction_status)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_abstraction_lease ON document_chunks(job_id, abstraction_status, abstraction_lease_expires_at)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_abstraction_retry ON document_chunks(job_id, abstraction_status, abstraction_retry_at)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_job_order ON document_chunks(job_id, chunk_order)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_chunks_document ON document_chunks(document_id)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_document_abstracts_job_chunk_order ON document_abstracts(job_id, chunk_id)`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS synthesis_plan_id text`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS synthesis_merge_worker_id text`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS synthesis_merge_lease_expires_at timestamptz`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS synthesis_preview_text text`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS synthesis_preview_complete boolean NOT NULL DEFAULT false`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS synthesis_preview_bytes integer NOT NULL DEFAULT 0 CHECK (synthesis_preview_bytes >= 0)`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS synthesis_preview_updated_at timestamptz`;
        await sql`ALTER TABLE analysis_jobs ADD COLUMN IF NOT EXISTS synthesis_preview_model_used text`;
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_document_chunks_split_child_unique ON document_chunks(job_id, split_parent_chunk_id, fingerprint) WHERE split_parent_chunk_id IS NOT NULL AND fingerprint IS NOT NULL`;
        await sql`
          CREATE TABLE IF NOT EXISTS synthesis_segments (
            id text PRIMARY KEY,
            job_id text NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
            plan_id text NOT NULL,
            segment_index integer NOT NULL CHECK (segment_index >= 0),
            start_sequence_index integer NOT NULL CHECK (start_sequence_index >= 0),
            end_sequence_index integer NOT NULL CHECK (end_sequence_index >= start_sequence_index),
            document_ids jsonb NOT NULL,
            filenames jsonb NOT NULL,
            estimated_bytes integer,
            status text NOT NULL DEFAULT 'pending',
            attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
            summary_text text,
            model_used text,
            input_tokens integer,
            output_tokens integer,
            payload_bytes integer,
            latency_ms integer,
            error_type text,
            error_message text,
            warnings jsonb,
            lease_expires_at timestamptz,
            claimed_at timestamptz,
            worker_id text,
            retry_at timestamptz,
            created_at timestamptz NOT NULL DEFAULT now(),
            updated_at timestamptz NOT NULL DEFAULT now(),
            completed_at timestamptz,
            UNIQUE (job_id, plan_id, segment_index)
          )
        `;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS job_id text`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS plan_id text`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS segment_index integer CHECK (segment_index IS NULL OR segment_index >= 0)`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS start_sequence_index integer CHECK (start_sequence_index IS NULL OR start_sequence_index >= 0)`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS end_sequence_index integer`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS document_ids jsonb`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS filenames jsonb`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS estimated_bytes integer`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending'`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0)`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS summary_text text`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS model_used text`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS input_tokens integer`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS output_tokens integer`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS payload_bytes integer`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS latency_ms integer`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS error_type text`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS error_message text`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS warnings jsonb`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS claimed_at timestamptz`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS worker_id text`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS retry_at timestamptz`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`;
        await sql`ALTER TABLE synthesis_segments ADD COLUMN IF NOT EXISTS completed_at timestamptz`;
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_synthesis_segments_job_plan_segment_unique ON synthesis_segments(job_id, plan_id, segment_index)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_synthesis_segments_job_plan ON synthesis_segments(job_id, plan_id, segment_index)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_synthesis_segments_job_status ON synthesis_segments(job_id, status)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_synthesis_segments_lease ON synthesis_segments(job_id, status, lease_expires_at)`;
        await sql`CREATE INDEX IF NOT EXISTS idx_synthesis_segments_retry ON synthesis_segments(job_id, status, retry_at)`;
        await sql`
          CREATE TABLE IF NOT EXISTS job_results (
            id text PRIMARY KEY,
            job_id text NOT NULL UNIQUE REFERENCES analysis_jobs(id) ON DELETE CASCADE,
            plan_id text,
            status text NOT NULL,
            final_title_opinion text,
            warnings_json jsonb,
            failed_documents_json jsonb,
            model_used text,
            input_tokens integer,
            output_tokens integer,
            payload_bytes integer,
            synthesis_duration_ms integer,
            generated_at timestamptz NOT NULL DEFAULT now()
          )
        `;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS job_id text`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS plan_id text`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS status text`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS final_title_opinion text`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS warnings_json jsonb`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS failed_documents_json jsonb`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS model_used text`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS input_tokens integer`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS output_tokens integer`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS payload_bytes integer`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS synthesis_duration_ms integer`;
        await sql`ALTER TABLE job_results ADD COLUMN IF NOT EXISTS generated_at timestamptz NOT NULL DEFAULT now()`;
        await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_job_results_job_unique ON job_results(job_id)`;
        await sql`
          CREATE TABLE IF NOT EXISTS followup_messages (
            id text PRIMARY KEY,
            job_id text NOT NULL REFERENCES analysis_jobs(id) ON DELETE CASCADE,
            question text NOT NULL,
            answer text NOT NULL,
            model_used text,
            input_tokens integer,
            output_tokens integer,
            payload_bytes integer,
            retrieved_document_ids jsonb,
            truncation_warning text,
            created_at timestamptz NOT NULL DEFAULT now()
          )
        `;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS job_id text`;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS question text`;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS answer text`;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS model_used text`;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS input_tokens integer`;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS output_tokens integer`;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS payload_bytes integer`;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS retrieved_document_ids jsonb`;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS truncation_warning text`;
        await sql`ALTER TABLE followup_messages ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`;
        await sql`CREATE INDEX IF NOT EXISTS idx_followup_messages_job ON followup_messages(job_id, created_at)`;
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
          COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'pending')::integer AS pending,
          COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'split_superseded')::integer AS superseded
        FROM document_chunks
        WHERE job_id = ${jobId}
      ),
      document_counts AS (
        SELECT
          COUNT(*) FILTER (
            WHERE chunk_count > 0
              AND completed_chunks + superseded_chunks = chunk_count
              AND failed_chunks = 0
          )::integer AS completed_documents,
          COUNT(*) FILTER (
            WHERE chunk_count > 0
              AND failed_chunks > 0
              AND completed_chunks + failed_chunks + superseded_chunks = chunk_count
          )::integer AS failed_documents
        FROM (
          SELECT
            document_id,
            COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status <> 'split_superseded')::integer AS chunk_count,
            COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'completed')::integer AS completed_chunks,
            COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'failed')::integer AS failed_chunks,
            COUNT(*) FILTER (WHERE upload_status = 'uploaded' AND abstraction_status = 'split_superseded')::integer AS superseded_chunks
          FROM document_chunks
          WHERE job_id = ${jobId}
          GROUP BY document_id
        ) per_document
      )
      UPDATE analysis_jobs
      SET
        abstract_chunk_total = counts.total,
        abstract_chunk_completed = counts.completed,
        abstract_chunk_failed = counts.failed,
        completed_documents = LEAST(document_counts.completed_documents, total_documents),
        failed_documents = LEAST(document_counts.failed_documents, total_documents),
        current_phase = CASE
          WHEN counts.total > 0 AND counts.completed + counts.failed = counts.total
            THEN 'Server abstraction finished: ' || counts.completed || ' completed, ' || counts.failed || ' failed'
          WHEN counts.superseded > 0 AND counts.processing + counts.pending + counts.retry_wait > 0
            THEN 'Re-segmenting oversized PDF for model limits: ' || counts.completed || '/' || counts.total || ' chunks'
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
      FROM counts, document_counts
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
          subject_tract = ${patch.subjectTract === undefined ? existing.subjectTract : patch.subjectTract},
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
      if (TERMINAL_STATUSES.has(existingJob.status)) {
        throw new JobApiError('Cannot add documents to a terminal job.', 409);
      }
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

    async findDocumentByFingerprint(jobId, fingerprint) {
      await ensureSchema();
      if (!fingerprint) return null;
      const rows = await sql`
        SELECT * FROM job_documents
        WHERE job_id = ${jobId} AND fingerprint = ${fingerprint}
        ORDER BY created_at ASC
        LIMIT 1
      `;
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
      const job = await this.getJob(jobId);
      if (!job) return null;
      if (TERMINAL_STATUSES.has(job.status)) {
        throw new JobApiError('Cannot add chunks to a terminal job.', 409);
      }
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
          ${input.fingerprint}, ${input.checksumSha256}, ${input.uploadStatus}::text
        )
        RETURNING *
      `;
      await refreshDocumentCounts(jobId, documentId);
      await refreshUploadCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async findChunkByFingerprint(jobId, documentId, fingerprint, chunkOrder) {
      await ensureSchema();
      if (!fingerprint) return null;
      const rows = await sql`
        SELECT * FROM document_chunks
        WHERE job_id = ${jobId}
          AND document_id = ${documentId}
          AND fingerprint = ${fingerprint}
          AND chunk_order = ${chunkOrder}
        ORDER BY created_at ASC
        LIMIT 1
      `;
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
        WHERE job_id = ${jobId}
          AND id = ${chunkId}
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
        WHERE job_id = ${jobId}
          AND id = ${chunkId}
          AND (${failure.workerId ?? null} IS NULL OR (abstraction_status = 'processing' AND abstraction_worker_id = ${failure.workerId}))
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

    async listRunnableAbstractionJobIds(limit = 20) {
      await ensureSchema();
      const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
      const rows = await sql`
        SELECT DISTINCT dc.job_id
        FROM document_chunks dc
        INNER JOIN analysis_jobs j ON j.id = dc.job_id
        WHERE j.status <> 'canceled'
          AND dc.upload_status = 'uploaded'
          AND (
            dc.abstraction_status = 'pending'
            OR (dc.abstraction_status = 'retry_wait' AND (dc.abstraction_retry_at IS NULL OR dc.abstraction_retry_at <= now()))
            OR (dc.abstraction_status = 'processing' AND (dc.abstraction_lease_expires_at IS NULL OR dc.abstraction_lease_expires_at <= now()))
          )
        ORDER BY dc.job_id ASC
        LIMIT ${safeLimit}
      `;
      return rows.map(row => row.job_id);
    },

    async refreshAbstractionRollup(jobId) {
      await ensureSchema();
      return await refreshAbstractionCounts(jobId);
    },

    async cancelJob(jobId, reason = null) {
      await ensureSchema();
      const cancelReason = reason || 'Job canceled by user.';
      const rows = await sql`
        UPDATE analysis_jobs
        SET status = 'canceled',
            current_phase = 'canceled',
            error_message = ${cancelReason},
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
      await sql`
        UPDATE document_chunks
        SET abstraction_status = 'failed',
            abstraction_error_type = 'canceled',
            abstraction_error_message = ${cancelReason},
            abstraction_retry_at = NULL,
            abstraction_claimed_at = NULL,
            abstraction_lease_expires_at = NULL,
            abstraction_worker_id = NULL,
            updated_at = now()
        WHERE job_id = ${jobId}
          AND abstraction_status IN ('pending', 'retry_wait')
      `;
      await refreshAbstractionCounts(jobId);
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
        WHERE job_id = ${jobId}
          AND id = ${chunkId}
          AND (${failure.workerId ?? null} IS NULL OR (abstraction_status = 'processing' AND abstraction_worker_id = ${failure.workerId}))
        RETURNING *
      `;
      await refreshAbstractionCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async markChunkAbstractionSplitSuperseded(jobId, chunkId, reason, workerId = null) {
      await ensureSchema();
      const rows = await sql`
        UPDATE document_chunks
        SET
          abstraction_status = 'split_superseded',
          abstraction_error_type = ${reason},
          abstraction_error_message = 'PDF chunk was split into smaller child chunks for retry.',
          abstraction_claimed_at = NULL,
          abstraction_lease_expires_at = NULL,
          abstraction_worker_id = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}
          AND id = ${chunkId}
          AND (${workerId ?? null} IS NULL OR (abstraction_status = 'processing' AND abstraction_worker_id = ${workerId}))
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
        SELECT
          ${id}, ${jobId}, ${documentId}, ${input.chunkOrder}, ${input.originalFilename}, ${input.blobKey},
          ${input.blobUrl}, ${input.mediaType}, ${input.sizeBytes}, ${input.pageStart}, ${input.pageEnd}, ${input.splitFrom},
          ${input.fingerprint}, ${input.checksumSha256}, 'uploaded', 'pending',
          ${input.splitParentChunkId}, ${input.splitReason}
        WHERE EXISTS (
          SELECT 1 FROM document_chunks parent
          WHERE parent.job_id = ${jobId}
            AND parent.id = ${input.splitParentChunkId}
            AND (${input.workerId ?? null} IS NULL OR (parent.abstraction_status = 'processing' AND parent.abstraction_worker_id = ${input.workerId}))
        )
        ON CONFLICT (job_id, split_parent_chunk_id, fingerprint)
        WHERE split_parent_chunk_id IS NOT NULL AND fingerprint IS NOT NULL
        DO UPDATE SET
          original_filename = EXCLUDED.original_filename,
          blob_key = EXCLUDED.blob_key,
          blob_url = EXCLUDED.blob_url,
          media_type = EXCLUDED.media_type,
          size_bytes = EXCLUDED.size_bytes,
          page_start = EXCLUDED.page_start,
          page_end = EXCLUDED.page_end,
          split_from = EXCLUDED.split_from,
          checksum_sha256 = EXCLUDED.checksum_sha256,
          upload_status = 'uploaded',
          abstraction_status = CASE
            WHEN document_chunks.abstraction_status = 'split_superseded' THEN document_chunks.abstraction_status
            ELSE 'pending'
          END,
          split_reason = EXCLUDED.split_reason,
          updated_at = now()
        RETURNING *
      `;
      if (!rows[0]) return null;
      await refreshDocumentCounts(jobId, documentId);
      await refreshUploadCounts(jobId);
      return rowToChunk(rows[0]);
    },

    async saveDocumentAbstract(record, options = {}) {
      await ensureSchema();
      const existing = await this.getDocumentAbstractByChunkId(record.jobId, record.chunkId);
      const abstractChanged = !existing
        || String(existing.abstractText || '') !== String(record.abstractText || '');
      const id = `abs_${randomUUID()}`;
      const rows = await sql`
        WITH claimed AS (
          UPDATE document_chunks
          SET
            abstraction_status = 'completed',
            abstraction_error_type = NULL,
            abstraction_error_message = NULL,
            payload_bytes = ${record.payloadBytes}::integer,
            latency_ms = ${record.latencyMs}::integer,
            model_used = ${record.modelUsed}::text,
            input_tokens = ${record.inputTokens}::integer,
            output_tokens = ${record.outputTokens}::integer,
            abstraction_completed_at = now(),
            abstraction_claimed_at = NULL,
            abstraction_lease_expires_at = NULL,
            abstraction_worker_id = NULL,
            abstraction_retry_at = NULL,
            updated_at = now()
          WHERE job_id = ${record.jobId}
            AND id = ${record.chunkId}
            AND (${record.workerId ?? null}::text IS NULL OR (abstraction_status = 'processing' AND abstraction_worker_id = ${record.workerId}::text))
          RETURNING id
        )
        INSERT INTO document_abstracts (
          id, job_id, document_id, chunk_id, abstract_text, model_used,
          payload_bytes, latency_ms, input_tokens, output_tokens,
          status, attempt_count, error_type, error_message
        )
        SELECT
          ${id}::text, ${record.jobId}::text, ${record.documentId}::text, ${record.chunkId}::text, ${record.abstractText}::text, ${record.modelUsed}::text,
          ${record.payloadBytes}::integer, ${record.latencyMs}::integer, ${record.inputTokens}::integer, ${record.outputTokens}::integer,
          ${record.status}::text, ${record.attemptCount}::integer, ${record.errorType ?? null}::text, ${record.errorMessage ?? null}::text
        FROM claimed
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
      if (!rows[0]) return null;
      if (abstractChanged && !options.preserveSynthesisPlan) {
        await sql`DELETE FROM job_results WHERE job_id = ${record.jobId}`;
        await sql`
          UPDATE analysis_jobs
          SET synthesis_plan_id = NULL,
              synthesis_merge_worker_id = NULL,
              synthesis_merge_lease_expires_at = NULL,
              synthesis_preview_text = NULL,
              synthesis_preview_complete = false,
              synthesis_preview_bytes = 0,
              synthesis_preview_updated_at = NULL,
              updated_at = now()
          WHERE id = ${record.jobId}
        `;
      }
      await refreshAbstractionCounts(record.jobId);
      return rowToAbstract(rows[0]);
    },

    async getDocumentAbstractByChunkId(jobId, chunkId) {
      await ensureSchema();
      const rows = await sql`
        SELECT * FROM document_abstracts
        WHERE job_id = ${jobId} AND chunk_id = ${chunkId}
        LIMIT 1
      `;
      return rowToAbstract(rows[0]);
    },

    async findReusableAbstractForChunk(jobId, chunk) {
      await ensureSchema();
      if (!chunk) return null;
      if (!chunk.fingerprint) return null;
      const byFingerprint = await sql`
        SELECT da.*, dc.id AS chunk_id_ref
        FROM document_abstracts da
        INNER JOIN document_chunks dc ON dc.id = da.chunk_id
        WHERE da.job_id = ${jobId}
          AND dc.fingerprint = ${chunk.fingerprint}
          AND dc.id <> ${chunk.id}
          AND dc.abstraction_status = 'completed'
          AND COALESCE(length(da.abstract_text), 0) > 0
        ORDER BY da.updated_at DESC
        LIMIT 1
      `;
      return rowToAbstract(byFingerprint[0]);
    },

    async listDocumentAbstracts(jobId) {
      await ensureSchema();
      const rows = await sql`
        SELECT
          da.*,
          dc.document_id,
          dc.chunk_order,
          dc.page_start,
          dc.page_end,
          dc.split_from,
          dc.original_filename,
          dc.blob_key,
          dc.blob_url,
          COALESCE(jd.original_filename, dc.original_filename) AS source_filename
        FROM document_abstracts da
        JOIN document_chunks dc ON dc.id = da.chunk_id
        LEFT JOIN job_documents jd ON jd.id = dc.document_id
        WHERE da.job_id = ${jobId}
        ORDER BY dc.chunk_order ASC, dc.page_start ASC NULLS LAST, da.created_at ASC
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

    async saveSynthesisPlan(jobId, planInput) {
      await ensureSchema();
      const job = await this.getJob(jobId);
      if (!job) return null;
      const planId = String(planInput?.planId || '').slice(0, 128);
      if (!planId) throw new JobApiError('planId is required to save a synthesis plan.', 400);
      const segments = Array.isArray(planInput?.segments) ? planInput.segments : [];
      // Remove any segments from prior plans so resume cannot mix versions.
      await sql`
        DELETE FROM synthesis_segments
        WHERE job_id = ${jobId} AND plan_id <> ${planId}
      `;
      // Persist the currently-active plan id on the job row.
      await sql`
        UPDATE analysis_jobs
        SET synthesis_plan_id = ${planId},
            synthesis_merge_worker_id = NULL,
            synthesis_merge_lease_expires_at = NULL,
            synthesis_preview_text = NULL,
            synthesis_preview_complete = false,
            synthesis_preview_bytes = 0,
            synthesis_preview_updated_at = NULL,
            updated_at = now()
        WHERE id = ${jobId}
      `;
      await sql`
        DELETE FROM job_results
        WHERE job_id = ${jobId}
          AND (plan_id IS NULL OR plan_id <> ${planId})
      `;
      const saved = [];
      for (const segment of segments) {
        const id = `seg_${randomUUID()}`;
        const documentIds = Array.isArray(segment.documentIds) ? segment.documentIds : [];
        const filenames = Array.isArray(segment.filenames) ? segment.filenames : [];
        const rows = await sql`
          INSERT INTO synthesis_segments (
            id, job_id, plan_id, segment_index,
            start_sequence_index, end_sequence_index,
            document_ids, filenames, estimated_bytes,
            status, attempt_count
          )
          VALUES (
            ${id}::text, ${jobId}::text, ${planId}::text, ${segment.segmentIndex}::integer,
            ${segment.startSequenceIndex}::integer, ${segment.endSequenceIndex}::integer,
            ${JSON.stringify(documentIds)}::jsonb, ${JSON.stringify(filenames)}::jsonb, ${segment.estimatedBytes ?? null}::integer,
            'pending', 0
          )
          ON CONFLICT (job_id, plan_id, segment_index) DO UPDATE
          SET
            start_sequence_index = EXCLUDED.start_sequence_index,
            end_sequence_index = EXCLUDED.end_sequence_index,
            document_ids = EXCLUDED.document_ids,
            filenames = EXCLUDED.filenames,
            estimated_bytes = EXCLUDED.estimated_bytes,
            updated_at = now()
          RETURNING *
        `;
        saved.push(rowToSynthesisSegment(rows[0]));
      }
      return { planId, segments: saved };
    },

    async getCurrentSynthesisPlanId(jobId) {
      await ensureSchema();
      const rows = await sql`SELECT synthesis_plan_id FROM analysis_jobs WHERE id = ${jobId} LIMIT 1`;
      return rows[0]?.synthesis_plan_id || null;
    },

    async listSynthesisSegments(jobId, planId) {
      await ensureSchema();
      const effectivePlanId = planId || await this.getCurrentSynthesisPlanId(jobId);
      if (!effectivePlanId) return [];
      const rows = await sql`
        SELECT * FROM synthesis_segments
        WHERE job_id = ${jobId} AND plan_id = ${effectivePlanId}
        ORDER BY segment_index ASC
      `;
      return rows.map(rowToSynthesisSegment);
    },

    async summarizeSynthesisSegments(jobId, planId) {
      await ensureSchema();
      const effectivePlanId = planId || await this.getCurrentSynthesisPlanId(jobId);
      if (!effectivePlanId) {
        return { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, retry_wait: 0 };
      }
      const rows = await sql`
        SELECT status, COUNT(*)::int AS count
        FROM synthesis_segments
        WHERE job_id = ${jobId} AND plan_id = ${effectivePlanId}
        GROUP BY status
      `;
      const counts = rows.reduce((acc, row) => {
        acc[row.status] = row.count;
        return acc;
      }, {});
      const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
      return {
        total,
        pending: counts.pending || 0,
        processing: counts.processing || 0,
        complete: counts.complete || 0,
        failed: counts.failed || 0,
        retry_wait: counts.retry_wait || 0,
      };
    },

    async listFailedChunks(jobId) {
      await ensureSchema();
      const rows = await sql`
        SELECT
          id, document_id, chunk_order, original_filename,
          page_start, page_end, abstraction_error_type, abstraction_error_message
        FROM document_chunks
        WHERE job_id = ${jobId}
          AND abstraction_status = 'failed'
        ORDER BY chunk_order ASC
      `;
      return rows.map(row => ({
        id: row.id,
        documentId: row.document_id,
        chunkOrder: row.chunk_order,
        originalFilename: row.original_filename,
        pageStart: row.page_start,
        pageEnd: row.page_end,
        abstractionErrorType: row.abstraction_error_type,
        abstractionErrorMessage: row.abstraction_error_message,
      }));
    },

    async listReadySynthesisSegments(jobId, planId, limit = 4) {
      await ensureSchema();
      const safeLimit = Math.max(1, Math.min(Number(limit) || 4, 32));
      const rows = await sql`
        SELECT * FROM synthesis_segments
        WHERE job_id = ${jobId}
          AND plan_id = ${planId}
          AND (
            status = 'pending'
            OR (status = 'retry_wait' AND (retry_at IS NULL OR retry_at <= now()))
            OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= now()))
          )
        ORDER BY segment_index ASC
        LIMIT ${safeLimit}
      `;
      return rows.map(rowToSynthesisSegment);
    },

    async listRunnableSynthesisJobIds(limit = 20) {
      await ensureSchema();
      const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
      const rows = await sql`
        SELECT DISTINCT j.id
        FROM analysis_jobs j
        LEFT JOIN synthesis_segments s
          ON s.job_id = j.id
         AND s.plan_id = j.synthesis_plan_id
        LEFT JOIN job_results r
          ON r.job_id = j.id
        WHERE j.status = 'synthesizing'
          AND r.job_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM document_chunks c
            WHERE c.job_id = j.id
              AND c.abstraction_status IN ('pending', 'processing', 'retry_wait')
          )
          AND (
            s.id IS NULL
            OR s.status = 'pending'
            OR (s.status = 'retry_wait' AND (s.retry_at IS NULL OR s.retry_at <= now()))
            OR (s.status = 'processing' AND (s.lease_expires_at IS NULL OR s.lease_expires_at <= now()))
            OR (
              NOT EXISTS (
                SELECT 1
                FROM synthesis_segments pending
                WHERE pending.job_id = j.id
                  AND pending.plan_id = j.synthesis_plan_id
                  AND pending.status <> 'complete'
              )
              AND (
                j.synthesis_merge_worker_id IS NULL
                OR j.synthesis_merge_lease_expires_at IS NULL
                OR j.synthesis_merge_lease_expires_at <= now()
              )
            )
          )
        ORDER BY j.id ASC
        LIMIT ${safeLimit}
      `;
      return rows.map(row => row.id);
    },

    async claimSynthesisSegment(jobId, segmentId, options = {}) {
      await ensureSchema();
      const workerId = options.workerId || `wkr_${Math.random().toString(36).slice(2, 10)}`;
      const leaseSeconds = Math.max(1, Math.ceil(Number(options.leaseMs || 120000) / 1000));
      const rows = await sql`
        UPDATE synthesis_segments
        SET
          status = 'processing',
          attempt_count = attempt_count + 1,
          claimed_at = now(),
          lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
          worker_id = ${workerId}::text,
          retry_at = NULL,
          error_type = NULL,
          error_message = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}::text
          AND id = ${segmentId}::text
          AND (
            status = 'pending'
            OR (status = 'retry_wait' AND (retry_at IS NULL OR retry_at <= now()))
            OR (status = 'processing' AND (lease_expires_at IS NULL OR lease_expires_at <= now()))
          )
        RETURNING *
      `;
      return rowToSynthesisSegment(rows[0]);
    },

    async completeSynthesisSegment(jobId, segmentId, payload) {
      await ensureSchema();
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      const rows = await sql`
        UPDATE synthesis_segments
        SET
          status = 'complete',
          summary_text = ${payload.summaryText}::text,
          model_used = ${payload.modelUsed}::text,
          input_tokens = ${payload.inputTokens ?? null}::integer,
          output_tokens = ${payload.outputTokens ?? null}::integer,
          payload_bytes = ${payload.payloadBytes ?? null}::integer,
          latency_ms = ${payload.latencyMs ?? null}::integer,
          error_type = NULL,
          error_message = NULL,
          warnings = ${JSON.stringify(warnings)}::jsonb,
          claimed_at = NULL,
          lease_expires_at = NULL,
          worker_id = NULL,
          retry_at = NULL,
          completed_at = now(),
          updated_at = now()
        WHERE job_id = ${jobId}::text
          AND id = ${segmentId}::text
          AND (${payload.workerId ?? null}::text IS NULL OR (status = 'processing' AND worker_id = ${payload.workerId}::text))
        RETURNING *
      `;
      return rowToSynthesisSegment(rows[0]);
    },

    async markSynthesisSegmentFailed(jobId, segmentId, failure) {
      await ensureSchema();
      const rows = await sql`
        UPDATE synthesis_segments
        SET
          status = 'failed',
          error_type = ${failure.errorType}::text,
          error_message = ${failure.errorMessage}::text,
          payload_bytes = ${failure.payloadBytes ?? null}::integer,
          latency_ms = ${failure.latencyMs ?? null}::integer,
          model_used = ${failure.modelUsed ?? null}::text,
          claimed_at = NULL,
          lease_expires_at = NULL,
          worker_id = NULL,
          retry_at = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}::text
          AND id = ${segmentId}::text
          AND (${failure.workerId ?? null}::text IS NULL OR (status = 'processing' AND worker_id = ${failure.workerId}::text))
        RETURNING *
      `;
      return rowToSynthesisSegment(rows[0]);
    },

    async markSynthesisSegmentRetryWait(jobId, segmentId, failure) {
      await ensureSchema();
      const retryAt = failure?.retryAtIso ? new Date(failure.retryAtIso) : null;
      const rows = await sql`
        UPDATE synthesis_segments
        SET
          status = 'retry_wait',
          error_type = ${failure.errorType}::text,
          error_message = ${failure.errorMessage}::text,
          payload_bytes = ${failure.payloadBytes ?? null}::integer,
          latency_ms = ${failure.latencyMs ?? null}::integer,
          model_used = ${failure.modelUsed ?? null}::text,
          retry_at = ${retryAt},
          claimed_at = NULL,
          lease_expires_at = NULL,
          worker_id = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}::text
          AND id = ${segmentId}::text
          AND (${failure.workerId ?? null}::text IS NULL OR (status = 'processing' AND worker_id = ${failure.workerId}::text))
        RETURNING *
      `;
      return rowToSynthesisSegment(rows[0]);
    },

    async resetStaleSynthesisSegments(jobId, staleMs = 180000) {
      await ensureSchema();
      const staleSeconds = Math.max(1, Math.ceil(Number(staleMs) / 1000));
      const rows = await sql`
        UPDATE synthesis_segments
        SET
          status = 'pending',
          error_type = 'stale_processing_recovered',
          error_message = 'Previous synthesis attempt was interrupted and has been requeued.',
          claimed_at = NULL,
          lease_expires_at = NULL,
          worker_id = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}
          AND status = 'processing'
          AND (
            (lease_expires_at IS NOT NULL AND lease_expires_at <= now())
            OR (lease_expires_at IS NULL AND updated_at < now() - make_interval(secs => ${staleSeconds}))
          )
        RETURNING *
      `;
      return rows.map(rowToSynthesisSegment);
    },

    async resetFailedSynthesisSegments(jobId, planId) {
      await ensureSchema();
      const rows = await sql`
        UPDATE synthesis_segments
        SET
          status = 'pending',
          error_type = NULL,
          error_message = NULL,
          retry_at = NULL,
          claimed_at = NULL,
          lease_expires_at = NULL,
          worker_id = NULL,
          updated_at = now()
        WHERE job_id = ${jobId}
          AND plan_id = ${planId}
          AND status IN ('failed', 'retry_wait')
        RETURNING *
      `;
      return rows.map(rowToSynthesisSegment);
    },

    async setSynthesisPreview(jobId, patch = {}) {
      await ensureSchema();
      const text = typeof patch.text === 'string' ? patch.text : '';
      const complete = Boolean(patch.complete);
      const bytesReceived = Number.isFinite(Number(patch.bytesReceived))
        ? Math.max(0, Math.floor(Number(patch.bytesReceived)))
        : text.length;
      const modelUsed = typeof patch.modelUsed === 'string' ? patch.modelUsed : null;
      const rows = await sql`
        UPDATE analysis_jobs
        SET
          synthesis_preview_text = ${text},
          synthesis_preview_complete = ${complete},
          synthesis_preview_bytes = ${bytesReceived},
          synthesis_preview_model_used = ${modelUsed ? modelUsed : null},
          synthesis_preview_updated_at = now(),
          updated_at = now()
        WHERE id = ${jobId}
        RETURNING synthesis_preview_text, synthesis_preview_complete, synthesis_preview_bytes, synthesis_preview_model_used
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        text: row.synthesis_preview_text || '',
        complete: Boolean(row.synthesis_preview_complete),
        bytesReceived: row.synthesis_preview_bytes ?? 0,
        modelUsed: row.synthesis_preview_model_used || null,
      };
    },

    async getSynthesisPreview(jobId) {
      await ensureSchema();
      const job = await this.getJob(jobId);
      if (!job) return null;
      return {
        text: job.synthesisPreviewText || '',
        complete: Boolean(job.synthesisPreviewComplete),
        bytesReceived: job.synthesisPreviewBytes || 0,
        updatedAt: job.synthesisPreviewUpdatedAt || null,
        modelUsed: job.synthesisPreviewModelUsed || null,
      };
    },

    async clearSynthesisPreview(jobId) {
      await ensureSchema();
      const rows = await sql`
        UPDATE analysis_jobs
        SET
          synthesis_preview_text = NULL,
          synthesis_preview_complete = false,
          synthesis_preview_bytes = 0,
          synthesis_preview_updated_at = NULL,
          updated_at = now()
        WHERE id = ${jobId}
        RETURNING id
      `;
      return rows.length > 0;
    },

    async claimSynthesisMerge(jobId, planId, options = {}) {
      await ensureSchema();
      const workerId = options.workerId || `wkr_${Math.random().toString(36).slice(2, 10)}`;
      const leaseSeconds = Math.max(1, Math.ceil(Number(options.leaseMs || 120000) / 1000));
      const rows = await sql`
        UPDATE analysis_jobs
        SET
          synthesis_merge_worker_id = ${workerId},
          synthesis_merge_lease_expires_at = now() + make_interval(secs => ${leaseSeconds}),
          updated_at = now()
        WHERE id = ${jobId}
          AND synthesis_plan_id = ${planId}
          AND (
            synthesis_merge_worker_id IS NULL
            OR synthesis_merge_lease_expires_at IS NULL
            OR synthesis_merge_lease_expires_at <= now()
          )
        RETURNING id, synthesis_plan_id, synthesis_merge_worker_id, synthesis_merge_lease_expires_at
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        jobId: row.id,
        planId: row.synthesis_plan_id,
        workerId: row.synthesis_merge_worker_id,
        leaseExpiresAt: row.synthesis_merge_lease_expires_at?.toISOString?.() || row.synthesis_merge_lease_expires_at || null,
      };
    },

    async saveJobResult(jobId, payload) {
      await ensureSchema();
      const job = await this.getJob(jobId);
      if (!job) return null;
      const id = `res_${randomUUID()}`;
      const status = JOB_RESULT_STATUSES.has(payload.status) ? payload.status : 'complete';
      const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
      const failedDocuments = Array.isArray(payload.failedDocuments) ? payload.failedDocuments : [];
      const rows = await sql`
        INSERT INTO job_results (
          id, job_id, plan_id, status,
          final_title_opinion, warnings_json, failed_documents_json,
          model_used, input_tokens, output_tokens, payload_bytes,
          synthesis_duration_ms, generated_at
        )
        SELECT
          ${id}::text, ${jobId}::text, ${payload.planId || null}::text, ${status}::text,
          ${payload.finalTitleOpinion || ''}, ${JSON.stringify(warnings)}::jsonb, ${JSON.stringify(failedDocuments)}::jsonb,
          ${payload.modelUsed || null}::text, ${payload.inputTokens ?? null}::integer, ${payload.outputTokens ?? null}::integer, ${payload.payloadBytes ?? null}::integer,
          ${payload.synthesisDurationMs ?? null}::integer, now()
        FROM analysis_jobs aj
        WHERE aj.id = ${jobId}::text
          AND (${payload.mergeWorkerId ?? null}::text IS NULL OR (
            aj.synthesis_plan_id = ${payload.planId || null}::text
            AND aj.synthesis_merge_worker_id = ${payload.mergeWorkerId}::text
          ))
        ON CONFLICT (job_id) DO UPDATE
        SET
          plan_id = EXCLUDED.plan_id,
          status = EXCLUDED.status,
          final_title_opinion = EXCLUDED.final_title_opinion,
          warnings_json = EXCLUDED.warnings_json,
          failed_documents_json = EXCLUDED.failed_documents_json,
          model_used = EXCLUDED.model_used,
          input_tokens = EXCLUDED.input_tokens,
          output_tokens = EXCLUDED.output_tokens,
          payload_bytes = EXCLUDED.payload_bytes,
          synthesis_duration_ms = EXCLUDED.synthesis_duration_ms,
          generated_at = now()
        RETURNING *
      `;
      if (!rows[0]) return null;
      await this.clearSynthesisPreview(jobId);
      // Roll the job into its terminal status. assertValidStatusTransition
      // forbids regressing once a job has reached 'complete'.
      const desiredJobStatus = status === 'complete' ? 'complete'
        : status === 'partial_failed' ? 'partial_failed'
        : 'failed';
      if (job.status !== 'canceled' && job.status !== desiredJobStatus) {
        try {
          assertValidStatusTransition(job.status, desiredJobStatus);
          await sql`
            UPDATE analysis_jobs
            SET status = ${desiredJobStatus},
                current_phase = ${status === 'complete' ? 'complete' : status === 'partial_failed' ? 'complete with synthesis warnings' : 'synthesis failed'},
                synthesis_merge_worker_id = NULL,
                synthesis_merge_lease_expires_at = NULL,
                completed_at = COALESCE(completed_at, now()),
                updated_at = now()
            WHERE id = ${jobId}
          `;
        } catch {
          if (payload.mergeWorkerId) {
            await sql`
              UPDATE analysis_jobs
              SET synthesis_merge_worker_id = NULL,
                  synthesis_merge_lease_expires_at = NULL,
                  updated_at = now()
              WHERE id = ${jobId}
                AND synthesis_merge_worker_id = ${payload.mergeWorkerId}
            `;
          }
          // ignore invalid transition; the result is still saved
        }
      } else if (payload.mergeWorkerId) {
        await sql`
          UPDATE analysis_jobs
          SET synthesis_merge_worker_id = NULL,
              synthesis_merge_lease_expires_at = NULL,
              updated_at = now()
          WHERE id = ${jobId}
            AND synthesis_merge_worker_id = ${payload.mergeWorkerId}
        `;
      }
      return rowToJobResult(rows[0]);
    },

    async clearJobResult(jobId) {
      await ensureSchema();
      const rows = await sql`DELETE FROM job_results WHERE job_id = ${jobId} RETURNING id`;
      return rows.length > 0;
    },

    async getJobResult(jobId) {
      await ensureSchema();
      const rows = await sql`SELECT * FROM job_results WHERE job_id = ${jobId} LIMIT 1`;
      return rowToJobResult(rows[0]);
    },

    async getJobResultMeta(jobId) {
      await ensureSchema();
      const rows = await sql`
        SELECT
          job_id, plan_id, status, model_used, generated_at,
          (COALESCE(length(final_title_opinion), 0) > 0) AS has_opinion
        FROM job_results
        WHERE job_id = ${jobId}
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        jobId: row.job_id,
        planId: row.plan_id,
        status: row.status,
        modelUsed: row.model_used,
        generatedAt: row.generated_at instanceof Date ? row.generated_at.toISOString() : row.generated_at,
        hasOpinion: Boolean(row.has_opinion),
      };
    },

    async appendFollowupMessage(jobId, payload) {
      await ensureSchema();
      const id = `flw_${randomUUID()}`;
      const retrievedIds = Array.isArray(payload.retrievedDocumentIds) ? payload.retrievedDocumentIds : [];
      const rows = await sql`
        INSERT INTO followup_messages (
          id, job_id, question, answer,
          model_used, input_tokens, output_tokens, payload_bytes,
          retrieved_document_ids, truncation_warning
        )
        VALUES (
          ${id}, ${jobId}, ${payload.question}, ${payload.answer},
          ${payload.modelUsed || null}, ${payload.inputTokens ?? null}, ${payload.outputTokens ?? null}, ${payload.payloadBytes ?? null},
          ${JSON.stringify(retrievedIds)}::jsonb, ${payload.truncationWarning || null}
        )
        RETURNING *
      `;
      return rowToFollowupMessage(rows[0]);
    },

    async listFollowupMessages(jobId, limit = 50) {
      await ensureSchema();
      const safeLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
      const rows = await sql`
        SELECT * FROM followup_messages
        WHERE job_id = ${jobId}
        ORDER BY created_at ASC
        LIMIT ${safeLimit}
      `;
      return rows.map(rowToFollowupMessage);
    },

    async getSynthesisStatus(jobId, options = {}) {
      await ensureSchema();
      const job = await this.getJob(jobId);
      if (!job) return null;
      const planId = await this.getCurrentSynthesisPlanId(jobId);
      const lightweight = options.lightweight !== false;
      const includeSegments = options.includeSegments === true;
      const includeResult = options.includeResult === true;
      let counts;
      let segments = [];
      if (lightweight && !includeSegments) {
        counts = planId
          ? await this.summarizeSynthesisSegments(jobId, planId)
          : { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, retry_wait: 0 };
      } else {
        segments = planId ? await this.listSynthesisSegments(jobId, planId) : [];
        const tallies = segments.reduce((acc, segment) => {
          acc[segment.status] = (acc[segment.status] || 0) + 1;
          return acc;
        }, {});
        counts = {
          total: segments.length,
          pending: tallies.pending || 0,
          processing: tallies.processing || 0,
          complete: tallies.complete || 0,
          failed: tallies.failed || 0,
          retry_wait: tallies.retry_wait || 0,
        };
      }
      const resultMeta = lightweight && !includeResult
        ? await this.getJobResultMeta(jobId)
        : null;
      const result = includeResult
        ? await this.getJobResult(jobId)
        : null;
      const mergeLeaseExpiresAt = job.synthesisMergeLeaseExpiresAt ? Date.parse(job.synthesisMergeLeaseExpiresAt) : 0;
      const mergeLeaseHeld = Boolean(job.synthesisMergeWorkerId && (!mergeLeaseExpiresAt || mergeLeaseExpiresAt > Date.now()));
      const hasResult = result
        ? Boolean(result.finalTitleOpinion)
        : Boolean(resultMeta?.hasOpinion);
      // Treat the post-segments / pre-result window as "merge in progress" so
      // pollers don't declare the job terminal before a server worker has
      // claimed the final merge. Without this, clients can race the claim and
      // fall back to browser synthesis even though the server would have run it.
      const segmentsAllFinished = counts.total > 0
        && (counts.pending + counts.processing + counts.retry_wait) === 0;
      const mergeInProgress = mergeLeaseHeld || (segmentsAllFinished && !hasResult);
      return {
        job,
        planId,
        total: counts.total,
        pending: counts.pending,
        processing: counts.processing,
        complete: counts.complete,
        failed: counts.failed,
        retry_wait: counts.retry_wait,
        mergeInProgress,
        segments: includeSegments ? segments : [],
        hasResult,
        result: includeResult ? result : null,
        resultMeta,
      };
    },

    async importContinuationAbstracts(targetJobId, sourceJobId) {
      await ensureSchema();
      const sourceJob = await this.getJob(sourceJobId);
      if (!sourceJob) {
        throw new JobApiError('Source job not found.', 404);
      }
      if (!TERMINAL_STATUSES.has(sourceJob.status)) {
        throw new JobApiError('Source job must be complete before importing continuation abstracts.', 409);
      }
      const targetJob = await this.getJob(targetJobId);
      if (!targetJob) {
        throw new JobApiError('Target job not found.', 404);
      }
      if (TERMINAL_STATUSES.has(targetJob.status)) {
        throw new JobApiError('Cannot import continuation abstracts into a terminal job.', 409);
      }
      const sourceRows = await this.listDocumentAbstracts(sourceJobId);
      const completed = sourceRows.filter(row => String(row.abstractText || '').trim().length > 0);
      if (!completed.length) {
        return { imported: 0, sourceJobId, targetJobId };
      }
      const targetChunks = await this.listChunks(targetJobId);
      let orderOffset = targetChunks.reduce((max, chunk) => Math.max(max, Number(chunk.chunkOrder) || 0), -1) + 1;
      const documentIdsBySource = new Map();
      let imported = 0;
      for (const row of completed) {
        const sourceDocumentKey = `continuation:${sourceJobId}:${row.documentId || row.chunkId}`;
        let documentId = documentIdsBySource.get(sourceDocumentKey);
        if (!documentId) {
          const existing = await this.findDocumentByFingerprint(targetJobId, sourceDocumentKey);
          if (existing) {
            documentId = existing.id;
          } else {
            const created = await this.createDocument(targetJobId, {
              originalFilename: row.sourceFilename || row.originalFilename || row.chunkId,
              mediaType: 'application/pdf',
              sizeBytes: 0,
              pageStart: row.pageStart,
              pageEnd: row.pageEnd,
              splitFrom: row.splitFrom,
              fingerprint: sourceDocumentKey,
              checksumSha256: null,
              uploadStatus: 'uploaded',
            });
            documentId = created.id;
          }
          documentIdsBySource.set(sourceDocumentKey, documentId);
        }
        const chunkId = `chk_${randomUUID()}`;
        const chunkFilename = row.originalFilename || row.sourceFilename || row.chunkId;
        const blobKey = buildChunkBlobKey(targetJobId, chunkId, chunkFilename);
        const importFingerprint = `continuation:${sourceJobId}:${row.chunkId}`;
        const existingChunk = await this.findChunkByFingerprint(targetJobId, documentId, importFingerprint, orderOffset);
        if (existingChunk) {
          orderOffset += 1;
          continue;
        }
        await sql`
          INSERT INTO document_chunks (
            id, job_id, document_id, chunk_order, original_filename, blob_key,
            blob_url, media_type, size_bytes, page_start, page_end, split_from,
            fingerprint, checksum_sha256, upload_status, abstraction_status,
            abstraction_completed_at, model_used
          )
          VALUES (
            ${chunkId}, ${targetJobId}, ${documentId}, ${orderOffset}, ${chunkFilename}, ${blobKey},
            ${row.blobUrl || null}, 'application/pdf', 0,
            ${row.pageStart}, ${row.pageEnd}, ${row.splitFrom},
            ${importFingerprint}, NULL, 'uploaded', 'completed', now(), ${row.modelUsed || null}
          )
        `;
        const abstractId = `abs_${randomUUID()}`;
        await sql`
          INSERT INTO document_abstracts (
            id, job_id, document_id, chunk_id, abstract_text, model_used,
            payload_bytes, latency_ms, input_tokens, output_tokens,
            status, attempt_count, error_type, error_message
          )
          VALUES (
            ${abstractId}, ${targetJobId}, ${documentId}, ${chunkId}, ${row.abstractText}, ${row.modelUsed || null},
            ${row.payloadBytes || null}, ${row.latencyMs || null}, ${row.inputTokens || null}, ${row.outputTokens || null},
            'completed', ${row.attemptCount || 1}, NULL, NULL
          )
          ON CONFLICT (chunk_id) DO UPDATE
          SET
            abstract_text = EXCLUDED.abstract_text,
            model_used = EXCLUDED.model_used,
            status = 'completed',
            updated_at = now()
        `;
        orderOffset += 1;
        imported += 1;
      }
      await refreshAbstractionCounts(targetJobId);
      await refreshUploadCounts(targetJobId);
      return { imported, sourceJobId, targetJobId };
    },

    async finalizeUploads(jobId) {
      await ensureSchema();
      const chunks = await this.listChunks(jobId);
      const invalidUploaded = chunks.filter(chunk => {
        if (chunk.uploadStatus !== 'uploaded') return false;
        // Server-created split children use a parent-based key path; skip them.
        if (chunk.splitParentChunkId) return false;
        return !chunk.blobUrl || !chunk.blobKey || !chunk.blobKey.startsWith(buildChunkBlobPrefix(jobId, chunk.id));
      });
      if (invalidUploaded.length) {
        throw new JobApiError('Uploaded chunks must include valid durable storage metadata before finalization.', 409);
      }
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

export { JOB_RESULT_STATUSES, SYNTHESIS_SEGMENT_STATUSES };
