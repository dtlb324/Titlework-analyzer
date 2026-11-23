import assert from 'node:assert/strict';
import { createPostgresJobStore } from '../api/_lib/jobs.js';
import { createPgliteSql } from './helpers/pglite-sql.js';

// PGlite is one connection, so these tests check statement order and the status guards.
// They cannot show the FOR UPDATE wait between two sessions; that needs a real Postgres.

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const OPINION = 'Paid title opinion';
const PREVIEW = 'paid preview';
const PLAN_ID = 'plan_paid';
const MERGE_WORKER = 'mw_paid';
const ABSTRACT = 'DOCUMENT #1: mineral deed, grantor to grantee.';

const pg = createPgliteSql();

// When armed, runs the merge after saveDocumentAbstract has read the old abstract and
// before its write statement executes.
let beforeAbstractWrite = null;

function withMergeRace(baseSql) {
  const sql = (strings, ...values) => {
    const query = baseSql(strings, ...values);
    if (!beforeAbstractWrite || !strings.join(' ').includes('INSERT INTO document_abstracts')) return query;
    const race = beforeAbstractWrite;
    beforeAbstractWrite = null;
    let pending = null;
    return {
      query: query.query,
      then(resolve, reject) {
        pending ||= race().then(() => query);
        return pending.then(resolve, reject);
      },
    };
  };
  if (typeof baseSql.transaction === 'function') sql.transaction = baseSql.transaction.bind(baseSql);
  return sql;
}

const store = createPostgresJobStore({ sql: withMergeRace(pg.sql) });

async function jobWithChunk() {
  const job = await store.createJob({ subjectTract: 'Section 12', contextNotes: '', totalDocuments: 1 });
  const fingerprint = `fp_${job.id}`;
  const doc = await store.createDocument(job.id, {
    originalFilename: 'deed.pdf', mediaType: 'application/pdf', sizeBytes: 10, uploadStatus: 'uploaded', fingerprint,
  });
  const chunk = await store.createChunk(job.id, doc.id, {
    chunkOrder: 0, originalFilename: 'deed.pdf', mediaType: 'application/pdf', sizeBytes: 10, uploadStatus: 'uploaded', fingerprint,
  });
  await pg.db.query(
    `UPDATE document_chunks
     SET abstraction_status = 'processing', abstraction_worker_id = 'wkr_slow'
     WHERE id = $1`,
    [chunk.id],
  );
  await pg.db.query(
    `UPDATE analysis_jobs
     SET status = 'synthesizing',
         current_phase = 'synthesizing',
         synthesis_plan_id = $2,
         synthesis_merge_started = true,
         synthesis_merge_worker_id = $4,
         synthesis_preview_text = $3,
         synthesis_preview_complete = true,
         synthesis_preview_bytes = 12,
         synthesis_preview_model_used = 'claude-sonnet-5-5'
     WHERE id = $1`,
    [job.id, PLAN_ID, PREVIEW, MERGE_WORKER],
  );
  return { jobId: job.id, documentId: doc.id, chunkId: chunk.id };
}

function abstractRecord(ids) {
  return {
    jobId: ids.jobId,
    documentId: ids.documentId,
    chunkId: ids.chunkId,
    abstractText: ABSTRACT,
    modelUsed: 'gemini-3.1-flash-lite',
    payloadBytes: 1,
    latencyMs: 1,
    inputTokens: 1,
    outputTokens: 1,
    status: 'completed',
    attemptCount: 1,
    workerId: 'wkr_slow',
  };
}

function mergeSave(jobId) {
  return store.saveJobResult(jobId, {
    planId: PLAN_ID,
    mergeWorkerId: MERGE_WORKER,
    status: 'complete',
    finalTitleOpinion: OPINION,
  });
}

async function restorePaidPlan(jobId) {
  await pg.db.query(
    `UPDATE analysis_jobs
     SET synthesis_plan_id = $2,
         synthesis_preview_text = $3,
         synthesis_preview_complete = true,
         synthesis_preview_bytes = 12,
         synthesis_preview_model_used = 'claude-sonnet-5-5'
     WHERE id = $1`,
    [jobId, PLAN_ID, PREVIEW],
  );
}

async function chunkStatus(chunkId) {
  const { rows } = await pg.db.query('SELECT abstraction_status FROM document_chunks WHERE id = $1', [chunkId]);
  return rows[0].abstraction_status;
}

