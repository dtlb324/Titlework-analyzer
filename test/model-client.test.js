import {
  abstractionApiKeyError,
  invokeModel,
  isGeminiModel,
  mapModelResponseToAnalyzeProxy,
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
