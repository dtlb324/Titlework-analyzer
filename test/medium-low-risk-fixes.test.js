import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import {
  computeRetryBackoff,
  extractRetryAfterMs,
  processChunkAbstraction,
  retryChunkAbstraction,
} from '../api/_lib/abstraction.js';
import { processMultiChunkAbstraction } from '../api/_lib/abstraction-batch.js';
import { buildSystemParam } from '../api/_lib/anthropic-request.js';
import { defaultSleep, runWorkerDrain } from '../api/_lib/cloud-run-worker.js';
import { deleteGeminiFile, uploadGeminiFile } from '../api/_lib/gemini-files.js';
import { invokeGeminiGenerateContent } from '../api/_lib/gemini-request.js';
import {
  isValidStatusTransition,
  parseJsonBody,
  resetJobRateLimits,
  validateCreateChunkInput,
  validateCreateDocumentInput,
  validateSaveJobResultInput,
} from '../api/_lib/jobs.js';
import { invokeAnthropicModel, invokeAnthropicModelStream } from '../api/_lib/model-client.js';
import { createApiRequest, readNodeRequestBody } from '../api/_lib/node-http-adapter.js';
import { postOpenRouterChat } from '../api/_lib/openrouter-request.js';
import { consumeOpenRouterMessageStream } from '../api/_lib/openrouter-stream.js';
import { processAbstractionBatch } from '../api/_lib/queue.js';
import {
  answerFollowupQuestion,
  getSynthesisConfig,
  processSynthesisJob,
} from '../api/_lib/synthesis.js';
import analyzeHandler from '../api/analyze.js';
import blobUploadHandler from '../api/blob/upload.js';
import jobPathHandler from '../api/jobs/[...path].js';
import { createOcrCompareHandler } from '../api/ocr-compare.js';
import { createServer } from '../server.js';
import { createWorkerHealthServer } from '../worker.js';
import { buildReport as buildOcrComparisonReport, scoreField as scoreOcrField } from '../scripts/compare-ocr-models.mjs';
import { generateFinalOpinion, resolveMode as resolveCompareMode } from '../scripts/compare-final-opinion.mjs';
import { validateRequiredEnv } from '../scripts/verify-release.mjs';
import { disposeAll, jsonResponse, loadIndex, StubElement, tick } from './helpers/browser-index-harness.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jobsSource = readFileSync(join(root, 'api/_lib/jobs.js'), 'utf8');
const workerSource = readFileSync(join(root, 'worker.js'), 'utf8');
const ocrCompareUiSource = readFileSync(join(root, 'public/ocr-compare.js'), 'utf8');
const compareFinalOpinionSource = readFileSync(join(root, 'scripts/compare-final-opinion.mjs'), 'utf8');
const dockerignoreSource = readFileSync(join(root, '.dockerignore'), 'utf8');

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function extractJobsMethod(name, ctx) {
  const marker = `    async ${name}(`;
  const start = jobsSource.indexOf(marker);
  assert(start >= 0, `Could not locate ${name} in api/_lib/jobs.js`);
  const bodyStart = jobsSource.indexOf(') {', start);
  assert(bodyStart >= 0, `Could not locate body start of ${name}`);
  let depth = 0;
  let end = -1;
  for (let i = bodyStart + 2; i < jobsSource.length; i++) {
    const ch = jobsSource[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  assert(end > start, `Could not parse end of ${name}`);
  return runInNewContext(`({ ${jobsSource.slice(start, end)} })`, ctx)[name];
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

function mockReq({ method = 'POST', url = '/api/jobs/job_1', headers = {}, body = undefined, remoteAddress = '203.0.113.10', query } = {}) {
  return {
    method,
    url,
    headers,
    body,
    query: query ?? { path: url.replace(/^\/api\/jobs\//, '').split('/').filter(Boolean) },
    socket: { remoteAddress },
  };
}

function httpCall(server, { method = 'GET', path = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: '127.0.0.1',
      port: server.address().port,
      method,
      path,
      headers,
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

async function withEnv(overrides, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(overrides)) {
    previous[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// ---- M1: Case-insensitive Content-Type + reject falsy/non-object JSON primitives ----

test('M1: readNodeRequestBody handles Application/JSON and rejects JSON primitives with 400', async () => {
  const validStream = Readable.from([Buffer.from('{"ok":true}')]);
  validStream.headers = { 'content-type': 'Application/JSON; charset=utf-8' };
  const parsed = await readNodeRequestBody(validStream);
  assert.deepEqual(parsed, { ok: true });

  for (const raw of ['null', 'false', '0', '""', '[1,2]']) {
    const stream = Readable.from([Buffer.from(raw)]);
    stream.headers = { 'content-type': 'Application/JSON' };
    let err = null;
    try {
      await readNodeRequestBody(stream);
    } catch (e) {
      err = e;
    }
    assert.equal(err?.statusCode, 400, `Expected 400 for ${raw}, got ${err?.statusCode}`);
  }
});

test('M1: parseJsonBody rejects JSON primitive strings/arrays while preserving bodyless null/undefined', () => {
  assert.deepEqual(parseJsonBody(undefined), {});
  assert.deepEqual(parseJsonBody(null), {});
  assert.deepEqual(parseJsonBody(''), {});
  assert.deepEqual(parseJsonBody('{"a":1}'), { a: 1 });
  for (const bad of ['null', 'false', '0', '""', '[]', false, 0, [1]]) {
    assert.throws(() => parseJsonBody(bad), `Expected parseJsonBody(${JSON.stringify(bad)}) to throw`);
  }
});

test('M1: HTTP POST with body "null" returns 400 promptly instead of hanging socket', async () => {
  const prevStore = globalThis.__TITLE_ANALYZER_JOB_STORE__;
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = {
    async getJob(id) { return { id, status: 'uploading' }; },
  };
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await withEnv({ APP_PASSWORD: '' }, async () => {
      const res = await httpCall(server, {
        method: 'POST',
        path: '/api/jobs/job_1/documents',
        headers: { 'content-type': 'Application/JSON' },
        body: 'null',
      });
      assert.equal(res.statusCode, 400);
    });
  } finally {
    globalThis.__TITLE_ANALYZER_JOB_STORE__ = prevStore;
    await new Promise(resolve => server.close(resolve));
  }
});

// ---- M2: ?path= query param cannot override /api/jobs/* dispatch & URIError returns 400 ----

test('M2: createApiRequest ignores ?path= override and malformed percent-encoding returns 400', async () => {
  const url = new URL('http://localhost/api/jobs/job_A/chunks?path=job_B');
  const apiReq = createApiRequest({ method: 'GET', headers: {}, socket: {} }, url);
  assert.deepEqual(apiReq.query.path, ['job_A', 'chunks']);

  const prevStore = globalThis.__TITLE_ANALYZER_JOB_STORE__;
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = { async getJob() { return null; } };
  try {
    await withEnv({ APP_PASSWORD: '' }, async () => {
      resetJobRateLimits();
      const res = mockRes();
      await jobPathHandler(mockReq({
        method: 'GET',
        url: '/api/jobs/%E0%A4%A',
        query: {},
      }), res);
      assert.equal(res.statusCode, 400);
      assert.match(res.body.error, /malformed/i);
    });
  } finally {
    globalThis.__TITLE_ANALYZER_JOB_STORE__ = prevStore;
  }
});

// ---- M3: Uncaught TypeError / Postgres INT4 22003 HTTP 500s & chunk retry sanitization ----

test('M3: retryChunkAbstraction throws 409 on lost reset and handleChunkRetry strips internal chunk fields', async () => {
  const lostStore = {
    async getJob() { return { id: 'job_1', status: 'abstracting' }; },
    async getChunk() { return { id: 'chk_1', jobId: 'job_1', abstractionStatus: 'failed' }; },
    async resetChunkAbstraction() { return null; },
  };
  let err = null;
  try {
    await retryChunkAbstraction('job_1', 'chk_1', { store: lostStore });
  } catch (e) {
    err = e;
  }
  assert.equal(err?.statusCode, 409);

  const prevStore = globalThis.__TITLE_ANALYZER_JOB_STORE__;
  const prevModel = globalThis.__TITLE_ANALYZER_MODEL_CLIENT__;
  const prevBlob = globalThis.__TITLE_ANALYZER_BLOB_LOADER__;
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = {
    async getJob() { return { id: 'job_1', status: 'abstracting' }; },
    async getChunk() {
      return {
        id: 'chk_1',
        jobId: 'job_1',
        documentId: 'doc_1',
        chunkOrder: 0,
        originalFilename: 'a.csv',
        mediaType: 'text/csv',
        blobUrl: 'gs://secret-bucket/jobs/job_1/chunks/chk_1/a.csv',
        blobKey: 'jobs/job_1/chunks/chk_1/a.csv',
        abstractionStatus: 'failed',
        abstractionAttempts: 1,
      };
    },
    async resetChunkAbstraction() {
      return {
        id: 'chk_1',
        jobId: 'job_1',
        documentId: 'doc_1',
        chunkOrder: 0,
        originalFilename: 'a.csv',
        mediaType: 'text/csv',
        uploadStatus: 'uploaded',
        abstractionStatus: 'pending',
        abstractionAttempts: 1,
      };
    },
    async claimChunkForAbstraction() {
      return {
        id: 'chk_1',
        jobId: 'job_1',
        documentId: 'doc_1',
        chunkOrder: 0,
        originalFilename: 'a.csv',
        mediaType: 'text/csv',
        uploadStatus: 'uploaded',
        abstractionStatus: 'processing',
        abstractionAttempts: 2,
      };
    },
    async saveDocumentAbstract() { return { id: 'abs_1' }; },
    async getAbstractionStatus() {
      return {
        total: 1,
        pending: 0,
        processing: 0,
        completed: 1,
        failed: 0,
        retry_wait: 0,
        failedChunks: [{
          id: 'chk_other',
          documentId: 'doc_2',
          chunkOrder: 1,
          originalFilename: 'b.pdf',
          mediaType: 'application/pdf',
          blobUrl: 'gs://secret-bucket/b.pdf',
          blobKey: 'secret-key',
          abstractionWorkerId: 'wkr_secret',
        }],
      };
    },
  };
  globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = async () => ({
    bytes: Buffer.from('a,b\n1,2'),
    mediaType: 'text/csv',
  });
  globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = async () => ({
    text: 'DOC TYPE: Deed\nGRANTOR: Alice\nGRANTEE: Bob\nDATE EXECUTED: 2020-01-01\nDATE RECORDED: 2020-01-02\nRECORDING REF: Vol 1 Page 2\nLEGAL DESC: Sec 1\nCONFIDENCE: high',
    model: 'gemini-3.1-flash-lite',
    usage: { input_tokens: 10, output_tokens: 10 },
  });
  try {
    await withEnv({ APP_PASSWORD: 'secret' }, async () => {
      resetJobRateLimits();
      const res = mockRes();
      await jobPathHandler(mockReq({
        method: 'POST',
        url: '/api/jobs/job_1/chunks/chk_1/retry',
        headers: { 'x-app-password': 'secret' },
      }), res);
      assert.equal(res.statusCode, 200);
      const serialized = JSON.stringify(res.body);
      assert(!serialized.includes('secret-bucket'), 'Must not leak blobUrl');
      assert(!serialized.includes('secret-key'), 'Must not leak blobKey');
      assert(!serialized.includes('wkr_secret'), 'Must not leak workerId');
    });
  } finally {
    globalThis.__TITLE_ANALYZER_JOB_STORE__ = prevStore;
    globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ = prevModel;
    globalThis.__TITLE_ANALYZER_BLOB_LOADER__ = prevBlob;
  }
});

test('M3: analyze rejects [null] messages/content with 400, INT4 validators reject >2147483647, and openrouter-stream tolerates data: null', async () => {
  await withEnv({ APP_PASSWORD: '', GEMINI_API_KEY: 'test-key' }, async () => {
    for (const messages of [[null], [{ role: 'user', content: [null] }]]) {
      const res = mockRes();
      await analyzeHandler(mockReq({
        method: 'POST',
        url: '/api/analyze',
        body: { model: 'gemini-3.1-flash-lite', messages },
      }), res);
      assert.equal(res.statusCode, 400);
    }
  });

  const overInt4 = 2147483648;
  assert.equal(validateCreateDocumentInput({
    originalFilename: 'a.pdf',
    mediaType: 'application/pdf',
    sizeBytes: overInt4,
  }).valid, false);
  assert.equal(validateCreateDocumentInput({
    originalFilename: 'a.pdf',
    mediaType: 'application/pdf',
    sizeBytes: 10,
    pageStart: 1,
    pageEnd: overInt4,
  }).valid, false);
  assert.equal(validateCreateChunkInput({
    originalFilename: 'a.pdf',
    mediaType: 'application/pdf',
    sizeBytes: overInt4,
    fingerprint: 'fp',
  }).valid, false);
  for (const field of ['inputTokens', 'outputTokens', 'payloadBytes', 'synthesisDurationMs']) {
    const check = validateSaveJobResultInput({ finalTitleOpinion: 'ok', [field]: overInt4 });
    assert.equal(check.valid, false, `Expected ${field} > INT4_MAX to be rejected`);
    assert.equal(check.statusCode, 400);
  }

  const ssePayload = [
    'data: null\n\n',
    'data: {"model":"m1","choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const line of ssePayload) controller.enqueue(new TextEncoder().encode(line));
      controller.close();
    },
  });
  const streamed = await consumeOpenRouterMessageStream(stream);
  assert.equal(streamed.text, 'hi');
});

// ---- M4: HEAD / and early abort handling on static server ----

test('M4: server handles HEAD / without streaming body and closes cleanly on abort', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const headRes = await httpCall(server, { method: 'HEAD', path: '/' });
    assert.equal(headRes.statusCode, 200);
    assert(Number(headRes.headers['content-length']) > 0);
    assert.equal(headRes.body, '');

    const headVendor = await httpCall(server, { method: 'HEAD', path: '/vendor/pdf-lib/pdf-lib.min.js' });
    assert.equal(headVendor.statusCode, 200);
    assert(Number(headVendor.headers['content-length']) > 0);
    assert.equal(headVendor.body, '');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

// ---- M5: Worker drain SIGTERM abort forwarding, poison-job cap, and defaultSleep listener cleanup ----

test('M5: worker health server forwards signal to drain, poison jobs exit drain quickly, and defaultSleep cleans up listeners', async () => {
  const controller = new AbortController();
  let receivedSignal = null;
  const server = createWorkerHealthServer({
    signal: controller.signal,
    drain: async ({ signal }) => {
      receivedSignal = signal;
      return { iterations: 1, idleCycles: 1, aborted: Boolean(signal?.aborted) };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await httpCall(server, { method: 'POST', path: '/internal/drain' });
    assert.equal(res.statusCode, 200);
    assert.equal(receivedSignal, controller.signal);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }

  let attempts = 0;
  const poisonResult = await runWorkerDrain({
    store: {
      async listRunnableAbstractionJobIds() { return ['job_poison']; },
      async listRunnableSynthesisJobIds() { return []; },
    },
    processAbstraction: async () => {
      attempts += 1;
      throw new Error('persistent failure');
    },
    sleep: async () => {},
  });
  assert.equal(attempts, 3, 'Expected poison drain to stop after 3 consecutive error cycles');
  assert.equal(poisonResult.iterations, 3);

  const extController = new AbortController();
  const abortDrainPromise = runWorkerDrain({
    signal: extController.signal,
    drainBudgetMs: 60_000,
    store: {
      async listRunnableAbstractionJobIds() { return ['job_slow']; },
      async listRunnableSynthesisJobIds() { return []; },
    },
    processAbstraction: async () => {
      extController.abort();
    },
    sleep: async () => {},
  });
  const abortedResult = await abortDrainPromise;
  assert.equal(abortedResult.aborted, true);

  let addCalls = 0;
  let removeCalls = 0;
  const fakeSignal = {
    aborted: false,
    addEventListener(type, fn) { if (type === 'abort') addCalls += 1; },
    removeEventListener(type, fn) { if (type === 'abort') removeCalls += 1; },
  };
  await defaultSleep(5, fakeSignal);
  assert.equal(addCalls, 1);
  assert.equal(removeCalls, 1, 'Expected defaultSleep to remove abort listener on timer completion');
});

// ---- M6: Timeout signals on Gemini Files, invokeGeminiGenerateContent, and postOpenRouterChat ----

test('M6: Gemini Files, invokeGeminiGenerateContent, and postOpenRouterChat attach AbortSignal to fetch by default', async () => {
  const prevFetch = globalThis.fetch;
  const seenSignals = [];
  globalThis.fetch = async (url, init = {}) => {
    seenSignals.push({ url: String(url), hasSignal: Boolean(init.signal) });
    if (String(url).includes('/upload/')) {
      return { ok: true, status: 200, json: async () => ({ file: { uri: 'https://files.invalid/f1', name: 'files/f1', state: 'ACTIVE' } }) };
    }
    if (String(url).includes('/files/f1') && init.method === 'DELETE') {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    if (String(url).includes('/files/f1')) {
      return { ok: true, status: 200, json: async () => ({ state: 'ACTIVE' }) };
    }
    if (String(url).includes(':generateContent')) {
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ model: 'm', choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: {} }),
    };
  };
  try {
    await withEnv({ GEMINI_API_KEY: 'gem-test', OPENROUTER_API_KEY: 'or-test' }, async () => {
      await uploadGeminiFile(Buffer.from('abc'), 'application/pdf', 'doc.pdf');
      await deleteGeminiFile('files/f1');
      await invokeGeminiGenerateContent({ model: 'gemini-3.1-flash-lite', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] });
      await postOpenRouterChat({ model: 'google/gemini-3.1-flash-lite', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] });
    });
    assert.equal(seenSignals.length, 5);
    for (const item of seenSignals) {
      assert.equal(item.hasSignal, true, `Expected fetch(${item.url}) to carry an AbortSignal`);
    }
  } finally {
    globalThis.fetch = prevFetch;
  }
});

// ---- M7: Batch escalation truncation, 429/504 no fallbackToSingles amplification, and queue deadline ----

test('M7: batch escalation truncation fails cleanly without saving Tier 1 abstract; 429/504 schedules retry_wait; queue honors deadline', async () => {
  const chunks = [
    { id: 'chk_1', jobId: 'job_1', documentId: 'doc_1', chunkOrder: 0, originalFilename: 'a.csv', mediaType: 'text/csv', uploadStatus: 'uploaded', abstractionStatus: 'pending', abstractionAttempts: 0 },
    { id: 'chk_2', jobId: 'job_1', documentId: 'doc_2', chunkOrder: 1, originalFilename: 'b.csv', mediaType: 'text/csv', uploadStatus: 'uploaded', abstractionStatus: 'pending', abstractionAttempts: 0 },
  ];
  const savedAbstracts = [];
  const failedMarks = [];
  const retryWaits = [];
  const makeBatchStore = () => ({
    async claimChunkForAbstraction(jobId, chunkId) {
      const c = chunks.find(item => item.id === chunkId);
      return { ...c, abstractionStatus: 'processing', abstractionAttempts: 1, abstractionWorkerId: 'wkr_1' };
    },
    async saveDocumentAbstract(rec) { savedAbstracts.push(rec); return rec; },
    async markChunkAbstractionFailed(jobId, chunkId, failure) { failedMarks.push({ chunkId, failure }); return { id: chunkId }; },
    async markChunkAbstractionRetryWait(jobId, chunkId, failure) { retryWaits.push({ chunkId, failure }); return { id: chunkId }; },
  });

  let modelCalls = 0;
  const resTrunc = await processMultiChunkAbstraction(chunks, {
    store: makeBatchStore(),
    workerId: 'wkr_1',
    escalationEnabled: true,
    escalationModel: 'claude-sonnet-5-5',
    blobLoader: async () => ({ bytes: Buffer.from('a,b\n1,2'), mediaType: 'text/csv' }),
    modelClient: async req => {
      modelCalls += 1;
      if (req.escalation) {
        return { text: 'PARTIAL TRUNCATED', model: 'claude-sonnet-5-5', stopReason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 100 } };
      }
      return {
        text: JSON.stringify([
          { docIndex: 1, abstract: 'DOC TYPE: Deed\nGRANTOR: Alice\nCONFIDENCE: low' },
          { docIndex: 2, abstract: 'DOC TYPE: Deed\nGRANTOR: Bob\nGRANTEE: Carol\nDATE EXECUTED: 2020-01-01\nDATE RECORDED: 2020-01-02\nRECORDING REF: Vol 1 Page 2\nLEGAL DESC: Sec 1\nCONFIDENCE: high' },
        ]),
        model: 'gemini-3.1-flash-lite',
        usage: { input_tokens: 20, output_tokens: 20 },
      };
    },
  });
  const truncByChunk = Object.fromEntries(resTrunc.map(r => [r.chunkId, r]));
  assert.equal(truncByChunk.chk_1.status, 'failed');
  assert.equal(truncByChunk.chk_1.failure.errorType, 'output_truncated');
  assert(!savedAbstracts.some(a => a.chunkId === 'chk_1'), 'Truncated escalation must not save low-confidence Tier 1 abstract');
  assert.equal(failedMarks.some(m => m.chunkId === 'chk_1' && m.failure.errorType === 'output_truncated'), true);

  modelCalls = 0;
  const res429 = await processMultiChunkAbstraction(chunks, {
    store: makeBatchStore(),
    workerId: 'wkr_1',
    maxAttempts: 3,
    escalationEnabled: false,
    blobLoader: async () => ({ bytes: Buffer.from('a,b\n1,2'), mediaType: 'text/csv' }),
    modelClient: async () => {
      modelCalls += 1;
      const err = new Error('Too many requests');
      err.status = 429;
      throw err;
    },
  });
  assert.equal(modelCalls, 1, '429 on batch must not fan out to fallbackToSingles');
  assert.equal(retryWaits.length, 2);
  assert(res429.every(r => r.status === 'retry_wait'));

  // Queue deadline check
  let slowCalls = 0;
  const queueChunks = Array.from({ length: 4 }, (_, i) => ({
    id: `chk_q_${i}`,
    jobId: 'job_q',
    documentId: `doc_q_${i}`,
    chunkOrder: i,
    originalFilename: `q${i}.png`,
    mediaType: 'image/png',
    blobUrl: `gs://test-bucket/jobs/job_q/chunks/chk_q_${i}/q${i}.png`,
    blobKey: `jobs/job_q/chunks/chk_q_${i}/q${i}.png`,
    uploadStatus: 'uploaded',
    abstractionStatus: 'pending',
    abstractionAttempts: 0,
  }));
  const queueRes = await processAbstractionBatch('job_q', {
    store: {
      async getJob() { return { id: 'job_q', status: 'abstracting' }; },
      async listChunks() { return queueChunks; },
      async claimChunkForAbstraction(_j, cid) { return { ...queueChunks.find(c => c.id === cid), abstractionStatus: 'processing', abstractionAttempts: 1 }; },
      async saveDocumentAbstract(r) { return r; },
    },
    concurrency: 1,
    batchLimit: 4,
    budgetMs: 15,
    blobLoader: async () => ({ bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), mediaType: 'image/png' }),
    modelClient: async () => {
      slowCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 25));
      return {
        text: 'DOC TYPE: Deed\nGRANTOR: A\nGRANTEE: B\nDATE EXECUTED: 2020-01-01\nDATE RECORDED: 2020-01-02\nRECORDING REF: Vol 1 Page 2\nLEGAL DESC: Sec 1\nCONFIDENCE: high',
        model: 'gemini-3.1-flash-lite',
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    },
  });
  assert(slowCalls < 4, `Expected deadline to stop queued tasks early, ran ${slowCalls}`);
  assert(queueRes.completedInBatch < 4);
});

// ---- M8: Job store & prompt-builder edge bugs ----

test('M8: ready transitions, continuation doc counts, newest followups, turns=0, synthesis status meta, finalize 404, block system prompt', async () => {
  assert.equal(isValidStatusTransition('ready', 'synthesizing'), true);
  assert.equal(isValidStatusTransition('ready', 'complete'), true);

  // importContinuationAbstracts calls refreshDocumentCounts and NOT refreshAbstractionCounts
  const importStart = jobsSource.indexOf('async importContinuationAbstracts(');
  const importBody = jobsSource.slice(importStart, jobsSource.indexOf('\n    async ', importStart + 1));
  assert(importBody.includes('refreshDocumentCounts(targetJobId, docId)'));
  assert(!importBody.includes('refreshAbstractionCounts('));

  // listFollowupMessages selects newest limit ordered ASC
  const listStart = jobsSource.indexOf('async listFollowupMessages(');
  const listBody = jobsSource.slice(listStart, jobsSource.indexOf('\n    async ', listStart + 1));
  assert(/ORDER BY created_at DESC, id DESC[\s\S]*ORDER BY created_at ASC, id ASC/.test(listBody));

  // getSynthesisConfig accepts explicit 0 and answerFollowupQuestion respects 0
  assert.equal(getSynthesisConfig({ followupHistoryTurns: 0 }).followupHistoryTurns, 0);
  let capturedMessages = null;
  const followupStore = {
    async getJob() { return { id: 'job_f', status: 'complete' }; },
    async getJobResult() { return { finalTitleOpinion: '## CHAIN OF TITLE SUMMARY\nClean title.' }; },
    async listFollowupMessages() { return [{ question: 'old q', answer: 'old a' }]; },
    async appendFollowupMessage(_id, payload) { return payload; },
  };
  await answerFollowupQuestion('job_f', 'new question', {
    store: followupStore,
    config: { followupHistoryTurns: 0 },
    modelClient: async req => {
      capturedMessages = req.messages;
      return { text: 'answer', model: 'claude-sonnet-5-5', usage: {} };
    },
  });
  assert(!capturedMessages[0].content.includes('old q'), 'followupHistoryTurns: 0 must exclude prior turns');

  // getSynthesisStatus checks getJobResultMeta even when lightweight: false and includeResult: false
  let metaCalled = false;
  const getSynthesisStatusFn = extractJobsMethod('getSynthesisStatus', {
    ensureSchema: async () => {},
    deriveSynthesisProgress: ({ hasResultRow }) => ({ hasResult: hasResultRow, mergeInProgress: !hasResultRow }),
  });
  const synStatus = await getSynthesisStatusFn.call({
    getJob: async () => ({ id: 'job_s', status: 'complete' }),
    getCurrentSynthesisPlanId: async () => 'plan_1',
    listSynthesisSegments: async () => [],
    getJobResultMeta: async () => { metaCalled = true; return { jobId: 'job_s', status: 'complete', hasOpinion: true }; },
    getJobResult: async () => null,
  }, 'job_s', { lightweight: false, includeResult: false });
  assert.equal(metaCalled, true);
  assert.equal(synStatus.hasResult, true);

  // finalizeUploads returns null for nonexistent job before checking chunks
  let listChunksCalled = false;
  const finalizeFn = extractJobsMethod('finalizeUploads', {
    ensureSchema: async () => {},
    validateChunkFinalizationStorage: () => ({ valid: true }),
    refreshUploadCounts: async () => null,
    assertValidStatusTransition: () => {},
    sql: async () => [],
    rowToJob: r => r,
    JobApiError: class extends Error {},
  });
  const missingFinalize = await finalizeFn.call({
    getJob: async () => null,
    listChunks: async () => { listChunksCalled = true; return []; },
  }, 'job_missing');
  assert.equal(missingFinalize, null);
  assert.equal(listChunksCalled, false);

  // buildSystemParam preserves block arrays
  const sysBlocks = buildSystemParam([{ type: 'text', text: 'x'.repeat(300) }]);
  assert(Array.isArray(sysBlocks));
  assert.equal(sysBlocks[0].text, 'x'.repeat(300));
  assert.deepEqual(sysBlocks[0].cache_control, { type: 'ephemeral' });
});

// ---- M9: Frontend progress, followup turns=0, MIME inference, high-DPI partial_failed, localStorage quota, OCR markdown ----

test('M9: frontend derivedProgressPercent, turns=0 followup, MIME inference, high-DPI partial_failed, saveActiveJob quota, and OCR markdown', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(200, {}) });
  try {
    // derivedProgressPercent
    const uploadPct = app.ctx.derivedProgressPercent({ status: 'uploading', totalChunks: 4, completedChunks: 2 });
    assert(uploadPct > 0 && uploadPct < 15, `Expected uploading pct in (0,15), got ${uploadPct}`);
    const abstractStartPct = app.ctx.derivedProgressPercent({
      status: 'abstracting',
      totalChunks: 4,
      completedChunks: 4,
      abstractChunkTotal: 4,
      abstractChunkCompleted: 0,
      abstractChunkFailed: 0,
    });
    assert.equal(abstractStartPct, 15, 'Abstracting 0/4 must not jump to 70% from completedChunks');
    const abstractMidPct = app.ctx.derivedProgressPercent({
      status: 'abstracting',
      totalChunks: 4,
      completedChunks: 4,
      abstractChunkTotal: 4,
      abstractChunkCompleted: 2,
      abstractChunkFailed: 0,
    });
    assert(abstractMidPct > 15 && abstractMidPct < 70, `Expected abstracting mid pct, got ${abstractMidPct}`);
    const synthPct = app.ctx.derivedProgressPercent({
      status: 'synthesizing',
      totalChunks: 4,
      completedChunks: 4,
      abstractChunkTotal: 4,
      abstractChunkCompleted: 4,
      synthesisTotalSegments: 4,
      synthesisCompletedSegments: 2,
    });
    assert(synthPct > 70 && synthPct < 99, `Expected synthesizing segment pct, got ${synthPct}`);

    // buildFollowupMessages when opinion leaves room for 0 history turns (turns === 0)
    const safeBytes = app.run('REQUEST_ENVELOPE_SAFE_BYTES');
    const opinionBudget = safeBytes - 40_000;
    const msgsZeroTurns = app.ctx.buildFollowupMessages('What is the mineral interest?', 'A'.repeat(opinionBudget), [
      { question: 'Prior question should be omitted', answer: 'B'.repeat(50_000) },
    ]);
    assert(!msgsZeroTurns[0].content.includes('Prior question should be omitted'));
    assert(!msgsZeroTurns[0].content.includes('Use this truncated title opinion'));

    // MIME inference for empty type, application/octet-stream, and image/jpg
    const pngOctet = new File([new Uint8Array([1, 2, 3])], 'scan.png', { type: 'application/octet-stream' });
    const jpgEmpty = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: '' });
    const jpgLegacy = new File([new Uint8Array([1, 2, 3])], 'photo2.jpg', { type: 'image/jpg' });
    assert.equal(app.ctx.isImageFile(pngOctet), true);
    assert.equal(app.ctx.isImageFile(jpgEmpty), true);
    assert.equal(app.ctx.isImageFile(jpgLegacy), true);
    const prepared = await app.ctx.prepareFileEntries(jpgLegacy, 10);
    assert.equal(prepared[0].type, 'image/jpeg');

    // saveActiveJob swallows QuotaExceededError
    app.ctx.sessionStorage.setItem = () => {
      const err = new Error('Quota exceeded');
      err.name = 'QuotaExceededError';
      throw err;
    };
    app.ctx.saveActiveJob({ id: 'job_quota' }, 'browser');
  } finally {
    disposeAll();
  }

  // rereadFlaggedPdfsAsHighDpi preserves partial_failed + warnings
  let postedResult = null;
  let patchedJob = null;
  const app2 = loadIndex({
    fetchImpl: async (url, options = {}) => {
      if (String(url).includes('/api/jobs/job_partial/result') && options.method === 'POST') {
        postedResult = JSON.parse(options.body);
        return jsonResponse(200, { result: postedResult });
      }
      if (String(url).endsWith('/api/jobs/job_partial') && options.method === 'PATCH') {
        patchedJob = JSON.parse(options.body);
        return jsonResponse(200, { job: { id: 'job_partial', status: patchedJob.status || 'synthesizing' } });
      }
      if (String(url).endsWith('/api/jobs/job_partial')) {
        return jsonResponse(200, { job: { id: 'job_partial', status: 'partial_failed', failedDocuments: 1, totalDocuments: 2, completedDocuments: 1 } });
      }
      return jsonResponse(200, {
        content: [{ type: 'text', text: '## CHAIN OF TITLE SUMMARY\nUpdated high-DPI opinion.\n\n## MINERAL OWNERSHIP\nAlice 100%.' }],
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 10, output_tokens: 10 },
      });
    },
  });
  try {
    const flaggedFile = new File([new Uint8Array([37, 80, 68, 70])], 'flagged.pdf', { type: 'application/pdf' });
    app2.ctx.__TITLE_ANALYZER_PDF_RASTER__ = {
      prepareDocument: async () => [{ mediaType: 'image/png', data: 'YWJj' }],
    };
    app2.ctx.PDFLib = { PDFDocument: { load: async () => ({ getPageCount: () => 1 }) } };
    app2.ctx.__testFlaggedFile = flaggedFile;
    app2.run(`
      activeJobId = 'job_partial';
      files = [__testFlaggedFile];
      documentAbstracts = [{ filename: 'flagged.pdf', abstract: 'CONFIDENCE: low\\nRECORDING REF: ILLEGIBLE — VERIFY MANUALLY' }];
      conversationHistory = [
        { role: 'user', content: 'prompt' },
        {
          role: 'assistant',
          kind: 'title-opinion',
          content: '## CHAIN OF TITLE SUMMARY\\nPrior partial.',
          sourceJobId: 'job_partial',
          exportContext: {
            job: { id: 'job_partial', totalDocuments: 2, completedDocuments: 1, failedDocuments: 1 },
            result: {
              warnings: ['1 document abstract(s) excluded due to abstraction failure.'],
              failedDocuments: [{ id: 'doc_2', filename: 'missing.pdf' }],
            },
          },
        },
      ];
    `);
    await app2.ctx.rereadFlaggedPdfsAsHighDpi();
    assert.equal(postedResult?.status, 'partial_failed');
    assert.equal(postedResult?.failedDocuments?.length, 1);
    assert(postedResult?.warnings?.some(w => w.includes('excluded')));
    assert.equal(patchedJob?.failedDocuments, 1);
  } finally {
    disposeAll();
  }

  // api/ocr-compare parses bold/bulleted/CRLF markdown outputs
  await withEnv({ OCR_COMPARE_ENABLED: 'true', APP_PASSWORD: '' }, async () => {
    const handler = createOcrCompareHandler({
      modelClient: async () => ({
        text: '- **GRANTOR:** Alice\r\n- **GRANTEE:** Bob\r\n```',
        model: 'gemini-3.1-flash-lite',
        usage: { input_tokens: 10, output_tokens: 10 },
      }),
    });
    const pngBase64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64');
    const res = mockRes();
    await handler({
      method: 'POST',
      headers: {},
      body: { filename: 'deed.png', pages: [{ mediaType: 'image/png', data: pngBase64 }] },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.models[0].fields.GRANTOR, 'Alice');
    assert.equal(res.body.models[0].fields.GRANTEE, 'Bob');
  });
});

