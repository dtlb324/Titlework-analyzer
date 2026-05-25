import jobsHandler from '../api/jobs.js';
import jobHandler from '../api/jobs/[...path].js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');
const scriptStart = indexHtml.lastIndexOf('<script>\nconst MAX_FILES');
const script = indexHtml.slice(scriptStart + 8, indexHtml.indexOf('</script>', scriptStart));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mockReq(method, body = null, headers = {}, query = {}) {
  return {
    method,
    body,
    query,
    headers: { 'x-forwarded-for': '203.0.113.25', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    url: query.id ? `/api/jobs/${query.id}` : '/api/jobs',
  };
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

function createMemoryJobStore() {
  const jobs = new Map();
  const results = new Map();
  return {
    async createJob(input) {
      const now = new Date('2026-05-22T21:49:00.000Z').toISOString();
      const job = {
        id: 'job_test_1',
        status: 'created',
        subjectTract: input.subjectTract,
        contextNotes: input.contextNotes,
        totalDocuments: input.totalDocuments,
        completedDocuments: 0,
        failedDocuments: 0,
        currentPhase: 'created',
        errorMessage: null,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null,
      };
      jobs.set(job.id, job);
      return job;
    },
    async getJob(id) {
      return jobs.get(id) || null;
    },
    async updateJob(id, patch) {
      const existing = jobs.get(id);
      if (!existing) return null;
      const updated = {
        ...existing,
        ...patch,
        updatedAt: new Date('2026-05-22T21:50:00.000Z').toISOString(),
      };
      jobs.set(id, updated);
      return updated;
    },
    async saveJobResult(id, payload) {
      const existing = jobs.get(id);
      if (!existing) return null;
      const status = payload.status || 'complete';
      const result = {
        jobId: id,
        planId: payload.planId || null,
        status,
        finalTitleOpinion: payload.finalTitleOpinion || '',
        warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
        failedDocuments: Array.isArray(payload.failedDocuments) ? payload.failedDocuments : [],
        modelUsed: payload.modelUsed || null,
        inputTokens: payload.inputTokens ?? null,
        outputTokens: payload.outputTokens ?? null,
        payloadBytes: payload.payloadBytes ?? null,
        synthesisDurationMs: payload.synthesisDurationMs ?? null,
        generatedAt: new Date('2026-05-22T21:51:00.000Z').toISOString(),
      };
      results.set(id, result);
      jobs.set(id, {
        ...existing,
        status,
        currentPhase: status === 'complete' ? 'complete' : status,
        completedAt: new Date('2026-05-22T21:51:00.000Z').toISOString(),
        updatedAt: new Date('2026-05-22T21:51:00.000Z').toISOString(),
      });
      return result;
    },
    async getJobResult(id) {
      return results.get(id) || null;
    },
  };
}

async function runClientScript(assertions) {
  const fetchCalls = [];
  const storage = new Map();
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        style: {},
        classList: { add() {}, remove() {} },
        attributes: new Map(),
        innerHTML: '',
        textContent: '',
        disabled: false,
        value: '',
        addEventListener() {},
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
        removeAttribute(name) { this.attributes.delete(name); },
        querySelectorAll() { return []; },
        focus() {},
      });
    }
    return elements.get(id);
  }

  const sandbox = {
    console: { log() {}, error() {}, warn() {}, debug() {} },
    assert,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Date,
    Math,
    JSON,
    RegExp,
    Error,
    Promise,
    Array,
    String,
    Number,
    URLSearchParams,
    encodeURIComponent,
    alert() {},
    confirm() { return true; },
    location: { search: '', hash: '' },
    document: {
      addEventListener() {},
      getElementById: element,
      querySelectorAll() { return []; },
      createElement() {
        return {
          _text: '',
          set textContent(value) {
            this._text = String(value);
            this.innerHTML = String(value);
          },
          get textContent() { return this._text; },
          innerHTML: '',
        };
      },
    },
    window: { location: { origin: 'https://example.test', pathname: '/' } },
    history: {
      replaced: '',
      replaceState(_state, _title, url) { this.replaced = url; },
    },
    sessionStorage: {
      getItem() { return ''; },
      setItem() {},
      removeItem() {},
    },
    localStorage: {
      getItem(key) { return storage.has(key) ? storage.get(key) : null; },
      setItem(key, value) { storage.set(key, String(value)); },
      removeItem(key) { storage.delete(key); },
    },
    fetch: async (url, options = {}) => {
      fetchCalls.push({ url, options });
      if (url === '/api/jobs' && options.method === 'POST') {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ job: { id: 'job_client_1', status: 'created', totalDocuments: 2 } }),
          json: async () => ({ job: { id: 'job_client_1', status: 'created', totalDocuments: 2 } }),
        };
      }
      if (url === '/api/jobs/job_client_1' && options.method === 'PATCH') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ job: { id: 'job_client_1', status: 'abstracting' } }),
          json: async () => ({ job: { id: 'job_client_1', status: 'abstracting' } }),
        };
      }
      if (url === '/api/jobs/job_client_1') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ job: { id: 'job_client_1', status: 'complete', totalDocuments: 2, completedDocuments: 2, failedDocuments: 0, currentPhase: 'done' } }),
          json: async () => ({ job: { id: 'job_client_1', status: 'complete', totalDocuments: 2, completedDocuments: 2, failedDocuments: 0, currentPhase: 'done' } }),
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ content: [{ text: 'ok' }] }),
        json: async () => ({ content: [{ text: 'ok' }] }),
      };
    },
  };
  sandbox.window.location = sandbox.location;
  return await vm.runInNewContext(`${script}\n(async () => {\n${assertions}\n})()`, sandbox);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('POST /api/jobs creates durable job metadata', async () => {
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = createMemoryJobStore();
  const req = mockReq('POST', {
    subjectTract: 'SE/4 Section 14',
    contextNotes: 'Run sheet through 1980',
    totalDocuments: 2,
  });
  const res = mockRes();

  await jobsHandler(req, res);

  assert(res.statusCode === 201, `Expected 201, got ${res.statusCode}`);
  assert(res.body.job.id === 'job_test_1', 'Expected created job id');
  assert(res.body.job.status === 'created', 'Expected created status');
  assert(res.body.job.totalDocuments === 2, 'Expected total document count');
  assert(!('documents' in res.body.job), 'Job response should not include raw documents');
});

