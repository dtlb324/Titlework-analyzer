// Shared Anthropic Messages API helpers (prompt caching, request shaping).

const DEFAULT_MERGE_USER_CACHE_MIN_TOKENS = 1024;

function promptCacheEnabled() {
  return process.env.ANTHROPIC_PROMPT_CACHE !== 'false';
}

export function estimateTextTokens(text) {
  const value = String(text || '');
  if (!value) return 0;
  return Math.ceil(value.length / 4);
}

export function mergeUserCacheMinTokens() {
  const raw = Number(process.env.SYNTHESIS_MERGE_CACHE_MIN_TOKENS ?? DEFAULT_MERGE_USER_CACHE_MIN_TOKENS);
  if (!Number.isFinite(raw)) return DEFAULT_MERGE_USER_CACHE_MIN_TOKENS;
  return Math.max(256, Math.floor(raw));
}

export function buildSystemParam(prompt, options = {}) {
  const text = String(prompt || '');
  const useCache = options.cache !== false && promptCacheEnabled() && text.length >= 256;
  if (!useCache) return text;
  return [{ type: 'text', text, cache_control: { type: 'ephemeral' } }];
}

export function buildCachedTextBlock(text, options = {}) {
  const body = String(text || '');
  const minTokens = options.minTokens ?? mergeUserCacheMinTokens();
  const useCache = options.cache !== false && promptCacheEnabled() && estimateTextTokens(body) >= minTokens;
  if (!useCache) {
    return [{ type: 'text', text: body }];
  }
  return [{ type: 'text', text: body, cache_control: { type: 'ephemeral' } }];
}

export function buildMergeUserMessageContent({ preamble, tract, contextNotes, segmentBlock, cacheSegments = true }) {
  let header = String(preamble || '');
  if (tract) header += `\n\n**Subject Tract:** ${tract}`;
  if (contextNotes) header += `\n\n**Additional Context:** ${contextNotes}`;
  header += '\n\n---\n\n';
  const segments = String(segmentBlock || '');
  if (!cacheSegments || !promptCacheEnabled()) {
    return `${header}${segments}`;
  }
  if (estimateTextTokens(segments) < mergeUserCacheMinTokens()) {
    return `${header}${segments}`;
  }
  return [
    { type: 'text', text: header },
    ...buildCachedTextBlock(segments, { minTokens: mergeUserCacheMinTokens() }),
  ];
}

export function buildMessagesRequestBody({ model, maxTokens, system, messages }) {
  return {
    model,
    max_tokens: maxTokens,
    system: buildSystemParam(system),
    messages,
  };
}
