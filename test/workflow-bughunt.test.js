// Provider/orchestration bug-hunt regressions (findings 4, 5, 6, 7, 8, 18).
// Production code runs for real (processSynthesisJob, processSynthesisBatch, model-client, OpenRouter
// stream parser). Only external side effects are replaced: the job store and global fetch / model client.
// Set TITLEWORK_TEST_FILTER=<substring> to run a subset while iterating.
import assertStrict from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PARTIAL_SYNTHESIS_PROMPT,
  processSynthesisJob,
} from '../api/_lib/synthesis.js';
import { processSynthesisBatch } from '../api/_lib/queue.js';
import { invokeModel } from '../api/_lib/model-client.js';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const OPINION = '## CHAIN OF TITLE\n| Grantor | Grantee |\n| A | B |\n\n## FINAL OWNERSHIP\nB has one-half mineral interest.\n\n## OPINION QUALIFICATIONS\n'
  + 'Verify all instruments against source records. '.repeat(8)
  + '\n- Recorded release qualification: the source instrument is missing. Verify manually before relying on ownership.';
const TRUNCATED_OPINION = OPINION.slice(0, OPINION.indexOf('missing.'));
const SEGMENT = '## CHAIN ROWS\n| Date | Doc Type | Grantor | Grantee |\n| 2001 | Deed | A | B |\n\n## DEFECTS\nnone\n\n## RUNNING BALANCE\n| B | 1/2 | ' + 'chain content filler '.repeat(12) + ' |';

function makeStore({ docCount = 1, failedChunks = [], listFailedChunks } = {}) {
  const job = { id: 'job_probe', status: 'synthesizing', subjectTract: 'Synthetic tract', contextNotes: '' };
  const abstracts = Array.from({ length: docCount }, (_, i) => ({
    id: `abs_${i}`, chunkId: `c${i}`, documentId: `d${i}`, chunkOrder: i, originalFilename: `deed${i}.pdf`,
    abstractText: `DOC TYPE: Deed\nGRANTOR: A${i}\nGRANTEE: B${i}\nINTEREST: 1/2 mineral interest`,
  }));
  let planId = null;
  let segments = [];
  let result = null;
  const previews = [];
  const calls = { saveJobResult: [], claimSynthesisMerge: 0, claimSegment: [] };
  const counts = () => {
    const c = { pending: 0, processing: 0, retry_wait: 0, complete: 0, failed: 0 };
    for (const s of segments) c[s.status] += 1;
    return c;
  };
  const find = id => segments.find(s => s.id === id);
  const store = {
    job, previews, calls,
    segmentsSnapshot: () => segments.map(s => ({ ...s })),
    get result() { return result; },
    async getJob() { return { ...job }; },
    async getAbstractionStatus() { return { pending: 0, processing: 0, retry_wait: 0, completed: docCount, failed: failedChunks.length }; },
    async listDocumentAbstracts() { return abstracts.map(a => ({ ...a })); },
    async getCurrentSynthesisPlanId() { return planId; },
    async saveSynthesisPlan(_jobId, plan) {
      planId = plan.planId;
      segments = plan.segments.map((s, i) => ({ ...s, id: `seg_${i}`, planId, status: 'pending', attemptCount: 0, workerId: null, summaryText: null, warnings: [], inputTokens: 0, outputTokens: 0 }));
      return { planId, segments: segments.map(s => ({ ...s })) };
    },
    async listSynthesisSegments() { return segments.map(s => ({ ...s })); },
    // Like the real store, readiness and claims do not look at job cancellation.
    async listReadySynthesisSegments(_jobId, _plan, limit) {
      return segments.filter(s => s.status === 'pending' || s.status === 'retry_wait').slice(0, limit).map(s => ({ ...s }));
    },
    async claimSynthesisSegment(_jobId, id, { workerId }) {
      const s = find(id);
      if (!s || !['pending', 'retry_wait'].includes(s.status)) return null;
      Object.assign(s, { status: 'processing', attemptCount: s.attemptCount + 1, workerId });
      calls.claimSegment.push(id);
      return { ...s };
    },
    async completeSynthesisSegment(_jobId, id, payload) {
      const s = find(id);
      if (!s || s.status !== 'processing' || s.workerId !== payload.workerId) return null;
      Object.assign(s, { status: 'complete', summaryText: payload.summaryText, modelUsed: payload.modelUsed, inputTokens: payload.inputTokens ?? 0, outputTokens: payload.outputTokens ?? 0, warnings: payload.warnings || [], workerId: null });
      return { ...s };
    },
    async markSynthesisSegmentFailed(_jobId, id, payload) {
      const s = find(id);
      if (!s || s.status !== 'processing' || s.workerId !== payload.workerId) return null;
      Object.assign(s, { status: 'failed', errorType: payload.errorType, errorMessage: payload.errorMessage, workerId: null });
      return { ...s };
    },
    async markSynthesisSegmentRetryWait(_jobId, id, payload) {
      const s = find(id);
      if (!s || s.status !== 'processing' || s.workerId !== payload.workerId) return null;
      Object.assign(s, { status: 'retry_wait', errorType: payload.errorType, workerId: null });
      return { ...s };
    },
    async getJobResult() { return result; },
    async claimSynthesisMerge(_jobId, _plan, { workerId }) {
      calls.claimSynthesisMerge += 1;
      return job.status === 'canceled' ? null : { workerId };
    },
    async saveJobResult(_jobId, payload) {
      calls.saveJobResult.push({ ...payload });
      if (job.status === 'canceled') return null;
      result = { ...payload };
      job.status = payload.status;
      return result;
    },
    async listFailedChunks(jobId) {
      if (listFailedChunks) return listFailedChunks(jobId);
      return failedChunks;
    },
    async getSynthesisStatus() { return { ...counts(), mergeInProgress: false, hasResult: Boolean(result) }; },
    async getSynthesisPreview() { return previews.at(-1) || null; },
    async clearSynthesisPreview() { previews.push({ cleared: true }); },
    async setSynthesisPreview(_jobId, patch) { previews.push({ ...patch }); return patch; },
  };
  return store;
}

