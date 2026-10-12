import assertStrict from 'node:assert/strict';
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
    // Successful Anthropic streams require the protocol terminal event, not just EOF.
    'event: message_stop\ndata: {"type":"message_stop"}',
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
    // Keep this malformed-block test protocol-complete on its successful path.
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ];
  const result = await consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)]));
  assert(result.text === 'ok', 'Expected lone delta text');
});

test('consumeAnthropicMessageStream keeps message_start input usage and merges later output usage', async () => {
  const events = [
    'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":1200,"cache_read_input_tokens":30,"output_tokens":1}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
    // Usage remains provisional until the terminal event completes the message.
    'event: message_stop\ndata: {"type":"message_stop"}',
  ];
  const result = await consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)]), {});
  assert(result.usage.input_tokens === 1200 && result.usage.cache_read_input_tokens === 30, 'Expected input usage from message_start');
  assert(result.usage.output_tokens === 42, 'Expected final output usage from message_delta');
});

test('consumeAnthropicMessageStream rejects a structured error before text', async () => {
  const events = ['event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'];
  const seenEvents = [];
  const deltas = [];
  await assertStrict.rejects(
    consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)]), {
      onEvent: event => seenEvents.push(event.data.type),
      onDelta: delta => deltas.push(delta),
    }),
    { message: 'Anthropic stream error (overloaded_error): Overloaded' },
  );
  assertStrict.deepEqual(seenEvents, ['error']);
  assertStrict.deepEqual(deltas, []);
});

test('consumeAnthropicMessageStream rejects a structured error after partial text', async () => {
  const events = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}',
    // Error payloads are authoritative even when the optional SSE event field is absent.
    'data: {"type":"error","error":{"type":"api_error","message":"Interrupted"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
    'event: message_stop\ndata: {"type":"message_stop"}',
  ];
  const deltas = [];
  await assertStrict.rejects(
    consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)]), {
      onDelta: (delta, fullText) => deltas.push({ delta, fullText }),
    }),
    { message: 'Anthropic stream error (api_error): Interrupted' },
  );
  assertStrict.deepEqual(deltas, [{ delta: 'Partial', fullText: 'Partial' }]);
});

test('consumeAnthropicMessageStream rejects EOF before message_stop', async () => {
  const events = [
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
  ];
  await assertStrict.rejects(
    consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)])),
    { message: 'Anthropic stream ended before message_stop.' },
  );
});

test('consumeAnthropicMessageStream requires a valid stop reason at message_stop', async () => {
  for (const stopReason of [undefined, null, '', true, {}, 'unknown_reason']) {
    const events = [
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason } })}`,
      'event: message_stop\ndata: {"type":"message_stop"}',
    ];
    await assertStrict.rejects(
      consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)])),
      { message: 'Anthropic message_stop received without a valid stop reason.' },
      `Expected rejection for ${JSON.stringify(stopReason)}`,
    );
  }
});

test('consumeAnthropicMessageStream completes LF and CRLF streams across fragmented boundaries', async () => {
  for (const stopReason of ['end_turn', 'max_tokens']) {
    const events = [
      ': keep-alive',
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-5-5","usage":{"input_tokens":1200,"cache_read_input_tokens":30,"cache_creation_input_tokens":20,"output_tokens":1}}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"A🧾"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"B"}}',
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"},"usage":{"output_tokens":42}}`,
      'event: message_stop\ndata: {"type":"message_stop"}',
    ];
    for (const newline of ['\n', '\r\n']) {
      const wire = (events.join('\n\n') + '\n\n').replaceAll('\n', newline);
      const bytes = new TextEncoder().encode(wire);
      for (const chunks of [[bytes], Array.from(bytes, byte => Uint8Array.of(byte))]) {
        const deltas = [];
        const seenEvents = [];
        const started = Date.now();
        const result = await consumeAnthropicMessageStream(mockStreamBody(chunks), {
          onDelta: async (delta, fullText) => deltas.push({ delta, fullText }),
          onEvent: event => seenEvents.push(event.data.type),
        });
        assertStrict.deepEqual({ ...result, firstDeltaAt: undefined }, {
          text: 'A🧾B', model: 'claude-haiku-5-5', stopReason,
          usage: { input_tokens: 1200, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 42 },
          firstDeltaAt: undefined,
        });
        assertStrict.equal(typeof result.firstDeltaAt, 'number');
        assertStrict.ok(result.firstDeltaAt >= started && result.firstDeltaAt <= Date.now());
        assertStrict.deepEqual(deltas, [{ delta: 'A🧾', fullText: 'A🧾' }, { delta: 'B', fullText: 'A🧾B' }]);
        assertStrict.deepEqual(seenEvents, ['message_start', 'content_block_delta', 'content_block_delta', 'message_delta', 'message_stop']);
      }
    }
  }
});

