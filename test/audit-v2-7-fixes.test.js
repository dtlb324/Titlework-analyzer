import assert from 'node:assert/strict';
import * as pdfLib from 'pdf-lib';
import { classifyAbstractionError, enrichVisualDeliveryForModel, processChunkAbstraction } from '../api/_lib/abstraction.js';
import { consumeAnthropicMessageStream } from '../api/_lib/anthropic-stream.js';
import { uploadGeminiFile } from '../api/_lib/gemini-files.js';
import { consumeOpenRouterMessageStream } from '../api/_lib/openrouter-stream.js';
import { runWorkerDrain, runWorkerLoop, runWorkerOnce } from '../api/_lib/cloud-run-worker.js';
import { runWithConcurrency } from '../api/_lib/concurrency.js';
import { createPostgresJobStore, hasRawPayloadFields, validatePatchJobInput, validateSaveJobResultInput } from '../api/_lib/jobs.js';
import { invokeModel } from '../api/_lib/model-client.js';
import { buildOpenRouterRequestBody, shouldUseOpenRouter } from '../api/_lib/openrouter-request.js';
import jobPathHandler from '../api/jobs/[...path].js';
import { enqueueSynthesisJob, processAbstractionBatch, retryFailedAbstractionChunks } from '../api/_lib/queue.js';
import { extractPdfPageSubset } from '../api/_lib/pdf-text.js';
import { prepareDocument } from '../public/pdf-raster.js';
import { answerFollowupQuestion, getPartialSynthesisConfig, PARTIAL_SYNTHESIS_PROMPT, processSynthesisJob } from '../api/_lib/synthesis.js';
import { disposeAll, jsonResponse, loadIndex } from './helpers/browser-index-harness.js';
import { createPgliteSql } from './helpers/pglite-sql.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const OPINION = [
  '# Title Opinion',
  '## Chain of Title',
  'Grantor A conveyed to Grantee B.',
  '## Final Ownership',
  'B owns 100% of the minerals.',
  '## Opinion Qualifications',
  'Based only on the instruments reviewed.',
  'x'.repeat(600),
].join('\n');

const pg = createPgliteSql();
const store = createPostgresJobStore({ sql: pg.sql });

async function jobWithChunk({ jobStatus, chunkStatus = 'pending' }) {
  const job = await store.createJob({ subjectTract: 'Section 12, Block C-8', contextNotes: '', totalDocuments: 1 });
  const fingerprint = `fp_${job.id}`;
  const doc = await store.createDocument(job.id, { originalFilename: 'deed.pdf', mediaType: 'application/pdf', sizeBytes: 10, uploadStatus: 'uploaded', fingerprint });
  const chunk = await store.createChunk(job.id, doc.id, { chunkOrder: 0, originalFilename: 'deed.pdf', mediaType: 'application/pdf', sizeBytes: 10, uploadStatus: 'uploaded', fingerprint });
  await pg.db.query('UPDATE document_chunks SET abstraction_status = $2 WHERE id = $1', [chunk.id, chunkStatus]);
  await pg.db.query('UPDATE analysis_jobs SET status = $2 WHERE id = $1', [job.id, jobStatus]);
  return { jobId: job.id, chunkId: chunk.id, documentId: doc.id };
}

async function saveServerAbstract({ jobId, chunkId, documentId }) {
  await pg.db.query("UPDATE document_chunks SET abstraction_status = 'processing', abstraction_worker_id = 'wkr_setup' WHERE id = $1", [chunkId]);
  return await store.saveDocumentAbstract({
    jobId, documentId, chunkId,
    abstractText: 'DOCUMENT #1: Warranty deed, Grantor A to Grantee B.',
    modelUsed: 'gemini-3.1-flash-lite', payloadBytes: 1, latencyMs: 1, inputTokens: 1, outputTokens: 1,
    status: 'completed', attemptCount: 1, workerId: 'wkr_setup',
  });
}

const SEGMENT = '## CHAIN ROWS\n| Date | Doc Type | Grantor | Grantee |\n| 2001 | Deed | A | B |\n\n## DEFECTS\nnone\n\n## RUNNING BALANCE\n| B | 1/2 | '
  + 'chain content filler '.repeat(12) + ' |';

async function synthesizingJobWithAbstracts(count) {
  const job = await store.createJob({ subjectTract: 'Section 12, Block C-8', contextNotes: '', totalDocuments: count });
  for (let i = 0; i < count; i += 1) {
    const fingerprint = `fp_${job.id}_${i}`;
    const doc = await store.createDocument(job.id, { originalFilename: `deed${i}.pdf`, mediaType: 'application/pdf', sizeBytes: 10, uploadStatus: 'uploaded', fingerprint });
    const chunk = await store.createChunk(job.id, doc.id, { chunkOrder: i, originalFilename: `deed${i}.pdf`, mediaType: 'application/pdf', sizeBytes: 10, uploadStatus: 'uploaded', fingerprint });
    await saveServerAbstract({ jobId: job.id, chunkId: chunk.id, documentId: doc.id });
  }
  await pg.db.query("UPDATE analysis_jobs SET status = 'synthesizing' WHERE id = $1", [job.id]);
  return job.id;
}

function synthesisCallKind(request) {
  const text = JSON.stringify(request.messages);
  if (/Merge these partial chain-of-title syntheses/.test(text)) return 'recombine';
  if (request.system === PARTIAL_SYNTHESIS_PROMPT) return 'half';
  if (/Previous response was incomplete/.test(text)) return 'repair';
  return 'original';
}

async function segmentRow(jobId) {
  const { rows } = await pg.db.query('SELECT status, error_type FROM synthesis_segments WHERE job_id = $1', [jobId]);
  assert.equal(rows.length, 1, 'Expected a single-pass plan');
  return rows[0];
}

async function expectStatusCode(promise, statusCode) {
  let caught = null;
  try { await promise; } catch (err) { caught = err; }
  assert.equal(caught?.statusCode, statusCode, `Expected HTTP ${statusCode}, got ${caught?.statusCode} (${caught?.message})`);
}

