import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOcrCompareHandler } from '../api/ocr-compare.js';
import { buildOpenRouterRequestBody, invokeOpenRouterModel } from '../api/_lib/openrouter-request.js';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM1kAAAAASUVORK5CYII=';
const upload = { filename: 'deed.png', pages: [{ mediaType: 'image/png', data: PNG }] };
const LAB_ENV = { APP_PASSWORD: 'ocr-test-password', OCR_COMPARE_ENABLED: 'true', OCR_COMPARE_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'synthetic-openrouter-key', NODE_ENV: 'test' };
const UNSET = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'ANTHROPIC_API_KEY', 'MODEL_PROVIDER', 'GEMINI_THINKING_LEVEL', 'GEMINI_THINKING_BUDGET', 'GEMINI_INCLUDE_THOUGHTS', 'ABSTRACT_MODEL', 'OCR_COMPARE_MAX_TOKENS', 'K_SERVICE'];

// Runs fn with a fresh environment and a stub fetch; nothing here can reach a real provider.
async function withLab(env, fetchStub, fn) {
  const saved = { ...process.env };
  const nativeFetch = globalThis.fetch;
  for (const key of UNSET) delete process.env[key];
  for (const [key, value] of Object.entries({ ...LAB_ENV, ...env })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  globalThis.fetch = fetchStub;
  try { return await fn(); }
  finally {
    globalThis.fetch = nativeFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
}

async function call(method, body) {
  const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.body = payload; return this; } };
  await createOcrCompareHandler()({ method, headers: { 'x-app-password': 'ocr-test-password' }, socket: {}, body }, res);
  return res;
}

const completion = (model, usage, text = 'GRANTOR: Router Fixture') => new Response(JSON.stringify({ id: 'gen-1', model, choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage }), { status: 200 });

// One answer per OpenRouter slug, so a column sent to the wrong slug shows up in the report.
const ANSWERS = {
  'google/gemini-3.1-flash-lite': () => completion('google/gemini-3.1-flash-lite-20260301', { prompt_tokens: 1000, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 200 }, cost: 0.00123 }),
  'google/gemini-4-hydrogen': () => completion('google/gemini-4-hydrogen-20261101', { prompt_tokens: 1000, completion_tokens: 700, completion_tokens_details: { reasoning_tokens: 200 } }),
  'anthropic/claude-haiku-5.5': () => completion('anthropic/claude-haiku-5.5-20261001', { prompt_tokens: 2000, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 100 }, cost: 0.0005 }),
};

function recordingFetch(calls, answers = ANSWERS) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), headers: init.headers, body });
    if (String(url) !== 'https://openrouter.ai/api/v1/chat/completions' || !answers[body.model]) throw new Error(`Unexpected network target blocked: ${url} ${body.model}`);
    return answers[body.model]();
  };
}

test('OCR_COMPARE_PROVIDER=openrouter sends all three columns to OpenRouter with the right slugs and reasoning efforts', async () => {
  const runs = [
    { efforts: ['default', 'low', 'medium'], reasoning: [undefined, 'low', 'medium'] },
    { efforts: ['minimal', 'medium', 'medium'], reasoning: ['minimal', 'medium', 'medium'] },
  ];
  for (const { efforts, reasoning } of runs) {
    const calls = [];
    await withLab({}, recordingFetch(calls), async () => {
      const res = await call('POST', { ...upload, efforts });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.equal(calls.length, 3, 'one OpenRouter call per column, no retries');
      assert.deepEqual(calls.map(c => c.body.model).sort(), ['anthropic/claude-haiku-5.5', 'google/gemini-3.1-flash-lite', 'google/gemini-4-hydrogen']);
      for (const c of calls) {
        assert.equal(c.url, 'https://openrouter.ai/api/v1/chat/completions');
        assert.equal(c.headers.Authorization, 'Bearer synthetic-openrouter-key');
        assert.equal(c.body.max_tokens, 16000);
        for (const key of ['temperature', 'top_p', 'top_k', 'thinking', 'output_config', 'generationConfig']) assert.ok(!(key in c.body), key);
      }
      const bySlug = Object.fromEntries(calls.map(c => [c.body.model, c.body]));
      const [current, hydrogen, haiku] = [bySlug['google/gemini-3.1-flash-lite'], bySlug['google/gemini-4-hydrogen'], bySlug['anthropic/claude-haiku-5.5']];
      for (const [body, expected] of [[current, reasoning[0]], [hydrogen, reasoning[1]], [haiku, reasoning[2]]]) {
        if (expected === undefined) assert.ok(!('reasoning' in body), 'default effort sends no reasoning field');
        else assert.deepEqual(body.reasoning, { effort: expected });
      }
      // Same images and prompt for every column; the rendered page is an image_url data URL.
      assert.deepEqual(current.messages, hydrogen.messages);
      assert.deepEqual(current.messages, haiku.messages);
      assert.equal(current.messages[0].role, 'system');
      assert.match(current.messages[0].content, /expert oil and gas title attorney/);
      assert.deepEqual(current.messages[1].content[0], { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } });
      assert.equal(current.messages[1].content[1].type, 'text');
      assert.ok(!JSON.stringify(res.body).includes(PNG), 'report must not retain uploaded bytes');
    });
  }
});

