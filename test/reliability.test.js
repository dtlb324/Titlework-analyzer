import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import vm from 'vm';
import handler from '../api/analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');
const readme = readFileSync(join(root, 'README.md'), 'utf8');
const scriptStart = indexHtml.lastIndexOf('<script>\nconst MAX_FILES');
const script = indexHtml.slice(scriptStart + 8, indexHtml.indexOf('</script>', scriptStart));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mockReq(body, headers = {}) {
  return {
    method: 'POST',
    body,
    headers: { 'x-forwarded-for': '198.51.100.42', ...headers },
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

function escapedHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function runClientScript(assertions) {
  const storage = new Map();
  const sandbox = {
    console: { log() {}, error() {}, warn() {}, debug() {} },
    assert,
    setTimeout,
    clearTimeout,
    Date,
    Math,
    JSON,
    RegExp,
    Error,
    Promise,
    Array,
    String,
    Number,
    document: {
      addEventListener() {},
      getElementById() {
        return {
          addEventListener() {},
          style: {},
          classList: { add() {}, remove() {} },
          innerHTML: '',
          textContent: '',
          disabled: false,
          value: '',
          focus() {},
        };
      },
      createElement() {
        return {
          _text: '',
          set textContent(value) {
            this._text = String(value);
            this.innerHTML = escapedHtml(value);
          },
          get textContent() { return this._text; },
          innerHTML: '',
        };
      },
    },
    window: {},
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
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get() { return null; } },
      text: async () => JSON.stringify({ content: [{ text: 'ok' }] }),
    }),
  };
  return await vm.runInNewContext(`${script}\n(async () => {\n${assertions}\n})()`, sandbox);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('server returns 413 for requests over the configured Cloud Run envelope', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevLimit = process.env.ANALYZE_MAX_REQUEST_BYTES;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  process.env.ANALYZE_MAX_REQUEST_BYTES = '1000';
  const req = mockReq({
    model: 'claude-haiku-4-5',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'x'.repeat(2000) }],
  });
  const res = mockRes();
  await handler(req, res);
  if (prevKey) process.env.ANTHROPIC_API_KEY = prevKey;
  else delete process.env.ANTHROPIC_API_KEY;
  if (prevLimit) process.env.ANALYZE_MAX_REQUEST_BYTES = prevLimit;
  else delete process.env.ANALYZE_MAX_REQUEST_BYTES;

  assert(res.statusCode === 413, `Expected 413, got ${res.statusCode}`);
  assert(String(res.body?.error).includes('configured'), 'Expected configured limit guidance');
});

test('server maps upstream aborts to 504 before Cloud Run request timeout', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  global.fetch = async () => {
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    throw err;
  };

  const req = mockReq({
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'hello' }],
  }, { 'x-request-id': 'test-timeout' });
  const res = mockRes();
  await handler(req, res);

  global.fetch = prevFetch;
  if (prevKey) process.env.ANTHROPIC_API_KEY = prevKey;
  else delete process.env.ANTHROPIC_API_KEY;

  assert(res.statusCode === 504, `Expected 504, got ${res.statusCode}`);
  assert(res.headers['X-Request-Id'] === 'test-timeout', 'Expected request id header');
});

test('client keeps a safe request envelope below the Cloud Run proxy limit', async () => {
  await runClientScript(`
    assert(CLOUD_RUN_MAX_REQUEST_BYTES >= 20_000_000, 'Cloud Run request ceiling should be above the old Vercel limit');
    assert(REQUEST_ENVELOPE_SAFE_BYTES <= CLOUD_RUN_MAX_REQUEST_BYTES, 'Envelope safety budget should stay below Cloud Run max request bytes');
    assert(MAX_PAYLOAD_BYTES < REQUEST_ENVELOPE_SAFE_BYTES, 'File payload budget should reserve request overhead');
    assert(CLOUD_RUN_REQUEST_TIMEOUT_MS >= 240_000, 'Client timeout budget should reflect longer Cloud Run requests');
  `);
});

