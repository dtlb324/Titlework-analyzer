import nodeAssert from 'node:assert/strict';
import jobsRouteHandler from '../api/jobs/[...path].js';
import {
  ABSTRACTION_PROMPT,
  assertSafeBlobUrl,
  buildAbstractMessagesForChunk,
  buildAbstractMessagesForChunks,
  computePdfSplitRanges,
  resolveChunkDelivery,
  estimateAbstractPayloadBytes,
  evaluateAbstractEscalation,
  defaultBlobLoader,
  getAbstractionConfig,
  resolveAbstractModel,
  resolveEscalationMaxTokens,
  resolveEscalationModel,
  processChunkAbstraction,
  processJobAbstraction,
  shouldEscalateAbstract,
  tryReuseExistingAbstract,
  validateAbstractPersistenceInput,
  enrichVisualDeliveryForModel,
} from '../api/_lib/abstraction.js';
import { chunkRequiresSoloBatch } from '../api/_lib/abstraction-batch.js';
import { groupAbstractsByDocument } from '../api/_lib/synthesis.js';
import {
  getBackgroundPromise,
  processAbstractionBatch,
} from '../api/_lib/queue.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { applyAbstractionClaim } from '../api/_lib/jobs.js';
import { fileURLToPath } from 'url';
import { cleanCases, defectiveCases } from './fixtures/abstract-quality-corpus.js';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');
const previousAppPassword = process.env.APP_PASSWORD;
process.env.APP_PASSWORD = 'test-password';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mockReq(method, body = null, headers = {}, query = {}, url = '/api/jobs/job_test_1/abstraction/start') {
  return {
    method,
    body,
    query,
    headers: { 'x-forwarded-for': '203.0.113.66', 'x-app-password': 'test-password', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    url,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

function cleanAbstract(note = 'All fields clearly legible.', docNum = 1) {
  return [
    `DOCUMENT #${docNum}:`,
    'DOC TYPE: Warranty Deed',
    'DATE EXECUTED: January 1, 2020',
    'DATE RECORDED: January 2, 2020',
    'RECORDING REF: Vol 1, Page 2',
    'GRANTOR: John Smith',
    'GRANTEE: Mary Jones',
    'LEGAL DESC: Section 1, Block C-9',
    'SURFACE: yes',
    'MINERALS: yes - 1/2',
    'ROYALTY/NPRI: no',
    'TERM: perpetual',
    'AFTER-ACQUIRED TITLE: no',
    'FRACTION CONVEYED: 1/2 mineral interest',
    'RESERVATIONS: none stated',
    'WARRANTY: full',
    'ACKNOWLEDGMENT: yes',
    'ISSUES: none noted',
    `CONFIDENCE: ${note}`,
  ].join('\n');
}

function makeChunk(overrides = {}) {
  return {
    id: overrides.id || 'chk_test_1',
    jobId: 'job_test_1',
    documentId: overrides.documentId || 'doc_test_1',
    chunkOrder: overrides.chunkOrder ?? 0,
    originalFilename: overrides.originalFilename || 'Deed.pdf',
    blobKey: overrides.blobKey || `jobs/job_test_1/chunks/${overrides.id || 'chk_test_1'}/deed.pdf`,
    blobUrl: overrides.blobUrl || `gs://titlework-test/jobs/job_test_1/chunks/${overrides.id || 'chk_test_1'}/deed.pdf`,
    mediaType: overrides.mediaType || 'application/pdf',
    sizeBytes: overrides.sizeBytes ?? 100,
    pageStart: overrides.pageStart ?? 1,
    pageEnd: overrides.pageEnd ?? 1,
    splitFrom: overrides.splitFrom || null,
    fingerprint: overrides.fingerprint || `${overrides.id || 'chk_test_1'}-fingerprint`,
    checksumSha256: 'a'.repeat(64),
    uploadStatus: 'uploaded',
    abstractionStatus: overrides.abstractionStatus || 'pending',
    abstractionAttempts: overrides.abstractionAttempts || 0,
    abstractionReclaims: overrides.abstractionReclaims || 0,
    abstractionErrorType: overrides.abstractionErrorType || null,
    abstractionErrorMessage: overrides.abstractionErrorMessage || null,
    abstractionRetryAt: overrides.abstractionRetryAt || null,
    abstractionClaimedAt: overrides.abstractionClaimedAt || null,
    abstractionLeaseExpiresAt: overrides.abstractionLeaseExpiresAt || null,
    abstractionWorkerId: overrides.abstractionWorkerId || null,
    payloadBytes: overrides.payloadBytes || null,
    latencyMs: overrides.latencyMs || null,
    modelUsed: overrides.modelUsed || null,
    inputTokens: overrides.inputTokens || null,
    outputTokens: overrides.outputTokens || null,
    createdAt: '2026-05-22T22:30:00.000Z',
    updatedAt: '2026-05-22T22:30:00.000Z',
    completedAt: null,
    abstractionCompletedAt: null,
  };
}

function createMemoryPhase3Store(chunksInput = [makeChunk()], options = {}) {
  const now = '2026-05-22T22:31:00.000Z';
  const jobs = new Map([[
    'job_test_1',
    {
      id: 'job_test_1',
      status: options.jobStatus || 'ready',
      totalDocuments: chunksInput.length,
      totalChunks: chunksInput.length,
      completedDocuments: 0,
      failedDocuments: 0,
      completedChunks: chunksInput.length,
      failedChunks: 0,
      currentPhase: 'ready',
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    },
  ]]);
  const chunks = new Map(chunksInput.map(chunk => [chunk.id, { ...chunk }]));
  const abstracts = new Map();

  function orderedChunks(jobId) {
    return [...chunks.values()]
      .filter(chunk => chunk.jobId === jobId)
      .sort((a, b) => a.chunkOrder - b.chunkOrder);
  }

  function rollup(jobId) {
    const jobChunks = orderedChunks(jobId).filter(chunk => chunk.abstractionStatus !== 'split_superseded');
    const completed = jobChunks.filter(chunk => chunk.abstractionStatus === 'completed').length;
    const failed = jobChunks.filter(chunk => chunk.abstractionStatus === 'failed').length;
    const pending = jobChunks.filter(chunk => chunk.abstractionStatus === 'pending').length;
    const processing = jobChunks.filter(chunk => chunk.abstractionStatus === 'processing').length;
    const retry_wait = jobChunks.filter(chunk => chunk.abstractionStatus === 'retry_wait').length;
    const terminal = completed + failed;
    const job = jobs.get(jobId);
    let status = job.status;
    if (status === 'canceled') {
    } else if (status === 'complete' && pending === 0 && processing === 0 && retry_wait === 0) {
    } else if (jobChunks.length && terminal === jobChunks.length) {
      status = completed > 0 && failed > 0 ? 'partial_failed' : completed > 0 ? 'synthesizing' : 'failed';
    } else if (jobChunks.some(chunk => ['pending', 'processing', 'retry_wait'].includes(chunk.abstractionStatus))) {
      status = 'abstracting';
    }
    const updated = {
      ...job,
      status,
      completedDocuments: completed,
      failedDocuments: failed,
      currentPhase: terminal === jobChunks.length
        ? `Server abstraction finished: ${completed} completed, ${failed} failed`
        : `Server abstraction ${completed}/${jobChunks.length}`,
      updatedAt: now,
    };
    jobs.set(jobId, updated);
    return { updated, counts: { completed, failed, pending, processing, retry_wait } };
  }

  function isClaimable(chunk, asOfMs, workerId = null) {
    if (chunk.uploadStatus !== 'uploaded') return false;
    const status = chunk.abstractionStatus || 'pending';
    if (status === 'pending') return true;
    if (status === 'retry_wait') {
      const retryAt = chunk.abstractionRetryAt ? Date.parse(chunk.abstractionRetryAt) : 0;
      return !retryAt || retryAt <= asOfMs;
    }
    if (status === 'processing') {
      if (workerId && chunk.abstractionWorkerId === workerId) return true;
      const expires = chunk.abstractionLeaseExpiresAt ? Date.parse(chunk.abstractionLeaseExpiresAt) : 0;
      return !expires || expires <= asOfMs;
    }
    return false;
  }

  return {
    jobs,
    chunks,
    abstracts,
    async getJob(id) {
      return jobs.get(id) || null;
    },
    async updateJob(id, patch) {
      const existing = jobs.get(id);
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: now };
      jobs.set(id, updated);
      return updated;
    },
    async listChunks(jobId) {
      return orderedChunks(jobId);
    },
    async listReadyAbstractionChunks(jobId, limit = 8) {
      const asOf = Date.now();
      return orderedChunks(jobId).filter(chunk => isClaimable(chunk, asOf)).slice(0, limit);
    },
    async getChunk(jobId, chunkId) {
      const chunk = chunks.get(chunkId);
      return chunk?.jobId === jobId ? chunk : null;
    },
    async markChunkAbstractionProcessing(jobId, chunkId) {
      const chunk = chunks.get(chunkId);
      if (!chunk || chunk.jobId !== jobId || chunk.abstractionStatus !== 'pending') return null;
      const updated = { ...chunk, abstractionStatus: 'processing', abstractionAttempts: chunk.abstractionAttempts + 1, updatedAt: now };
      chunks.set(chunkId, updated);
      return updated;
    },
    async claimChunkForAbstraction(jobId, chunkId, claimOptions = {}) {
      const chunk = chunks.get(chunkId);
      if (!chunk || chunk.jobId !== jobId) return null;
      if (!isClaimable(chunk, Date.now(), claimOptions.workerId)) return null;
      const updated = applyAbstractionClaim(chunk, claimOptions);
      chunks.set(chunkId, updated);
      return updated;
    },
    async renewChunkAbstractionLease(jobId, chunkId, renewOptions = {}) {
      if (options.renewThrows) throw new Error(options.renewThrows);
      const chunk = chunks.get(chunkId);
      if (!chunk || chunk.jobId !== jobId) return null;
      if (chunk.abstractionStatus !== 'processing' || !renewOptions.workerId || chunk.abstractionWorkerId !== renewOptions.workerId) return null;
      const updated = {
        ...chunk,
        abstractionLeaseExpiresAt: new Date(Date.now() + Math.max(1, Number(renewOptions.leaseMs) || 90_000)).toISOString(),
        updatedAt: now,
      };
      chunks.set(chunkId, updated);
      return updated;
    },
    async markChunkAbstractionFailed(jobId, chunkId, failure) {
      const chunk = chunks.get(chunkId);
      if (options.enforceWorkerLease && (!failure.workerId || chunk.abstractionStatus !== 'processing' || chunk.abstractionWorkerId !== failure.workerId)) {
        return null;
      }
      const updated = {
        ...chunk,
        abstractionStatus: 'failed',
        abstractionErrorType: failure.errorType,
        abstractionErrorMessage: failure.errorMessage,
        abstractionClaimedAt: null,
        abstractionLeaseExpiresAt: null,
        abstractionWorkerId: null,
        abstractionRetryAt: null,
        payloadBytes: failure.payloadBytes ?? chunk.payloadBytes,
        latencyMs: failure.latencyMs ?? chunk.latencyMs,
        modelUsed: failure.modelUsed ?? chunk.modelUsed,
        updatedAt: now,
      };
      chunks.set(chunkId, updated);
      rollup(jobId);
      return updated;
    },
    async markChunkAbstractionRetryWait(jobId, chunkId, failure) {
      const chunk = chunks.get(chunkId);
      if (options.enforceWorkerLease && (!failure.workerId || chunk.abstractionStatus !== 'processing' || chunk.abstractionWorkerId !== failure.workerId)) {
        return null;
      }
      const updated = {
        ...chunk,
        abstractionStatus: 'retry_wait',
        abstractionErrorType: failure.errorType,
        abstractionErrorMessage: failure.errorMessage,
        abstractionRetryAt: failure.retryAtIso,
        abstractionClaimedAt: null,
        abstractionLeaseExpiresAt: null,
        abstractionWorkerId: null,
        updatedAt: now,
      };
      chunks.set(chunkId, updated);
      rollup(jobId);
      return updated;
    },
    async getDocumentAbstractByChunkId(jobId, chunkId) {
      const item = abstracts.get(chunkId);
      return item && item.jobId === jobId ? item : null;
    },
    async findReusableAbstractForChunk(jobId, chunk) {
      if (!chunk.fingerprint) return null;
      for (const [chunkId, abs] of abstracts.entries()) {
        const peer = chunks.get(chunkId);
        if (!peer || peer.id === chunk.id || peer.abstractionStatus !== 'completed') continue;
        if (peer.fingerprint === chunk.fingerprint) {
          return { ...abs, chunkId };
        }
      }
      return null;
    },
    async saveDocumentAbstract(record, options = {}) {
      validateAbstractPersistenceInput(record);
      const chunk = chunks.get(record.chunkId);
      if (options.enforceWorkerLease && (!record.workerId || chunk.abstractionStatus !== 'processing' || chunk.abstractionWorkerId !== record.workerId)) {
        return null;
      }
      const id = `abs_${record.chunkId}`;
      const saved = { id, ...record, createdAt: now };
      abstracts.set(record.chunkId, saved);
      chunks.set(record.chunkId, {
        ...chunk,
        abstractionStatus: 'completed',
        abstractionErrorType: null,
        abstractionErrorMessage: null,
        abstractionClaimedAt: null,
        abstractionLeaseExpiresAt: null,
        abstractionWorkerId: null,
        abstractionRetryAt: null,
        payloadBytes: record.payloadBytes,
        latencyMs: record.latencyMs,
        modelUsed: record.modelUsed,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        abstractionCompletedAt: now,
        updatedAt: now,
      });
      rollup(record.jobId);
      return saved;
    },
    async listDocumentAbstracts(jobId) {
      const byChunk = new Map([...abstracts.values()].map(item => [item.chunkId, item]));
      return orderedChunks(jobId)
        .filter(chunk => byChunk.has(chunk.id))
        .map(chunk => ({
          ...byChunk.get(chunk.id),
          chunkOrder: chunk.chunkOrder,
          originalFilename: chunk.originalFilename,
          status: chunk.abstractionStatus,
        }));
    },
    async resetChunkAbstraction(jobId, chunkId) {
      const chunk = chunks.get(chunkId);
      if (!chunk || chunk.jobId !== jobId) return null;
      if (!['failed', 'retry_wait'].includes(chunk.abstractionStatus)) return null;
      const updated = {
        ...chunk,
        abstractionStatus: 'pending',
        abstractionErrorType: null,
        abstractionErrorMessage: null,
        abstractionRetryAt: null,
        abstractionClaimedAt: null,
        abstractionLeaseExpiresAt: null,
        abstractionWorkerId: null,
        updatedAt: now,
      };
      chunks.set(chunkId, updated);
      rollup(jobId);
      return updated;
    },
    async retryFailedChunks(jobId) {
      const jobChunks = orderedChunks(jobId);
      let reset = 0;
      for (const chunk of jobChunks) {
        if (['failed', 'retry_wait'].includes(chunk.abstractionStatus)) {
          chunks.set(chunk.id, {
            ...chunk,
            abstractionStatus: 'pending',
            abstractionErrorType: null,
            abstractionErrorMessage: null,
            abstractionRetryAt: null,
            abstractionClaimedAt: null,
            abstractionLeaseExpiresAt: null,
            abstractionWorkerId: null,
            updatedAt: now,
          });
          reset += 1;
        }
      }
      rollup(jobId);
      return reset;
    },
    async cancelJob(jobId, reason) {
      const job = jobs.get(jobId);
      if (!job) return null;
      const cancelReason = reason || 'Job canceled by user.';
      const updated = {
        ...job,
        status: 'canceled',
        currentPhase: 'canceled',
        errorMessage: cancelReason,
        completedAt: job.completedAt || now,
        updatedAt: now,
      };
      jobs.set(jobId, updated);
      for (const chunk of orderedChunks(jobId)) {
        if (['pending', 'retry_wait', 'processing'].includes(chunk.abstractionStatus)) {
          chunks.set(chunk.id, {
            ...chunk,
            abstractionStatus: 'failed',
            abstractionErrorType: 'canceled',
            abstractionErrorMessage: cancelReason,
            abstractionRetryAt: null,
            abstractionClaimedAt: null,
            abstractionLeaseExpiresAt: null,
            abstractionWorkerId: null,
            updatedAt: now,
          });
        }
      }
      rollup(jobId);
      return updated;
    },
    async refreshAbstractionRollup(jobId) {
      return rollup(jobId).updated;
    },
    async getAbstractionStatus(jobId) {
      const jobChunks = orderedChunks(jobId).filter(chunk => chunk.abstractionStatus !== 'split_superseded');
      const counts = jobChunks.reduce((acc, chunk) => {
        acc[chunk.abstractionStatus] = (acc[chunk.abstractionStatus] || 0) + 1;
        return acc;
      }, {});
      return {
        total: jobChunks.length,
        pending: counts.pending || 0,
        processing: counts.processing || 0,
        completed: counts.completed || 0,
        failed: counts.failed || 0,
        retry_wait: counts.retry_wait || 0,
        failedChunks: jobChunks.filter(chunk => chunk.abstractionStatus === 'failed'),
        job: jobs.get(jobId),
      };
    },
    async resetStaleProcessingChunks(jobId, staleMs = 120_000) {
      const asOf = Date.now();
      const stale = [];
      for (const chunk of orderedChunks(jobId)) {
        if (chunk.abstractionStatus !== 'processing') continue;
        const expires = chunk.abstractionLeaseExpiresAt ? Date.parse(chunk.abstractionLeaseExpiresAt) : 0;
        const updatedAt = chunk.updatedAt ? Date.parse(chunk.updatedAt) : 0;
        const isStale = (expires && expires <= asOf) || (!expires && updatedAt && (asOf - updatedAt) > staleMs);
        if (isStale) {
          chunks.set(chunk.id, {
            ...chunk,
            abstractionStatus: 'pending',
            abstractionErrorType: 'stale_processing_recovered',
            abstractionErrorMessage: 'Stale lease recovered.',
            abstractionClaimedAt: null,
            abstractionLeaseExpiresAt: null,
            abstractionWorkerId: null,
            updatedAt: now,
          });
          stale.push(chunks.get(chunk.id));
        }
      }
      if (stale.length) rollup(jobId);
      return stale;
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('enrichVisualDeliveryForModel skips Gemini Files upload when routing to OpenRouter', async () => {
  const prevProvider = process.env.MODEL_PROVIDER;
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevFetch = global.fetch;
  process.env.MODEL_PROVIDER = 'openrouter';
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  let fetchCalled = false;
  global.fetch = async (...args) => {
    fetchCalled = true;
    throw new Error(`unexpected upload fetch: ${String(args[0])}`);
  };

  try {
    const delivery = { mode: 'visual', extractedText: '' };
    const chunk = { id: 'c1', mediaType: 'application/pdf', originalFilename: 'big.pdf' };
    const payload = new Uint8Array(2_000_000);
    const result = await enrichVisualDeliveryForModel(delivery, chunk, payload, 'gemini-2.5-flash');
    assert(result.mode === 'visual', `Expected delivery to stay 'visual', got '${result.mode}'`);
    assert(result.fileUri === undefined, 'Expected no file_uri to be set');
    assert(fetchCalled === false, 'Expected no Gemini Files upload when routing to OpenRouter');
  } finally {
    global.fetch = prevFetch;
    if (prevProvider) process.env.MODEL_PROVIDER = prevProvider; else delete process.env.MODEL_PROVIDER;
    if (prevGeminiKey) process.env.GEMINI_API_KEY = prevGeminiKey; else delete process.env.GEMINI_API_KEY;
  }
});

test('POST /api/jobs/:id/abstraction/start enqueues quickly for the Cloud Run worker', async () => {
  const store = createMemoryPhase3Store([makeChunk()]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({
    bytes: Buffer.from('%PDF-test'),
    mediaType: chunk.mediaType,
  });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async request => {
    const blockTypes = request.messages[0].content.map(block => block.type);
    assert(blockTypes.includes('document'), 'Expected PDF document block');
    assert(request.payloadBytes <= 3_900_000, 'Expected safe payload envelope');
    return {
      text: cleanAbstract('Abstracted deed facts.'),
      model: 'gemini-2.5-flash',
      usage: { input_tokens: 111, output_tokens: 22 },
    };
  };

  const startedAt = Date.now();
  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/start'), res);
  const elapsed = Date.now() - startedAt;

  assert(res.statusCode === 202, `Expected 202 Accepted, got ${res.statusCode}`);
  assert(res.body.status, 'Expected status snapshot in response');
  assert(res.body.workflow.driver === 'inprocess', 'Expected default inprocess driver');
  assert(elapsed < 2000, `Expected start endpoint to return quickly, took ${elapsed}ms`);

  const kickPromise = getBackgroundPromise('job_test_1');
  assert(kickPromise, 'Expected abstraction/start to kick a bounded background batch');
  await kickPromise;
  const saved = await store.listDocumentAbstracts('job_test_1');
  assert(saved.length === 1, 'Expected saved abstract');
  assert(saved[0].abstractText.includes('Abstracted deed facts'), 'Expected abstract text persistence');
  assert(saved[0].inputTokens === 111 && saved[0].outputTokens === 22, 'Expected token usage persistence');
});

test('POST /api/jobs/:id/abstraction/start can enqueue only when WORKFLOW_KICK_ON_START=false', async () => {
  const previousKick = process.env.WORKFLOW_KICK_ON_START;
  process.env.WORKFLOW_KICK_ON_START = 'false';
  const store = createMemoryPhase3Store([makeChunk()]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  try {
    const res = mockRes();
    await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/start'), res);
    assert(res.statusCode === 202, `Expected 202, got ${res.statusCode}`);
    assert(!getBackgroundPromise('job_test_1'), 'Expected no in-request kick when disabled');
  } finally {
    if (previousKick === undefined) delete process.env.WORKFLOW_KICK_ON_START;
    else process.env.WORKFLOW_KICK_ON_START = previousKick;
  }
});

test('POST /api/jobs/:id/abstraction/start rejects jobs before uploads are ready', async () => {
  const store = createMemoryPhase3Store([makeChunk()], { jobStatus: 'uploading' });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({ bytes: Buffer.from('%PDF'), mediaType: chunk.mediaType });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => ({ text: 'DOCUMENT #1:\nnoop', model: 'gemini-2.5-flash', usage: {} });

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/start'), res);

  assert(res.statusCode === 409, `Expected 409, got ${res.statusCode}`);
  assert(/finalized/.test(res.body.error), `Expected finalize guidance, got ${res.body.error}`);
});

test('resolveAbstractModel ignores removed Claude Haiku model ids', () => {
  const previous = process.env.ABSTRACT_MODEL;
  process.env.ABSTRACT_MODEL = 'claude-haiku-4-5';
  assert(resolveAbstractModel() === 'gemini-3.1-flash-lite', 'Expected Haiku override to fall back to Gemini Flash Lite');
  process.env.ABSTRACT_MODEL = 'claude-haiku-4-5-20251001';
  assert(resolveAbstractModel() === 'gemini-3.1-flash-lite', 'Expected Haiku version suffix to fall back to Gemini Flash Lite');
  if (previous) process.env.ABSTRACT_MODEL = previous;
  else delete process.env.ABSTRACT_MODEL;
});

test('buildAbstractMessagesForChunk supports PDF, image, and CSV chunks', async () => {
  const pdfMessages = buildAbstractMessagesForChunk(makeChunk({ mediaType: 'application/pdf' }), Buffer.from('%PDF'), 0);
  const imageMessages = buildAbstractMessagesForChunk(makeChunk({ mediaType: 'image/png', originalFilename: 'scan.png' }), Buffer.from('png'), 1);
  const csvMessages = buildAbstractMessagesForChunk(makeChunk({ mediaType: 'text/csv', originalFilename: 'owners.csv' }), Buffer.from('owner,interest\nA,1/2'), 2);

  assert(pdfMessages[0].content.some(block => block.type === 'document'), 'Expected PDF document block');
  assert(imageMessages[0].content.some(block => block.type === 'image'), 'Expected image block');
  assert(csvMessages[0].content.some(block => block.type === 'text' && block.text.includes('CSV DATA')), 'Expected CSV text prompt');
  assert(!JSON.stringify(csvMessages).includes('base64'), 'CSV messages should not use base64 document payloads');
});

test('rendered image chunks ignore PDF and CSV source extensions without changing the filename', async () => {
  const bytes = Buffer.from('rendered image');
  for (const filename of ['deed.pdf', 'owners.csv']) {
    const chunk = { originalFilename: filename, mediaType: 'image/png', renderedImages: true };
    const single = buildAbstractMessagesForChunk(chunk, bytes);
    const batch = buildAbstractMessagesForChunks([{ chunk, payloadBytes: bytes }]);
    for (const messages of [single, batch]) {
      const images = messages[0].content.filter(block => block.type === 'image');
      assert(images.length === 1, `Expected an image block for rendered ${filename}`);
      assert(images[0].source.data === bytes.toString('base64'), 'Expected unchanged rendered bytes');
      assert(!messages[0].content.some(block => block.type === 'document'), 'Rendered images must not become PDF blocks');
      assert(messages[0].content.at(-1).text.includes(`${filename} (rendered pages)`), 'Expected unchanged model-visible rendered filename');
    }
    assert(chunk.originalFilename === filename, 'Expected the original filename to remain unchanged');
    assert((await resolveChunkDelivery(chunk, bytes)).mode === 'visual', 'Rendered images must bypass PDF text extraction');
    assert(estimateAbstractPayloadBytes(chunk, bytes) === estimateAbstractPayloadBytes({ ...chunk, originalFilename: 'scan.png' }, bytes), 'Rendered image planning must not use PDF or CSV estimates');
  }
});

test('abstraction prompt treats each PDF as one recorded instrument', () => {
  assert(ABSTRACTION_PROMPT.includes('abstracting a single courthouse instrument'), 'Expected single-instrument abstraction instruction');
  assert(!ABSTRACTION_PROMPT.includes('INSTRUMENT 1 OF M'), 'Prompt should not ask for multi-instrument sub-sections');
  assert(!ABSTRACTION_PROMPT.includes('multiple clearly identifiable recorded instruments'), 'Prompt should not ask for multi-instrument detection');
  assert(getAbstractionConfig().maxTokens === 2000, `Expected 2000 token default, got ${getAbstractionConfig().maxTokens}`);
});

test('browser abstraction fallback mirrors single-instrument prompt and token budget', () => {
  assert(indexHtml.includes('abstracting a single courthouse instrument'), 'Expected browser prompt to include single-instrument instruction');
  assert(!indexHtml.includes('INSTRUMENT 1 OF M'), 'Browser prompt should not ask for multi-instrument sub-sections');
  assert(!indexHtml.includes('multiple clearly identifiable recorded instruments'), 'Browser prompt should not ask for multi-instrument detection');
  assert(indexHtml.includes('const ABSTRACT_MAX_TOKENS = 2000'), 'Expected browser abstraction token default to match server default');
  assert(indexHtml.includes("const ABSTRACT_MODEL = 'gemini-3.1-flash-lite'"), 'Expected browser fallback to use Gemini Flash Lite for abstraction');
  assert(indexHtml.includes("const SYNTHESIS_PARTIAL_MODEL = 'gemini-3.1-flash-lite'"), 'Expected browser partial synthesis to use Gemini Flash Lite');
  assert(!indexHtml.includes('claude-haiku-4-5'), 'Browser abstraction must not reference Claude Haiku');
  assert(indexHtml.includes("const ABSTRACT_ESCALATION_MODEL = 'claude-sonnet-5-5'"), 'Expected browser fallback to define Sonnet 5.5 escalation model');
  assert(indexHtml.includes('callAbstractionWithEscalation'), 'Expected browser fallback to use abstraction escalation helper');
});

test('GET /api/jobs/:id/abstracts returns saved abstracts in chunk order', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_second', chunkOrder: 1, originalFilename: 'B.pdf', abstractionStatus: 'completed' }),
    makeChunk({ id: 'chk_first', chunkOrder: 0, originalFilename: 'A.pdf', abstractionStatus: 'completed' }),
  ]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.saveDocumentAbstract({
    jobId: 'job_test_1',
    documentId: 'doc_test_1',
    chunkId: 'chk_second',
    abstractText: 'second',
    modelUsed: 'gemini-2.5-flash',
    payloadBytes: 100,
    latencyMs: 10,
    inputTokens: 1,
    outputTokens: 1,
    status: 'completed',
    attemptCount: 1,
  });
  await store.saveDocumentAbstract({
    jobId: 'job_test_1',
    documentId: 'doc_test_1',
    chunkId: 'chk_first',
    abstractText: 'first',
    modelUsed: 'gemini-2.5-flash',
    payloadBytes: 100,
    latencyMs: 10,
    inputTokens: 1,
    outputTokens: 1,
    status: 'completed',
    attemptCount: 1,
  });

  const res = mockRes();
  await jobsRouteHandler(mockReq('GET', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstracts'), res);

  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.abstracts.map(item => item.abstractText).join(',') === 'first,second', 'Expected chunk-order abstracts');
  assert(res.body.abstracts[0].sequence_index === 0, 'Expected Phase 3 sequence_index field');
  assert(res.body.abstracts[0].display_name === 'A.pdf', 'Expected Phase 3 display_name field');
  assert(res.body.abstracts[0].abstract_text === 'first', 'Expected Phase 3 abstract_text field');
  assert(!JSON.stringify(res.body).includes('data:'), 'Abstract response must not include raw data URLs');
});

test('server storage loader rejects non-GCS URLs before loading object bytes', () => {
  let rejected = false;
  try {
    assertSafeBlobUrl('https://attacker.example/chunk.pdf');
  } catch (err) {
    rejected = /Google Cloud Storage/.test(err.message);
  }
  assert(rejected, 'Expected non-GCS URL rejection');
});

test('POST /api/jobs/:id/chunks/:chunkId/retry retries only the failed chunk', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_done', chunkOrder: 0, abstractionStatus: 'completed' }),
    makeChunk({ id: 'chk_failed', chunkOrder: 1, originalFilename: 'retry.csv', mediaType: 'text/csv', abstractionStatus: 'failed', abstractionAttempts: 1 }),
  ]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.saveDocumentAbstract({
    jobId: 'job_test_1',
    documentId: 'doc_test_1',
    chunkId: 'chk_done',
    abstractText: 'already done',
    modelUsed: 'gemini-2.5-flash',
    payloadBytes: 100,
    latencyMs: 10,
    inputTokens: null,
    outputTokens: null,
    status: 'completed',
    attemptCount: 1,
  });
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({
    bytes: Buffer.from('owner,interest\nB,1/2'),
    mediaType: chunk.mediaType,
  });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => ({
    text: 'DOCUMENT #2:\nRetried CSV abstract.',
    model: 'gemini-2.5-flash',
    usage: {},
  });

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1', chunkId: 'chk_failed' }, '/api/jobs/job_test_1/chunks/chk_failed/retry'), res);

  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  const saved = await store.listDocumentAbstracts('job_test_1');
  assert(saved.length === 2, 'Expected existing and retried abstracts');
  assert(saved.some(item => item.abstractText.includes('already done')), 'Expected completed chunk preserved');
  assert(saved.some(item => item.abstractText.includes('Retried CSV abstract')), 'Expected failed chunk retried');
});

test('POST /api/jobs/:id/chunks/:chunkId/retry refuses a canceled job', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_failed', abstractionStatus: 'failed', abstractionErrorType: 'canceled' }),
  ], { jobStatus: 'canceled' });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  let modelCalls = 0;
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => {
    modelCalls += 1;
    return { text: 'DOCUMENT #1:\nShould not run.', model: 'gemini-2.5-flash', usage: {} };
  };

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1', chunkId: 'chk_failed' }, '/api/jobs/job_test_1/chunks/chk_failed/retry'), res);

  assert(res.statusCode === 409, `Expected 409 for a canceled job, got ${res.statusCode}`);
  assert(modelCalls === 0, `Expected no model call on a canceled job, got ${modelCalls}`);
});

test('processJobAbstraction preserves completed chunks when another chunk fails', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_ok', chunkOrder: 0, originalFilename: 'ok.pdf' }),
    makeChunk({ id: 'chk_bad', chunkOrder: 1, originalFilename: 'bad.pdf' }),
  ]);
  let modelCalls = 0;

  const result = await processJobAbstraction('job_test_1', {
    store,
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async () => {
      modelCalls += 1;
      if (modelCalls === 2) {
        const err = new Error('provider unavailable');
        err.status = 500;
        throw err;
      }
      return { text: cleanAbstract('Completed abstract.'), model: 'gemini-2.5-flash', usage: {} };
    },
    maxAttempts: 1,
  });

  assert(result.completed === 1, 'Expected one completed chunk');
  assert(result.failed === 1, 'Expected one failed chunk');
  const saved = await store.listDocumentAbstracts('job_test_1');
  assert(saved.length === 1, 'Expected completed abstract preserved');
  assert(store.chunks.get('chk_bad').abstractionStatus === 'failed', 'Expected only bad chunk failed');
});