test('OpenRouter lab needs no APP_PASSWORD locally, still does in production', async () => {
  const bare = async (method, body) => {
    const res = { setHeader() {}, status(code) { this.code = code; return this; }, json(payload) { this.body = payload; return this; } };
    await createOcrCompareHandler()({ method, headers: {}, socket: {}, body }, res);
    return res;
  };
  const calls = [];
  await withLab({ APP_PASSWORD: undefined }, recordingFetch(calls), async () => {
    const meta = await bare('GET');
    assert.equal(meta.code, 200);
    assert.equal(meta.body.passwordRequired, false);
    const run = await bare('POST', { ...upload, efforts: ['default', 'medium', 'medium'] });
    assert.equal(run.code, 200, JSON.stringify(run.body));
    assert.equal(calls.length, 3);
  });
  for (const env of [{ APP_PASSWORD: undefined, NODE_ENV: 'production' }, { APP_PASSWORD: undefined, K_SERVICE: 'titlework' }]) {
    const none = [];
    await withLab(env, recordingFetch(none), async () => {
      assert.equal((await bare('GET')).code, 503);
      assert.equal((await bare('POST', upload)).code, 503);
    });
    assert.equal(none.length, 0);
  }
});

test('OpenRouter mode reports the provider, the routed model id and the chosen effort per column', async () => {
  const calls = [];
  await withLab({}, recordingFetch(calls), async () => {
    const res = await call('POST', upload);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body.models.map(m => m.provider), ['openrouter', 'openrouter', 'openrouter']);
    assert.deepEqual(res.body.models.map(m => m.id), ['gemini-3.1-flash-lite', 'gemini-4-hydrogen', 'claude-haiku-5-5']);
    assert.deepEqual(res.body.models.map(m => m.modelVersion), ['google/gemini-3.1-flash-lite-20260301', 'google/gemini-4-hydrogen-20261101', 'anthropic/claude-haiku-5.5-20261001']);
    assert.deepEqual(res.body.models.map(m => m.stopReason), ['stop', 'stop', 'stop']);
    assert.deepEqual(res.body.models.map(m => m.effort), ['default', 'medium', 'medium']);
    assert.ok(res.body.models.every(m => m.text === 'GRANTOR: Router Fixture' && m.fields.GRANTOR === 'Router Fixture' && m.error === undefined));
  });
});

