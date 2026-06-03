import {
  shouldUseOpenRouter,
  openRouterApiKeyError,
  buildOpenRouterRequestBody,
  normalizeOpenRouterResponse,
  invokeOpenRouterModel,
} from '../api/_lib/openrouter-request.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// ── shouldUseOpenRouter ───────────────────────────────────────────────

test('shouldUseOpenRouter returns false by default for simple claude models', () => {
  const prev = process.env.MODEL_PROVIDER;
  delete process.env.MODEL_PROVIDER;
  assert(shouldUseOpenRouter('claude-sonnet-4-6') === false);
  process.env.MODEL_PROVIDER = prev;
});

test('shouldUseOpenRouter returns true for slash-names', () => {
  const prev = process.env.MODEL_PROVIDER;
  delete process.env.MODEL_PROVIDER;
  assert(shouldUseOpenRouter('anthropic/claude-sonnet-4-6') === true);
  assert(shouldUseOpenRouter('openai/gpt-4o') === true);
  assert(shouldUseOpenRouter('google/gemini-2.5-flash') === true);
  process.env.MODEL_PROVIDER = prev;
});

test('shouldUseOpenRouter returns true when MODEL_PROVIDER=openrouter', () => {
  const prev = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = 'openrouter';
  assert(shouldUseOpenRouter('claude-sonnet-4-6') === true);
  assert(shouldUseOpenRouter('gemini-2.5-flash') === true);
  process.env.MODEL_PROVIDER = prev;
});

test('shouldUseOpenRouter ignores MODEL_PROVIDER other than openrouter', () => {
  const prev = process.env.MODEL_PROVIDER;
  process.env.MODEL_PROVIDER = 'anthropic';
  assert(shouldUseOpenRouter('claude-sonnet-4-6') === false);
  process.env.MODEL_PROVIDER = prev;
});

// ── openRouterApiKeyError ────────────────────────────────────────────

test('openRouterApiKeyError returns error when key is missing', () => {
  const prev = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  const err = openRouterApiKeyError();
  assert(err != null, 'Expected error message');
  assert(err.includes('OPENROUTER_API_KEY'));
  process.env.OPENROUTER_API_KEY = prev;
});

test('openRouterApiKeyError returns null when key is set', () => {
  const prev = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'sk-or-valid-key';
  assert(openRouterApiKeyError() === null);
  process.env.OPENROUTER_API_KEY = prev;
});

// ── buildOpenRouterRequestBody ───────────────────────────────────────

test('buildOpenRouterRequestBody maps model with auto name-mapping', () => {
  const req = buildOpenRouterRequestBody({ model: 'claude-sonnet-4-6', maxTokens: 100, messages: [] });
  assert(req.model === 'anthropic/claude-sonnet-4-6', `Expected anthropic prefix, got ${req.model}`);
});

test('buildOpenRouterRequestBody maps gemini model automatically', () => {
  const req = buildOpenRouterRequestBody({ model: 'gemini-2.5-flash', maxTokens: 100, messages: [] });
  assert(req.model === 'google/gemini-2.5-flash', `Expected google/ prefix, got ${req.model}`);
});

test('buildOpenRouterRequestBody passes slash-names through unchanged', () => {
  const req = buildOpenRouterRequestBody({ model: 'openai/gpt-4o', maxTokens: 100, messages: [] });
  assert(req.model === 'openai/gpt-4o', `Expected unchanged, got ${req.model}`);
});

test('buildOpenRouterRequestBody places system as leading message', () => {
  const req = buildOpenRouterRequestBody({
    model: 'claude-sonnet-4-6',
    maxTokens: 100,
    system: 'you are helpful',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert(req.messages[0].role === 'system');
  assert(req.messages[0].content === 'you are helpful');
});

test('buildOpenRouterRequestBody handles array system', () => {
  const req = buildOpenRouterRequestBody({
    model: 'claude-sonnet-4-6',
    maxTokens: 100,
    system: [{ text: 'part1' }, { text: 'part2' }],
    messages: [],
  });
  assert(req.messages[0].content === 'part1\npart2');
});

test('buildOpenRouterRequestBody translates text blocks', () => {
  const req = buildOpenRouterRequestBody({
    model: 'claude-sonnet-4-6',
    maxTokens: 100,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  });
  assert(req.messages[0].content[0].type === 'text');
  assert(req.messages[0].content[0].text === 'hello');
});

test('buildOpenRouterRequestBody translates image blocks (base64)', () => {
  const req = buildOpenRouterRequestBody({
    model: 'claude-sonnet-4-6',
    maxTokens: 100,
    messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', data: 'abc123', media_type: 'image/png' } }],
    }],
  });
  const part = req.messages[0].content[0];
  assert(part.type === 'image_url');
  assert(part.image_url.url.startsWith('data:image/png;base64,abc123'));
});

