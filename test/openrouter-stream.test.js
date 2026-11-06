import assertStrict from 'node:assert/strict';
import { consumeOpenRouterMessageStream } from '../api/_lib/openrouter-stream.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

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
    'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.text === 'Hello World!', `Expected "Hello World!", got "${result.text}"`);
});

test('consumeOpenRouterMessageStream returns [DONE] termination', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"done"},"index":0}]}',
    'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.text === 'done');
});

// Superseded pin (finding 6): was `stopReason === 'length'`. Old intent: surface the provider's finish
// reason. New intent: same fixture, but OpenRouter's token-limit 'length' is reported as the shared
// 'max_tokens' so truncation is recognized downstream. The text assertion is unchanged.
test('consumeOpenRouterMessageStream extracts finish_reason', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"x"},"index":0,"finish_reason":"length"}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.stopReason === 'max_tokens', `Expected "max_tokens", got "${result.stopReason}"`);
  assert(result.text === 'x', `Expected "x", got "${result.text}"`);
});

test('consumeOpenRouterMessageStream extracts usage', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":42,"completion_tokens":7}}',
    'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.usage.input_tokens === 42, `Expected 42, got ${result.usage.input_tokens}`);
  assert(result.usage.output_tokens === 7, `Expected 7, got ${result.usage.output_tokens}`);
});

test('consumeOpenRouterMessageStream extracts model name', async () => {
  const sseLines = [
    'data: {"model":"anthropic/claude-sonnet-5","choices":[{"delta":{"content":"hi"}}]}',
    'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.model === 'anthropic/claude-sonnet-5', `Expected model, got ${result.model}`);
});

test('consumeOpenRouterMessageStream calls onDelta callbacks', async () => {
  const sseLines = [
    'data: {"choices":[{"delta":{"content":"A"},"index":0}]}',
    'data: {"choices":[{"delta":{"content":"B"},"index":0}]}',
    'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}',
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
    'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}',
    'data: [DONE]',
  ];
  const body = makeSSEBody(sseLines);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.firstDeltaAt != null, 'Expected firstDeltaAt to be set');
});

// Superseded pin (finding 5): an empty body used to resolve as a successful empty completion.
// Old intent: "no content yields empty text and null metadata". New intent: a body with no
// protocol completion is rejected, while a completed stream without content still yields empty text.
test('consumeOpenRouterMessageStream rejects an empty body', async () => {
  const body = makeSSEBody([]);
  let error = null;
  try { await consumeOpenRouterMessageStream(body); } catch (err) { error = err; }
  assert(error?.message === 'OpenRouter stream ended before [DONE].', `Expected EOF rejection, got ${error?.message}`);
});

test('consumeOpenRouterMessageStream handles a completed stream with no content', async () => {
  const body = makeSSEBody([
    'data: {"choices":[{"delta":{},"index":0,"finish_reason":"stop"}]}',
    'data: [DONE]',
  ]);
  const result = await consumeOpenRouterMessageStream(body);
  assert(result.text === '');
  assert(result.model == null);
  assert(result.usage.input_tokens === null);
});

// --- Provider bug-hunt regressions (findings 4, 5, 6). Registered before the runner below. ---

const encoder = new TextEncoder();
const frame = payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
const textFrame = text => frame({ choices: [{ index: 0, delta: { content: text } }] });
const stopFrame = (finish_reason = 'stop', extra = {}) => frame({ choices: [{ index: 0, delta: {}, finish_reason }], ...extra });
const doneFrame = 'data: [DONE]\n\n';

function nativeBody(wire, { close = true, onCancel } = {}) {
  const bytes = typeof wire === 'string' ? encoder.encode(wire) : wire;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      if (close) controller.close();
    },
    cancel(reason) { onCancel?.(reason); },
  });
}

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

test('consumeOpenRouterMessageStream awaits async onDelta with (delta, fullText) before reading further', async () => {
  const wire = textFrame('Hel') + textFrame('lo') + stopFrame() + doneFrame;
  const log = [];
  const result = await consumeOpenRouterMessageStream(nativeBody(wire), {
    onDelta: async (delta, fullText) => {
      log.push(`start:${delta}|${fullText}`);
      await new Promise(resolve => setImmediate(resolve));
      log.push(`end:${delta}`);
    },
  });
  assertStrict.deepEqual(log, ['start:Hel|Hel', 'end:Hel', 'start:lo|Hello', 'end:lo']);
  assertStrict.equal(result.text, 'Hello');
});

