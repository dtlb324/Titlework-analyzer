// Parse Anthropic Messages API server-sent events from a streaming response body.

function parseSseEventBlock(block) {
  const lines = block.split('\n');
  let eventName = 'message';
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!dataLines.length) return null;
  const dataText = dataLines.join('\n');
  if (dataText === '[DONE]') return { event: eventName, done: true, data: null };
  try {
    return { event: eventName, done: false, data: JSON.parse(dataText) };
  } catch {
    return { event: eventName, done: false, data: null, raw: dataText };
  }
}

export async function consumeAnthropicMessageStream(body, handlers = {}) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('Streaming response body is not readable.');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let model = handlers.model || null;
  let stopReason = null;
  let usage = {};
  let firstDeltaAt = null;

  const onDelta = typeof handlers.onDelta === 'function' ? handlers.onDelta : null;
  const onEvent = typeof handlers.onEvent === 'function' ? handlers.onEvent : null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let splitAt = buffer.indexOf('\n\n');
    while (splitAt !== -1) {
      const block = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const parsed = parseSseEventBlock(block);
      if (!parsed) {
        splitAt = buffer.indexOf('\n\n');
        continue;
      }
      if (onEvent) onEvent(parsed);
      if (parsed.done) continue;
      const payload = parsed.data;
      if (!payload || typeof payload !== 'object') {
        splitAt = buffer.indexOf('\n\n');
        continue;
      }
      if (payload.type === 'message_start' && payload.message?.model) {
        model = payload.message.model;
      }
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        const delta = String(payload.delta.text || '');
        if (delta) {
          if (firstDeltaAt == null) firstDeltaAt = Date.now();
          text += delta;
          if (onDelta) await onDelta(delta, text);
        }
      }
      if (payload.type === 'message_delta') {
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason;
        if (payload.usage) usage = { ...usage, ...payload.usage };
      }
      if (payload.type === 'message_stop' && payload.message?.usage) {
        usage = { ...usage, ...payload.message.usage };
      }
      splitAt = buffer.indexOf('\n\n');
    }
  }

  return {
    text,
    model,
    usage,
    stopReason,
    firstDeltaAt,
  };
}
