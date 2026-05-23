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
  validateFollowupRequestInput,
  validatePatchChunkInput,
  validatePatchJobInput,
  validateSaveJobResultInput,
  validateSynthesisRequestInput,
} from '../_lib/jobs.js';
import {
  processJobAbstraction,
  retryChunkAbstraction,
  serverAbstractionSetupError,
} from '../_lib/abstraction.js';
import {
  abstractionSnapshot,
  cancelAbstractionJob,
  enqueueAbstractionJob,
  enqueueSynthesisJob,
  getWorkflowConfig,
  processAbstractionBatch,
  processSynthesisBatch,
  retryFailedAbstractionChunks,
  synthesisSnapshot,
  workflowSetupError,
} from '../_lib/queue.js';
import {
  answerFollowupQuestion,
  synthesisSetupError,
} from '../_lib/synthesis.js';
import { isAllowedStorageUrl, objectExists, validateObjectRef } from '../_lib/storage.js';

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

const TERMINAL_JOB_STATUSES = new Set(['complete', 'partial_failed', 'failed', 'canceled']);

function isTerminalJob(job) {
  return TERMINAL_JOB_STATUSES.has(job?.status);
}

function expectedChunkBlobPrefix(jobId, chunkId) {
  return `jobs/${jobId}/chunks/${chunkId}/`;
}

async function chunkHasUsableBlobMetadata(chunk) {
  if (!chunk || chunk.uploadStatus !== 'uploaded') return true;
  if (typeof chunk.blobKey !== 'string' || !chunk.blobKey.startsWith(expectedChunkBlobPrefix(chunk.jobId, chunk.id))) {
    return false;
  }
  if (!isAllowedStorageUrl(chunk.blobUrl)) return false;
  const ref = validateObjectRef({
    jobId: chunk.jobId,
    chunkId: chunk.id,
    objectKey: chunk.blobKey,
    objectUrl: chunk.blobUrl,
  });
  if (!ref.valid) return false;
  if (process.env.VERIFY_GCS_OBJECTS === 'true') {
    return await objectExists(chunk);
  }
  return true;
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
  if (isTerminalJob(existingJob)) {
    return res.status(409).json({ error: 'Cannot add documents to a terminal job.', requestId });
  }

  const body = parseBody(req, res, requestId);
  if (!body) return;
  const validation = validateCreateDocumentInput(body);
  if (!validation.valid) return res.status(400).json({ error: validation.reason, requestId });
  if (validation.value.fingerprint && store.findDocumentByFingerprint) {
    const existingDocument = await store.findDocumentByFingerprint(jobId, validation.value.fingerprint);
    if (existingDocument) return res.status(200).json({ document: existingDocument, requestId });
  }

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

  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  if (isTerminalJob(job)) {
    return res.status(409).json({ error: 'Cannot add chunks to a terminal job.', requestId });
  }
  const document = await store.getDocument(jobId, documentId);
  if (!document) return res.status(404).json({ error: 'Document not found.', requestId });
  if (validation.value.fingerprint && store.findChunkByFingerprint) {
    const existingChunk = await store.findChunkByFingerprint(jobId, documentId, validation.value.fingerprint, validation.value.chunkOrder);
    if (existingChunk) return res.status(200).json({ chunk: existingChunk, requestId });
  }
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
  const validation = validatePatchChunkInput(body, { jobId, chunkId });
  if (!validation.valid) return res.status(400).json({ error: validation.reason, requestId });

  const chunk = await store.updateChunk(jobId, chunkId, validation.patch);
  if (!chunk) return res.status(404).json({ error: 'Chunk not found.', requestId });
  return res.status(200).json({ chunk, requestId });
}