test('GET and PATCH /api/jobs/:id fetch and update progress', async () => {
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = createMemoryJobStore();
  await jobsHandler(mockReq('POST', { totalDocuments: 3 }), mockRes());

  const patchRes = mockRes();
  await jobHandler(mockReq('PATCH', {
    status: 'abstracting',
    completedDocuments: 1,
    failedDocuments: 0,
    currentPhase: 'Abstracting batch 1 of 2',
  }, {}, { id: 'job_test_1' }), patchRes);

  assert(patchRes.statusCode === 200, `Expected 200, got ${patchRes.statusCode}`);
  assert(patchRes.body.job.status === 'abstracting', 'Expected abstracting status');
  assert(patchRes.body.job.completedDocuments === 1, 'Expected completed count update');

  const getRes = mockRes();
  await jobHandler(mockReq('GET', null, {}, { id: 'job_test_1' }), getRes);
  assert(getRes.statusCode === 200, `Expected 200, got ${getRes.statusCode}`);
  assert(getRes.body.job.currentPhase === 'Abstracting batch 1 of 2', 'Expected current phase to persist');
});

test('PATCH /api/jobs/:id renames the job for recent-job display', async () => {
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = createMemoryJobStore();
  await jobsHandler(mockReq('POST', { totalDocuments: 3, subjectTract: 'Original tract' }), mockRes());

  const patchRes = mockRes();
  await jobHandler(mockReq('PATCH', {
    subjectTract: 'Smith Ranch title run',
  }, {}, { id: 'job_test_1' }), patchRes);

  assert(patchRes.statusCode === 200, `Expected 200, got ${patchRes.statusCode}`);
  assert(patchRes.body.job.subjectTract === 'Smith Ranch title run', 'Expected renamed subject tract');

  const getRes = mockRes();
  await jobHandler(mockReq('GET', null, {}, { id: 'job_test_1' }), getRes);
  assert(getRes.body.job.subjectTract === 'Smith Ranch title run', 'Expected renamed job title to persist');
});