const sse = payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
function routerStream(mode, text) {
  let wire = sse({ model: 'anthropic/claude-sonnet-5.5', choices: [{ index: 0, delta: { content: text } }] });
  if (mode === 'error') wire += sse({ error: { code: 502, message: 'provider failed mid-stream' } });
  if (mode === 'normal' || mode === 'length') {
    wire += sse({ choices: [{ index: 0, delta: {}, finish_reason: mode === 'length' ? 'length' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 90 } });
    wire += 'data: [DONE]\n\n';
  }
  return new Response(wire, { headers: { 'content-type': 'text/event-stream' } });
}

const ENV_KEYS = ['MODEL_PROVIDER', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'SYNTHESIS_STREAM_ENABLED'];
async function withEnvironment(overrides, fn) {
  const previousEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  const previousFetch = globalThis.fetch;
  const previousLog = console.log;
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error?.message ?? String(error));
  process.on('unhandledRejection', onUnhandled);
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
  console.log = () => {};
  try {
    return await fn({ unhandled });
  } finally {
    console.log = previousLog;
    globalThis.fetch = previousFetch;
    for (const key of ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    process.off('unhandledRejection', onUnhandled);
  }
}
const openRouterEnv = { MODEL_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'fixture-not-a-real-key' };
const settle = () => new Promise(resolve => setImmediate(resolve));

// Finding 4: a streamed final merge through OpenRouter used to call onDelta(delta) without the accumulated
// text and without awaiting it. The preview callback then threw and crashed the process on valid output.
test('finding 4: OpenRouter streamed final merge completes and publishes the preview', async () => {
  await withEnvironment(openRouterEnv, async ({ unhandled }) => {
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ stream: body.stream === true, max_tokens: body.max_tokens });
      if (body.stream) return routerStream('normal', OPINION);
      return Response.json({ model: body.model, choices: [{ message: { content: SEGMENT }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 30 } });
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, config: { chunkSize: 1, maxAttempts: 1 }, streamFinalOpinion: true, workerId: 'probe', budgetMs: 5000 });
    await settle();
    assertStrict.equal(out.result.status, 'complete', JSON.stringify(out.result.warnings));
    assertStrict.equal(out.result.finalTitleOpinion, OPINION);
    assertStrict.deepEqual(out.result.warnings, []);
    assertStrict.equal(requests.filter(request => request.stream).length, 1, 'the merge is the only streamed call');
    const finalPreview = store.previews.filter(preview => preview.text !== undefined).at(-1);
    assertStrict.equal(finalPreview.complete, true);
    assertStrict.equal(finalPreview.text, OPINION);
    assertStrict.deepEqual(unhandled, []);
  });
});