test('buildOpenRouterRequestBody translates document blocks (base64 PDF)', () => {
  const req = buildOpenRouterRequestBody({
    model: 'claude-sonnet-4-6',
    maxTokens: 100,
    messages: [{
      role: 'user',
      content: [{ type: 'document', source: { type: 'base64', data: 'pdfdata', media_type: 'application/pdf', filename: 'doc.pdf' } }],
    }],
  });
  const part = req.messages[0].content[0];
  assert(part.type === 'file');
  assert(part.file.filename === 'doc.pdf');
  assert(part.file.file_data === 'data:application/pdf;base64,pdfdata');
});

test('buildOpenRouterRequestBody throws on file_uri source', () => {
  let threw = false;
  try {
    buildOpenRouterRequestBody({
      model: 'claude-sonnet-4-6',
      maxTokens: 100,
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'file_uri', uri: 'gcs://bucket/file', media_type: 'image/png' } }],
      }],
    });
  } catch (err) {
    threw = true;
    assert(err.statusCode === 400, `Expected 400, got ${err.statusCode}`);
    assert(err.message.includes('file_uri'));
  }
  assert(threw, 'Expected throw for file_uri');
});

test('buildOpenRouterRequestBody preserves cache_control for anthropic/* targets', () => {
  const req = buildOpenRouterRequestBody({
    model: 'anthropic/claude-sonnet-4-6',
    maxTokens: 100,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }],
    }],
  });
  assert(req.messages[0].content[0].cache_control !== undefined, 'Expected cache_control preserved');
});

test('buildOpenRouterRequestBody strips cache_control for non-anthropic targets', () => {
  const req = buildOpenRouterRequestBody({
    model: 'openai/gpt-4o',
    maxTokens: 100,
    messages: [{
      role: 'user',
      content: [{ type: 'text', text: 'cached', cache_control: { type: 'ephemeral' } }],
    }],
  });
  assert(req.messages[0].content[0].cache_control === undefined, 'Expected cache_control stripped');
});

test('buildOpenRouterRequestBody maps max_tokens', () => {
  const req = buildOpenRouterRequestBody({ model: 'claude-sonnet-4-6', maxTokens: 4096, messages: [] });
  assert(req.max_tokens === 4096);
});

// ── normalizeOpenRouterResponse ──────────────────────────────────────

test('normalizeOpenRouterResponse extracts text and usage', () => {
  const data = {
    model: 'anthropic/claude-sonnet-4-6',
    choices: [{ message: { content: 'hello world', role: 'assistant' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  const result = normalizeOpenRouterResponse(data, 'claude-sonnet-4-6');
  assert(result.text === 'hello world');
  assert(result.model === 'anthropic/claude-sonnet-4-6');
  assert(result.usage.input_tokens === 10);
  assert(result.usage.output_tokens === 5);
  assert(result.stopReason === 'stop');
});

test('normalizeOpenRouterResponse handles null input gracefully', () => {
  const result = normalizeOpenRouterResponse({}, 'claude-sonnet-4-6');
  assert(result.text === '');
  assert(result.usage.input_tokens === null);
  assert(result.usage.output_tokens === null);
});

// ── invokeOpenRouterModel ────────────────────────────────────────────

test('invokeOpenRouterModel calls fetch with correct URL and headers', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  const prevFetch = global.fetch;
  process.env.OPENROUTER_API_KEY = 'sk-or-test-key';
  let capturedUrl = '';
  let capturedHeaders = {};
  let capturedBody = null;
  global.fetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = init.headers;
    capturedBody = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'response text' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
        model: 'anthropic/claude-sonnet-4-6',
      }),
    };
  };
  const result = await invokeOpenRouterModel({
    model: 'claude-sonnet-4-6',
    maxTokens: 100,
    system: 'system',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  });
  global.fetch = prevFetch;
  if (prevKey) process.env.OPENROUTER_API_KEY = prevKey;
  else delete process.env.OPENROUTER_API_KEY;

  assert(capturedUrl.includes('openrouter.ai/api/v1/chat/completions'), `Wrong URL: ${capturedUrl}`);
  assert(capturedHeaders['Authorization'] === 'Bearer sk-or-test-key', 'Wrong auth header');
  assert(capturedHeaders['HTTP-Referer'] !== undefined, 'Missing HTTP-Referer');
  assert(capturedHeaders['X-Title'] !== undefined, 'Missing X-Title');
  assert(capturedBody.model === 'anthropic/claude-sonnet-4-6', 'Wrong model in body');
  assert(result.text === 'response text', 'Wrong response text');
  assert(result.usage.input_tokens === 5, 'Wrong usage input');
  assert(result.usage.output_tokens === 3, 'Wrong usage output');
});

test('invokeOpenRouterModel throws key error when API key is missing', async () => {
  const prevKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    await invokeOpenRouterModel({
      model: 'claude-sonnet-4-6',
      maxTokens: 100,
      messages: [],
    });
    assert(false, 'Expected throw');
  } catch (err) {
    assert(err.statusCode === 503, `Expected 503, got ${err.statusCode}`);
    assert(err.message.includes('OPENROUTER_API_KEY'));
  }
  process.env.OPENROUTER_API_KEY = prevKey;
});

// ── Run ──────────────────────────────────────────────────────────────

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