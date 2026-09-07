import { getClientIp } from '../api/_lib/client-ip.js';
import {
  applyAbstractionClaim,
  deriveSynthesisProgress,
  requireJobPassword,
  resetJobRateLimits,
} from '../api/_lib/jobs.js';
import { resetSharedRateLimits } from '../api/_lib/shared-rate-limit.js';
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
      const started = Date.now();
      const ok = await requireJobPassword(mockReq({
        headers: {
          'x-app-password': 'wrong',
          'x-forwarded-for': `${i}.0.0.1, 198.51.100.20`,
        },
      }), res, `req_${i}`);
      assert(ok === false && res.statusCode === 401, `Expected 401 on attempt ${i + 1}, got ${res.statusCode}`);
      assert(Date.now() - started >= 400, 'Failed pre-auth must keep the ~500ms delay');
    }
    const locked = mockRes();
    await requireJobPassword(mockReq({
      headers: {
        'x-app-password': 'wrong',
        'x-forwarded-for': '9.9.9.9, 198.51.100.20',
      },
    }), locked, 'req_lock');
    assert(locked.statusCode === 429, `Expected 429 after five failures, got ${locked.statusCode}`);

    const otherHop = mockRes();
    await requireJobPassword(mockReq({
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
      abstractionReclaims: 0,
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
      const updated = applyAbstractionClaim(chunk, options);
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
  assert(chunks.get('chk_1').abstractionAttempts === 1, `Batch fallback must not burn an extra attempt, got ${chunks.get('chk_1').abstractionAttempts}`);
  assert(chunks.get('chk_1').abstractionReclaims >= 1, 'Same-worker fallback should increment the reclaim counter');
});

test('same-worker reclaim uses a reclaim cap and does not burn extra attempts', () => {
  let chunk = {
    id: 'chk_poison',
    abstractionStatus: 'pending',
    abstractionAttempts: 0,
    abstractionReclaims: 0,
  };
  chunk = applyAbstractionClaim(chunk, { workerId: 'wkr_1', maxAttempts: 5, maxReclaims: 3, leaseMs: 90_000 });
  assert(chunk.abstractionStatus === 'processing', 'First claim should process');
  assert(chunk.abstractionAttempts === 1, 'First claim increments attempts');
  assert(chunk.abstractionReclaims === 0, 'First claim is not a reclaim');
  for (let i = 1; i <= 3; i++) {
    chunk = applyAbstractionClaim(chunk, { workerId: 'wkr_1', maxAttempts: 5, maxReclaims: 3, leaseMs: 90_000 });
    assert(chunk.abstractionAttempts === 1, `Reclaim ${i} must not increment attempts`);
    assert(chunk.abstractionReclaims === i, `Expected reclaims ${i}, got ${chunk.abstractionReclaims}`);
    assert(chunk.abstractionStatus === 'processing', `Reclaim ${i} should stay processing under the cap`);
  }
  chunk = applyAbstractionClaim(chunk, { workerId: 'wkr_1', maxAttempts: 5, maxReclaims: 3, leaseMs: 90_000 });
  assert(chunk.abstractionStatus === 'failed', 'Over-cap reclaim must fail the chunk');
  assert(chunk.abstractionErrorType === 'max_attempts', 'Expected max_attempts');
  assert(chunk.abstractionAttempts === 1, 'Failed reclaim must not punish with an extra attempt');
  assert(chunk.abstractionReclaims === 4, 'Cap failure records the extra reclaim');
});

test('password strikes persist across instances via shared limiter store', async () => {
  const previous = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'correct-horse';
  resetJobRateLimits();
  const objects = new Map();
  globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__ = {
    async read(key) {
      const row = objects.get(key);
      return row ? { data: { ...row.data }, generation: row.generation } : { data: null, generation: 0 };
    },
    async write(key, data, generation) {
      const existing = objects.get(key);
      const current = existing?.generation ?? 0;
      if (generation !== current) {
        const err = new Error('precondition');
        err.code = 412;
        throw err;
      }
      objects.set(key, { data: { ...data }, generation: current + 1 });
    },
  };
  try {
    for (let i = 0; i < 5; i++) {
      const res = mockRes();
      await requireJobPassword(mockReq({
        headers: { 'x-app-password': 'wrong', 'x-forwarded-for': '203.0.113.90' },
      }), res, `gcs_${i}`);
      assert(res.statusCode === 401, `Expected 401, got ${res.statusCode}`);
    }
    resetSharedRateLimits();
    const locked = mockRes();
    await requireJobPassword(mockReq({
      headers: { 'x-app-password': 'wrong', 'x-forwarded-for': '203.0.113.90' },
    }), locked, 'gcs_lock');
    assert(locked.statusCode === 429, `Expected shared lockout after memory reset, got ${locked.statusCode}`);
    assert(objects.size >= 1, 'Expected a persisted rate-limit object');
  } finally {
    delete globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
    resetJobRateLimits();
    if (previous === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = previous;
  }
});

test('successful auth uses a short TTL cache instead of a GCS RMW each request', async () => {
  const previous = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'correct-horse';
  resetJobRateLimits();
  const objects = new Map();
  let reads = 0;
  let writes = 0;
  globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__ = {
    async read(key) {
      reads += 1;
      const row = objects.get(key);
      return row ? { data: { ...row.data }, generation: row.generation } : { data: null, generation: 0 };
    },
    async write(key, data, generation) {
      writes += 1;
      const existing = objects.get(key);
      const current = existing?.generation ?? 0;
      if (generation !== current) {
        const err = new Error('precondition');
        err.code = 412;
        throw err;
      }
      objects.set(key, { data: { ...data }, generation: current + 1 });
    },
  };
  try {
    for (let i = 0; i < 4; i++) {
      const res = mockRes();
      const ok = await requireJobPassword(mockReq({
        headers: { 'x-app-password': 'correct-horse', 'x-forwarded-for': '203.0.113.92' },
      }), res, `cache_${i}`);
      assert(ok === true, `Expected successful auth, got ${res.statusCode}`);
    }
    assert(reads === 1, `Expected one shared read inside the TTL, got ${reads}`);
    assert(writes === 0, `Successful auth must not RMW the shared store, got ${writes} writes`);
  } finally {
    delete globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
    resetJobRateLimits();
    if (previous === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = previous;
  }
});

test('shared limiter fails closed when store errors are not 412', async () => {
  const previous = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'correct-horse';
  resetJobRateLimits();
  globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__ = {
    async read() {
      const err = new Error('backend exploded');
      err.code = 500;
      throw err;
    },
    async write() {
      throw new Error('write should not run');
    },
  };
  try {
    const res = mockRes();
    const ok = await requireJobPassword(mockReq({
      headers: { 'x-app-password': 'correct-horse', 'x-forwarded-for': '203.0.113.93' },
    }), res, 'gcs_down');
    assert(ok === false && res.statusCode === 503, `Expected fail-closed 503, got ${res.statusCode}`);
  } finally {
    delete globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
    resetJobRateLimits();
    if (previous === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = previous;
  }
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