test('a merge that commits before the abstract write keeps the paid opinion and refuses the abstract', async () => {
  for (const terminalStatus of ['complete', 'canceled']) {
    const ids = await jobWithChunk();
    let raced = false;
    beforeAbstractWrite = async () => {
      raced = true;
      if (terminalStatus === 'complete') {
        assert.ok(await mergeSave(ids.jobId), 'merge-save should commit before the abstract write');
      } else {
        await pg.db.query(
          `INSERT INTO job_results (id, job_id, plan_id, status, final_title_opinion)
           VALUES ($1, $2, $3, 'complete', $4)`,
          [`res_${ids.jobId}`, ids.jobId, PLAN_ID, OPINION],
        );
        await pg.db.query(
          `UPDATE analysis_jobs
           SET status = 'canceled', current_phase = 'canceled', completed_at = now()
           WHERE id = $1`,
          [ids.jobId],
        );
      }
      // saveJobResult clears the preview as part of finishing. Put the paid
      // plan and preview back so an unguarded reset would be visible.
      await restorePaidPlan(ids.jobId);
    };
    const saved = await store.saveDocumentAbstract(abstractRecord(ids));

    assert.equal(raced, true, `the ${terminalStatus} merge was not injected before the abstract write`);
    assert.equal(saved, null, `the abstract must be refused once the job is ${terminalStatus}`);
    assert.equal(await store.getDocumentAbstractByChunkId(ids.jobId, ids.chunkId), null);
    assert.equal(await chunkStatus(ids.chunkId), 'processing');
    const result = await store.getJobResult(ids.jobId);
    assert.equal(result?.finalTitleOpinion, OPINION);
    assert.equal(result?.planId, PLAN_ID);
    const job = await store.getJob(ids.jobId);
    assert.equal(job.status, terminalStatus);
    assert.equal(job.synthesisPlanId, PLAN_ID);
    assert.equal(job.synthesisPreviewText, PREVIEW);
    assert.equal(job.synthesisPreviewComplete, true);
    assert.equal(job.synthesisPreviewBytes, 12);
    assert.equal(job.synthesisPreviewModelUsed, 'claude-sonnet-5-5');
  }
});

test('a merge that saves after the abstract lands cannot store an opinion built from the old abstract', async () => {
  const ids = await jobWithChunk();
  const saved = await store.saveDocumentAbstract(abstractRecord(ids));
  assert.equal(saved?.abstractText, ABSTRACT);

  assert.equal(await mergeSave(ids.jobId), null);
  assert.equal(await store.getJobResult(ids.jobId), null);
  const job = await store.getJob(ids.jobId);
  assert.equal(job.status, 'synthesizing');
  assert.equal(job.synthesisPlanId, null);
  assert.equal(job.synthesisMergeWorkerId, null);
});

test('an abstract change still clears a stale opinion while the job is open', async () => {
  const ids = await jobWithChunk();
  await pg.db.query(
    `INSERT INTO job_results (id, job_id, plan_id, status, final_title_opinion)
     VALUES ($1, $2, 'plan_stale', 'complete', 'Stale opinion')`,
    [`res_${ids.jobId}`, ids.jobId],
  );
  const saved = await store.saveDocumentAbstract(abstractRecord(ids));
  assert.equal(saved?.abstractText, ABSTRACT);
  assert.equal(await chunkStatus(ids.chunkId), 'completed');
  assert.equal(await store.getJobResult(ids.jobId), null);
  const job = await store.getJob(ids.jobId);
  assert.equal(job.status, 'synthesizing');
  assert.equal(job.synthesisPlanId, null);
  assert.equal(job.synthesisPreviewText, null);
  assert.equal(job.synthesisPreviewComplete, false);
  assert.equal(job.synthesisPreviewBytes, 0);
  assert.equal(job.synthesisPreviewModelUsed, null);
});

test('preserveSynthesisPlan keeps the opinion and plan when the abstract changes', async () => {
  const ids = await jobWithChunk();
  await pg.db.query(
    `INSERT INTO job_results (id, job_id, plan_id, status, final_title_opinion)
     VALUES ($1, $2, $3, 'complete', $4)`,
    [`res_${ids.jobId}`, ids.jobId, PLAN_ID, OPINION],
  );
  const saved = await store.saveDocumentAbstract(abstractRecord(ids), { preserveSynthesisPlan: true });
  assert.equal(saved?.abstractText, ABSTRACT);
  assert.equal((await store.getJobResult(ids.jobId))?.finalTitleOpinion, OPINION);
  const job = await store.getJob(ids.jobId);
  assert.equal(job.synthesisPlanId, PLAN_ID);
  assert.equal(job.synthesisPreviewText, PREVIEW);
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
