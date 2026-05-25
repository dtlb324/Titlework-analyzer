// Gemini generateContent helpers (Anthropic-shaped messages in, normalized usage out).

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

function geminiApiKey() {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
}

export function isGeminiModel(model) {
  return /^gemini-/i.test(String(model || '').trim());
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

export function buildGeminiGenerateContentBody({ model, maxTokens, system, messages, thinkingBudget }) {
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
  const budget = Number(thinkingBudget);
  if (Number.isFinite(budget)) {
    body.generationConfig.thinkingConfig = { thinkingBudget: budget };
  }
  return body;
}

export function normalizeGeminiUsage(usageMetadata = {}) {
  const input = Number(usageMetadata.promptTokenCount);
  const output = Number(usageMetadata.candidatesTokenCount);
  return {
    input_tokens: Number.isFinite(input) ? input : null,
    output_tokens: Number.isFinite(output) ? output : null,
  };
}

export function extractGeminiText(data = {}) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  return parts.map(part => part.text || '').join('');
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
  const thinkingBudget = request.thinkingBudget ?? (
    Number.isFinite(Number(process.env.GEMINI_THINKING_BUDGET))
      ? Number(process.env.GEMINI_THINKING_BUDGET)
      : 0
  );
  const body = buildGeminiGenerateContentBody({
    model,
    maxTokens,
    system: request.system,
    messages: request.messages,
    thinkingBudget,
  });
  const baseUrl = String(process.env.GEMINI_API_BASE_URL || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '');
  const url = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const timeoutMs = Number(options.timeoutMs) || 240_000;
  const timeout = options.createTimeoutSignal
    ? options.createTimeoutSignal(timeoutMs)
    : null;

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
    return {
      text,
      model: data.modelVersion || model,
      usage: normalizeGeminiUsage(data.usageMetadata),
      stopReason: data?.candidates?.[0]?.finishReason || null,
      raw: data,
    };
  } finally {
    timeout?.cleanup?.();
  }
}