test('consumeAnthropicMessageStream rejects empty and unterminated streams', async () => {
  for (const wire of [
    '',
    'data: [DONE]\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Partial"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n',
  ]) {
    await assertStrict.rejects(
      consumeAnthropicMessageStream(mockStreamBody([new TextEncoder().encode(wire)])),
      { message: 'Anthropic stream ended before message_stop.' },
    );
  }
});

test('consumeAnthropicMessageStream preserves all documented completed stop reasons', async () => {
  for (const stopReason of ['end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn', 'refusal', 'model_context_window_exceeded']) {
    const events = [
      `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"${stopReason}"}}`,
      'event: message_stop\ndata: {"type":"message_stop"}',
    ];
    const result = await consumeAnthropicMessageStream(mockStreamBody([encodeSse(events)]));
    assertStrict.equal(result.stopReason, stopReason);
    assertStrict.equal(result.text, '');
    assertStrict.equal(result.firstDeltaAt, null);
  }
});

test('consumeAnthropicMessageStream rejects fragmented CRLF error events', async () => {
  const bytes = new TextEncoder().encode('event: error\r\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\r\n\r\n');
  await assertStrict.rejects(
    consumeAnthropicMessageStream(mockStreamBody(Array.from(bytes, byte => Uint8Array.of(byte)))),
    { message: 'Anthropic stream error (overloaded_error): Overloaded' },
  );
});

test('consumeAnthropicMessageStream cancels an abandoned open stream and releases its reader', async () => {
  let cancellations = 0;
  let cancellationReason;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encodeSse(['event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Synthetic overload"}}']));
    },
    cancel(reason) { cancellations++; cancellationReason = reason; },
  });
  let failure;
  await assertStrict.rejects(consumeAnthropicMessageStream(body), error => {
    failure = error;
    assertStrict.equal(error.message, 'Anthropic stream error (overloaded_error): Synthetic overload');
    return true;
  });
  assertStrict.equal(cancellations, 1, 'An abandoned open response must be cancelled once');
  assertStrict.equal(cancellationReason, failure, 'Cancellation must carry the original failure');
  assertStrict.equal(body.locked, false, 'The reader must release its lock after rejection');
});

function observeReader(body) {
  const stats = { cancellations: 0, releases: 0 };
  const getReader = body.getReader.bind(body);
  body.getReader = () => {
    const reader = getReader();
    return {
      read: () => reader.read(),
      cancel: reason => { stats.cancellations++; return reader.cancel(reason); },
      releaseLock: () => { stats.releases++; reader.releaseLock(); },
    };
  };
  return stats;
}

const partialEvent = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Synthetic text"}}';
const completeEvents = [
  partialEvent,
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}',
  'event: message_stop\ndata: {"type":"message_stop"}',
];

test('consumeAnthropicMessageStream releases a normally exhausted reader without cancellation', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(encodeSse(completeEvents)); controller.close(); } });
  const stats = observeReader(body);
  const result = await consumeAnthropicMessageStream(body);
  assertStrict.equal(result.text, 'Synthetic text');
  assertStrict.equal(result.stopReason, 'end_turn');
  assertStrict.deepEqual(result.usage, { output_tokens: 3 });
  assertStrict.deepEqual(stats, { cancellations: 0, releases: 1 });
  assertStrict.equal(body.locked, false);
});

test('consumeAnthropicMessageStream releases premature EOF without cancelling an already exhausted stream', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(encodeSse([partialEvent])); controller.close(); } });
  const stats = observeReader(body);
  await assertStrict.rejects(consumeAnthropicMessageStream(body), { message: 'Anthropic stream ended before message_stop.' });
  assertStrict.deepEqual(stats, { cancellations: 0, releases: 1 });
  assertStrict.equal(body.locked, false);
});

test('consumeAnthropicMessageStream releases an already failed transport without cancelling it again', async () => {
  const failure = new Error('Synthetic transport failure');
  const body = new ReadableStream({ start(controller) { controller.error(failure); } });
  const stats = observeReader(body);
  await assertStrict.rejects(consumeAnthropicMessageStream(body), error => error === failure);
  assertStrict.deepEqual(stats, { cancellations: 0, releases: 1 });
  assertStrict.equal(body.locked, false);
});

