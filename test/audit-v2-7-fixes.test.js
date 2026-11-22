import assert from 'node:assert/strict';
import { createPostgresJobStore, validatePatchJobInput } from '../api/_lib/jobs.js';
import { enqueueSynthesisJob, processAbstractionBatch, retryFailedAbstractionChunks } from '../api/_lib/queue.js';
import { processSynthesisJob } from '../api/_lib/synthesis.js';
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