test('validateAbstractPersistenceInput rejects raw document and base64 fields', () => {
  const result = validateAbstractPersistenceInput({
    jobId: 'job_test_1',
    documentId: 'doc_test_1',
    chunkId: 'chk_test_1',
    abstractText: 'safe abstract text',
    modelUsed: 'gemini-2.5-flash',
    payloadBytes: 100,
    latencyMs: 10,
    status: 'completed',
    attemptCount: 1,
    rawPdfBase64: 'JVBERi0=',
  });
  assert(result.valid === false, 'Expected raw base64 persistence rejection');
});

test('GET /api/jobs/:id/abstraction/status reports failed chunk list', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_done', abstractionStatus: 'completed' }),
    makeChunk({ id: 'chk_failed', chunkOrder: 1, abstractionStatus: 'failed', abstractionErrorType: 'provider_error' }),
  ]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;

  const res = mockRes();
  await jobsRouteHandler(mockReq('GET', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/status'), res);

  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.status.completed === 1, 'Expected completed count');
  assert(res.body.status.failed === 1, 'Expected failed count');
  assert(res.body.status.failedChunks[0].id === 'chk_failed', 'Expected failed chunk metadata');
});

test('frontend contains server-abstraction start, poll, fetch, and fallback hooks', () => {
  assert(indexHtml.includes('startServerAbstraction'), 'Expected server abstraction start hook');
  assert(indexHtml.includes('/abstraction/status'), 'Expected abstraction status polling endpoint');
  assert(indexHtml.includes('/abstracts'), 'Expected saved abstracts fetch endpoint');
  assert(indexHtml.includes('runDocumentAbstraction'), 'Expected browser abstraction fallback path preserved');
  assert(indexHtml.includes('falling back to browser abstraction'), 'Expected user-visible fallback warning');
});