test('consumeOpenRouterMessageStream propagates an async onDelta rejection instead of leaving it unhandled', async () => {
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const failure = new Error('Synthetic preview write failure');
    const wire = textFrame('Hello') + stopFrame() + doneFrame;
    await assertStrict.rejects(
      consumeOpenRouterMessageStream(nativeBody(wire), { onDelta: async () => { throw failure; } }),
      error => error === failure,
    );
    await new Promise(resolve => setImmediate(resolve));
    assertStrict.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});
test('consumeOpenRouterMessageStream rejects an SSE error frame instead of returning partial text', async () => {
  const errorFrame = frame({ error: { code: 502, message: 'provider failed mid-stream' } });
  const errorWithFinish = frame({ error: { code: 502, message: 'provider failed mid-stream' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] });
  const cases = [
    ['error after partial text, clean EOF', textFrame('Partial') + errorFrame, ['Partial']],
    ['error before any text', errorFrame, []],
    ['error frame carrying finish_reason error, followed by [DONE]', textFrame('Partial') + errorWithFinish + doneFrame, ['Partial']],
  ];
  for (const [label, wire, expectedDeltas] of cases) {
    const deltas = [];
    const events = [];
    await assertStrict.rejects(
      consumeOpenRouterMessageStream(nativeBody(wire), {
        onDelta: delta => { deltas.push(delta); },
        onEvent: event => { events.push(Boolean(event.error)); },
      }),
      { message: 'OpenRouter stream error (502): provider failed mid-stream' },
      label,
    );
    assertStrict.deepEqual(deltas, expectedDeltas, label);
    assertStrict.ok(events.includes(true), `${label}: onEvent must see the error frame before the rejection`);
  }
});

test('consumeOpenRouterMessageStream rejects a fragmented CRLF error frame', async () => {
  const bytes = encoder.encode(textFrame('Partial').replaceAll('\n', '\r\n') + frame({ error: { code: 'overloaded', message: 'Overloaded' } }).replaceAll('\n', '\r\n'));
  await assertStrict.rejects(
    consumeOpenRouterMessageStream({ getReader: () => {
      let index = 0;
      return { read: async () => index < bytes.length ? { done: false, value: bytes.slice(index, ++index) } : { done: true } };
    } }),
    { message: 'OpenRouter stream error (overloaded): Overloaded' },
  );
});

test('consumeOpenRouterMessageStream rejects streams that end without [DONE] or a valid finish reason', async () => {
  const cases = [
    ['empty body', '', 'OpenRouter stream ended before [DONE].'],
    ['EOF after text and finish_reason but no [DONE]', textFrame('Partial') + stopFrame(), 'OpenRouter stream ended before [DONE].'],
    ['EOF after text only', textFrame('Partial'), 'OpenRouter stream ended before [DONE].'],
    ['EOF after only a keepalive and invalid data', ': OPENROUTER PROCESSING\n\ndata: not json\n\n', 'OpenRouter stream ended before [DONE].'],
    ['[DONE] without any finish_reason', textFrame('Partial') + doneFrame, 'OpenRouter [DONE] received without a valid finish reason.'],
    ['[DONE] with finish_reason error', textFrame('Partial') + stopFrame('error') + doneFrame, 'OpenRouter [DONE] received without a valid finish reason.'],
    ['[DONE] with unknown finish_reason', textFrame('Partial') + stopFrame('mystery') + doneFrame, 'OpenRouter [DONE] received without a valid finish reason.'],
  ];
  for (const [label, wire, message] of cases) {
    await assertStrict.rejects(consumeOpenRouterMessageStream(nativeBody(wire)), { message }, label);
  }
});

test('consumeOpenRouterMessageStream completes only on a valid finish reason followed by [DONE], keeping usage that arrives in between', async () => {
  for (const finishReason of ['stop', 'tool_calls', 'content_filter']) {
    const wire = frame({ model: 'anthropic/claude-sonnet-5.5', choices: [{ index: 0, delta: { content: 'A' } }] })
      + textFrame('B')
      + stopFrame(finishReason)
      + frame({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 90 } })
      + doneFrame;
    const result = await consumeOpenRouterMessageStream(nativeBody(wire));
    assertStrict.equal(result.text, 'AB');
    assertStrict.equal(result.stopReason, finishReason);
    assertStrict.equal(result.model, 'anthropic/claude-sonnet-5.5');
    assertStrict.deepEqual(result.usage, { input_tokens: 100, output_tokens: 90 });
  }
});

const completeWire = textFrame('Synthetic text') + stopFrame('stop', { usage: { prompt_tokens: 7, completion_tokens: 3 } }) + doneFrame;