// Finding 5: an OpenRouter stream that ends in an SSE error frame, or in a clean EOF without the protocol
// terminator, used to be saved as a complete opinion cut off before its last qualification.
test('finding 5: incomplete OpenRouter single-pass streams are never saved as a complete opinion', async () => {
  for (const mode of ['normal', 'eof', 'error']) {
    await withEnvironment(openRouterEnv, async ({ unhandled }) => {
      const sent = mode === 'normal' ? OPINION : TRUNCATED_OPINION;
      let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls += 1;
        assertStrict.equal(JSON.parse(init.body).stream, true, 'max_tokens above 8192 takes the streaming path');
        return routerStream(mode, sent);
      };
      const store = makeStore();
      const out = await processSynthesisJob('job_probe', { store, config: { maxTokens: 16000, maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
      await settle();
      assertStrict.equal(calls, 1, `${mode}: exactly one provider call`);
      assertStrict.deepEqual(unhandled, []);
      if (mode === 'normal') {
        assertStrict.equal(out.result.status, 'complete');
        assertStrict.equal(out.result.finalTitleOpinion, OPINION);
        assertStrict.deepEqual(out.result.warnings, []);
      } else {
        assertStrict.equal(out.result.status, 'failed', `${mode}: truncated provider output must not be a finished opinion`);
        assertStrict.equal(out.result.finalTitleOpinion, '');
        assertStrict.ok(store.calls.saveJobResult.every(saved => saved.status !== 'complete' && !saved.finalTitleOpinion.includes('Recorded release qualification')));
      }
    });
  }
});

test('finding 5: an incomplete OpenRouter final merge without the preview callback fails the merge', async () => {
  for (const mode of ['eof', 'error']) {
    await withEnvironment(openRouterEnv, async ({ unhandled }) => {
      let mergeCalls = 0;
      globalThis.fetch = async (_url, init) => {
        const body = JSON.parse(init.body);
        if (body.stream) { mergeCalls += 1; return routerStream(mode, TRUNCATED_OPINION); }
        return Response.json({ model: body.model, choices: [{ message: { content: SEGMENT }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 30 } });
      };
      const store = makeStore({ docCount: 2 });
      const out = await processSynthesisJob('job_probe', { store, config: { chunkSize: 1, maxAttempts: 1 }, streamFinalOpinion: false, workerId: 'probe', budgetMs: 5000 });
      await settle();
      assertStrict.equal(mergeCalls, 1, `${mode}: the merge is attempted once`);
      assertStrict.equal(out.result.status, 'failed', `${mode}`);
      assertStrict.equal(out.result.finalTitleOpinion, '');
      assertStrict.ok(out.result.warnings.some(warning => warning.startsWith('final_merge_failed')), JSON.stringify(out.result.warnings));
      assertStrict.deepEqual(unhandled, []);
    });
  }
});

// Finding 6: a response that stopped at the token limit is not a finished opinion, whichever path produced it.
function anthropicJson(text, stopReason) {
  return Response.json({ model: 'claude-sonnet-5-5', content: [{ type: 'text', text }], stop_reason: stopReason, usage: { input_tokens: 100, output_tokens: 8000 } });
}
const anthropicEnv = { ANTHROPIC_API_KEY: 'fixture-not-a-real-key' };

test('finding 6: a direct Anthropic single-document response cut off at max_tokens is not saved as complete', async () => {
  await withEnvironment(anthropicEnv, async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls += 1; return anthropicJson(OPINION, 'max_tokens'); };
    const store = makeStore();
    const out = await processSynthesisJob('job_probe', { store, config: { maxAttempts: 3 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.equal(calls, 1, 'a truncated terminal response must not trigger a new billable retry');
    assertStrict.equal(out.result.status, 'failed');
    assertStrict.equal(out.result.finalTitleOpinion, '');
    assertStrict.ok(out.result.warnings.includes('segment_1_failed: output_truncated'), JSON.stringify(out.result.warnings));
  });
});

test('finding 6: an OpenRouter length stop on a single document is not saved as complete', async () => {
  for (const streamed of [false, true]) {
    await withEnvironment(openRouterEnv, async () => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (streamed) return routerStream('length', OPINION);
        return Response.json({ model: 'anthropic/claude-sonnet-5.5', choices: [{ message: { content: OPINION }, finish_reason: 'length' }], usage: { prompt_tokens: 100, completion_tokens: 8000 } });
      };
      const store = makeStore();
      const out = await processSynthesisJob('job_probe', { store, config: { maxTokens: streamed ? 16000 : 8000, maxAttempts: 3 }, workerId: 'probe', budgetMs: 5000 });
      assertStrict.equal(calls, 1, `streamed=${streamed}`);
      assertStrict.equal(out.result.status, 'failed', `streamed=${streamed}`);
      assertStrict.equal(out.result.finalTitleOpinion, '');
    });
  }
});

test('finding 6: a truncated multi-document pass still takes the existing split path, now for OpenRouter length too', async () => {
  await withEnvironment(openRouterEnv, async () => {
    const kinds = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const partial = body.messages[0].content === PARTIAL_SYNTHESIS_PROMPT;
      kinds.push(partial ? 'partial' : kinds.length === 0 ? 'full-truncated' : 'merge');
      const text = partial ? SEGMENT : OPINION;
      const finish = kinds.length === 1 ? 'length' : 'stop';
      return Response.json({ model: 'anthropic/claude-sonnet-5.5', choices: [{ message: { content: text }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, config: { maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(kinds, ['full-truncated', 'partial', 'partial', 'merge']);
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.equal(out.result.finalTitleOpinion, OPINION);
  });
});

test('finding 6: truncation-driven splitting is capped at one level, so a document count cannot fan the spend out', async () => {
  for (const docCount of [8, 32]) {
    await withEnvironment(openRouterEnv, async () => {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return Response.json({ model: 'anthropic/claude-sonnet-5.5', choices: [{ message: { content: SEGMENT }, finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
      };
      const store = makeStore({ docCount });
      const out = await processSynthesisJob('job_probe', { store, config: { maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
      assertStrict.equal(out.result.status, 'failed', `${docCount} documents`);
      // Per planned segment: one full call, then one half that also truncates. The half does not split again and the
      // segment fails closed, so spend grows with the number of segments and not with recursion depth.
      const segmentCount = (await store.listSynthesisSegments()).length;
      assertStrict.equal(calls, 2 * segmentCount, `${docCount} documents in ${segmentCount} segment(s): every call truncated`);
    });
  }
});

test('finding 6: a truncated final merge fails closed and its streamed preview is never marked complete', async () => {
  await withEnvironment({}, async () => {
    const systems = [];
    const modelClient = async request => {
      systems.push(request.system === PARTIAL_SYNTHESIS_PROMPT ? 'partial' : 'final');
      if (request.system === PARTIAL_SYNTHESIS_PROMPT) return { text: SEGMENT, model: 'gemini-3.1-flash-lite', usage: {}, stopReason: 'end_turn' };
      if (request.onDelta) await request.onDelta(OPINION, OPINION);
      return { text: OPINION, model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 5 }, stopReason: 'max_tokens' };
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 1, maxAttempts: 1 }, streamFinalOpinion: true, workerId: 'probe', budgetMs: 5000 });
    // 2 segments, truncated merge, existing split into 2 partials, truncated re-merge. Nothing is retried beyond that.
    assertStrict.deepEqual(systems, ['partial', 'partial', 'final', 'partial', 'partial', 'final']);
    assertStrict.equal(out.result.status, 'failed');
    assertStrict.equal(out.result.finalTitleOpinion, '');
    assertStrict.ok(out.result.warnings.includes('final_merge_failed: output_truncated'), JSON.stringify(out.result.warnings));
    assertStrict.ok(store.previews.every(preview => preview.complete !== true), 'a truncated preview must not be recoverable as complete');
  });
});

test('finding 6: a repair retry that stops at max_tokens is not accepted as the repaired opinion', async () => {
  await withEnvironment({}, async () => {
    const responses = [
      { text: 'too short', stopReason: 'end_turn' },
      { text: OPINION, stopReason: 'max_tokens' },
    ];
    let calls = 0;
    const modelClient = async () => ({ ...responses[calls++], model: 'claude-sonnet-5-5', usage: {} });
    const store = makeStore();
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 3 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.equal(calls, 2, 'one initial call plus the existing repair call; nothing more');
    assertStrict.equal(out.result.status, 'failed');
    assertStrict.equal(out.result.finalTitleOpinion, '');
    assertStrict.ok(out.result.warnings.includes('segment_1_failed: output_truncated'), JSON.stringify(out.result.warnings));
  });
});

// Finding 7: a storage error while listing failed documents used to be read as "no failed documents",
// so the missing-source warning was dropped and the result was saved as complete.
const lookupFailure = () => { throw new Error('temporary DB read failure'); };
const failedChunk = { id: 'c_failed', documentId: 'd_failed', chunkOrder: 9, originalFilename: 'failed.pdf', abstractionErrorType: 'provider_error', abstractionErrorMessage: 'boom' };

test('finding 7: a failed-document lookup error stops a single-pass save instead of reading as no failures', async () => {
  await withEnvironment({}, async () => {
    const modelClient = async () => ({ text: OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: 'end_turn' });
    const store = makeStore({ failedChunks: [failedChunk], listFailedChunks: lookupFailure });
    await assertStrict.rejects(
      processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 }),
      { message: 'temporary DB read failure' },
    );
    assertStrict.deepEqual(store.calls.saveJobResult, []);
  });
});

test('finding 7: a failed-document lookup error stops a multi-segment merge before any billable merge call or save', async () => {
  await withEnvironment({}, async () => {
    let finalCalls = 0;
    const modelClient = async request => {
      if (request.system === PARTIAL_SYNTHESIS_PROMPT) return { text: SEGMENT, model: 'gemini-3.1-flash-lite', usage: {}, stopReason: 'end_turn' };
      finalCalls += 1;
      return { text: OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: 'end_turn' };
    };
    const store = makeStore({ docCount: 2, failedChunks: [failedChunk], listFailedChunks: lookupFailure });
    await assertStrict.rejects(
      processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 1, maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 }),
      { message: 'temporary DB read failure' },
    );
    assertStrict.equal(finalCalls, 0, 'the exclusion set must be known before paying for the final merge');
    assertStrict.deepEqual(store.calls.saveJobResult, []);
  });
});

test('finding 7: a failed-document lookup error stops the degraded and all-failed saves too', async () => {
  for (const goodSegments of [1, 0]) {
    await withEnvironment({}, async () => {
      let segmentCalls = 0;
      const modelClient = async request => {
        if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
          segmentCalls += 1;
          if (segmentCalls > goodSegments) { const err = new Error('bad request'); err.status = 400; throw err; }
          return { text: SEGMENT, model: 'gemini-3.1-flash-lite', usage: {}, stopReason: 'end_turn' };
        }
        return { text: OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: 'end_turn' };
      };
      const store = makeStore({ docCount: 2, failedChunks: [failedChunk], listFailedChunks: lookupFailure });
      await assertStrict.rejects(
        processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 1, maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 }),
        { message: 'temporary DB read failure' },
        `goodSegments=${goodSegments}`,
      );
      assertStrict.deepEqual(store.calls.saveJobResult, []);
    });
  }
});

test('finding 7: a readable failed-document list still produces a partial_failed result naming the document', async () => {
  await withEnvironment({}, async () => {
    const modelClient = async () => ({ text: OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: 'end_turn' });
    const store = makeStore({ failedChunks: [failedChunk] });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.equal(out.result.status, 'partial_failed');
    assertStrict.equal(out.result.failedDocuments.length, 1);
    assertStrict.equal(out.result.failedDocuments[0].filename, 'failed.pdf');
    assertStrict.equal(out.result.finalTitleOpinion, OPINION);
  });
});

// Finding 8: processSynthesisBatch used to inject the abstraction retry budget (ABSTRACTION_MAX_ATTEMPTS,
// default 5) as the synthesis budget, overriding SYNTHESIS_MAX_ATTEMPTS (default 3).
async function failingSegmentCalls(run) {
  let calls = 0;
  const modelClient = async () => {
    calls += 1;
    const err = new Error('upstream unavailable');
    err.status = 503;
    throw err;
  };
  const store = makeStore();
  await run(store, modelClient);
  return calls;
}
const queued = (options = {}) => (store, modelClient) => processSynthesisBatch('job_probe', { store, modelClient, budgetMs: 5000, ...options });
const direct = (options = {}) => (store, modelClient) => processSynthesisJob('job_probe', { store, modelClient, workerId: 'probe', budgetMs: 5000, ...options });

test('finding 8: queued synthesis uses the synthesis retry budget, the same as direct synthesis', async () => {
  await withEnvironment({}, async () => {
    const queuedCalls = await failingSegmentCalls(queued());
    const directCalls = await failingSegmentCalls(direct());
    assertStrict.equal(directCalls, 3, 'synthesis default is 3 attempts');
    assertStrict.equal(queuedCalls, directCalls, 'the queue must not widen the synthesis budget');
  });
});

test('finding 8: an explicit synthesis config budget is honored on the queue path and abstraction options do not leak in', async () => {
  await withEnvironment({}, async () => {
    assertStrict.equal(await failingSegmentCalls(queued({ config: { maxAttempts: 2 } })), 2);
    assertStrict.equal(await failingSegmentCalls(queued({ maxAttempts: 7 })), 3, 'options.maxAttempts is the abstraction budget');
  });
});

test('finding 8: SYNTHESIS_MAX_ATTEMPTS caps queued synthesis even when ABSTRACTION_MAX_ATTEMPTS is larger', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child-env-attempts'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, SYNTHESIS_MAX_ATTEMPTS: '1', ABSTRACTION_MAX_ATTEMPTS: '5' },
    encoding: 'utf8',
  });
  assertStrict.equal(child.status, 0, child.stderr);
  assertStrict.deepEqual(JSON.parse(child.stdout.trim().split('\n').at(-1)), { queued: 1, direct: 1 });
});

