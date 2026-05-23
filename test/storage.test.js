import jobsRouteHandler from '../api/jobs/[...path].js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mockReq(method, body = null, headers = {}, query = {}, url = '/api/jobs/job_test_1') {
  return {
    method,
    body,
    query,
    headers: { 'x-forwarded-for': '203.0.113.45', ...headers },
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

function createMemoryJobStore() {
  const now = '2026-05-22T22:15:00.000Z';
  let documentCount = 0;
  let chunkCount = 0;
  const jobs = new Map([[
    'job_test_1',
    {
      id: 'job_test_1',
      status: 'created',
      totalDocuments: 2,
      totalChunks: 0,
      completedDocuments: 0,
      failedDocuments: 0,
      completedChunks: 0,
      failedChunks: 0,
      currentPhase: 'created',
      createdAt: now,
      updatedAt: now,
    },
  ]]);
  const documents = new Map();
  const chunks = new Map();

  return {
    __setJobStatus(jobId, status) {
      const job = jobs.get(jobId);
      jobs.set(jobId, { ...job, status, updatedAt: now });
    },
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
    async createDocument(jobId, input) {
      documentCount += 1;
      const document = {
        id: `doc_test_${documentCount}`,
        jobId,
        originalFilename: input.originalFilename,
        mediaType: input.mediaType,
        sizeBytes: input.sizeBytes,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        splitFrom: input.splitFrom,
        fingerprint: input.fingerprint,
        checksumSha256: input.checksumSha256,
        uploadStatus: 'pending',
        chunkCount: 0,
        completedChunkCount: 0,
        failedChunkCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      documents.set(document.id, document);
      return document;
    },
    async findDocumentByFingerprint(jobId, fingerprint) {
      return [...documents.values()].find(document => document.jobId === jobId && document.fingerprint === fingerprint) || null;
    },
    async getDocument(jobId, documentId) {
      const document = documents.get(documentId);
      return document?.jobId === jobId ? document : null;
    },
    async createChunk(jobId, documentId, input) {
      chunkCount += 1;
      const chunk = {
        id: `chk_test_${chunkCount}`,
        jobId,
        documentId,
        chunkOrder: input.chunkOrder,
        originalFilename: input.originalFilename,
        blobKey: input.blobKey || `jobs/${jobId}/chunks/chk_test_${chunkCount}/deed.pdf`,
        blobUrl: null,
        mediaType: input.mediaType,
        sizeBytes: input.sizeBytes,
        pageStart: input.pageStart,
        pageEnd: input.pageEnd,
        splitFrom: input.splitFrom,
        fingerprint: input.fingerprint,
        checksumSha256: input.checksumSha256,
        uploadStatus: 'pending',
        uploadAttempts: 0,
        lastErrorMessage: null,
        createdAt: now,
        updatedAt: now,
      };
      chunks.set(chunk.id, chunk);
      const document = documents.get(documentId);
      documents.set(documentId, { ...document, chunkCount: (document.chunkCount || 0) + 1 });
      return chunk;
    },
    async findChunkByFingerprint(jobId, documentId, fingerprint, chunkOrder) {
      return [...chunks.values()].find(chunk =>
        chunk.jobId === jobId
        && chunk.documentId === documentId
        && chunk.fingerprint === fingerprint
        && chunk.chunkOrder === chunkOrder
      ) || null;
    },
    async updateChunk(jobId, chunkId, patch) {
      const existing = chunks.get(chunkId);
      if (!existing || existing.jobId !== jobId) return null;
      const updated = { ...existing, ...patch, updatedAt: now };
      chunks.set(chunkId, updated);
      return updated;
    },
    async listChunks(jobId) {
      return [...chunks.values()].filter(chunk => chunk.jobId === jobId);
    },
    async finalizeUploads(jobId) {
      const jobChunks = [...chunks.values()].filter(chunk => chunk.jobId === jobId);
      if (!jobChunks.length || jobChunks.some(chunk => chunk.uploadStatus !== 'uploaded')) {
        return { ready: false, job: jobs.get(jobId), pendingChunks: jobChunks.filter(chunk => chunk.uploadStatus !== 'uploaded').length || 1 };
      }
      const job = { ...jobs.get(jobId), status: 'ready', totalChunks: jobChunks.length, currentPhase: 'ready', updatedAt: now };
      jobs.set(jobId, job);
      return { ready: true, job, pendingChunks: 0 };
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('POST /api/jobs/:id/documents registers durable document metadata', async () => {
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = createMemoryJobStore();
  const res = mockRes();

  await jobsRouteHandler(mockReq('POST', {
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-fingerprint',
    checksumSha256: 'a'.repeat(64),
  }, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/documents'), res);

  assert(res.statusCode === 201, `Expected 201, got ${res.statusCode}`);
  assert(res.body.document.id === 'doc_test_1', 'Expected document id');
  assert(res.body.document.jobId === 'job_test_1', 'Expected job association');
  assert(res.body.document.originalFilename === 'Deed.pdf', 'Expected filename metadata');
  assert(res.body.document.uploadStatus === 'pending', 'Expected pending upload status');
  assert(!('data' in res.body.document), 'Document response must not include raw content');
});

test('POST /api/jobs/:id/documents/:documentId/chunks registers durable chunk metadata', async () => {
  const store = createMemoryJobStore();
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.createDocument('job_test_1', {
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-fingerprint',
    checksumSha256: 'a'.repeat(64),
  });
  const res = mockRes();

  await jobsRouteHandler(mockReq('POST', {
    chunkOrder: 0,
    originalFilename: 'Deed (pp 1-3).pdf',
    mediaType: 'application/pdf',
    sizeBytes: 65432,
    pageStart: 1,
    pageEnd: 3,
    splitFrom: 'Deed.pdf',
    fingerprint: 'deed-chunk-fingerprint',
    checksumSha256: 'b'.repeat(64),
  }, {}, { id: 'job_test_1', documentId: 'doc_test_1' }, '/api/jobs/job_test_1/documents/doc_test_1/chunks'), res);

  assert(res.statusCode === 201, `Expected 201, got ${res.statusCode}`);
  assert(res.body.chunk.id === 'chk_test_1', 'Expected chunk id');
  assert(res.body.chunk.documentId === 'doc_test_1', 'Expected document association');
  assert(res.body.chunk.pageStart === 1 && res.body.chunk.pageEnd === 3, 'Expected page range');
  assert(res.body.chunk.splitFrom === 'Deed.pdf', 'Expected split source');
  assert(res.body.chunk.blobKey.startsWith('jobs/job_test_1/chunks/chk_test_1/'), 'Expected job-scoped blob key');
});

test('PATCH /api/jobs/:id/chunks/:chunkId updates upload status and GET lists chunks', async () => {
  const store = createMemoryJobStore();
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.createDocument('job_test_1', {
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-fingerprint',
    checksumSha256: 'a'.repeat(64),
  });
  await store.createChunk('job_test_1', 'doc_test_1', {
    chunkOrder: 0,
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-chunk-fingerprint',
    checksumSha256: 'b'.repeat(64),
  });

  const patchRes = mockRes();
  await jobsRouteHandler(mockReq('PATCH', {
    uploadStatus: 'uploaded',
    blobKey: 'jobs/job_test_1/chunks/chk_test_1/deed.pdf',
    blobUrl: 'https://blob.vercel-storage.com/private/deed.pdf',
  }, {}, { id: 'job_test_1', chunkId: 'chk_test_1' }, '/api/jobs/job_test_1/chunks/chk_test_1'), patchRes);

  assert(patchRes.statusCode === 200, `Expected 200, got ${patchRes.statusCode}`);
  assert(patchRes.body.chunk.uploadStatus === 'uploaded', 'Expected uploaded status');
  assert(patchRes.body.chunk.blobUrl.includes('blob.vercel-storage.com'), 'Expected blob URL');

  const listRes = mockRes();
  await jobsRouteHandler(mockReq('GET', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/chunks'), listRes);

  assert(listRes.statusCode === 200, `Expected 200, got ${listRes.statusCode}`);
  assert(listRes.body.chunks.length === 1, 'Expected one chunk');
  assert(listRes.body.chunks[0].uploadStatus === 'uploaded', 'Expected list to include updated status');
});

test('PATCH /api/jobs/:id/chunks/:chunkId rejects uploaded status without a valid Blob pointer', async () => {
  const store = createMemoryJobStore();
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.createDocument('job_test_1', {
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-fingerprint',
    checksumSha256: 'a'.repeat(64),
  });
  await store.createChunk('job_test_1', 'doc_test_1', {
    chunkOrder: 0,
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-chunk-fingerprint',
    checksumSha256: 'b'.repeat(64),
  });

  const missingBlobRes = mockRes();
  await jobsRouteHandler(mockReq('PATCH', {
    uploadStatus: 'uploaded',
  }, {}, { id: 'job_test_1', chunkId: 'chk_test_1' }, '/api/jobs/job_test_1/chunks/chk_test_1'), missingBlobRes);
  assert(missingBlobRes.statusCode === 400, `Expected missing Blob URL rejection, got ${missingBlobRes.statusCode}`);

  const wrongKeyRes = mockRes();
  await jobsRouteHandler(mockReq('PATCH', {
    uploadStatus: 'uploaded',
    blobKey: 'jobs/other_job/chunks/chk_test_1/deed.pdf',
    blobUrl: 'https://blob.vercel-storage.com/private/deed.pdf',
  }, {}, { id: 'job_test_1', chunkId: 'chk_test_1' }, '/api/jobs/job_test_1/chunks/chk_test_1'), wrongKeyRes);
  assert(wrongKeyRes.statusCode === 400, `Expected wrong Blob key rejection, got ${wrongKeyRes.statusCode}`);
});

test('POST durable document and chunk registration is idempotent by fingerprint', async () => {
  const store = createMemoryJobStore();
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;

  const documentPayload = {
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-fingerprint',
    checksumSha256: 'a'.repeat(64),
  };
  const firstDocRes = mockRes();
  await jobsRouteHandler(mockReq('POST', documentPayload, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/documents'), firstDocRes);
  const secondDocRes = mockRes();
  await jobsRouteHandler(mockReq('POST', documentPayload, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/documents'), secondDocRes);
  assert(firstDocRes.statusCode === 201, `Expected first document create, got ${firstDocRes.statusCode}`);
  assert(secondDocRes.statusCode === 200, `Expected duplicate document reuse, got ${secondDocRes.statusCode}`);
  assert(secondDocRes.body.document.id === firstDocRes.body.document.id, 'Expected duplicate document registration to return existing id');

  const chunkPayload = {
    chunkOrder: 0,
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-chunk-fingerprint',
    checksumSha256: 'b'.repeat(64),
  };
  const firstChunkRes = mockRes();
  await jobsRouteHandler(mockReq('POST', chunkPayload, {}, { id: 'job_test_1', documentId: firstDocRes.body.document.id }, `/api/jobs/job_test_1/documents/${firstDocRes.body.document.id}/chunks`), firstChunkRes);
  const secondChunkRes = mockRes();
  await jobsRouteHandler(mockReq('POST', chunkPayload, {}, { id: 'job_test_1', documentId: firstDocRes.body.document.id }, `/api/jobs/job_test_1/documents/${firstDocRes.body.document.id}/chunks`), secondChunkRes);
  assert(firstChunkRes.statusCode === 201, `Expected first chunk create, got ${firstChunkRes.statusCode}`);
  assert(secondChunkRes.statusCode === 200, `Expected duplicate chunk reuse, got ${secondChunkRes.statusCode}`);
  assert(secondChunkRes.body.chunk.id === firstChunkRes.body.chunk.id, 'Expected duplicate chunk registration to return existing id');
});

test('durable upload routes reject terminal jobs and unsupported TIFF metadata', async () => {
  const store = createMemoryJobStore();
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  store.__setJobStatus('job_test_1', 'complete');

  const terminalRes = mockRes();
  await jobsRouteHandler(mockReq('POST', {
    originalFilename: 'After-complete.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'late-fingerprint',
  }, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/documents'), terminalRes);
  assert(terminalRes.statusCode === 409, `Expected terminal job upload mutation rejection, got ${terminalRes.statusCode}`);

  store.__setJobStatus('job_test_1', 'created');
  const tiffRes = mockRes();
  await jobsRouteHandler(mockReq('POST', {
    originalFilename: 'Scan.tiff',
    mediaType: 'image/tiff',
    sizeBytes: 123456,
    fingerprint: 'tiff-fingerprint',
  }, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/documents'), tiffRes);
  assert(tiffRes.statusCode === 400, `Expected TIFF rejection, got ${tiffRes.statusCode}`);
});

test('POST /api/jobs/:id/finalize-uploads marks job ready after all chunks upload', async () => {
  const store = createMemoryJobStore();
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.createDocument('job_test_1', {
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-fingerprint',
    checksumSha256: 'a'.repeat(64),
  });
  await store.createChunk('job_test_1', 'doc_test_1', {
    chunkOrder: 0,
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-chunk-fingerprint',
    checksumSha256: 'b'.repeat(64),
  });
  await store.updateChunk('job_test_1', 'chk_test_1', {
    uploadStatus: 'uploaded',
    blobKey: 'jobs/job_test_1/chunks/chk_test_1/deed.pdf',
    blobUrl: 'https://blob.vercel-storage.com/private/deed.pdf',
  });

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/finalize-uploads'), res);

  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.job.status === 'ready', 'Expected job ready after finalize');
  assert(res.body.pendingChunks === 0, 'Expected no pending chunks');
});

test('POST /api/jobs/:id/finalize-uploads rejects uploaded chunks missing usable Blob metadata', async () => {
  const store = createMemoryJobStore();
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.createDocument('job_test_1', {
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-fingerprint',
    checksumSha256: 'a'.repeat(64),
  });
  await store.createChunk('job_test_1', 'doc_test_1', {
    chunkOrder: 0,
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-chunk-fingerprint',
    checksumSha256: 'b'.repeat(64),
  });
  await store.updateChunk('job_test_1', 'chk_test_1', { uploadStatus: 'uploaded' });

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/finalize-uploads'), res);

  assert(res.statusCode === 409, `Expected invalid uploaded chunk rejection, got ${res.statusCode}`);
  assert(res.body.error.includes('Blob'), `Expected Blob metadata error, got ${res.body.error}`);
});

test('durable upload endpoints reject raw base64 and document contents', async () => {
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = createMemoryJobStore();

  const documentRes = mockRes();
  await jobsRouteHandler(mockReq('POST', {
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-fingerprint',
    data: 'JVBERi0xLjQ=',
  }, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/documents'), documentRes);
  assert(documentRes.statusCode === 400, `Expected document rejection, got ${documentRes.statusCode}`);

  const chunkRes = mockRes();
  await jobsRouteHandler(mockReq('POST', {
    chunkOrder: 0,
    originalFilename: 'Deed.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 123456,
    fingerprint: 'deed-chunk-fingerprint',
    base64: 'JVBERi0xLjQ=',
  }, {}, { id: 'job_test_1', documentId: 'doc_test_1' }, '/api/jobs/job_test_1/documents/doc_test_1/chunks'), chunkRes);
  assert(chunkRes.statusCode === 400, `Expected chunk rejection, got ${chunkRes.statusCode}`);
});

test('Blob upload endpoint keeps APP_PASSWORD for token requests but allows signed completion callbacks', () => {
  const source = readFileSync(join(root, 'api/blob/upload.js'), 'utf8');
  assert(source.includes('enforceJobRateLimit'), 'Blob upload token requests should use the job write rate limiter');
  assert(source.includes("uploadEventType === 'blob.upload-completed'"), 'Expected Blob completion callback detection');
  assert(source.includes('!isBlobCompletionCallback && !requireJobPassword'), 'Token requests should require APP_PASSWORD while completion callbacks reach handleUpload signature verification');
  assert(!source.includes("'image/tiff'"), 'Blob upload content types should not include TIFF when analyze API cannot process TIFF images');
});

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  } finally {
    delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