test('C1: synthesis on a complete job is refused before planning, so the saved opinion survives and nothing is billed', async () => {
  const ids = await jobWithChunk({ jobStatus: 'ready' });
  await saveServerAbstract(ids);
  await store.saveJobResult(ids.jobId, { status: 'complete', finalTitleOpinion: 'Browser opinion' });
  let modelCalls = 0;
  const modelClient = async () => { modelCalls += 1; return { text: OPINION, model: 'claude-sonnet-5-5', usage: {} }; };

  await expectStatusCode(processSynthesisJob(ids.jobId, { store, modelClient, budgetMs: 5_000 }), 409);
  await expectStatusCode(enqueueSynthesisJob(ids.jobId, { store }), 409);
  await assert.rejects(store.saveSynthesisPlan(ids.jobId, { planId: 'plan_new', segments: [] }), { statusCode: 409 });

  assert.equal(modelCalls, 0);
  assert.equal((await store.getJobResult(ids.jobId))?.finalTitleOpinion, 'Browser opinion');
  assert.equal((await store.getJob(ids.jobId)).status, 'complete');
});

test('C2: a complete job with leftover pending chunks is not listed, claimed, retried or reverted', async () => {
  const ids = await jobWithChunk({ jobStatus: 'ready', chunkStatus: 'pending' });
  await store.saveJobResult(ids.jobId, { status: 'complete', finalTitleOpinion: 'Browser opinion' });

  assert.equal((await store.listRunnableAbstractionJobIds(100)).includes(ids.jobId), false);
  assert.equal(await store.claimChunkForAbstraction(ids.jobId, ids.chunkId, { workerId: 'wkr_late', leaseMs: 60_000, maxAttempts: 5 }), null);
  await expectStatusCode(processAbstractionBatch(ids.jobId, { store, budgetMs: 1_000 }), 409);
  await expectStatusCode(retryFailedAbstractionChunks(ids.jobId, { store }), 409);
  assert.equal((await store.refreshAbstractionRollup(ids.jobId)).status, 'complete');
  assert.equal((await store.getJobResult(ids.jobId))?.finalTitleOpinion, 'Browser opinion');
});

test('C2: an abstract that lands after the job completed does not delete the opinion', async () => {
  const ids = await jobWithChunk({ jobStatus: 'abstracting', chunkStatus: 'processing' });
  await pg.db.query("UPDATE document_chunks SET abstraction_worker_id = 'wkr_slow' WHERE id = $1", [ids.chunkId]);
  await pg.db.query("UPDATE analysis_jobs SET status = 'synthesizing' WHERE id = $1", [ids.jobId]);
  await store.saveJobResult(ids.jobId, { status: 'complete', finalTitleOpinion: 'Browser opinion' });

  const saved = await store.saveDocumentAbstract({
    jobId: ids.jobId, documentId: ids.documentId, chunkId: ids.chunkId,
    abstractText: 'DOCUMENT #1: late abstract', modelUsed: 'gemini-3.1-flash-lite',
    payloadBytes: 1, latencyMs: 1, inputTokens: 1, outputTokens: 1, status: 'completed', attemptCount: 1, workerId: 'wkr_slow',
  });
  assert.equal(saved, null);
  assert.equal((await store.getJobResult(ids.jobId))?.finalTitleOpinion, 'Browser opinion');
});

test('H1: a merge lease cannot be claimed once another worker saved this plan\'s result', async () => {
  for (const resultStatus of ['complete', 'partial_failed', 'failed']) {
    const job = await store.createJob({ subjectTract: 'Section 12', contextNotes: '', totalDocuments: 1 });
    await pg.db.query("UPDATE analysis_jobs SET status = 'synthesizing', synthesis_plan_id = 'plan_race' WHERE id = $1", [job.id]);
    const first = await store.claimSynthesisMerge(job.id, 'plan_race', { workerId: 'wkr_a', leaseMs: 600_000 });
    assert.ok(first);
    assert.ok(await store.saveJobResult(job.id, { planId: 'plan_race', status: resultStatus, finalTitleOpinion: OPINION, mergeWorkerId: 'wkr_a' }));
    assert.equal(await store.claimSynthesisMerge(job.id, 'plan_race', { workerId: 'wkr_b', leaseMs: 600_000 }), null, `Expected no second merge after a ${resultStatus} result`);
  }
});

test('H3: cancellation through PATCH is refused, and a canceled job refuses chunk claims and renewals', async () => {
  const patch = validatePatchJobInput({ status: 'canceled' }, { status: 'abstracting', totalDocuments: 1, completedDocuments: 0, failedDocuments: 0 });
  assert.equal(patch.valid, false);
  assert.equal(patch.statusCode, 409);

  const ids = await jobWithChunk({ jobStatus: 'abstracting', chunkStatus: 'pending' });
  assert.ok(await store.claimChunkForAbstraction(ids.jobId, ids.chunkId, { workerId: 'wkr_live', leaseMs: 60_000, maxAttempts: 5 }));
  // Simulates the window inside cancelJob after the job row flips and before the chunk rows do.
  await pg.db.query("UPDATE analysis_jobs SET status = 'canceled' WHERE id = $1", [ids.jobId]);
  assert.equal(await store.renewChunkAbstractionLease(ids.jobId, ids.chunkId, { workerId: 'wkr_live', leaseMs: 60_000 }), null);
  assert.deepEqual(await store.renewChunkAbstractionLeases(ids.jobId, [ids.chunkId], { workerId: 'wkr_live', leaseMs: 60_000 }), []);
  await pg.db.query("UPDATE document_chunks SET abstraction_status = 'failed' WHERE id = $1", [ids.chunkId]);
  assert.equal(await store.retryFailedChunks(ids.jobId), 0);
});

test('H9: a result whose status the job cannot take is refused instead of stranding the job', async () => {
  const failed = await jobWithChunk({ jobStatus: 'failed', chunkStatus: 'completed' });
  assert.equal(await store.saveJobResult(failed.jobId, { status: 'complete', finalTitleOpinion: OPINION }), null);
  assert.equal(await store.getJobResult(failed.jobId), null);
  assert.equal((await store.getJob(failed.jobId)).status, 'failed');

  const uploading = await jobWithChunk({ jobStatus: 'uploading', chunkStatus: 'completed' });
  await expectStatusCode(enqueueSynthesisJob(uploading.jobId, { store }), 409);

  const valid = await jobWithChunk({ jobStatus: 'synthesizing', chunkStatus: 'completed' });
  const saved = await store.saveJobResult(valid.jobId, { status: 'partial_failed', finalTitleOpinion: OPINION });
  assert.equal(saved?.status, 'partial_failed');
  const job = await store.getJob(valid.jobId);
  assert.equal(job.status, 'partial_failed');
  assert.equal(job.currentPhase, 'complete with synthesis warnings');
});

