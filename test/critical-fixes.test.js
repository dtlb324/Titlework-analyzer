import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
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
import jobPathHandler from '../api/jobs/[...path].js';
import { disposeAll, jsonResponse, loadIndex, makeJobServer, pngFile, StubElement, tick } from './helpers/browser-index-harness.js';

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

// ---- Critical #4: listRunnableSynthesisJobIds admits jobs with failed segments ----

test('Critical #4: listRunnableSynthesisJobIds SQL checks active statuses instead of <> complete', async () => {
  const captured = [];
  const sql = async (strings, ...values) => {
    captured.push(strings.join('?'));
    return [{ id: 'job_degraded' }];
  };
  const listRunnableSynthesisJobIds = extractJobsMethod('listRunnableSynthesisJobIds', {
    ensureSchema: async () => {},
    sql,
  });
  const ids = await listRunnableSynthesisJobIds(10);
  assert.deepEqual(ids, ['job_degraded']);
  assert.ok(
    captured[0].includes("pending.status IN ('pending', 'processing', 'retry_wait')"),
    `Expected listRunnableSynthesisJobIds to check IN ('pending', 'processing', 'retry_wait'), got:\n${captured[0]}`,
  );
  assert.equal(
    captured[0].includes("pending.status <> 'complete'"),
    false,
    'listRunnableSynthesisJobIds must not exclude jobs with failed segments via <> complete',
  );
});

// ---- Critical #5: cancelJob cancels synthesis_segments; claim/renew reject canceled jobs; hasMore=false on canceled ----

