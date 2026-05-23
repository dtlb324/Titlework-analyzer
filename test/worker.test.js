import { request } from 'http';
import { createWorkerHealthServer } from '../worker.js';
import { runWorkerLoop, runWorkerOnce } from '../api/_lib/cloud-run-worker.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('Cloud Run worker processes runnable abstraction and synthesis jobs once', async () => {
  const calls = [];
  const store = {
    async listRunnableAbstractionJobIds() { return ['job_abs_1', 'job_abs_2']; },
    async listRunnableSynthesisJobIds() { return ['job_syn_1']; },
  };
  const result = await runWorkerOnce({
    store,
    processAbstraction: async jobId => {
      calls.push(`abstract:${jobId}`);
      return { hasMore: false };
    },
    processSynthesis: async jobId => {
      calls.push(`synthesis:${jobId}`);
      return { hasMore: false };
    },
  });

  assert(result.abstractionJobs === 2, `Expected 2 abstraction jobs, got ${result.abstractionJobs}`);
  assert(result.synthesisJobs === 1, `Expected 1 synthesis job, got ${result.synthesisJobs}`);
  assert(calls.join(',') === 'abstract:job_abs_1,abstract:job_abs_2,synthesis:job_syn_1', `Unexpected call order: ${calls.join(',')}`);
});

test('Cloud Run worker loop sleeps when idle and stops on abort', async () => {
  let iterations = 0;
  const controller = new AbortController();
  const result = await runWorkerLoop({
    store: {
      async listRunnableAbstractionJobIds() { return []; },
      async listRunnableSynthesisJobIds() { return []; },
    },
    signal: controller.signal,
    pollIntervalMs: 1,
    maxIdleCycles: 2,
    sleep: async () => {
      iterations += 1;
      if (iterations === 1) controller.abort();
    },
  });

  assert(result.idleCycles >= 1, 'Expected at least one idle cycle');
  assert(result.aborted === true, 'Expected loop to report abort');
});

test('Cloud Run worker loop backs off after failed work instead of hot-looping', async () => {
  let sleeps = 0;
  const result = await runWorkerLoop({
    store: {
      async listRunnableAbstractionJobIds() { return ['job_bad']; },
      async listRunnableSynthesisJobIds() { return []; },
    },
    processAbstraction: async () => {
      throw new Error('bad config');
    },
    pollIntervalMs: 1,
    maxIterations: 2,
    sleep: async () => { sleeps += 1; },
  });

  assert(result.iterations === 2, `Expected two iterations, got ${result.iterations}`);
  assert(sleeps === 2, `Expected backoff sleep after each failed work pass, got ${sleeps}`);
});

test('worker exposes an HTTP health server for Cloud Run service readiness', async () => {
  const server = createWorkerHealthServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: server.address().port, path: '/healthz' }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { text += chunk; });
        response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert(res.statusCode === 200, `Expected health 200, got ${res.statusCode}`);
    assert(res.body.ok === true, 'Expected worker health ok=true');
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('package exposes a Cloud Run worker start script', async () => {
  const pkg = await import('../package.json', { with: { type: 'json' } });
  assert(pkg.default.scripts?.['start:worker'] === 'node worker.js', 'Expected npm run start:worker to launch worker.js');
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
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
