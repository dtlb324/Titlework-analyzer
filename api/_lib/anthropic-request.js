// Shared Anthropic Messages API helpers (prompt caching, request shaping).

function promptCacheEnabled() {
  return process.env.ANTHROPIC_PROMPT_CACHE !== 'false';
}

export function buildSystemParam(prompt, options = {}) {
  const text = String(prompt || '');
  const useCache = options.cache !== false && promptCacheEnabled() && text.length >= 256;
  if (!useCache) return text;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function buildMessagesRequestBody({ model, maxTokens, system, messages }) {
  return {
    model,
    max_tokens: maxTokens,
    system: buildSystemParam(system),
    messages,
  };
}
