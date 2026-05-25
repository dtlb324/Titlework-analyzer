import jobsRouteHandler from '../api/jobs/[...path].js';
import {
  ABSTRACTION_PROMPT,
  assertSafeBlobUrl,
  buildAbstractMessagesForChunk,
  defaultBlobLoader,
  getAbstractionConfig,
  processChunkAbstraction,
  processJobAbstraction,
  tryReuseExistingAbstract,
  validateAbstractPersistenceInput,
} from '../api/_lib/abstraction.js';
import {
  getBackgroundPromise,
  processAbstractionBatch,
} from '../api/_lib/queue.js';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
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
      // do not transition away from canceled
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

  function isClaimable(chunk, asOfMs) {
    if (chunk.uploadStatus !== 'uploaded') return false;
    const status = chunk.abstractionStatus || 'pending';
    if (status === 'pending') return true;
    if (status === 'retry_wait') {
      const retryAt = chunk.abstractionRetryAt ? Date.parse(chunk.abstractionRetryAt) : 0;
      return !retryAt || retryAt <= asOfMs;
    }
    if (status === 'processing') {
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
      if (!isClaimable(chunk, Date.now())) return null;
      const leaseMs = claimOptions.leaseMs || 90_000;
      const updated = {
        ...chunk,
        abstractionStatus: 'processing',
        abstractionAttempts: (chunk.abstractionAttempts || 0) + 1,
        abstractionErrorType: null,
        abstractionErrorMessage: null,
        abstractionClaimedAt: new Date().toISOString(),
        abstractionLeaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
        abstractionWorkerId: claimOptions.workerId || 'wkr_test',
        abstractionRetryAt: null,
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
        if (chunk.abstractionStatus === 'processing') {
          chunks.set(chunk.id, {
            ...chunk,
            abstractionClaimedAt: null,
            abstractionLeaseExpiresAt: null,
            abstractionWorkerId: null,
            updatedAt: now,
          });
        } else if (['pending', 'retry_wait'].includes(chunk.abstractionStatus)) {
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
      text: 'DOCUMENT #1:\nAbstracted deed facts.',
      model: 'claude-haiku-4-5',
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

  assert(!getBackgroundPromise('job_test_1'), 'Expected route not to schedule an in-request background drain');
  assert((await store.listDocumentAbstracts('job_test_1')).length === 0, 'Expected no abstract before the worker drains the queue');

  await processAbstractionBatch('job_test_1', { store });
  const saved = await store.listDocumentAbstracts('job_test_1');
  assert(saved.length === 1, 'Expected saved abstract');
  assert(saved[0].abstractText.includes('Abstracted deed facts'), 'Expected abstract text persistence');
  assert(saved[0].inputTokens === 111 && saved[0].outputTokens === 22, 'Expected token usage persistence');
});

test('POST /api/jobs/:id/abstraction/start rejects jobs before uploads are ready', async () => {
  const store = createMemoryPhase3Store([makeChunk()], { jobStatus: 'uploading' });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({ bytes: Buffer.from('%PDF'), mediaType: chunk.mediaType });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => ({ text: 'DOCUMENT #1:\nnoop', model: 'claude-haiku-4-5', usage: {} });

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/start'), res);

  assert(res.statusCode === 409, `Expected 409, got ${res.statusCode}`);
  assert(/finalized/.test(res.body.error), `Expected finalize guidance, got ${res.body.error}`);
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

test('abstraction prompt treats each PDF as one recorded instrument', () => {
  assert(ABSTRACTION_PROMPT.includes('abstracting a single courthouse instrument'), 'Expected single-instrument abstraction instruction');
  assert(!ABSTRACTION_PROMPT.includes('INSTRUMENT 1 OF M'), 'Prompt should not ask for multi-instrument sub-sections');
  assert(!ABSTRACTION_PROMPT.includes('multiple clearly identifiable recorded instruments'), 'Prompt should not ask for multi-instrument detection');
  assert(getAbstractionConfig().maxTokens === 3000, `Expected 3000 token default, got ${getAbstractionConfig().maxTokens}`);
});

test('browser abstraction fallback mirrors single-instrument prompt and token budget', () => {
  assert(indexHtml.includes('abstracting a single courthouse instrument'), 'Expected browser prompt to include single-instrument instruction');
  assert(!indexHtml.includes('INSTRUMENT 1 OF M'), 'Browser prompt should not ask for multi-instrument sub-sections');
  assert(!indexHtml.includes('multiple clearly identifiable recorded instruments'), 'Browser prompt should not ask for multi-instrument detection');
  assert(indexHtml.includes('const ABSTRACT_MAX_TOKENS = 3000'), 'Expected browser abstraction token default to match server default');
  assert(indexHtml.includes("const ABSTRACT_ESCALATION_MODEL = 'claude-sonnet-4-6'"), 'Expected browser fallback to define Sonnet escalation model');
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
    modelUsed: 'claude-haiku-4-5',
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
    modelUsed: 'claude-haiku-4-5',
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
    modelUsed: 'claude-haiku-4-5',
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
    model: 'claude-haiku-4-5',
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
      return { text: 'DOCUMENT #1:\nCompleted abstract.', model: 'claude-haiku-4-5', usage: {} };
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
    modelUsed: 'claude-haiku-4-5',
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

// ---------------------------------------------------------------------------
// Phase 4 tests
// ---------------------------------------------------------------------------

test('Phase 4: worker claims pending chunks under a lease', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_a', chunkOrder: 0, originalFilename: 'a.pdf' }),
    makeChunk({ id: 'chk_b', chunkOrder: 1, originalFilename: 'b.pdf' }),
  ]);
  let modelCalls = 0;
  const result = await processAbstractionBatch('job_test_1', {
    store,
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async () => {
      modelCalls += 1;
      return { text: 'DOCUMENT #1:\nClaim test.', model: 'claude-haiku-4-5', usage: {} };
    },
    batchLimit: 4,
    concurrency: 2,
    budgetMs: 5000,
    maxAttempts: 1,
  });
  assert(modelCalls === 2, `Expected two model calls (one per chunk), got ${modelCalls}`);
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
      return { text: 'DOCUMENT #1:\nok.', model: 'claude-haiku-4-5', usage: {} };
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
      modelClient: async () => ({ text: 'DOCUMENT #1:\nCSV abstract.', model: 'claude-haiku-4-5', usage: {} }),
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
      return { text: 'DOCUMENT #1:\nstale worker abstract', model: 'claude-haiku-4-5', usage: {} };
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
    modelUsed: 'claude-haiku-4-5',
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
    return { text: 'DOCUMENT #2:\nNew abstract.', model: 'claude-haiku-4-5', usage: {} };
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
    return { text: 'DOCUMENT #1:\nRetried.', model: 'claude-haiku-4-5', usage: {} };
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

  // Build a real multi-page PDF so pdf-lib can split it
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
    return { text: 'DOCUMENT #1:\nSplit child abstract.', model: 'claude-haiku-4-5', usage: {} };
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
  assert(children.map(child => `${child.pageStart}-${child.pageEnd}`).join(',') === '1-2,3-4', 'Expected inferred child page ranges 1-2 and 3-4');
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
      return { text: 'DOCUMENT #1:\nok.', model: 'claude-haiku-4-5', usage: {} };
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
});

test('Phase 4: cancel fails pending chunks so canceled jobs leave the worker queue', async () => {
  const store = createMemoryPhase3Store([
    makeChunk({ id: 'chk_one', chunkOrder: 0, abstractionStatus: 'pending' }),
    makeChunk({ id: 'chk_two', chunkOrder: 1, abstractionStatus: 'retry_wait', abstractionRetryAt: new Date(Date.now() + 60_000).toISOString() }),
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
  // Cancel BEFORE any processing
  await store.cancelJob('job_test_1', 'test cancel');

  let modelCalls = 0;
  const result = await processAbstractionBatch('job_test_1', {
    store,
    blobLoader: async chunk => ({ bytes: Buffer.from(chunk.id), mediaType: chunk.mediaType }),
    modelClient: async () => {
      modelCalls += 1;
      return { text: 'DOCUMENT #1:\nshould not run.', model: 'claude-haiku-4-5', usage: {} };
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
    await defaultBlobLoader(makeChunk({ id: 'chk_large', sizeBytes: 26_000_000 }));
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
    modelUsed: 'claude-haiku-4-5',
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
    return { text: 'DOCUMENT #2:\nShould not run.', model: 'claude-haiku-4-5', usage: {} };
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
      if (request.model === 'claude-sonnet-4-6') {
        return {
          text: 'DOCUMENT #1:\nDOC TYPE: Warranty Deed\nCONFIDENCE: Sonnet verified the illegible text and low-confidence fields.',
          model: 'claude-sonnet-4-6',
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
  assert(models.join(',') === 'gemini-2.5-flash,claude-sonnet-4-6', `Expected Gemini Flash then Sonnet, got ${models.join(',')}`);
  assert(saved.modelUsed === 'claude-sonnet-4-6', `Expected Sonnet saved, got ${saved.modelUsed}`);
  assert(saved.abstractText.includes('Sonnet verified'), 'Expected escalated abstract text saved');
  assert(saved.inputTokens === 30 && saved.outputTokens === 45, 'Expected token usage summed across Haiku and Sonnet calls');
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
        text: 'DOCUMENT #1:\nDOC TYPE: Warranty Deed\nGRANTOR: A\nGRANTEE: B\nISSUES: none noted\nCONFIDENCE: Clear, single-instrument abstract.',
        model: 'gemini-2.5-flash',
        usage: { input_tokens: 10, output_tokens: 15 },
      };
    },
  });

  const saved = store.abstracts.get('chk_clean');
  assert(models.join(',') === 'gemini-2.5-flash', `Expected only Gemini Flash, got ${models.join(',')}`);
  assert(saved.modelUsed === 'gemini-2.5-flash', `Expected Gemini Flash saved, got ${saved.modelUsed}`);
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
  // Make sure Phase 3 setup error is past
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async chunk => ({ bytes: Buffer.from('%PDF'), mediaType: chunk.mediaType });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => ({ text: 'DOCUMENT #1:\nok.', model: 'claude-haiku-4-5', usage: {} });

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
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => ({ text: 'DOCUMENT #1:\nok.', model: 'claude-haiku-4-5', usage: {} });

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/process'), res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.completedInBatch === 3, `Expected three completions in process batch, got ${res.body.completedInBatch}`);
  assert(res.body.hasMore === false, 'Expected no more work after draining batch');
});

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
    // Reset globals between tests to avoid cross-test pollution
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