test('consumeOpenRouterMessageStream releases a normally exhausted reader without cancellation', async () => {
  const body = nativeBody(completeWire);
  const stats = observeReader(body);
  const result = await consumeOpenRouterMessageStream(body);
  assertStrict.equal(result.text, 'Synthetic text');
  assertStrict.equal(result.stopReason, 'stop');
  assertStrict.deepEqual(result.usage, { input_tokens: 7, output_tokens: 3 });
  // Superseded pin (review follow-up): this used to expect cancellations 0 because the consumer read to EOF
  // after [DONE]. It now returns at [DONE] and cancels whatever is left, so a late transport error or a body
  // that never closes cannot discard a finished generation.
  assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
  assertStrict.equal(body.locked, false);
});

test('consumeOpenRouterMessageStream returns at [DONE] and ignores frames after it', async () => {
  const body = nativeBody(completeWire + textFrame('ignored'));
  const stats = observeReader(body);
  const deltas = [];
  const result = await consumeOpenRouterMessageStream(body, { onDelta: delta => { deltas.push(delta); } });
  assertStrict.equal(result.text, 'Synthetic text');
  assertStrict.deepEqual(deltas, ['Synthetic text']);
  // Superseded pin (review follow-up): was { cancellations: 0 } when the consumer drained to EOF.
  assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
});

test('consumeOpenRouterMessageStream returns the finished text when the body never closes after [DONE]', async () => {
  const body = nativeBody(completeWire, { close: false });
  const stats = observeReader(body);
  const result = await Promise.race([
    consumeOpenRouterMessageStream(body),
    new Promise(resolve => setTimeout(() => resolve('hung after [DONE]'), 500)),
  ]);
  assertStrict.notEqual(result, 'hung after [DONE]');
  assertStrict.equal(result.text, 'Synthetic text');
  assertStrict.equal(result.stopReason, 'stop');
  assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
});

test('consumeOpenRouterMessageStream keeps the finished text when the transport fails after [DONE]', async () => {
  const failure = new Error('Synthetic late transport failure');
  let pulls = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (pulls++ === 0) controller.enqueue(encoder.encode(completeWire));
      else controller.error(failure);
    },
  });
  const stats = observeReader(body);
  const result = await consumeOpenRouterMessageStream(body);
  assertStrict.equal(result.text, 'Synthetic text');
  assertStrict.equal(stats.releases, 1);
});

test('consumeOpenRouterMessageStream cancels an abandoned open stream with the original failure and releases its reader', async () => {
  let cancellationReason;
  let cancellations = 0;
  const body = nativeBody(textFrame('Partial') + frame({ error: { code: 502, message: 'Synthetic overload' } }), {
    close: false,
    onCancel: reason => { cancellations++; cancellationReason = reason; },
  });
  const stats = observeReader(body);
  let failure;
  await assertStrict.rejects(consumeOpenRouterMessageStream(body), error => { failure = error; return true; });
  assertStrict.equal(failure.message, 'OpenRouter stream error (502): Synthetic overload');
  assertStrict.equal(cancellations, 1);
  assertStrict.equal(cancellationReason, failure);
  assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
  assertStrict.equal(body.locked, false);
});

test('consumeOpenRouterMessageStream releases premature EOF and failed transports without cancelling them again', async () => {
  const eof = nativeBody(textFrame('Partial'));
  const eofStats = observeReader(eof);
  await assertStrict.rejects(consumeOpenRouterMessageStream(eof), { message: 'OpenRouter stream ended before [DONE].' });
  assertStrict.deepEqual(eofStats, { cancellations: 0, releases: 1 });
  assertStrict.equal(eof.locked, false);

  const failure = new Error('Synthetic transport failure');
  const broken = new ReadableStream({ start(controller) { controller.error(failure); } });
  const brokenStats = observeReader(broken);
  await assertStrict.rejects(consumeOpenRouterMessageStream(broken), error => error === failure);
  assertStrict.deepEqual(brokenStats, { cancellations: 0, releases: 1 });
  assertStrict.equal(broken.locked, false);
});