test('OpenRouter usage is normalized per family so thinking is never billed twice, and the reported cost wins', async () => {
  const calls = [];
  await withLab({}, recordingFetch(calls), async () => {
    const [current, hydrogen, haiku] = (await call('POST', upload)).body.models;
    // Gemini: completion 700 includes 200 reasoning -> output 500 + thinking 200, as the direct Gemini report shows them.
    assert.deepEqual(current.usage, { input_tokens: 1000, output_tokens: 500, thinking_tokens: 200 });
    assert.deepEqual(hydrogen.usage, { input_tokens: 1000, output_tokens: 500, thinking_tokens: 200 });
    // Claude: output_tokens stays inclusive (as Anthropic reports it); thinking_tokens is display only.
    assert.deepEqual(haiku.usage, { input_tokens: 2000, output_tokens: 300, thinking_tokens: 100 });
    // usage.cost present -> used as is.
    assert.equal(current.costUsd, 0.00123);
    assert.equal(haiku.costUsd, 0.0005);
    assert.match(current.costRates.source, /^OpenRouter reported cost/);
    // No usage.cost -> computed from list rates with thinking counted once.
    assert.equal(hydrogen.costUsd, (1000 * 1.5 + (500 + 200) * 7.5) / 1_000_000);
    assert.deepEqual({ input: hydrogen.costRates.input, output: hydrogen.costRates.output }, { input: 1.5, output: 7.5 });
    assert.match(hydrogen.costRates.source, /^computed from list rates, https:\/\/openrouter\.ai\//);
  });
  const noCost = { ...ANSWERS, 'anthropic/claude-haiku-5.5': () => completion('anthropic/claude-haiku-5.5', { prompt_tokens: 2000, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 100 } }) };
  await withLab({}, recordingFetch([], noCost), async () => {
    const haiku = (await call('POST', upload)).body.models[2];
    assert.equal(haiku.costUsd, (2000 * 0.1 + 300 * 0.5) / 1_000_000, 'Claude output already includes reasoning');
  });
  const noReasoning = { ...ANSWERS, 'google/gemini-4-hydrogen': () => completion('google/gemini-4-hydrogen', { prompt_tokens: 1000, completion_tokens: 500 }), 'anthropic/claude-haiku-5.5': () => completion('anthropic/claude-haiku-5.5', {}) };
  await withLab({}, recordingFetch([], noReasoning), async () => {
    const [, hydrogen, haiku] = (await call('POST', upload)).body.models;
    assert.deepEqual(hydrogen.usage, { input_tokens: 1000, output_tokens: 500 });
    assert.equal(hydrogen.costUsd, (1000 * 1.5 + 500 * 7.5) / 1_000_000, 'absent reasoning tokens count as zero');
    assert.equal(haiku.costUsd, null, 'missing usage never becomes a zero cost');
  });
});

test('OpenRouter mode checks OPENROUTER_API_KEY, not the Gemini key, before any call', async () => {
  const calls = [];
  await withLab({ OPENROUTER_API_KEY: undefined, GEMINI_API_KEY: 'synthetic-gemini-key', ANTHROPIC_API_KEY: 'synthetic-anthropic-key' }, recordingFetch(calls), async () => {
    const res = await call('POST', upload);
    assert.equal(res.code, 503);
    assert.match(res.body.error, /OPENROUTER_API_KEY/);
    assert.doesNotMatch(res.body.error, /GEMINI/);
    assert.equal(calls.length, 0);
  });
  // Only the OpenRouter key set: no Gemini or Anthropic key is needed.
  await withLab({}, recordingFetch([]), async () => assert.equal((await call('POST', upload)).code, 200));
});

// Built at runtime so secret scanners do not flag a fake key literal in the source.
const UPSTREAM_KEY_ECHO = ['sk', 'or', 'v1', 'fixture0000echo'].join('-');

test('one failing OpenRouter column is isolated, sanitized, and not retried', async () => {
  const calls = [];
  const answers = {
    ...ANSWERS,
    'google/gemini-4-hydrogen': () => new Response(JSON.stringify({ error: { message: `No credits. key ${UPSTREAM_KEY_ECHO}` } }), { status: 402 }),
    'anthropic/claude-haiku-5.5': () => new Response(JSON.stringify({ error: { code: 502, message: 'Provider returned error' }, choices: [] }), { status: 200 }),
  };
  await withLab({}, recordingFetch(calls, answers), async () => {
    const res = await call('POST', upload);
    assert.equal(res.code, 200);
    assert.equal(calls.length, 3);
    assert.equal(res.body.models[0].text, 'GRANTOR: Router Fixture');
    assert.match(res.body.models[1].error, /No credits/);
    assert.ok(!res.body.models[1].error.includes(UPSTREAM_KEY_ECHO));
    assert.equal(res.body.models[2].error, 'Provider returned error', 'a 200 body that carries an error is a failure, not empty text');
  });
});

test('metadata names the provider in OpenRouter mode and keeps the effort menus unchanged', async () => {
  await withLab({}, recordingFetch([]), async () => {
    const res = await call('GET');
    assert.equal(res.code, 200);
    assert.deepEqual(res.body.models.map(m => m.provider), ['openrouter', 'openrouter', 'openrouter']);
    assert.deepEqual(res.body.models.map(m => m.effortLevels), [['default', 'minimal', 'low', 'medium', 'high'], ['low', 'medium', 'high', 'xhigh'], ['low', 'medium', 'high', 'xhigh', 'max']]);
  });
});

