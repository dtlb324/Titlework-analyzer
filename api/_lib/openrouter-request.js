// OpenRouter chat-completions helpers (Anthropic-shaped messages in, OpenAI-format out, normalized usage back).

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

function openRouterApiKey() {
  return process.env.OPENROUTER_API_KEY || '';
}

export function openRouterApiKeyError() {
  if (openRouterApiKey()) return null;
  return 'OPENROUTER_API_KEY is required when the selected provider is OpenRouter. Set OPENROUTER_API_KEY and optionally MODEL_PROVIDER=openrouter.';
}

/**
 * Determine whether a model name should be routed through OpenRouter.
 * 1. Slash-name detection (e.g. anthropic/claude-sonnet-4-6) → always OpenRouter.
 * 2. Global toggle MODEL_PROVIDER=openrouter → route everything through OpenRouter.
 * 3. Otherwise → false (existing Anthropic/Gemini routing applies).
 */
export function shouldUseOpenRouter(model) {
  const modelName = String(model || '').trim();
  // Rule 1: slash-name → OpenRouter
  if (modelName.includes('/')) return true;
  // Rule 2: global toggle
  if (process.env.MODEL_PROVIDER === 'openrouter') return true;
  return false;
}

/**
 * Auto-map internal model names to OpenRouter slash-names when MODEL_PROVIDER=openrouter.
 * - claude-* → anthropic/claude-*
 * - gemini-* → google/gemini-*
 * - already contains '/' → pass through unchanged
 */
function mapModelName(model) {
  const modelName = String(model || '').trim();
  if (modelName.includes('/')) return modelName;
  if (/^claude-/i.test(modelName)) return `anthropic/${modelName}`;
  if (/^gemini-/i.test(modelName)) return `google/${modelName}`;
  return modelName;
}

// Shared non-streaming max-tokens threshold (mirrors Anthropic behaviour).
export const NON_STREAMING_MAX_TOKENS = 8192;

/**
 * Translate the canonical Anthropic-shaped request into an OpenAI chat-completions body.
 *
 * Canonical input shape:
 *   { model, maxTokens, system: string|[{ text }], messages: [{ role, content }] }
 * where content is string or [{ type:'text', text }|{ type:'image'|'document', source:{ type:'base64'|'file_uri', ... } }].
 */
export function buildOpenRouterRequestBody({ model, maxTokens, system, messages }) {
  const openaiMessages = [];

  // system → leading system message
  if (system != null) {
    const systemText = typeof system === 'string'
      ? system
      : Array.isArray(system)
        ? system.map(entry => entry?.text || '').join('\n')
        : '';
    if (systemText) {
      openaiMessages.push({ role: 'system', content: systemText });
    }
  }

  // user/assistant messages
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const content = message.content;

    if (typeof content === 'string') {
      if (content) openaiMessages.push({ role, content });
      continue;
    }

    if (!Array.isArray(content)) continue;

    const parts = [];
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;

      if (block.type === 'text') {
        const part = { type: 'text', text: String(block.text || '') };
        if (block.cache_control) {
          part.cache_control = block.cache_control;
        }
        parts.push(part);
        continue;
      }

      if (block.type === 'image' || block.type === 'document') {
        const source = block.source || {};

        if (source.type === 'file_uri') {
          const error = new Error(
            `OpenRouter does not support file_uri sources. ` +
            `Got source type 'file_uri' for ${block.type} block. ` +
            `Use base64-encoded sources instead.`
          );
          error.statusCode = 400;
          throw error;
        }

        if (source.type === 'base64' && source.data && source.media_type) {
          if (block.type === 'image') {
            // Image → data URL in image_url format
            parts.push({
              type: 'image_url',
              image_url: {
                url: `data:${source.media_type};base64,${source.data}`,
              },
            });
          } else {
            // Document (PDF) → OpenAI file format
            parts.push({
              type: 'file',
              file: {
                filename: source.filename || 'document.pdf',
                file_data: `data:${source.media_type};base64,${source.data}`,
              },
            });
          }
        }
        continue;
      }
    }

    if (parts.length) {
      openaiMessages.push({ role, content: parts });
    }
  }

  const target = mapModelName(model);
  const isAnthropicTarget = target.startsWith('anthropic/');

  // Strip cache_control from content parts unless targeting anthropic/*
  const sanitizedMessages = openaiMessages.map(msg => {
    if (typeof msg.content === 'string') return msg;
    if (!Array.isArray(msg.content)) return msg;
    const sanitized = msg.content.map(part => {
      if (!part || typeof part !== 'object') return part;
      const { cache_control, ...rest } = part;
      if (isAnthropicTarget && cache_control) {
        // Preserve cache_control for anthropic/* targets — OpenRouter passes hints through
        return { ...part };
      }
      return rest;
    });
    return { ...msg, content: sanitized };
  });

  return {
    model: target,
    max_tokens: maxTokens,
    messages: sanitizedMessages,
  };
}

export function buildOpenRouterHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${openRouterApiKey()}`,
    'HTTP-Referer': process.env.OPENROUTER_REFERER || 'http://localhost:3000',
    'X-Title': process.env.OPENROUTER_TITLE || 'Titlework Analyzer',
  };
  return headers;
}

/**
 * Normalize an OpenAI chat-completions response into the shared shape.
 *   { text, model, usage: { input_tokens, output_tokens }, stopReason }
 */
export function normalizeOpenRouterResponse(data = {}, requestedModel) {
  const choices = data?.choices || [];
  const firstChoice = choices[0] || {};
  const message = firstChoice.message || {};
  const finishReason = firstChoice.finish_reason || null;

  const textParts = [];
  if (typeof message.content === 'string') {
    textParts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part?.type === 'text') textParts.push(part.text || '');
    }
  }

  const usage = data?.usage || {};
  return {
    text: textParts.join(''),
    model: data.model || requestedModel,
    usage: {
      input_tokens: Number.isFinite(usage.prompt_tokens) ? usage.prompt_tokens : null,
      output_tokens: Number.isFinite(usage.completion_tokens) ? usage.completion_tokens : null,
    },
    stopReason: finishReason,
  };
}

/**
 * Invoke a non-streaming OpenRouter chat-completions request.
 */
export async function invokeOpenRouterModel(request, options = {}) {
  const keyError = openRouterApiKeyError();
  if (keyError) {
    const error = new Error(keyError);
    error.statusCode = 503;
    throw error;
  }

  const body = buildOpenRouterRequestBody({
    model: request.model,
    maxTokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
  });

  const headers = buildOpenRouterHeaders();
  const url = `${OPENROUTER_BASE_URL}/chat/completions`;

  const timeoutMs = Number(options.timeoutMs) || 240_000;
  const timeout = options.createTimeoutSignal
    ? options.createTimeoutSignal(timeoutMs)
    : null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: timeout?.signal,
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message = data?.error?.message || data?.error || `OpenRouter request failed (HTTP ${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    return normalizeOpenRouterResponse(data, request.model);
  } finally {
    timeout?.cleanup?.();
  }
}
