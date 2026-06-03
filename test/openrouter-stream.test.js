import { consumeOpenRouterMessageStream } from '../api/_lib/openrouter-stream.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

/**
 * Helper: create a mock ReadableStream body that yields the given text as
 * OpenAI-format SSE lines, split into chunks.
 */
function makeSSEBody(sseLines, chunkSize = 128) {
  const full = sseLines.join('\n');
  const chunks = [];
  for (let i = 0; i < full.length; i += chunkSize) {
    chunks.push(full.slice(i, i + chunkSize));
  }
  const encoder = new TextEncoder();
  return {
    getReader() {
      let idx = 0;
      return {
        async read() {
          if (idx >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: encoder.encode(chunks[idx++]) };
        },
        releaseLock() {},
      };
    },
  };
}

test('consumeOpenRouterMessageStream accumulates delta text', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":" World"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":"!"},"index":0}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.text === 'Hello World!', `Expected "Hello World!", got "${result.text}"`);
});

test('consumeOpenRouterMessageStream returns [DONE] termination', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"done"},"index":0}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.text === 'done');
});

test('consumeOpenRouterMessageStream extracts finish_reason', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"x"},"index":0,"finish_reason":"length"}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.stopReason === 'length', `Expected "length", got "${result.stopReason}"`);
});

test('consumeOpenRouterMessageStream extracts usage', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":42,"completion_tokens":7}}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.usage.input_tokens === 42, `Expected 42, got ${result.usage.input_tokens}`);
  assert(result.usage.output_tokens === 7, `Expected 7, got ${result.usage.output_tokens}`);
});

test('consumeOpenRouterMessageStream extracts model name', async () => {
  const sseLines = [
    'data: {"model":"anthropic/claude-sonnet-4-6","choices":[{"delta":{"content":"hi"}}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.model === 'anthropic/claude-sonnet-4-6', `Expected model, got ${result.model}`);
});

test('consumeOpenRouterMessageStream calls onDelta callbacks', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"A"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":"B"},"index":0}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const deltas = [];
  const result = await consumeOpenRouterMessageStream(body, {
    onDelta: (d) => { deltas.push(d); },
  });
  assert(deltas.join('') === 'AB', `Expected deltas "AB", got "${deltas.join('')}"`);
});

test('consumeOpenRouterMessageStream sets firstDeltaAt on first delta', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"first"},"index":0}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.firstDeltaAt != null, 'Expected firstDeltaAt to be set');
});

test('consumeOpenRouterMessageStream handles empty body', async () => {
  const body = makeSSEBody([]);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.text === '');
  assert(result.model == null);
  assert(result.usage.input_tokens === null);
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