test('PATCH /api/jobs/:id rejects invalid status transitions', async () => {
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = createMemoryJobStore();
  await jobsHandler(mockReq('POST', { totalDocuments: 1 }), mockRes());

  const earlyCompleteRes = mockRes();
  await jobHandler(mockReq('PATCH', {
    status: 'complete',
    completedDocuments: 1,
    currentPhase: 'done',
  }, {}, { id: 'job_test_1' }), earlyCompleteRes);
  assert(earlyCompleteRes.statusCode === 409, `Expected created -> complete to be rejected, got ${earlyCompleteRes.statusCode}`);

  const abstractingRes = mockRes();
  await jobHandler(mockReq('PATCH', {
    status: 'abstracting',
    completedDocuments: 1,
    currentPhase: 'abstracting',
  }, {}, { id: 'job_test_1' }), abstractingRes);
  assert(abstractingRes.statusCode === 200, `Expected abstracting patch to pass, got ${abstractingRes.statusCode}`);

  const backwardsRes = mockRes();
  await jobHandler(mockReq('PATCH', {
    status: 'created',
    currentPhase: 'created again',
  }, {}, { id: 'job_test_1' }), backwardsRes);
  assert(backwardsRes.statusCode === 409, `Expected abstracting -> created to be rejected, got ${backwardsRes.statusCode}`);

  const synthRes = mockRes();
  await jobHandler(mockReq('PATCH', {
    status: 'synthesizing',
    completedDocuments: 1,
    currentPhase: 'synthesizing',
  }, {}, { id: 'job_test_1' }), synthRes);
  assert(synthRes.statusCode === 200, `Expected synthesizing patch to pass, got ${synthRes.statusCode}`);

  const completeRes = mockRes();
  await jobHandler(mockReq('PATCH', {
    status: 'complete',
    completedDocuments: 1,
    currentPhase: 'done',
  }, {}, { id: 'job_test_1' }), completeRes);
  assert(completeRes.statusCode === 200, `Expected complete patch to pass, got ${completeRes.statusCode}`);

  const invalidRes = mockRes();
  await jobHandler(mockReq('PATCH', {
    status: 'abstracting',
    currentPhase: 'abstracting again',
  }, {}, { id: 'job_test_1' }), invalidRes);

  assert(invalidRes.statusCode === 409, `Expected 409, got ${invalidRes.statusCode}`);
});

test('POST /api/jobs/:id/result saves browser synthesis fallback output', async () => {
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = createMemoryJobStore();
  const previousPassword = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'pw';
  try {
    await jobsHandler(mockReq('POST', { totalDocuments: 1 }, { 'x-app-password': 'pw' }), mockRes());
    await jobHandler(mockReq('PATCH', {
      status: 'abstracting',
      completedDocuments: 1,
      currentPhase: 'abstracting',
    }, { 'x-app-password': 'pw' }, { id: 'job_test_1' }), mockRes());
    await jobHandler(mockReq('PATCH', {
      status: 'synthesizing',
      completedDocuments: 1,
      currentPhase: 'synthesizing',
    }, { 'x-app-password': 'pw' }, { id: 'job_test_1' }), mockRes());

    const saveRes = mockRes();
    await jobHandler(mockReq('POST', {
      status: 'complete',
      finalTitleOpinion: 'Browser synthesized title opinion',
      warnings: ['browser fallback'],
    }, { 'x-app-password': 'pw' }, { path: ['job_test_1', 'result'] }), saveRes);

    assert(saveRes.statusCode === 200, `Expected result save to succeed, got ${saveRes.statusCode}: ${JSON.stringify(saveRes.body)}`);
    assert(saveRes.body.result.finalTitleOpinion === 'Browser synthesized title opinion', 'Expected saved title opinion in response');

    const getRes = mockRes();
    await jobHandler(mockReq('GET', null, { 'x-app-password': 'pw' }, { path: ['job_test_1', 'result'] }), getRes);
    assert(getRes.statusCode === 200, `Expected result fetch to succeed, got ${getRes.statusCode}`);
    assert(getRes.body.result.finalTitleOpinion === 'Browser synthesized title opinion', 'Expected persisted browser title opinion');
  } finally {
    if (previousPassword) process.env.APP_PASSWORD = previousPassword;
    else delete process.env.APP_PASSWORD;
  }
});

