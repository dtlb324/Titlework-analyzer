import assert from 'node:assert/strict';
import {
  mutateSharedRateLimit,
  RATE_LIMIT_READ_TTL_MS,
  resetSharedRateLimits,
  SharedRateLimitError,
} from '../api/_lib/shared-rate-limit.js';
import { readOpsJson } from '../api/_lib/storage.js';
import {
  COMPACTION_SYNTHESIS_PROMPT,
  PARTIAL_SYNTHESIS_PROMPT,
  processSynthesisJob,
  shouldCompactBeforeMerge,
} from '../api/_lib/synthesis.js';
import { createPostgresJobStore } from '../api/_lib/jobs.js';
import jobPathHandler from '../api/jobs/[...path].js';
import { disposeAll, jsonResponse, loadIndex, makeJobServer, pngFile, StubElement, tick } from './helpers/browser-index-harness.js';
import { createPgliteSql } from './helpers/pglite-sql.js';

if (!StubElement.prototype.removeAttribute) {
  StubElement.prototype.removeAttribute = function removeAttribute(k) { delete this[k]; };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
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

// ---- Critical #1: Shared GCS rate limiter count-drop bypass, window bleed, fail-closed refresh, and readOpsJson CAS ----

test('Critical #1a: shared rate limiter flushes buffered counts across >1s pauses instead of dropping them', async () => {
  const realNow = Date.now;
  let fakeNow = 1_700_000_000_000;
  Date.now = () => fakeNow;
  resetSharedRateLimits();
  const objects = new Map();
  let writes = 0;
  globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__ = {
    async read(key) {
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
    let blocked = 0;
    // Send 5 bursts of 5 requests (25 total) separated by >1s pauses against a 10-req/min limit.
    for (let burst = 0; burst < 5; burst++) {
      for (let i = 0; i < 5; i++) {
        const over = await mutateSharedRateLimit({
          scope: 'analyze',
          ip: '198.51.100.10',
          windowMs: 60_000,
          update: entry => {
            entry.count += 1;
            return entry.count > 10;
          },
        });
        if (over) blocked += 1;
        fakeNow += 10;
      }
      fakeNow += RATE_LIMIT_READ_TTL_MS + 10;
    }
    assert.equal(blocked, 15, `Expected 15 of 25 requests blocked against limit 10, got ${blocked}`);
    assert.ok(writes >= 4, `Expected buffered counts to flush to GCS across bursts, saw ${writes} writes`);
    const [stored] = [...objects.values()];
    assert.ok(stored && stored.data.count >= 21, `Expected persisted GCS count >= 21, got ${stored?.data?.count}`);
  } finally {
    Date.now = realNow;
    delete globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
    resetSharedRateLimits();
  }
});

test('Critical #1b: shared rate limiter does not bleed expired-window buffered counts into a new window', async () => {
  const realNow = Date.now;
  let fakeNow = 1_700_000_000_000;
  Date.now = () => fakeNow;
  resetSharedRateLimits();
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
    // Request 1 starts window at t=0 (flushed); requests 2..6 buffer near end of 60s window.
    await mutateSharedRateLimit({ scope: 'jobs', ip: '198.51.100.11', windowMs: 60_000, update: e => { e.count += 1; } });
    fakeNow += 59_500;
    // Flush at t=59.5s (still same window), then buffer 5 requests at t=59.6s..59.8s.
    await mutateSharedRateLimit({ scope: 'jobs', ip: '198.51.100.11', windowMs: 60_000, update: e => { e.count += 1; } });
    for (let i = 0; i < 5; i++) {
      fakeNow += 50;
      await mutateSharedRateLimit({ scope: 'jobs', ip: '198.51.100.11', windowMs: 60_000, update: e => { e.count += 1; } });
    }
    // Cross the 60s boundary while cache is still fresh (<1000ms since last request).
    fakeNow += 400; // now = 60_150 > 60_000
    let observedCount = 0;
    await mutateSharedRateLimit({
      scope: 'jobs',
      ip: '198.51.100.11',
      windowMs: 60_000,
      update: e => {
        e.count += 1;
        observedCount = e.count;
      },
    });
    assert.equal(observedCount, 1, `Expected fresh window count 1 without expired bleed, got ${observedCount}`);
  } finally {
    Date.now = realNow;
    delete globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
    resetSharedRateLimits();
  }
});

test('Critical #1c: refreshShared wraps backend errors in SharedRateLimitError', async () => {
  resetSharedRateLimits();
  globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__ = {
    async read() {
      const err = new Error('ECONNRESET');
      err.code = 500;
      throw err;
    },
    async write() { throw new Error('should not write'); },
  };
  try {
    await assert.rejects(
      () => mutateSharedRateLimit({ scope: 'jobs', ip: '198.51.100.12', windowMs: 60_000, update: () => 'ok' }),
      err => err instanceof SharedRateLimitError && err.statusCode === 503,
    );
  } finally {
    delete globalThis.__TITLE_ANALYZER_RATE_LIMIT_BACKEND__;
    resetSharedRateLimits();
  }
});

test('Critical #1d: readOpsJson reads generation first, downloads pinned generation, retries on 404 race, and fails closed on metadata error', async () => {
  const key = 'ops/rate-limits/jobs/' + 'a'.repeat(64) + '.json';
  const calls = [];
  let version = 1001;
  const raceBucket = {
    file(name, opts = {}) {
      return {
        async getMetadata() {
          calls.push({ op: 'getMetadata', name, generation: opts.generation });
          return [{ generation: String(version) }];
        },
        async download() {
          calls.push({ op: 'download', name, generation: opts.generation });
          if (opts.generation === 1001) {
            // Simulate concurrent overwrite replacing gen 1001 with gen 1002 before download.
            version = 1002;
            const err = new Error('No such generation');
            err.code = 404;
            throw err;
          }
          assert.equal(opts.generation, 1002, 'download must pin the generation read from getMetadata');
          return [Buffer.from(JSON.stringify({ count: 7, failedAuth: 2, windowStart: 123 }))];
        },
      };
    },
  };
  const res = await readOpsJson(key, { bucket: raceBucket, config: { bucket: 'b' } });
  assert.equal(res.generation, 1002);
  assert.equal(res.data.count, 7);
  assert.equal(calls[0].op, 'getMetadata');
  assert.equal(calls[1].op, 'download');
  assert.equal(calls[1].generation, 1001);

  const failingMetaBucket = {
    file() {
      return {
        async getMetadata() {
          const err = new Error('transient GCS outage');
          err.code = 500;
          throw err;
        },
      };
    },
  };
  await assert.rejects(
    () => readOpsJson(key, { bucket: failingMetaBucket, config: { bucket: 'b' } }),
    /transient GCS outage/,
  );
});

// ---- Critical #2: Durable upload completion/failure refreshes #view-job instead of freezing ----

test('Critical #2: runStagedAnalysis refreshes #view-job after stopping poller on completion', async () => {
  let jobStatus = 'synthesizing';
  const server = makeJobServer({
    abstractionReadyAfter: 0,
    synthesisReadyAfter: 0,
    hooks: {
      'GET /api/jobs/job_1': async () => jsonResponse(200, {
        job: { id: 'job_1', status: jobStatus, totalDocuments: 1, completedDocuments: 1, failedDocuments: 0, currentPhase: jobStatus },
      }),
      'GET /api/jobs/job_1/synthesis/status': async (srv) => {
        srv.state.synthesisReads += 1;
        jobStatus = 'complete';
        return jsonResponse(200, {
          status: { total: 1, pending: 0, processing: 0, complete: 1, failed: 0, mergeInProgress: false, mergeLeaseHeld: false, hasResult: true },
        });
      },
      'GET /api/jobs/job_1/result': async () => jsonResponse(200, {
        result: { status: 'complete', finalTitleOpinion: makeGoodOpinion('Verified refresh.'), warnings: [], failedDocuments: [] },
      }),
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'a'.repeat(32))]);
  await app.run('analyze()');
  await tick(20);
  assert.equal(app.ctx.location.hash, '#/job/job_1', 'Durable upload should navigate to #/job/job_1');
  assert.ok(
    server.calls.filter(c => c === 'GET /api/jobs/job_1').length >= 1,
    'Expected loadJobView refresh fetch for #/job/job_1 after completion',
  );
  assert.match(app.getEl('jobResults').innerHTML, /Verified refresh\./, 'Expected #view-job to render the completed opinion');
});

test('Critical #2b: runStagedAnalysis refreshes #view-job after stopping poller on failure', async () => {
  let jobStatus = 'abstracting';
  const server = makeJobServer({
    hooks: {
      'POST /api/jobs/job_1/abstraction/start': async () => jsonResponse(503, { error: 'no server', fallback: 'browser_abstraction' }),
      'POST /api/analyze': async () => jsonResponse(500, { error: 'Upstream failed' }),
      'PATCH /api/jobs/job_1': async (_srv, opts) => {
        const body = JSON.parse(opts.body);
        if (body.status) jobStatus = body.status;
        return jsonResponse(200, { job: { id: 'job_1', status: jobStatus } });
      },
      'GET /api/jobs/job_1': async () => jsonResponse(200, {
        job: { id: 'job_1', status: jobStatus, totalDocuments: 1, completedDocuments: 0, failedDocuments: 1, errorMessage: 'Upstream failed' },
      }),
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'a'.repeat(32))]);
  await app.run('analyze()');
  await tick(20);
  assert.equal(app.ctx.location.hash, '#/job/job_1');
  assert.equal(jobStatus, 'failed');
  assert.match(app.getEl('jobHeader').innerHTML, /Job failed/, 'Expected #view-job header to reflect failed status after refresh');
});

test('Critical #2c: a hung #view-job refresh does not hold the failed run open', async () => {
  const server = makeJobServer({
    hooks: {
      'POST /api/jobs/job_1/abstraction/start': async () => jsonResponse(503, { error: 'no server', fallback: 'browser_abstraction' }),
      'POST /api/analyze': async () => jsonResponse(500, { error: 'Upstream failed' }),
      'PATCH /api/jobs/job_1': async (_srv, opts) => jsonResponse(200, { job: { id: 'job_1', status: JSON.parse(opts.body).status || 'abstracting' } }),
      'GET /api/jobs/job_1': () => new Promise(() => {}),
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'a'.repeat(32))]);
  await Promise.race([app.run('analyze()'), tick(300)]);
  assert.equal(app.ctx.location.hash, '#/job/job_1');
  assert.ok(server.calls.includes('GET /api/jobs/job_1'), 'Expected the #view-job refresh to start');
  assert.equal(app.getEl('progressSection').style.display, 'none', 'Progress must hide while the refresh is still pending');
  assert.equal(app.getEl('analyzeBtn').disabled, false, 'Analyze must re-enable while the refresh is still pending');
  assert.equal(app.run('activeAnalysisRun'), null, 'The failed run must end while the refresh is still pending');
});

test('Critical #2d: refreshing a still-running job after a failed run polls only while its page is open', async () => {
  const server = makeJobServer({
    abstractionReadyAfter: 0,
    hooks: {
      'POST /api/jobs/job_1/synthesis/start': async () => jsonResponse(503, { error: 'no synth', fallback: 'browser_synthesis' }),
      'POST /api/analyze': async () => jsonResponse(500, { error: 'browser synthesis upstream failed' }),
      'PATCH /api/jobs/job_1': async () => jsonResponse(500, { error: 'patch failed' }),
      'GET /api/jobs/job_1': async () => jsonResponse(200, {
        job: { id: 'job_1', status: 'synthesizing', totalDocuments: 1, completedDocuments: 1, failedDocuments: 0, currentPhase: 'Synthesizing' },
      }),
      'GET /api/jobs/job_1/synthesis/status': async () => jsonResponse(200, {
        status: { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, retry_wait: 0, hasResult: false, mergeInProgress: false, mergeLeaseHeld: false },
      }),
      'POST /api/jobs/job_1/synthesis/process': async () => jsonResponse(503, { error: 'no synth', fallback: 'browser_synthesis' }),
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'a'.repeat(32))]);
  await app.run('analyze()');
  await tick(20);
  assert.equal(app.ctx.location.hash, '#/job/job_1');
  assert.equal(app.run('activeAnalysisRun'), null);
  const kicks = () => server.calls.filter(c => c === 'POST /api/jobs/job_1/synthesis/process').length;
  const kicksBeforeLeaving = kicks();
  app.ctx.location.hash = '#/';
  for (let i = 0; i < 8; i++) {
    if (app.run('activeJobPollState')) await app.run('runJobPollTick(activeJobPollState)');
  }
  assert.equal(kicks(), kicksBeforeLeaving, 'A job the tab no longer drives must not be kicked after its page is left');
});

// ---- Critical #3: maybeKickStalledJobWorkflow kicks unplanned synthesizing jobs ----

test('Critical #3: maybeKickStalledJobWorkflow kicks /synthesis/process when a synthesizing job has no plan yet', async () => {
  const calls = [];
  const app = loadIndex({
    fetchImpl: async (url, options = {}) => {
      const method = options.method || 'GET';
      const path = String(url).replace('https://harness.invalid', '');
      calls.push(`${method} ${path}`);
      if (path === '/api/jobs/job_syn') {
        return jsonResponse(200, {
          job: { id: 'job_syn', status: 'synthesizing', totalDocuments: 2, completedDocuments: 2, failedDocuments: 0, currentPhase: 'Server abstraction finished: 2 completed, 0 failed' },
        });
      }
      if (path === '/api/jobs/job_syn/synthesis/status') {
        return jsonResponse(200, {
          status: { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, retry_wait: 0, planId: null, hasResult: false, mergeInProgress: false, mergeLeaseHeld: false },
        });
      }
      if (path === '/api/jobs/job_syn/synthesis/process') {
        return jsonResponse(200, { status: { total: 1, pending: 0, processing: 1 } });
      }
      return jsonResponse(200, {});
    },
  });
  app.ctx.location.hash = '#/job/job_syn';
  await app.ctx.loadJobView('job_syn');
  // WORKFLOW_STALL_THRESHOLD is 4: poll 1 establishes signature, polls 2..5 increment stall count to 4 and kick.
  for (let i = 0; i < 5; i++) {
    await app.run('runJobPollTick(activeJobPollState)');
  }
  assert.ok(
    calls.includes('POST /api/jobs/job_syn/synthesis/process'),
    `Expected stall kicker to POST /synthesis/process for unplanned synthesizing job; calls=${JSON.stringify(calls)}`,
  );

  // An active browser-driven run for the same job must NOT kick server /synthesis/process.
  calls.length = 0;
  app.run('activeAnalysisRun = { jobId: "job_syn", driver: "browser" }; activeJobPollState.workflowStallPolls = 10;');
  await app.run('runJobPollTick(activeJobPollState)');
  assert.equal(
    calls.includes('POST /api/jobs/job_syn/synthesis/process'),
    false,
    'Browser-driven synthesis run must not trigger server /synthesis/process kick',
  );
});

// ---- Critical #4-#7 run the real job store SQL against in-process Postgres (PGlite) ----

const pg = createPgliteSql();
const pgStore = createPostgresJobStore({ sql: pg.sql });

function planSegment(segmentIndex, overrides = {}) {
  return {
    segmentIndex,
    startSequenceIndex: segmentIndex * 2,
    endSequenceIndex: segmentIndex * 2 + 1,
    documentIds: [`doc_${segmentIndex}`],
    filenames: [`deed_${segmentIndex}.pdf`],
    estimatedBytes: 100,
    ...overrides,
  };
}

async function createPlannedJob(store, planId, segmentCount) {
  const job = await store.createJob({ subjectTract: 'Section 12, Block C-8', contextNotes: '', totalDocuments: segmentCount });
  await pg.db.query(`UPDATE analysis_jobs SET status = 'synthesizing' WHERE id = $1`, [job.id]);
  const plan = await store.saveSynthesisPlan(job.id, {
    planId,
    segments: Array.from({ length: segmentCount }, (_, i) => planSegment(i)),
  });
  return { jobId: job.id, segments: plan.segments };
}

async function setSegmentStatuses(jobId, statuses) {
  for (const [segmentIndex, status] of statuses.entries()) {
    await pg.db.query(`UPDATE synthesis_segments SET status = $3 WHERE job_id = $1 AND segment_index = $2`, [jobId, segmentIndex, status]);
  }
}

async function segmentRows(jobId) {
  const { rows } = await pg.db.query(
    `SELECT plan_id, segment_index, status, error_type, worker_id, lease_expires_at
       FROM synthesis_segments WHERE job_id = $1 ORDER BY plan_id, segment_index`,
    [jobId],
  );
  return rows;
}

async function jobRow(jobId) {
  const { rows } = await pg.db.query(
    `SELECT status, synthesis_plan_id, synthesis_merge_worker_id, synthesis_preview_text FROM analysis_jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0];
}

async function resultPlanId(jobId) {
  const { rows } = await pg.db.query(`SELECT plan_id FROM job_results WHERE job_id = $1`, [jobId]);
  return rows[0]?.plan_id ?? null;
}

test('Critical #4: the worker lists finished multi-segment jobs whose segments failed, and only those', async () => {
  const degraded = await createPlannedJob(pgStore, 'plan_degraded', 3);
  await setSegmentStatuses(degraded.jobId, ['complete', 'complete', 'failed']);
  const allFailed = await createPlannedJob(pgStore, 'plan_all_failed', 2);
  await setSegmentStatuses(allFailed.jobId, ['failed', 'failed']);
  const allComplete = await createPlannedJob(pgStore, 'plan_all_complete', 2);
  await setSegmentStatuses(allComplete.jobId, ['complete', 'complete']);

  const inFlight = await createPlannedJob(pgStore, 'plan_in_flight', 2);
  await setSegmentStatuses(inFlight.jobId, ['failed']);
  assert.ok(await pgStore.claimSynthesisSegment(inFlight.jobId, inFlight.segments[1].id, { workerId: 'wkr_live', leaseMs: 600000 }));
  const mergeLeased = await createPlannedJob(pgStore, 'plan_merge_leased', 2);
  await setSegmentStatuses(mergeLeased.jobId, ['complete', 'failed']);
  assert.ok(await pgStore.claimSynthesisMerge(mergeLeased.jobId, 'plan_merge_leased', { workerId: 'merge_live', leaseMs: 600000 }));
  const canceled = await createPlannedJob(pgStore, 'plan_canceled', 2);
  await setSegmentStatuses(canceled.jobId, ['complete', 'failed']);
  await pgStore.cancelJob(canceled.jobId, 'User stopped job.');

  const listed = new Set(await pgStore.listRunnableSynthesisJobIds(100));
  assert.deepEqual(
    [degraded, allFailed, allComplete, inFlight, mergeLeased, canceled].map(job => listed.has(job.jobId)),
    [true, true, true, false, false, false],
    'Expected degraded, all-failed and all-complete jobs listed; in-flight, merge-leased and canceled jobs not listed',
  );
});

test('Critical #5: canceling a job stops its synthesis segments, and canceled jobs refuse segment claims and renewals', async () => {
  const job = await createPlannedJob(pgStore, 'plan_cancel', 3);
  const [first, second, third] = job.segments;
  await setSegmentStatuses(job.jobId, ['pending', 'pending', 'complete']);
  assert.ok(await pgStore.claimSynthesisSegment(job.jobId, first.id, { workerId: 'wkr_1', leaseMs: 600000 }));
  assert.ok(await pgStore.cancelJob(job.jobId, 'User stopped job.'));
  assert.deepEqual(
    (await segmentRows(job.jobId)).map(row => [row.segment_index, row.status, row.error_type, row.worker_id, row.lease_expires_at]),
    [[0, 'failed', 'canceled', null, null], [1, 'failed', 'canceled', null, null], [2, 'complete', null, null, null]],
  );
  assert.equal(await pgStore.renewSynthesisSegmentLease(job.jobId, first.id, { workerId: 'wkr_1', leaseMs: 600000 }), null);
  assert.equal(await pgStore.claimSynthesisSegment(job.jobId, second.id, { workerId: 'wkr_2' }), null);
  assert.equal(await pgStore.claimSynthesisSegment(job.jobId, third.id, { workerId: 'wkr_3' }), null);

  // A job canceled before its segments were failed (for example by an older release) still has active segments.
  const legacy = await createPlannedJob(pgStore, 'plan_legacy_cancel', 2);
  assert.ok(await pgStore.claimSynthesisSegment(legacy.jobId, legacy.segments[0].id, { workerId: 'wkr_1', leaseMs: 600000 }));
  assert.ok(await pgStore.renewSynthesisSegmentLease(legacy.jobId, legacy.segments[0].id, { workerId: 'wkr_1', leaseMs: 600000 }));
  await pg.db.query(`UPDATE analysis_jobs SET status = 'canceled' WHERE id = $1`, [legacy.jobId]);
  assert.equal(await pgStore.renewSynthesisSegmentLease(legacy.jobId, legacy.segments[0].id, { workerId: 'wkr_1', leaseMs: 600000 }), null);
  assert.equal(await pgStore.claimSynthesisSegment(legacy.jobId, legacy.segments[1].id, { workerId: 'wkr_2' }), null);

  // Verify GET /api/jobs/:id/synthesis/status returns hasMore: false for a canceled job even if stale pending segments exist.
  const prevPassword = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'secret';
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = {
    async getJob() { return { id: 'job_c1', status: 'canceled' }; },
    async getSynthesisStatus() {
      return {
        job: { id: 'job_c1', status: 'canceled' },
        planId: 'plan_1',
        total: 2,
        pending: 1,
        processing: 0,
        complete: 1,
        failed: 0,
        retry_wait: 0,
        mergeInProgress: false,
        mergeLeaseHeld: false,
        hasResult: false,
        segments: [],
      };
    },
  };
  try {
    const res = {
      statusCode: 200,
      headers: {},
      body: null,
      setHeader(k, v) { this.headers[k] = v; },
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    await jobPathHandler({
      method: 'GET',
      url: '/api/jobs/job_c1/synthesis/status',
      headers: { 'x-app-password': 'secret' },
      query: { path: ['job_c1', 'synthesis', 'status'] },
      socket: { remoteAddress: '127.0.0.1' },
    }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.status.hasMore, false, 'Canceled job synthesis status must report hasMore: false');
  } finally {
    delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
    if (prevPassword === undefined) delete process.env.APP_PASSWORD;
    else process.env.APP_PASSWORD = prevPassword;
  }
});

async function assertPlanResaves(store) {
  const job = await createPlannedJob(store, 'plan_a', 3);
  assert.deepEqual(job.segments.map(segment => [segment.planId, segment.segmentIndex, segment.status]), [
    ['plan_a', 0, 'pending'], ['plan_a', 1, 'pending'], ['plan_a', 2, 'pending'],
  ]);
  assert.ok(await store.claimSynthesisMerge(job.jobId, 'plan_a', { workerId: 'merge_1', leaseMs: 600000 }));
  await pg.db.query(`UPDATE analysis_jobs SET synthesis_preview_text = 'partial preview' WHERE id = $1`, [job.jobId]);
  await pg.db.query(`INSERT INTO job_results (id, job_id, plan_id, status, final_title_opinion) VALUES ($1, $2, 'plan_a', 'complete', 'opinion')`, [`res_${job.jobId}`, job.jobId]);

  const shrunk = await store.saveSynthesisPlan(job.jobId, { planId: 'plan_a', segments: [planSegment(0), planSegment(1)] });
  assert.deepEqual(shrunk.segments.map(segment => segment.segmentIndex), [0, 1]);
  assert.deepEqual((await segmentRows(job.jobId)).map(row => [row.plan_id, row.segment_index]), [['plan_a', 0], ['plan_a', 1]]);
  assert.deepEqual(await jobRow(job.jobId), {
    status: 'synthesizing', synthesis_plan_id: 'plan_a', synthesis_merge_worker_id: 'merge_1', synthesis_preview_text: 'partial preview',
  }, 'A same-plan re-save must keep the merge lease and preview');
  assert.equal(await resultPlanId(job.jobId), 'plan_a');

  await store.saveSynthesisPlan(job.jobId, { planId: 'plan_b', segments: [planSegment(0)] });
  assert.deepEqual((await segmentRows(job.jobId)).map(row => [row.plan_id, row.segment_index]), [['plan_b', 0]]);
  assert.deepEqual(await jobRow(job.jobId), {
    status: 'synthesizing', synthesis_plan_id: 'plan_b', synthesis_merge_worker_id: null, synthesis_preview_text: null,
  }, 'A new plan must clear the old merge lease and preview');
  assert.equal(await resultPlanId(job.jobId), null);
  return job.jobId;
}

test('Critical #6: saveSynthesisPlan prunes dropped segments, keeps a same-plan merge lease, and applies atomically', async () => {
  const jobId = await assertPlanResaves(pgStore);
  assert.ok(await pgStore.claimSynthesisMerge(jobId, 'plan_b', { workerId: 'merge_2', leaseMs: 600000 }));
  await assert.rejects(() => pgStore.saveSynthesisPlan(jobId, {
    planId: 'plan_c',
    segments: [planSegment(0), planSegment(1, { startSequenceIndex: null })],
  }));
  assert.deepEqual((await segmentRows(jobId)).map(row => [row.plan_id, row.segment_index]), [['plan_b', 0]]);
  assert.equal((await jobRow(jobId)).synthesis_merge_worker_id, 'merge_2', 'A failed save must leave the previous plan untouched');

  const withoutTransactions = (strings, ...values) => pg.sql(strings, ...values);
  await assertPlanResaves(createPostgresJobStore({ sql: withoutTransactions }));
});

// ---- Critical #7: ensureSchema retries after a transient DDL failure ----

test('Critical #7: ensureSchema clears cached promise on rejection so a subsequent call succeeds', async () => {
  const fresh = createPgliteSql();
  let failNext = true;
  const flakySql = (strings, ...values) => {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error('Neon wake-up timeout'));
    }
    return fresh.sql(strings, ...values);
  };
  const store = createPostgresJobStore({ sql: flakySql });
  await assert.rejects(() => store.createJob({ subjectTract: 'Sec 12', contextNotes: '', totalDocuments: 1 }), /Neon wake-up timeout/);
  const job = await store.createJob({ subjectTract: 'Sec 12', contextNotes: '', totalDocuments: 1 });
  assert.equal((await store.getJob(job.id)).id, job.id);
});

// ---- Critical #8: Oversized merges reach pairwise merge tree even with SYNTHESIS_COMPACTION_ENABLED=true ----

test('Critical #8: oversized multi-segment merges bypass single-call compaction and complete via merge tree with default compaction enabled', async () => {
  const prevCompact = process.env.SYNTHESIS_COMPACTION_ENABLED;
  const prevBulk = process.env.BULK_JOB_MIN_ABSTRACTS;
  process.env.SYNTHESIS_COMPACTION_ENABLED = 'true';
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  assert.equal(
    shouldCompactBeforeMerge({ segmentCount: 6, mergeInputBytes: 1000, compactionEnabled: false }),
    false,
    'shouldCompactBeforeMerge must honor explicit compactionEnabled: false override',
  );

  // Build 4 completed segments whose combined summary text exceeds 12 MB (4 * 4 MB = 16 MB).
  const abstracts = Array.from({ length: 40 }, (_, i) => ({
    id: `abs_${i}`,
    jobId: 'job_big',
    documentId: `doc_${i}`,
    chunkId: `chk_${i}`,
    chunkOrder: i,
    originalFilename: `deed_${i + 1}.pdf`,
    abstractText: `DOC TYPE: Deed ${i + 1}\nGRANTOR: Owner ${i}\nGRANTEE: Owner ${i + 1}\n`,
  }));
  const segments = new Map();
  let planId = null;
  let savedResult = null;
  let mergeWorker = null;
  const store = {
    async getJob() { return { id: 'job_big', status: 'synthesizing', subjectTract: 'Sec 1', contextNotes: '' }; },
    async listChunks() { return abstracts.map(a => ({ id: a.chunkId, abstractionStatus: 'completed' })); },
    async listDocumentAbstracts() { return abstracts; },
    async listFailedChunks() { return []; },
    async getCurrentSynthesisPlanId() { return planId; },
    async saveSynthesisPlan(_id, plan) {
      planId = plan.planId;
      segments.clear();
      for (const s of plan.segments) {
        segments.set(`seg_${s.segmentIndex}`, { ...s, id: `seg_${s.segmentIndex}`, status: 'pending', attemptCount: 0 });
      }
      return { planId, segments: [...segments.values()] };
    },
    async listSynthesisSegments() { return [...segments.values()]; },
    async listReadySynthesisSegments() { return [...segments.values()].filter(s => s.status === 'pending'); },
    async claimSynthesisSegment(_j, segId, opts) {
      const seg = segments.get(segId);
      seg.status = 'processing';
      seg.attemptCount += 1;
      seg.workerId = opts.workerId;
      return seg;
    },
    async renewSynthesisSegmentLease(_j, segId) { return segments.get(segId); },
    async completeSynthesisSegment(_j, segId, payload) {
      const seg = segments.get(segId);
      Object.assign(seg, { status: 'complete', summaryText: payload.summaryText, modelUsed: payload.modelUsed });
      return seg;
    },
    async claimSynthesisMerge(_j, _p, opts) { mergeWorker = opts.workerId; return { workerId: mergeWorker }; },
    async getJobResult() { return savedResult; },
    async saveJobResult(_j, payload) { savedResult = payload; return payload; },
    async getSynthesisStatus() { return { total: segments.size, pending: 0, processing: 0, complete: segments.size, failed: 0, retry_wait: 0, hasResult: Boolean(savedResult), mergeInProgress: false, mergeLeaseHeld: false }; },
    async getSynthesisPreview() { return null; },
    async clearSynthesisPreview() { return true; },
  };

  let compactionCalls = 0;
  let treeMergeCalls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === COMPACTION_SYNTHESIS_PROMPT) {
      compactionCalls += 1;
      throw new Error('Compaction must not run on >12MB merge input');
    }
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      const content = typeof request.messages[0].content === 'string'
        ? request.messages[0].content
        : JSON.stringify(request.messages[0].content);
      if (/Merge these two adjacent partial chain-of-title segments/.test(content)) {
        treeMergeCalls += 1;
        return { text: 'CHAIN consolidated pair ' + treeMergeCalls + ' ' + 'x'.repeat(250), model: 'gemini-3.1-flash-lite', usage: { input_tokens: 10, output_tokens: 10 } };
      }
      // Return a 4 MB segment summary so 4+ segments exceed 12 MB total.
      return { text: 'CHAIN segment ' + 'a'.repeat(4_000_000), model: 'gemini-3.1-flash-lite', usage: { input_tokens: 10, output_tokens: 10 } };
    }
    return { text: makeGoodOpinion('Merged via tree.'), model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 10 } };
  };

  try {
    const out = await processSynthesisJob('job_big', { store, budgetMs: 30_000, config: { chunkSize: 10 } });
    assert.equal(compactionCalls, 0, `Expected 0 compaction calls for >12MB input, got ${compactionCalls}`);
    assert.ok(treeMergeCalls > 0, `Expected merge tree to run, got ${treeMergeCalls}`);
    assert.equal(out.result?.status, 'complete', `Expected complete, got ${out.result?.status}`);
    assert.ok(out.result.warnings.includes('merge_tree_applied'), `Expected merge_tree_applied warning, got ${JSON.stringify(out.result.warnings)}`);
  } finally {
    delete globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__;
    if (prevCompact === undefined) delete process.env.SYNTHESIS_COMPACTION_ENABLED;
    else process.env.SYNTHESIS_COMPACTION_ENABLED = prevCompact;
    if (prevBulk === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
    else process.env.BULK_JOB_MIN_ABSTRACTS = prevBulk;
  }
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
    console.error(err.stack || err.message || String(err));
  } finally {
    disposeAll();
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