test('client splits abstraction batches after synthetic 413 errors', async () => {
  await runClientScript(`
    let combinedAttempts = 0;
    let singleAttempts = 0;
    callBackend = async function(messages) {
      const docBlocks = messages[0].content.filter(block => block.type === 'document').length;
      if (docBlocks === 2) {
        combinedAttempts++;
        throw new Error('File too large (HTTP 413): synthetic test');
      }
      singleAttempts++;
      const prompt = messages[0].content.find(block => block.type === 'text').text;
      const docNum = Number(prompt.match(/DOCUMENT #(\\d+)/)[1]);
      return 'DOCUMENT #' + docNum + ':\\nAbstract OK';
    };
    const result = await abstractBatch([
      { name: 'a.pdf', type: 'application/pdf', size: 100, data: 'aaa' },
      { name: 'b.pdf', type: 'application/pdf', size: 100, data: 'bbb' },
    ], 0, true);
    assert(combinedAttempts === 1, 'Expected one combined failed attempt');
    assert(singleAttempts === 2, 'Expected two single-file retries');
    assert(result.includes('DOCUMENT #1') && result.includes('DOCUMENT #2'), 'Expected both documents in split result');
  `);
});

test('client splits abstraction batches after synthetic timeout errors', async () => {
  await runClientScript(`
    let combinedAttempts = 0;
    callBackend = async function(messages) {
      const docBlocks = messages[0].content.filter(block => block.type === 'document').length;
      if (docBlocks === 2) {
        combinedAttempts++;
        throw new Error('Timeout error (HTTP 504): synthetic test');
      }
      const prompt = messages[0].content.find(block => block.type === 'text').text;
      const docNum = Number(prompt.match(/DOCUMENT #(\\d+)/)[1]);
      return 'DOCUMENT #' + docNum + ':\\nAbstract OK';
    };
    const result = await abstractBatch([
      { name: 'timeout-a.pdf', type: 'application/pdf', size: 100, data: 'aaa' },
      { name: 'timeout-b.pdf', type: 'application/pdf', size: 100, data: 'bbb' },
    ], 0, true);
    assert(combinedAttempts === 1, 'Expected one timed-out combined attempt');
    assert(result.includes('DOCUMENT #1') && result.includes('DOCUMENT #2'), 'Expected timeout split result');
  `);
});

test('single PDF timeout fallback uses finer PDF chunks', async () => {
  await runClientScript(`
    let observedChunkRaw = 0;
    splitPdfIntoEntries = async function(source, slotsAvailable, maxChunkRaw) {
      observedChunkRaw = maxChunkRaw;
      return [
        { name: 'large (pp 1-2).pdf', type: 'application/pdf', size: 100, data: 'aaa', pageRange: [1, 2] },
        { name: 'large (pp 3-4).pdf', type: 'application/pdf', size: 100, data: 'bbb', pageRange: [3, 4] },
      ];
    };
    callBackend = async function(messages) {
      const prompt = messages[0].content.find(block => block.type === 'text').text;
      const docNum = Number(prompt.match(/DOCUMENT #(\\d+)/)[1]);
      return 'DOCUMENT #' + docNum + ':\\nPart abstract';
    };
    const result = await abstractSinglePdfOnTimeout({
      name: 'large.pdf',
      type: 'application/pdf',
      size: 2_000_000,
      data: 'base64',
      sourceFile: { name: 'large.pdf', type: 'application/pdf', size: 2_000_000 },
    }, 0);
    assert(observedChunkRaw === TIMEOUT_SPLIT_CHUNK_RAW, 'Expected timeout fallback chunk size');
    assert(observedChunkRaw <= 400_000, 'Timeout fallback should split finer than upload chunks');
    assert(result.includes('pp 1-2') && result.includes('pp 3-4'), 'Expected page ranges in merged timeout result');
  `);
});

