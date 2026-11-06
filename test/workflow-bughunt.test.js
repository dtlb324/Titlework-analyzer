// Provider/orchestration bug-hunt regressions (findings 4, 5, 6, 7, 8, 18).
// Production code runs for real (processSynthesisJob, processSynthesisBatch, model-client, OpenRouter
// stream parser). Only external side effects are replaced: the job store and global fetch / model client.
// Set TITLEWORK_TEST_FILTER=<substring> to run a subset while iterating.
import assertStrict from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { estimateTextTokens } from '../api/_lib/anthropic-request.js';
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
  const calls = { saveJobResult: [], claimSynthesisMerge: 0, claimSegment: [], renewSegment: [] };
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
    async renewSynthesisSegmentLease(_jobId, id, { workerId, leaseMs }) {
      calls.renewSegment.push({ id, workerId, leaseMs });
      const s = find(id);
      if (!s || s.status !== 'processing' || s.workerId !== workerId) return null;
      return { ...s };
    },
    // Test-only: simulate another worker reclaiming the row after this worker's lease expired.
    reassignSegment(id, workerId) { Object.assign(find(id), { workerId }); },
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

function synthesisCallLabel(request) {
  const kind = callKind(request);
  if (kind === 'recombine' || kind === 'final') return kind;
  const text = JSON.stringify(request.messages);
  const ids = [...new Set([...text.matchAll(/deed(\d+)\.pdf/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
  if (!ids.length) return kind;
  const span = ids.length === 1 ? String(ids[0]) : `${ids[0]}-${ids.at(-1)}`;
  return `${kind}:${span}`;
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
    // Every billed call: the truncated original, both halves and the truncated recombine.
    assertStrict.equal(kept.outputTokens, 1 + 2 + 2 + 8);
    assertStrict.equal(kept.inputTokens, 4);
    assertStrict.ok(calls.at(-1).text.includes('HALF_1') && calls.at(-1).text.includes('HALF_2'), 'the final merge reads both halves');
    assertStrict.ok(out.result.warnings.includes('segment_1:segment_split_halves_kept'), JSON.stringify(out.result.warnings));
  });
});

// A request-size split does not increment truncation depth, so a half that then stops at max_tokens splits again.
// That nested recombine used to run with no recovery and fail the segment, discarding the paid single-document halves.
test('recombine recovery: a nested recombine after a payload split keeps the paid halves', async () => {
  await withEnvironment({}, async () => {
    const calls = [];
    const modelClient = async request => {
      const kind = callKind(request);
      const text = JSON.stringify(request.messages);
      const label = synthesisCallLabel(request);
      calls.push({ label, text });
      if (kind === 'original' && text.includes('deed0.pdf') && text.includes('deed3.pdf')) {
        throw Object.assign(new Error('payload too large'), { status: 413 });
      }
      const truncated = kind === 'recombine' || (kind === 'half' && text.includes('deed2.pdf') && text.includes('deed3.pdf'));
      const marker = label === 'half:0-1' ? 'NESTED_OUTER_LEFT' : label === 'half:2' ? 'NESTED_DOC_2' : label === 'half:3' ? 'NESTED_DOC_3' : 'BODY';
      return {
        text: kind === 'final' ? OPINION : `${SEGMENT} ${marker}`,
        model: 'gemini-3.1-flash-lite',
        usage: { input_tokens: 1, output_tokens: 2 },
        stopReason: truncated ? 'max_tokens' : 'end_turn',
      };
    };
    const store = makeStore({ docCount: 8 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 4, maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(calls.map(call => call.label), [
      'original:0-3', 'half:0-1', 'half:2-3', 'half:2', 'half:3', 'recombine', 'recombine', 'original:4-7', 'final',
    ]);
    const recombinations = calls.filter(call => call.label === 'recombine');
    assertStrict.ok(recombinations[1].text.includes('NESTED_DOC_2') && recombinations[1].text.includes('NESTED_DOC_3'), 'the outer recombine reads the kept nested halves');
    const [first, second] = store.segmentsSnapshot();
    assertStrict.equal(first.status, 'complete');
    assertStrict.equal(first.errorType, undefined);
    assertStrict.equal(typeof first.summaryText, 'string');
    assertStrict.ok(first.summaryText.includes('NESTED_OUTER_LEFT'), first.summaryText);
    assertStrict.ok(first.summaryText.includes('NESTED_DOC_2') && first.summaryText.includes('NESTED_DOC_3'), first.summaryText);
    assertStrict.ok(first.summaryText.indexOf('NESTED_OUTER_LEFT') < first.summaryText.indexOf('NESTED_DOC_2'), 'document order survives both keep_halves steps');
    assertStrict.ok(first.summaryText.indexOf('NESTED_DOC_2') < first.summaryText.indexOf('NESTED_DOC_3'), first.summaryText);
    assertStrict.ok(first.summaryText.includes('## Partial synthesis: deed2.pdf to deed2.pdf'), first.summaryText);
    assertStrict.ok(first.summaryText.includes('## Partial synthesis: deed3.pdf to deed3.pdf'), first.summaryText);
    assertStrict.deepEqual(first.warnings, ['segment_split', 'segment_split_halves_kept']);
    assertStrict.equal(second.status, 'complete');
    assertStrict.deepEqual(second.warnings, []);
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.equal(out.result.finalTitleOpinion, OPINION);
    assertStrict.ok(out.result.warnings.includes('segment_1:segment_split_halves_kept'), JSON.stringify(out.result.warnings));
  });
});

// Same eight-document plan. The outer original truncates, so depth becomes 1 and the halves are not split again.
// Only the outer recombine truncates. keep_halves still completes that segment.
test('recombine recovery: an outer truncation split on the same plan still keeps the halves', async () => {
  await withEnvironment({}, async () => {
    const calls = [];
    const modelClient = async request => {
      const kind = callKind(request);
      const text = JSON.stringify(request.messages);
      const label = synthesisCallLabel(request);
      calls.push(label);
      const truncated = kind === 'recombine' || (kind === 'original' && text.includes('deed0.pdf') && text.includes('deed3.pdf'));
      const marker = label === 'half:0-1' ? 'SHALLOW_LEFT' : label === 'half:2-3' ? 'SHALLOW_RIGHT' : 'BODY';
      return {
        text: kind === 'final' ? OPINION : `${SEGMENT} ${marker}`,
        model: 'gemini-3.1-flash-lite',
        usage: {},
        stopReason: truncated ? 'max_tokens' : 'end_turn',
      };
    };
    const store = makeStore({ docCount: 8 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 4, maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(calls, ['original:0-3', 'half:0-1', 'half:2-3', 'recombine', 'original:4-7', 'final']);
    const [first, second] = store.segmentsSnapshot();
    assertStrict.equal(first.status, 'complete');
    assertStrict.equal(first.errorType, undefined);
    assertStrict.deepEqual(first.warnings, ['segment_split', 'segment_split_halves_kept']);
    assertStrict.ok(first.summaryText.includes('SHALLOW_LEFT') && first.summaryText.includes('SHALLOW_RIGHT'), first.summaryText);
    assertStrict.ok(first.summaryText.indexOf('SHALLOW_LEFT') < first.summaryText.indexOf('SHALLOW_RIGHT'), 'halves stay in document order');
    assertStrict.equal(second.status, 'complete');
    assertStrict.deepEqual(second.warnings, []);
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.ok(out.result.warnings.includes('segment_1:segment_split_halves_kept'), JSON.stringify(out.result.warnings));
  });
});

// Payload splits can keep a half at every level. The saved segment must stay within the partial output cap
// (the maxTokens those half calls already use), or the final merge reads the concatenation of every leaf.
test('recombine recovery: an oversized kept-halves stitch is cut to the segment output cap before completion', async () => {
  await withEnvironment({}, async () => {
    const calls = [];
    const modelClient = async request => {
      const kind = callKind(request);
      const text = JSON.stringify(request.messages);
      const label = synthesisCallLabel(request);
      calls.push({ label, kind, maxTokens: request.maxTokens, text });
      const truncated = kind === 'recombine' || (kind === 'original' && text.includes('deed0.pdf') && !text.includes('deed2.pdf'));
      const body = label === 'half:0'
        ? `${SEGMENT} ${'x'.repeat(4000)}`
        : label === 'half:1'
          ? `${SEGMENT} ${'y'.repeat(4000)} OVERSIZE_TAIL`
          : (kind === 'final' ? OPINION : SEGMENT);
      return { text: body, model: 'gemini-3.1-flash-lite', usage: {}, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 4 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 2, maxAttempts: 1, partialMaxTokens: 512 }, workerId: 'probe', budgetMs: 5000 });
    const [first, second] = store.segmentsSnapshot();
    const cap = calls.find(call => call.label === 'half:0').maxTokens;
    assertStrict.equal(first.status, 'complete');
    assertStrict.equal(estimateTextTokens(first.summaryText), cap);
    assertStrict.ok(first.summaryText.includes('## CHAIN ROWS'), first.summaryText.slice(0, 80));
    assertStrict.equal(first.summaryText.includes('OVERSIZE_TAIL'), false);
    assertStrict.deepEqual(first.warnings, ['segment_split', 'segment_split_halves_kept']);
    assertStrict.equal(second.status, 'complete');
    const finalCall = calls.find(call => call.kind === 'final');
    assertStrict.equal(finalCall.text.includes('OVERSIZE_TAIL'), false);
    assertStrict.equal(out.result.status, 'complete');
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
    assertStrict.equal(first.errorType, 'provider_error');
    assertStrict.equal(first.summaryText, null, 'a non-truncation recombine failure saves no halves');
    assertStrict.equal(kinds.filter(k => k === 'recombine').length, 1, 'the failed recombine is not retried');
    assertStrict.deepEqual(kinds.slice(0, 4), ['original', 'half', 'half', 'recombine']);
  });
});

test('recombine recovery: halves are not kept when either half is not a valid segment summary', async () => {
  await withEnvironment({}, async () => {
    const kinds = [];
    const modelClient = async request => {
      const kind = callKind(request);
      kinds.push(kind);
      const halfIndex = kinds.filter(k => k === 'half').length;
      const truncated = kind === 'recombine' || (kind === 'original' && JSON.stringify(request.messages).includes('deed0.pdf'));
      const text = kind === 'final' ? OPINION : kind === 'half' && halfIndex === 2 ? 'I cannot help with that.' : SEGMENT;
      return { text, model: 'gemini-3.1-flash-lite', usage: {}, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 4 });
    await processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 2, maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
    const [first] = store.segmentsSnapshot();
    assertStrict.equal(first.status, 'failed');
    assertStrict.equal(first.errorType, 'output_truncated');
    assertStrict.equal(first.summaryText, null);
  });
});

test('recombine recovery: kept halves are labelled with their real filenames, not segment-relative numbers', async () => {
  await withEnvironment({}, async () => {
    const modelClient = async request => {
      const kind = callKind(request);
      const truncated = kind === 'recombine' || (kind === 'original' && JSON.stringify(request.messages).includes('deed2.pdf'));
      return { text: kind === 'final' ? OPINION : SEGMENT, model: 'gemini-3.1-flash-lite', usage: {}, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 4 });
    await processSynthesisJob('job_probe', { store, modelClient, config: { chunkSize: 2, maxAttempts: 1 }, workerId: 'probe', budgetMs: 5000 });
    const second = store.segmentsSnapshot()[1];
    assertStrict.deepEqual(second.warnings, ['segment_split', 'segment_split_halves_kept']);
    assertStrict.ok(second.summaryText.includes('## Partial synthesis: deed2.pdf to deed2.pdf'), second.summaryText);
    assertStrict.ok(second.summaryText.includes('## Partial synthesis: deed3.pdf to deed3.pdf'), second.summaryText);
    assertStrict.ok(!/Documents 1-/.test(second.summaryText), second.summaryText);
  });
});

test('recombine recovery: a retryable error on the single-pass retry fails closed instead of re-running the split', async () => {
  await withEnvironment({}, async () => {
    const kinds = [];
    const modelClient = async request => {
      let kind = callKind(request);
      if (kind === 'recombine' && kinds.includes('recombine')) kind = 'retry';
      kinds.push(kind);
      if (kind === 'retry') throw Object.assign(new Error('upstream overloaded'), { status: 529 });
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: kind === 'half' ? 'end_turn' : 'max_tokens' };
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 3 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(kinds, ['original', 'half', 'half', 'recombine', 'retry'], 'no second claim re-bills the tree');
    const [segment] = store.segmentsSnapshot();
    assertStrict.equal(segment.status, 'failed');
    assertStrict.equal(segment.errorType, 'recombine_retry_failed');
    assertStrict.equal(out.result.status, 'failed');
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
    // Every billed call: the truncated original, both halves, the truncated recombine and the retry.
    assertStrict.equal(segment.outputTokens, 1 + 2 + 2 + 8 + 32);
    assertStrict.equal(segment.inputTokens, 5);
    assertStrict.equal(out.result.outputTokens, 1 + 2 + 2 + 8 + 32, 'the single-pass result reports the same total');
  });
});

test('recombine recovery: a single-pass result lists the segment recovery warnings', async () => {
  await withEnvironment({}, async () => {
    let recombines = 0;
    const modelClient = async request => {
      const kind = callKind(request);
      if (kind === 'recombine') recombines += 1;
      const truncated = kind === 'original' || (kind === 'recombine' && recombines === 1);
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 1, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.deepEqual(out.result.warnings, ['segment_1:segment_split', 'segment_1:segment_split_recombine_retry']);
  });
});

// Four documents make each half multi-document. The outer recombine still gets exactly one larger retry.
test('recombine recovery: a four-document single-pass recombine that truncates is retried once', async () => {
  await withEnvironment({}, async () => {
    const calls = [];
    const modelClient = async request => {
      let kind = callKind(request);
      if (kind === 'recombine' && calls.some(call => call.kind === 'recombine')) kind = 'retry';
      calls.push({ kind, maxTokens: request.maxTokens });
      const truncated = kind === 'original' || kind === 'recombine';
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 4 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 1, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    const larger = calls.filter(call => call.maxTokens === 16000);
    assertStrict.equal(larger.length, 1);
    assertStrict.equal(larger[0].kind, 'retry');
    assertStrict.equal(larger[0].maxTokens, 16000);
    assertStrict.deepEqual(calls.map(call => call.kind), ['original', 'half', 'half', 'recombine', 'retry']);
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.equal(out.result.finalTitleOpinion, OPINION);
  });
});

// A request-size split leaves depth at 0, so one half splits again. That nested recombine has no recovery.
test('recombine recovery: a single-pass nested recombine that truncates fails without a larger retry', async () => {
  await withEnvironment({}, async () => {
    const calls = [];
    const modelClient = async request => {
      const kind = callKind(request);
      const text = JSON.stringify(request.messages);
      calls.push({ kind, label: synthesisCallLabel(request), maxTokens: request.maxTokens });
      if (kind === 'original' && text.includes('deed0.pdf') && text.includes('deed3.pdf')) {
        throw Object.assign(new Error('payload too large'), { status: 413 });
      }
      const truncated = kind === 'recombine' || (kind === 'half' && text.includes('deed2.pdf') && text.includes('deed3.pdf'));
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 4 });
    await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 1, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    const [segment] = store.segmentsSnapshot();
    assertStrict.equal(segment.status, 'failed');
    assertStrict.equal(segment.errorType, 'output_truncated');
    assertStrict.equal(segment.summaryText, null);
    assertStrict.equal(calls.filter(call => call.maxTokens === 16000).length, 0);
    assertStrict.deepEqual(calls.map(call => call.label), ['original:0-3', 'half:0-1', 'half:2-3', 'half:2', 'half:3', 'recombine']);
    assertStrict.equal(calls.at(-1).maxTokens, 8000);
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

test('segment lease: a single-pass segment renews its lease before every paid call, covering the upstream timeout', async () => {
  await withEnvironment({}, async () => {
    let recombines = 0;
    const modelClient = async request => {
      const kind = callKind(request);
      if (kind === 'recombine') recombines += 1;
      const truncated = kind === 'original' || (kind === 'recombine' && recombines === 1);
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', {
      store, modelClient, leaseMs: 120_000, workerId: 'probe', budgetMs: 5000,
      config: { maxAttempts: 1, maxTokens: 8000, upstreamTimeoutMs: 240_000 },
    });
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.equal(store.calls.renewSegment.length, 5, 'original, two halves, recombine and the larger retry each renew first');
    for (const renewal of store.calls.renewSegment) {
      assertStrict.deepEqual(renewal, { id: 'seg_0', workerId: 'probe', leaseMs: 300_000 }, 'each renewal outlasts one full upstream timeout');
    }
  });
});

test('segment lease: a lost lease stops the chain before the larger retry is paid for', async () => {
  await withEnvironment({}, async () => {
    const kinds = [];
    let store;
    const modelClient = async request => {
      const kind = callKind(request);
      kinds.push(kind);
      // While the first recombine is in flight, the lease expires and another worker reclaims the segment.
      if (kind === 'recombine') store.reassignSegment('seg_0', 'other_worker');
      const truncated = kind === 'original' || kind === 'recombine';
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: truncated ? 'max_tokens' : 'end_turn' };
    };
    store = makeStore({ docCount: 2 });
    const failMarks = [];
    const markFailed = store.markSynthesisSegmentFailed;
    store.markSynthesisSegmentFailed = async (...args) => { failMarks.push(args[2].errorType); return markFailed(...args); };
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 3, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(failMarks, [], 'a lost lease is never reported as a failure of the new owner\'s row');
    assertStrict.deepEqual(kinds, ['original', 'half', 'half', 'recombine'], 'the 16k retry is never sent');
    const [segment] = store.segmentsSnapshot();
    assertStrict.equal(segment.status, 'processing', 'the row is left to its new owner, not failed');
    assertStrict.equal(segment.workerId, 'other_worker');
    assertStrict.equal(store.calls.saveJobResult.length, 0);
    assertStrict.ok(!out.result, JSON.stringify(out.result));
  });
});

test('segment lease: a renewal DB error does not split or re-bill a healthy segment', async () => {
  await withEnvironment({}, async () => {
    const kinds = [];
    const modelClient = async request => {
      kinds.push(callKind(request));
      return { text: OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: 'end_turn' };
    };
    const store = makeStore({ docCount: 2 });
    const renew = store.renewSynthesisSegmentLease;
    let renewals = 0;
    store.renewSynthesisSegmentLease = async (...args) => {
      renewals += 1;
      if (renewals === 1) throw new Error('Connection terminated due to connection timeout');
      return renew(...args);
    };
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 3, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(kinds, ['original'], 'a DB blip is not a model timeout, so no split');
    assertStrict.equal(out.result.status, 'complete');
    assertStrict.deepEqual(out.result.warnings, []);
  });
});

test('segment lease: a renewal DB error mid-chain does not re-run the paid split', async () => {
  await withEnvironment({}, async () => {
    const kinds = [];
    const modelClient = async request => {
      const kind = callKind(request);
      kinds.push(kind);
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: kind === 'original' ? 'max_tokens' : 'end_turn' };
    };
    const store = makeStore({ docCount: 2 });
    const renew = store.renewSynthesisSegmentLease;
    let renewals = 0;
    store.renewSynthesisSegmentLease = async (...args) => {
      renewals += 1;
      if (renewals === 4) throw new Error('read ECONNRESET');
      return renew(...args);
    };
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 3, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(kinds, ['original', 'half', 'half', 'recombine'], 'the paid halves are not re-run');
    assertStrict.equal(out.result.status, 'complete');
  });
});

test('segment lease: the repair call renews the lease and stops when it is lost', async () => {
  await withEnvironment({}, async () => {
    let calls = 0;
    let store;
    const modelClient = async () => {
      calls += 1;
      // The first answer fails validation, and the lease is taken while it is in flight.
      store.reassignSegment('seg_0', 'other_worker');
      return { text: 'I cannot help with that.', model: 'claude-sonnet-5-5', usage: {}, stopReason: 'end_turn' };
    };
    store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 3, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.equal(calls, 1, 'the repair call is never paid for');
    const [segment] = store.segmentsSnapshot();
    assertStrict.equal(segment.status, 'processing');
    assertStrict.equal(segment.workerId, 'other_worker');
    assertStrict.equal(store.calls.saveJobResult.length, 0);
    assertStrict.ok(!out.result, JSON.stringify(out.result));
  });
});

test('segment lease: a lease lost before a half call stops the split', async () => {
  await withEnvironment({}, async () => {
    const kinds = [];
    let store;
    const modelClient = async request => {
      const kind = callKind(request);
      kinds.push(kind);
      if (kind === 'original') store.reassignSegment('seg_0', 'other_worker');
      return { text: kind === 'half' ? SEGMENT : OPINION, model: 'claude-sonnet-5-5', usage: {}, stopReason: kind === 'original' ? 'max_tokens' : 'end_turn' };
    };
    store = makeStore({ docCount: 2 });
    const out = await processSynthesisJob('job_probe', { store, modelClient, config: { maxAttempts: 3, maxTokens: 8000 }, workerId: 'probe', budgetMs: 5000 });
    assertStrict.deepEqual(kinds, ['original'], 'no half call is paid for');
    const [segment] = store.segmentsSnapshot();
    assertStrict.equal(segment.status, 'processing');
    assertStrict.equal(segment.workerId, 'other_worker');
    assertStrict.equal(store.calls.saveJobResult.length, 0);
    assertStrict.ok(!out.result, JSON.stringify(out.result));
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