test('H2: only the lease owner\'s PDF split supersedes the parent and adds child chunks', async () => {
  const child = (i, fingerprint) => ({
    chunkOrder: i, originalFilename: `deed_p${i + 1}.pdf`, blobKey: `split/${fingerprint}.pdf`, blobUrl: null,
    mediaType: 'application/pdf', sizeBytes: 5, pageStart: i + 1, pageEnd: i + 1, splitFrom: 'deed.pdf',
    fingerprint, checksumSha256: null,
  });
  const ids = await jobWithChunk({ jobStatus: 'abstracting', chunkStatus: 'processing' });
  await pg.db.query("UPDATE document_chunks SET abstraction_worker_id = 'wkr_owner' WHERE id = $1", [ids.chunkId]);
  const childCount = async () => (await pg.db.query('SELECT count(*)::int AS n FROM document_chunks WHERE split_parent_chunk_id = $1', [ids.chunkId])).rows[0].n;

  const lost = await store.commitSplitPdfChunks(ids.jobId, ids.documentId, ids.chunkId, [child(0, 'fp_a'), child(1, 'fp_b')], { reason: 'payload_too_large', workerId: 'wkr_other' });
  assert.equal(lost, null);
  assert.equal(await childCount(), 0, 'A split by a worker that lost the lease must not leave child chunks');

  const won = await store.commitSplitPdfChunks(ids.jobId, ids.documentId, ids.chunkId, [child(0, 'fp_a'), child(1, 'fp_b')], { reason: 'payload_too_large', workerId: 'wkr_owner' });
  assert.equal(won?.parent?.abstractionStatus, 'split_superseded');
  assert.deepEqual(won.children.map(c => c.abstractionStatus), ['pending', 'pending']);
  assert.equal(await childCount(), 2);
});

test('H5: halves of a truncated single-pass opinion run on the partial synthesis model, not the final model', async () => {
  const jobId = await synthesizingJobWithAbstracts(2);
  const calls = [];
  const modelClient = async request => {
    const kind = synthesisCallKind(request);
    calls.push({ kind, model: request.model, maxTokens: request.maxTokens });
    if (kind === 'original') return { text: OPINION.slice(0, 100), model: request.model, usage: {}, stopReason: 'max_tokens' };
    return { text: kind === 'half' ? SEGMENT : OPINION, model: request.model, usage: {}, stopReason: 'end_turn' };
  };
  await processSynthesisJob(jobId, { store, modelClient, config: { model: 'claude-sonnet-5-5', maxAttempts: 3 }, budgetMs: 5_000 });
  const partial = getPartialSynthesisConfig({ model: 'claude-sonnet-5-5', maxAttempts: 3 });
  assert.deepEqual(calls.map(call => call.kind), ['original', 'half', 'half', 'recombine']);
  assert.deepEqual(calls.filter(call => call.kind === 'half').map(call => call.model), [partial.model, partial.model]);
  assert.notEqual(partial.model, 'claude-sonnet-5-5');
  assert.equal((await segmentRow(jobId)).status, 'complete');
});

test('H6: a single-pass opinion fails closed instead of re-billing after a split, a repair, or an error inside a paid split', async () => {
  const scenarios = {
    // The split finishes but the recombined opinion fails validation.
    invalidAfterSplit: kind => (kind === 'original'
      ? { text: 'cut', stopReason: 'max_tokens' }
      : { text: kind === 'half' ? SEGMENT : 'not an opinion', stopReason: 'end_turn' }),
    // No split: the first answer and its repair both fail validation.
    invalidAfterRepair: () => ({ text: 'not an opinion', stopReason: 'end_turn' }),
    // The billed truncated call splits, then a half hits a retryable rate limit.
    rateLimitInPaidSplit: kind => {
      if (kind === 'original') return { text: 'cut', stopReason: 'max_tokens' };
      throw Object.assign(new Error('rate limit'), { status: 429 });
    },
  };
  const outcome = {};
  for (const [name, respond] of Object.entries(scenarios)) {
    const jobId = await synthesizingJobWithAbstracts(2);
    const kinds = [];
    const modelClient = async request => {
      const kind = synthesisCallKind(request);
      kinds.push(kind);
      return { model: request.model, usage: {}, ...respond(kind) };
    };
    await processSynthesisJob(jobId, { store, modelClient, config: { maxAttempts: 3 }, budgetMs: 5_000 });
    const row = await segmentRow(jobId);
    outcome[name] = { kinds, status: row.status, errorType: row.error_type };
  }
  assert.deepEqual(outcome, {
    invalidAfterSplit: { kinds: ['original', 'half', 'half', 'recombine'], status: 'failed', errorType: 'validation_failed' },
    invalidAfterRepair: { kinds: ['original', 'repair'], status: 'failed', errorType: 'validation_failed' },
    rateLimitInPaidSplit: { kinds: ['original', 'half'], status: 'failed', errorType: 'paid_split_failed' },
  });
});