test('an unknown OCR_COMPARE_PROVIDER fails closed for metadata and comparisons', async () => {
  const calls = [];
  await withLab({ OCR_COMPARE_PROVIDER: 'openrouters', GEMINI_API_KEY: 'synthetic-gemini-key' }, recordingFetch(calls), async () => {
    for (const [method, body] of [['GET'], ['POST', upload]]) {
      const res = await call(method, body);
      assert.equal(res.code, 503);
      assert.match(res.body.error, /OCR_COMPARE_PROVIDER/);
      assert.equal(res.body.models, undefined);
    }
    assert.equal(calls.length, 0);
  });
});

test('direct mode (unset or "direct") is unchanged: Gemini and Anthropic URLs and bodies, no provider field', async () => {
  for (const provider of [undefined, 'direct', '']) {
    const calls = [];
    const stub = async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), headers: init.headers, body });
      if (String(url).startsWith('https://generativelanguage.googleapis.com/')) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'GRANTOR: Direct' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }));
      if (String(url) === 'https://api.anthropic.com/v1/messages') return new Response(JSON.stringify({ model: body.model, content: [{ type: 'text', text: 'GRANTOR: Direct' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }));
      throw new Error(`Unexpected network target blocked: ${url}`);
    };
    // 8000 keeps Haiku non-streaming (the stub answers plain JSON).
    await withLab({ OCR_COMPARE_PROVIDER: provider, OCR_COMPARE_MAX_TOKENS: '8000', OPENROUTER_API_KEY: undefined, GEMINI_API_KEY: 'synthetic-gemini-key', ANTHROPIC_API_KEY: 'synthetic-anthropic-key' }, stub, async () => {
      const metadata = await call('GET');
      assert.ok(metadata.body.models.every(m => !('provider' in m)));
      const res = await call('POST', { ...upload, efforts: ['low', 'high', 'max'] });
      assert.equal(res.code, 200);
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.map(c => c.url).sort(), [
        'https://api.anthropic.com/v1/messages',
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent',
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-4-hydrogen:generateContent',
      ]);
      const haiku = calls.find(c => c.url.includes('anthropic'));
      assert.equal(haiku.body.model, 'claude-haiku-5-5');
      assert.deepEqual(haiku.body.output_config, { effort: 'max' });
      assert.ok(!('reasoning' in haiku.body));
      assert.ok(res.body.models.every(m => !('provider' in m) && m.error === undefined && m.costRates.source !== undefined && !/OpenRouter/.test(m.costRates.source)));
    });
  }
});

test('buildOpenRouterRequestBody: reasoningEffort is opt-in and existing callers get the same body', () => {
  const input = { model: 'claude-sonnet-5-5', maxTokens: 2000, system: 'sys', messages: [{ role: 'user', content: 'hi' }] };
  const before = { model: 'anthropic/claude-sonnet-5.5', max_tokens: 2000, messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }] };
  assert.deepEqual(buildOpenRouterRequestBody(input), before);
  assert.deepEqual(buildOpenRouterRequestBody({ ...input, reasoningEffort: undefined }), before);
  assert.deepEqual(buildOpenRouterRequestBody({ ...input, reasoningEffort: '' }), before);
  assert.deepEqual(buildOpenRouterRequestBody({ ...input, reasoningEffort: 'high' }), { ...before, reasoning: { effort: 'high' } });
});

test('OpenRouter slugs: Haiku 5.5 uses the dotted slug, Sonnet 5.5 is unchanged, Gemini keeps the google/ prefix', () => {
  const slug = model => buildOpenRouterRequestBody({ model, maxTokens: 1, messages: [] }).model;
  assert.equal(slug('claude-haiku-5-5'), 'anthropic/claude-haiku-5.5');
  assert.equal(slug('claude-sonnet-5-5'), 'anthropic/claude-sonnet-5.5');
  assert.equal(slug('claude-sonnet-5'), 'anthropic/claude-sonnet-5');
  assert.equal(slug('gemini-4-hydrogen'), 'google/gemini-4-hydrogen');
  assert.equal(slug('gemini-3.1-flash-lite'), 'google/gemini-3.1-flash-lite');
  assert.equal(slug('gemini-3.8-flash'), 'google/gemini-3.8-flash');
});

