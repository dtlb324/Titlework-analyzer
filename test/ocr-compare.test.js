import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from '../server.js';
import { createOcrCompareHandler } from '../api/ocr-compare.js';
import { spawnSync } from 'node:child_process';

process.env.NODE_ENV = 'test';
delete process.env.K_SERVICE;
delete process.env.DATABASE_URL;
process.env.APP_PASSWORD = 'ocr-test-password';
process.env.OCR_COMPARE_ENABLED = 'true';

async function withServer(fn, options = {}) {
  const server = createServer(options);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function request(base, options = {}) {
  return fetch(`${base}/api/ocr-compare`, {
    headers: { 'x-app-password': 'ocr-test-password', 'content-type': 'application/json' },
    ...options,
  });
}

test('OCR lab metadata reports current Gemini, 3.8 and Haiku 5.5 without starting model calls', async () => {
  await withServer(async base => {
    const response = await request(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    const config = await response.json();
    assert.deepEqual(config.models.map(model => model.id), ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'claude-haiku-5-5']);
    assert.equal(config.models[1].thinkingLevel, 'low');
    assert.equal(config.models[2].label, 'Claude Haiku 5.5');
    assert.equal(config.models[2].maxTokens, config.models[0].maxTokens);
    assert.equal(config.maxPages, 10);
    assert.equal(config.maxBytes, 12_000_000);
  });
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1kAAAAASUVORK5CYII=';
const document = { filename: 'deed.png', pages: [{ mediaType: 'image/png', data: PNG }] };

test('PDF renderer serves allowlisted local modules and image decoders, not arbitrary package files', async () => {
  await withServer(async base => {
    for (const name of ['pdf.mjs', 'pdf.worker.mjs']) {
      const response = await fetch(`${base}/vendor/pdfjs/${name}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /javascript/);
      assert.match(await response.text(), /pdfjs/);
    }
    const wasm = await fetch(`${base}/vendor/pdfjs/wasm/jbig2.wasm`);
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    const bytes = new Uint8Array(await wasm.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 4)], [0, 97, 115, 109]);
    const denied = await fetch(`${base}/vendor/pdfjs/package.json`);
    assert.equal(denied.status, 404);
  });
});

test('one upload starts all models concurrently with identical visual input and production prompt', async () => {
  const calls = [];
  const releases = [];
  await withServer(async base => {
    const pending = request(base, { method: 'POST', body: JSON.stringify(document) });
    for (let i = 0; i < 50 && calls.length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    try {
      assert.equal(calls.length, 3, 'All providers must start before any completes');
      assert.deepEqual(calls.map(call => call.model), ['gemini-3.1-flash-lite', 'gemini-3.8-flash', 'claude-haiku-5-5']);
      assert.deepEqual(calls[0].messages, calls[1].messages);
      assert.deepEqual(calls[0].messages, calls[2].messages);
      assert.equal(calls[0].system, calls[2].system);
      assert.equal(calls[2].effort, 'low');
      assert.equal(calls[2].thinkingLevel, undefined, 'Claude uses effort, not a Gemini thinking level');
      assert.equal(calls[0].system, calls[1].system);
      assert.match(calls[0].system, /expert oil and gas title attorney/);
      assert.equal(calls[0].messages[0].content[0].source.data, PNG);
      assert.equal(calls[1].thinkingLevel, 'low');
    } finally { releases.forEach(resolve => resolve()); }
    const response = await pending;
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.inputMode, 'rendered_images');
    assert.equal(report.pageCount, 1);
    assert.equal(report.models[0].fields.GRANTOR, 'Sample Owner');
    assert.equal(report.models[0].usage.thinking_tokens, 20);
    assert.equal(report.models[0].costUsd, (100 * 0.25 + 70 * 1.5) / 1_000_000);
    assert.equal(report.models.length, 3);
    assert.equal(report.models[2].costUsd, (100 * 0.1 + 50 * 0.5) / 1_000_000, 'Haiku output_tokens already include thinking');
    assert.equal(report.models[2].costRates.source, 'https://platform.claude.com/docs/en/about-claude/pricing');
    assert.ok(report.models.every(model => Number.isFinite(model.latencyMs)));
    assert.ok(!JSON.stringify(report).includes(PNG), 'Report must not retain uploaded bytes');
  }, { ocrCompareModelClient: async call => {
    calls.push(call);
    await new Promise(resolve => releases.push(resolve));
    return { text: 'GRANTOR: Sample Owner\nGRANTEE: Test Buyer', usage: call.model.startsWith('claude-') ? { input_tokens: 100, output_tokens: 50 } : { input_tokens: 100, output_tokens: 50, thinking_tokens: 20 }, stopReason: 'STOP', model: `${call.model}-version` };
  } });
});

test('disabled lab and unauthorized requests never call providers', async () => {
  let calls = 0;
  await withServer(async base => {
    process.env.OCR_COMPARE_ENABLED = 'false';
    try { assert.equal((await request(base, { method: 'POST', body: JSON.stringify(document) })).status, 404); }
    finally { process.env.OCR_COMPARE_ENABLED = 'true'; }
    const denied = await request(base, { method: 'POST', headers: { 'x-app-password': 'wrong', 'content-type': 'application/json' }, body: JSON.stringify(document) });
    assert.equal(denied.status, 401);
    assert.equal(calls, 0);
  }, { ocrCompareModelClient: async () => { calls++; return {}; } });
});

test('rendered PDF pages are all sent as images despite the original .pdf filename', async () => {
  const calls = [];
  await withServer(async base => {
    const response = await request(base, { method: 'POST', body: JSON.stringify({ filename: 'deed.pdf', pages: [document.pages[0], document.pages[0]] }) });
    assert.equal(response.status, 200);
    for (const call of calls) {
      assert.equal(call.messages[0].content.filter(block => block.type === 'image').length, 2);
      assert.ok(call.messages[0].content.every(block => block.type !== 'document'));
      assert.ok(call.messages[0].content.filter(block => block.type === 'image').every(block => block.source.media_type === 'image/png'));
    }
    assert.equal(calls.length, 3);
  }, { ocrCompareModelClient: async call => { calls.push(call); return { text: 'GRANTOR: Test' }; } });
});

test('handler itself fails closed without APP_PASSWORD even outside production', async () => {
  const handler = createOcrCompareHandler();
  const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
  delete process.env.APP_PASSWORD;
  try {
    await handler({ method: 'GET', headers: {} }, response);
    assert.equal(response.code, 503);
    assert.match(response.body.error, /APP_PASSWORD/);
  } finally { process.env.APP_PASSWORD = 'ocr-test-password'; }
});

test('a failed model is sanitized and does not discard the other output or retry', async () => {
  let calls = 0;
  await withServer(async base => {
    const response = await request(base, { method: 'POST', body: JSON.stringify(document) });
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.equal(report.models[0].text, 'GRANTOR: Verified Fixture');
    assert.match(report.models[1].error, /REDACTED/);
    assert.ok(!report.models[1].error.includes('AIzaABCDEFGHIJKLMNOPQRSTUV'));
    assert.equal(calls, 3);
    assert.equal(report.models[0].costUsd, null, 'Missing usage must not become a zero cost estimate');
    assert.equal(report.models[2].costUsd, null, 'Missing Claude usage must not become a zero cost estimate');
  }, { ocrCompareModelClient: async ({ model }) => {
    calls++;
    if (model === 'gemini-3.8-flash') throw new Error('provider error key=AIzaABCDEFGHIJKLMNOPQRSTUV');
    return { text: 'GRANTOR: Verified Fixture' };
  } });
});

test('invalid, non-image and excessive page inputs are rejected before provider calls', async () => {
  let calls = 0;
  await withServer(async base => {
    const invalid = [null, {}, { ...document, filename: '' }, { ...document, pages: [] }, { ...document, pages: Array(11).fill(document.pages[0]) }, { ...document, pages: [{ mediaType: 'application/pdf', data: PNG }] }, { ...document, pages: [{ mediaType: 'image/png', data: 'not base64' }] }, { ...document, pages: [{ mediaType: 'image/png', data: Buffer.from('plain text').toString('base64') }] }];
    for (const body of invalid) assert.equal((await request(base, { method: 'POST', body: JSON.stringify(body) })).status, 400);
    assert.equal(calls, 0);
  }, { ocrCompareModelClient: async () => { calls++; return {}; } });
});

test('overlapping requests are rejected and the slot is released after provider failure', async () => {
  const releases = [];
  let calls = 0;
  await withServer(async base => {
    const pending = request(base, { method: 'POST', body: JSON.stringify(document) });
    for (let i = 0; i < 50 && calls < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    const response = await request(base, { method: 'POST', body: JSON.stringify(document) });
    try {
      assert.equal(response.status, 429);
      assert.equal(calls, 3);
    } finally { releases.forEach(resolve => resolve()); }
    await pending;
    const next = await request(base, { method: 'POST', body: JSON.stringify(document) });
    assert.equal(next.status, 200);
    assert.equal(calls, 6);
  }, { ocrCompareModelClient: async () => {
    calls++;
    if (calls <= 3) await new Promise(resolve => releases.push(resolve));
    throw new Error('synthetic provider failure');
  } });
});

test('the lab uses direct Gemini and direct Anthropic even when production provider is OpenRouter', async () => {
  const nativeFetch = globalThis.fetch;
  const providerCalls = [];
  const anthropicCalls = [];
  process.env.GEMINI_API_KEY = 'synthetic-test-key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-synthetic-test-key';
  delete process.env.OPENROUTER_API_KEY;
  process.env.MODEL_PROVIDER = 'openrouter';
  process.env.GEMINI_THINKING_LEVEL = 'minimal';
  globalThis.fetch = async (url, options) => {
    if (String(url) === 'https://api.anthropic.com/v1/messages') {
      anthropicCalls.push({ headers: options.headers, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({ model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'scratch' }, { type: 'text', text: 'GRANTOR: Claude Fixture' }], usage: { input_tokens: 200, output_tokens: 40 } }), { status: 200 });
    }
    if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) return nativeFetch(url, options);
    providerCalls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'GRANTOR: API Fixture' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 10 } }), { status: 200 });
  };
  try {
    await withServer(async base => {
      const response = await request(base, { method: 'POST', body: JSON.stringify(document) });
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(providerCalls.length, 2, 'two Gemini calls; Haiku goes to Anthropic');
      assert.match(providerCalls[1].url, /gemini-3\.8-flash:generateContent$/);
      assert.equal(providerCalls[0].body.generationConfig.thinkingConfig.thinkingLevel, 'minimal');
      assert.equal(providerCalls[1].body.generationConfig.thinkingConfig.thinkingLevel, 'low');
      assert.deepEqual(providerCalls[0].body.contents, providerCalls[1].body.contents);
      assert.equal(report.models[0].text, 'GRANTOR: API Fixture');
      assert.equal(anthropicCalls.length, 1);
      const [claude] = anthropicCalls;
      assert.equal(claude.headers['x-api-key'], 'sk-ant-synthetic-test-key');
      assert.equal(claude.body.model, 'claude-haiku-5-5');
      assert.deepEqual(claude.body.output_config, { effort: 'low' });
      assert.equal(claude.body.max_tokens, report.models[2].maxTokens);
      assert.ok(!('thinking' in claude.body) && !('temperature' in claude.body), 'Haiku 5.5 rejects sampling overrides');
      assert.equal(claude.body.messages[0].content[0].type, 'image');
      assert.equal(claude.body.messages[0].content[0].source.data, PNG);
      assert.equal(report.models[2].text, 'GRANTOR: Claude Fixture', 'thinking blocks are not part of the output text');
      assert.equal(report.models[2].error, undefined);
      assert.equal(report.models[2].costUsd, (200 * 0.1 + 40 * 0.5) / 1_000_000);
      assert.ok(!JSON.stringify(report).includes('sk-ant-synthetic-test-key'));
    });
  } finally {
    globalThis.fetch = nativeFetch;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MODEL_PROVIDER;
    delete process.env.GEMINI_THINKING_LEVEL;
  }
});

test('Gemini 2.5 baseline with a thinking budget rejects metadata and comparisons before provider calls', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createOcrCompareHandler } from './api/ocr-compare.js';
    let calls = 0;
    const handler = createOcrCompareHandler({ modelClient: async () => { calls++; return { text: 'fixture' }; } });
    const responses = [];
    for (const method of ['GET', 'POST']) {
      const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { responses.push({ code: this.code, body }); } };
      await handler({ method, headers: { 'x-app-password': 'ocr-test-password' }, socket: {}, body: ${JSON.stringify(document)} }, res);
    }
    console.log(JSON.stringify({ responses, calls }));
  `], { encoding: 'utf8', env: { ...process.env, ABSTRACT_MODEL: 'gemini-2.5-flash', GEMINI_THINKING_BUDGET: '1024', GEMINI_THINKING_LEVEL: '' } });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  for (const response of report.responses) {
    assert.equal(response.code, 503);
    assert.match(response.body.error, /Gemini 3-series ABSTRACT_MODEL/);
    assert.equal(response.body.models, undefined, 'Unsupported baseline must not return misleading thinking metadata');
  }
  assert.equal(report.calls, 0, 'Unsupported baseline must not start either provider');
});

test('current-model metadata follows server ABSTRACT_MODEL override', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { createOcrCompareHandler } from './api/ocr-compare.js'; const res={setHeader(){},status(code){this.code=code;return this;},json(body){console.log(JSON.stringify({code:this.code,body}));}}; await createOcrCompareHandler()({method:'GET',headers:{'x-app-password':'ocr-test-password'},socket:{}},res);`], { encoding: 'utf8', env: { ...process.env, ABSTRACT_MODEL: 'gemini-3.5-flash' } });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.code, 200);
  assert.equal(response.body.models[0].id, 'gemini-3.5-flash');
});

test('a missing ANTHROPIC_API_KEY fails only the Haiku column and leaves Gemini results intact', async () => {
  const nativeFetch = globalThis.fetch;
  let anthropicRequests = 0;
  process.env.GEMINI_API_KEY = 'synthetic-test-key';
  delete process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('https://api.anthropic.com/')) { anthropicRequests++; return new Response('{}', { status: 500 }); }
    if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) return nativeFetch(url, options);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'GRANTOR: Gemini Fixture' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }), { status: 200 });
  };
  try {
    await withServer(async base => {
      const response = await request(base, { method: 'POST', body: JSON.stringify(document) });
      assert.equal(response.status, 200);
      const report = await response.json();
      assert.equal(report.models[0].text, 'GRANTOR: Gemini Fixture');
      assert.equal(report.models[0].costUsd, (10 * 0.25 + 5 * 1.5) / 1_000_000, 'absent Gemini thoughtsTokenCount means zero thinking tokens');
      assert.match(report.models[2].error, /ANTHROPIC_API_KEY is required/);
      assert.equal(anthropicRequests, 0);
    });
  } finally { globalThis.fetch = nativeFetch; delete process.env.GEMINI_API_KEY; }
});

test('Haiku cost uses the long-prompt tier and cache rates, and never fabricates a zero', async () => {
  const usages = [
    { input_tokens: 150_000, output_tokens: 1000 },
    { input_tokens: 1000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 3000, output_tokens: 100 },
    { input_tokens: 1000 },
  ];
  const costs = [];
  for (const usage of usages) {
    await withServer(async base => {
      const report = await (await request(base, { method: 'POST', body: JSON.stringify(document) })).json();
      costs.push(report.models[2]);
    }, { ocrCompareModelClient: async call => ({ text: 'GRANTOR: X', usage: call.model.startsWith('claude-') ? usage : {} }) });
  }
  assert.equal(costs[0].costUsd, (150_000 * 0.5 + 1000 * 2.5) / 1_000_000);
  assert.equal(costs[0].costRates.input, 0.5);
  assert.equal(costs[1].costUsd, (1000 * 0.1 + 2000 * 0.125 + 3000 * 0.01 + 100 * 0.5) / 1_000_000);
  assert.equal(costs[2].costUsd, null);
});