async function handleFinalizeUploads(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const chunks = await store.listChunks(jobId);
  const checks = await Promise.all(chunks.map(async chunk => ({
    chunk,
    usable: await chunkHasUsableBlobMetadata(chunk),
  })));
  const invalidUploaded = checks.filter(item => !item.usable).map(item => item.chunk);
  if (invalidUploaded.length) {
    return res.status(409).json({
      error: 'Uploaded chunks must include valid durable storage metadata before finalization.',
      invalidChunks: invalidUploaded.map(chunk => chunk.id),
      requestId,
    });
  }
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

function publicStatus(snapshot) {
  if (!snapshot) return null;
  return {
    total: snapshot.total || 0,
    pending: snapshot.pending || 0,
    processing: snapshot.processing || 0,
    completed: snapshot.completed || 0,
    failed: snapshot.failed || 0,
    retry_wait: snapshot.retry_wait || 0,
    failedChunks: (snapshot.failedChunks || []).map(publicFailedChunk),
    hasMore: snapshot.hasMore ?? ((snapshot.pending || 0) + (snapshot.processing || 0) + (snapshot.retry_wait || 0) > 0),
  };
}

async function handleAbstractionStart(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const setupError = serverAbstractionSetupError() || workflowSetupError();
  if (setupError) {
    return res.status(503).json({ error: setupError, fallback: 'browser_abstraction', requestId });
  }
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  if (job.status === 'canceled') {
    return res.status(409).json({ error: 'Job has been canceled.', requestId });
  }
  const snapshot = await enqueueAbstractionJob(jobId, { store });
  const config = getWorkflowConfig();
  return res.status(202).json({
    status: publicStatus(snapshot),
    job: snapshot.job,
    workflow: { driver: config.driver, batchLimit: config.batchLimit, concurrency: config.concurrency },
    requestId,
  });
}

async function handleAbstractionStatus(req, res, requestId, store, jobId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  const snapshot = await abstractionSnapshot(jobId, { store });
  return res.status(200).json({
    status: publicStatus(snapshot),
    job: snapshot.job || job,
    requestId,
  });
}

async function handleAbstractionProcess(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const setupError = serverAbstractionSetupError() || workflowSetupError();
  if (setupError) {
    return res.status(503).json({ error: setupError, fallback: 'browser_abstraction', requestId });
  }
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  if (job.status === 'canceled') {
    return res.status(409).json({ error: 'Job has been canceled.', requestId });
  }
  const result = await processAbstractionBatch(jobId, { store });
  return res.status(200).json({
    status: publicStatus(result),
    job: result.job || job,
    hasMore: result.hasMore,
    completedInBatch: result.completedInBatch,
    failedInBatch: result.failedInBatch,
    retryScheduledInBatch: result.retryScheduledInBatch,
    splitsInBatch: result.splitsInBatch,
    elapsedMs: result.elapsedMs,
    lastError: result.lastError,
    requestId,
  });
}

async function handleJobCancel(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const body = req.body ? parseBody(req, res, requestId) : {};
  if (req.body && !body) return;
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : undefined;
  const { job, alreadyCanceled } = await cancelAbstractionJob(jobId, { store, reason });
  return res.status(200).json({ job, alreadyCanceled: Boolean(alreadyCanceled), requestId });
}

async function handleRetryFailedChunks(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const setupError = serverAbstractionSetupError() || workflowSetupError();
  if (setupError) {
    return res.status(503).json({ error: setupError, fallback: 'browser_abstraction', requestId });
  }
  const result = await retryFailedAbstractionChunks(jobId, { store });
  return res.status(200).json({
    reset: result.reset,
    status: publicStatus(result.snapshot),
    job: result.snapshot?.job,
    requeuedAt: result.requeuedAt,
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

function publicSynthesisSegment(segment) {
  if (!segment) return null;
  return {
    id: segment.id,
    segmentIndex: segment.segmentIndex,
    startSequenceIndex: segment.startSequenceIndex,
    endSequenceIndex: segment.endSequenceIndex,
    documentIds: segment.documentIds || [],
    filenames: segment.filenames || [],
    status: segment.status,
    attemptCount: segment.attemptCount,
    estimatedBytes: segment.estimatedBytes,
    modelUsed: segment.modelUsed,
    inputTokens: segment.inputTokens,
    outputTokens: segment.outputTokens,
    payloadBytes: segment.payloadBytes,
    latencyMs: segment.latencyMs,
    errorType: segment.errorType,
    errorMessage: segment.errorMessage,
    warnings: segment.warnings || [],
    completedAt: segment.completedAt,
  };
}

function publicSynthesisStatusBody(snapshot) {
  if (!snapshot) return null;
  const raw = snapshot.raw || snapshot;
  const status = snapshot.status || {};
  return {
    total: status.total ?? raw?.total ?? 0,
    pending: status.pending ?? raw?.pending ?? 0,
    processing: status.processing ?? raw?.processing ?? 0,
    complete: status.complete ?? raw?.complete ?? 0,
    failed: status.failed ?? raw?.failed ?? 0,
    retry_wait: status.retry_wait ?? raw?.retry_wait ?? 0,
    planId: status.planId ?? raw?.planId ?? null,
    hasResult: status.hasResult ?? raw?.hasResult ?? false,
    mergeInProgress: status.mergeInProgress ?? raw?.mergeInProgress ?? false,
    segments: (raw?.segments || []).map(publicSynthesisSegment),
    warnings: raw?.result?.warnings || [],
    failedDocuments: raw?.result?.failedDocuments || [],
    hasMore: Boolean(status.mergeInProgress ?? raw?.mergeInProgress)
      || ((status.pending ?? 0) + (status.processing ?? 0) + (status.retry_wait ?? 0)) > 0,
  };
}

function publicJobResult(result) {
  if (!result) return null;
  return {
    jobId: result.jobId,
    planId: result.planId,
    status: result.status,
    finalTitleOpinion: result.finalTitleOpinion,
    warnings: result.warnings || [],
    failedDocuments: result.failedDocuments || [],
    modelUsed: result.modelUsed,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    payloadBytes: result.payloadBytes,
    synthesisDurationMs: result.synthesisDurationMs,
    generatedAt: result.generatedAt,
  };
}

function synthesisCombinedSetupError() {
  return workflowSetupError() || synthesisSetupError();
}

async function handleSynthesisStart(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const body = req.body ? parseBody(req, res, requestId) : {};
  if (req.body && !body) return;
  const validation = validateSynthesisRequestInput(body);
  if (!validation.valid) return res.status(400).json({ error: validation.reason, requestId });
  const setupError = synthesisCombinedSetupError();
  if (setupError) {
    return res.status(503).json({ error: setupError, fallback: 'browser_synthesis', requestId });
  }
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  if (job.status === 'canceled') {
    return res.status(409).json({ error: 'Job has been canceled.', requestId });
  }
  let snapshot;
  try {
    snapshot = await enqueueSynthesisJob(jobId, { store });
  } catch (err) {
    if (err?.statusCode === 409 || /No abstracts available/i.test(err?.message || '')) {
      return res.status(409).json({ error: err.message || 'Synthesis cannot start before abstracts are available.', requestId });
    }
    throw err;
  }
  const workflow = getWorkflowConfig();
  return res.status(202).json({
    status: publicSynthesisStatusBody(snapshot),
    job: snapshot.job,
    workflow: { driver: workflow.driver },
    requestId,
  });
}

async function handleSynthesisStatus(req, res, requestId, store, jobId) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  const snapshot = await synthesisSnapshot(jobId, { store });
  return res.status(200).json({
    status: publicSynthesisStatusBody(snapshot),
    job: snapshot.job || job,
    requestId,
  });
}

async function handleSynthesisProcess(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const body = req.body ? parseBody(req, res, requestId) : {};
  if (req.body && !body) return;
  const validation = validateSynthesisRequestInput(body);
  if (!validation.valid) return res.status(400).json({ error: validation.reason, requestId });
  const setupError = synthesisCombinedSetupError();
  if (setupError) {
    return res.status(503).json({ error: setupError, fallback: 'browser_synthesis', requestId });
  }
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  if (job.status === 'canceled') {
    return res.status(409).json({ error: 'Job has been canceled.', requestId });
  }
  let result;
  try {
    result = await processSynthesisBatch(jobId, { store });
  } catch (err) {
    if (err?.statusCode === 409 || /No abstracts available/i.test(err?.message || '')) {
      return res.status(409).json({ error: err.message || 'Synthesis cannot run before abstracts are available.', requestId });
    }
    throw err;
  }
  return res.status(200).json({
    status: publicSynthesisStatusBody({ status: result.status, raw: result.rawStatus }),
    job: result.rawStatus?.job || job,
    completedInBatch: result.completedInBatch,
    failedInBatch: result.failedInBatch,
    retryScheduledInBatch: result.retryScheduledInBatch,
    mergeRan: result.mergeRan,
    elapsedMs: result.elapsedMs,
    lastError: result.lastError,
    result: publicJobResult(result.result),
    hasMore: result.hasMore,
    requestId,
  });
}

async function handleJobResult(req, res, requestId, store, jobId) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const job = await store.getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.', requestId });
  if (req.method === 'POST') {
    if (job.status === 'canceled') {
      return res.status(409).json({ error: 'Cannot save a result for a canceled job.', requestId });
    }
    if (!store.saveJobResult) {
      return res.status(503).json({ error: 'Job result storage is not available.', requestId });
    }
    const body = parseBody(req, res, requestId);
    if (!body) return;
    const validation = validateSaveJobResultInput(body);
    if (!validation.valid) {
      return res.status(validation.statusCode).json({ error: validation.reason, requestId });
    }
    const result = await store.saveJobResult(jobId, validation.payload);
    if (!result) return res.status(404).json({ error: 'Job not found.', requestId });
    const updatedJob = await store.getJob(jobId);
    return res.status(200).json({
      result: publicJobResult(result),
      job: updatedJob || job,
      requestId,
    });
  }
  const result = store.getJobResult ? await store.getJobResult(jobId) : null;
  if (!result) {
    return res.status(404).json({ error: 'Final title opinion is not available yet for this job.', requestId, job });
  }
  return res.status(200).json({
    result: publicJobResult(result),
    job,
    requestId,
  });
}

async function handleFollowup(req, res, requestId, store, jobId) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.', requestId });
  if (!requireServerAbstractionPassword(res, requestId)) return;
  if (!validPrefixedId(jobId, 'job_')) return res.status(400).json({ error: 'Invalid job id.', requestId });
  const body = parseBody(req, res, requestId);
  if (!body) return;
  const validation = validateFollowupRequestInput(body);
  if (!validation.valid) return res.status(400).json({ error: validation.reason, requestId });
  const setupError = synthesisSetupError();
  if (setupError) {
    return res.status(503).json({ error: setupError, fallback: 'browser_synthesis', requestId });
  }
  try {
    const { followup, truncationWarning } = await answerFollowupQuestion(jobId, validation.value.question, { store });
    return res.status(200).json({
      followup,
      truncationWarning,
      requestId,
    });
  } catch (err) {
    if (err?.statusCode) {
      return res.status(err.statusCode).json({ error: err.message, requestId });
    }
    throw err;
  }
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
    if (parts.length === 3 && second === 'abstraction' && third === 'process') return await handleAbstractionProcess(req, res, requestId, store, jobId);
    if (parts.length === 3 && second === 'synthesis' && third === 'start') return await handleSynthesisStart(req, res, requestId, store, jobId);
    if (parts.length === 3 && second === 'synthesis' && third === 'status') return await handleSynthesisStatus(req, res, requestId, store, jobId);
    if (parts.length === 3 && second === 'synthesis' && third === 'process') return await handleSynthesisProcess(req, res, requestId, store, jobId);
    if (parts.length === 2 && second === 'result') return await handleJobResult(req, res, requestId, store, jobId);
    if (parts.length === 2 && second === 'followup') return await handleFollowup(req, res, requestId, store, jobId);
    if (parts.length === 2 && second === 'abstracts') return await handleAbstractList(req, res, requestId, store, jobId);
    if (parts.length === 2 && second === 'cancel') return await handleJobCancel(req, res, requestId, store, jobId);
    if (parts.length === 2 && second === 'retry-failed') return await handleRetryFailedChunks(req, res, requestId, store, jobId);
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