test('POST /api/jobs/:id/result works without APP_PASSWORD in passwordless mode', async () => {
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = createMemoryJobStore();
  const previousPassword = process.env.APP_PASSWORD;
  delete process.env.APP_PASSWORD;
  try {
    await jobsHandler(mockReq('POST', { totalDocuments: 1 }), mockRes());
    await jobHandler(mockReq('PATCH', {
      status: 'abstracting',
      completedDocuments: 1,
      currentPhase: 'abstracting',
    }, {}, { id: 'job_test_1' }), mockRes());
    await jobHandler(mockReq('PATCH', {
      status: 'synthesizing',
      completedDocuments: 1,
      currentPhase: 'synthesizing',
    }, {}, { id: 'job_test_1' }), mockRes());

    const saveRes = mockRes();
    await jobHandler(mockReq('POST', {
      status: 'complete',
      finalTitleOpinion: 'Passwordless browser result',
    }, {}, { path: ['job_test_1', 'result'] }), saveRes);
    assert(saveRes.statusCode === 200, `Expected passwordless result save, got ${saveRes.statusCode}: ${JSON.stringify(saveRes.body)}`);

    const getRes = mockRes();
    await jobHandler(mockReq('GET', null, {}, { path: ['job_test_1', 'result'] }), getRes);
    assert(getRes.statusCode === 200, `Expected passwordless result fetch, got ${getRes.statusCode}`);
    assert(getRes.body.result.finalTitleOpinion === 'Passwordless browser result', 'Expected persisted passwordless browser result');
  } finally {
    if (previousPassword) process.env.APP_PASSWORD = previousPassword;
    else delete process.env.APP_PASSWORD;
  }
});

test('frontend creates jobs, patches progress, and polls status', async () => {
  await runClientScript(`
    const job = await createAnalysisJob({
      subjectTract: 'SE/4',
      contextNotes: 'notes',
      totalDocuments: 2
    });
    assert(job.id === 'job_client_1', 'Expected created client job id');
    await patchAnalysisJob(job.id, {
      status: 'abstracting',
      completedDocuments: 1,
      failedDocuments: 0,
      currentPhase: 'Abstracted 1 of 2 documents'
    });
    const polled = await pollAnalysisJobOnce(job.id);
    assert(polled.status === 'complete', 'Expected polling to fetch latest job status');
  `);
});

test('frontend migrates ?job= links before defaulting to home', async () => {
  await runClientScript(`
    location.search = '?job=job_legacy_1';
    location.hash = '';
    const route = parseRoute();
    assert(route.name === 'job' && route.jobId === 'job_legacy_1', 'Expected ?job= link to route to the job view');
    assert(history.replaced.endsWith('#/job/job_legacy_1'), 'Expected legacy URL to be replaced with hash job route');
  `);
});

test('frontend renders retry controls from numeric failedDocuments', async () => {
  await runClientScript(`
    renderJobActions({ id: 'job_failed_1', status: 'failed', failedDocuments: 2 });
    assert(document.getElementById('jobActions').innerHTML.includes('Retry 2 failed'), 'Expected retry control for numeric failed document count');
    renderJobDetail({ id: 'job_failed_1', status: 'failed', failedDocuments: 2 });
    assert(document.getElementById('jobDetail').innerHTML.includes('2 documents failed'), 'Expected failed document summary for numeric count');
  `);
});

test('frontend reloads after job action when active poller is canceled', async () => {
  await runClientScript(`
    let loadCalled = false;
    loadJobView = async function(jobId) {
      loadCalled = jobId === 'job_action_1';
    };
    activeJobPollState = { jobId: 'job_action_1', cancelled: true, timer: null };
    fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ job: { id: 'job_action_1', status: 'abstracting' } }),
    });
    await runJobAction({ id: 'job_action_1' }, '/retry-failed');
    assert(loadCalled, 'Expected action completion to reload when active poller is canceled');
  `);
});

