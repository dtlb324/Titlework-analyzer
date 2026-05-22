import startHandler from '../api/jobs/[id]/abstraction/start.js';
import statusHandler from '../api/jobs/[id]/abstraction/status.js';
import abstractsHandler from '../api/jobs/[id]/abstracts.js';
import retryHandler from '../api/jobs/[id]/chunks/[chunkId]/retry.js';
import {
  assertSafeBlobUrl,
  buildAbstractMessagesForChunk,
  processJobAbstraction,
  validateAbstractPersistenceInput,
} from '../api/_lib/abstraction.js';
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
    blobUrl: overrides.blobUrl || 'https://blob.vercel-storage.com/private/deed.pdf',
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

function createMemoryPhase3Store(chunksInput = [makeChunk()]) {
  const now = '2026-05-22T22:31:00.000Z';
  const jobs = new Map([[
    'job_test_1',
    {
      id: 'job_test_1',
      status: 'ready',
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
    const jobChunks = orderedChunks(jobId);
    const completed = jobChunks.filter(chunk => chunk.abstractionStatus === 'completed').length;
    const failed = jobChunks.filter(chunk => chunk.abstractionStatus === 'failed').length;
    const terminal = completed + failed;
    const job = jobs.get(jobId);
    let status = job.status;
    if (jobChunks.length && terminal === jobChunks.length) {
      status = completed > 0 && failed > 0 ? 'partial_failed' : completed > 0 ? 'synthesizing' : 'failed';
    } else if (jobChunks.some(chunk => ['pending', 'processing'].includes(chunk.abstractionStatus))) {
      status = 'abstracting';
    }
    const updated = {
      ...job,
      status,
      completedDocuments: completed,
      failedDocuments: failed,
      currentPhase: terminal === jobChunks.length ? `Server abstraction finished: ${completed} completed, ${failed} failed` : `Server abstraction ${completed}/${jobChunks.length}`,
      updatedAt: now,
    };
    jobs.set(jobId, updated);
    return updated;
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
    async markChunkAbstractionFailed(jobId, chunkId, failure) {
      const chunk = chunks.get(chunkId);
      const updated = {
        ...chunk,
        abstractionStatus: 'failed',
        abstractionErrorType: failure.errorType,
        abstractionErrorMessage: failure.errorMessage,
        payloadBytes: failure.payloadBytes ?? chunk.payloadBytes,
        latencyMs: failure.latencyMs ?? chunk.latencyMs,
        modelUsed: failure.modelUsed ?? chunk.modelUsed,
        updatedAt: now,
      };
      chunks.set(chunkId, updated);
      rollup(jobId);
      return updated;
    },
    async saveDocumentAbstract(record) {
      validateAbstractPersistenceInput(record);
      const id = `abs_${record.chunkId}`;
      const saved = { id, ...record, createdAt: now };
      abstracts.set(record.chunkId, saved);
      const chunk = chunks.get(record.chunkId);
      chunks.set(record.chunkId, {
        ...chunk,
        abstractionStatus: 'completed',
        abstractionErrorType: null,
        abstractionErrorMessage: null,
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
      if (!chunk || chunk.jobId !== jobId || chunk.abstractionStatus !== 'failed') return null;
      const updated = {
        ...chunk,
        abstractionStatus: 'pending',
        abstractionErrorType: null,
        abstractionErrorMessage: null,
        updatedAt: now,
      };
      chunks.set(chunkId, updated);
      return updated;
    },
    async getAbstractionStatus(jobId) {
      const jobChunks = orderedChunks(jobId);
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
        failedChunks: jobChunks.filter(chunk => chunk.abstractionStatus === 'failed'),
        job: jobs.get(jobId),
      };
    },
    async resetStaleProcessingChunks() {
      return [];
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('POST /api/jobs/:id/abstraction/start processes uploaded chunks and saves abstracts', async () => {
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

  const res = mockRes();
  await startHandler(mockReq('POST', null, {}, { id: 'job_test_1' }), res);

  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.status.completed === 1, 'Expected completed abstraction count');
  const saved = await store.listDocumentAbstracts('job_test_1');
  assert(saved.length === 1, 'Expected saved abstract');
  assert(saved[0].abstractText.includes('Abstracted deed facts'), 'Expected abstract text persistence');
  assert(saved[0].inputTokens === 111 && saved[0].outputTokens === 22, 'Expected token usage persistence');
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
  await abstractsHandler(mockReq('GET', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstracts'), res);

  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.abstracts.map(item => item.abstractText).join(',') === 'first,second', 'Expected chunk-order abstracts');
  assert(res.body.abstracts[0].sequence_index === 0, 'Expected Phase 3 sequence_index field');
  assert(res.body.abstracts[0].display_name === 'A.pdf', 'Expected Phase 3 display_name field');
  assert(res.body.abstracts[0].abstract_text === 'first', 'Expected Phase 3 abstract_text field');
  assert(!JSON.stringify(res.body).includes('data:'), 'Abstract response must not include raw data URLs');
});

test('server Blob loader rejects non-Vercel Blob URLs before attaching the Blob token', () => {
  let rejected = false;
  try {
    assertSafeBlobUrl('https://attacker.example/chunk.pdf');
  } catch (err) {
    rejected = /Vercel Blob/.test(err.message);
  }
  assert(rejected, 'Expected non-Vercel Blob URL rejection');
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
  await retryHandler(mockReq('POST', null, {}, { id: 'job_test_1', chunkId: 'chk_failed' }, '/api/jobs/job_test_1/chunks/chk_failed/retry'), res);

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
  await statusHandler(mockReq('GET', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/abstraction/status'), res);

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

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
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
if (previousAppPassword) process.env.APP_PASSWORD = previousAppPassword;
else delete process.env.APP_PASSWORD;
