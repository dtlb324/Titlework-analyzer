import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import handler from '../api/analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');
const scriptStart = indexHtml.lastIndexOf('<script>\nconst MAX_FILES');
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

test('uses Haiku for abstraction and Sonnet for synthesis', () => {
  assert(script.includes("ABSTRACT_MODEL = 'claude-haiku-4-5'"), 'Expected Haiku for abstraction');
  assert(script.includes("SYNTHESIS_MODEL = 'claude-sonnet-4-6'"), 'Expected Sonnet for synthesis');
  assert(!script.includes("'claude-opus-4-7'"), 'Opus 4.7 should not be hardcoded');
});

test('uses adaptive batching and parallel abstraction', () => {
  assert(script.includes('buildAdaptiveBatches'), 'Missing adaptive batching');
  assert(script.includes('runDocumentAbstraction'), 'Missing shared abstraction runner');
  assert(script.includes('ABSTRACT_CONCURRENCY = 2'), 'Missing parallel pool');
  assert(script.includes('MAX_DOCS_PER_BATCH = 2'), 'Max docs per batch should be 2 for timeout safety');
  assert(script.includes('isTimeoutError'), 'Missing timeout error detection');
  assert(script.includes('abstractSinglePdfOnTimeout'), 'Missing timeout PDF split retry');
  assert(script.includes('batchExceedsTimeoutLimit'), 'Missing proactive timeout batch check');
  assert(script.includes('finalizeBatchesForTimeout'), 'Missing timeout batch finalizer');
  assert(script.includes('VERCEL_FUNCTION_TIMEOUT_MS = 45_000'), 'Vercel timeout budget should leave platform margin');
  assert(script.includes('REQUEST_ENVELOPE_SAFE_BYTES = 3_900_000'), 'Missing safe request envelope budget');
  assert(script.includes('VERCEL_MAX_REQUEST_BYTES'), 'Missing Vercel payload guard');
  assert(script.includes('buildAbstractMessages'), 'Missing abstract message builder');
  assert(!script.includes('BATCH_SIZE'), 'Fixed BATCH_SIZE should be removed');
});

test('supports 400-document bulk upload', () => {
  assert(script.includes('const MAX_FILES = 400'), 'MAX_FILES should be 400');
  assert(script.includes('hierarchicalSynthesis'), 'Missing hierarchical synthesis');
  assert(script.includes('SYNTHESIS_CHUNK_SIZE = 50'), 'Synthesis chunk size should be 50');
  assert(script.includes('acquireRequestSlot'), 'Missing request throttling');
});

test('UI copy reflects 400-file limit', () => {
  assert(indexHtml.includes('up to 400 files'), 'Upload hint should mention 400 files');
});

test('API ping works without API key (health check)', async () => {
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

test('API accepts claude-haiku-4-5 and claude-sonnet-4-6', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  const prevFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  global.fetch = async () => ({
    status: 200,
    json: async () => ({ content: [{ text: 'ok' }], model: 'test-model', stop_reason: 'end_turn', usage: {} }),
  });
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-6']) {
    const req = mockReq({ model, messages: [{ role: 'user', content: 'hello' }] });
    const res = mockRes();
    await handler(req, res);
    assert(res.statusCode !== 400 || !String(res.body?.error).includes('model'), `${model} should pass model validation`);
  }
  global.fetch = prevFetch;
  if (prev) process.env.ANTHROPIC_API_KEY = prev;
  else delete process.env.ANTHROPIC_API_KEY;
});

test('rate limit default allows bulk throughput', () => {
  const analyzeJs = readFileSync(join(root, 'api/analyze.js'), 'utf8');
  assert(analyzeJs.includes("process.env.ANALYZE_RATE_LIMIT_MAX || '300'"), 'Rate limit should default to 300');
});