test('invokeOpenRouterModel (production path) still sends no reasoning field and returns the same result shape', async () => {
  const calls = [];
  const result = await withLab({}, async (url, init) => {
    calls.push(JSON.parse(init.body));
    return completion('anthropic/claude-sonnet-5.5', { prompt_tokens: 5, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 1 }, cost: 0.01 }, 'ok');
  }, () => invokeOpenRouterModel({ model: 'claude-sonnet-5-5', maxTokens: 100, system: 'sys', messages: [{ role: 'user', content: 'hi' }] }));
  assert.deepEqual(Object.keys(calls[0]).sort(), ['max_tokens', 'messages', 'model']);
  assert.deepEqual(result, { text: 'ok', model: 'anthropic/claude-sonnet-5.5', usage: { input_tokens: 5, output_tokens: 3 }, stopReason: 'stop' });
});

const usageOnly = usage => ({ ...ANSWERS, 'google/gemini-4-hydrogen': () => completion('google/gemini-4-hydrogen', usage) });
const hydrogenOf = async answers => withLab({}, recordingFetch([], answers), async () => (await call('POST', upload)).body.models[1]);

test('BYOK: usage.cost 0 is not shown as the cost; the upstream cost is used, else list rates', async () => {
  const tokens = { prompt_tokens: 1000, completion_tokens: 500 };
  const listRate = (1000 * 1.5 + 500 * 7.5) / 1_000_000;
  const upstream = await hydrogenOf(usageOnly({ ...tokens, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0042 } }));
  assert.equal(upstream.costUsd, 0.0042);
  assert.match(upstream.costRates.source, /^OpenRouter BYOK upstream cost \(usage\.cost_details\.upstream_inference_cost\)/);
  // Missing, negative, non-finite or non-number upstream cost: compute from list rates, never the 0.
  for (const cost_details of [undefined, {}, { upstream_inference_cost: null }, { upstream_inference_cost: -1 }, { upstream_inference_cost: '0.5' }, { upstream_inference_cost: 1e999 }]) {
    const model = await hydrogenOf(usageOnly({ ...tokens, cost: 0, is_byok: true, cost_details }));
    assert.equal(model.costUsd, listRate, JSON.stringify(cost_details));
    assert.match(model.costRates.source, /^computed from list rates/);
  }
  // Without is_byok a finite usage.cost, including 0, is used as reported; invalid values are computed.
  const free = await hydrogenOf(usageOnly({ ...tokens, cost: 0 }));
  assert.equal(free.costUsd, 0);
  assert.match(free.costRates.source, /^OpenRouter reported cost/);
  for (const cost of [-1, '0.5', null, 1e999]) assert.equal((await hydrogenOf(usageOnly({ ...tokens, cost }))).costUsd, listRate, String(cost));
  // is_byok false behaves like absent; a truthy non-true value is not BYOK.
  assert.equal((await hydrogenOf(usageOnly({ ...tokens, cost: 0.003, is_byok: false, cost_details: { upstream_inference_cost: 9 } }))).costUsd, 0.003);
});

test('the literal OPENROUTER_API_KEY is redacted from column errors, whatever its format', async () => {
  const key = ['plain', 'fixture', 'value', 'not', 'a', 'secret'].join('');
  const echoes = {
    http401: () => new Response(JSON.stringify({ error: { message: `Bearer ${key} rejected` } }), { status: 401 }),
    err200: () => new Response(JSON.stringify({ error: { message: `key ${key} bad` } }), { status: 200 }),
    finishError: () => new Response(JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'error', error: { message: `upstream saw ${key}` } }] }), { status: 200 }),
  };
  for (const [name, answer] of Object.entries(echoes)) {
    await withLab({ OPENROUTER_API_KEY: key }, async () => answer(), async () => {
      const res = await call('POST', upload);
      assert.equal(res.code, 200, name);
      assert.ok(!JSON.stringify(res.body).includes(key), name);
      assert.match(res.body.models[0].error, /\[REDACTED\]/, name);
    });
  }
  // A thrown fetch error that echoes the Authorization header, and a key sitting across the 1000-char cut.
  for (const message of [`boom Bearer ${key}`, 'x'.repeat(990) + key]) {
    await withLab({ OPENROUTER_API_KEY: key }, async () => { throw new Error(message); }, async () => {
      const res = await call('POST', upload);
      assert.ok(!JSON.stringify(res.body).includes(key.slice(0, 8)), message.slice(0, 20));
    });
  }
  // Short values (< 8 chars) are not treated as secrets: redacting them would mangle ordinary text.
  await withLab({ OPENROUTER_API_KEY: 'abc' }, async () => new Response(JSON.stringify({ error: { message: 'abc is a fine word' } }), { status: 401 }), async () => {
    assert.equal((await call('POST', upload)).body.models[0].error, 'abc is a fine word');
  });
});

