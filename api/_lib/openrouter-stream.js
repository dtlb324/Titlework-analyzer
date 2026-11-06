
import { normalizeOpenRouterFinishReason } from './openrouter-request.js';

// Compared after normalization: OpenRouter's 'length' is 'max_tokens' here.
const VALID_FINISH_REASONS = new Set(['stop', 'max_tokens', 'tool_calls', 'content_filter', 'function_call']);

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
  let doneSeen = false;

  const decoder = new TextDecoder();
  let buffer = '';

  const reader = body.getReader();

  async function processLine(line) {
    if (!line.startsWith('data:')) return;

    const data = line.slice(5).trim();
    if (data === '[DONE]') {
      if (!VALID_FINISH_REASONS.has(stopReason)) {
        throw new Error('OpenRouter [DONE] received without a valid finish reason.');
      }
      doneSeen = true;
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (parsed?.error) {
      if (options?.onEvent) await options.onEvent(parsed);
      const errorCode = parsed.error.code ?? parsed.error.type ?? 'unknown_error';
      const errorMessage = parsed.error.message || 'Unknown provider error.';
      throw new Error(`OpenRouter stream error (${errorCode}): ${errorMessage}`);
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
      if (options?.onDelta) await options.onDelta(deltaText, text);
    }

    const finishReason = choices[0]?.finish_reason;
    if (finishReason) {
      stopReason = normalizeOpenRouterFinishReason(finishReason);
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
      await options.onEvent(parsed);
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

      let lineIndex;
      while ((lineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, lineIndex).trimEnd();
        buffer = buffer.slice(lineIndex + 1);
        if (!doneSeen) await processLine(line);
      }
    }

    if (!doneSeen) await processLine(buffer.trim());
    if (!doneSeen) throw new Error('OpenRouter stream ended before [DONE].');

    return { text, model, usage, stopReason, firstDeltaAt };
  } catch (error) {
    if (readerState === 'reading') {
      try { Promise.resolve(reader.cancel?.(error)).catch(() => {}); } catch {}
    }
    throw error;
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
}