test('Phase 4: worker claims pending chunks under a lease', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  async function makeTextPdf(label) {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText(`STATE OF TEXAS\nCOUNTY OF REEVES\nWARRANTY DEED\nDOCUMENT: ${label}\nGRANTOR: John Smith\nGRANTEE: Mary Jones\nExecuted January 1, 2020\nRecorded January 2, 2020, Vol 1, Page 2\nSection 1, Block C-9\n`.repeat(3), { x: 72, y: 700, size: 11, font, lineHeight: 14, maxWidth: 460 });
    return Buffer.from(await doc.save());
  }
  const pdfA = await makeTextPdf('A');
  const pdfB = await makeTextPdf('B');
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_a', chunkOrder: 0, originalFilename: 'a.pdf', sizeBytes: pdfA.byteLength }),
    makeChunk({ id: 'chk_b', chunkOrder: 1, originalFilename: 'b.pdf', sizeBytes: pdfB.byteLength }),
  ]);
  let modelCalls = 0;
  const result = await processAbstractionBatch('job_test_1', {
    store,
    blobLoader: async chunk => ({ bytes: chunk.id === 'chk_a' ? pdfA : pdfB, mediaType: chunk.mediaType }),
    modelClient: async () => {
      modelCalls += 1;
      return {
        text: JSON.stringify([
          { docIndex: 1, abstract: cleanAbstract('Claim test A.', 1) },
          { docIndex: 2, abstract: cleanAbstract('Claim test B.', 2) },
        ]),
        model: 'gemini-2.5-flash',
        usage: {},
      };
    },
    batchLimit: 4,
    concurrency: 2,
    budgetMs: 5000,
    maxAttempts: 1,
  });
  assert(modelCalls === 1, `Expected one batched model call for two small chunks, got ${modelCalls}`);
  assert(result.completed === 2, `Expected both chunks completed, got ${result.completed}`);
  assert(result.hasMore === false, 'Expected no more work');
  const chunkA = store.chunks.get('chk_a');
  assert(chunkA.abstractionAttempts >= 1, 'Expected attempt counter incremented by claim');
  assert(chunkA.abstractionStatus === 'completed', 'Expected completed status after worker success');
  assert(chunkA.abstractionLeaseExpiresAt === null, 'Expected lease cleared after success');
});

test('Phase 4: claim sets lease fields while chunk is in flight', async () => {
  const store = createMemoryPhase3Store([makeChunk()]);
  let observedDuringRun = null;
  await processAbstractionBatch('job_test_1', {
    store,
    blobLoader: async chunk => ({ bytes: Buffer.from('%PDF'), mediaType: chunk.mediaType }),
    modelClient: async () => {
      observedDuringRun = store.chunks.get('chk_test_1');
      return { text: cleanAbstract('ok.'), model: 'gemini-2.5-flash', usage: {} };
    },
    batchLimit: 1,
    concurrency: 1,
    budgetMs: 2000,
    maxAttempts: 1,
  });
  assert(observedDuringRun, 'Expected to observe chunk mid-flight');
  assert(observedDuringRun.abstractionStatus === 'processing', 'Expected processing status during model call');
  assert(observedDuringRun.abstractionLeaseExpiresAt, 'Expected lease set during processing');
  assert(observedDuringRun.abstractionWorkerId, 'Expected workerId stamped on claimed chunk');
});

test('Phase 4: abstraction worker logs chunk processing stages without raw payloads', async () => {
  const store = createMemoryPhase3Store([makeChunk({ mediaType: 'text/csv', originalFilename: 'owners.csv' })]);
  const previousLog = console.log;
  const logs = [];
  console.log = value => {
    try { logs.push(JSON.parse(value)); } catch {}
  };
  try {
    await processAbstractionBatch('job_test_1', {
      store,
      blobLoader: async chunk => ({ bytes: Buffer.from('owner,interest\nA,1/2'), mediaType: chunk.mediaType }),
      modelClient: async () => ({ text: 'DOCUMENT #1:\nCSV abstract.', model: 'gemini-2.5-flash', usage: {} }),
      batchLimit: 1,
      concurrency: 1,
      budgetMs: 2000,
      maxAttempts: 1,
      workerId: 'wkr_log_test',
      logStages: true,
    });
  } finally {
    console.log = previousLog;
  }

  const events = logs.filter(entry => entry.event === 'chunk_abstraction_stage');
  const stages = events.map(entry => entry.stage);
  assert(stages.includes('claimed'), 'Expected claimed stage log');
  assert(stages.includes('loaded'), 'Expected loaded stage log');
  assert(stages.includes('model_start'), 'Expected model_start stage log');
  assert(stages.includes('model_response'), 'Expected model_response stage log');
  assert(stages.includes('saved'), 'Expected saved stage log');
  assert(events.every(entry => !JSON.stringify(entry).includes('owner,interest')), 'Logs must not include raw CSV payload');
});

test('Phase 4: stale abstraction worker cannot overwrite a reclaimed chunk', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_race' })], { enforceWorkerLease: true });
  let raced = false;

  const result = await processChunkAbstraction(store.chunks.get('chk_race'), {
    store,
    workerId: 'wkr_old',
    leaseMs: 50,
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async () => {
      if (!raced) {
        raced = true;
        const claimed = store.chunks.get('chk_race');
        store.chunks.set('chk_race', {
          ...claimed,
          abstractionStatus: 'completed',
          abstractionWorkerId: 'wkr_new',
          abstractionLeaseExpiresAt: null,
          abstractionCompletedAt: new Date().toISOString(),
        });
        store.abstracts.set('chk_race', {
          id: 'abs_chk_race',
          jobId: 'job_test_1',
          documentId: 'doc_test_1',
          chunkId: 'chk_race',
          abstractText: 'new worker abstract',
          status: 'completed',
        });
      }
      return { text: cleanAbstract('stale worker abstract'), model: 'gemini-2.5-flash', usage: {} };
    },
    maxAttempts: 1,
  });

  assert(result.status === 'stale', `Expected stale writer to be skipped, got ${result.status}`);
  assert(store.abstracts.get('chk_race').abstractText === 'new worker abstract', 'Expected newer abstract to remain intact');
});

test('Phase 4: completed chunks are not reprocessed when /abstraction/process runs again', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_done', abstractionStatus: 'completed' }),
    makeChunk({ id: 'chk_pending', chunkOrder: 1, abstractionStatus: 'pending' }),
  ]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.saveDocumentAbstract({
    jobId: 'job_test_1',
    documentId: 'doc_test_1',
    chunkId: 'chk_done',
    abstractText: 'preserved',
    modelUsed: 'gemini-2.5-flash',
    payloadBytes: 100,
    latencyMs: 10,
    inputTokens: null,
    outputTokens: null,
    status: 'completed',
    attemptCount: 1,
  });
  let modelCalls = 0;
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => {
    modelCalls += 1;
    return { text: cleanAbstract('New abstract.', 2), model: 'gemini-2.5-flash', usage: {} };
  };

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/process'), res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(modelCalls === 1, `Expected one model call (only pending chunk), got ${modelCalls}`);
  const preserved = store.abstracts.get('chk_done');
  assert(preserved.abstractText === 'preserved', 'Expected existing completed abstract preserved');
});

test('Phase 4: failed chunks can be retried via /retry-failed', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_failed', abstractionStatus: 'failed', abstractionAttempts: 3, abstractionErrorType: 'provider_error' }),
  ]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  let modelCalls = 0;
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({ bytes: Buffer.from('%PDF'), mediaType: chunk.mediaType });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => {
    modelCalls += 1;
    return { text: cleanAbstract('Retried.'), model: 'gemini-2.5-flash', usage: {} };
  };

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/retry-failed'), res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.reset === 1, `Expected one chunk reset, got ${res.body.reset}`);
  assert(!getBackgroundPromise('job_test_1'), 'Expected retry route not to schedule in-request background work');
  await processAbstractionBatch('job_test_1', { store });
  assert(modelCalls === 1, `Expected one retry call, got ${modelCalls}`);
  const chunk = store.chunks.get('chk_failed');
  assert(chunk.abstractionStatus === 'completed', `Expected chunk completed after retry, got ${chunk.abstractionStatus}`);
});

test('Phase 4: stale processing chunks are requeued by resetStaleProcessingChunks', async () => {
  const longAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const expiredLease = new Date(Date.now() - 1000).toISOString();
  const store = createMemoryPhase3Store([
    makeChunk({
      id: 'chk_stale',
      abstractionStatus: 'processing',
      abstractionWorkerId: 'wkr_dead',
      abstractionClaimedAt: longAgo,
      abstractionLeaseExpiresAt: expiredLease,
    }),
  ]);
  store.chunks.set('chk_stale', { ...store.chunks.get('chk_stale'), updatedAt: longAgo });

  await store.resetStaleProcessingChunks('job_test_1', 60_000);
  const chunk = store.chunks.get('chk_stale');
  assert(chunk.abstractionStatus === 'pending', `Expected requeued, got ${chunk.abstractionStatus}`);
  assert(chunk.abstractionLeaseExpiresAt === null, 'Expected lease cleared after requeue');
});

test('Phase 4: 504 timeout still splits PDF chunks into smaller children', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_big', pageStart: 1, pageEnd: 4, sizeBytes: 1_200_000 }),
  ]);
  let splitCalls = 0;
  const expectedChildChecksums = new Map();
  store.createSplitChunk = async (jobId, documentId, input) => {
    splitCalls += 1;
    assert(input.checksumSha256 === expectedChildChecksums.get(input.originalFilename), 'Expected split child checksum to match child PDF bytes');
    assert(input.checksumSha256 !== store.chunks.get('chk_big').checksumSha256, 'Expected child checksum not to reuse parent checksum');
    const childId = `chk_split_${splitCalls}`;
    const child = {
      ...makeChunk({
        id: childId,
        chunkOrder: 0,
        originalFilename: input.originalFilename,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        sizeBytes: input.sizeBytes,
      }),
      abstractionStatus: 'pending',
      uploadStatus: 'uploaded',
      blobKey: input.blobKey,
      blobUrl: input.blobUrl,
    };
    store.chunks.set(childId, child);
    return child;
  };
  store.markChunkAbstractionSplitSuperseded = async (jobId, chunkId, reason) => {
    const chunk = store.chunks.get(chunkId);
    store.chunks.set(chunkId, { ...chunk, abstractionStatus: 'split_superseded', abstractionErrorType: reason });
    return chunk;
  };

  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_BLOB_WRITER__ = async (parent, name, bytes) => {
    expectedChildChecksums.set(name, createHash('sha256').update(bytes).digest('hex'));
    return {
      blobKey: `jobs/${parent.jobId}/chunks/${parent.id}/${name}`,
      blobUrl: `gs://titlework-test/jobs/${parent.jobId}/chunks/${parent.id}/${name}`,
    };
  };

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage([200, 200]);
  const pdfBytes = Buffer.from(await pdf.save());

  let calls = 0;
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({ bytes: pdfBytes, mediaType: 'application/pdf' });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => {
    calls += 1;
    if (calls === 1) {
      const err = new Error('timeout');
      err.status = 504;
      throw err;
    }
    return { text: cleanAbstract('Split child abstract.'), model: 'gemini-2.5-flash', usage: {} };
  };

  const result = await processAbstractionBatch('job_test_1', {
    store,
    batchLimit: 4,
    concurrency: 1,
    budgetMs: 5000,
    maxAttempts: 1,
  });

  assert(splitCalls === 2, `Expected two children created from split, got ${splitCalls}`);
  const parent = store.chunks.get('chk_big');
  assert(parent.abstractionStatus === 'split_superseded', `Expected parent superseded, got ${parent.abstractionStatus}`);
  assert(result.splitsInBatch >= 1 || result.completed >= 0, 'Expected split or completion accounted in batch');
});

test('Phase 4: 504 timeout splits whole PDFs even when page range metadata is missing', async () => {
  const wholeChunk = {
    ...makeChunk({ id: 'chk_whole_big', sizeBytes: 1_200_000 }),
    pageStart: null,
    pageEnd: null,
  };
  const store = createMemoryPhase3Store([wholeChunk]);
  let splitCalls = 0;
  store.createSplitChunk = async (jobId, documentId, input) => {
    splitCalls += 1;
    const childId = `chk_whole_split_${splitCalls}`;
    const child = {
      ...makeChunk({
        id: childId,
        chunkOrder: input.chunkOrder,
        originalFilename: input.originalFilename,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        sizeBytes: input.sizeBytes,
      }),
      abstractionStatus: 'pending',
      uploadStatus: 'uploaded',
      blobKey: input.blobKey,
      blobUrl: input.blobUrl,
      splitFrom: input.splitFrom,
      splitParentChunkId: input.splitParentChunkId,
      splitReason: input.splitReason,
    };
    store.chunks.set(childId, child);
    return child;
  };
  store.markChunkAbstractionSplitSuperseded = async (jobId, chunkId, reason) => {
    const chunk = store.chunks.get(chunkId);
    store.chunks.set(chunkId, { ...chunk, abstractionStatus: 'split_superseded', abstractionErrorType: reason });
    return store.chunks.get(chunkId);
  };

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage([200, 200]);
  const pdfBytes = Buffer.from(await pdf.save());

  await processChunkAbstraction(wholeChunk, {
    store,
    blobLoader: async chunk => ({ bytes: pdfBytes, mediaType: chunk.mediaType }),
    blobWriter: async (parent, name) => ({
      blobKey: `jobs/${parent.jobId}/chunks/${parent.id}/${name}`,
      blobUrl: `gs://titlework-test/jobs/${parent.jobId}/chunks/${parent.id}/${name}`,
    }),
    modelClient: async () => {
      const err = new Error('timeout');
      err.status = 504;
      throw err;
    },
    maxAttempts: 1,
  });

  assert(splitCalls === 2, `Expected two inferred-range children, got ${splitCalls}`);
  const parent = store.chunks.get('chk_whole_big');
  const children = [...store.chunks.values()].filter(chunk => chunk.splitParentChunkId === 'chk_whole_big');
  assert(parent.abstractionStatus === 'split_superseded', `Expected parent superseded, got ${parent.abstractionStatus}`);
  assert(children.map(child => `${child.pageStart}-${child.pageEnd}`).join(',') === '1-2,2-4', 'Expected inferred child page ranges 1-2 and 2-4 with 1-page overlap');
});