test('bad 200 responses become readable per-column errors, never "[object Object]" or a TypeError', async () => {
  const GENERIC = 'OpenRouter returned no completion (HTTP 200)';
  const raw = body => () => new Response(body, { status: 200 });
  const json = (data, status = 200) => () => new Response(JSON.stringify(data), { status });
  const cases = [
    ['empty body', raw(''), GENERIC],
    ['HTML body', raw('<html>gateway</html>'), GENERIC],
    ['array', raw('[]'), GENERIC],
    ['null', raw('null'), GENERIC],
    ['empty object', json({}), GENERIC],
    ['choices missing', json({ usage: { prompt_tokens: 1 } }), GENERIC],
    ['choices empty', json({ choices: [] }), GENERIC],
    ['finish_reason error, no detail', json({ choices: [{ message: { content: '' }, finish_reason: 'error' }] }), GENERIC],
    ['finish_reason error with message', json({ choices: [{ message: { content: '' }, finish_reason: 'error', error: { code: 502, message: 'upstream died' } }] }), 'upstream died'],
    ['finish_reason error with code only', json({ choices: [{ message: { content: '' }, finish_reason: 'error', error: { code: 502 } }] }), 'OpenRouter error 502'],
    ['error message in 200', json({ error: { code: 502, message: 'Provider returned error' } }), 'Provider returned error'],
    ['error code only in 200', json({ error: { code: 502 } }), 'OpenRouter error 502'],
    ['error status only in 200', json({ error: { status: 'overloaded' } }), 'OpenRouter error overloaded'],
    ['error object with nothing usable in 200', json({ error: { metadata: {} } }), GENERIC],
    ['error string in 200', json({ error: 'boom' }), 'boom'],
  ];
  for (const [name, answer, expected] of cases) {
    const answers = { ...ANSWERS, 'google/gemini-4-hydrogen': answer };
    const calls = [];
    await withLab({}, recordingFetch(calls, answers), async () => {
      const res = await call('POST', upload);
      assert.equal(res.code, 200, name);
      const model = res.body.models[1];
      assert.equal(model.error, expected, name);
      assert.doesNotMatch(model.error, /object Object|TypeError|undefined|null/, name);
      assert.equal(model.text, undefined, name);
      assert.equal(res.body.models[0].error, undefined, 'the other columns still succeed');
      assert.equal(calls.length, 3, 'no retries');
    });
  }
});

test('non-ok OpenRouter responses give readable messages in the lab path and in invokeOpenRouterModel', async () => {
  const request = { model: 'claude-sonnet-5-5', maxTokens: 10, system: 's', messages: [{ role: 'user', content: 'hi' }] };
  const cases = [
    [{ error: { code: 500 } }, 500, 'OpenRouter error 500'],
    [{ error: { code: 429, message: 'Rate limit exceeded' } }, 429, 'Rate limit exceeded'],
    [{ error: 'str' }, 429, 'str'],
    [{ error: { metadata: {} } }, 502, 'OpenRouter request failed (HTTP 502).'],
    ['<h1>gateway</h1>', 502, 'OpenRouter request failed (HTTP 502).'],
  ];
  for (const [data, status, expected] of cases) {
    const stub = async () => new Response(typeof data === 'string' ? data : JSON.stringify(data), { status });
    await withLab({}, stub, async () => {
      await assert.rejects(invokeOpenRouterModel(request), error => error.message === expected && error.status === status);
      const hydrogen = (await call('POST', upload)).body.models[1];
      assert.equal(hydrogen.error, expected);
    });
  }
});
