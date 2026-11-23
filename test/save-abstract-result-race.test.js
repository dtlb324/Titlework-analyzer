import assert from 'node:assert/strict';
import { createPostgresJobStore } from '../api/_lib/jobs.js';
import { createPgliteSql } from './helpers/pglite-sql.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const OPINION = 'Paid title opinion';
const PREVIEW = 'paid preview';
const PLAN_ID = 'plan_paid';
const ABSTRACT = 'DOCUMENT #1: mineral deed, grantor to grantee.';

const pg = createPgliteSql();

// Arms only around saveDocumentAbstract. The hook commits the merge when it
// sees the post-abstract job_results delete, before that statement runs.
let raceArmed = false;
let abstractLanded = false;
let raceCount = 0;
let activeRace = null;

function isPostAbstractResultReset(text) {
  return text.includes('DELETE FROM job_results') && text.includes('WHERE job_id');
}

function withMergeRace(baseSql) {
  const sql = (strings, ...values) => {
    const text = strings.join(' ');
    const query = baseSql(strings, ...values);
    if (text.includes('INSERT INTO document_abstracts') && text.includes('FROM claimed')) {
      let pending = null;
      return {
        query: query.query,
        then(resolve, reject) {
          pending ||= Promise.resolve(query).then(rows => {
            if (rows?.[0]) abstractLanded = true;
            return rows;
          });
          return pending.then(resolve, reject);
        },
      };
    }
    if (raceArmed && isPostAbstractResultReset(text)) {
      raceArmed = false;
      let pending = null;
      return {
        query: query.query,
        then(resolve, reject) {
          pending ||= (async () => {
            assert.equal(abstractLanded, true, 'the merge must land after the abstract write');
            raceCount += 1;
            await activeRace();
            return query;
          })();
          return pending.then(resolve, reject);
        },
      };
    }
    return query;
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
         synthesis_merge_started = false,
         synthesis_preview_text = $3,
         synthesis_preview_complete = true,
         synthesis_preview_bytes = 12,
         synthesis_preview_model_used = 'claude-sonnet-5-5'
     WHERE id = $1`,
    [job.id, PLAN_ID, PREVIEW],
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

test('a merge that commits after the abstract write keeps the paid opinion, plan, and preview', async () => {
  for (const terminalStatus of ['complete', 'canceled']) {
    const ids = await jobWithChunk();
    abstractLanded = false;
    raceCount = 0;
    activeRace = async () => {
      if (terminalStatus === 'complete') {
        const saved = await store.saveJobResult(ids.jobId, {
          planId: PLAN_ID,
          status: 'complete',
          finalTitleOpinion: OPINION,
        });
        assert.ok(saved, 'merge-save should commit before the result delete');
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
      // plan and preview back so a later unguarded reset is visible.
      await restorePaidPlan(ids.jobId);
    };
    raceArmed = true;
    const saved = await store.saveDocumentAbstract(abstractRecord(ids));
    raceArmed = false;

    assert.equal(raceCount, 1, `the ${terminalStatus} merge was not injected before the result delete`);
    assert.ok(saved, `the abstract write should commit before the ${terminalStatus} merge`);
    assert.equal(saved.abstractText, ABSTRACT);
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

test('an abstract change still clears a stale opinion while the job is open', async () => {
  const ids = await jobWithChunk();
  await pg.db.query(
    `INSERT INTO job_results (id, job_id, plan_id, status, final_title_opinion)
     VALUES ($1, $2, 'plan_stale', 'complete', 'Stale opinion')`,
    [`res_${ids.jobId}`, ids.jobId],
  );
  raceArmed = false;
  abstractLanded = false;
  const saved = await store.saveDocumentAbstract(abstractRecord(ids));
  assert.equal(saved?.abstractText, ABSTRACT);
  assert.equal(await store.getJobResult(ids.jobId), null);
  const job = await store.getJob(ids.jobId);
  assert.equal(job.status, 'synthesizing');
  assert.equal(job.synthesisPlanId, null);
  assert.equal(job.synthesisPreviewText, null);
  assert.equal(job.synthesisPreviewComplete, false);
  assert.equal(job.synthesisPreviewBytes, 0);
  assert.equal(job.synthesisPreviewModelUsed, null);
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