test('auto-splits large PDFs client-side', () => {
  assert(script.includes('splitPdfIntoEntries'), 'Missing PDF split helper');
  assert(script.includes('PDF_SPLIT_RAW_THRESHOLD'), 'Missing PDF split threshold');
  assert(indexHtml.includes('pdf-lib'), 'Missing pdf-lib script');
  assert(script.includes('ingestUploadedFiles'), 'Missing shared upload ingest helper');
});


test('shows estimated processing time during runs', () => {
  assert(indexHtml.includes('id="progressEta"'), 'Missing progress ETA element');
  assert(script.includes('createProgressTimer'), 'Missing progress timer');
  assert(script.includes('formatDurationPrecise'), 'Missing precise duration formatter');
  assert(script.includes('buildProcessingPlan'), 'Missing processing plan builder');
  assert(script.includes('formatInitialEstimate'), 'Missing initial estimate formatter');
  assert(script.includes('formatEtaRemaining'), 'Missing ETA formatter');
});


test('proactively splits batches before timeout', () => {
  assert(script.includes('VERCEL_FUNCTION_TIMEOUT_MS = 45_000'), 'Missing safer Vercel timeout budget');
  assert(script.includes('batchExceedsTimeoutLimit'), 'Missing proactive timeout batch check');
  assert(script.includes('finalizeBatchesForTimeout'), 'Missing timeout batch finalizer');
  assert(script.includes('abstractSinglePdfOnTimeout'), 'Missing single-PDF timeout split');
});

test('preserves PDF data for retries via sourceFile', () => {
  assert(script.includes('sourceFile: file'), 'Should retain original File object on upload');
  assert(script.includes('async function ensureFileData'), 'Should re-read file data before API calls');
  assert(script.includes('async function readSourceFile'), 'Should have readSourceFile helper');
  assert(!script.includes('batchFiles.forEach(freeFileMemory)'), 'Should not free memory after each batch');
  assert(script.includes('files.forEach(freeFileMemory)'), 'Should free memory only after successful run');
});

test('registers job-linked durable uploads before browser-driven analysis', () => {
  assert(script.includes('async function getDurableStorageStatus'), 'Missing durable storage availability check');
  assert(script.includes('async function registerJobUploads'), 'Missing job-linked upload registration helper');
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}/documents'), 'Missing document registration endpoint call');
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}/documents/${encodeURIComponent(documentId)}/chunks'), 'Missing chunk registration endpoint call');
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}/chunks/${encodeURIComponent(chunkId)}'), 'Missing chunk upload status patch endpoint call');
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}/finalize-uploads'), 'Missing finalize uploads endpoint call');
  assert(script.includes("handleUploadUrl: '/api/blob/upload'"), 'Missing direct browser-to-Blob upload configuration');
  assert(script.includes('headers: getJobHeaders()'), 'Blob client upload token request should include app auth headers');
  assert(script.includes('Durable file resume unavailable'), 'Missing graceful fallback warning copy');
});


// === Phase 6 ===

test('Phase 6: HTML defines view-home, view-job, view-history shells', () => {
  assert(indexHtml.includes('id="view-home"'), 'Missing #view-home wrapper');
  assert(indexHtml.includes('id="view-job"'), 'Missing #view-job wrapper');
  assert(indexHtml.includes('id="view-history"'), 'Missing #view-history wrapper');
});

test('Phase 6: hash router exposes parseHash and navigate', () => {
  assert(script.includes('function parseRoute'), 'Missing parseRoute() helper');
  assert(script.includes('function applyRoute'), 'Missing applyRoute() helper');
  assert(script.includes("window.addEventListener('hashchange'"), 'Router must listen for hashchange');
  assert(script.includes("'#/job/'") || script.includes('`#/job/'), 'Router must emit #/job/ links');
});

test('Phase 6: getJobLink emits hash route, getRequestedJobId reads it', () => {
  assert(script.includes('`${window.location.origin}${window.location.pathname}#/job/'),
    'getJobLink must emit hash route');
  assert(script.includes("hash.startsWith('#/job/')") || script.includes("startsWith('/job/')"),
    'getRequestedJobId must parse #/job/{id}');
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