// ---- M10: Operational scripts & .dockerignore ----

test('M10: verify-release rejects valueless env entries & accepts OpenRouter; compare scripts & .dockerignore fixed', async () => {
  const missingPassword = validateRequiredEnv({
    containers: [{
      env: [
        { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'db' } } },
        { name: 'GCS_BUCKET', value: 'b' },
        { name: 'GEMINI_API_KEY', valueFrom: { secretKeyRef: { name: 'g' } } },
        { name: 'ANTHROPIC_API_KEY', valueFrom: { secretKeyRef: { name: 'a' } } },
        { name: 'APP_PASSWORD' },
      ],
    }],
  });
  assert.equal(missingPassword.valid, false);
  assert(missingPassword.missing.includes('app password'));

  const openRouterOnly = validateRequiredEnv({
    containers: [{
      env: [
        { name: 'MODEL_PROVIDER', value: 'openrouter' },
        { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'db' } } },
        { name: 'GCS_BUCKET', value: 'b' },
        { name: 'OPENROUTER_API_KEY', valueFrom: { secretKeyRef: { name: 'or' } } },
        { name: 'APP_PASSWORD', valueFrom: { secretKeyRef: { name: 'pw' } } },
      ],
    }],
  });
  assert.equal(openRouterOnly.valid, true, `Expected OpenRouter-only env to pass, missing: ${openRouterOnly.missing}`);

  assert.equal(scoreOcrField('', 'Alice', true, 'GRANTOR'), 'missed_degraded');
  assert.equal(scoreOcrField('ILLEGIBLE', 'Alice', true, 'GRANTOR'), 'correct_illegible');
  const ocrReport = buildOcrComparisonReport([
    {
      name: 'doc1.png',
      mode: 'visual',
      gt: { file: 'doc1.png' },
      perModel: {
        'gemini-3.1-flash-lite': {
          latencyMs: 100,
          usage: { input_tokens: 10, output_tokens: 10 },
          scores: { GRANTOR: 'correct', GRANTEE: 'correct_illegible' },
        },
      },
    },
  ], { 'doc1.png': {} });
  assert(ocrReport.includes('| `gemini-3.1-flash-lite` | 1 (100%) |'), `Expected 100% non-degraded accuracy, got:\n${ocrReport}`);

  assert.equal(resolveCompareMode({ segmentSummaries: [{ segmentIndex: 0, summaryText: 's' }], plannedSegmentCount: 2 }), 'single-pass');
  let capturedMaxTokens = null;
  await generateFinalOpinion({
    mode: 'merge',
    ctx: { abstracts: [{ filename: 'a', abstract: 'b' }], segmentSummaries: [{ filename: 's1', abstract: 'x' }, { filename: 's2', abstract: 'y' }], tract: 'T', contextNotes: '' },
    model: 'claude-sonnet-5-5',
    invokeModelFn: async req => {
      capturedMaxTokens = req.maxTokens;
      return { text: 'opinion', model: 'claude-sonnet-5-5', stopReason: 'end_turn', usage: {} };
    },
  });
  assert.equal(capturedMaxTokens, 16000);
  await assert.rejects(
    () => generateFinalOpinion({
      mode: 'merge',
      ctx: { abstracts: [], segmentSummaries: [{ filename: 's1', abstract: 'x' }, { filename: 's2', abstract: 'y' }], tract: 'T', contextNotes: '' },
      model: 'claude-sonnet-5-5',
      invokeModelFn: async () => ({ text: 'cut', model: 'claude-sonnet-5-5', stopReason: 'max_tokens', usage: {} }),
    }),
    err => err.code === 'output_truncated',
  );
  assert(compareFinalOpinionSource.includes('POSTGRES_PRISMA_URL'));

  for (const excluded of ['scripts/ocr-comparison-results/', 'scripts/sample-docs/', 'eval/compare/']) {
    assert(dockerignoreSource.includes(excluded), `Expected .dockerignore to exclude ${excluded}`);
  }
});