test('large PDF ingest keeps durable uploads whole with page range metadata', async () => {
  await runClientScript(`
    let splitCalled = false;
    splitPdfIntoEntries = async function() {
      splitCalled = true;
      return [
        { name: 'large (pp 1-2).pdf', type: 'application/pdf', size: 100, data: 'aaa', pageRange: [1, 2] },
        { name: 'large (pp 3-4).pdf', type: 'application/pdf', size: 100, data: 'bbb', pageRange: [3, 4] },
      ];
    };
    readFileAsBase64 = async function() { return 'base64'; };
    PDFLib = {
      PDFDocument: {
        load: async function() {
          return { getPageCount: function() { return 7; } };
        },
      },
    };
    window.PDFLib = PDFLib;
    const file = {
      name: 'large.pdf',
      type: 'application/pdf',
      size: 2_000_000,
      arrayBuffer: async function() { return new ArrayBuffer(8); },
    };
    const entries = await prepareFileEntries(file, 400);
    assert(splitCalled === false, 'Expected large PDF ingest not to call page splitting');
    assert(entries.length === 1, 'Expected one whole-PDF entry');
    assert(entries[0].name === 'large.pdf', 'Expected original PDF filename preserved');
    assert(entries[0].pageRange[0] === 1 && entries[0].pageRange[1] === 7, 'Expected whole-PDF page range metadata');
    assert(entries[0].splitFrom === null || entries[0].splitFrom === undefined, 'Whole PDF should not be marked as split');
  `);
});

test('browser fallback splits a single PDF that exceeds the request envelope', async () => {
  await runClientScript(`
    let splitCalled = false;
    splitPdfIntoEntries = async function(source, slotsAvailable, maxChunkRaw) {
      splitCalled = true;
      return [
        { name: 'huge (pp 1-2).pdf', type: 'application/pdf', size: 100, data: 'aaa', pageRange: [1, 2] },
        { name: 'huge (pp 3-4).pdf', type: 'application/pdf', size: 100, data: 'bbb', pageRange: [3, 4] },
      ];
    };
    callBackend = async function(messages) {
      const prompt = messages[0].content.find(block => block.type === 'text').text;
      const docNum = Number(prompt.match(/DOCUMENT #(\\d+)/)[1]);
      return 'DOCUMENT #' + docNum + ':\\nPart abstract';
    };
    const result = await abstractBatch([{
      name: 'huge.pdf',
      type: 'application/pdf',
      size: 9_000_000,
      data: 'x'.repeat(13_000_000),
      sourceFile: { name: 'huge.pdf', type: 'application/pdf', size: 9_000_000 },
    }], 0, true);
    assert(splitCalled, 'Expected oversized single PDF to use page-split fallback');
    assert(result.includes('pp 1-2') && result.includes('pp 3-4'), 'Expected split page ranges in fallback result');
  `);
});

test('synthesis recursively splits oversized request envelopes', async () => {
  await runClientScript(`
    let synthesisCalls = 0;
    callBackend = async function(messages) {
      synthesisCalls++;
      return 'summary ' + synthesisCalls;
    };
    const abstracts = Array.from({ length: 6 }, (_, i) => ({
      filename: 'doc-' + (i + 1) + '.pdf',
      abstract: 'x'.repeat(3_000_000),
    }));
    const result = await synthesizeAbstracts(
      abstracts,
      '',
      '',
      'Oversized synthesis regression test.',
      SYNTHESIS_PROMPT
    );
    assert(synthesisCalls > 1, 'Expected oversized synthesis to split into multiple calls');
    assert(result.includes('summary'), 'Expected merged synthesis output');
  `);
});

test('timeout classifier catches platform and Anthropic timeout shapes', async () => {
  await runClientScript(`
    assert(isTimeoutError(new Error('Cloud Run request timeout')), 'Expected Cloud Run timeout match');
    assert(isTimeoutError(new Error('Timeout error (HTTP 504)')), 'Expected HTTP 504 match');
    assert(isTimeoutError(new Error('The operation was aborted after upstream timeout')), 'Expected abort timeout match');
  `);
});