test('consumeOpenRouterMessageStream cancels on callback failure and malformed completion without replacing the failure', async () => {
  for (const callback of ['onDelta', 'onEvent']) {
    const failure = new Error(`Synthetic ${callback} failure`);
    let reason;
    const body = nativeBody(textFrame('Partial'), { close: false, onCancel: error => { reason = error; } });
    const stats = observeReader(body);
    const handler = callback === 'onDelta' ? async () => { throw failure; } : () => { throw failure; };
    await assertStrict.rejects(consumeOpenRouterMessageStream(body, { [callback]: handler }), error => error === failure);
    assertStrict.equal(reason, failure);
    assertStrict.deepEqual(stats, { cancellations: 1, releases: 1 });
    assertStrict.equal(body.locked, false);
  }
  const malformed = nativeBody(textFrame('Partial') + doneFrame, { close: false });
  const malformedStats = observeReader(malformed);
  await assertStrict.rejects(consumeOpenRouterMessageStream(malformed), { message: 'OpenRouter [DONE] received without a valid finish reason.' });
  assertStrict.deepEqual(malformedStats, { cancellations: 1, releases: 1 });
  assertStrict.equal(malformed.locked, false);
});

test('consumeOpenRouterMessageStream observes rejected or stalled cancellation without hiding the original error', async () => {
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    let rejectCancellation;
    const rejecting = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(frame({ error: { code: 500, message: 'Original failure' } }))); },
      cancel() { return new Promise((_, reject) => { rejectCancellation = reject; }); },
    });
    const rejectingStats = observeReader(rejecting);
    await assertStrict.rejects(consumeOpenRouterMessageStream(rejecting), { message: 'OpenRouter stream error (500): Original failure' });
    assertStrict.deepEqual(rejectingStats, { cancellations: 1, releases: 1 });
    rejectCancellation(new Error('Synthetic delayed cancellation rejection'));
    await new Promise(resolve => setImmediate(resolve));

    const stalled = new ReadableStream({
      start(controller) { controller.enqueue(encoder.encode(frame({ error: { code: 500, message: 'Original failure' } }))); },
      cancel() { return new Promise(() => {}); },
    });
    const outcome = await Promise.race([
      consumeOpenRouterMessageStream(stalled).then(() => 'unexpected success', error => error),
      new Promise(resolve => setTimeout(() => resolve('still waiting for cancellation'), 50)),
    ]);
    assertStrict.equal(outcome?.message, 'OpenRouter stream error (500): Original failure');
    assertStrict.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

test('consumeOpenRouterMessageStream preserves results and errors when reader methods throw during cleanup', async () => {
  for (const success of [true, false]) {
    const failure = new Error('Original callback failure');
    let cancellations = 0;
    let releases = 0;
    let reads = 0;
    const reader = {
      read: async () => reads++ === 0 ? { done: false, value: encoder.encode(completeWire) } : { done: true },
      cancel() { cancellations++; throw new Error('Synthetic synchronous cancellation failure'); },
      releaseLock() { releases++; throw new Error('Synthetic release failure'); },
    };
    const promise = consumeOpenRouterMessageStream({ getReader: () => reader }, success ? {} : { onEvent() { throw failure; } });
    if (success) assertStrict.equal((await promise).text, 'Synthetic text');
    else await assertStrict.rejects(promise, error => error === failure);
    // Superseded pin (review follow-up): success used to expect 0 cancellations. The consumer now cancels the
    // rest of the body at a valid [DONE]; a cancel that throws must still not discard the finished text.
    assertStrict.equal(cancellations, 1);
    assertStrict.equal(releases, 1);
  }
});

test('consumeOpenRouterMessageStream awaits async onEvent and propagates its rejection', async () => {
  const unhandled = [];
  const onUnhandled = error => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    const failure = new Error('Synthetic async onEvent failure');
    await assertStrict.rejects(
      consumeOpenRouterMessageStream(nativeBody(completeWire), { onEvent: async () => { throw failure; } }),
      error => error === failure,
    );
    await new Promise(resolve => setImmediate(resolve));
    assertStrict.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', onUnhandled); }
});

// Superseded pin (finding 6): 'length' used to be returned as-is. Old intent: the raw finish_reason is
// surfaced. New intent: OpenRouter's token-limit reason is normalized to the shared 'max_tokens' reason
// so the synthesis split/terminal-truncation logic sees one vocabulary. 'stop' and other reasons stay as-is.
test('consumeOpenRouterMessageStream normalizes length to max_tokens and leaves other reasons untouched', async () => {
  const lengthResult = await consumeOpenRouterMessageStream(nativeBody(textFrame('cut') + stopFrame('length') + doneFrame));
  assertStrict.equal(lengthResult.stopReason, 'max_tokens');
  assertStrict.equal(lengthResult.text, 'cut');
  for (const reason of ['stop', 'tool_calls', 'content_filter']) {
    const result = await consumeOpenRouterMessageStream(nativeBody(textFrame('ok') + stopFrame(reason) + doneFrame));
    assertStrict.equal(result.stopReason, reason);
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