// pdf-lib only reads the /Encrypt flag, so a trailer entry is enough to reproduce an owner-locked courthouse PDF.
async function encryptedPdfBytes(pageCount) {
  const doc = await pdfLib.PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) doc.addPage([200, 200]);
  doc.context.trailerInfo.Encrypt = doc.context.register(doc.context.obj({ Filter: 'Standard', V: 1, R: 2, P: -4 }));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('H4: encrypted PDFs are never copied into blank subsets or split children', async () => {
  const bytes = await encryptedPdfBytes(4);
  await assert.rejects(extractPdfPageSubset(bytes, [1]), /Encrypted PDF/);

  const parent = {
    id: 'chk_enc', jobId: 'job_enc', documentId: 'doc_enc', chunkOrder: 0, originalFilename: 'deed.pdf',
    mediaType: 'application/pdf', uploadStatus: 'uploaded', abstractionStatus: 'processing', abstractionWorkerId: 'wkr_enc',
    abstractionAttempts: 1, pageStart: 1, pageEnd: 4, sizeBytes: bytes.length, fingerprint: 'fp_enc',
  };
  const writes = [];
  const store = {
    async claimChunkForAbstraction() { return parent; },
    async commitSplitPdfChunks() { writes.push('commit'); return null; },
    async markChunkAbstractionFailed() { return { ...parent, abstractionStatus: 'failed' }; },
  };
  const result = await processChunkAbstraction(parent, {
    store, workerId: 'wkr_enc', maxAttempts: 1,
    blobLoader: async () => ({ bytes, mediaType: 'application/pdf' }),
    blobWriter: async (_chunk, name) => { writes.push(`upload:${name}`); return { blobKey: name, blobUrl: null }; },
    modelClient: async () => { throw Object.assign(new Error('payload too large'), { status: 413 }); },
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(writes, []);

  const app = loadIndex({ fetchImpl: async () => jsonResponse(200, {}) });
  try {
    app.ctx.PDFLib = pdfLib;
    const file = { name: 'deed.pdf', size: bytes.length, type: 'application/pdf', arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    await assert.rejects(app.ctx.splitPdfIntoEntries(file, 50, 400), /deed\.pdf: this PDF is encrypted/);
  } finally {
    disposeAll();
  }
});

function streamBody(text) {
  const bytes = new TextEncoder().encode(text);
  let sent = false;
  return { getReader: () => ({ read: async () => (sent ? { done: true } : (sent = true, { done: false, value: bytes })), releaseLock() {} }) };
}

async function withFetch(fetchImpl, fn) {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  globalThis.fetch = fetchImpl;
  process.env.GEMINI_API_KEY = 'test-key';
  try {
    return await fn();
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  }
}

test('H10: auth and context-length errors classify as permanent, and stream errors carry their HTTP status', async () => {
  assert.deepEqual(
    [
      { code: 'missing_api_key', statusCode: 503, message: 'GEMINI_API_KEY is required.' },
      { status: 401, message: 'API key not valid.' },
      { status: 403, message: 'Permission denied.' },
      { status: 400, message: 'prompt is too long: 250000 tokens > 200000 maximum' },
      { status: 503, message: 'The model is overloaded.' },
    ].map(err => classifyAbstractionError(Object.assign(new Error(err.message), err))),
    ['auth_error', 'auth_error', 'auth_error', 'payload_too_large', 'rate_limit'],
  );
  await assert.rejects(
    consumeAnthropicMessageStream(streamBody('event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}\n\n')),
    err => err.status === 429 && classifyAbstractionError(err) === 'rate_limit',
  );
  await assert.rejects(
    consumeOpenRouterMessageStream(streamBody('data: {"error":{"code":413,"message":"request too big"}}\n\n')),
    err => err.status === 413 && classifyAbstractionError(err) === 'payload_too_large',
  );
});

test('H10: a transient Files API failure on a file too big to send inline is retried, not turned into a permanent 413', async () => {
  const chunk = { id: 'chk_plat', jobId: 'job_plat', mediaType: 'image/png', originalFilename: 'plat.png' };
  const tooBigInline = Buffer.alloc(15_000_000);
  const fitsInline = Buffer.alloc(2_000_000);
  const outage = async () => new Response(JSON.stringify({ error: { message: 'Backend unavailable' } }), { status: 503 });
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    await withFetch(outage, async () => {
      await assert.rejects(
        enrichVisualDeliveryForModel({ mode: 'visual' }, chunk, tooBigInline, 'gemini-3.1-flash-lite'),
        err => err.status === 503 && classifyAbstractionError(err) === 'provider_error',
      );
      assert.deepEqual(await enrichVisualDeliveryForModel({ mode: 'visual' }, chunk, fitsInline, 'gemini-3.1-flash-lite'), { mode: 'visual' });
    });
  } finally {
    console.warn = previousWarn;
  }
});

test('H11: an uploaded Gemini file is deleted when it never becomes ACTIVE or its request is never sent', async () => {
  const requests = [];
  const files = async (url, init = {}) => {
    requests.push(`${init.method || 'GET'} ${new URL(url).pathname}`);
    if (init.method === 'POST') return new Response(JSON.stringify({ file: { name: 'files/abc123', uri: 'https://files/abc123', mimeType: 'image/png' } }), { status: 200 });
    if (init.method === 'DELETE') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ name: 'files/abc123', state: 'FAILED' }), { status: 200 });
  };
  await withFetch(files, () => assert.rejects(uploadGeminiFile(Buffer.alloc(2_000_000), 'image/png', 'plat.png')));
  assert.equal(requests.at(-1), 'DELETE /v1beta/files/abc123');

  requests.length = 0;
  const active = async (url, init = {}) => {
    if (init.method === 'GET' || !init.method) {
      requests.push(`GET ${new URL(url).pathname}`);
      return new Response(JSON.stringify({ name: 'files/abc123', state: 'ACTIVE' }), { status: 200 });
    }
    return files(url, init);
  };
  const chunk = {
    id: 'chk_plat', jobId: 'job_plat', documentId: 'doc_plat', chunkOrder: 0, mediaType: 'image/png', originalFilename: 'plat.png',
    uploadStatus: 'uploaded', abstractionStatus: 'processing', abstractionWorkerId: 'wkr_plat', abstractionAttempts: 1, sizeBytes: 2_000_000,
  };
  let renewals = 0;
  const store = {
    async claimChunkForAbstraction() { return chunk; },
    // The first renewal (before the upload) succeeds; the one before the paid call reports the lease lost.
    async renewChunkAbstractionLease() { renewals += 1; return renewals === 1 ? chunk : null; },
  };
  let modelCalls = 0;
  const result = await withFetch(active, () => processChunkAbstraction(chunk, {
    store, workerId: 'wkr_plat', maxAttempts: 1,
    blobLoader: async () => ({ bytes: Buffer.alloc(2_000_000), mediaType: 'image/png' }),
    modelClient: async () => { modelCalls += 1; return { text: 'DOCUMENT #1: plat', usage: {} }; },
  }));
  assert.equal(result.status, 'stale');
  assert.equal(modelCalls, 0);
  assert.equal(renewals, 2, 'Expected one renewal before the upload and one before the paid call');
  assert.equal(requests.at(-1), 'DELETE /v1beta/files/abc123');
});

