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
  };
}

async function runClientScript(assertions) {
  const fetchCalls = [];
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        style: {},
        classList: { add() {}, remove() {} },
        innerHTML: '',
        textContent: '',
        disabled: false,
        value: '',
        addEventListener() {},
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
    location: { search: '', hash: '' },
    document: {
      addEventListener() {},
      getElementById: element,
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
    sessionStorage: {
      getItem() { return ''; },
      setItem() {},
      removeItem() {},
    },
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
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
