import { randomUUID } from 'crypto';
import { neon } from '@neondatabase/serverless';

const ALLOWED_STATUSES = new Set(['created', 'abstracting', 'synthesizing', 'complete', 'failed']);
const TERMINAL_STATUSES = new Set(['complete', 'failed']);
const VALID_TRANSITIONS = {
  created: new Set(['created', 'abstracting', 'failed']),
  abstracting: new Set(['abstracting', 'synthesizing', 'failed']),
  synthesizing: new Set(['synthesizing', 'complete', 'failed']),
  complete: new Set(['complete']),
  failed: new Set(['failed']),
};
const MAX_TOTAL_DOCUMENTS = 400;
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
    completedDocuments: row.completed_documents,
    failedDocuments: row.failed_documents,
    currentPhase: row.current_phase,
    errorMessage: row.error_message,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    startedAt: row.started_at instanceof Date ? row.started_at.toISOString() : row.started_at,
    completedAt: row.completed_at instanceof Date ? row.completed_at.toISOString() : row.completed_at,
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
      initialized = sql`
        CREATE TABLE IF NOT EXISTS analysis_jobs (
          id text PRIMARY KEY,
          status text NOT NULL,
          subject_tract text,
          context_notes text,
          total_documents integer NOT NULL CHECK (total_documents >= 0),
          completed_documents integer NOT NULL DEFAULT 0 CHECK (completed_documents >= 0),
          failed_documents integer NOT NULL DEFAULT 0 CHECK (failed_documents >= 0),
          current_phase text NOT NULL,
          error_message text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          started_at timestamptz,
          completed_at timestamptz
        )
      `;
    }
    await initialized;
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