const noProgressPass = { completedInBatch: 0, failedInBatch: 0, retryScheduledInBatch: 0, splitsInBatch: 0, lastError: { errorType: 'provider_error', errorMessage: 'claim failed' } };
const listedOnce = ids => ({
  async listRunnableAbstractionJobIds() { return ids; },
  async listRunnableSynthesisJobIds() { return []; },
});

test('H12: a batch that returns an error without progress backs off and trips the drain breaker, instead of hot-looping', async () => {
  let loopSleeps = 0;
  await runWorkerLoop({ store: listedOnce(['job_poison']), processAbstraction: async () => noProgressPass, maxIterations: 3, sleep: async () => { loopSleeps += 1; } });
  assert.equal(loopSleeps, 3);

  let stalledSleeps = 0;
  const stalledPass = { ...noProgressPass, lastError: null };
  await runWorkerLoop({ store: listedOnce(['job_stuck']), processAbstraction: async () => stalledPass, maxIterations: 3, sleep: async () => { stalledSleeps += 1; } });
  assert.equal(stalledSleeps, 3, 'A cycle that lists work but moves nothing must pause too');

  let drainPasses = 0;
  const drained = await runWorkerDrain({ store: listedOnce(['job_poison']), processAbstraction: async () => { drainPasses += 1; return noProgressPass; }, sleep: async () => {} });
  assert.equal(drainPasses, 3);
  assert.equal(drained.iterations, 3);
});

test('H12: an aborted worker starts no further job and no synthesis after the current pass', async () => {
  const controller = new AbortController();
  const calls = [];
  const store = {
    ...listedOnce(['job_a', 'job_b']),
    async getJob() { return { status: 'synthesizing' }; },
  };
  await runWorkerOnce({
    store,
    signal: controller.signal,
    processAbstraction: async jobId => { calls.push(`abstract:${jobId}`); controller.abort(); },
    processSynthesis: async jobId => { calls.push(`synthesis:${jobId}`); },
  });
  assert.deepEqual(calls, ['abstract:job_a']);
});

test('H12: a drain deadline caps the budget of each job batch', async () => {
  const previousBatching = process.env.ABSTRACTION_BATCH_ENABLED;
  process.env.ABSTRACTION_BATCH_ENABLED = 'false';
  const chunk = { id: 'chk_loop', jobId: 'job_budget', documentId: 'doc_loop', chunkOrder: 0, mediaType: 'image/png', originalFilename: 'plat.png', uploadStatus: 'uploaded', sizeBytes: 10 };
  // Every pass reuses a saved abstract, so the batch would keep going until its budget runs out.
  const store = {
    ...listedOnce(['job_budget']),
    async getJob() { return { id: 'job_budget', status: 'abstracting' }; },
    async listReadyAbstractionChunks() { return [chunk]; },
    async claimChunkForAbstraction(_jobId, _chunkId, opts) { return { ...chunk, abstractionStatus: 'processing', abstractionWorkerId: opts.workerId, abstractionAttempts: 1 }; },
    async getDocumentAbstractByChunkId() { return { abstractText: 'DOCUMENT #1: Plat of survey.', modelUsed: 'gemini-3.1-flash-lite' }; },
    async saveDocumentAbstract() { return { id: 'abs_loop' }; },
    async getAbstractionStatus() { return { total: 1, pending: 1, processing: 0, completed: 0, failed: 0, retry_wait: 0, failedChunks: [], job: { status: 'abstracting' } }; },
  };
  const startedAt = Date.now();
  try {
    await runWorkerOnce({ store, deadline: Date.now() + 1_200 });
  } finally {
    if (previousBatching === undefined) delete process.env.ABSTRACTION_BATCH_ENABLED;
    else process.env.ABSTRACTION_BATCH_ENABLED = previousBatching;
  }
  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 5_000, `Expected the batch to stop near the 1.2s drain deadline, ran ${elapsedMs}ms`);
});

function listableStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: i => [...map.keys()][i] ?? null,
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    keys: () => [...map.keys()],
  };
}

test('H13: a complete job offers no high-DPI re-read it could not save, and refuses one before any paid call', async () => {
  const requests = [];
  const app = loadIndex({ fetchImpl: async (url, init = {}) => { requests.push(`${init.method || 'GET'} ${url}`); return jsonResponse(200, {}); } });
  try {
    const pdf = new File([new Uint8Array([37, 80, 68, 70, 45])], 'deed.pdf', { type: 'application/pdf' });
    const sourceFiles = app.run('sessionSourceFilesByJob');
    sourceFiles.set('job_done', [pdf]);
    sourceFiles.set('job_partial', [pdf]);
    const labelsFor = job => { app.ctx.renderJobActions(job); return app.run('jobActionButtons').map(button => button.label); };
    assert.equal(labelsFor({ id: 'job_done', status: 'complete', failedDocuments: 1 }).includes('Re-read as high-DPI page images'), false);
    assert.equal(labelsFor({ id: 'job_partial', status: 'partial_failed', failedDocuments: 1 }).includes('Re-read as high-DPI page images'), true);
    await app.ctx.rereadJobPdfsAsHighDpi({ id: 'job_done', status: 'complete', failedDocuments: 1 });
    assert.deepEqual(requests, []);
  } finally {
    disposeAll();
  }
});

test('H14: a Windows .csv typed application/vnd.ms-excel is read as CSV, and a PDF with a short preamble rasterizes', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(200, {}) });
  try {
    assert.equal(app.ctx.isCsvFile(new File(['grantor,grantee'], 'deeds.csv', { type: 'application/vnd.ms-excel' })), true);
    assert.equal(app.ctx.isPdfFile(new File(['%PDF-1.7'], 'deed.pdf', { type: 'application/x-pdf' })), true);
    assert.equal(app.ctx.isImageFile(new File(['x'], 'plat.png', { type: 'image/png' })), true);
  } finally {
    disposeAll();
  }
  const withPreamble = new File([new Uint8Array(64), '%PDF-1.7\n'], 'deed.pdf', { type: 'application/pdf' });
  const pdfjs = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 0, destroy() {} }), destroy() {} }) };
  const outcome = await prepareDocument(withPreamble, { loadPdfjs: async () => pdfjs }).then(() => 'rendered', err => err.message);
  assert.notEqual(outcome, 'File signature does not match the selected document type.');
});

