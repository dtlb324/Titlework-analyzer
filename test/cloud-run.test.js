import { readFileSync } from 'fs';
import { request } from 'http';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { createServer } from '../server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requestServer(server, { method = 'GET', path = '/', body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = request({
      method,
      path,
      port: server.address().port,
      host: '127.0.0.1',
      headers: {
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ statusCode: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(fn) {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(server);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('Cloud Run server exposes health and serves the static app', async () => {
  await withServer(async server => {
    const health = await requestServer(server, { path: '/healthz' });
    assert(health.statusCode === 200, `Expected health 200, got ${health.statusCode}`);
    assert(health.json?.ok === true, 'Expected health JSON ok=true');
    assert(health.json?.service === 'title-analyzer', 'Expected service name in health response');

    const home = await requestServer(server, { path: '/' });
    assert(home.statusCode === 200, `Expected home 200, got ${home.statusCode}`);
    assert(home.headers['content-type'].includes('text/html'), 'Expected text/html response');
    assert(home.text.includes('Mineral Ownership Builder'), 'Expected static app HTML');
  });
});

test('Cloud Run server routes existing API handlers through the same /api surface', async () => {
  await withServer(async server => {
    const res = await requestServer(server, { method: 'POST', path: '/api/analyze', body: { ping: true } });
    assert(res.statusCode === 200, `Expected ping 200, got ${res.statusCode}`);
    assert(res.json?.ok === true, 'Expected analyze ping response');
  });
});

test('Cloud Run server routes durable job APIs through the same /api surface', async () => {
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = {
    async createJob(input) {
      return {
        id: 'job_cloud_run_1',
        status: 'created',
        totalDocuments: input.totalDocuments,
        subjectTract: input.subjectTract,
      };
    },
    async getJob(id) {
      if (id !== 'job_cloud_run_1') return null;
      return { id, status: 'created', totalDocuments: 1, subjectTract: 'A-123' };
    },
  };
  try {
    await withServer(async server => {
      const create = await requestServer(server, {
        method: 'POST',
        path: '/api/jobs',
        body: { totalDocuments: 1, subjectTract: 'A-123' },
      });
      assert(create.statusCode === 201, `Expected create 201, got ${create.statusCode}`);
      assert(create.json?.job?.id === 'job_cloud_run_1', 'Expected created job response');

      const detail = await requestServer(server, { path: '/api/jobs/job_cloud_run_1' });
      assert(detail.statusCode === 200, `Expected detail 200, got ${detail.statusCode}`);
      assert(detail.json?.job?.id === 'job_cloud_run_1', 'Expected routed job detail response');
    });
  } finally {
    delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
  }
});

test('Cloud Run deployment files define a production start command and container', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert(pkg.scripts?.start === 'node server.js', 'Expected npm start to launch server.js');

  const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');
  assert(dockerfile.includes('npm ci --omit=dev'), 'Expected Dockerfile to install production dependencies');
  assert(dockerfile.includes('CMD ["npm", "start"]'), 'Expected Dockerfile to use npm start');
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
