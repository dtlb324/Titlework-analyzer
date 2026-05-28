// Gemini generateContent helpers (Anthropic-shaped messages in, normalized usage out).

import { deleteGeminiFiles } from './gemini-files.js';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function geminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

export function isGeminiModel(model) {
  return /^gemini-/i.test(String(model || '').trim());
}

const GEMINI_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

/** Gemini 3+ uses thinkingLevel; Gemini 2.5 uses thinkingBudget (see Google thinking docs). */
export function isGemini3SeriesModel(model) {
  return /^gemini-3/i.test(String(model || '').trim());
}

function normalizeThinkingLevel(raw) {
  const level = String(raw || '').trim().toLowerCase();
  return GEMINI_THINKING_LEVELS.has(level) ? level : null;
}

/**
 * Resolve thinkingConfig for generateContent.
 * - Gemini 3.x: GEMINI_THINKING_LEVEL (minimal|low|medium|high); omit for API default (medium on 3.5 Flash).
 * - Gemini 2.5: GEMINI_THINKING_BUDGET (0 off, -1 dynamic, or token count).
 */
export function resolveGeminiThinkingConfig(model, overrides = {}) {
  if (!isGeminiModel(model)) return null;

  if (isGemini3SeriesModel(model)) {
    const level = normalizeThinkingLevel(
      overrides.thinkingLevel ?? process.env.GEMINI_THINKING_LEVEL,
    );
    if (!level) return null;
    const config = { thinkingLevel: level };
    if (overrides.includeThoughts === true || process.env.GEMINI_INCLUDE_THOUGHTS === 'true') {
      config.includeThoughts = true;
    }
    return config;
  }

  const budgetRaw = overrides.thinkingBudget ?? process.env.GEMINI_THINKING_BUDGET;
  const budget = Number.isFinite(Number(budgetRaw)) ? Number(budgetRaw) : 0;
  return { thinkingBudget: budget };
}

export function anthropicMessagesToGeminiContents(messages = []) {
  const contents = [];
  for (const message of messages) {
    const role = message?.role === 'assistant' ? 'model' : 'user';
    const parts = [];
    const content = message?.content;
    if (typeof content === 'string') {
      if (content) parts.push({ text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          if (block.text) parts.push({ text: String(block.text) });
          continue;
        }
        if (block.type === 'image' || block.type === 'document') {
          const source = block.source || {};
          if (source.type === 'file_uri' && source.uri && source.media_type) {
            parts.push({
              file_data: {
                mime_type: source.media_type,
                file_uri: source.uri,
              },
            });
            continue;
          }
          if (source.type === 'base64' && source.data && source.media_type) {
            parts.push({
              inline_data: {
                mime_type: source.media_type,
                data: source.data,
              },
            });
          }
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }
  return contents;
}

export function buildGeminiGenerateContentBody({
  model,
  maxTokens,
  system,
  messages,
  thinkingConfig = null,
  thinkingBudget,
  thinkingLevel,
  responseSchema = null,
}) {
  const body = {
    contents: anthropicMessagesToGeminiContents(messages),
    generationConfig: {
      maxOutputTokens: maxTokens,
    },
  };
  const systemText = typeof system === 'string'
    ? system
    : Array.isArray(system)
      ? system.map(entry => entry?.text || '').join('\n')
      : '';
  if (systemText.trim()) {
    body.systemInstruction = { parts: [{ text: systemText }] };
  }
  const resolvedThinking = thinkingConfig
    ?? resolveGeminiThinkingConfig(model, { thinkingBudget, thinkingLevel });
  if (resolvedThinking && Object.keys(resolvedThinking).length) {
    body.generationConfig.thinkingConfig = resolvedThinking;
  } else if (Number.isFinite(Number(thinkingBudget))) {
    // Explicit legacy call sites may still pass thinkingBudget directly.
    body.generationConfig.thinkingConfig = { thinkingBudget: Number(thinkingBudget) };
  }
  if (responseSchema) {
    body.generationConfig.responseMimeType = 'application/json';
    body.generationConfig.responseSchema = responseSchema;
  }
  return body;
}

export function normalizeGeminiUsage(usageMetadata = {}) {
  const input = Number(usageMetadata.promptTokenCount);
  const output = Number(usageMetadata.candidatesTokenCount);
  const thinking = Number(usageMetadata.thoughtsTokenCount);
  return {
    input_tokens: Number.isFinite(input) ? input : null,
    output_tokens: Number.isFinite(output) ? output : null,
    thinking_tokens: Number.isFinite(thinking) ? thinking : null,
  };
}

export function extractGeminiText(data = {}) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts
    .filter(part => !part.thought)
    .map(part => part.text || '')
    .join('');
}

/** Thought summaries when includeThoughts is enabled (debug / eval only). */
export function extractGeminiThoughtSummaries(data = {}) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.filter(part => part.thought && part.text).map(part => String(part.text));
}

export function geminiApiKeyError() {
  if (geminiApiKey()) return null;
  return 'GEMINI_API_KEY is required for Gemini models. Create a key at https://aistudio.google.com/apikey and set GEMINI_API_KEY on Cloud Run.';
}

export async function invokeGeminiGenerateContent(request, options = {}) {
  const apiKeyError = geminiApiKeyError();
  if (apiKeyError) {
    const error = new Error(apiKeyError);
    error.statusCode = 503;
    throw error;
  }

  const model = request.model;
  const maxTokens = request.maxTokens;
  const thinkingConfig = resolveGeminiThinkingConfig(model, {
    thinkingLevel: request.thinkingLevel,
    thinkingBudget: request.thinkingBudget,
    includeThoughts: request.includeThoughts,
  });
  const body = buildGeminiGenerateContentBody({
    model,
    maxTokens,
    system: request.system,
    messages: request.messages,
    thinkingConfig,
    thinkingBudget: request.thinkingBudget,
    thinkingLevel: request.thinkingLevel,
    responseSchema: request.responseSchema ?? null,
  });
  const baseUrl = String(process.env.GEMINI_API_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const timeoutMs = Number(options.timeoutMs) || 240_000;
  const timeout = options.createTimeoutSignal
    ? options.createTimeoutSignal(timeoutMs)
    : null;

  const cleanupFileNames = collectGeminiFileNamesFromMessages(request.messages);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': geminiApiKey(),
      },
      body: JSON.stringify(body),
      signal: timeout?.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.error || `Gemini request failed (HTTP ${response.status}).`;
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    const text = extractGeminiText(data);
    const thoughtSummaries = extractGeminiThoughtSummaries(data);
    return {
      text,
      model: data.modelVersion || model,
      usage: normalizeGeminiUsage(data.usageMetadata),
      stopReason: data?.candidates?.[0]?.finishReason || null,
      thoughtSummaries: thoughtSummaries.length ? thoughtSummaries : undefined,
      thinkingConfig: thinkingConfig || undefined,
      raw: data,
    };
  } finally {
    timeout?.cleanup?.();
    if (cleanupFileNames.length) {
      await deleteGeminiFiles(cleanupFileNames);
    }
  }
}

function collectGeminiFileNamesFromMessages(messages = []) {
  const names = new Set();
  for (const message of messages) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const source = block?.source;
      if (source?.type === 'file_uri' && source.geminiFileName) {
        names.add(source.geminiFileName);
      }
    }
  }
  return [...names];
}
