import { consumeAnthropicMessageStream } from '../api/_lib/anthropic-stream.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function encodeSse(events) {
  return new TextEncoder().encode(events.join('\n\n') + '\n\n');
}

function mockStreamBody(chunks) {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          const value = chunks[index++];
          return { done: false, value };
        },
      };
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('consumeAnthropicMessageStream accumulates text deltas', async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-sonnet-5"}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  ];
  const deltas = [];
  const result = await consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)]), {
    onDelta: async (delta, fullText) => {
      deltas.push({ delta, fullText });
    },
  });
  assert(result.text === 'Hello world', `Expected merged text, got ${result.text}`);
  assert(result.model === 'claude-sonnet-5', 'Expected model from message_start');
  assert(deltas.length === 2, 'Expected two delta callbacks');
  assert(result.firstDeltaAt != null, 'Expected first delta timestamp');
});

test('consumeAnthropicMessageStream ignores malformed blocks', async () => {
  const events = [
    ': keep-alive',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  ];
  const result = await consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)]));
  assert(result.text === 'ok', 'Expected lone delta text');
});

test('consumeAnthropicMessageStream keeps message_start input usage and merges later output usage', async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":1200,"cache_read_input_tokens":30,"output_tokens":1}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
  ];
  const result = await consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)]), {});
  assert(result.usage.input_tokens === 1200 && result.usage.cache_read_input_tokens === 30, 'Expected input usage from message_start');
  assert(result.usage.output_tokens === 42, 'Expected final output usage from message_delta');
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