test('frontend applies hidden-tab multiplier to error retry backoff', async () => {
  await runClientScript(`
    let scheduledDelay = 0;
    setTimeout = function(_fn, delay) {
      scheduledDelay = delay;
      return 1;
    };
    clearTimeout = function() {};
    document.hidden = true;
    fetch = async () => ({
      ok: false,
      status: 503,
      json: async () => ({ error: 'busy' }),
    });
    await runJobPollTick({
      jobId: 'job_poll_1',
      timer: null,
      cancelled: false,
      consecutiveUnchanged: 0,
      lastKey: '',
      lastChangeAt: Date.now(),
      errorBackoffMs: 0,
    });
    assert(scheduledDelay === JOB_POLL_INTERVALS.backoffMin * 2 * JOB_POLL_INTERVALS.hiddenMultiplier,
      'Expected 503 retry delay to include hidden-tab multiplier');
  `);
});

test('frontend guards authenticated initial job route until password succeeds', async () => {
  await runClientScript(`
    assert(typeof checkPasswordRequired === 'function', 'Expected password gate helper');
    assert(scriptIncludesInitialRouteGuard(), 'Expected initial route guard after password gate');

    function scriptIncludesInitialRouteGuard() {
      return ${JSON.stringify(script)}.includes('const canLoadInitialRoute = await checkPasswordRequired()')
        && ${JSON.stringify(script)}.includes('if (canLoadInitialRoute) applyRoute(parseRoute())')
        && ${JSON.stringify(script)}.includes('showMain();\\n      applyRoute(parseRoute());');
    }
  `);
});

test('frontend saves browser synthesis fallback before terminal status', async () => {
  await runClientScript(`
    const source = ${JSON.stringify(script)};
    assert(source.includes('async function saveBrowserJobResult'), 'Missing browser result persistence helper');
    assert(source.includes('await saveBrowserJobResult(job.id'), 'Browser synthesis fallback must save /result before marking complete');
  `);
});

test('Bug fix: server synthesis progress caps completedDocuments at files.length after splits', async () => {
  await runClientScript(`
    const source = ${JSON.stringify(script)};
    // When PDF splits occur the abstract count exceeds the original file count.
    // The PATCH validator rejects completedDocuments > totalDocuments, so the
    // browser must cap the value.
    assert(
      source.includes('Math.min(documentAbstracts.length, files.length)'),
      'completedDocuments patch must be capped at files.length to avoid exceeding totalDocuments after server-side PDF splits'
    );
  `);
});

test('frontend job-view follow-up falls back to browser synthesis on 503', async () => {
  await runClientScript(`
    const source = ${JSON.stringify(script)};
    assert(source.includes('Server follow-up unavailable') && source.includes('buildFollowupMessages(q, result.finalTitleOpinion'),
      'Job result follow-up should use browser fallback when /followup returns 503');
  `);
});

test('frontend job route ignores stale async job responses', async () => {
  await runClientScript(`
    const source = ${JSON.stringify(script)};
    assert(source.includes('jobViewLoadSeq') && source.includes('isCurrentJobRoute(jobId)'),
      'loadJobView must guard async fetch/result responses against stale route changes');
  `);
});

test('frontend disables recent jobs toolbar until a completed local job exists', async () => {
  await runClientScript(`
    const button = document.getElementById('recentJobsButton');
    const hint = document.getElementById('recentJobsToolbarHint');

    renderRecentJobsToolbar();
    assert(button.getAttribute('aria-disabled') === 'true', 'Expected recent jobs toolbar button disabled before completed jobs');
    assert(button.getAttribute('href') === null, 'Disabled recent jobs toolbar button should not link to history');
    assert(hint.textContent.includes('available after'), 'Expected disabled toolbar to explain when it unlocks');

    localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify([
      { id: 'job_failed_1', status: 'failed', lastViewedAt: Date.now(), documentCount: 1 }
    ]));
    renderRecentJobsToolbar();
    assert(button.getAttribute('aria-disabled') === 'true', 'Failed jobs should not unlock recent jobs toolbar');

    localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify([
      { id: 'job_complete_1', status: 'complete', lastViewedAt: Date.now(), documentCount: 2 }
    ]));
    renderRecentJobsToolbar();
    assert(button.getAttribute('aria-disabled') === 'false', 'Completed job should enable recent jobs toolbar');
    assert(button.getAttribute('href') === '#/jobs', 'Enabled recent jobs toolbar button should link to history');
    assert(hint.textContent.includes('Resume'), 'Expected enabled card copy to invite resuming jobs');
  `);
});

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  } finally {
    delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
