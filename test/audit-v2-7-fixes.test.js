import assert from 'node:assert/strict';
import { createPostgresJobStore, validatePatchJobInput } from '../api/_lib/jobs.js';
import { enqueueSynthesisJob, processAbstractionBatch, retryFailedAbstractionChunks } from '../api/_lib/queue.js';
import { getPartialSynthesisConfig, PARTIAL_SYNTHESIS_PROMPT, processSynthesisJob } from '../api/_lib/synthesis.js';
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