test('Phase 4: single-page oversized PDFs fail instead of split', async () => {
  const wholeChunk = {
    ...makeChunk({ id: 'chk_single_page_big', sizeBytes: 1_200_000 }),
    pageStart: null,
    pageEnd: null,
  };
  const store = createMemoryPhase3Store([wholeChunk]);
  let splitCalls = 0;
  store.createSplitChunk = async () => {
    splitCalls += 1;
    return null;
  };

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]);
  const pdfBytes = Buffer.from(await pdf.save());

  const result = await processChunkAbstraction(wholeChunk, {
    store,
    blobLoader: async chunk => ({ bytes: pdfBytes, mediaType: chunk.mediaType }),
    modelClient: async () => {
      const err = new Error('timeout');
      err.status = 504;
      throw err;
    },
    maxAttempts: 1,
  });

  const parent = store.chunks.get('chk_single_page_big');
  assert(result.status === 'failed', `Expected terminal failed status, got ${result.status}`);
  assert(splitCalls === 0, `Expected no split children for single-page PDF, got ${splitCalls}`);
  assert(parent.abstractionStatus === 'failed', `Expected parent failed, got ${parent.abstractionStatus}`);
  assert(parent.abstractionErrorType === 'upstream_timeout', `Expected upstream_timeout, got ${parent.abstractionErrorType}`);
});

test('Phase 4: job progress rolls up correctly across pending/processing/completed/failed', async () => {
  const previousBatch = process.env.ABSTRACTION_BATCH_ENABLED;
  process.env.ABSTRACTION_BATCH_ENABLED = 'false';
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_a', chunkOrder: 0 }),
    makeChunk({ id: 'chk_b', chunkOrder: 1 }),
    makeChunk({ id: 'chk_c', chunkOrder: 2 }),
  ]);
  let calls = 0;
  await processAbstractionBatch('job_test_1', {
    store,
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async () => {
      calls += 1;
      if (calls === 2) {
        const err = new Error('boom');
        err.status = 400;
        throw err;
      }
      return { text: cleanAbstract('ok.'), model: 'gemini-2.5-flash', usage: {} };
    },
    batchLimit: 5,
    concurrency: 1,
    budgetMs: 5000,
    maxAttempts: 1,
  });
  const job = await store.getJob('job_test_1');
  const status = await store.getAbstractionStatus('job_test_1');
  assert(status.completed === 2, `Expected 2 completed, got ${status.completed}`);
  assert(status.failed === 1, `Expected 1 failed, got ${status.failed}`);
  assert(job.status === 'partial_failed', `Expected partial_failed rollup, got ${job.status}`);
  if (previousBatch === undefined) delete process.env.ABSTRACTION_BATCH_ENABLED;
  else process.env.ABSTRACTION_BATCH_ENABLED = previousBatch;
});

test('abstraction rollup does not regress a complete job back to synthesizing', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_done', chunkOrder: 0, abstractionStatus: 'completed' }),
  ]);
  await store.updateJob('job_test_1', { status: 'complete', currentPhase: 'complete' });
  await store.refreshAbstractionRollup('job_test_1');
  const job = await store.getJob('job_test_1');
  assert(job.status === 'complete', `Expected complete status to be preserved, got ${job.status}`);
});

test('SQL abstraction rollup preserves complete jobs that have no remaining chunk work', () => {
  const jobsSource = readFileSync(join(root, 'api/_lib/jobs.js'), 'utf8');
  const fnStart = jobsSource.indexOf('async function refreshAbstractionCounts');
  assert(fnStart >= 0, 'Expected refreshAbstractionCounts');
  const fnBody = jobsSource.slice(fnStart, fnStart + 4500);
  assert(
    fnBody.includes("WHEN status = 'complete'") && fnBody.includes("THEN 'complete'"),
    'Expected SQL rollup to keep complete jobs complete when no chunk work remains',
  );
});

test('Phase 4: cancel fails pending chunks so canceled jobs leave the worker queue', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_one', chunkOrder: 0, abstractionStatus: 'pending' }),
    makeChunk({ id: 'chk_two', chunkOrder: 1, abstractionStatus: 'retry_wait', abstractionRetryAt: new Date(Date.now() + 60_000).toISOString() }),
    makeChunk({ id: 'chk_three', chunkOrder: 2, abstractionStatus: 'processing', abstractionWorkerId: 'wkr_live' }),
  ]);
  await store.cancelJob('job_test_1', 'test cancel');
  const chunks = await store.listChunks('job_test_1');
  for (const chunk of chunks) {
    assert(chunk.abstractionStatus === 'failed', `Expected canceled chunk ${chunk.id} to be failed`);
    assert(chunk.abstractionErrorType === 'canceled', `Expected canceled error type on ${chunk.id}`);
  }
});

test('Phase 4: cancellation stops future chunk processing', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_one', chunkOrder: 0 }),
    makeChunk({ id: 'chk_two', chunkOrder: 1 }),
  ]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.cancelJob('job_test_1', 'test cancel');

  let modelCalls = 0;
  const result = await processAbstractionBatch('job_test_1', {
    store,
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async () => {
      modelCalls += 1;
      return { text: 'DOCUMENT #1:\nshould not run.', model: 'gemini-2.5-flash', usage: {} };
    },
    batchLimit: 5,
    concurrency: 1,
    budgetMs: 5000,
  });
  assert(modelCalls === 0, `Expected zero model calls after cancel, got ${modelCalls}`);
  assert(result.completedInBatch === 0, 'Expected no completions after cancel');
  const job = await store.getJob('job_test_1');
  assert(job.status === 'canceled', 'Expected job to remain canceled');
});

test('Phase 4: POST /api/jobs/:id/cancel marks job canceled and is idempotent', async () => {
  const store = createMemoryPhase3Store([makeChunk()]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;

  const res1 = mockRes();
  await jobsRouteHandler(mockReq('POST', { reason: 'user' }, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/cancel'), res1);
  assert(res1.statusCode === 200, `Expected 200, got ${res1.statusCode}`);
  assert(res1.body.job.status === 'canceled', 'Expected canceled status');
  assert(res1.body.alreadyCanceled === false, 'Expected first cancel reports alreadyCanceled false');

  const res2 = mockRes();
  await jobsRouteHandler(mockReq('POST', { reason: 'user' }, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/cancel'), res2);
  assert(res2.statusCode === 200, `Expected 200 on second cancel, got ${res2.statusCode}`);
  assert(res2.body.alreadyCanceled === true, 'Expected second cancel reports alreadyCanceled true');
});

test('Phase 4: starting a canceled job returns 409', async () => {
  const store = createMemoryPhase3Store([makeChunk()]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.cancelJob('job_test_1', 'test');

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/start'), res);
  assert(res.statusCode === 409, `Expected 409 for canceled job, got ${res.statusCode}`);
});

test('Phase 4: rate_limit error schedules retry_wait instead of failing immediately', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_rate' })]);
  let calls = 0;
  await processAbstractionBatch('job_test_1', {
    store,
    blobLoader: async chunk => ({ bytes: Buffer.from('%PDF'), mediaType: chunk.mediaType }),
    modelClient: async () => {
      calls += 1;
      const err = new Error('rate limit hit');
      err.status = 429;
      throw err;
    },
    batchLimit: 1,
    concurrency: 1,
    budgetMs: 200,
    maxAttempts: 3,
  });
  const chunk = store.chunks.get('chk_rate');
  assert(calls === 1, `Expected one model call before durable retry_wait, got ${calls}`);
  assert(chunk.abstractionStatus === 'retry_wait', `Expected retry_wait, got ${chunk.abstractionStatus}`);
  assert(chunk.abstractionRetryAt, 'Expected retryAt scheduled');
  assert(chunk.abstractionErrorType === 'rate_limit', 'Expected rate_limit error type recorded');
});

test('Phase 4: default storage loader rejects oversized content before reading object bytes', async () => {
  let buffered = false;
  globalThis.__TITLE_ANALYZER_OBJECT_READER__ = async () => {
    buffered = true;
    return { bytes: Buffer.alloc(0), mediaType: 'application/pdf' };
  };

  let rejected = false;
  try {
    await defaultBlobLoader(makeChunk({ id: 'chk_large', sizeBytes: 49_000_000 }));
  } catch (err) {
    rejected = /too large/i.test(err.message);
  }
  delete globalThis.__TITLE_ANALYZER_OBJECT_READER__;

  assert(rejected, 'Expected oversized object to be rejected');
  assert(buffered === false, 'Expected oversized object rejection before reading bytes');
});

test('Phase 4: default storage loader allows splittable PDFs up to the split recovery cap', async () => {
  let read = false;
  globalThis.__TITLE_ANALYZER_OBJECT_READER__ = async chunk => {
    read = true;
    return { bytes: Buffer.from('%PDF'), mediaType: chunk.mediaType };
  };

  const payload = await defaultBlobLoader(makeChunk({
    id: 'chk_split_candidate',
    sizeBytes: 10_000_000,
    pageStart: 1,
    pageEnd: 4,
  }));
  delete globalThis.__TITLE_ANALYZER_OBJECT_READER__;

  assert(read, 'Expected splittable PDF object to be read for split recovery');
  assert(payload.mediaType === 'application/pdf', 'Expected PDF media type preserved');
});

test('Phase 4: default storage loader allows whole PDFs without ranges for split recovery', async () => {
  let read = false;
  globalThis.__TITLE_ANALYZER_OBJECT_READER__ = async chunk => {
    read = true;
    return { bytes: Buffer.from('%PDF'), mediaType: chunk.mediaType };
  };

  const legacyWholePdf = {
    ...makeChunk({
      id: 'chk_whole_split_candidate',
      sizeBytes: 10_000_000,
    }),
    pageStart: null,
    pageEnd: null,
  };
  const payload = await defaultBlobLoader(legacyWholePdf);
  delete globalThis.__TITLE_ANALYZER_OBJECT_READER__;

  assert(read, 'Expected whole PDF object to be read for split recovery');
  assert(payload.mediaType === 'application/pdf', 'Expected PDF media type preserved');
});

test('Phase 4: abstraction progress labels re-segmenting oversized PDFs', () => {
  const jobsSource = readFileSync(join(root, 'api/_lib/jobs.js'), 'utf8');
  assert(jobsSource.includes('Re-segmenting oversized PDF for model limits'), 'Expected split recovery progress label');
  assert(jobsSource.includes("abstraction_status = 'split_superseded'"), 'Expected progress label to detect superseded split parents');
});

test('Phase 4: saving an abstract invalidates synthesis only when abstract text changes', () => {
  const jobsSource = readFileSync(join(root, 'api/_lib/jobs.js'), 'utf8');
  assert(jobsSource.includes('abstractChanged'), 'saveDocumentAbstract should detect abstract changes');
  assert(jobsSource.includes('preserveSynthesisPlan'), 'saveDocumentAbstract should support preserving synthesis plan');
  assert(jobsSource.includes('synthesis_plan_id = NULL'), 'saveDocumentAbstract should clear stale synthesis_plan_id when changed');
});

test('processChunkAbstraction reuses peer abstract with matching fingerprint without model call', async () => {
  const donor = makeChunk({
    id: 'chk_donor',
    chunkOrder: 0,
    fingerprint: 'same-file-fp',
    abstractionStatus: 'completed',
  });
  const target = makeChunk({
    id: 'chk_target',
    chunkOrder: 1,
    fingerprint: 'same-file-fp',
    abstractionStatus: 'pending',
  });
  const store = createMemoryPhase3Store([donor, target]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.saveDocumentAbstract({
    jobId: 'job_test_1',
    documentId: 'doc_test_1',
    chunkId: 'chk_donor',
    abstractText: 'Reusable abstract body.',
    modelUsed: 'gemini-2.5-flash',
    payloadBytes: 0,
    latencyMs: 1,
    inputTokens: 0,
    outputTokens: 0,
    status: 'completed',
    attemptCount: 1,
  });
  let modelCalls = 0;
  let blobLoads = 0;
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async () => {
    blobLoads += 1;
    return { bytes: Buffer.from('%PDF'), mediaType: 'application/pdf' };
  };
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => {
    modelCalls += 1;
    return { text: 'DOCUMENT #2:\nShould not run.', model: 'gemini-2.5-flash', usage: {} };
  };
  const result = await processChunkAbstraction(target, { store, workerId: 'wkr_reuse' });
  assert(result.status === 'completed', `Expected completed reuse, got ${result.status}`);
  assert(result.reused === true, 'Expected reused flag');
  assert(modelCalls === 0, `Expected zero model calls, got ${modelCalls}`);
  assert(blobLoads === 0, `Expected zero blob loads on reuse, got ${blobLoads}`);
  assert(store.abstracts.get('chk_target').abstractText.includes('Reusable abstract'), 'Expected copied abstract on target chunk');
});

test('processChunkAbstraction escalates flagged abstracts to Sonnet and saves the escalated result', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_flagged' })]);
  const models = [];
  const result = await processChunkAbstraction(store.chunks.get('chk_flagged'), {
    store,
    workerId: 'wkr_escalate',
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async request => {
      models.push(request.model);
      if (request.model === 'claude-sonnet-5-5') {
        return {
          text: 'DOCUMENT #1:\nDOC TYPE: Warranty Deed\nCONFIDENCE: Sonnet verified the illegible text and low-confidence fields.',
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 20, output_tokens: 30 },
        };
      }
      return {
        text: 'DOCUMENT #1:\nDOC TYPE: Warranty Deed\nISSUES: ILLEGIBLE - VERIFY MANUALLY\nCONFIDENCE: low',
        model: 'gemini-2.5-flash',
        usage: { input_tokens: 10, output_tokens: 15 },
      };
    },
  });

  const saved = store.abstracts.get('chk_flagged');
  assert(result.status === 'completed', `Expected completed escalation, got ${result.status}`);
  assert(models.join(',') === 'gemini-3.1-flash-lite,claude-sonnet-5-5', `Expected Gemini Flash Lite then Sonnet 5.5, got ${models.join(',')}`);
  assert(saved.modelUsed === 'claude-sonnet-5-5', `Expected Sonnet 5.5 saved, got ${saved.modelUsed}`);
  assert(saved.abstractText.includes('Sonnet verified'), 'Expected escalated abstract text saved');
  assert(saved.inputTokens === 30 && saved.outputTokens === 45, 'Expected token usage summed across Gemini Flash Lite and Sonnet calls');
});

test('processChunkAbstraction stops before the escalation call when its lease was taken, and marks nothing', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_lease_lost' })]);
  const models = [];
  const result = await processChunkAbstraction(store.chunks.get('chk_lease_lost'), {
    store,
    workerId: 'wkr_first',
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async request => {
      models.push(request.model);
      // Another worker takes the chunk while the first call is in flight.
      store.chunks.set('chk_lease_lost', {
        ...store.chunks.get('chk_lease_lost'),
        abstractionWorkerId: 'wkr_thief',
        abstractionLeaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
      });
      return {
        text: 'DOCUMENT #1:\nDOC TYPE: Warranty Deed\nISSUES: ILLEGIBLE - VERIFY MANUALLY\nCONFIDENCE: low',
        model: 'gemini-3.1-flash-lite',
        usage: { input_tokens: 10, output_tokens: 15 },
      };
    },
  });
  const row = store.chunks.get('chk_lease_lost');
  assert(result.status === 'stale', `Expected stale, got ${result.status}`);
  assert(models.length === 1, `Escalation must not be paid after the lease is lost, got ${models.join(',')}`);
  assert(row.abstractionStatus === 'processing' && row.abstractionWorkerId === 'wkr_thief', `New owner's row must be untouched, got ${row.abstractionStatus}/${row.abstractionWorkerId}`);
  assert(!store.abstracts.has('chk_lease_lost'), 'No abstract may be saved');
});

test('processChunkAbstraction renews its own lease before each paid call (primary and escalation)', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_renew_each' })]);
  let renewals = 0;
  const renewMs = [];
  const renew = store.renewChunkAbstractionLease;
  store.renewChunkAbstractionLease = async (...args) => { renewals += 1; renewMs.push(args[2].leaseMs); return renew(...args); };
  const result = await processChunkAbstraction(store.chunks.get('chk_renew_each'), {
    store,
    workerId: 'wkr_renew',
    leaseMs: 1000,
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async request => ({
      text: request.model === 'claude-sonnet-5-5'
        ? 'DOCUMENT #1:\nDOC TYPE: Warranty Deed\nCONFIDENCE: Sonnet verified.'
        : 'DOCUMENT #1:\nDOC TYPE: Warranty Deed\nISSUES: ILLEGIBLE - VERIFY MANUALLY\nCONFIDENCE: low',
      model: request.model,
      usage: { input_tokens: 10, output_tokens: 15 },
    }),
  });
  assert(result.status === 'completed', `Expected completed, got ${result.status}`);
  assert(renewals === 2, `Expected one renewal per paid call (2), got ${renewals}`);
  assert(renewMs.every(ms => ms >= 300_000), `Renewal must cover upstream timeout + 60s, not the 1s claim lease, got ${renewMs}`);
});

test('processChunkAbstraction delegates renewal to chunkLeaseGuard without duplicate singular renewal', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_delegate_guard' })]);
  let singularRenewals = 0;
  const origRenew = store.renewChunkAbstractionLease;
  store.renewChunkAbstractionLease = async (...args) => { singularRenewals += 1; return origRenew(...args); };
  const guardArgs = [];
  const result = await processChunkAbstraction(store.chunks.get('chk_delegate_guard'), {
    store,
    workerId: 'wkr_guard',
    leaseMs: 1000,
    chunkLeaseGuard: async (chunk, ms) => {
      guardArgs.push({ id: chunk.id, ms });
      return 'renewed';
    },
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async () => ({
      text: cleanAbstract('Clear.'),
      model: 'gemini-3.1-flash-lite',
      usage: { input_tokens: 10, output_tokens: 15 },
    }),
  });
  assert(result.status === 'completed', `Expected completed, got ${result.status}`);
  assert(guardArgs.length === 1 && guardArgs[0].id === 'chk_delegate_guard' && guardArgs[0].ms >= 300_000, `Expected chunkLeaseGuard called with chunk and call leaseMs, got ${JSON.stringify(guardArgs)}`);
  assert(singularRenewals === 0, `Expected 0 singular renewals when chunkLeaseGuard returns outcome, got ${singularRenewals}`);

  const lostStore = createMemoryPhase3Store([makeChunk({ id: 'chk_delegate_lost' })]);
  let calls = 0;
  const lostResult = await processChunkAbstraction(lostStore.chunks.get('chk_delegate_lost'), {
    store: lostStore,
    workerId: 'wkr_guard',
    chunkLeaseGuard: async () => 'lost',
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async () => { calls += 1; return { text: 'should not pay', model: 'gemini-3.1-flash-lite', usage: {} }; },
  });
  assert(lostResult.status === 'stale' && calls === 0, `Expected stale with 0 paid calls, got ${lostResult.status}/${calls}`);
});

test('processChunkAbstraction keeps clean Gemini abstracts on the cheap path', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_clean' })]);
  const models = [];
  await processChunkAbstraction(store.chunks.get('chk_clean'), {
    store,
    workerId: 'wkr_clean',
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async request => {
      models.push(request.model);
      return {
        text: cleanAbstract('Clear, single-instrument abstract.'),
        model: 'gemini-2.5-flash',
        usage: { input_tokens: 10, output_tokens: 15 },
      };
    },
  });

  const saved = store.abstracts.get('chk_clean');
  assert(models.join(',') === 'gemini-3.1-flash-lite', `Expected only Gemini Flash Lite, got ${models.join(',')}`);
  assert(saved.modelUsed === 'gemini-2.5-flash', `Expected Gemini Flash saved, got ${saved.modelUsed}`);
});