// Finding 18: with batch limit above concurrency, segments queued behind the concurrency limit used to start
// after the job was canceled, because cancellation was only read once per batch.
async function runQueuedSegments({ cancelDuringCall }) {
  const store = makeStore({ docCount: 4 });
  let calls = 0;
  const modelClient = async request => {
    if (request.system !== PARTIAL_SYNTHESIS_PROMPT) return { text: OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: 'end_turn' };
    calls += 1;
    if (calls === cancelDuringCall) store.job.status = 'canceled';
    return { text: SEGMENT, model: 'gemini-3.1-flash-lite', usage: {}, stopReason: 'end_turn' };
  };
  const out = await processSynthesisJob('job_probe', {
    store, modelClient, workerId: 'probe', budgetMs: 5000, batchLimit: 4, config: { chunkSize: 1, maxAttempts: 1, concurrency: 1 },
  });
  return { store, out, segmentCalls: () => calls };
}

test('finding 18: a cancel during the first queued segment stops the segments waiting behind the concurrency limit', async () => {
  await withEnvironment({}, async () => {
    const { store, out, segmentCalls } = await runQueuedSegments({ cancelDuringCall: 1 });
    assertStrict.equal(segmentCalls(), 1, 'only the in-flight call may run after the cancel');
    assertStrict.deepEqual(store.segmentsSnapshot().map(segment => segment.status), ['complete', 'pending', 'pending', 'pending']);
    assertStrict.deepEqual(store.calls.claimSegment, ['seg_0'], 'canceled work must not even claim the remaining segments');
    assertStrict.deepEqual(store.calls.saveJobResult, []);
    assertStrict.equal(out.mergeRan, false);
  });
});

