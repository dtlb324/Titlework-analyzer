
/**
 * Consume an OpenAI-format SSE stream from OpenRouter.
 *
 * Reads `data:` lines, accumulates `choices[].delta.content`, handles `[DONE]` termination.
 * Returns the same shape as `consumeAnthropicMessageStream`:
 *   { text, model, usage, stopReason, firstDeltaAt }
 *
 * The `response.body` is a ReadableStream of Uint8Array chunks.
 */
export async function consumeOpenRouterMessageStream(body, options = {}) {
  let text = '';
  let usage = { input_tokens: null, output_tokens: null };
  let stopReason = null;
  let model = null;
  let firstDeltaAt = null;

  const decoder = new TextDecoder();
  let buffer = '';

  const reader = body.getReader();

  function processLine(line) {
    if (!line.startsWith('data:')) return;

    const data = line.slice(5).trim();
    if (data === '[DONE]') return true;

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    const choices = parsed?.choices || [];
    const delta = choices[0]?.delta || {};

    if (parsed.model && !model) model = parsed.model;

    const deltaText = delta.content || '';
    if (deltaText && firstDeltaAt == null) {
      firstDeltaAt = Date.now();
    }

    if (deltaText) {
      text += deltaText;
      if (options?.onDelta) options.onDelta(deltaText);
    }

    const finishReason = choices[0]?.finish_reason;
    if (finishReason) {
      stopReason = finishReason;
    }

    const usageMeta = parsed?.usage;
    if (usageMeta) {
      if (Number.isFinite(usageMeta.prompt_tokens)) {
        usage.input_tokens = usageMeta.prompt_tokens;
      }
      if (Number.isFinite(usageMeta.completion_tokens)) {
        usage.output_tokens = usageMeta.completion_tokens;
      }
    }

    if (options?.onEvent) {
      options.onEvent(parsed);
    }
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let lineIndex;
      while ((lineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, lineIndex).trimEnd();
        buffer = buffer.slice(lineIndex + 1);
        if (processLine(line)) {
          return { text, model, usage, stopReason, firstDeltaAt };
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }

  processLine(buffer.trim());

  return { text, model, usage, stopReason, firstDeltaAt };
}