test('processChunkAbstraction fails a max_tokens abstract instead of saving it as completed', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_truncated' })]);
  const models = [];
  const result = await processChunkAbstraction(store.chunks.get('chk_truncated'), {
    store,
    workerId: 'wkr_truncated',
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async request => {
      models.push(request.model);
      return {
        text: 'DOC TYPE: Mineral Deed\nGRANTOR: A\nINTEREST CONVEYED: an undivided 1/',
        model: request.model,
        usage: { input_tokens: 10, output_tokens: request.maxTokens },
        stopReason: 'max_tokens',
      };
    },
  });

  assert(result.status === 'failed', `Expected failed, got ${result.status}`);
  assert(result.failure.errorType === 'output_truncated', `Expected output_truncated, got ${result.failure.errorType}`);
  assert(!store.abstracts.has('chk_truncated'), 'A truncated abstract must not be saved');
  assert(store.chunks.get('chk_truncated').abstractionStatus === 'failed', 'Chunk must be failed, not completed');
  assert(models.join(',') === 'gemini-3.1-flash-lite,claude-sonnet-5-5', `Expected one escalation attempt, got ${models.join(',')}`);
});

test('processChunkAbstraction fails a truncated abstract when the escalation call errors', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_truncated_escalation_error' })]);
  const result = await processChunkAbstraction(store.chunks.get('chk_truncated_escalation_error'), {
    store,
    workerId: 'wkr_truncated',
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async request => {
      if (request.model === 'claude-sonnet-5-5') throw new Error('escalation provider down');
      return { text: 'DOC TYPE: Mineral Deed\nINTEREST CONVEYED: an undivided 1/', model: request.model, usage: { output_tokens: request.maxTokens }, stopReason: 'max_tokens' };
    },
  });

  assert(result.status === 'failed' && result.failure.errorType === 'output_truncated', `Expected output_truncated failure, got ${result.status}/${result.failure?.errorType}`);
  assert(!store.abstracts.has('chk_truncated_escalation_error'), 'A truncated abstract must not be saved');
});

test('processChunkAbstraction keeps a finished escalation after a truncated first abstract', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_truncated_recovered' })]);
  const result = await processChunkAbstraction(store.chunks.get('chk_truncated_recovered'), {
    store,
    workerId: 'wkr_truncated',
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async request => (request.model === 'claude-sonnet-5-5'
      ? { text: 'DOC TYPE: Mineral Deed\nINTEREST CONVEYED: an undivided 1/2 mineral interest', model: request.model, usage: { output_tokens: 40 }, stopReason: 'end_turn' }
      : { text: 'DOC TYPE: Mineral Deed\nINTEREST CONVEYED: an undivided 1/', model: request.model, usage: { output_tokens: request.maxTokens }, stopReason: 'max_tokens' }),
  });

  assert(result.status === 'completed', `Expected completed, got ${result.status}`);
  assert(store.abstracts.get('chk_truncated_recovered').abstractText.endsWith('1/2 mineral interest'), 'Expected the finished escalated abstract');
});

test('processChunkAbstraction splits a truncated multi-page PDF instead of failing it', async () => {
  const chunk = makeChunk({ id: 'chk_truncated_pdf', pageStart: 1, pageEnd: 4 });
  const store = createMemoryPhase3Store([chunk]);
  let splitCalls = 0;
  store.createSplitChunk = async (jobId, documentId, input) => {
    splitCalls += 1;
    const child = { ...makeChunk({ id: `chk_truncated_pdf_${splitCalls}`, chunkOrder: input.chunkOrder, pageStart: input.pageStart, pageEnd: input.pageEnd }), splitParentChunkId: input.splitParentChunkId };
    store.chunks.set(child.id, child);
    return child;
  };
  store.markChunkAbstractionSplitSuperseded = async (jobId, chunkId, reason) => {
    store.chunks.set(chunkId, { ...store.chunks.get(chunkId), abstractionStatus: 'split_superseded', abstractionErrorType: reason });
    return store.chunks.get(chunkId);
  };
  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage([200, 200]);
  const pdfBytes = Buffer.from(await pdf.save());

  const result = await processChunkAbstraction(chunk, {
    store,
    escalationEnabled: false,
    blobLoader: async () => ({ bytes: pdfBytes, mediaType: 'application/pdf' }),
    blobWriter: async (parent, name) => ({ blobKey: `jobs/${parent.jobId}/chunks/${parent.id}/${name}`, blobUrl: `gs://titlework-test/jobs/${parent.jobId}/chunks/${parent.id}/${name}` }),
    modelClient: async request => ({ text: 'DOC TYPE: Mineral Deed\nINTEREST CONVEYED: an undivided 1/', model: request.model, usage: {}, stopReason: 'max_tokens' }),
  });

  assert(result.status === 'split_superseded', `Expected split_superseded, got ${result.status}`);
  assert(splitCalls === 2, `Expected two page-range children, got ${splitCalls}`);
  assert(store.chunks.get('chk_truncated_pdf').abstractionErrorType === 'output_truncated', 'Expected the split reason to record truncation');
  assert(!store.abstracts.has('chk_truncated_pdf'), 'A truncated abstract must not be saved');
});

test('Phase 4: setup error when queue env not configured returns 503 with fallback hint', async () => {
  const previousBucket = process.env.GCS_BUCKET;
  const previousApi = process.env.ANTHROPIC_API_KEY;
  const previousGemini = process.env.GEMINI_API_KEY;
  delete process.env.GCS_BUCKET;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete globalThis.__TITLE_ANALYZER_BLOB_LOADER__;
  delete globalThis.__TITLE_ANALYZER_MODEL_CLIENT__;
  const store = createMemoryPhase3Store([makeChunk()]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/start'), res);
  assert(res.statusCode === 503, `Expected 503 when queue env missing, got ${res.statusCode}`);
  assert(res.body.fallback === 'browser_abstraction', 'Expected fallback hint for frontend');

  if (previousBucket) process.env.GCS_BUCKET = previousBucket;
  if (previousApi) process.env.ANTHROPIC_API_KEY = previousApi;
  if (previousGemini) process.env.GEMINI_API_KEY = previousGemini;
});

test('Phase 4: WORKFLOW_DRIVER=inngest without keys returns 503 setup error', async () => {
  process.env.WORKFLOW_DRIVER = 'inngest';
  const store = createMemoryPhase3Store([makeChunk()]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({ bytes: Buffer.from('%PDF'), mediaType: chunk.mediaType });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => ({ text: 'DOCUMENT #1:\nok.', model: 'gemini-2.5-flash', usage: {} });

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/start'), res);
  assert(res.statusCode === 503, `Expected 503 for unconfigured Inngest driver, got ${res.statusCode}`);
  assert(/INNGEST/.test(res.body.error || ''), `Expected Inngest setup error message, got ${res.body.error}`);

  delete process.env.WORKFLOW_DRIVER;
});

test('Bug fix: split child checksumSha256 matches child PDF bytes', async () => {
  const wholeChunk = {
    ...makeChunk({ id: 'chk_cs_parent', sizeBytes: 1_200_000, checksumSha256: 'a'.repeat(64) }),
    pageStart: null,
    pageEnd: null,
  };
  const store = createMemoryPhase3Store([wholeChunk]);
  const createdChildren = [];
  store.createSplitChunk = async (jobId, documentId, input) => {
    createdChildren.push(input);
    const childId = `chk_cs_child_${createdChildren.length}`;
    const child = {
      ...makeChunk({ id: childId, pageStart: input.pageStart, pageEnd: input.pageEnd }),
      abstractionStatus: 'pending',
      uploadStatus: 'uploaded',
      blobKey: input.blobKey,
      blobUrl: input.blobUrl,
      splitParentChunkId: input.splitParentChunkId,
    };
    store.chunks.set(childId, child);
    return child;
  };
  store.markChunkAbstractionSplitSuperseded = async (jobId, chunkId) => {
    const chunk = store.chunks.get(chunkId);
    store.chunks.set(chunkId, { ...chunk, abstractionStatus: 'split_superseded' });
    return store.chunks.get(chunkId);
  };

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage([200, 200]);
  const pdfBytes = Buffer.from(await pdf.save());

  await processChunkAbstraction(wholeChunk, {
    store,
    blobLoader: async () => ({ bytes: pdfBytes, mediaType: 'application/pdf' }),
    blobWriter: async (parent, name, bytes) => ({
      blobKey: `jobs/${parent.jobId}/chunks/${parent.id}/${name}`,
      blobUrl: `gs://test/jobs/${parent.jobId}/chunks/${parent.id}/${name}`,
      childBytes: bytes,
    }),
    modelClient: async () => { const e = new Error('timeout'); e.status = 504; throw e; },
    maxAttempts: 1,
  });

  assert(createdChildren.length === 2, `Expected two split children, got ${createdChildren.length}`);
  for (const child of createdChildren) {
    assert(typeof child.checksumSha256 === 'string' && child.checksumSha256.length === 64, 'Expected split child checksumSha256 to be a SHA-256 hex string');
    assert(child.checksumSha256 !== wholeChunk.checksumSha256, 'Expected child checksum not to reuse parent checksum');
  }
});

test('Bug fix: partial PDF split marks created children failed when supersede fails', async () => {
  const wholeChunk = {
    ...makeChunk({ id: 'chk_partial_split', sizeBytes: 1_200_000 }),
    pageStart: 1,
    pageEnd: 4,
  };
  const store = createMemoryPhase3Store([wholeChunk]);
  let createCalls = 0;
  store.createSplitChunk = async () => {
    createCalls += 1;
    const childId = `chk_partial_child_${createCalls}`;
    const child = {
      ...makeChunk({ id: childId }),
      abstractionStatus: 'pending',
      uploadStatus: 'uploaded',
      splitParentChunkId: 'chk_partial_split',
    };
    store.chunks.set(childId, child);
    return child;
  };
  store.markChunkAbstractionSplitSuperseded = async () => null;

  const { PDFDocument } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage([200, 200]);
  const pdfBytes = Buffer.from(await pdf.save());

  const result = await processChunkAbstraction(wholeChunk, {
    store,
    blobLoader: async () => ({ bytes: pdfBytes, mediaType: 'application/pdf' }),
    blobWriter: async (parent, name) => ({
      blobKey: `jobs/${parent.jobId}/chunks/${parent.id}/${name}`,
      blobUrl: `gs://test/${name}`,
    }),
    modelClient: async () => { const e = new Error('timeout'); e.status = 504; throw e; },
    maxAttempts: 1,
  });

  assert(createCalls === 2, `Expected two children before supersede failure, got ${createCalls}`);
  assert(result.status === 'failed' || result.status === 'retry_wait', `Expected failure after split supersede miss, got ${result.status}`);
  const failedChildren = [...store.chunks.values()].filter(chunk => chunk.splitParentChunkId === 'chk_partial_split' && chunk.abstractionStatus === 'failed');
  assert(failedChildren.length === 2, `Expected created split children to be marked failed, got ${failedChildren.length}`);
});

test('Phase 4: /abstraction/process drains another batch when /abstraction/start hits its budget', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_x', chunkOrder: 0 }),
    makeChunk({ id: 'chk_y', chunkOrder: 1 }),
    makeChunk({ id: 'chk_z', chunkOrder: 2 }),
  ]);
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => ({
    text: JSON.stringify([cleanAbstract('ok X.', 1), cleanAbstract('ok Y.', 2), cleanAbstract('ok Z.', 3)]),
    model: 'gemini-2.5-flash',
    usage: {},
  });

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/process'), res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.completedInBatch === 3, `Expected three completions in process batch, got ${res.body.completedInBatch}`);
  assert(res.body.hasMore === false, 'Expected no more work after draining batch');
});

test('Priority 6: browser ABSTRACT_PROMPT matches server ABSTRACTION_PROMPT verbatim', () => {
  const match = indexHtml.match(/const ABSTRACT_PROMPT = `([\s\S]*?)`;/);
  assert(match, 'Expected ABSTRACT_PROMPT template literal in public/index.html');
  assert(match[1] === ABSTRACTION_PROMPT, 'Expected browser ABSTRACT_PROMPT to match server ABSTRACTION_PROMPT verbatim');
  assert(!match[1].includes('or "not visible"'), 'Browser prompt must not instruct writing "not visible"');
  assert(match[1].includes('Never write "not visible"'), 'Browser prompt must explicitly forbid "not visible"');
  assert(match[1].includes('ILLEGIBLE - VERIFY MANUALLY'), 'Browser prompt must instruct ILLEGIBLE - VERIFY MANUALLY');
  assert(match[1].includes('"not stated"') && match[1].includes('"unrecorded"'), 'Prompt must separate omitted/unrecorded fields from ILLEGIBLE - VERIFY MANUALLY');
});

