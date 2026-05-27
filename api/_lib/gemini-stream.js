// Parse Gemini streamGenerateContent SSE (alt=sse) into accumulated text + usage.

function parseSseDataLine(block) {
  const lines = block.split('\n');
  const dataLines = [];
  for (const line of lines) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trim());
    }
  }
  if (!dataLines.length) return null;
  const dataText = dataLines.join('\n');
  if (!dataText || dataText === '[DONE]') return { done: true, data: null };
  try {
    return { done: false, data: JSON.parse(dataText) };
  } catch {
    return { done: false, data: null };
  }
}

export function extractGeminiStreamTextParts(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  let text = '';
  for (const part of parts) {
    if (part?.thought) continue;
    if (part?.text) text += String(part.text);
  }
  return text;
}

/** Gemini SSE may send incremental or cumulative text; normalize to full text so far. */
export function mergeGeminiStreamText(accumulated, chunkText) {
  const next = String(chunkText || '');
  if (!next) return accumulated;
  const prev = String(accumulated || '');
  if (!prev) return next;
  if (next.startsWith(prev)) return next;
  if (prev.endsWith(next)) return prev;
  return prev + next;
}

export async function consumeGeminiGenerateContentStream(body, handlers = {}) {
  if (!body || typeof body.getReader !== 'function') {
    throw new Error('Streaming response body is not readable.');
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let model = handlers.model || null;
  let stopReason = null;
  let usageMetadata = {};
  let firstDeltaAt = null;

  const onDelta = typeof handlers.onDelta === 'function' ? handlers.onDelta : null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let splitAt = buffer.indexOf('\n\n');
    while (splitAt !== -1) {
      const block = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const parsed = parseSseDataLine(block);
      if (!parsed || parsed.done) {
        splitAt = buffer.indexOf('\n\n');
        continue;
      }
      const payload = parsed.data;
      if (!payload || typeof payload !== 'object') {
        splitAt = buffer.indexOf('\n\n');
        continue;
      }
      if (payload.modelVersion) model = payload.modelVersion;
      const chunkText = extractGeminiStreamTextParts(payload);
      if (chunkText) {
        const merged = mergeGeminiStreamText(text, chunkText);
        const delta = merged.slice(text.length);
        text = merged;
        if (delta) {
          if (firstDeltaAt == null) firstDeltaAt = Date.now();
          if (onDelta) await onDelta(delta, text);
        }
      }
      const finishReason = payload?.candidates?.[0]?.finishReason;
      if (finishReason) stopReason = finishReason;
      if (payload.usageMetadata && typeof payload.usageMetadata === 'object') {
        usageMetadata = { ...usageMetadata, ...payload.usageMetadata };
      }
      splitAt = buffer.indexOf('\n\n');
    }
  }

  return {
    text,
    model,
    usageMetadata,
    stopReason,
    firstDeltaAt,
  };
}
