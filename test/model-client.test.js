import assertStrict from 'node:assert/strict';
import {
  abstractionApiKeyError,
  invokeModel,
  invokeAnthropicModel,
  invokeAnthropicModelStream,
  isGeminiModel,
  mapModelResponseToAnalyzeProxy,
  shouldUseOpenRouter,
  openRouterApiKeyError,
  sanitizeModelClientError,
} from '../api/_lib/model-client.js';
import { buildOpenRouterRequestBody } from '../api/_lib/openrouter-request.js';
import { consumeOpenRouterMessageStream } from '../api/_lib/openrouter-stream.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('OpenRouter maps claude-sonnet-5-5 to anthropic/claude-sonnet-5.5', () => {
  const req = buildOpenRouterRequestBody({ model: 'claude-sonnet-5-5', maxTokens: 100, messages: [] });
  assert(req.model === 'anthropic/claude-sonnet-5.5', `Expected dotted OpenRouter slug, got ${req.model}`);
});

test('abstractionApiKeyError requires Gemini key for gemini models', () => {
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevGoogle = process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  assert(
    abstractionApiKeyError('gemini-2.5-flash')?.includes('GEMINI_API_KEY'),
    'Expected Gemini key error',
  );
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  assert(abstractionApiKeyError('gemini-2.5-flash') === null, 'Expected no error when Gemini key is set');
  if (prevGemini) process.env.GEMINI_API_KEY = prevGemini;
  else delete process.env.GEMINI_API_KEY;
  if (prevGoogle) process.env.GOOGLE_API_KEY = prevGoogle;
  else delete process.env.GOOGLE_API_KEY;
});

test('abstractionApiKeyError uses the OpenRouter key for a bare Gemini model when globally routed', () => {
  const names = ['MODEL_PROVIDER', 'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    process.env.MODEL_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    assert(abstractionApiKeyError('gemini-3.1-flash-lite') === null, 'Expected OpenRouter routing not to require a Gemini key');
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test('OpenRouter stream frames preserve results and callback order with or without a trailing newline', async () => {
  const frames = [
    ': keepalive',
    'data: invalid JSON',
    'data: {"model":"anthropic/claude-sonnet-5.5","choices":[{"delta":{"content":"Hello"}}],"usage":{"prompt_tokens":12}}',
    'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}],"usage":{"completion_tokens":3}}',
  ];
  const previousNow = Date.now;
  Date.now = () => 12345;
  try {
    for (const ending of [[], ['data: [DONE]'], ['data: [DONE]', 'data: {"choices":[{"delta":{"content":"ignored"}}]}']]) {
      const runs = [];
      for (const newline of ['', '\n']) {
        const callbacks = [];
        const bytes = new TextEncoder().encode([...frames, ...ending].join('\n') + newline);
        const body = new ReadableStream({
          start(controller) {
            for (let i = 0; i < bytes.length; i += 17) controller.enqueue(bytes.slice(i, i + 17));
            controller.close();
          },
        });
        const result = await consumeOpenRouterMessageStream(body, {
          onDelta: delta => callbacks.push(['delta', delta]),
          onEvent: event => callbacks.push(['event', event]),
        });
        assertStrict.deepEqual(result, {
          text: 'Hello world', model: 'anthropic/claude-sonnet-5.5',
          usage: { input_tokens: 12, output_tokens: 3 }, stopReason: 'stop', firstDeltaAt: 12345,
        });
        assertStrict.deepEqual(callbacks.map(([kind]) => kind), ['delta', 'event', 'delta', 'event']);
        runs.push({ result, callbacks });
      }
      assertStrict.deepEqual(runs[0], runs[1]);
    }
  } finally {
    Date.now = previousNow;
  }
});

test('invokeModel routes Gemini models to Gemini API', async () => {
  const prevGemini = process.env.GEMINI_API_KEY;
  const prevFetch = global.fetch;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = String(url);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'abstract ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
        modelVersion: 'gemini-2.5-flash',
      }),
    };
  };
  const result = await invokeModel({
    model: 'gemini-2.5-flash',
    maxTokens: 100,
    system: 'system prompt',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  });
  global.fetch = prevFetch;
  if (prevGemini) process.env.GEMINI_API_KEY = prevGemini;
  else delete process.env.GEMINI_API_KEY;

  assert(requestedUrl.includes('gemini-2.5-flash:generateContent'), `Expected Gemini endpoint, got ${requestedUrl}`);
  assert(result.text === 'abstract ok', 'Expected model text');
  assert(result.usage.input_tokens === 10, 'Expected usage mapping');
});

