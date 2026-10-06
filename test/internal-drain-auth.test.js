import { request } from 'http';
import { createWorkerHealthServer } from '../worker.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const ENV_KEYS = ['INTERNAL_DRAIN_TOKEN', 'NODE_ENV', 'K_SERVICE'];

function snapshotEnv() {
  const previous = {};
  for (const key of ENV_KEYS) previous[key] = process.env[key];
  return previous;
}

function restoreEnv(previous) {
  for (const key of ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}

function postDrain(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/internal/drain',
      method: 'POST',
      headers,
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withDrainServer(env, fn) {
  const previous = snapshotEnv();
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  let calls = 0;
  const server = createWorkerHealthServer({
    drain: async () => {
      calls += 1;
      return { synthesisJobs: 1, errors: [], hasWork: false };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(server.address().port, () => calls);
  } finally {
    await new Promise(resolve => server.close(resolve));
    restoreEnv(previous);
  }
}

test('POST /internal/drain rejects a missing credential when the token is set', async () => {
  await withDrainServer({
    NODE_ENV: 'production',
    INTERNAL_DRAIN_TOKEN: 'correct-drain-token',
  }, async (port, calls) => {
    const res = await postDrain(port);
    assert(res.status === 401, `Expected 401 without credential, got ${res.status}`);
    assert(res.body?.ok === false, `Expected rejection body, got ${JSON.stringify(res.body)}`);
    assert(calls() === 0, 'Drain must not run without a credential');
  });
});

test('POST /internal/drain rejects a wrong credential', async () => {
  await withDrainServer({
    NODE_ENV: 'production',
    INTERNAL_DRAIN_TOKEN: 'correct-drain-token',
  }, async (port, calls) => {
    const res = await postDrain(port, { 'x-internal-drain-token': 'wrong-drain-token' });
    assert(res.status === 401, `Expected 401 for wrong credential, got ${res.status}`);
    assert(res.body?.error === 'Unauthorized.', `Expected unauthorized error, got ${JSON.stringify(res.body)}`);
    assert(calls() === 0, 'Drain must not run with a wrong credential');
  });
});

test('POST /internal/drain accepts the correct credential', async () => {
  await withDrainServer({
    NODE_ENV: 'production',
    INTERNAL_DRAIN_TOKEN: 'correct-drain-token',
  }, async (port, calls) => {
    const res = await postDrain(port, { 'x-internal-drain-token': 'correct-drain-token' });
    assert(res.status === 200, `Expected 200 for correct credential, got ${res.status}`);
    assert(res.body?.ok === true && res.body?.synthesisJobs === 1, `Expected drain summary, got ${JSON.stringify(res.body)}`);
    assert(calls() === 1, `Expected one drain call, got ${calls()}`);
  });
});

test('POST /internal/drain fails closed in production when INTERNAL_DRAIN_TOKEN is unset', async () => {
  await withDrainServer({ NODE_ENV: 'production' }, async (port, calls) => {
    const res = await postDrain(port, { 'x-internal-drain-token': 'anything' });
    assert(res.status === 401, `Expected 401 when production token is unset, got ${res.status}`);
    assert(res.body?.error === 'INTERNAL_DRAIN_TOKEN is required.', `Expected missing-token error, got ${JSON.stringify(res.body)}`);
    assert(calls() === 0, 'Drain must not run when the production token is unset');
  });

  await withDrainServer({ K_SERVICE: 'titlework-analyzer-worker' }, async (port, calls) => {
    const res = await postDrain(port);
    assert(res.status === 401, `Expected 401 on Cloud Run without a token, got ${res.status}`);
    assert(calls() === 0, 'Drain must not run on Cloud Run without a token');
  });
});

test('POST /internal/drain stays open outside production when the token is unset', async () => {
  await withDrainServer({}, async (port, calls) => {
    const res = await postDrain(port);
    assert(res.status === 200, `Expected local drain without a token, got ${res.status}`);
    assert(res.body?.ok === true, `Expected drain summary, got ${JSON.stringify(res.body)}`);
    assert(calls() === 1, 'Local unset token should still run the drain');
  });
});

test('a configured token is required outside production too', async () => {
  await withDrainServer({ INTERNAL_DRAIN_TOKEN: 'local-token' }, async (port, calls) => {
    const missing = await postDrain(port);
    const wrong = await postDrain(port, { 'x-internal-drain-token': 'nope' });
    const ok = await postDrain(port, { 'x-internal-drain-token': 'local-token' });
    assert(missing.status === 401, `Expected 401 for missing local token, got ${missing.status}`);
    assert(wrong.status === 401, `Expected 401 for wrong local token, got ${wrong.status}`);
    assert(ok.status === 200 && ok.body?.synthesisJobs === 1, `Expected local drain with the token, got ${JSON.stringify(ok.body)}`);
    assert(calls() === 1, `Expected only the authenticated call to drain, got ${calls()}`);
  });
});

test('worker health stays unauthenticated when drain auth is required', async () => {
  await withDrainServer({
    NODE_ENV: 'production',
    INTERNAL_DRAIN_TOKEN: 'correct-drain-token',
  }, async port => {
    const health = await new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/healthz' }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end();
    });
    assert(health.status === 200 && health.body?.ok === true, `Expected open health check, got ${health.status}`);
  });
});

test('POST /internal/drain does not return internal error text', async () => {
  const previous = snapshotEnv();
  delete process.env.NODE_ENV;
  delete process.env.K_SERVICE;
  process.env.INTERNAL_DRAIN_TOKEN = 'local-token';
  const server = createWorkerHealthServer({
    drain: async () => {
      throw new Error('database password=super-secret');
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const res = await postDrain(server.address().port, { 'x-internal-drain-token': 'local-token' });
    assert(res.status === 500, `Expected 500, got ${res.status}`);
    assert(res.body?.error === 'Drain failed.', `Expected generic error, got ${JSON.stringify(res.body)}`);
    assert(!JSON.stringify(res.body).includes('super-secret'), 'Internal error text must not be returned');
  } finally {
    await new Promise(resolve => server.close(resolve));
    restoreEnv(previous);
  }
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
