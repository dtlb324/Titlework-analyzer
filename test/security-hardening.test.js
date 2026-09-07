import { getClientIp } from '../api/_lib/client-ip.js';
import {
  deriveSynthesisProgress,
  requireJobPassword,
  resetJobRateLimits,
} from '../api/_lib/jobs.js';
import jobHandler from '../api/jobs/[...path].js';
import analyzeHandler from '../api/analyze.js';
import { processMultiChunkAbstraction } from '../api/_lib/abstraction-batch.js';
import { createServer } from '../server.js';
import { request } from 'http';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
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

function mockReq({ method = 'GET', headers = {}, url = '/api/jobs/job_test_1', body = undefined, remoteAddress = '127.0.0.1' } = {}) {
  return {
    method,
    headers,
    url,
    body,
    query: { path: url.replace(/^\/api\/jobs\//, '').split('/').filter(Boolean) },
    socket: { remoteAddress },
  };
}

test('getClientIp trusts the rightmost X-Forwarded-For hop', () => {
  const spoofed = getClientIp({
    headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.9' },
    socket: { remoteAddress: '10.0.0.1' },
  });
  assert(spoofed === '203.0.113.9', `Expected rightmost hop, got ${spoofed}`);
  const rotating = getClientIp({
    headers: { 'x-forwarded-for': '192.0.2.55, 203.0.113.9' },
    socket: { remoteAddress: '10.0.0.1' },
  });
  assert(rotating === '203.0.113.9', 'Rotating leftmost XFF must not change the trusted IP');
  const local = getClientIp({ headers: {}, socket: { remoteAddress: '127.0.0.1' } });
  assert(local === '127.0.0.1', 'Without XFF, use the socket address');
});

test('rotating leftmost XFF cannot bypass job password strike limit', async () => {
  const previous = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'correct-horse';
  resetJobRateLimits();
  try {
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      const ok = requireJobPassword(mockReq({
        headers: {
          'x-app-password': 'wrong',
          'x-forwarded-for': `${i}.0.0.1, 198.51.100.20`,
        },
      }), res, `req_${i}`);
      assert(ok === false && res.statusCode === 401, `Expected 401 on attempt ${i + 1}, got ${res.statusCode}`);
    }
    const locked = mockRes();
    requireJobPassword(mockReq({
      headers: {
        'x-app-password': 'wrong',
        'x-forwarded-for': '9.9.9.9, 198.51.100.20',
      },
    }), locked, 'req_lock');
    assert(locked.statusCode === 429, `Expected 429 after five failures, got ${locked.statusCode}`);

    const otherHop = mockRes();
    requireJobPassword(mockReq({
      headers: {
        'x-app-password': 'wrong',
        'x-forwarded-for': '9.9.9.9, 198.51.100.21',
      },
    }), otherHop, 'req_other');
    assert(otherHop.statusCode === 401, `A different trusted hop should still be 401, got ${otherHop.statusCode}`);
  } finally {
    resetJobRateLimits();
    if (previous === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = previous;
  }
});

test('GET /api/jobs/:id is password-throttled', async () => {
  const previous = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'correct-horse';
  resetJobRateLimits();
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = {
    async getJob() { return { id: 'job_test_1', status: 'created' }; },
  };
  try {
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      await jobHandler(mockReq({
        method: 'GET',
        url: '/api/jobs/job_test_1',
        headers: {
          'x-app-password': 'nope',
          'x-forwarded-for': '203.0.113.80',
        },
      }), res);
      assert(res.statusCode === 401, `Expected GET 401, got ${res.statusCode}`);
    }
    const locked = mockRes();
    await jobHandler(mockReq({
      method: 'GET',
      url: '/api/jobs/job_test_1',
      headers: {
        'x-app-password': 'nope',
        'x-forwarded-for': '203.0.113.80',
      },
    }), locked);
    assert(locked.statusCode === 429, `Expected GET 429 after strikes, got ${locked.statusCode}`);
  } finally {
    resetJobRateLimits();
    delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
    if (previous === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = previous;
  }
});

test('analyze password check uses trusted hop before inspecting the body', async () => {
  const previous = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'correct-horse';
  try {
    const res = mockRes();
    await analyzeHandler(mockReq({
      method: 'POST',
      url: '/api/analyze',
      headers: {
        'x-app-password': 'wrong',
        'x-forwarded-for': '8.8.8.8, 203.0.113.40',
      },
      body: { ping: true },
    }), res);
    assert(res.statusCode === 401, `Expected analyze 401, got ${res.statusCode}`);
  } finally {
    if (previous === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = previous;
  }
});

test('unauthenticated API requests are rejected without buffering the body', async () => {
  const previous = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'correct-horse';
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await new Promise((resolve, reject) => {
      const req = request({
        method: 'POST',
        path: '/api/analyze',
        port: server.address().port,
        host: '127.0.0.1',
        headers: {
          'content-type': 'application/json',
          'x-app-password': 'wrong',
          'x-forwarded-for': '198.51.100.77',
        },
      }, res => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode, text }));
      });
      req.on('error', err => {
        if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
          resolve({ statusCode: 0, text: '', reset: true });
          return;
        }
        reject(err);
      });
      req.write('{"ping":true}');
      req.end();
    });
    assert(result.statusCode === 401 || result.reset, `Expected 401 or connection reset, got ${result.statusCode}`);
    if (result.text) assert(!result.text.includes('ok":true'), 'Must not run the ping handler');
  } finally {
    await new Promise(resolve => server.close(resolve));
    if (previous === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = previous;
  }
});