test('H14: a 401 is not retried into a password lockout, and polls end when the job is canceled or already finished', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(200, {}) });
  try {
    let reads = 0;
    await assert.rejects(app.ctx.readServerState(async () => { reads += 1; throw Object.assign(new Error('Unauthorized'), { status: 401 }); }, null), /Unauthorized/);
    assert.equal(reads, 1);
  } finally {
    disposeAll();
  }
  for (const [jobStatus, expected] of [['canceled', 'Job was canceled.'], ['failed', 'returned']]) {
    let statusReads = 0;
    const app2 = loadIndex({
      fetchImpl: async url => {
        if (String(url).endsWith('/synthesis/status')) {
          statusReads += 1;
          return jsonResponse(200, { status: { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, retry_wait: 0 }, job: { id: 'job_end', status: jobStatus } });
        }
        return jsonResponse(200, {});
      },
    });
    try {
      const outcome = await app2.ctx.pollServerSynthesis('job_end', [], 1, null, null).then(() => 'returned', err => err.message);
      assert.equal(outcome, expected);
      assert.equal(statusReads, 1);
    } finally {
      disposeAll();
    }
  }
});

test('H14: a failed save keeps the paid browser opinion with a notice instead of throwing', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(503, { error: 'Database unavailable.' }) });
  try {
    await app.ctx.saveBrowserResultOrWarn('job_save', { status: 'complete', finalTitleOpinion: OPINION });
    assert.match(app.getEl('errorBox').innerHTML, /not saved to the job/);
  } finally {
    disposeAll();
  }
});

test('H14: local abstraction checkpoints expire after a day and are pruned at startup', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(200, {}) });
  try {
    const dayAgo = Date.now() - 25 * 60 * 60 * 1000;
    const files = [new File(['%PDF-1.7'], 'deed.pdf', { type: 'application/pdf' })];
    const key = app.ctx.getFileSignature(files, 0, 'home');
    const storage = listableStorage({
      'title-analyzer-abstraction:old': JSON.stringify({ savedAt: dayAgo, entries: [{ localIndex: 0, abstract: 'old' }] }),
      'title-analyzer-abstraction:fresh': JSON.stringify({ savedAt: Date.now(), entries: [] }),
      [key]: JSON.stringify({ savedAt: dayAgo, entries: [{ localIndex: 0, abstract: 'stale' }] }),
      'unrelated-key': 'kept',
    });
    app.ctx.localStorage = storage;
    assert.equal(app.ctx.loadAbstractionCheckpoint(files, 0, 'home').entries.length, 0);
    assert.equal(storage.getItem(key), null);
    app.ctx.pruneExpiredAbstractionCheckpoints();
    assert.deepEqual(storage.keys().sort(), ['title-analyzer-abstraction:fresh', 'unrelated-key']);
  } finally {
    disposeAll();
  }
});

test('M14: the job view lists failed documents from the saved result and shows run notices on the job route', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(200, {}) });
  try {
    app.run(`rdLatestJob = { jobId: 'job_f', job: null, result: { failedDocuments: [{ originalFilename: 'Book 12 Page 40.pdf' }] } }`);
    app.ctx.renderJobDetail({ id: 'job_f', status: 'partial_failed', failedDocuments: 1 });
    assert.match(app.getEl('jobDetail').innerHTML, /Book 12 Page 40\.pdf/);

    app.ctx.location.hash = '#/job/job_f';
    app.ctx.showError('Server-side abstraction completed with 2 failed chunk(s): retry before final use.');
    assert.match(app.getEl('jobActionError').textContent, /2 failed chunk/);
  } finally {
    disposeAll();
  }
});

test('M15: a double password submit sends one ping, and a poll tick never overlaps one in flight', async () => {
  let pings = 0;
  let jobReads = 0;
  let releaseJobRead;
  const app = loadIndex({
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith('/api/analyze') && init.method === 'POST') { pings += 1; return jsonResponse(401, { error: 'Unauthorized' }); }
      if (String(url).includes('/api/jobs/job_p')) { jobReads += 1; await new Promise(resolve => { releaseJobRead = resolve; }); return jsonResponse(404, { error: 'Job not found.' }); }
      return jsonResponse(200, {});
    },
  });
  try {
    app.getEl('passwordInput').value = 'typo';
    await Promise.all([app.ctx.checkPassword(), app.ctx.checkPassword()]);
    assert.equal(pings, 1);

    const state = { jobId: 'job_p', scope: 'view' };
    const first = app.ctx.runJobPollTick(state);
    const second = app.ctx.runJobPollTick(state);
    await new Promise(resolve => setTimeout(resolve, 0));
    releaseJobRead();
    await Promise.all([first, second]);
    assert.equal(jobReads, 1);
  } finally {
    disposeAll();
  }
});

test('M16: a page too large for a 2D canvas fails with a clear message instead of a TypeError', async () => {
  const page = { getViewport: () => ({ width: 40_000, height: 40_000 }), render: () => ({ promise: Promise.resolve() }), cleanup() {} };
  const pdfjs = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page, destroy() {} }), destroy() {} }) };
  const file = new File(['%PDF-1.7\n'], 'plat.pdf', { type: 'application/pdf' });
  await assert.rejects(
    prepareDocument(file, { loadPdfjs: async () => pdfjs, createCanvas: () => ({ width: 0, height: 0, getContext: () => null }) }),
    /Page 1 is too large to render in this browser/,
  );
});