test('Critical #5: cancelJob cancels synthesis_segments, claim/renew check job status <> canceled, and synthesis status hasMore is false when canceled', async () => {
  const queries = [];
  const sql = async (strings, ...values) => {
    queries.push({ text: strings.join('?'), values });
    return [{ id: 'job_c1', status: 'canceled' }];
  };
  const cancelJob = extractJobsMethod('cancelJob', {
    ensureSchema: async () => {},
    sql,
    rowToJob: row => row,
    refreshAbstractionCounts: async () => {},
  });
  await cancelJob.call({ clearSynthesisPreview: async () => {} }, 'job_c1', 'User stopped job.');
  const segCancelQuery = queries.find(q => q.text.includes('UPDATE synthesis_segments'));
  assert.ok(segCancelQuery, 'cancelJob must UPDATE synthesis_segments');
  assert.ok(segCancelQuery.text.includes("status = 'failed'"), 'cancelJob must fail active synthesis segments');
  assert.ok(segCancelQuery.text.includes("error_type = 'canceled'"), 'cancelJob must record canceled error_type');
  assert.ok(segCancelQuery.text.includes('worker_id = NULL'), 'cancelJob must release segment worker_id');

  const claimQueries = [];
  const claimSql = async (strings) => { claimQueries.push(strings.join('?')); return []; };
  const claimSynthesisSegment = extractJobsMethod('claimSynthesisSegment', {
    ensureSchema: async () => {},
    sql: claimSql,
    rowToSynthesisSegment: row => row || null,
  });
  const renewSynthesisSegmentLease = extractJobsMethod('renewSynthesisSegmentLease', {
    ensureSchema: async () => {},
    sql: claimSql,
    rowToSynthesisSegment: row => row || null,
  });
  await claimSynthesisSegment('job_c1', 'seg_1', { workerId: 'wkr_1' });
  await renewSynthesisSegmentLease('job_c1', 'seg_1', { workerId: 'wkr_1' });
  assert.ok(claimQueries[0].includes("j.status <> 'canceled'"), 'claimSynthesisSegment must reject canceled jobs');
  assert.ok(claimQueries[1].includes("j.status <> 'canceled'"), 'renewSynthesisSegmentLease must reject canceled jobs');

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

// ---- Critical #6: saveSynthesisPlan is atomic via sql.transaction, prunes orphans, and preserves same-plan merge lease ----

test('Critical #6: saveSynthesisPlan runs atomically in sql.transaction, prunes out-of-range segments, and updates analysis_jobs last with IS DISTINCT FROM', async () => {
  const txnQueries = [];
  const sql = async () => { throw new Error('should use sql.transaction when available'); };
  sql.transaction = async fn => {
    const txn = (strings, ...values) => ({ text: strings.join('?'), values });
    const built = fn(txn);
    txnQueries.push(...built);
    return built.map((q, idx) => (idx >= 2 && idx < built.length - 1 ? [{ id: `seg_${idx}`, segment_index: idx - 2 }] : []));
  };
  const saveSynthesisPlan = extractJobsMethod('saveSynthesisPlan', {
    ensureSchema: async () => {},
    sql,
    JobApiError: Error,
    randomUUID: () => 'uuid1',
    rowToSynthesisSegment: row => row,
  });
  const saved = await saveSynthesisPlan.call({ getJob: async () => ({ id: 'job_1', status: 'synthesizing' }) }, 'job_1', {
    planId: 'plan_abc',
    segments: [
      { segmentIndex: 0, startSequenceIndex: 0, endSequenceIndex: 9, documentIds: ['d1'], filenames: ['a.pdf'], estimatedBytes: 100 },
      { segmentIndex: 1, startSequenceIndex: 10, endSequenceIndex: 19, documentIds: ['d2'], filenames: ['b.pdf'], estimatedBytes: 100 },
    ],
  });
  assert.equal(saved.segments.length, 2);
  assert.equal(txnQueries.length, 5, 'Expected DELETE segments, DELETE results, 2 UPSERTs, and 1 UPDATE analysis_jobs');
  assert.ok(txnQueries[0].text.includes('NOT (segment_index = ANY('), 'Must prune orphaned same-plan segment indices');
  const lastQuery = txnQueries[txnQueries.length - 1];
  assert.ok(lastQuery.text.includes('UPDATE analysis_jobs'), 'UPDATE analysis_jobs must execute LAST');
  assert.ok(lastQuery.text.includes('synthesis_plan_id IS DISTINCT FROM'), 'Must not wipe merge lease/preview when planId already matches');

  // Verify non-transaction fallback also executes UPDATE analysis_jobs LAST (never before segment inserts).
  const seqQueries = [];
  const seqSql = async (strings, ...values) => {
    const text = strings.join('?');
    seqQueries.push(text);
    if (text.includes('INSERT INTO synthesis_segments')) return [{ id: 'seg_x' }];
    return [];
  };
  const saveSeq = extractJobsMethod('saveSynthesisPlan', {
    ensureSchema: async () => {},
    sql: seqSql,
    JobApiError: Error,
    randomUUID: () => 'uuid2',
    rowToSynthesisSegment: row => row,
  });
  await saveSeq.call({ getJob: async () => ({ id: 'job_1', status: 'synthesizing' }) }, 'job_1', {
    planId: 'plan_seq',
    segments: [{ segmentIndex: 0, startSequenceIndex: 0, endSequenceIndex: 4, documentIds: ['d1'], filenames: ['a.pdf'] }],
  });
  const insertIdx = seqQueries.findIndex(q => q.includes('INSERT INTO synthesis_segments'));
  const updateJobIdx = seqQueries.findIndex(q => q.includes('UPDATE analysis_jobs'));
  assert.ok(insertIdx >= 0 && updateJobIdx > insertIdx, 'Fallback must update analysis_jobs.synthesis_plan_id AFTER inserting segments');
});

// ---- Critical #7: ensureSchema retries after a transient DDL failure ----

test('Critical #7: ensureSchema clears cached promise on rejection so a subsequent call succeeds', async () => {
  const fnStart = jobsSource.indexOf('  let initialized = null;');
  const fnEnd = jobsSource.indexOf('  async function refreshUploadCounts(', fnStart);
  assert(fnStart >= 0 && fnEnd > fnStart, 'Could not locate ensureSchema in api/_lib/jobs.js');
  let failFirst = true;
  let calls = 0;
  const sql = async () => {
    calls += 1;
    if (failFirst) {
      failFirst = false;
      throw new Error('Neon wake-up timeout');
    }
    return [];
  };
  const ensureSchema = runInNewContext(
    `${jobsSource.slice(fnStart, fnEnd)}; ensureSchema;`,
    { sql },
  );
  await assert.rejects(() => ensureSchema(), /Neon wake-up timeout/);
  const callsAfterFailure = calls;
  await ensureSchema();
  assert.ok(calls > callsAfterFailure, 'Expected ensureSchema to retry DDL after initial failure instead of returning cached rejection');
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