test('empty failed opinions still count as a saved result', () => {
  const emptyFailed = deriveSynthesisProgress({
    job: { status: 'failed' },
    counts: { total: 2, pending: 0, processing: 0, retry_wait: 0, complete: 2, failed: 0 },
    hasResultRow: true,
    mergeLeaseHeld: false,
  });
  assert(emptyFailed.hasResult === true, 'A result row with an empty opinion is still a result');
  assert(emptyFailed.mergeInProgress === false, 'Failed jobs must not stay mergeInProgress');

  const awaitingMerge = deriveSynthesisProgress({
    job: { status: 'synthesizing' },
    counts: { total: 2, pending: 0, processing: 0, retry_wait: 0, complete: 2, failed: 0 },
    hasResultRow: false,
    mergeLeaseHeld: false,
  });
  assert(awaitingMerge.mergeInProgress === true, 'Segments done with no result is still merge-in-progress');

  const leaseHeld = deriveSynthesisProgress({
    job: { status: 'synthesizing' },
    counts: { total: 2, pending: 0, processing: 0, retry_wait: 0, complete: 2, failed: 0 },
    hasResultRow: false,
    mergeLeaseHeld: true,
  });
  assert(leaseHeld.mergeLeaseHeld === true, 'Lease held should be reported');
});

test('batch fallback can re-claim chunks already leased to the same worker', async () => {
  const chunks = new Map();
  const workerId = 'wkr_batch';
  function seed(id) {
    chunks.set(id, {
      id,
      jobId: 'job_1',
      documentId: 'doc_1',
      chunkOrder: Number(id.replace(/\D/g, '')) || 0,
      originalFilename: `${id}.pdf`,
      mediaType: 'application/pdf',
      uploadStatus: 'uploaded',
      abstractionStatus: 'pending',
      abstractionAttempts: 0,
    });
  }
  seed('chk_1');
  seed('chk_2');
  const store = {
    async claimChunkForAbstraction(jobId, chunkId, options = {}) {
      const chunk = chunks.get(chunkId);
      if (!chunk) return null;
      const sameWorker = chunk.abstractionStatus === 'processing' && chunk.abstractionWorkerId === options.workerId;
      const pending = chunk.abstractionStatus === 'pending';
      if (!sameWorker && !pending) return null;
      const updated = {
        ...chunk,
        abstractionStatus: 'processing',
        abstractionWorkerId: options.workerId,
        abstractionAttempts: sameWorker ? chunk.abstractionAttempts : chunk.abstractionAttempts + 1,
        abstractionLeaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
      };
      chunks.set(chunkId, updated);
      return updated;
    },
    async tryReuseExistingAbstract() { return null; },
    async getDocumentAbstractByChunkId() { return null; },
    async saveDocumentAbstract(record) {
      const chunk = chunks.get(record.chunkId);
      chunks.set(record.chunkId, { ...chunk, abstractionStatus: 'completed' });
      return record;
    },
    async markChunkAbstractionFailed(jobId, chunkId) {
      const chunk = chunks.get(chunkId);
      chunks.set(chunkId, { ...chunk, abstractionStatus: 'failed' });
      return chunks.get(chunkId);
    },
    async markChunkAbstractionRetryWait(jobId, chunkId) {
      return this.markChunkAbstractionFailed(jobId, chunkId);
    },
  };
  let batchCalls = 0;
  const results = await processMultiChunkAbstraction([chunks.get('chk_1'), chunks.get('chk_2')], {
    store,
    workerId,
    leaseMs: 90_000,
    blobLoader: async () => ({ bytes: Buffer.from('%PDF-1.4'), mediaType: 'application/pdf' }),
    modelClient: async () => {
      batchCalls += 1;
      if (batchCalls === 1) {
        const err = new Error('batch exploded');
        err.status = 500;
        throw err;
      }
      return { text: 'DOC TYPE: Deed\nGRANTOR: A\nGRANTEE: B\nCONVEYANCE: 100%\nLEGAL DESC: Tract\n', model: 'gemini-2.5-flash', usage: {} };
    },
  });
  const skipped = results.filter(result => result.status === 'skipped');
  assert(skipped.length === 0, `Same-worker fallback must not skip leased chunks, got ${JSON.stringify(results)}`);
  assert(results.some(result => result.status === 'completed' || result.status === 'failed' || result.status === 'retry_wait'),
    `Expected fallback to process chunks, got ${JSON.stringify(results.map(r => r.status))}`);
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
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