test('finding 18: a cancel between later admissions is honored at the next admission', async () => {
  await withEnvironment({}, async () => {
    const { store, segmentCalls } = await runQueuedSegments({ cancelDuringCall: 3 });
    assertStrict.equal(segmentCalls(), 3);
    assertStrict.deepEqual(store.segmentsSnapshot().map(segment => segment.status), ['complete', 'complete', 'complete', 'pending']);
  });
});

test('finding 18: without a cancel every queued segment runs and the merge saves', async () => {
  await withEnvironment({}, async () => {
    const { store, out, segmentCalls } = await runQueuedSegments({ cancelDuringCall: 0 });
    assertStrict.equal(segmentCalls(), 4);
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.equal(store.calls.saveJobResult.length, 1);
  });
});

// Finding 6 (Gemini): partial segment synthesis runs on Gemini, which reports a token-limit stop as 'MAX_TOKENS'.
// Normalized once in the model client, that stop must fail the segment like the Anthropic/OpenRouter ones do.
test('finding 6: a Gemini partial segment cut off at MAX_TOKENS is not saved as a completed segment', async () => {
  await withEnvironment({ GEMINI_API_KEY: 'fixture-not-a-real-key' }, async () => {
    const geminiCalls = [];
    globalThis.fetch = async (url, init) => {
      assertStrict.match(String(url), /generativelanguage\.googleapis\.com/, 'segment synthesis uses the Gemini route');
      geminiCalls.push(JSON.parse(init.body));
      return Response.json({
        candidates: [{ content: { parts: [{ text: SEGMENT }] }, finishReason: 'MAX_TOKENS' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
        modelVersion: 'gemini-3.1-flash-lite',
      });
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, config: { chunkSize: 1, maxAttempts: 3 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.equal(geminiCalls.length, 2, 'one call per segment; a truncated segment is not retried');
    assertStrict.deepEqual(store.segmentsSnapshot().map(segment => segment.status), ['failed', 'failed']);
    assertStrict.equal(out.result.status, 'failed');
    assertStrict.ok(out.result.warnings.includes('segment_1_failed: output_truncated'), JSON.stringify(out.result.warnings));
  });
});

test('finding 6: a Gemini finish that is not a token limit keeps its raw reason', async () => {
  await withEnvironment({ GEMINI_API_KEY: 'fixture-not-a-real-key' }, async () => {
    globalThis.fetch = async () => Response.json({
      candidates: [{ content: { parts: [{ text: SEGMENT }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
    });
    const result = await invokeModel({ model: 'gemini-3.1-flash-lite', maxTokens: 1000, system: 'sys', messages: [{ role: 'user', content: 'hi' }] });
    assertStrict.equal(result.stopReason, 'STOP');
    assertStrict.equal(result.text, SEGMENT);
  });
});

// A truncated recombine after a truncation split used to fail the segment and discard both finished halves.
function callKind(request) {
  const text = JSON.stringify(request.messages);
  if (/Merge these partial chain-of-title syntheses/.test(text)) return 'recombine';
  if (request.system === PARTIAL_SYNTHESIS_PROMPT && /split automatically/.test(text)) return 'half';
  if (/partial chain-of-title segments covering all/.test(text)) return 'final';
  return 'original';
}

test('recombine recovery: a multi-segment plan keeps the finished halves when the recombine truncates, with no extra call', async () => {
  await withEnvironment({}, async () => {
    const calls = [];
    const OUTPUT = { original: 1, half: 2, recombine: 8, final: 64 };
    const modelClient = async request => {
      const kind = callKind(request);
      calls.push({ kind, text: JSON.stringify(request.messages) });
      // Only the first segment (deed0, deed1) truncates; only a split segment ever recombines.
      const truncated = kind === 'recombine' || (kind === 'original' && JSON.stringify(request.messages).includes('deed0.pdf'));
      const text = kind === 'final' ? OPINION : (kind === 'half' ? `${SEGMENT} HALF_${calls.filter(c => c.kind === 'half').length}` : SEGMENT);
      return { text, model: 'gemini-3.1-flash-lite', usage: { input_tokens: 1, output_tokens: OUTPUT[kind] }, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 4 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 2, maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
    const segments = store.segmentsSnapshot();
    assertStrict.equal(segments.length, 2, JSON.stringify(segments.map(s => s.documentIds)));
    assertStrict.deepEqual(calls.map(c => c.kind), ['original', 'half', 'half', 'recombine', 'original', 'final']);
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.equal(out.result.finalTitleOpinion, OPINION);
    const kept = segments[0];
    assertStrict.equal(kept.status, 'complete');
    assertStrict.deepEqual(kept.warnings, ['segment_split', 'segment_split_halves_kept']);
    assertStrict.ok(kept.summaryText.includes('HALF_1') && kept.summaryText.includes('HALF_2'), kept.summaryText);
    assertStrict.ok(kept.summaryText.indexOf('HALF_1') < kept.summaryText.indexOf('HALF_2'), 'halves stay in document order');
    // Halves plus the billed, truncated recombine: 2 + 2 + 8. The truncated original is not counted; that gap predates this change.
    assertStrict.equal(kept.outputTokens, 12);
    assertStrict.ok(calls.at(-1).text.includes('HALF_1') && calls.at(-1).text.includes('HALF_2'), 'the final merge reads both halves');
    assertStrict.ok(out.result.warnings.includes('segment_1:segment_split_halves_kept'), JSON.stringify(out.result.warnings));
  });
});

test('recombine recovery: a recombine that fails for any other reason does not keep the halves', async () => {
  await withEnvironment({}, async () => {
    const kinds = [];
    const modelClient = async request => {
      const kind = callKind(request);
      kinds.push(kind);
      if (kind === 'recombine') throw Object.assign(new Error('bad request'), { status: 400 });
      const truncated = kind === 'original' && JSON.stringify(request.messages).includes('deed0.pdf');
      return { text: kind === 'final' ? OPINION : SEGMENT, model: 'gemini-3.1-flash-lite', usage: {}, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 4 });
    await processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 2, maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
    const [first] = store.segmentsSnapshot();
    assertStrict.equal(first.status, 'failed');
    assertStrict.notEqual(first.errorType, 'output_truncated');
    assertStrict.equal(first.summaryText, null, 'a non-truncation recombine failure saves no halves');
    assertStrict.deepEqual(kinds.slice(0, 4), ['original', 'half', 'half', 'recombine'], 'the failed recombine is not retried');
  });
});

test('recombine recovery: a single-pass recombine that truncates is retried once with the final-merge limit', async () => {
  await withEnvironment({}, async () => {
    const calls = [];
    const OUTPUT = { original: 1, half: 2, recombine: 8, retry: 32 };
    const modelClient = async request => {
      let kind = callKind(request);
      if (kind === 'recombine' && calls.some(c => c.kind === 'recombine')) kind = 'retry';
      calls.push({ kind, maxTokens: request.maxTokens });
      const truncated = kind === 'original' || kind === 'recombine';
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: OUTPUT[kind] }, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 1, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(calls.map(c => c.kind), ['original', 'half', 'half', 'recombine', 'retry']);
    assertStrict.equal(calls[3].maxTokens, 8000);
    assertStrict.equal(calls[4].maxTokens, 16000, 'the retry uses SYNTHESIS_MERGE_MAX_TOKENS (default 16000)');
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.equal(out.result.finalTitleOpinion, OPINION);
    const [segment] = store.segmentsSnapshot();
    assertStrict.deepEqual(segment.warnings, ['segment_split', 'segment_split_recombine_retry']);
    // Halves, the billed truncated recombine and the retry. The truncated original is not counted; that gap predates this change.
    assertStrict.equal(segment.outputTokens, 2 + 2 + 8 + 32);
  });
});

test('recombine recovery: a single-pass retry that also truncates fails closed after exactly five calls', async () => {
  await withEnvironment({}, async () => {
    const kinds = [];
    const modelClient = async request => {
      const kind = callKind(request);
      kinds.push(kind);
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: kind === 'half' ? 'end_turn' : 'max_tokens' };
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 3 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(kinds, ['original', 'half', 'half', 'recombine', 'recombine']);
    assertStrict.equal(out.result.status, 'failed');
    assertStrict.equal(out.result.finalTitleOpinion, '');
    assertStrict.ok(out.result.warnings.includes('segment_1_failed: output_truncated'), JSON.stringify(out.result.warnings));
  });
});

test('recombine recovery: the single-pass retry above 8192 tokens takes the OpenRouter streaming path', async () => {
  await withEnvironment(openRouterEnv, async () => {
    const requests = [];
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      const text = JSON.stringify(body.messages);
      const kind = /Merge these partial chain-of-title syntheses/.test(text)
        ? (requests.some(r => r.kind === 'recombine') ? 'retry' : 'recombine')
        : body.messages[0].content === PARTIAL_SYNTHESIS_PROMPT ? 'half' : 'original';
      requests.push({ kind, stream: body.stream === true, maxTokens: body.max_tokens });
      if (body.stream) return routerStream('normal', OPINION);
      const finish = kind === 'half' ? 'stop' : 'length';
      return Response.json({ model: 'anthropic/claude-sonnet-5.5', choices: [{ message: { content: kind === 'half' ? SEGMENT : OPINION }, finish_reason: finish }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, config: { maxAttempts: 1, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(requests.map(r => r.kind), ['original', 'half', 'half', 'recombine', 'retry']);
    assertStrict.deepEqual(requests.at(-1), { kind: 'retry', stream: true, maxTokens: 16000 });
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.equal(out.result.finalTitleOpinion, OPINION);
  });
});

if (process.argv.includes('--child-env-attempts')) {
  // Child mode for the environment-variable test above: module constants are read at import time.
  console.log = () => {};
  const result = { queued: await failingSegmentCalls(queued()), direct: await failingSegmentCalls(direct()) };
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else {
  let failed = 0;
  const filter = process.env.TITLEWORK_TEST_FILTER || '';
  for (const { name, fn } of tests) {
    if (filter && !name.includes(filter)) continue;
    try {
      await fn();
      console.log(`ok - ${name}`);
    } catch (err) {
      failed++;
      console.error(`not ok - ${name}`);
      console.error(err.stack || err.message || String(err));
    }
  }
  process.exitCode = failed ? 1 : 0;
}
