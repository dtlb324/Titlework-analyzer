import { buildMessagesRequestBody } from './anthropic-request.js';
import { geminiApiKeyError, invokeGeminiGenerateContent, isGeminiModel } from './gemini-request.js';

export { isGeminiModel, geminiApiKeyError };

function anthropicApiKey() {
  return process.env.ANTHROPIC_API_KEY || '';
}

export function isAnthropicModel(model) {
  return /^claude-/i.test(String(model || '').trim());
}

export function modelApiKeyError(model) {
  if (isGeminiModel(model)) return geminiApiKeyError();
  if (!anthropicApiKey()) {
    return 'ANTHROPIC_API_KEY is required for Claude models.';
  }
  return null;
}

export function abstractionApiKeyError(model) {
  return modelApiKeyError(model);
}

function sanitizeProviderErrorMessage(err) {
  return String(err?.message || err || 'Unknown error')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, '[REDACTED]')
    .slice(0, 1000);
}

function createDefaultTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), cleanup() {} };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cleanup: () => clearTimeout(timeout) };
}

async function invokeAnthropicModel(request, options = {}) {
  const keyError = modelApiKeyError(request.model);
  if (keyError) {
    const error = new Error(keyError);
    error.statusCode = 503;
    throw error;
  }
  const body = JSON.stringify(buildMessagesRequestBody({
    model: request.model,
    maxTokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
  }));
  const timeoutMs = Number(options.timeoutMs) || 240_000;
  const timeout = options.createTimeoutSignal
    ? options.createTimeoutSignal(timeoutMs)
    : createDefaultTimeoutSignal(timeoutMs);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicApiKey(),
        'anthropic-version': '2023-06-01',
      },
      body,
      signal: timeout.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.error || `Anthropic request failed (HTTP ${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return {
      text: data.content?.map(block => block.text || '').join('') || '',
      model: data.model || request.model,
      usage: data.usage || {},
      stopReason: data.stop_reason || null,
      raw: data,
    };
  } finally {
    timeout.cleanup?.();
  }
}

export async function invokeModel(request, options = {}) {
  const model = request?.model;
  if (!model) {
    const error = new Error('Model is required.');
    error.statusCode = 400;
    throw error;
  }
  if (isGeminiModel(model)) {
    return await invokeGeminiGenerateContent(request, options);
  }
  if (isAnthropicModel(model)) {
    return await invokeAnthropicModel(request, options);
  }
  const error = new Error(`Unsupported model: ${model}`);
  error.statusCode = 400;
  throw error;
}

export function mapModelResponseToAnalyzeProxy(result = {}) {
  return {
    content: [{ type: 'text', text: result.text || '' }],
    model: result.model,
    stop_reason: result.stopReason || 'end_turn',
    usage: result.usage || {},
  };
}

export function sanitizeModelClientError(err) {
  return sanitizeProviderErrorMessage(err);
}