// ---- L1–L8: Low risk fixes ----

test('L1–L3 & L8 (frontend): CRLF markdown, preview card scroll, dotted filenames, runWithConcurrency sibling errors', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(200, {}) });
  try {
    // L1: CRLF markdown
    const html = app.ctx.md('| A | B |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\nPara line');
    assert(html.includes('<table>'), 'CRLF table must render as <table>');
    assert(html.includes('<p>Para line</p>'));

    // L2: renderSynthesisPreview scrolls .synthesis-preview-card
    const section = app.getEl('synthesisPreviewSection');
    const body = app.getEl('synthesisPreviewBody');
    const card = new StubElement('card');
    card.scrollHeight = 420;
    body.closest = selector => (selector === '.synthesis-preview-card' ? card : null);
    app.ctx.renderSynthesisPreview('Streaming opinion text', true);
    assert.equal(card.scrollTop, 420);

    // L3: stagedFileTag handles dots before spaces
    assert.deepEqual({ ...app.ctx.stagedFileTag({ name: 'Mt.Pleasant Deed.png', type: '' }) }, { kind: 'img', label: 'PNG' });
    assert.deepEqual({ ...app.ctx.stagedFileTag({ name: 'Mt.Pleasant Deed.pdf (pp 1-10)', type: '' }) }, { kind: 'pdf', label: 'PDF' });

    // L8: runWithConcurrency catches sibling rejections without unhandledRejection
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on('unhandledRejection', onUnhandled);
    try {
      await assert.rejects(
        () => app.ctx.runWithConcurrency([
          async () => { await tick(5); throw new Error('err-1'); },
          async () => { await tick(10); throw new Error('err-2'); },
        ], 2),
        /err-1/,
      );
      await tick(20);
      assert.equal(unhandled, 0, 'Expected no unhandledRejection from sibling tasks');
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  } finally {
    disposeAll();
  }
});