test('consumeAnthropicMessageStream cancels on callback failure without replacing that failure', async () => {
  for (const callback of ['onDelta', 'onEvent']) {
    const failure = new Error(`Synthetic ${callback} failure`);
    let reason;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(encodeSse([partialEvent])); },
      cancel(error) { reason = error; },
    });
    const stats = observeReader(body);
    const handler = callback === 'onDelta' ? async () => { throw failure; } : () => { throw failure; };
    await assertStrict.rejects(consumeAnthropicMessageStream(body, { [callback]: handler }), error => error === failure);
    assertStrict.equal(reason, failure);
    assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
    assertStrict.equal(body.locked, false);
  }
});

test('consumeAnthropicMessageStream cancels a malformed terminal response and releases the reader', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(encodeSse(['event: message_stop\ndata: {"type":"message_stop"}'])); } });
  const stats = observeReader(body);
  await assertStrict.rejects(consumeAnthropicMessageStream(body), { message: 'Anthropic message_stop received without a valid stop reason.' });
  assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
  assertStrict.equal(body.locked, false);
});

test('consumeAnthropicMessageStream observes rejected cancellation without hiding the original error', async () => {
  const failures = [];
  const unhandled = error => failures.push(error);
  process.on('unhandledRejection', unhandled);
  try {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(encodeSse(['event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Original failure"}}'])); },
      cancel() { throw new Error('Synthetic cancellation rejection'); },
    });
    const stats = observeReader(body);
    await assertStrict.rejects(consumeAnthropicMessageStream(body), { message: 'Anthropic stream error (api_error): Original failure' });
    await new Promise(resolve => setImmediate(resolve));
    assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
    assertStrict.equal(body.locked, false);
    assertStrict.deepEqual(failures, []);
  } finally { process.off('unhandledRejection', unhandled); }
});

test('consumeAnthropicMessageStream observes cancellation that rejects after the original failure is reported', async () => {
  let rejectCancellation;
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const body = new ReadableStream({
      start(controller) { controller.enqueue(encodeSse(['event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Original failure"}}'])); },
      cancel() { return new Promise((_, reject) => { rejectCancellation = reject; }); },
    });
    const stats = observeReader(body);
    await assertStrict.rejects(consumeAnthropicMessageStream(body), { message: 'Anthropic stream error (api_error): Original failure' });
    assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
    assertStrict.equal(body.locked, false);
    rejectCancellation(new Error('Synthetic delayed cancellation rejection'));
    await new Promise(resolve => setImmediate(resolve));
    assertStrict.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('consumeAnthropicMessageStream does not wait for stalled cancellation before reporting failure', async () => {
  const body = new ReadableStream({
    start(controller) { controller.enqueue(encodeSse(['event: error\ndata: {"type":"error","error":{"type":"api_error","message":"Original failure"}}'])); },
    cancel() { return new Promise(() => {}); },
  });
  const stats = observeReader(body);
  const outcome = await Promise.race([
    consumeAnthropicMessageStream(body).then(() => 'unexpected success', error => error),
    new Promise(resolve => setImmediate(() => resolve('still waiting for cancellation'))),
  ]);
  assertStrict.equal(outcome?.message, 'Anthropic stream error (api_error): Original failure');
  assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
  assertStrict.equal(body.locked, false);
});

test('consumeAnthropicMessageStream preserves results and errors when reader methods throw during cleanup', async () => {
  for (const success of [true, false]) {
    const failure = new Error('Original callback failure');
    let cancellations = 0, releases = 0, reads = 0;
    const reader = {
      read: async () => reads++ === 0 ? { done: false, value: encodeSse(completeEvents) } : { done: true },
      cancel() { cancellations++; throw new Error('Synthetic synchronous cancellation failure'); },
      releaseLock() { releases++; throw new Error('Synthetic release failure'); },
    };
    const promise = consumeAnthropicMessageStream({ getReader: () => reader }, success ? {} : { onEvent() { throw failure; } });
    if (success) assertStrict.equal((await promise).text, 'Synthetic text');
    else await assertStrict.rejects(promise, error => error === failure);
    assertStrict.equal(cancellations, success ? 0 : 1);
    assertStrict.equal(releases, 1);
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
