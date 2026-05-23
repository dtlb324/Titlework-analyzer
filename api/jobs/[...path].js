import {
  createRequestId,
  enforceJobRateLimit,
  getJobStore,
  parseJsonBody,
  requireJobPassword,
  sendStorageNotConfigured,
  setJobSecurityHeaders,
  validateCreateChunkInput,
  validateCreateDocumentInput,
  validatePatchChunkInput,
  validatePatchJobInput,
} from '../_lib/jobs.js';
import {
  processJobAbstraction,
  retryChunkAbstraction,
  serverAbstractionSetupError,
} from '../_lib/abstraction.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

function getPathParts(req) {
  const queryPath = req.query?.path;
  if (Array.isArray(queryPath)) return queryPath.map(String);
  if (typeof queryPath === 'string') return [queryPath];
  const match = String(req.url || '').match(/\/api\/jobs\/([^?#]+)/);
  return match ? match[1].split('/').filter(Boolean).map(decodeURIComponent) : [];
}

function validPrefixedId(id, prefix) {
  return typeof id === 'string' && id.startsWith(prefix) && id.length > prefix.length;
}

function parseBody(req, res, requestId) {
  try {
    return parseJsonBody(req.body);
  } catch {
    res.status(400).json({ error: 'Invalid JSON in request body.', requestId });
    return null;
  }
}

function publicFailedChunk(chunk) {
  return {
    id: chunk.id,
    documentId: chunk.documentId,
    chunkOrder: chunk.chunkOrder,
    originalFilename: chunk.originalFilename,
    mediaType: chunk.mediaType,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    attemptCount: chunk.abstractionAttempts,
    errorType: chunk.abstractionErrorType,
    errorMessage: chunk.abstractionErrorMessage,
  };
}

function publicAbstract(record) {
  return {
    id: record.id,
    jobId: record.jobId,
    documentId: record.documentId,
    chunkId: record.chunkId,
    chunk_id: record.chunkId,
    chunkOrder: record.chunkOrder,
    sequence_index: record.chunkOrder,
    originalFilename: record.originalFilename,
    display_name: record.originalFilename,
    filename: record.originalFilename,
    abstractText: record.abstractText,
    abstract_text: record.abstractText,
    abstract: record.abstractText,
    modelUsed: record.modelUsed,
    payloadBytes: record.payloadBytes,
    latencyMs: record.latencyMs,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    status: record.status,
    attemptCount: record.attemptCount,
    createdAt: record.createdAt,
  };
}

function requireServerAbstractionPassword(res, requestId) {
  if (process.env.APP_PASSWORD) return true;
  res.status(401).json({ error: 'APP_PASSWORD is required for server-side abstraction endpoints.', requestId });
  return false;
}

async function handleJobDetail(req, res, requestId, store, jobId) {
  if (!['GET', 'PATCH'].includes(req.method)) {
    return res.status(405).json({ error: 'Method not allowed.', requestId });
  }
  if (!validPrefixedId(jobId, 'job_')) {
    return res.status(400).json({ error: 'Invalid job id.', requestId });
  }
  const existing = await store.getJob(jobId);
  if (!existing) {
    return res.status(404).json({ error: 'Job not found.', requestId });
  }
  if (req.method === 'GET') {
    return res.status(200).json({ job: existing, requestId });
  }

  const body = parseBody(req, res, requestId);
  if (!body) return;
  const validation = validatePatchJobInput(body, existing);
  if (!validation.valid) {
    return res.status(validation.statusCode).json({ error: validation.reason, requestId });
  }
  const updated = await store.updateJob(jobId, validation.patch);
  return res.status(200).json({ job: updated, requestId });
}

async function handleCreateDocument(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const existingJob = await store.getJob(jobId);
  if (!existingJob) return res.status(404).json({ error: 'Job not found.', requestId });

  const body = parseBody(req, res, requestId);
  if (!body) return;
  const validation = validateCreateDocumentInput(body);
  if (!validation.valid) return res.status(400).json({ error: validation.reason, requestId });

  const document = await store.createDocument(jobId, validation.value);
  if (!document) return res.status(404).json({ error: 'Job not found.', requestId });
  return res.status(201).json({ document, requestId });
}

async function handleCreateChunk(req, res, requestId, store, jobId, documentId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!validPrefixedId(jobId, 'job_') || !validPrefixedId(documentId, 'doc_')) {
    return res.status(400).json({ error: 'Invalid job or document id.', requestId });
  }
  const body = parseBody(req, res, requestId);
  if (!body) return;
  const validation = validateCreateChunkInput(body);
  if (!validation.valid) return res.status(400).json({ error: validation.reason, requestId });

  const document = await store.getDocument(jobId, documentId);
  if (!document) return res.status(404).json({ error: 'Document not found.', requestId });
  const chunk = await store.createChunk(jobId, documentId, validation.value);
  if (!chunk) return res.status(404).json({ error: 'Document not found.', requestId });
  return res.status(201).json({ chunk, requestId });
}

async function handleChunkList(req, res, requestId, store, jobId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  const chunks = await store.listChunks(jobId);
  return res.status(200).json({ chunks, requestId });
}

async function handleChunkPatch(req, res, requestId, store, jobId, chunkId) {
  if (req.method !== 'PATCH') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!validPrefixedId(jobId, 'job_') || !validPrefixedId(chunkId, 'chk_')) {
    return res.status(400).json({ error: 'Invalid job or chunk id.', requestId });
  }
  const body = parseBody(req, res, requestId);
  if (!body) return;
  const validation = validatePatchChunkInput(body);
  if (!validation.valid) return res.status(400).json({ error: validation.reason, requestId });

  const chunk = await store.updateChunk(jobId, chunkId, validation.patch);
  if (!chunk) return res.status(404).json({ error: 'Chunk not found.', requestId });
  return res.status(200).json({ chunk, requestId });
}

async function handleFinalizeUploads(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const result = await store.finalizeUploads(jobId);
  if (!result) return res.status(404).json({ error: 'Job not found.', requestId });
  if (!result.ready) {
    return res.status(409).json({
      error: 'Uploads are not complete.',
      pendingChunks: result.pendingChunks,
      job: result.job,
      requestId,
    });
  }
  return res.status(200).json({ job: result.job, pendingChunks: 0, requestId });
}

async function handleAbstractionStart(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const setupError = serverAbstractionSetupError();
  if (setupError) {
    return res.status(503).json({ error: setupError, fallback: 'browser_abstraction', requestId });
  }
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  const status = await processJobAbstraction(jobId, { store });
  return res.status(200).json({ status, job: status.job, requestId });
}

async function handleAbstractionStatus(req, res, requestId, store, jobId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  const status = store.getAbstractionStatus
    ? await store.getAbstractionStatus(jobId)
    : { total: 0, pending: 0, processing: 0, completed: 0, failed: 0, failedChunks: [], job };
  return res.status(200).json({
    status: {
      ...status,
      failedChunks: (status.failedChunks || []).map(publicFailedChunk),
    },
    job: status.job || job,
    requestId,
  });
}

async function handleAbstractList(req, res, requestId, store, jobId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  const abstracts = store.listDocumentAbstracts ? await store.listDocumentAbstracts(jobId) : [];
  return res.status(200).json({ abstracts: abstracts.map(publicAbstract), requestId });
}

async function handleChunkRetry(req, res, requestId, store, jobId, chunkId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  if (!validPrefixedId(chunkId, 'chk_')) return res.status(400).json({ error: 'Invalid chunk id.', requestId });
  const setupError = serverAbstractionSetupError();
  if (setupError) {
    return res.status(503).json({ error: setupError, fallback: 'browser_abstraction', requestId });
  }
  const retry = await retryChunkAbstraction(jobId, chunkId, { store });
  return res.status(200).json({ retry, status: retry.status, requestId });
}

export default async function handler(req, res) {
  setJobSecurityHeaders(res);
  const requestId = req.headers['x-request-id'] || createRequestId();
  res.setHeader('X-Request-Id', requestId);

  const parts = getPathParts(req);
  const isWrite = req.method !== 'GET';
  if (isWrite && !enforceJobRateLimit(req, res, requestId)) return;
  if (!requireJobPassword(req, res, requestId)) return;

  const store = getJobStore();
  if (!store) return sendStorageNotConfigured(res, requestId);

  try {
    const [jobId, second, third, fourth] = parts;
    if (parts.length === 1) return await handleJobDetail(req, res, requestId, store, jobId);
    if (parts.length === 2 && second === 'documents') return await handleCreateDocument(req, res, requestId, store, jobId);
    if (parts.length === 4 && second === 'documents' && fourth === 'chunks') return await handleCreateChunk(req, res, requestId, store, jobId, third);
    if (parts.length === 2 && second === 'chunks') return await handleChunkList(req, res, requestId, store, jobId);
    if (parts.length === 3 && second === 'chunks') return await handleChunkPatch(req, res, requestId, store, jobId, third);
    if (parts.length === 4 && second === 'chunks' && fourth === 'retry') return await handleChunkRetry(req, res, requestId, store, jobId, third);
    if (parts.length === 2 && second === 'finalize-uploads') return await handleFinalizeUploads(req, res, requestId, store, jobId);
    if (parts.length === 3 && second === 'abstraction' && third === 'start') return await handleAbstractionStart(req, res, requestId, store, jobId);
    if (parts.length === 3 && second === 'abstraction' && third === 'status') return await handleAbstractionStatus(req, res, requestId, store, jobId);
    if (parts.length === 2 && second === 'abstracts') return await handleAbstractList(req, res, requestId, store, jobId);
    return res.status(404).json({ error: 'Job route not found.', requestId });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, requestId });
    }
    console.error(JSON.stringify({
      event: 'job_route_error',
      requestId,
      path: parts.join('/'),
      reason: err?.message || String(err),
    }));
    return res.status(500).json({ error: 'Could not process job route.', requestId });
  }
}
