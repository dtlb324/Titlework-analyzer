import {
  abstractionApiKeyError,
  invokeModel,
  invokeAnthropicModelStream,
  isGeminiModel,
  mapModelResponseToAnalyzeProxy,
  shouldUseOpenRouter,
  openRouterApiKeyError,
} from '../api/_lib/model-client.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

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
    model: 'claude-sonnet-4-6',
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

// Regression: the OpenRouter streaming path must NOT call response.json() on a
// successful response. A fetch body is single-consumption — draining it as JSON
// leaves consumeOpenRouterMessageStream with an empty stream and an empty opinion.
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

  global.fetch = async () => {
    // Model real fetch single-consumption: reading the body as JSON drains it,
    // after which the stream reader yields nothing.
    let bodyConsumed = false;
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      json: async () => { bodyConsumed = true; return {}; },
      body: {
        getReader() {
          let idx = 0;
          const chunks = bodyConsumed ? [] : [sseLines.join('\n')];
          return {
            async read() {
              if (idx >= chunks.length) return { done: true, value: undefined };
              return { done: false, value: encoder.encode(chunks[idx++]) };
            },
            releaseLock() {},
          };
        },
      },
    };
  };

  try {
    const result = await invokeModel({
      model: 'anthropic/claude-sonnet-4-6', // slash-name → OpenRouter
      maxTokens: 16000, // > NON_STREAMING_MAX_TOKENS → streaming path
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
