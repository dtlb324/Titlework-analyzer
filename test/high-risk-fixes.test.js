import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { PDFDocument } from 'pdf-lib';
import { consumeAnthropicMessageStream } from '../api/_lib/anthropic-stream.js';
import { processChunkAbstraction } from '../api/_lib/abstraction.js';
import {
  applyAbstractionClaim,
  assertValidStatusTransition,
  isInvalidJobStatusTransition,
  isValidStatusTransition,
  JobApiError,
  resetJobRateLimits,
  validateCreateJobInput,
  validateSynthesisRequestInput,
} from '../api/_lib/jobs.js';
import { invokeOpenRouterModel } from '../api/_lib/openrouter-request.js';
import { enqueueSynthesisJob, processAbstractionBatch, retryFailedAbstractionChunks } from '../api/_lib/queue.js';
import { buildObjectKey, createSignedUpload } from '../api/_lib/storage.js';
import {
  PARTIAL_SYNTHESIS_PROMPT,
  processSynthesisJob,
  resolvePartialSynthesisModel,
  SYNTHESIS_PROMPT,
  synthesisSetupError,
} from '../api/_lib/synthesis.js';
import analyzeHandler from '../api/analyze.js';
import jobPathHandler from '../api/jobs/[...path].js';
import { createServer } from '../server.js';
import { disposeAll, jsonResponse, loadIndex, pngFile, StubElement, tick } from './helpers/browser-index-harness.js';

