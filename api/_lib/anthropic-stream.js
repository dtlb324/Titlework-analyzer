
const VALID_STOP_REASONS = new Set([
  'end_turn', 'max_tokens', 'stop_sequence', 'tool_use', 'pause_turn',
  'refusal', 'model_context_window_exceeded',
]);

function parseSseEventBlock(block) {
  const lines = block.split(/\r?\n/);
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
  let messageStopped = false;

  const onDelta = typeof handlers.onDelta === 'function' ? handlers.onDelta : null;
  const onEvent = typeof handlers.onEvent === 'function' ? handlers.onEvent : null;

  async function processBlock(block) {
    const parsed = parseSseEventBlock(block);
    if (!parsed) return;
    if (onEvent) await onEvent(parsed);
    if (parsed.done) return;
    const payload = parsed.data;
    if (!payload || typeof payload !== 'object') return;
    if (parsed.event === 'error' || payload.type === 'error') {
      const errorType = payload.error?.type || 'unknown_error';
      const message = payload.error?.message || 'Unknown provider error.';
      throw new Error(`Anthropic stream error (${errorType}): ${message}`);
    }
    if (payload.type === 'message_start' && payload.message?.model) {
      model = payload.message.model;
    }
    // message_start carries input/cache token counts; later message_delta
    // usage (cumulative output tokens) is merged over it.
    if (payload.type === 'message_start' && payload.message?.usage) {
      usage = { ...usage, ...payload.message.usage };
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
    if (payload.type === 'message_stop') {
      if (!VALID_STOP_REASONS.has(stopReason)) {
        throw new Error('Anthropic message_stop received without a valid stop reason.');
      }
      messageStopped = true;
      if (payload.message?.usage) usage = { ...usage, ...payload.message.usage };
    }
  }

  let readerState = 'reading';
  try {
    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (error) {
        readerState = 'failed';
        throw error;
      }
      const { done, value } = chunk;
      if (done) {
        readerState = 'exhausted';
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let boundary;
      while (!messageStopped && (boundary = /\r?\n\r?\n/.exec(buffer)) !== null) {
        const block = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        await processBlock(block);
      }
      if (messageStopped) break;
    }

    if (!messageStopped) throw new Error('Anthropic stream ended before message_stop.');
    if (readerState === 'reading') {
      readerState = 'abandoned';
      try { Promise.resolve(reader.cancel?.()).catch(() => {}); } catch {}
    }

    return {
      text,
      model,
      usage,
      stopReason,
      firstDeltaAt,
    };
  } catch (error) {
    if (readerState === 'reading') {
      try { Promise.resolve(reader.cancel?.(error)).catch(() => {}); } catch {}
    }
    throw error;
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
}