test('L4–L8 (backend/OCR/worker): error banner reset, terminal guards, error stringification, retry backoff, synthesis warnings, worker entry', async () => {
  // L4: ocr-compare.js clears stale error
  assert(ocrCompareUiSource.includes("status: 'idle', error: ''"));
  assert(ocrCompareUiSource.includes("status: 'loading', error: ''"));

  // L5: handleChunkPatch, api/blob/upload, handleFollowup, and handleJobResult concurrent cancel -> 409
  const prevStore = globalThis.__TITLE_ANALYZER_JOB_STORE__;
  const prevRateLimitBackend = globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
  const prevBucket = process.env.GCS_BUCKET;
  globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__ = {
    async read() { return { data: null, generation: 0 }; },
    async write() {},
  };
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = {
    async getJob(id) {
      if (id === 'job_complete') return { id, status: 'complete' };
      if (id === 'job_canceled') return { id, status: 'canceled' };
      if (id === 'job_raced') return { id, status: 'synthesizing' };
      return null;
    },
    async getChunk(jobId, chunkId) {
      return { id: chunkId, jobId, originalFilename: 'a.pdf', mediaType: 'application/pdf', blobKey: `jobs/${jobId}/chunks/${chunkId}/a.pdf`, sizeBytes: 100 };
    },
    async saveJobResult() { return null; },
  };
  try {
    await withEnv({ APP_PASSWORD: '', GCS_BUCKET: 'test-bucket' }, async () => {
      resetJobRateLimits();
      const patchRes = mockRes();
      await jobPathHandler(mockReq({
        method: 'PATCH',
        url: '/api/jobs/job_complete/chunks/chk_1',
        body: { uploadStatus: 'failed' },
      }), patchRes);
      assert.equal(patchRes.statusCode, 409);

      const uploadRes = mockRes();
      await blobUploadHandler(mockReq({
        method: 'POST',
        url: '/api/blob/upload',
        body: { jobId: 'job_complete', chunkId: 'chk_1', mediaType: 'application/pdf' },
      }), uploadRes);
      assert.equal(uploadRes.statusCode, 409);

      const raceResultRes = mockRes();
      await jobPathHandler(mockReq({
        method: 'POST',
        url: '/api/jobs/job_raced/result',
        body: { finalTitleOpinion: '## CHAIN OF TITLE SUMMARY\nClean.' },
      }), raceResultRes);
      assert.equal(raceResultRes.statusCode, 409);
    });

    await withEnv({ APP_PASSWORD: 'secret', ANTHROPIC_API_KEY: 'ant-test', GEMINI_API_KEY: 'gem-test' }, async () => {
      resetJobRateLimits();
      const followupRes = mockRes();
      await jobPathHandler(mockReq({
        method: 'POST',
        url: '/api/jobs/job_canceled/followup',
        headers: { 'x-app-password': 'secret' },
        body: { question: 'Still valid?' },
      }), followupRes);
      assert.equal(followupRes.statusCode, 409);
    });
  } finally {
    globalThis.__TITLE_ANALYZER_JOB_STORE__ = prevStore;
    if (prevRateLimitBackend === undefined) delete globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
    else globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__ = prevRateLimitBackend;
    if (prevBucket === undefined) delete process.env.GCS_BUCKET;
    else process.env.GCS_BUCKET = prevBucket;
  }

  // L6: Error objects without .message never stringify to "[object Object]"
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 502,
    json: async () => ({ error: { code: 'bad_gateway', detail: 'upstream down' } }),
  });
  try {
    await withEnv({ ANTHROPIC_API_KEY: 'ant-test', GEMINI_API_KEY: 'gem-test' }, async () => {
      for (const call of [
        () => invokeAnthropicModel({ model: 'claude-sonnet-5-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
        () => invokeAnthropicModelStream({ model: 'claude-sonnet-5-5', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
        () => invokeGeminiGenerateContent({ model: 'gemini-3.1-flash-lite', maxTokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
      ]) {
        await assert.rejects(call, err => !err.message.includes('[object Object]'));
      }
    });
  } finally {
    globalThis.fetch = prevFetch;
  }

  // L7: Retry-After ms vs seconds
  assert.equal(extractRetryAfterMs({ retryAfterMs: 500 }), 500);
  assert.equal(computeRetryBackoff(1, 500), 500);
  assert.equal(extractRetryAfterMs({ headers: { 'retry-after': '3' } }), 3000);

  // L8: synthesis.js merge catch preserves warningsAccum & worker.js uses fileURLToPath
  const segments = [
    { id: 'seg_0', segmentIndex: 0, startSequenceIndex: 0, endSequenceIndex: 0, documentIds: ['d1'], filenames: ['d1.pdf'], status: 'complete', summaryText: 'Summary 1', warnings: ['segment_1_warning'], inputTokens: 1, outputTokens: 1 },
    { id: 'seg_1', segmentIndex: 1, startSequenceIndex: 1, endSequenceIndex: 1, documentIds: ['d2'], filenames: ['d2.pdf'], status: 'complete', summaryText: 'Summary 2', warnings: [], inputTokens: 1, outputTokens: 1 },
  ];
  const mergeStore = {
    job: { id: 'job_w', status: 'synthesizing', subjectTract: 'Sec 1', contextNotes: '', synthesisPlanId: 'plan_w' },
    async getJob() { return this.job; },
    async getJobResult() { return null; },
    async getCurrentSynthesisPlanId() { return 'plan_w'; },
    async listDocumentAbstracts() {
      return [
        { id: 'a1', documentId: 'd1', chunkId: 'c1', chunkOrder: 0, originalFilename: 'd1.pdf', abstractText: 'Doc 1' },
        { id: 'a2', documentId: 'd2', chunkId: 'c2', chunkOrder: 1, originalFilename: 'd2.pdf', abstractText: 'Doc 2' },
      ];
    },
    async listChunks() { return []; },
    async saveSynthesisPlan(_jobId, plan) { return { planId: plan.planId, segments }; },
    async listSynthesisSegments() { return segments; },
    async listReadySynthesisSegments() { return []; },
    async getSynthesisStatus() {
      return { total: 2, pending: 0, processing: 0, complete: 2, failed: 0, retry_wait: 0, mergeInProgress: false, hasResult: Boolean(this.saved) };
    },
    async claimSynthesisMerge() { return { jobId: 'job_w', planId: 'plan_w', workerId: 'w_merge' }; },
    async renewSynthesisMergeLease() { return { jobId: 'job_w', planId: 'plan_w', workerId: 'w_merge' }; },
    async saveJobResult(_id, payload) { this.saved = payload; return payload; },
  };
  await processSynthesisJob('job_w', {
    store: mergeStore,
    config: { chunkSize: 1 },
    modelClient: async () => { throw new Error('merge boom'); },
  });
  assert(mergeStore.saved.warnings.includes('segment_1:segment_1_warning'), 'Merge catch must preserve warningsAccum');
  assert(mergeStore.saved.warnings.includes('final_merge_failed: provider_error'));

  assert(workerSource.includes('fileURLToPath(import.meta.url)'));
});

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${t.name}`);
    console.error(err.stack || err.message || err);
  }
}

if (failures) {
  process.exit(1);
}
