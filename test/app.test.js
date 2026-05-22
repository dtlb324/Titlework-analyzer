import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import handler from '../api/analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');
const scriptStart = indexHtml.lastIndexOf('<script>');
const script = indexHtml.slice(scriptStart + 8, indexHtml.indexOf('</script>', scriptStart));

function mockReq(body, headers = {}) {
  return {
    method: 'POST',
    body,
    headers: { 'x-forwarded-for': '203.0.113.99', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  return res;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('index.html JavaScript parses', () => {
  const tmp = join(root, '.tmp-index-script.js');
  writeFileSync(tmp, script);
  const result = spawnSync('node', ['--check', tmp], { encoding: 'utf8' });
  unlinkSync(tmp);
  assert(result.status === 0, `Syntax error: ${result.stderr}`);
});

test('uses Sonnet 4.6 as default model', () => {
  assert(script.includes("'claude-sonnet-4-6'"), 'Expected claude-sonnet-4-6 in callBackend');
  assert(!script.includes("'claude-opus-4-7'"), 'Opus 4.7 should not be hardcoded');
});

test('supports 400-document bulk upload', () => {
  assert(script.includes('const MAX_FILES = 400'), 'MAX_FILES should be 400');
  assert(script.includes('hierarchicalSynthesis'), 'Missing hierarchical synthesis');
  assert(script.includes('SYNTHESIS_CHUNK_SIZE = 25'), 'Missing synthesis chunk size');
  assert(script.includes('throttleRequest'), 'Missing request throttling');
});

test('UI copy reflects 400-file limit', () => {
  assert(indexHtml.includes('up to 400 files'), 'Upload hint should mention 400 files');
});

test('API ping without key returns 500 (expected in CI)', async () => {
  if (process.env.ANTHROPIC_API_KEY) {
    throw new Error('SKIP');
  }
  const req = mockReq({ ping: true });
  const res = mockRes();
  await handler(req, res);
  assert(res.statusCode === 500, `Without API key ping should 500, got ${res.statusCode}`);
  assert(res.body?.error?.includes('API key'), 'Should report missing API key');
});

test('API ping with key returns ok', async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('SKIP');
  }
  const req = mockReq({ ping: true });
  const res = mockRes();
  await handler(req, res);
  assert(res.statusCode === 200, `Ping should succeed, got ${res.statusCode}`);
  assert(res.body?.ok === true, 'Ping body should be { ok: true }');
});

test('API rejects unknown model', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  const req = mockReq({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const res = mockRes();
  await handler(req, res);
  if (prev) process.env.ANTHROPIC_API_KEY = prev;
  else delete process.env.ANTHROPIC_API_KEY;
  assert(res.statusCode === 400, `Expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert(String(res.body?.error).includes('model'), 'Should reject unknown model');
});

test('API accepts claude-sonnet-4-6 model in validation', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  const req = mockReq({
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const res = mockRes();
  await handler(req, res);
  if (prev) process.env.ANTHROPIC_API_KEY = prev;
  else delete process.env.ANTHROPIC_API_KEY;
  assert(res.statusCode !== 400 || !String(res.body?.error).includes('model'), 'Sonnet 4.6 should pass model validation');
});

test('rate limit default allows bulk throughput', () => {
  const analyzeJs = readFileSync(join(root, 'api/analyze.js'), 'utf8');
  assert(analyzeJs.includes("process.env.ANALYZE_RATE_LIMIT_MAX || '200'"), 'Rate limit should default to 200');
});

let passed = 0;
let failed = 0;
let skipped = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    if (err.message === 'SKIP') {
      console.log(`○ ${name} (skipped)`);
      skipped++;
    } else {
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}`);
      failed++;
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