test('Priority 6: computePdfSplitRanges and splitPdfChunk add 1-page overlap for >=4 pages without infinite recursion on 2-page PDFs', async () => {
  nodeAssert.deepEqual(
    computePdfSplitRanges(4, 1, 4).map(r => [r.pageStart, r.pageEnd]),
    [[1, 2], [2, 4]],
    'Expected 4-page PDF split with 1-page overlap (1-2, 2-4)',
  );
  nodeAssert.deepEqual(
    computePdfSplitRanges(5, 1, 5).map(r => [r.pageStart, r.pageEnd]),
    [[1, 3], [3, 5]],
    'Expected 5-page PDF split with 1-page overlap (1-3, 3-5)',
  );
  nodeAssert.deepEqual(
    computePdfSplitRanges(3, 1, 3).map(r => [r.pageStart, r.pageEnd]),
    [[1, 2], [3, 3]],
    'Expected 3-page PDF split with zero overlap',
  );
  nodeAssert.deepEqual(
    computePdfSplitRanges(2, 1, 2).map(r => [r.pageStart, r.pageEnd]),
    [[1, 1], [2, 2]],
    'Expected 2-page PDF split with zero overlap',
  );

  const { PDFDocument } = await import('pdf-lib');

  // Verify actual split PDF page counts on a 4-page PDF and grouping order in groupAbstractsByDocument.
  const pdf4 = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf4.addPage([200, 200]);
  const bytes4 = Buffer.from(await pdf4.save());
  const chunk4 = makeChunk({ id: 'chk_overlap_4', pageStart: 1, pageEnd: 4, sizeBytes: bytes4.byteLength });
  const store4 = createMemoryPhase3Store([chunk4]);
  const childPageCounts = [];
  store4.createSplitChunk = async (jobId, documentId, input) => {
    const childId = `chk_overlap_child_${childPageCounts.length + 1}`;
    const child = {
      ...makeChunk({
        id: childId,
        chunkOrder: input.chunkOrder,
        originalFilename: input.originalFilename,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        sizeBytes: input.sizeBytes,
      }),
      abstractionStatus: 'pending',
      uploadStatus: 'uploaded',
      splitParentChunkId: input.splitParentChunkId,
    };
    store4.chunks.set(childId, child);
    return child;
  };
  store4.markChunkAbstractionSplitSuperseded = async (_jobId, chunkId) => {
    const row = store4.chunks.get(chunkId);
    store4.chunks.set(chunkId, { ...row, abstractionStatus: 'split_superseded' });
    return store4.chunks.get(chunkId);
  };
  await processChunkAbstraction(chunk4, {
    store: store4,
    maxAttempts: 1,
    blobLoader: async () => ({ bytes: bytes4, mediaType: 'application/pdf' }),
    blobWriter: async (parent, name, childBytes) => {
      const parsedChild = await PDFDocument.load(childBytes);
      childPageCounts.push(parsedChild.getPageCount());
      return { blobKey: `jobs/${parent.jobId}/${name}`, blobUrl: `gs://test/${name}` };
    },
    modelClient: async () => { const err = new Error('timeout'); err.status = 504; throw err; },
  });
  nodeAssert.deepEqual(childPageCounts, [2, 3], 'Expected 4-page split children to contain 2 and 3 pages due to 1-page overlap');
  const overlapChildren = [...store4.chunks.values()].filter(c => c.splitParentChunkId === 'chk_overlap_4');
  nodeAssert.deepEqual(overlapChildren.map(c => [c.pageStart, c.pageEnd]), [[1, 2], [2, 4]]);

  const grouped = groupAbstractsByDocument([
    { documentId: 'doc_1', chunkId: overlapChildren[1].id, chunkOrder: 0, pageStart: 2, pageEnd: 4, sourceFilename: 'deed.pdf', abstractText: 'Second half with overlap' },
    { documentId: 'doc_1', chunkId: overlapChildren[0].id, chunkOrder: 0, pageStart: 1, pageEnd: 2, sourceFilename: 'deed.pdf', abstractText: 'First half' },
  ]);
  nodeAssert.equal(grouped.length, 1);
  assert(grouped[0].abstract.indexOf('**Pages 1-2:**') < grouped[0].abstract.indexOf('**Pages 2-4:**'), 'Expected overlapping split chunks ordered cleanly by pageStart');

  // Verify 2-page PDF splits into 1-page children which then fail rather than recursing infinitely.
  const pdf2 = await PDFDocument.create();
  pdf2.addPage([200, 200]);
  pdf2.addPage([200, 200]);
  const bytes2 = Buffer.from(await pdf2.save());
  const chunk2 = makeChunk({ id: 'chk_two_page', pageStart: 1, pageEnd: 2, sizeBytes: bytes2.byteLength });
  const store2 = createMemoryPhase3Store([chunk2]);
  const childBytesById = new Map();
  store2.createSplitChunk = async (jobId, documentId, input) => {
    const childId = `chk_two_child_${childBytesById.size + 1}`;
    const child = {
      ...makeChunk({
        id: childId,
        chunkOrder: input.chunkOrder,
        originalFilename: input.originalFilename,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        sizeBytes: input.sizeBytes,
      }),
      abstractionStatus: 'pending',
      uploadStatus: 'uploaded',
      splitParentChunkId: input.splitParentChunkId,
    };
    store2.chunks.set(childId, child);
    return child;
  };
  store2.markChunkAbstractionSplitSuperseded = async (_jobId, chunkId) => {
    const row = store2.chunks.get(chunkId);
    store2.chunks.set(chunkId, { ...row, abstractionStatus: 'split_superseded' });
    return store2.chunks.get(chunkId);
  };
  const twoSplitRes = await processChunkAbstraction(chunk2, {
    store: store2,
    maxAttempts: 1,
    blobLoader: async () => ({ bytes: bytes2, mediaType: 'application/pdf' }),
    blobWriter: async (parent, name, childBytes) => {
      childBytesById.set(name, childBytes);
      return { blobKey: `jobs/${parent.jobId}/${name}`, blobUrl: `gs://test/${name}` };
    },
    modelClient: async () => { const err = new Error('timeout'); err.status = 504; throw err; },
  });
  assert(twoSplitRes.status === 'split_superseded');
  const twoChildren = [...store2.chunks.values()].filter(c => c.splitParentChunkId === 'chk_two_page');
  nodeAssert.deepEqual(twoChildren.map(c => [c.pageStart, c.pageEnd]), [[1, 1], [2, 2]]);
  for (const child of twoChildren) {
    const childRes = await processChunkAbstraction(child, {
      store: store2,
      maxAttempts: 1,
      blobLoader: async c => ({ bytes: childBytesById.get(c.originalFilename), mediaType: 'application/pdf' }),
      modelClient: async () => { const err = new Error('timeout'); err.status = 504; throw err; },
    });
    assert(childRes.status === 'failed', '1-page split child must terminate as failed, never split infinitely');
  }
});

test('Priority 7: multi-page renderedImages bundles build image blocks, stay solo, and skip PDF text/File API paths', async () => {
  const page1 = Buffer.from('page-1-png').toString('base64');
  const page2 = Buffer.from('page-2-jpeg').toString('base64');
  const chunk = {
    ...makeChunk({
      id: 'chk_rendered_bundle',
      originalFilename: 'pathological.pdf',
      mediaType: 'application/pdf',
    }),
    renderedImages: [
      { mediaType: 'image/png', data: page1 },
      { mediaType: 'image/jpeg', data: page2 },
    ],
  };

  assert(chunkRequiresSoloBatch(chunk) === true, 'Rendered image bundle chunk must require solo batching');

  const delivery = await resolveChunkDelivery(chunk, Buffer.from('%PDF-ignored'));
  assert(delivery.mode === 'rendered_images' && delivery.pages.length === 2, 'Expected rendered_images delivery');

  const enriched = await enrichVisualDeliveryForModel(delivery, chunk, Buffer.alloc(5_000_000), 'gemini-3.1-flash-lite');
  assert(enriched === delivery, 'Expected rendered_images delivery to bypass Gemini Files API upload');

  const singleMsg = buildAbstractMessagesForChunk(chunk, null, 0, delivery);
  const imageBlocks = singleMsg[0].content.filter(b => b.type === 'image');
  assert(imageBlocks.length === 2, `Expected 2 image blocks, got ${imageBlocks.length}`);
  assert(!singleMsg[0].content.some(b => b.type === 'document'), 'Rendered bundle must not include PDF document block');
  assert(imageBlocks[0].source.media_type === 'image/png' && imageBlocks[0].source.data === page1);
  assert(imageBlocks[1].source.media_type === 'image/jpeg' && imageBlocks[1].source.data === page2);
  assert(singleMsg[0].content.at(-1).text.includes('pathological.pdf (rendered pages)'));
  assert(singleMsg[0].content.at(-1).text.includes('high-DPI rendered page images'));

  const batchMsg = buildAbstractMessagesForChunks([{ chunk, payloadBytes: null, delivery }], 0);
  assert(batchMsg[0].content.filter(b => b.type === 'image').length === 2);

  const estimated = estimateAbstractPayloadBytes(chunk, null, delivery);
  assert(estimated === page1.length + page2.length + 2000, `Unexpected byte estimate ${estimated}`);
});