function routeRequest(method, url, body) {
  return {
    method, url, body, headers: {}, socket: { remoteAddress: '203.0.113.7' },
    query: { path: url.replace(/^\/api\/jobs\//, '').split('/').filter(Boolean) },
  };
}

function routeResponse() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

async function callRoute(method, url, body) {
  const res = routeResponse();
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  try {
    await jobPathHandler(routeRequest(method, url, body), res);
  } finally {
    delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
  }
  return res;
}

test('M4: a deeply nested or very wide body is scanned without overflowing the stack', () => {
  const deep = JSON.parse('['.repeat(50_000) + ']'.repeat(50_000));
  assert.equal(hasRawPayloadFields({ notes: deep }), false);
  assert.equal(hasRawPayloadFields({ notes: new Array(500_000).fill(0) }), false);
  assert.equal(hasRawPayloadFields({ notes: [[{ nested: { abstract: 'text' } }]] }), true);
  assert.equal(validatePatchJobInput({ currentPhase: 'x', extra: deep }, { status: 'uploading', totalDocuments: 1, completedDocuments: 0, failedDocuments: 0 }).valid, true);
});

test('M5: once uploads are finalized, no chunk can be added or moved off uploaded, so synthesis cannot deadlock', async () => {
  const ids = await jobWithChunk({ jobStatus: 'ready', chunkStatus: 'pending' });
  const added = await callRoute('POST', `/api/jobs/${ids.jobId}/documents/${ids.documentId}/chunks`, {
    chunkOrder: 1, originalFilename: 'late.pdf', mediaType: 'application/pdf', sizeBytes: 10, fingerprint: 'fp_late',
  });
  assert.equal(added.statusCode, 409, JSON.stringify(added.body));
  const failedUpload = await callRoute('PATCH', `/api/jobs/${ids.jobId}/chunks/${ids.chunkId}`, { uploadStatus: 'failed' });
  assert.equal(failedUpload.statusCode, 409, JSON.stringify(failedUpload.body));
  assert.equal((await store.getChunk(ids.jobId, ids.chunkId)).uploadStatus, 'uploaded');
});

test('M8: a failed save after a streamed merge keeps the paid opinion and the next pass saves it with no new model call', async () => {
  const jobId = await synthesizingJobWithAbstracts(2);
  const kinds = [];
  const modelClient = async request => {
    const kind = synthesisCallKind(request);
    kinds.push(kind);
    if (kind === 'half') return { text: SEGMENT, model: request.model, usage: {}, stopReason: 'end_turn' };
    if (request.onDelta) await request.onDelta(OPINION, OPINION);
    return { text: OPINION, model: request.model, usage: {}, stopReason: 'end_turn' };
  };
  let failNextSave = true;
  const flakyStore = {
    ...store,
    async saveJobResult(...args) {
      if (failNextSave) {
        failNextSave = false;
        // saveJobResult releases its merge lease in finally even when its write fails.
        await pg.db.query('UPDATE analysis_jobs SET synthesis_merge_worker_id = NULL, synthesis_merge_lease_expires_at = NULL WHERE id = $1', [jobId]);
        throw new Error('connection terminated unexpectedly');
      }
      return store.saveJobResult(...args);
    },
  };
  const options = { store: flakyStore, modelClient, streamFinalOpinion: true, config: { chunkSize: 1, maxAttempts: 1 }, budgetMs: 5_000 };
  await assert.rejects(processSynthesisJob(jobId, options), /connection terminated/);
  assert.equal(await store.getJobResult(jobId), null);
  assert.equal((await store.getSynthesisPreview(jobId))?.complete, true);
  const callsAfterFirstPass = kinds.length;

  const second = await processSynthesisJob(jobId, options);
  assert.equal(kinds.length, callsAfterFirstPass, 'The recovered pass must not call the model again');
  assert.equal(second.result?.status, 'complete');
  assert.equal((await store.getJobResult(jobId))?.finalTitleOpinion, OPINION);
});

test('M10: follow-ups asked about an earlier opinion are not fed into the prompt for a rebuilt one', async () => {
  const job = await store.createJob({ subjectTract: 'Section 12', contextNotes: '', totalDocuments: 1 });
  await pg.db.query("UPDATE analysis_jobs SET status = 'synthesizing' WHERE id = $1", [job.id]);
  const old = await store.appendFollowupMessage(job.id, { question: 'QUESTION ABOUT OPINION V1', answer: 'answer v1' });
  await pg.db.query("UPDATE followup_messages SET created_at = now() - interval '1 hour' WHERE id = $1", [old.id]);
  await store.saveJobResult(job.id, { status: 'complete', finalTitleOpinion: OPINION });
  await store.appendFollowupMessage(job.id, { question: 'QUESTION ABOUT OPINION V2', answer: 'answer v2' });
  let prompt = '';
  await answerFollowupQuestion(job.id, 'Who owns the minerals?', {
    store,
    config: { followupHistoryTurns: 5 },
    modelClient: async request => { prompt = JSON.stringify(request.messages); return { text: 'B owns them.', model: request.model, usage: {} }; },
  });
  assert.equal(prompt.includes('QUESTION ABOUT OPINION V1'), false);
  assert.equal(prompt.includes('QUESTION ABOUT OPINION V2'), true);
});

test('L4: integer fields reject booleans, arrays and blanks; result arrays are capped first; the driver label is the server\'s', () => {
  const job = { status: 'abstracting', totalDocuments: 5, completedDocuments: 0, failedDocuments: 0 };
  assert.deepEqual([true, [], '   ', '2', 3].map(value => validatePatchJobInput({ completedDocuments: value }, job).valid), [false, false, false, true, true]);

  const spoofed = validateSaveJobResultInput({ finalTitleOpinion: 'Opinion', warnings: ['synthesis_driver:server', 'note'] });
  assert.equal(JSON.stringify(spoofed.payload.warnings), '["note"]');
  const browser = validateSaveJobResultInput({ finalTitleOpinion: 'Opinion', synthesisDriver: 'browser', warnings: ['synthesis_driver:server', 'note'] });
  assert.equal(JSON.stringify(browser.payload.warnings), '["synthesis_driver:browser","note"]');
  const huge = validateSaveJobResultInput({ finalTitleOpinion: 'Opinion', warnings: new Array(1_000_000).fill('w') });
  assert.equal(huge.payload.warnings.length, 100);
});

test('L5: a zero concurrency still runs every item, and rollups, cancel, preview clears and lease reads agree with the SQL', async () => {
  assert.deepEqual(await runWithConcurrency([1, 2, 3], 0, async n => n * 2), [2, 4, 6]);

  const failed = await jobWithChunk({ jobStatus: 'abstracting', chunkStatus: 'failed' });
  const rolled = await store.refreshAbstractionRollup(failed.jobId);
  assert.equal(rolled.status, 'failed');
  assert.ok(rolled.completedAt, 'A job whose abstraction failed is terminal, so it records completedAt');

  const live = await jobWithChunk({ jobStatus: 'abstracting', chunkStatus: 'pending' });
  const canceled = await store.cancelJob(live.jobId, 'User stopped job.');
  assert.equal(canceled.abstractChunkFailed, 1, 'cancelJob returns the counts after its chunks were failed');

  const merging = await store.createJob({ subjectTract: 'Section 12', contextNotes: '', totalDocuments: 1 });
  await pg.db.query("UPDATE analysis_jobs SET status = 'synthesizing', synthesis_plan_id = 'plan_l5' WHERE id = $1", [merging.id]);
  await store.setSynthesisPreview(merging.id, { text: 'draft', modelUsed: 'claude-sonnet-5-5' });
  await store.clearSynthesisPreview(merging.id);
  assert.equal((await store.getSynthesisPreview(merging.id)).modelUsed, null);
  await pg.db.query("UPDATE analysis_jobs SET synthesis_merge_worker_id = 'wkr_legacy', synthesis_merge_lease_expires_at = NULL WHERE id = $1", [merging.id]);
  assert.equal((await store.getSynthesisStatus(merging.id, { lightweight: true })).mergeLeaseHeld, false);
  assert.ok(await store.claimSynthesisMerge(merging.id, 'plan_l5', { workerId: 'wkr_new' }), 'The lease the status reports as free can be claimed');
});

test('L6: stream errors keep their text, and OpenRouter routing, slugs and stream options are consistent', async () => {
  await assert.rejects(
    consumeAnthropicMessageStream(streamBody('event: error\ndata: upstream connect error\n\n')),
    /Anthropic stream error: upstream connect error/,
  );
  await assert.rejects(consumeOpenRouterMessageStream(streamBody('data: {"error":"Provider returned error"}\n\n')), /Provider returned error/);

  const previousProvider = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = ' OpenRouter ';
  try {
    assert.equal(shouldUseOpenRouter('claude-sonnet-5-5'), true);
  } finally {
    if (previousProvider === undefined) delete process.env.MODEL_PROVIDER;
    else process.env.MODEL_PROVIDER = previousProvider;
  }
  assert.deepEqual(
    ['claude-sonnet-5-5', 'claude-opus-4-7', 'claude-sonnet-5', 'gemini-3.1-flash-lite'].map(model => buildOpenRouterRequestBody({ model, maxTokens: 10, messages: [] }).model),
    ['anthropic/claude-sonnet-5.5', 'anthropic/claude-opus-4.7', 'anthropic/claude-sonnet-5', 'google/gemini-3.1-flash-lite'],
  );

  let sentBody = null;
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  globalThis.fetch = async (_url, init) => {
    sentBody = JSON.parse(init.body);
    return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { status: 200 });
  };
  try {
    await invokeModel({ model: 'anthropic/claude-sonnet-5.5', maxTokens: 9_000, system: 'sys', messages: [{ role: 'user', content: 'q' }], reasoningEffort: 'high' }, { timeoutMs: 5_000 });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  }
  assert.equal(sentBody.stream, true);
  assert.deepEqual(sentBody.reasoning, { effort: 'high' });
});

test('L7: PDF export spells out arrows, pages a long notice box, and home follow-ups use only the current opinion', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  try {
    const counter = { count: 0 };
    assert.equal(app.ctx.pdfSafeText('Smith → Jones', counter), 'Smith -> Jones');
    assert.equal(counter.count, 0);

    const PAGE_H = 279;
    const MARGIN = 20;
    const draws = [];
    let pages = 1;
    app.ctx.jspdf = {
      jsPDF: class {
        constructor() { this.internal = { pageSize: { getWidth: () => 216, getHeight: () => PAGE_H }, getNumberOfPages: () => pages }; }
        setFillColor() {} setDrawColor() {} rect() {} setTextColor() {} setFontSize() {} setFont() {} line() {} setPage() {}
        addPage() { pages += 1; }
        text(t, _x, y) { draws.push({ page: pages, y, text: String(t) }); }
        splitTextToSize(t) { return [t]; }
        save() {}
      },
    };
    const para = { nodeType: 1, tagName: 'P', innerText: 'B owns 1/2', textContent: 'B owns 1/2', innerHTML: 'B owns 1/2' };
    const card = { querySelector: sel => (sel === '.ac' ? { childNodes: [para] } : null) };
    const jobRoot = app.getEl('jobResults');
    jobRoot.querySelectorAll = sel => (sel === '.analysis-card' ? [card] : []);
    app.ctx.__warnings = Array.from({ length: 120 }, (_, i) => `Instrument ${i + 1} needs a manual check`);
    app.run(`rdLatestJob = { jobId: 'job_pdf', job: { id: 'job_pdf', totalDocuments: 1 }, result: { warnings: __warnings, failedDocuments: [] } }`);
    app.ctx.downloadPDF({ rootElement: jobRoot, tractOverride: 'T' });
    const noticeDraws = draws.filter(d => d.text.startsWith('• Instrument'));
    assert.equal(noticeDraws.length, 120);
    assert.ok(new Set(noticeDraws.map(d => d.page)).size > 1, 'A 120-line notice list continues on another page');
    assert.ok(noticeDraws.every(d => d.y <= PAGE_H - MARGIN), `Every notice line stays above the bottom margin, max y ${Math.max(...noticeDraws.map(d => d.y))}`);

    app.run(`conversationHistory = [
      { role: 'user', content: 'abstracts', kind: 'analysis-input' },
      { role: 'assistant', content: 'OPINION V1', kind: 'title-opinion' },
      { role: 'user', content: 'QUESTION ABOUT V1', kind: 'followup' },
      { role: 'assistant', content: 'ANSWER ABOUT V1', kind: 'followup' },
      { role: 'user', content: 'more abstracts', kind: 'analysis-input' },
      { role: 'assistant', content: 'OPINION V2', kind: 'title-opinion' },
      { role: 'user', content: 'QUESTION ABOUT V2', kind: 'followup' },
      { role: 'assistant', content: 'ANSWER ABOUT V2', kind: 'followup' },
      { role: 'user', content: 'current question', kind: 'followup' },
    ]`);
    const prompt = app.ctx.buildFollowupMessages('current question')[0].content;
    assert.equal(prompt.includes('QUESTION ABOUT V1'), false);
    assert.equal(prompt.includes('QUESTION ABOUT V2'), true);
    assert.equal(prompt.includes('OPINION V2'), true);
  } finally {
    disposeAll();
  }
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err);
    failed += 1;
  }
}
console.log(`${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