if (!StubElement.prototype.removeAttribute) {
  StubElement.prototype.removeAttribute = function removeAttribute(k) { delete this[k]; };
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const jobsSource = readFileSync(join(root, 'api/_lib/jobs.js'), 'utf8');

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

function mockReq({ method = 'POST', url = '/api/jobs/job_1', headers = {}, body = undefined, remoteAddress = '203.0.113.10' } = {}) {
  return {
    method,
    url,
    headers,
    body,
    query: { path: url.replace(/^\/api\/jobs\//, '').split('/').filter(Boolean) },
    socket: { remoteAddress },
  };
}

function makeGoodOpinion(note = 'All clear.') {
  return [
    '## CHAIN OF TITLE SUMMARY',
    'Complete chronological chain of title across all segments and recorded instruments covering Section 12, Block C-8, Reeves County, Texas, tracing patent title through subsequent mineral deeds, reservations, and assignments without unaddressed gaps.',
    '',
    '## FINAL OWNERSHIP DETERMINATION',
    '| Owner | Interest |',
    '|---|---|',
    `| Alice Mineral Co. | 100% — ${note} |`,
    '',
    '## TITLE DEFECTS & CURATIVE REQUIREMENTS',
    'None identified across the examined abstract instruments; all conveyances reconcile to unity.',
    '',
    '## OPINION QUALIFICATIONS',
    'Based strictly on the submitted abstracts; verify county deed records, probate indexes, and unreleased liens prior to closing or royalty distribution.',
  ].join('\n');
}

function makeSegmentSummary(note = 'Segment ok') {
  return [
    '### Chain of title',
    `| Document | Grantor | Grantee | Running Balance |`,
    `|---|---|---|---|`,
    `| Doc 1 | A | B | 100% (${note} — complete mineral conveyance across the subject tract with no unresolved gaps) |`,
  ].join('\n');
}

async function withEnv(env, fn) {
  const previous = {};
  for (const [k, v] of Object.entries(env)) {
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

// ---- H1: refreshAbstractionCounts, lease-lost callers, & /abstraction/process guard ----

test('H1a: refreshAbstractionCounts SQL removes + superseded_chunks and preserves terminal/canceled status and current_phase', () => {
  const start = jobsSource.indexOf('async function refreshAbstractionCounts(jobId)');
  const end = jobsSource.indexOf('\n  return {', start);
  const body = jobsSource.slice(start, end);
  assert(!body.includes('+ superseded_chunks'), 'document_counts must not add superseded_chunks to chunk_count comparisons');
  assert(body.includes("WHEN status = 'canceled' THEN current_phase"), 'current_phase must preserve canceled');
  assert(body.includes("WHEN status IN ('complete', 'synthesizing', 'failed', 'partial_failed')"), 'current_phase and status must preserve synthesis-terminal states');
});

test('H1b: lease-lost chunk updates skip refreshAbstractionCounts and /abstraction/process rejects created/uploading with 409', async () => {
  for (const methodName of ['markChunkAbstractionRetryWait', 'markChunkAbstractionFailed', 'markChunkAbstractionSplitSuperseded']) {
    let refreshed = 0;
    const fn = extractJobsMethod(methodName, {
      ensureSchema: async () => {},
      sql: async () => [],
      refreshAbstractionCounts: async () => { refreshed += 1; },
      rowToChunk: row => row || null,
    });
    const out = methodName === 'markChunkAbstractionSplitSuperseded'
      ? await fn('job_1', 'chk_1', 'timeout', 'wkr_lost')
      : await fn('job_1', 'chk_1', { errorType: 'timeout', errorMessage: 'lost', workerId: 'wkr_lost' });
    assert.equal(out, null);
    assert.equal(refreshed, 0, `${methodName} must not call refreshAbstractionCounts when 0 rows matched`);
  }

  for (const preStatus of ['created', 'uploading']) {
    let calledBatch = false;
    globalThis.__TITLE_ANALYZER_JOB_STORE__ = {
      async getJob() { return { id: 'job_pre', status: preStatus }; },
      async listChunks() { calledBatch = true; return []; },
    };
    const rateMem = new Map();
    globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__ = {
      async read(k) { return rateMem.get(k) || { data: null, generation: 0 }; },
      async write(k, data, gen) { rateMem.set(k, { data, generation: gen + 1 }); },
    };
    const prevPw = process.env.APP_PASSWORD;
    const prevGem = process.env.GEMINI_API_KEY;
    const prevGcs = process.env.GCS_BUCKET;
    process.env.APP_PASSWORD = 'pw';
    process.env.GEMINI_API_KEY = 'synthetic-gemini';
    process.env.GCS_BUCKET = 'synthetic-bucket';
    try {
      const res = mockRes();
      await jobPathHandler(mockReq({
        method: 'POST',
        url: '/api/jobs/job_pre/abstraction/process',
        headers: { 'x-app-password': 'pw' },
      }), res);
      assert.equal(res.statusCode, 409, `Expected 409 for ${preStatus}, got ${res.statusCode}`);
      assert.equal(calledBatch, false);

      await assert.rejects(
        processAbstractionBatch('job_pre', { store: globalThis.__TITLE_ANALYZER_JOB_STORE__ }),
        err => err.statusCode === 409,
      );
    } finally {
      delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
      delete globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
      if (prevPw === undefined) delete process.env.APP_PASSWORD; else process.env.APP_PASSWORD = prevPw;
      if (prevGem === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = prevGem;
      if (prevGcs === undefined) delete process.env.GCS_BUCKET; else process.env.GCS_BUCKET = prevGcs;
    }
  }
});

// ---- H2: Boot-time probes do not burn lockout strikes, ocr-compare pre-auth ordering, 429 UI ----

test('H2: empty probes do not burn password lockout strikes, ocr-compare checks config before auth, and UI renders 429 clearly', async () => {
  resetJobRateLimits();
  await withEnv({
    APP_PASSWORD: 'secret-password',
    NODE_ENV: 'production',
    OCR_COMPARE_ENABLED: 'false',
  }, async () => {
    const server = createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      for (let i = 0; i < 8; i++) {
        const probe = await fetch(`${base}/api/analyze`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-app-password': '' },
          body: JSON.stringify({ ping: true }),
        });
        assert.equal(probe.status, 401);
      }
      // Correct password still works after 8 empty probes
      const okRes = await fetch(`${base}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': 'secret-password' },
        body: JSON.stringify({ ping: true }),
      });
      assert.equal(okRes.status, 200);

      // ocr-compare disabled returns 404 before password check
      const disabledRes = await fetch(`${base}/api/ocr-compare`, { method: 'GET' });
      assert.equal(disabledRes.status, 404);

      // 5 wrong non-empty passwords still trigger 429 lockout
      for (let i = 0; i < 5; i++) {
        const bad = await fetch(`${base}/api/analyze`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-app-password': 'wrong' },
          body: JSON.stringify({ ping: true }),
        });
        assert.equal(bad.status, 401);
      }
      const locked = await fetch(`${base}/api/analyze`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-app-password': 'secret-password' },
        body: JSON.stringify({ ping: true }),
      });
      assert.equal(locked.status, 429);
    } finally {
      await new Promise(resolve => server.close(resolve));
      resetJobRateLimits();
    }
  });

  // Frontend UI renders explicit 429 lockout error instead of "Could not reach the server"
  const app = loadIndex({
    fetchImpl: async () => jsonResponse(429, { error: 'Too many failed attempts. Wait 60 seconds and try again.' }),
  });
  const bootOk = await app.ctx.checkPasswordRequired();
  assert.equal(bootOk, false);
  assert.match(app.getEl('passwordError').innerHTML, /Too many failed attempts/);
  assert.doesNotMatch(app.getEl('passwordError').innerHTML, /Could not reach the server/);
});

// ---- H3 & H11: Merge preview ownership, degraded preview isolation, and Rebuild button ----

test('H3 & H11: validation-failure clearSynthesisPreview preserves ownership, degraded previews are isolated, and rebuild clears partial_failed results', async () => {
  // H3: degraded preview cannot be recovered on all-segments-complete merge, and validation failure passes mergeWorkerId
  const clearCalls = [];
  const store = {
    job: { id: 'job_h3', status: 'synthesizing', subjectTract: 'Tract', contextNotes: '' },
    plan: {
      planId: 'plan_h3',
      segments: [
        { id: 'seg_0', segmentIndex: 0, startSequenceIndex: 0, endSequenceIndex: 0, documentIds: ['doc_0'], filenames: ['a.pdf'], status: 'complete', summaryText: makeSegmentSummary('s1') },
        { id: 'seg_1', segmentIndex: 1, startSequenceIndex: 1, endSequenceIndex: 1, documentIds: ['doc_1'], filenames: ['b.pdf'], status: 'complete', summaryText: makeSegmentSummary('s2') },
      ],
    },
    preview: {
      text: makeGoodOpinion('DEGRADED PREVIEW MISSING DOC'),
      complete: true,
      degraded: true,
      modelUsed: 'claude-sonnet-5-5',
    },
    result: null,
    async getJob() { return this.job; },
    async listDocumentAbstracts() {
      return [
        { id: 'abs_0', chunkId: 'chk_0', documentId: 'doc_0', chunkOrder: 0, filename: 'a.pdf', abstractText: 'Abs A' },
        { id: 'abs_1', chunkId: 'chk_1', documentId: 'doc_1', chunkOrder: 1, filename: 'b.pdf', abstractText: 'Abs B' },
      ];
    },
    async listFailedChunks() { return []; },
    async getCurrentSynthesisPlanId() { return this.plan.planId; },
    async saveSynthesisPlan(_jobId, { planId }) { this.plan.planId = planId; return this.plan; },
    async listSynthesisSegments() { return this.plan.segments; },
    async listReadySynthesisSegments() { return []; },
    async getSynthesisPreview() { return this.preview; },
    async setSynthesisPreview(_jobId, patch) { this.preview = { ...patch }; return this.preview; },
    async clearSynthesisPreview(jobId, opts = {}) { clearCalls.push({ jobId, ...opts }); this.preview = { text: '', complete: false, degraded: false }; return true; },
    async claimSynthesisMerge(_jobId, planId, { workerId }) { return { jobId: 'job_h3', planId, workerId }; },
    async getJobResult() { return this.result; },
    async saveJobResult(_jobId, payload) { this.result = payload; return payload; },
    async getSynthesisStatus() { return { job: this.job, total: 2, pending: 0, processing: 0, complete: 2, failed: 0, retry_wait: 0, hasResult: Boolean(this.result) }; },
  };

  let mergeCalls = 0;
  const out = await processSynthesisJob('job_h3', {
    store,
    workerId: 'wkr_owner',
    modelClient: async () => {
      mergeCalls += 1;
      // Return short invalid opinion to also trigger validation-failure clearSynthesisPreview
      return { text: 'Too short invalid opinion.', model: 'claude-sonnet-5-5', usage: {} };
    },
  });
  assert.equal(mergeCalls, 1, 'Degraded preview must not be reused on an all-segments-complete merge');
  assert.equal(out.result.status, 'failed');
  assert.ok(clearCalls.some(c => c.planId === store.plan.planId && c.mergeWorkerId === 'wkr_owner'), 'Validation-failure clearSynthesisPreview must pass planId and mergeWorkerId');

  // H11: validateSynthesisRequestInput accepts rebuild boolean; enqueueSynthesisJob clears result/preview on rebuild
  assert.deepEqual(validateSynthesisRequestInput({ rebuild: true }), { valid: true, value: { rebuild: true } });
  assert.equal(validateSynthesisRequestInput({ rebuild: 'yes' }).valid, false);

  let resetSegments = 0;
  let clearedResult = 0;
  let clearedPreview = 0;
  const partialStore = {
    job: { id: 'job_h11', status: 'partial_failed', subjectTract: 'Tract', contextNotes: '' },
    async getJob() { return this.job; },
    async listChunks() { return [{ id: 'chk_1', abstractionStatus: 'completed' }]; },
    async listDocumentAbstracts() { return [{ id: 'abs_1', chunkId: 'chk_1', documentId: 'doc_1', chunkOrder: 0, filename: 'a.pdf', abstractText: 'Abs' }]; },
    async getCurrentSynthesisPlanId() { return 'plan_11'; },
    async saveSynthesisPlan(_j, { planId }) { return { planId, segments: [{ id: 'seg_0', segmentIndex: 0, status: 'failed' }] }; },
    async listSynthesisSegments() { return [{ id: 'seg_0', segmentIndex: 0, status: 'failed' }]; },
    async summarizeSynthesisSegments() { return { total: 1, pending: 1, processing: 0, complete: 0, failed: 0, retry_wait: 0 }; },
    async resetFailedSynthesisSegments() { resetSegments += 1; return []; },
    async clearJobResult() { clearedResult += 1; return true; },
    async clearSynthesisPreview() { clearedPreview += 1; return true; },
    async getJobResult() { return { planId: 'plan_11', status: 'partial_failed', finalTitleOpinion: 'Old' }; },
    async getJobResultMeta() { return null; },
    async updateJob(_id, patch) { this.job = { ...this.job, ...patch }; return this.job; },
    async getSynthesisStatus() { return { job: this.job, planId: 'plan_11', total: 1, pending: 1, processing: 0, complete: 0, failed: 0, retry_wait: 0, hasResult: false, mergeInProgress: false, mergeLeaseHeld: false }; },
  };
  await enqueueSynthesisJob('job_h11', { store: partialStore, rebuild: true });
  assert.equal(resetSegments, 1);
  assert.equal(clearedResult, 1);
  assert.equal(clearedPreview, 1);
  assert.equal(partialStore.job.status, 'synthesizing');

  // retryFailedAbstractionChunks also clears synthesis preview
  let retryClearedPreview = 0;
  await retryFailedAbstractionChunks('job_h11', {
    store: {
      async getJob() { return { id: 'job_h11', status: 'partial_failed' }; },
      async retryFailedChunks() { return 1; },
      async clearJobResult() { return true; },
      async clearSynthesisPreview() { retryClearedPreview += 1; return true; },
      async updateJob() { return { id: 'job_h11', status: 'abstracting' }; },
      async getAbstractionStatus() { return { total: 1, pending: 1, processing: 0, completed: 0, failed: 0, retry_wait: 0 }; },
    },
  });
  assert.equal(retryClearedPreview, 1);

  // Frontend Rebuild button sends { rebuild: true }
  const postedBodies = [];
  const app = loadIndex({
    fetchImpl: async (url, init) => {
      if (String(url).endsWith('/synthesis/start')) postedBodies.push(JSON.parse(init.body));
      return jsonResponse(202, { job: { id: 'job_p', status: 'synthesizing' } });
    },
  });
  app.ctx.confirm = () => true;
  app.ctx.rdJobIsShown = () => true;
  app.ctx.renderJobActions({ id: 'job_p', status: 'partial_failed', failedDocuments: [{ id: 'd1' }] });
  const btn = app.run("jobActionButtons.find(b => b.label.includes('Rebuild opinion'))");
  await btn.onClick();
  assert.deepEqual(postedBodies, [{ rebuild: true }]);
});

// ---- H4: Preview DB errors non-fatal, merge lease renewal, repair retry cap, error busy-spin ----

test('H4: non-fatal preview DB errors, merge lease renewal, repair retry cap, and busy-spin exit', async () => {
  // 1. Non-fatal preview DB failure + merge lease renewal + lease_lost abort
  let renewMergeCalls = 0;
  let modelCalls = 0;
  const h4Store = {
    job: { id: 'job_h4', status: 'synthesizing', subjectTract: 'Tract', contextNotes: '' },
    segments: [
      { id: 'seg_0', segmentIndex: 0, startSequenceIndex: 0, endSequenceIndex: 0, documentIds: ['doc_0'], filenames: ['a.pdf'], status: 'complete', summaryText: makeSegmentSummary('s1') },
      { id: 'seg_1', segmentIndex: 1, startSequenceIndex: 1, endSequenceIndex: 1, documentIds: ['doc_1'], filenames: ['b.pdf'], status: 'complete', summaryText: makeSegmentSummary('s2') },
    ],
    saved: null,
    async getJob() { return this.job; },
    async listDocumentAbstracts() {
      return [
        { id: 'abs_0', chunkId: 'chk_0', documentId: 'doc_0', chunkOrder: 0, filename: 'a.pdf', abstractText: 'Abs A' },
        { id: 'abs_1', chunkId: 'chk_1', documentId: 'doc_1', chunkOrder: 1, filename: 'b.pdf', abstractText: 'Abs B' },
      ];
    },
    async listFailedChunks() { return []; },
    async getCurrentSynthesisPlanId() { return 'plan_h4'; },
    async saveSynthesisPlan(_jobId, { planId }) { return { planId, segments: this.segments }; },
    async listSynthesisSegments() { return this.segments; },
    async listReadySynthesisSegments() { return []; },
    async getSynthesisPreview() { return null; },
    async setSynthesisPreview() { throw new Error('Transient Neon timeout'); },
    async clearSynthesisPreview() { throw new Error('Transient Neon timeout'); },
    async claimSynthesisMerge(_j, p, { workerId }) { return { jobId: 'job_h4', planId: p, workerId }; },
    async renewSynthesisMergeLease() { renewMergeCalls += 1; return { jobId: 'job_h4' }; },
    async getJobResult() { return null; },
    async saveJobResult(_j, payload) { this.saved = payload; return payload; },
    async getSynthesisStatus() { return { job: this.job, total: 2, pending: 0, processing: 0, complete: 2, failed: 0, retry_wait: 0, hasResult: Boolean(this.saved) }; },
  };
  const opinion = makeGoodOpinion('Streamed despite preview DB blip');
  const res = await processSynthesisJob('job_h4', {
    store: h4Store,
    workerId: 'wkr_h4',
    streamFinalOpinion: true,
    modelClient: async req => {
      modelCalls += 1;
      if (req.onDelta) await req.onDelta('chunk', opinion);
      return { text: opinion, model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 20 } };
    },
  });
  assert.equal(modelCalls, 1);
  assert.equal(renewMergeCalls, 1);
  assert.equal(res.result.status, 'complete');
  assert.equal(res.result.finalTitleOpinion, opinion);

  // 2. Repair retry stays within maxAttempts (maxAttempts: 2 => at most 2 calls, not 3 or 5)
  let segCalls = 0;
  const segStore = {
    job: { id: 'job_rep', status: 'synthesizing', subjectTract: 'Tract', contextNotes: '' },
    seg: { id: 'seg_0', segmentIndex: 0, startSequenceIndex: 0, endSequenceIndex: 0, documentIds: ['doc_0'], filenames: ['a.pdf'], status: 'pending', attemptCount: 0 },
    async getJob() { return this.job; },
    async listDocumentAbstracts() { return [{ id: 'abs_0', chunkId: 'chk_0', documentId: 'doc_0', chunkOrder: 0, filename: 'a.pdf', abstractText: 'Abs A' }]; },
    async listFailedChunks() { return []; },
    async getCurrentSynthesisPlanId() { return 'plan_rep'; },
    async saveSynthesisPlan(_jobId, { planId }) { return { planId, segments: [this.seg] }; },
    async listSynthesisSegments() { return [this.seg]; },
    async listReadySynthesisSegments() { return this.seg.status === 'pending' ? [this.seg] : []; },
    async claimSynthesisSegment(_j, _s, { workerId }) {
      if (this.seg.status !== 'pending') return null;
      this.seg.attemptCount += 1;
      this.seg.status = 'processing';
      this.seg.workerId = workerId;
      return { ...this.seg };
    },
    async markSynthesisSegmentRetryWait(_j, _s, failure) {
      this.seg.status = 'retry_wait';
      this.seg.attemptCount += failure.extraAttempts || 0;
      return { ...this.seg };
    },
    async markSynthesisSegmentFailed(_j, _s, failure) {
      this.seg.status = 'failed';
      this.seg.errorType = failure.errorType;
      return { ...this.seg };
    },
    async claimSynthesisMerge(_j, p, { workerId }) { return { jobId: 'job_rep', planId: p, workerId }; },
    async saveJobResult(_j, payload) { return payload; },
    async getSynthesisStatus() { return { job: this.job, total: 1, pending: 0, processing: 0, complete: 0, failed: 1, retry_wait: 0, hasResult: false }; },
  };
  await processSynthesisJob('job_rep', {
    store: segStore,
    config: { maxAttempts: 2 },
    modelClient: async () => {
      segCalls += 1;
      return { text: 'bad output', model: 'claude-sonnet-5-5', usage: {} };
    },
  });
  assert.equal(segCalls, 2, `Expected maxAttempts=2 to cap repair retries at 2 calls, got ${segCalls}`);
  assert.equal(segStore.seg.status, 'failed');

  // 3. processSynthesisJob breaks immediately on { status: 'error' } instead of spinning for budgetMs
  let listReadyCalls = 0;
  const spinStore = {
    job: { id: 'job_spin', status: 'synthesizing', subjectTract: 'Tract', contextNotes: '' },
    seg: { id: 'seg_0', segmentIndex: 0, startSequenceIndex: 0, endSequenceIndex: 0, documentIds: ['doc_0'], filenames: ['a.pdf'], status: 'pending', attemptCount: 0 },
    async getJob() { return this.job; },
    async listDocumentAbstracts() { return [{ id: 'abs_0', chunkId: 'chk_0', documentId: 'doc_0', chunkOrder: 0, filename: 'a.pdf', abstractText: 'Abs A' }]; },
    async listFailedChunks() { return []; },
    async getCurrentSynthesisPlanId() { return 'plan_spin'; },
    async saveSynthesisPlan(_jobId, { planId }) { return { planId, segments: [this.seg] }; },
    async listSynthesisSegments() { return [this.seg]; },
    async listReadySynthesisSegments() {
      listReadyCalls += 1;
      return [this.seg];
    },
    async claimSynthesisSegment() { throw new Error('Neon connection refused'); },
    async getSynthesisStatus() { return { job: this.job, total: 1, pending: 1, processing: 0, complete: 0, failed: 0, retry_wait: 0, hasResult: false }; },
  };
  const spinOut = await processSynthesisJob('job_spin', { store: spinStore, budgetMs: 30_000 });
  assert.equal(listReadyCalls, 1, 'Expected loop to break on first error instead of spinning until deadline');
  assert.ok(spinOut.lastError?.errorMessage?.includes('Neon connection refused'));
});

// ---- H6: OpenRouter server synthesis + HTTP 200 error payload validation ----

test('H6: OpenRouter works for synthesisSetupError, resolvePartialSynthesisModel, and rejects HTTP 200 error payloads', async () => {
  await withEnv({
    MODEL_PROVIDER: 'openrouter',
    OPENROUTER_API_KEY: 'sk-or-synthetic-key',
    GEMINI_API_KEY: undefined,
    GOOGLE_API_KEY: undefined,
    ANTHROPIC_API_KEY: undefined,
    SYNTHESIS_PARTIAL_MODEL: 'google/gemini-3.1-flash-lite',
  }, async () => {
    assert.equal(synthesisSetupError(), null);
    assert.equal(resolvePartialSynthesisModel(), 'google/gemini-3.1-flash-lite');

    const prevFetch = globalThis.fetch;
    try {
      for (const badBody of [
        { error: { code: 502, message: 'Provider overloaded' } },
        { choices: [] },
        { choices: [{ finish_reason: 'error', error: { message: 'Upstream failure' }, message: { content: '' } }] },
      ]) {
        globalThis.fetch = async () => new Response(JSON.stringify(badBody), { status: 200, headers: { 'content-type': 'application/json' } });
        await assert.rejects(
          invokeOpenRouterModel({ model: 'google/gemini-3.1-flash-lite', maxTokens: 100, system: 'sys', messages: [{ role: 'user', content: 'hi' }] }),
        );
      }
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

// ---- H7: Optimistic status guards + POST /result 409 on complete ----

test('H7: updateJob/createDocument/finalizeUploads enforce optimistic status guards and POST /result rejects complete jobs with 409', async () => {
  // updateJob detects concurrent status shift and raises 409
  let readCount = 0;
  const updateJob = extractJobsMethod('updateJob', {
    ensureSchema: async () => {},
    TERMINAL_STATUSES: new Set(['complete', 'partial_failed', 'failed', 'canceled']),
    assertValidStatusTransition,
    isValidStatusTransition,
    JobApiError,
    rowToJob: row => row || null,
    sql: async () => [],
  });
  await assert.rejects(
    updateJob.call({
      async getJob() {
        readCount += 1;
        return readCount === 1
          ? { id: 'job_1', status: 'abstracting', completedDocuments: 0, failedDocuments: 0, currentPhase: 'a' }
          : { id: 'job_1', status: 'canceled', completedDocuments: 0, failedDocuments: 0, currentPhase: 'canceled' };
      },
    }, 'job_1', { status: 'synthesizing' }),
    err => err.statusCode === 409,
  );

  // POST /api/jobs/:id/result returns 409 when job is already complete
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = {
    async getJob() { return { id: 'job_done', status: 'complete' }; },
    async saveJobResult() { throw new Error('saveJobResult must not be called for complete job'); },
  };
  try {
    const res = mockRes();
    await jobPathHandler(mockReq({
      method: 'POST',
      url: '/api/jobs/job_done/result',
      body: { finalTitleOpinion: makeGoodOpinion(), status: 'failed' },
    }), res);
    assert.equal(res.statusCode, 409);
  } finally {
    delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
  }
});

// ---- H8: Atomic split-PDF upload-before-insert and ON CONFLICT status preservation ----

test('H8: splitPdfChunk uploads all children before DB writes and uses commitSplitPdfChunks when available', async () => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 4; i++) pdf.addPage([200, 200]);
  const bytes = Buffer.from(await pdf.save());
  const parent = {
    id: 'chk_parent', jobId: 'job_h8', documentId: 'doc_h8', chunkOrder: 0,
    originalFilename: 'big.pdf', mediaType: 'application/pdf', uploadStatus: 'uploaded',
    abstractionStatus: 'pending', pageStart: 1, pageEnd: 4, sizeBytes: bytes.length, fingerprint: 'fp_h8',
  };
  const events = [];
  let committedChildren = null;
  const store = {
    async claimChunkForAbstraction(_j, _id, opts) { return applyAbstractionClaim(parent, opts); },
    async commitSplitPdfChunks(_j, _d, _p, children) {
      events.push('commit');
      committedChildren = children;
      return { parent: { ...parent, abstractionStatus: 'split_superseded' }, children };
    },
    async createSplitChunk() { throw new Error('should prefer commitSplitPdfChunks'); },
    async markChunkAbstractionSplitSuperseded() { throw new Error('should prefer commitSplitPdfChunks'); },
  };
  const res = await processChunkAbstraction(parent, {
    store,
    workerId: 'wkr_h8',
    maxAttempts: 1,
    blobLoader: async () => ({ bytes, mediaType: 'application/pdf' }),
    blobWriter: async (_p, name) => { events.push(`upload:${name}`); return { blobKey: `k/${name}`, blobUrl: `gs://b/${name}` }; },
    modelClient: async () => { throw Object.assign(new Error('timeout'), { status: 504 }); },
  });
  assert.equal(res.status, 'split_superseded');
  assert.equal(events.length, 3);
  assert.ok(events[0].startsWith('upload:') && events[1].startsWith('upload:') && events[2] === 'commit');
  assert.equal(committedChildren.length, 2);

  // Verify createSplitChunk SQL preserves processing & completed on conflict
  const createSplitStart = jobsSource.indexOf('async createSplitChunk(');
  const createSplitBody = jobsSource.slice(createSplitStart, jobsSource.indexOf('async commitSplitPdfChunks('));
  assert.ok(createSplitBody.includes("('split_superseded', 'processing', 'completed')"));
});

// ---- H9: Filenames with .. or . sanitize cleanly and createSignedUpload forwards config ----

test('H9: sanitizeFilename collapses consecutive dots and bare dot, and createSignedUpload forwards config', async () => {
  const keyDots = buildObjectKey('job_1', 'chk_1', 'Vol 10..12.pdf');
  assert.ok(!keyDots.includes('..'), `Expected no .. in ${keyDots}`);
  assert.equal(keyDots, 'jobs/job_1/chunks/chk_1/Vol-10.12.pdf');

  const keyBareDot = buildObjectKey('job_1', 'chk_1', '.');
  assert.equal(keyBareDot, 'jobs/job_1/chunks/chk_1/document');

  const signed = await createSignedUpload({
    jobId: 'job_1',
    chunkId: 'chk_1',
    originalFilename: 'Vol 10..12.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
  }, {
    config: { bucket: 'custom-bucket', maxUploadBytes: 10_000, signedUrlTtlMs: 60_000 },
    bucket: {
      file(name) {
        return { getSignedUrl: async () => [`https://signed.invalid/${name}`] };
      },
    },
  });
  assert.equal(signed.objectKey, 'jobs/job_1/chunks/chk_1/Vol-10.12.pdf');
  assert.equal(signed.objectUrl, 'gs://custom-bucket/jobs/job_1/chunks/chk_1/Vol-10.12.pdf');
});

// ---- H10: consumeAnthropicMessageStream survives post-message_stop errors/hangs and awaits async onEvent ----

test('H10: Anthropic stream returns finished text on post-message_stop hang/error and awaits onEvent', async () => {
  const enc = new TextEncoder();
  const doneEvents = enc.encode(
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Finished opinion"}}\n\n'
    + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
  // 1. Body that never closes after message_stop
  const hangingBody = new ReadableStream({ start(c) { c.enqueue(doneEvents); } });
  const result = await Promise.race([
    consumeAnthropicMessageStream(hangingBody),
    new Promise(resolve => setTimeout(() => resolve('hung'), 500)),
  ]);
  assert.notEqual(result, 'hung');
  assert.equal(result.text, 'Finished opinion');

  // 2. Async onEvent rejection is awaited & propagated instead of becoming unhandledRejection
  const unhandled = [];
  const onUnhandled = err => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  try {
    const errBody = new ReadableStream({ start(c) { c.enqueue(doneEvents); c.close(); } });
    await assert.rejects(
      consumeAnthropicMessageStream(errBody, { onEvent: async () => { throw new Error('async event error'); } }),
      { message: 'async event error' },
    );
    await tick(10);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ---- H12: analyzeAdditional displayText, >400 cumulative docs, failure PATCH, re-entry, 401, saveActiveJob, hideAddDocs ----

test('H12: renderResults uses displayText, validateCreateJobInput allows >400 cumulative docs, and analyzeAdditional fixes failure PATCH / re-entry / 401 / hideAddDocs', async () => {
  assert.equal(validateCreateJobInput({ totalDocuments: 500 }).valid, true);

  const patches = [];
  let createdCount = 0;
  const app = loadIndex({
    fetchImpl: async (url, init) => {
      if (url === '/api/jobs' && init?.method === 'POST') {
        createdCount += 1;
        return jsonResponse(201, { job: { id: `job_add_${createdCount}`, status: 'created', totalDocuments: JSON.parse(init.body).totalDocuments } });
      }
      if (String(url).startsWith('/api/jobs/job_add_') && init?.method === 'PATCH') {
        patches.push(JSON.parse(init.body));
        return jsonResponse(200, { job: { id: 'job_add_1', status: 'failed', completedDocuments: 2, failedDocuments: 1 } });
      }
      if (url === '/api/analyze') {
        return jsonResponse(500, { error: 'Model failure' });
      }
      return jsonResponse(404, {});
    },
  });
  app.ctx.__h12Init = makeGoodOpinion('Initial');
  app.ctx.__h12Upd = makeGoodOpinion('Updated');
  app.run(`conversationHistory.push(
    { role: 'user', content: 'HUGE RAW PROMPT', displayText: 'Analyzed 2 document(s)', kind: 'analysis-input' },
    { role: 'assistant', content: __h12Init, kind: 'title-opinion' },
    { role: 'user', content: 'HUGE CONTINUATION RAW PROMPT', displayText: 'Added 1 more document(s) — re-analyzed all 3 together', kind: 'analysis-input' },
    { role: 'assistant', content: __h12Upd, kind: 'title-opinion' },
  )`);
  app.ctx.renderResults();
  const html = app.getEl('results').innerHTML;
  assert.ok(html.includes('Added 1 more document(s)'), 'Expected displayText to be rendered');
  assert.ok(!html.includes('HUGE CONTINUATION RAW PROMPT'), 'Must not dump raw synthesisInput prompt into Q card');

  // Test browser abstraction failure PATCH does not double-add priorCount
  app.run("documentAbstracts = [{ filename: 'a.pdf', abstract: 'A' }, { filename: 'b.pdf', abstract: 'B' }]");
  app.ctx.__h12File = pngFile('c.png');
  app.run('additionalFiles = [__h12File]');
  app.run('document.getElementById("tractDescription").value = "Tract"');
  await app.ctx.analyzeAdditional({ skipDurableUpload: true });
  const failPatch = patches.at(-1);
  assert.ok(failPatch && failPatch.status === 'failed');
  assert.equal(failPatch.completedDocuments, 2, 'completedDocuments must not double-add priorCount');
  assert.equal(failPatch.failedDocuments, 1);

  // hideAddDocs restores #results when canceling after failure
  app.getEl('results').innerHTML = '';
  app.ctx.hideAddDocs();
  assert.ok(app.getEl('results').innerHTML.length > 0, 'hideAddDocs must re-render #results when conversationHistory exists');
});

// ---- H13: Canceling a browser-driven run stops runDocumentAbstraction & hierarchicalSynthesis ----

test('H13: canceling a browser run stops runDocumentAbstraction and hierarchicalSynthesis between batches/segments', async () => {
  let analyzeCalls = 0;
  let runRef;
  const app = loadIndex({
    fetchImpl: async url => {
      if (url === '/api/analyze') {
        analyzeCalls += 1;
        if (analyzeCalls === 1 && runRef) {
          app.ctx.cancelAllAnalysisRuns();
        }
        return jsonResponse(200, { content: [{ type: 'text', text: 'DOCUMENT #1:\nGRANTOR: A\nCONFIDENCE: High' }] });
      }
      return jsonResponse(404, {});
    },
  });
  runRef = app.ctx.beginAnalysisRun('job_h13');
  app.run('buildSynthesisChunks = abstracts => abstracts.map(a => [a])');
  const docs = [
    { filename: 'a.pdf', abstract: 'Abs A' },
    { filename: 'b.pdf', abstract: 'Abs B' },
    { filename: 'c.pdf', abstract: 'Abs C' },
  ];
  const progressCalls = [];
  await app.ctx.hierarchicalSynthesis(docs, 'Tract', '', msg => progressCalls.push(msg), runRef);
  assert.equal(analyzeCalls, 1, 'Expected cancellation after segment 1 to stop segment 2, 3, and final merge');
  assert.equal(progressCalls.length, 1);
});

// ---- H14: callBackend classifies JSON 401 password errors, selects ANTHROPIC_API_KEY hint, and attaches .status ----

test('H14: callBackend reports JSON 401 password errors accurately, picks right key hint, and sets err.status', async () => {
  const app = loadIndex({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === 'claude-sonnet-5-5' && body.messages[0].content === 'key-error') {
        return jsonResponse(401, { error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }
      return jsonResponse(401, { error: 'Invalid password.' });
    },
  });
  await assert.rejects(
    app.ctx.callBackend([{ role: 'user', content: 'hi' }], 'sys', { model: 'gemini-3.1-flash-lite' }),
    err => err.status === 401 && /Incorrect password/i.test(err.message) && !/GEMINI_API_KEY/.test(err.message),
  );
  await assert.rejects(
    app.ctx.callBackend([{ role: 'user', content: 'key-error' }], 'sys', { model: 'claude-sonnet-5-5' }),
    err => err.status === 401 && /ANTHROPIC_API_KEY/.test(err.message),
  );
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`✗ ${name}`);
    console.error(err);
  } finally {
    disposeAll();
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