test('invokeAnthropicModelStream requests stream=true and forwards deltas', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  let requestBody = null;
  global.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    const encoder = new TextEncoder();
    const chunk = encoder.encode([
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n'));
    return {
      ok: true,
      status: 200,
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: chunk };
            },
          };
        },
      },
    };
  };
  const deltas = [];
  const result = await invokeAnthropicModelStream({
    model: 'claude-sonnet-5',
    maxTokens: 100,
    system: 'system prompt',
    messages: [{ role: 'user', content: 'hello' }],
  }, {
    onDelta: (delta) => { deltas.push(delta); },
  });
  global.fetch = prevFetch;
  if (prevKey) process.env.ANTHROPIC_API_KEY = prevKey;
  else delete process.env.ANTHROPIC_API_KEY;

  assert(requestBody?.stream === true, 'Expected stream flag on Anthropic request');
  assert(result.text === 'Hi', 'Expected streamed text');
  assert(deltas.join('') === 'Hi', 'Expected onDelta callbacks');
});

test('Anthropic requests send anthropic-version 2026-10-21 and no sampling parameters', async () => {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  const sent = [];
  global.fetch = async (_url, init) => {
    sent.push({ headers: init.headers, body: JSON.parse(init.body) });
    const wire = [
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      '',
    ].join('\n');
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: 'ok' }], usage: {}, stop_reason: 'end_turn' }),
      body: new Response(wire).body,
    };
  };
  const request = { model: 'claude-sonnet-5-5', maxTokens: 100, system: 'system prompt', messages: [{ role: 'user', content: 'hello' }] };
  try {
    await invokeAnthropicModel(request, { direct: true });
    await invokeAnthropicModelStream(request, { direct: true });
  } finally {
    global.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
  }
  assertStrict.equal(sent.length, 2);
  for (const { headers, body } of sent) {
    assertStrict.equal(headers['anthropic-version'], '2026-10-21');
    for (const key of ['temperature', 'top_p', 'top_k']) {
      assert(!(key in body), `2026-10-21 rejects ${key}`);
    }
  }
});

test('mapModelResponseToAnalyzeProxy preserves analyze.js response shape', () => {
  const mapped = mapModelResponseToAnalyzeProxy({
    text: 'ok',
    model: 'gemini-2.5-flash',
    usage: { input_tokens: 1, output_tokens: 2 },
    stopReason: 'STOP',
  });
  assert(mapped.content[0].text === 'ok', 'Expected text block');
  assert(mapped.model === 'gemini-2.5-flash', 'Expected model id');
  assert(mapped.usage.input_tokens === 1, 'Expected usage passthrough');
});

test('isGeminiModel is exported for analyze validation', () => {
  assert(isGeminiModel('gemini-2.5-flash'), 'Expected gemini matcher');
});

test('invokeModel streaming path does not consume the SSE body via json()', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  const prevProvider = process.env.MODEL_PROVIDER;
  const prevFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  delete process.env.MODEL_PROVIDER;

  const sseLines = [
    'data: {"choices":[{"delta":{"content":"Final"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":" opinion"},"index":0}]}',
    'data: [DONE]',
  ];

  global.fetch = async () => new Response(sseLines.join('\n'), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });

  try {
    const result = await invokeModel({
      model: 'anthropic/claude-sonnet-5',
      maxTokens: 16000,
      system: 'system',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'merge' }] }],
    });
    assert(result.text === 'Final opinion', `Expected streamed text, got "${result.text}"`);
  } finally {
    global.fetch = prevFetch;
    if (prevKey) process.env.OPENROUTER_API_KEY = prevKey; else delete process.env.OPENROUTER_API_KEY;
    if (prevProvider) process.env.MODEL_PROVIDER = prevProvider; else delete process.env.MODEL_PROVIDER;
  }
});

test('invokeModel streams through OpenRouter when MODEL_PROVIDER=openrouter', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  const prevProvider = process.env.MODEL_PROVIDER;
  const prevFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-be-used';
  process.env.MODEL_PROVIDER = 'openrouter';
  let requestedUrl = '';
  global.fetch = async (url) => {
    requestedUrl = String(url);
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      json: async () => ({}),
      body: {
        getReader() {
          let done = false;
          return {
            async read() {
              if (done) return { done: true, value: undefined };
              done = true;
              return { done: false, value: encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n') };
            },
            releaseLock() {},
          };
        },
      },
    };
  };
  try {
    const result = await invokeModel({
      model: 'claude-sonnet-5',
      maxTokens: 4000,
      stream: true,
      system: 'system',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'merge' }] }],
    }, { stream: true });
    assert(requestedUrl.includes('openrouter.ai'), `Expected OpenRouter URL, got ${requestedUrl}`);
    assert(!requestedUrl.includes('api.anthropic.com'), 'Must not stream merge via direct Anthropic when OpenRouter is selected');
    assert(result.text === 'ok', `Expected streamed OpenRouter text, got "${result.text}"`);
  } finally {
    global.fetch = prevFetch;
    if (prevKey) process.env.OPENROUTER_API_KEY = prevKey; else delete process.env.OPENROUTER_API_KEY;
    if (prevAnthropic) process.env.ANTHROPIC_API_KEY = prevAnthropic; else delete process.env.ANTHROPIC_API_KEY;
    if (prevProvider) process.env.MODEL_PROVIDER = prevProvider; else delete process.env.MODEL_PROVIDER;
  }
});