test('follow-up context uses latest title opinion and excludes analysis payloads', async () => {
  await runClientScript(`
    conversationHistory = [
      { role: 'user', content: 'old raw synthesis input', displayText: 'Analyzed 2 document(s)', kind: 'analysis-input' },
      { role: 'assistant', content: 'OLD TITLE OPINION', kind: 'title-opinion' },
      { role: 'user', content: 'new raw synthesis input that should be excluded', displayText: 'Added 1 more document', kind: 'analysis-input' },
      { role: 'assistant', content: 'NEW TITLE OPINION', kind: 'title-opinion' },
      { role: 'user', content: 'prior follow-up', kind: 'followup' },
      { role: 'assistant', content: 'prior answer', kind: 'followup' },
      { role: 'user', content: 'current question', kind: 'followup' },
    ];
    const messages = buildFollowupMessages('current question');
    const body = messages[0].content;
    assert(body.includes('NEW TITLE OPINION'), 'Expected latest title opinion');
    assert(!body.includes('OLD TITLE OPINION'), 'Should not use stale title opinion');
    assert(!body.includes('new raw synthesis input'), 'Should exclude bulky analysis payloads');
  `);
});

test('follow-up fallback trims until the request is inside the safe envelope', async () => {
  await runClientScript(`
    conversationHistory = [
      { role: 'user', content: 'raw synthesis input', displayText: 'Analyzed 1 document', kind: 'analysis-input' },
      { role: 'assistant', content: 'x'.repeat(5_000_000), kind: 'title-opinion' },
      { role: 'user', content: 'current question', kind: 'followup' },
    ];
    const messages = buildFollowupMessages('current question');
    const bytes = estimateRequestBytes(SYNTHESIS_MODEL, SYNTHESIS_MAX_TOKENS, SYNTHESIS_PROMPT, messages);
    assert(bytes <= REQUEST_ENVELOPE_SAFE_BYTES, 'Expected trimmed follow-up to fit safe envelope');
  `);
});

test('checkpoint signatures include content fingerprints', async () => {
  await runClientScript(`
    const first = getFileSignature([{ name: 'same.pdf', type: 'application/pdf', size: 100, data: 'aaa' }], 0, 'initial');
    const second = getFileSignature([{ name: 'same.pdf', type: 'application/pdf', size: 100, data: 'bbb' }], 0, 'initial');
    assert(first !== second, 'Expected same-name and same-size files with different data to get different checkpoint keys');
  `);
});

test('README bulk-processing constants match code', async () => {
  await runClientScript(`
    assert(MAX_DOCS_PER_BATCH === 8, 'Expected browser fallback max docs per batch to be 8');
    assert(maxDocsForPayload(700_000) === 8, 'Expected mid-sized fallback payloads to batch under Cloud Run limits');
    assert(maxDocsForPayload(900_000) === 1, 'Expected larger fallback payloads to stay isolated');
    const fallbackBatches = buildAdaptiveBatches(Array.from({ length: 10 }, (_, i) => ({
      name: 'small-' + i + '.pdf',
      type: 'application/pdf',
      size: 100_000,
      data: 'x'.repeat(100_000),
    })));
    assert(fallbackBatches.length === 2, 'Expected 10 small fallback docs to fit into 2 batches');
    assert(fallbackBatches[0].files.length === 8, 'Expected first fallback batch to carry 8 small docs');
    assert(MAX_PAYLOAD_BYTES > 10_000_000, 'Expected payload cap to reflect Cloud Run envelope budget');
  `);
  assert(readme.includes('up to 8 small documents per browser fallback call'), 'README should document current fallback batch size');
  assert(!readme.includes('up to 2 documents per call'), 'README should not advertise stale 2-document fallback batching');
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