async function makeTextPdfBytes(lines, { extraBlankPage = false, scanBytes = 0 } = {}) {
  const { PDFDocument, PDFName, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  lines.forEach((line, i) => page.drawText(line, { x: 36, y: 760 - i * 14, size: 10, font }));
  if (scanBytes > 0) {
    page.node.set(PDFName.of('ScanData'), doc.context.register(doc.context.stream(Buffer.alloc(scanBytes, 65))));
  }
  if (extraBlankPage) {
    doc.addPage([612, 792]);
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function withEnvOverrides(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('Priority 4: text-mode PDF flagged for ILLEGIBLE or deterministic mismatch escalates once with visual PDF bytes', async () => {
  const textPdfBytes = await makeTextPdfBytes([
    'WARRANTY DEED',
    'Grantor: John Smith conveys to Grantee: Mary Jones',
    'Executed January 1, 2020 and recorded January 2, 2020 in Vol 1, Page 2.',
    'Legal Description: Section 1, Block C-9, Ward County, Texas. Minerals 1/2 conveyed.',
  ]);
  const base64Pdf = textPdfBytes.toString('base64');

  for (const scenario of ['illegible', 'missing_ref', 'low_text_match']) {
    const store = createMemoryPhase3Store([makeChunk({ id: `chk_text_${scenario}`, sizeBytes: textPdfBytes.byteLength })]);
    const requests = [];
    const result = await processChunkAbstraction(store.chunks.get(`chk_text_${scenario}`), {
      store,
      workerId: 'wkr_text_esc',
      blobLoader: async () => ({ bytes: textPdfBytes, mediaType: 'application/pdf' }),
      modelClient: async req => {
        requests.push(req);
        if (!req.escalation) {
          let text = cleanAbstract('Initial text-mode pass.');
          if (scenario === 'illegible') {
            text = text.replace('Vol 1, Page 2', 'ILLEGIBLE - VERIFY MANUALLY');
          } else if (scenario === 'missing_ref') {
            text = text.replace('RECORDING REF: Vol 1, Page 2\n', '');
          } else if (scenario === 'low_text_match') {
            text = text
              .replace('GRANTOR: John Smith', 'GRANTOR: Zebra Corp')
              .replace('GRANTEE: Mary Jones', 'GRANTEE: Omega Trust')
              .replace('RECORDING REF: Vol 1, Page 2', 'RECORDING REF: Vol 99, Page 999');
          }
          return { text, model: 'gemini-3.1-flash-lite', usage: { input_tokens: 15, output_tokens: 25 } };
        }
        return {
          text: cleanAbstract('Visual escalation verified.'),
          model: 'claude-sonnet-5-5',
          usage: { input_tokens: 40, output_tokens: 35 },
        };
      },
    });

    assert(result.status === 'completed', `Expected completed for ${scenario}`);
    assert(requests.length === 2, `Expected 1 Tier 1 + 1 escalation call for ${scenario}, got ${requests.length}`);

    const tier1Content = requests[0].messages[0].content;
    assert(!tier1Content.some(b => b.type === 'document'), `Tier 1 should be text-only for ${scenario}`);
    assert(tier1Content.at(-1).text.includes('EXTRACTED PDF TEXT'), 'Tier 1 prompt should contain extracted text');

    const escContent = requests[1].messages[0].content;
    const docBlock = escContent.find(b => b.type === 'document');
    assert(docBlock, `Escalation must attach PDF document block for ${scenario}`);
    assert(docBlock.source.type === 'base64', 'Escalation must send base64 PDF bytes');
    assert(docBlock.source.data === base64Pdf, 'Escalation must attach the full PDF bytes');
    assert(!escContent.at(-1).text.includes('EXTRACTED PDF TEXT'), 'Escalation must not be text-only');

    const saved = store.abstracts.get(`chk_text_${scenario}`);
    assert(saved.modelUsed === 'claude-sonnet-5-5', 'Expected escalated model saved');
    assert(saved.inputTokens === 55 && saved.outputTokens === 60, 'Expected summed input/output tokens');
  }
});

test('Priority 4: gemini_file PDF escalates via base64 for Anthropic/OpenRouter and fresh upload for Gemini', async () => {
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('ScanData'), doc.context.register(doc.context.stream(Buffer.alloc(120_000, 66))));
  const scannedPdfBytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  const base64Pdf = scannedPdfBytes.toString('base64');

  const prevFetch = globalThis.fetch;
  let uploadCounter = 0;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (init.method === 'POST' && target.includes('/upload/v1beta/files')) {
      uploadCounter += 1;
      return new Response(JSON.stringify({
        file: {
          uri: `https://generativelanguage.googleapis.com/v1beta/files/scan_${uploadCounter}`,
          name: `files/scan_${uploadCounter}`,
          mimeType: 'application/pdf',
        },
      }), { status: 200 });
    }
    if (target.includes('/files/scan_')) {
      return new Response(JSON.stringify({ state: 'ACTIVE' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    await withEnvOverrides({
      GEMINI_API_KEY: 'synthetic-gemini-key',
      GEMINI_FILE_API_ENABLED: 'true',
      GEMINI_FILE_API_MIN_BYTES: '100000',
    }, async () => {
      for (const targetModel of ['claude-sonnet-5-5', 'anthropic/claude-haiku-5.5']) {
        const beforeUploads = uploadCounter;
        const store = createMemoryPhase3Store([makeChunk({ id: `chk_gf_${targetModel}`, sizeBytes: scannedPdfBytes.byteLength })]);
        const requests = [];
        await processChunkAbstraction(store.chunks.get(`chk_gf_${targetModel}`), {
          store,
          escalationModel: targetModel,
          blobLoader: async () => ({ bytes: scannedPdfBytes, mediaType: 'application/pdf' }),
          modelClient: async req => {
            requests.push(req);
            if (!req.escalation) {
              return {
                text: cleanAbstract().replace('GRANTOR: John Smith', 'GRANTOR: ILLEGIBLE - VERIFY MANUALLY'),
                model: 'gemini-3.1-flash-lite',
                usage: { input_tokens: 10, output_tokens: 10 },
              };
            }
            return {
              text: cleanAbstract('Base64 escalation complete.'),
              model: targetModel,
              usage: { input_tokens: 20, output_tokens: 20 },
            };
          },
        });
        assert(requests.length === 2, `Expected 2 calls for ${targetModel}`);
        assert(uploadCounter === beforeUploads + 1, 'Only Tier 1 should upload to Gemini Files API');
        const tier1Doc = requests[0].messages[0].content.find(b => b.type === 'document');
        assert(tier1Doc.source.type === 'file_uri', 'Tier 1 should use file_uri');
        const escDoc = requests[1].messages[0].content.find(b => b.type === 'document');
        assert(escDoc.source.type === 'base64', `${targetModel} escalation must use base64, not file_uri`);
        assert(escDoc.source.data === base64Pdf, `${targetModel} must receive raw PDF base64`);
      }

      const beforeGeminiUploads = uploadCounter;
      const storeGemini = createMemoryPhase3Store([makeChunk({ id: 'chk_gf_gemini', sizeBytes: scannedPdfBytes.byteLength })]);
      const geminiRequests = [];
      await processChunkAbstraction(storeGemini.chunks.get('chk_gf_gemini'), {
        store: storeGemini,
        escalationModel: 'gemini-4-hydrogen',
        blobLoader: async () => ({ bytes: scannedPdfBytes, mediaType: 'application/pdf' }),
        modelClient: async req => {
          geminiRequests.push(req);
          if (!req.escalation) {
            return {
              text: cleanAbstract().replace('GRANTOR: John Smith', 'GRANTOR: ILLEGIBLE - VERIFY MANUALLY'),
              model: 'gemini-3.1-flash-lite',
              usage: {},
            };
          }
          return { text: cleanAbstract('Fresh Gemini upload escalation.'), model: 'gemini-4-hydrogen', usage: {} };
        },
      });
      assert(uploadCounter === beforeGeminiUploads + 2, 'Gemini escalation should upload a fresh Gemini file instead of reusing Tier 1 URI');
      const t1Uri = geminiRequests[0].messages[0].content.find(b => b.type === 'document').source.uri;
      const escUri = geminiRequests[1].messages[0].content.find(b => b.type === 'document').source.uri;
      assert(t1Uri !== escUri, 'Escalation must not reuse Tier 1 file_uri');
    });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('Priority 4: hybrid-mode PDF escalates with full visual PDF bytes', async () => {
  const hybridBytes = await makeTextPdfBytes([
    'WARRANTY DEED',
    'Grantor: John Smith conveys to Grantee: Mary Jones',
    'Executed January 1, 2020 and recorded January 2, 2020 in Vol 1, Page 2.',
    'Legal Description: Section 1, Block C-9, Ward County, Texas.',
  ], { extraBlankPage: true });
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_hybrid', sizeBytes: hybridBytes.byteLength })]);
  const requests = [];
  const result = await processChunkAbstraction(store.chunks.get('chk_hybrid'), {
    store,
    blobLoader: async () => ({ bytes: hybridBytes, mediaType: 'application/pdf' }),
    modelClient: async req => {
      requests.push(req);
      if (!req.escalation) {
        return {
          text: cleanAbstract().replace('CONFIDENCE: All fields clearly legible.', 'CONFIDENCE: low'),
          model: 'gemini-3.1-flash-lite',
          usage: {},
        };
      }
      return { text: cleanAbstract('Full visual hybrid escalation.'), model: 'claude-sonnet-5-5', usage: {} };
    },
  });
  assert(result.status === 'completed');
  assert(requests.length === 2);
  assert(requests[0].messages[0].content.at(-1).text.includes('HYBRID PDF'), 'Tier 1 should be hybrid mode');
  const escContent = requests[1].messages[0].content;
  assert(!escContent.at(-1).text.includes('HYBRID PDF'), 'Escalation must not send partial hybrid prompt');
  const escDoc = escContent.find(b => b.type === 'document');
  assert(escDoc?.source?.type === 'base64' && escDoc.source.data === hybridBytes.toString('base64'), 'Escalation must send full PDF bytes');
});

test('Priority 4: escalation error logs structured warning without retrying and preserves Tier 1 abstract', async () => {
  const warnings = [];
  const prevWarn = console.warn;
  console.warn = msg => warnings.push(msg);
  try {
    await withEnvOverrides({ ANTHROPIC_API_KEY: 'sk-ant-secret-value-12345' }, async () => {
      const store = createMemoryPhase3Store([makeChunk({ id: 'chk_esc_err' })]);
      let escalationCalls = 0;
      const tier1Text = cleanAbstract('Tier 1 preserved despite error.').replace('RECORDING REF: Vol 1, Page 2\n', '');
      const result = await processChunkAbstraction(store.chunks.get('chk_esc_err'), {
        store,
        blobLoader: async () => ({ bytes: Buffer.from('%PDF-test'), mediaType: 'application/pdf' }),
        modelClient: async req => {
          if (req.escalation) {
            escalationCalls += 1;
            throw new Error('Upstream rejected sk-ant-secret-value-12345 on escalation');
          }
          return { text: tier1Text, model: 'gemini-3.1-flash-lite', usage: { input_tokens: 12, output_tokens: 18 } };
        },
      });
      assert(result.status === 'completed');
      assert(escalationCalls === 1, `Escalation must never retry, got ${escalationCalls} calls`);
      assert(store.abstracts.get('chk_esc_err').modelUsed === 'gemini-3.1-flash-lite', 'Tier 1 model should be preserved');
      assert(store.abstracts.get('chk_esc_err').abstractText.includes('Tier 1 preserved'), 'Tier 1 abstract should be preserved');
      const parsedWarn = warnings.map(w => { try { return JSON.parse(w); } catch { return null; } }).find(e => e?.event === 'abstraction_escalation_failed');
      assert(parsedWarn, 'Expected structured abstraction_escalation_failed warning');
      assert(parsedWarn.chunkId === 'chk_esc_err');
      assert(parsedWarn.reasons.includes('missing_required_field:RECORDING REF'));
      assert(!JSON.stringify(parsedWarn).includes('sk-ant-secret-value-12345'), 'Warning must redact secret keys');
    });

    warnings.length = 0;
    const hugePdfBytes = Buffer.alloc(14_000_000, 65);
    const prevFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const target = String(url);
      if (init.method === 'POST' && target.includes('/upload/v1beta/files')) {
        return new Response(JSON.stringify({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/huge1', name: 'files/huge1', mimeType: 'application/pdf' } }), { status: 200 });
      }
      if (target.includes('/files/huge1')) return new Response(JSON.stringify({ state: 'ACTIVE' }), { status: 200 });
      throw new Error(`unexpected fetch ${target}`);
    };
    try {
      await withEnvOverrides({ GEMINI_API_KEY: 'synthetic-key', GEMINI_FILE_API_ENABLED: 'true' }, async () => {
        const store = createMemoryPhase3Store([makeChunk({ id: 'chk_esc_413', sizeBytes: hugePdfBytes.byteLength })]);
        let escalationCalls = 0;
        const result = await processChunkAbstraction(store.chunks.get('chk_esc_413'), {
          store,
          blobLoader: async () => ({ bytes: hugePdfBytes, mediaType: 'application/pdf' }),
          modelClient: async req => {
            if (req.escalation) {
              escalationCalls += 1;
              return { text: cleanAbstract(), model: req.model, usage: {} };
            }
            return {
              text: cleanAbstract('Tier 1 kept when inline escalation too large.').replace(/CONFIDENCE:.*$/m, 'CONFIDENCE: low'),
              model: 'gemini-3.1-flash-lite',
              usage: {},
            };
          },
        });
        assert(result.status === 'completed');
        assert(escalationCalls === 0, 'Oversized inline escalation must fail before invoking modelClient');
        const parsedWarn = warnings.map(w => { try { return JSON.parse(w); } catch { return null; } }).find(e => e?.event === 'abstraction_escalation_failed');
        assert(parsedWarn && parsedWarn.errorType === 'payload_too_large', `Expected payload_too_large warning, got ${JSON.stringify(parsedWarn)}`);
      });
    } finally {
      globalThis.fetch = prevFetch;
    }
  } finally {
    console.warn = prevWarn;
  }
});

test('Priority 4: escalation never loops even when escalated abstract remains illegible or incomplete', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_no_loop' })]);
  let calls = 0;
  const result = await processChunkAbstraction(store.chunks.get('chk_no_loop'), {
    store,
    blobLoader: async () => ({ bytes: Buffer.from('%PDF-test'), mediaType: 'application/pdf' }),
    modelClient: async req => {
      calls += 1;
      return {
        text: `DOC TYPE: Warranty Deed\nGRANTOR: ILLEGIBLE - VERIFY MANUALLY\nCONFIDENCE: ${req.escalation ? 'low still illegible' : 'low'}`,
        model: req.model,
        usage: { input_tokens: 10, output_tokens: 10 },
      };
    },
  });
  assert(result.status === 'completed');
  assert(calls === 2, `Expected exactly 2 calls (Tier 1 + 1 bounded escalation), got ${calls}`);
  assert(store.abstracts.get('chk_no_loop').modelUsed === 'claude-sonnet-5-5');
});

test('Priority 5: deterministic triggers fire via shouldEscalateAbstract/evaluateAbstractEscalation while clean and CSV skip false positives', async () => {
  const clean = cleanAbstract();
  assert(shouldEscalateAbstract(clean) === false, 'Clean abstract must not escalate');

  const missingField = clean.replace('RECORDING REF: Vol 1, Page 2\n', '');
  const missingEval = evaluateAbstractEscalation(missingField);
  assert(missingEval.shouldEscalate === true && missingEval.reasons.includes('missing_required_field:RECORDING REF'));

  const abstainedField = clean.replace('GRANTEE: Mary Jones', 'GRANTEE: not visible');
  const abstainedEval = evaluateAbstractEscalation(abstainedField);
  assert(abstainedEval.shouldEscalate === true && abstainedEval.reasons.includes('abstained_required_field:GRANTEE'));

  const invertedDates = clean.replace('DATE RECORDED: January 2, 2020', 'DATE RECORDED: December 20, 2019');
  const invertedEval = evaluateAbstractEscalation(invertedDates);
  assert(invertedEval.shouldEscalate === true && invertedEval.reasons.includes('inverted_dates'));

  const mineralsNoFrac = clean.replace('FRACTION CONVEYED: 1/2 mineral interest', 'FRACTION CONVEYED: none stated');
  const mineralsEval = evaluateAbstractEscalation(mineralsNoFrac);
  assert(mineralsEval.shouldEscalate === true && mineralsEval.reasons.includes('minerals_without_fraction'));

  const lowMatchEval = evaluateAbstractEscalation(
    clean
      .replace('GRANTOR: John Smith', 'GRANTOR: Fake Person')
      .replace('GRANTEE: Mary Jones', 'GRANTEE: Another Fake')
      .replace('RECORDING REF: Vol 1, Page 2', 'RECORDING REF: Vol 99, Page 99'),
    {},
    2000,
    { documentText: 'Grantor John Smith conveys to Grantee Mary Jones on January 1, 2020, recorded January 2, 2020 in Vol 1 Page 2.' },
  );
  assert(lowMatchEval.shouldEscalate === true && lowMatchEval.reasons.includes('low_text_match'));

  assert(
    shouldEscalateAbstract('Owner: John Smith, 50% mineral interest.', {}, 2000, { isCsv: true }) === false,
    'CSV abstract without deed template fields must not false-positive escalate',
  );
  assert(
    shouldEscalateAbstract(
      'DOC TYPE: Ownership Schedule\nRECORDING REF: ILLEGIBLE - VERIFY MANUALLY\nCONFIDENCE: High confidence.',
      {},
      2000,
      { isCsv: true },
    ) === false,
    'CSV abstract with ILLEGIBLE marker must not escalate to visual Sonnet',
  );

  const secondaryIllegible = clean
    .replace('WARRANTY: full', 'WARRANTY: ILLEGIBLE - VERIFY MANUALLY')
    .replace('ACKNOWLEDGMENT: yes', 'ACKNOWLEDGMENT: ILLEGIBLE - VERIFY MANUALLY')
    .replace('ISSUES: none noted', 'ISSUES: Notary seal is ILLEGIBLE - VERIFY MANUALLY');
  const secondaryEval = evaluateAbstractEscalation(secondaryIllegible);
  assert(
    secondaryEval.shouldEscalate === false,
    `Secondary-field ILLEGIBLE marker must not escalate, got ${JSON.stringify(secondaryEval.reasons)}`,
  );

  const keyIllegibleEval = evaluateAbstractEscalation(
    clean.replace('RESERVATIONS: none stated', 'RESERVATIONS: ILLEGIBLE - VERIFY MANUALLY'),
  );
  assert(
    keyIllegibleEval.shouldEscalate === true && keyIllegibleEval.reasons.includes('illegible_marker'),
    `Key-field ILLEGIBLE marker must still escalate, got ${JSON.stringify(keyIllegibleEval.reasons)}`,
  );

  const unrecordedClean = clean
    .replace('DATE RECORDED: January 2, 2020', 'DATE RECORDED: unrecorded')
    .replace('RECORDING REF: Vol 1, Page 2', 'RECORDING REF: unrecorded');
  assert(
    shouldEscalateAbstract(unrecordedClean) === false,
    'Consistently unrecorded instrument must not false-positive escalate',
  );

  assert(
    ABSTRACTION_PROMPT.includes('"not stated"') && ABSTRACTION_PROMPT.includes('"unrecorded"'),
    'ABSTRACTION_PROMPT must distinguish absent/unrecorded fields from ILLEGIBLE - VERIFY MANUALLY',
  );
});

test('Priority 5: clean, correct abstracts are not escalated by the quality checks (with and without document text)', () => {
  const failures = [];
  for (const c of cleanCases) {
    for (const [label, context] of [['no text', {}], ['with text', { documentText: c.text }]]) {
      const result = evaluateAbstractEscalation(c.abstract, { outputTokens: 450 }, 2000, context);
      if (result.shouldEscalate) failures.push(`${c.name} (${label}): ${result.reasons.join(', ')}`);
    }
  }
  assert(failures.length === 0, `${failures.length} clean abstracts escalated:\n${failures.join('\n')}`);
});

test('Priority 5: defective abstracts keep escalating with their stated reason', () => {
  const failures = [];
  for (const c of defectiveCases) {
    const contexts = c.needsText ? [['with text', { documentText: c.text }]] : [['no text', {}], ['with text', { documentText: c.text }]];
    for (const [label, context] of contexts) {
      const result = evaluateAbstractEscalation(c.abstract, { outputTokens: 450 }, 2000, context);
      if (!result.shouldEscalate || !result.reasons.some(reason => reason.startsWith(c.reason))) {
        failures.push(`${c.name} (${label}): expected ${c.reason}, got ${JSON.stringify(result.reasons)}`);
      }
    }
  }
  assert(failures.length === 0, `${failures.length} defective abstracts not flagged:\n${failures.join('\n')}`);
});

test('Priority 4: resolveEscalationModel and resolveEscalationMaxTokens read env dynamically', async () => {
  await withEnvOverrides({ ABSTRACT_ESCALATION_MODEL: 'anthropic/claude-haiku-5.5', ABSTRACT_ESCALATION_MAX_TOKENS: '6000' }, async () => {
    assert(resolveEscalationModel() === 'anthropic/claude-haiku-5.5');
    assert(resolveEscalationMaxTokens() === 6000);
    assert(getAbstractionConfig().escalationModel === 'anthropic/claude-haiku-5.5');
    assert(getAbstractionConfig().escalationMaxTokens === 6000);
  });
});

const FLAGGED_TIER1 = 'DOCUMENT #1:\nDOC TYPE: Warranty Deed\nISSUES: ILLEGIBLE - VERIFY MANUALLY\nCONFIDENCE: low';

test('lease: getAbstractionConfig exposes the upstream timeout', () => {
  assert(Number.isFinite(getAbstractionConfig().upstreamTimeoutMs) && getAbstractionConfig().upstreamTimeoutMs >= 10_000, 'Expected upstreamTimeoutMs in config');
});

test('lease (solo): lease stolen before the escalation => no Sonnet call, stale, chunk not failed or retry_wait', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_solo_lost' })]);
  const calls = [];
  const result = await processChunkAbstraction(store.chunks.get('chk_solo_lost'), {
    store,
    workerId: 'wkr_A',
    blobLoader: async () => ({ bytes: Buffer.from('%PDF-test'), mediaType: 'application/pdf' }),
    modelClient: async req => {
      calls.push(req.model);
      if (!req.escalation) {
        // Worker B reclaims the chunk while the slow Tier-1 call runs.
        store.chunks.set('chk_solo_lost', { ...store.chunks.get('chk_solo_lost'), abstractionWorkerId: 'wkr_B' });
        return { text: FLAGGED_TIER1, model: 'gemini-3.1-flash-lite', usage: {} };
      }
      return { text: cleanAbstract('Sonnet'), model: 'claude-sonnet-5-5', usage: {} };
    },
  });
  assert(result.status === 'stale', `Expected stale, got ${result.status}`);
  assert(calls.length === 1, `Expected only the Tier-1 call, got ${calls.join(',')}`);
  const chunk = store.chunks.get('chk_solo_lost');
  assert(chunk.abstractionStatus === 'processing' && chunk.abstractionWorkerId === 'wkr_B', `Lost chunk must be left to its new owner, got ${chunk.abstractionStatus}/${chunk.abstractionWorkerId}`);
  assert(!store.abstracts.has('chk_solo_lost'), 'Stale worker must not persist an abstract');
});

test('lease (solo): an expired but unclaimed lease is renewed before the Sonnet call', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_solo_expired' })]);
  let leaseAtSonnet = null;
  const result = await processChunkAbstraction(store.chunks.get('chk_solo_expired'), {
    store,
    workerId: 'wkr_A',
    leaseMs: 1000,
    blobLoader: async () => ({ bytes: Buffer.from('%PDF-test'), mediaType: 'application/pdf' }),
    modelClient: async req => {
      if (!req.escalation) {
        store.chunks.set('chk_solo_expired', { ...store.chunks.get('chk_solo_expired'), abstractionLeaseExpiresAt: new Date(Date.now() - 60_000).toISOString() });
        return { text: FLAGGED_TIER1, model: 'gemini-3.1-flash-lite', usage: {} };
      }
      leaseAtSonnet = Date.parse(store.chunks.get('chk_solo_expired').abstractionLeaseExpiresAt);
      return { text: cleanAbstract('Sonnet'), model: 'claude-sonnet-5-5', usage: {} };
    },
  });
  assert(result.status === 'completed', `Expected completed, got ${result.status}`);
  assert(leaseAtSonnet !== null, 'Expected a Sonnet call');
  const minMs = getAbstractionConfig().upstreamTimeoutMs + 60_000;
  assert(leaseAtSonnet - Date.now() > minMs - 5_000, `Lease must cover upstream timeout + 60s at the Sonnet call, remaining ${leaseAtSonnet - Date.now()}ms`);
});

test('lease (solo): a renewal that throws is logged and the work proceeds', async () => {
  const warnings = [];
  const prevWarn = console.warn;
  console.warn = msg => warnings.push(msg);
  try {
    const store = createMemoryPhase3Store([makeChunk({ id: 'chk_solo_renew_err' })], { renewThrows: 'db blip' });
    const calls = [];
    const result = await processChunkAbstraction(store.chunks.get('chk_solo_renew_err'), {
      store,
      workerId: 'wkr_A',
      blobLoader: async () => ({ bytes: Buffer.from('%PDF-test'), mediaType: 'application/pdf' }),
      modelClient: async req => {
        calls.push(req.model);
        return req.escalation
          ? { text: cleanAbstract('Sonnet'), model: 'claude-sonnet-5-5', usage: {} }
          : { text: FLAGGED_TIER1, model: 'gemini-3.1-flash-lite', usage: {} };
      },
    });
    assert(result.status === 'completed', `Expected completed, got ${result.status}`);
    assert(calls.length === 2, `Expected Tier-1 + Sonnet, got ${calls.length}`);
    assert(warnings.some(w => String(w).includes('abstraction_chunk_lease_renew_failed')), 'Expected a renew-failed warning');
  } finally {
    console.warn = prevWarn;
  }
});

test('lease (solo): a store without renewChunkAbstractionLease behaves as before', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_solo_norenew' })]);
  delete store.renewChunkAbstractionLease;
  const calls = [];
  const result = await processChunkAbstraction(store.chunks.get('chk_solo_norenew'), {
    store,
    workerId: 'wkr_A',
    blobLoader: async () => ({ bytes: Buffer.from('%PDF-test'), mediaType: 'application/pdf' }),
    modelClient: async req => {
      calls.push(req.model);
      return req.escalation
        ? { text: cleanAbstract('Sonnet'), model: 'claude-sonnet-5-5', usage: {} }
        : { text: FLAGGED_TIER1, model: 'gemini-3.1-flash-lite', usage: {} };
    },
  });
  assert(result.status === 'completed' && calls.length === 2, `Expected completed with 2 calls, got ${result.status}/${calls.length}`);
});

test('lease: runModelAbstraction awaits modelCallGuard before every call and lets guard errors escape the escalation catch', async () => {
  const { runModelAbstraction, runChunkEscalation } = await import('../api/_lib/abstraction.js');
  const order = [];
  const guardErr = Object.assign(new Error('lease lost'), { code: 'lease_lost' });
  let n = 0;
  const base = {
    messages: [{ role: 'user', content: 'x' }],
    model: 'gemini-3.1-flash-lite',
    maxTokens: 100,
    payloadBytes: 10,
    escalationModel: 'claude-sonnet-5-5',
    escalationMaxTokens: 100,
  };
  const modelClient = async req => {
    order.push(req.escalation ? 'call:esc' : 'call:primary');
    return { text: req.escalation ? cleanAbstract('Sonnet') : FLAGGED_TIER1, model: req.model, usage: {} };
  };
  await runModelAbstraction({ ...base, options: { modelClient, modelCallGuard: async () => { order.push(`guard${++n}`); } } });
  assert(order.join(',') === 'guard1,call:primary,guard2,call:esc', `Unexpected order ${order.join(',')}`);
  let thrown = null;
  order.length = 0;
  try {
    await runModelAbstraction({ ...base, options: { modelClient, modelCallGuard: async () => { if (order.length) throw guardErr; order.push('guard'); } } });
  } catch (err) { thrown = err; }
  assert(thrown === guardErr, 'Guard error on the escalation call must propagate unchanged');
  assert(order.join(',') === 'guard,call:primary', `Escalation must not be paid after a failed guard, got ${order.join(',')}`);
  thrown = null;
  const chunk = makeChunk({ id: 'chk_guard_chunk_esc' });
  let paid = 0;
  try {
    await runChunkEscalation({
      chunk,
      payloadBytes: Buffer.from('%PDF-test'),
      options: { modelClient: async () => { paid += 1; return { text: 'x', usage: {} }; }, modelCallGuard: async () => { throw guardErr; } },
    });
  } catch (err) { thrown = err; }
  assert(thrown === guardErr && paid === 0, 'runChunkEscalation must rethrow the guard error and not pay');
});

test('lease (solo): processChunkAbstraction delegates renewal to chunkLeaseGuard without duplicate singular renewal', async () => {
  const store = createMemoryPhase3Store([makeChunk({ id: 'chk_delegate_guard' })]);
  let singularRenewals = 0;
  const origRenew = store.renewChunkAbstractionLease;
  store.renewChunkAbstractionLease = async (...args) => { singularRenewals += 1; return origRenew(...args); };
  const guardArgs = [];
  const result = await processChunkAbstraction(store.chunks.get('chk_delegate_guard'), {
    store,
    workerId: 'wkr_guard',
    leaseMs: 1000,
    chunkLeaseGuard: async (chunk, ms) => {
      guardArgs.push({ id: chunk.id, ms });
      return 'renewed';
    },
    blobLoader: async () => ({ bytes: Buffer.from('%PDF-test'), mediaType: 'application/pdf' }),
    modelClient: async () => ({
      text: cleanAbstract('Clean'),
      model: 'gemini-3.1-flash-lite',
      usage: { input_tokens: 10, output_tokens: 15 },
    }),
  });
  assert(result.status === 'completed', `Expected completed, got ${result.status}`);
  assert(guardArgs.length === 1 && guardArgs[0].id === 'chk_delegate_guard' && guardArgs[0].ms >= 300_000, `Expected chunkLeaseGuard called with chunk and call leaseMs, got ${JSON.stringify(guardArgs)}`);
  assert(singularRenewals === 0, `Expected 0 singular renewals when chunkLeaseGuard returns outcome, got ${singularRenewals}`);

  const lostStore = createMemoryPhase3Store([makeChunk({ id: 'chk_delegate_lost' })]);
  let calls = 0;
  const lostResult = await processChunkAbstraction(lostStore.chunks.get('chk_delegate_lost'), {
    store: lostStore,
    workerId: 'wkr_guard',
    chunkLeaseGuard: async () => 'lost',
    blobLoader: async () => ({ bytes: Buffer.from('%PDF-test'), mediaType: 'application/pdf' }),
    modelClient: async () => { calls += 1; return { text: 'should not pay', model: 'gemini-3.1-flash-lite', usage: {} }; },
  });
  assert(lostResult.status === 'stale' && calls === 0, `Expected stale with 0 paid calls, got ${lostResult.status}/${calls}`);
});

test('processChunkAbstraction sets MEDIA_RESOLUTION_HIGH on direct Gemini visual, hybrid, image, and gemini_file calls only', async () => {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');

  const cleanDoc = await PDFDocument.create();
  const cleanFont = await cleanDoc.embedFont(StandardFonts.Helvetica);
  const cleanPage = cleanDoc.addPage([612, 792]);
  cleanPage.drawText('STATE OF TEXAS\nCOUNTY OF REEVES\nGRANTOR: JOHN DOE\nGRANTEE: JANE DOE\n'.repeat(8), {
    x: 72, y: 700, size: 11, font: cleanFont, lineHeight: 14, maxWidth: 460,
  });
  const cleanPdfBytes = Buffer.from(await cleanDoc.save());

  const hybridDoc = await PDFDocument.create();
  const hybridFont = await hybridDoc.embedFont(StandardFonts.Helvetica);
  const hybridPage1 = hybridDoc.addPage([612, 792]);
  hybridPage1.drawText('STATE OF TEXAS\nCOUNTY OF REEVES\nGRANTOR: JOHN DOE\nGRANTEE: JANE DOE\n'.repeat(8), {
    x: 72, y: 700, size: 11, font: hybridFont, lineHeight: 14, maxWidth: 460,
  });
  hybridDoc.addPage([612, 792]);
  const hybridPdfBytes = Buffer.from(await hybridDoc.save());

  const visualDoc = await PDFDocument.create();
  visualDoc.addPage([612, 792]);
  const visualPdfBytes = Buffer.from(await visualDoc.save());

  const prevRes = process.env.GEMINI_PDF_MEDIA_RESOLUTION;
  const prevProvider = process.env.MODEL_PROVIDER;
  const prevEscalation = process.env.ABSTRACTION_ESCALATION_ENABLED;
  delete process.env.GEMINI_PDF_MEDIA_RESOLUTION;
  delete process.env.MODEL_PROVIDER;
  delete process.env.ABSTRACTION_ESCALATION_ENABLED;

  try {
    const capture = async (chunk, bytes, extraOptions = {}) => {
      const requests = [];
      const store = createMemoryPhase3Store([chunk]);
      await processChunkAbstraction(chunk, {
        store,
        workerId: 'wkr_media_res',
        escalationEnabled: false,
        blobLoader: async () => ({ bytes, mediaType: chunk.mediaType }),
        modelClient: async req => {
          requests.push(req);
          if (extraOptions.escalate && req.model === 'gemini-3.1-flash-lite') {
            return { text: 'DOC TYPE: Deed\nISSUES: ILLEGIBLE - VERIFY MANUALLY\nCONFIDENCE: low', model: req.model, usage: {} };
          }
          return { text: 'DOC TYPE: Deed\nGRANTOR: John Doe\nCONFIDENCE: clear', model: req.model, usage: {} };
        },
        ...extraOptions,
      });
      return requests;
    };

    const visualReqs = await capture(makeChunk({ id: 'chk_vis', sizeBytes: visualPdfBytes.byteLength }), visualPdfBytes);
    assert(visualReqs[0].mediaResolution === 'MEDIA_RESOLUTION_HIGH', `Expected MEDIA_RESOLUTION_HIGH for visual PDF, got ${visualReqs[0].mediaResolution}`);

    const hybridReqs = await capture(makeChunk({ id: 'chk_hyb', pageEnd: 2, sizeBytes: hybridPdfBytes.byteLength }), hybridPdfBytes);
    assert(hybridReqs[0].mediaResolution === 'MEDIA_RESOLUTION_HIGH', `Expected MEDIA_RESOLUTION_HIGH for hybrid PDF, got ${hybridReqs[0].mediaResolution}`);

    const imgBytes = Buffer.from('png-image-bytes');
    const imgReqs = await capture(makeChunk({ id: 'chk_img', mediaType: 'image/png', originalFilename: 'scan.png', sizeBytes: imgBytes.byteLength }), imgBytes);
    assert(imgReqs[0].mediaResolution === 'MEDIA_RESOLUTION_HIGH', `Expected MEDIA_RESOLUTION_HIGH for image chunk, got ${imgReqs[0].mediaResolution}`);

    const geminiFileChunk = makeChunk({ id: 'chk_gfile', sizeBytes: 100 });
    const gfileReqs = await capture(geminiFileChunk, visualPdfBytes, {
      preloadedDelivery: {
        chunkId: 'chk_gfile',
        delivery: {
          mode: 'gemini_file',
          fileUri: 'https://generativelanguage.googleapis.com/v1beta/files/test_file',
          geminiFileName: 'files/test_file',
          mimeType: 'application/pdf',
        },
      },
    });
    assert(gfileReqs[0].mediaResolution === 'MEDIA_RESOLUTION_HIGH', `Expected MEDIA_RESOLUTION_HIGH for gemini_file chunk, got ${gfileReqs[0].mediaResolution}`);

    const textReqs = await capture(makeChunk({ id: 'chk_txt', sizeBytes: cleanPdfBytes.byteLength }), cleanPdfBytes);
    assert(!('mediaResolution' in textReqs[0]), 'Clean text-mode PDF must omit mediaResolution');

    const csvBytes = Buffer.from('owner,interest\nAlice,1/2\n');
    const csvReqs = await capture(makeChunk({ id: 'chk_csv', mediaType: 'text/csv', originalFilename: 'owners.csv', sizeBytes: csvBytes.byteLength }), csvBytes);
    assert(!('mediaResolution' in csvReqs[0]), 'CSV chunk must omit mediaResolution');

    process.env.GEMINI_PDF_MEDIA_RESOLUTION = 'false';
    const disabledReqs = await capture(makeChunk({ id: 'chk_off', sizeBytes: visualPdfBytes.byteLength }), visualPdfBytes);
    assert(!('mediaResolution' in disabledReqs[0]), 'GEMINI_PDF_MEDIA_RESOLUTION=false must omit mediaResolution');

    process.env.GEMINI_PDF_MEDIA_RESOLUTION = 'medium';
    const mediumReqs = await capture(makeChunk({ id: 'chk_med', sizeBytes: visualPdfBytes.byteLength }), visualPdfBytes);
    assert(mediumReqs[0].mediaResolution === 'MEDIA_RESOLUTION_MEDIUM', `Expected MEDIA_RESOLUTION_MEDIUM, got ${mediumReqs[0].mediaResolution}`);

    delete process.env.GEMINI_PDF_MEDIA_RESOLUTION;
    process.env.MODEL_PROVIDER = 'openrouter';
    const openrouterReqs = await capture(makeChunk({ id: 'chk_or', sizeBytes: visualPdfBytes.byteLength }), visualPdfBytes);
    assert(!('mediaResolution' in openrouterReqs[0]), 'OpenRouter-routed Gemini must omit mediaResolution');
    delete process.env.MODEL_PROVIDER;

    const escalationReqs = await capture(makeChunk({ id: 'chk_esc', sizeBytes: visualPdfBytes.byteLength }), visualPdfBytes, {
      escalationEnabled: true,
      escalate: true,
    });
    assert(escalationReqs.length === 2, `Expected 2 calls on escalation, got ${escalationReqs.length}`);
    assert(escalationReqs[0].mediaResolution === 'MEDIA_RESOLUTION_HIGH', 'Primary Gemini visual call should set MEDIA_RESOLUTION_HIGH');
    assert(!('mediaResolution' in escalationReqs[1]), 'Claude escalation call must not receive mediaResolution');
  } finally {
    if (prevRes === undefined) delete process.env.GEMINI_PDF_MEDIA_RESOLUTION;
    else process.env.GEMINI_PDF_MEDIA_RESOLUTION = prevRes;
    if (prevProvider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = prevProvider;
    if (prevEscalation === undefined) delete process.env.ABSTRACTION_ESCALATION_ENABLED;
    else process.env.ABSTRACTION_ESCALATION_ENABLED = prevEscalation;
  }
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
    delete globalThis.__TITLE_ANALYZER_BLOB_WRITER__;
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err);
    process.exitCode = 1;
    break;
  }
}

delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
delete globalThis.__TITLE_ANALYZER_BLOB_LOADER__;
delete globalThis.__TITLE_ANALYZER_MODEL_CLIENT__;
delete globalThis.__TITLE_ANALYZER_BLOB_WRITER__;
if (previousAppPassword) process.env.APP_PASSWORD = previousAppPassword;
else delete process.env.APP_PASSWORD;