async function withAnthropicStream(wire, fn, readError) {
  const prevKey = process.env.ANTHROPIC_API_KEY;
  const prevProvider = process.env.MODEL_PROVIDER;
  const prevFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
  delete process.env.MODEL_PROVIDER;
  const requests = [];
  let cleanups = 0;
  global.fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    const bytes = new TextEncoder().encode(wire);
    let index = 0;
    return new Response(new ReadableStream({
      pull(controller) {
        if (index < bytes.length) controller.enqueue(Uint8Array.of(bytes[index++]));
        else if (readError) controller.error(readError);
        else controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    return await fn({
      stream: true,
      direct: true,
      createTimeoutSignal: () => ({ signal: new AbortController().signal, cleanup: () => { cleanups++; } }),
    });
  } finally {
    global.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
    if (prevProvider === undefined) delete process.env.MODEL_PROVIDER; else process.env.MODEL_PROVIDER = prevProvider;
    assertStrict.equal(requests.length, 1, 'Interrupted streams must not trigger retries or fallback requests');
    assertStrict.equal(requests[0].url, 'https://api.anthropic.com/v1/messages');
    assertStrict.equal(requests[0].body.stream, true);
    assertStrict.equal(cleanups, 1, 'The real client must clean up its timeout on both success and failure');
  }
}

for (const [name, invoke] of [['invokeAnthropicModelStream', invokeAnthropicModelStream], ['invokeModel', invokeModel]]) {
  const request = { model: 'claude-haiku-5-5', maxTokens: 16000, messages: [{ role: 'user', content: 'Synthetic document' }] };
  const start = 'event: message_start\r\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":12,"cache_read_input_tokens":3,"output_tokens":0}}}';
  const partial = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}';
  const error = 'event: error\r\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded sk-ant-test-only-token"}}';
  for (const [scenario, events, message, expectedDeltas] of [
    ['error before text', [error], 'Anthropic stream error (overloaded_error): Overloaded sk-ant-test-only-token', []],
    ['error after partial text', [start, partial, error], 'Anthropic stream error (overloaded_error): Overloaded sk-ant-test-only-token', ['Partial']],
    ['EOF before terminal completion', [start, partial, 'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}'], 'Anthropic stream ended before message_stop.', ['Partial']],
  ]) {
    test(`${name} propagates ${scenario} without returning partial success or retrying`, async () => {
      const deltas = [];
      await withAnthropicStream(events.join('\r\n\r\n') + '\r\n\r\n', async options => {
        await assertStrict.rejects(invoke(request, { ...options, onDelta: delta => deltas.push(delta) }), err => {
          assertStrict.equal(err.message, message);
          assertStrict.equal(sanitizeModelClientError(err), message.replace('sk-ant-test-only-token', '[REDACTED]'));
          return true;
        });
      });
      assertStrict.deepEqual(deltas, expectedDeltas);
    });
  }
  test(`${name} propagates reader transport failures after partial text`, async () => {
    const failure = new Error('Synthetic connection reset');
    const deltas = [];
    const wire = ([start, partial].join('\r\n\r\n') + '\r\n\r\n').replaceAll('\r\n', '\n');
    await withAnthropicStream(wire, async options => {
      await assertStrict.rejects(invoke(request, { ...options, onDelta: delta => deltas.push(delta) }), err => {
        assertStrict.equal(err, failure);
        return true;
      });
    }, failure);
    assertStrict.deepEqual(deltas, ['Partial']);
  });
  test(`${name} preserves completed normal and token-limit stream results`, async () => {
    for (const stopReason of ['end_turn', 'max_tokens']) {
      const events = [start, partial,
        `event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"output_tokens":42}}`,
        'event: message_stop\r\ndata: {"type":"message_stop"}',
      ];
      const deltas = [];
      const result = await withAnthropicStream(events.join('\r\n\r\n') + '\r\n\r\n', options =>
        invoke(request, { ...options, onDelta: delta => deltas.push(delta) }));
      assertStrict.equal(result.text, 'Partial');
      assertStrict.equal(result.model, 'claude-haiku-5-5');
      assertStrict.equal(result.stopReason, stopReason);
      assertStrict.deepEqual(result.usage, { input_tokens: 12, cache_read_input_tokens: 3, output_tokens: 42 });
      assertStrict.deepEqual(deltas, ['Partial']);
      assertStrict.equal(typeof result.firstDeltaAt, 'number');
      assertStrict.equal(typeof result.latencyMs, 'number');
      assertStrict.equal(typeof result.timeToFirstDeltaMs, 'number');
      assertStrict.ok(result.timeToFirstDeltaMs >= 0 && result.timeToFirstDeltaMs <= result.latencyMs);
    }
  });
}

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(err.stack || err.message || String(err));
  }
}
process.exit(failed ? 1 : 0);
