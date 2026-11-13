import { ABSTRACTION_PROMPT, buildAbstractMessagesForChunk, getAbstractionConfig } from './_lib/abstraction.js';
import { requireJobPassword, setJobSecurityHeaders } from './_lib/jobs.js';
import { isProductionRuntime } from './_lib/runtime-info.js';
import { geminiApiKeyError, invokeGeminiGenerateContent, resolveGeminiThinkingConfig } from './_lib/gemini-request.js';
import { invokeAnthropicModel, invokeAnthropicModelStream, isAnthropicModel, NON_STREAMING_MAX_TOKENS, sanitizeModelClientError } from './_lib/model-client.js';
import { normalizeOpenRouterResponse, openRouterErrorText, postOpenRouterChat } from './_lib/openrouter-request.js';

const MAX_PAGES = 60;
const DEFAULT_LAB_MAX_TOKENS = 16000;
const MIN_LAB_MAX_TOKENS = 512;
const MAX_LAB_MAX_TOKENS = 32000;
const MAX_BYTES = 12_000_000;
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4;
const PRICING_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
const ANTHROPIC_PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const OPENROUTER_PRICING_SOURCE = 'https://openrouter.ai/api/v1/models';
const HAIKU_ID = 'claude-haiku-5-5';
const HAIKU_LONG_PROMPT_TOKENS = 100_000;
const DIRECT_TIMEOUT_MS = 240_000;
// One non-streaming call; reasoning at high effort can run long. Stays under undici's 300 s header timeout.
const OPENROUTER_TIMEOUT_MS = 290_000;

function labMaxTokens() {
  const raw = Number(process.env.OCR_COMPARE_MAX_TOKENS);
  return Number.isInteger(raw) && raw >= MIN_LAB_MAX_TOKENS && raw <= MAX_LAB_MAX_TOKENS ? raw : DEFAULT_LAB_MAX_TOKENS;
}

// OCR_COMPARE_PROVIDER=openrouter sends all three columns through OpenRouter with OPENROUTER_API_KEY.
// Unset (or "direct") keeps direct Gemini and direct Anthropic. Any other value fails closed.
function usesOpenRouter() {
  const raw = String(process.env.OCR_COMPARE_PROVIDER || '').trim().toLowerCase();
  if (!raw || raw === 'direct') return false;
  if (raw === 'openrouter') return true;
  const error = new Error(`OCR_COMPARE_PROVIDER ${JSON.stringify(raw)} is not supported. Use "openrouter" or leave it unset.`);
  error.statusCode = 503;
  throw error;
}

// Exact-model exception from https://ai.google.dev/gemini-api/docs/generate-content/thinking.
const HYDROGEN_ID = 'gemini-4-hydrogen';
const GEMINI_EFFORTS = new Map([['gemini-3.1-flash-lite-image', ['minimal', 'high']], [HYDROGEN_ID, ['low', 'medium', 'high', 'xhigh']]]);
const GEMINI_NO_MINIMAL = /^gemini-3(?:[.-][78]-flash(?!-lite)|.*-pro(?:-|$))/i;
const HAIKU_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function geminiEfforts(model) {
  return GEMINI_EFFORTS.get(model.toLowerCase()) || (GEMINI_NO_MINIMAL.test(model) ? ['low', 'medium', 'high'] : ['minimal', 'low', 'medium', 'high']);
}

function withEffort(model, effort) {
  const thinkingLevel = isAnthropicModel(model.id) ? `adaptive, effort ${effort}` : effort;
  return { ...model, effort, thinkingLevel };
}

function models() {
  const viaOpenRouter = usesOpenRouter();
  const config = getAbstractionConfig();
  const maxTokens = labMaxTokens();
  if (!/^gemini-3[.-][a-z0-9.-]+$/i.test(config.model)) {
    const error = new Error('OCR comparison requires a Gemini 3-series ABSTRACT_MODEL.');
    error.statusCode = 503;
    throw error;
  }
  const configuredRaw = String(process.env.GEMINI_THINKING_LEVEL || '').trim();
  const configured = resolveGeminiThinkingConfig(config.model)?.thinkingLevel || 'default';
  const baselineLevels = geminiEfforts(config.model);
  if (configuredRaw && !baselineLevels.includes(configured)) {
    const error = new Error(`GEMINI_THINKING_LEVEL ${JSON.stringify(configuredRaw)} is not supported by ${config.model}.`);
    error.statusCode = 503;
    throw error;
  }
  return [
    withEffort({ id: config.model, label: 'Current Gemini', effortLevels: configured === 'default' ? ['default', ...baselineLevels] : baselineLevels, maxTokens }, configured),
    withEffort({ id: HYDROGEN_ID, label: 'Gemini 4 Hydrogen', effortLevels: geminiEfforts(HYDROGEN_ID), maxTokens }, 'medium'),
    withEffort({ id: HAIKU_ID, label: 'Claude Haiku 5.5', effortLevels: HAIKU_EFFORTS, maxTokens }, 'medium'),
  ].map(model => (viaOpenRouter ? { ...model, provider: 'openrouter' } : model));
}

function applyEfforts(pair, efforts) {
  if (efforts === undefined) return pair;
  if (!Array.isArray(efforts) || efforts.length !== pair.length) throw new Error(`efforts must list one level per model (${pair.length}).`);
  return pair.map((model, index) => {
    if (!model.effortLevels.includes(efforts[index])) throw new Error(`${model.label} does not support effort ${JSON.stringify(efforts[index])}.`);
    return withEffort(model, efforts[index]);
  });
}

// OpenRouter's completion_tokens include reasoning tokens (completion_tokens_details.reasoning_tokens).
// Shape the usage like each direct provider's so estimateCost and the report need no special case:
// Claude keeps output_tokens inclusive of thinking (thinking_tokens is display only);
// Gemini's cost adds thinking_tokens on top of output_tokens, so output_tokens excludes it.
function openRouterUsage(model, raw) {
  const num = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  const completion = num(raw?.completion_tokens);
  const thinking = num(raw?.completion_tokens_details?.reasoning_tokens);
  const usage = { input_tokens: num(raw?.prompt_tokens), output_tokens: completion };
  if (thinking !== null) usage.thinking_tokens = thinking;
  if (thinking !== null && !isAnthropicModel(model)) usage.output_tokens = completion !== null && completion >= thinking ? completion - thinking : null;
  return usage;
}

const finiteCost = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// What OpenRouter says the call cost. With BYOK, usage.cost is OpenRouter's own fee (often 0), so the
// provider's bill is usage.cost_details.upstream_inference_cost; without it we fall back to list rates.
function reportedOpenRouterCost(usage) {
  if (usage?.is_byok === true) {
    const upstream = usage.cost_details?.upstream_inference_cost;
    return finiteCost(upstream) ? { costUsd: upstream, costSource: 'upstream' } : {};
  }
  return finiteCost(usage?.cost) ? { costUsd: usage.cost, costSource: 'cost' } : {};
}

async function invokeOpenRouterLabModel(call, options) {
  const data = await postOpenRouterChat({ model: call.model, maxTokens: call.maxTokens, system: call.system, messages: call.messages, reasoningEffort: call.effort || call.thinkingLevel }, options);
  // A 200 can still carry no completion: empty or HTML body, [], null, an error object, no choices, or finish_reason "error".
  const noCompletion = detail => new Error(openRouterErrorText(detail) || 'OpenRouter returned no completion (HTTP 200)');
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw noCompletion();
  if (data.error) throw noCompletion(data.error);
  const choice = data.choices?.[0];
  if (!choice || typeof choice !== 'object') throw noCompletion();
  if (choice.finish_reason === 'error') throw noCompletion(choice.error);
  return { ...normalizeOpenRouterResponse(data, call.model), usage: openRouterUsage(call.model, data.usage), ...reportedOpenRouterCost(data.usage) };
}

function invokeLabModel(call, options) {
  if (usesOpenRouter()) return invokeOpenRouterLabModel(call, options);
  if (!isAnthropicModel(call.model)) return invokeGeminiGenerateContent(call, options);
  return Number(call.maxTokens) > NON_STREAMING_MAX_TOKENS
    ? invokeAnthropicModelStream(call, { ...options, direct: true })
    : invokeAnthropicModel(call, { ...options, direct: true });
}

function validateUpload(body) {
  if (!body || typeof body.filename !== 'string' || !body.filename.trim() || body.filename.length > 255) throw new Error('A filename of 1–255 characters is required.');
  if (!Array.isArray(body.pages) || !body.pages.length || body.pages.length > MAX_PAGES) throw new Error(`Upload 1–${MAX_PAGES} rendered image pages.`);
  let total = 0;
  const pages = body.pages.map(page => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(page?.mediaType)) throw new Error('Only PNG, JPEG, or WebP image pages are accepted. PDFs must be rendered in the browser.');
    if (typeof page.data !== 'string' || !page.data.length || page.data.length > MAX_BASE64_CHARS || page.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(page.data)) throw new Error('Invalid or oversized base64 image page.');
    const bytes = Buffer.from(page.data, 'base64');
    if (bytes.toString('base64') !== page.data) throw new Error('Invalid base64 image page.');
    const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isJpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    const isWebp = bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
    if (!({ 'image/png': isPng, 'image/jpeg': isJpeg, 'image/webp': isWebp })[page.mediaType]) throw new Error('Image bytes do not match their media type.');
    total += bytes.length;
    if (total > MAX_BYTES) throw new Error('Rendered pages exceed the 12 MB upload limit. Try fewer pages.');
    return { bytes, mediaType: page.mediaType };
  });
  return { filename: body.filename, pages };
}

function fieldsFromText(text) {
  const fields = Object.create(null);
  let field = null;
  for (const line of text.split('\n')) {
    const match = line.match(/^([A-Z][A-Z /-]*[A-Z]):\s*(.*)$/);
    if (match) {
      field = match[1].trim();
      fields[field] = match[2].trim();
    } else if (field && line.trim()) {
      fields[field] += `\n${line.trim()}`;
    }
  }
  return fields;
}

// Anthropic reports thinking inside output_tokens and breaks it out separately in
// output_tokens_details. Surface it as thinking_tokens for display only; the cost
// estimate must not add it again.
function withThinkingTokens(usage) {
  const thinking = usage?.output_tokens_details?.thinking_tokens;
  return typeof thinking === 'number' && Number.isFinite(thinking) && thinking >= 0 && usage.thinking_tokens == null ? { ...usage, thinking_tokens: thinking } : usage;
}

function estimateHaikuCost(usage) {
  const num = value => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  const input = num(usage?.input_tokens);
  const output = num(usage?.output_tokens);
  const cacheWrite = usage?.cache_creation_input_tokens == null ? 0 : num(usage.cache_creation_input_tokens);
  const cacheRead = usage?.cache_read_input_tokens == null ? 0 : num(usage.cache_read_input_tokens);
  if ([input, output, cacheWrite, cacheRead].some(value => value === null)) return { costUsd: null };
  // Anthropic prices the whole request by total prompt length; output_tokens already include thinking.
  const long = input + cacheWrite + cacheRead > HAIKU_LONG_PROMPT_TOKENS;
  const rates = long ? { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05 } : { input: 0.1, output: 0.5, cacheWrite: 0.125, cacheRead: 0.01 };
  return {
    costUsd: (input * rates.input + cacheWrite * rates.cacheWrite + cacheRead * rates.cacheRead + output * rates.output) / 1_000_000,
    costRates: { input: rates.input, output: rates.output, source: ANTHROPIC_PRICING_SOURCE },
  };
}

function estimateCost(id, usage) {
  if (id === HAIKU_ID) return estimateHaikuCost(usage);
  const rates = id === 'gemini-3.1-flash-lite'
    ? { input: 0.25, output: 1.5 }
    : id === HYDROGEN_ID
      ? { input: 1.5, output: 7.5 }
      : id === 'gemini-3.8-flash'
        ? (new Date().toISOString() < '2027-01-01' ? { input: 0.75, output: 3.75 } : { input: 1.5, output: 7.5 })
        : null;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  // Gemini omits thoughtsTokenCount when the model did not think, so absent means zero.
  const thinking = usage?.thinking_tokens ?? 0;
  if (!rates || ![input, output, thinking].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return { costUsd: null, costRates: rates && { ...rates, source: PRICING_SOURCE } };
  return { costUsd: (input * rates.input + (output + thinking) * rates.output) / 1_000_000, costRates: { ...rates, source: PRICING_SOURCE } };
}

// Prefer the cost OpenRouter reported (usage.cost, or the upstream cost under BYOK); otherwise compute
// from the same list rates, which OpenRouter passes through. The rates are shown either way; only the source label differs.
function estimateOpenRouterCost(id, usage, reportedCostUsd, costSource) {
  const estimate = estimateCost(id, usage);
  const reported = typeof reportedCostUsd === 'number' && Number.isFinite(reportedCostUsd) && reportedCostUsd >= 0;
  const ratesNote = `rates are list prices, ${OPENROUTER_PRICING_SOURCE}`;
  const source = !reported ? `computed from list rates, ${OPENROUTER_PRICING_SOURCE}`
    : costSource === 'upstream' ? `OpenRouter BYOK upstream cost (usage.cost_details.upstream_inference_cost); ${ratesNote}`
      : `OpenRouter reported cost (usage.cost); ${ratesNote}`;
  return {
    costUsd: reported ? reportedCostUsd : estimate.costUsd,
    ...(estimate.costRates ? { costRates: { ...estimate.costRates, source } } : {}),
  };
}

// OpenRouter mode only: also remove the literal OPENROUTER_API_KEY (the prefix patterns miss non-sk-or keys).
// Redact before sanitizeModelClientError truncates, so a key cut at the length limit cannot leak a prefix.
function sanitizeOpenRouterError(error) {
  const key = process.env.OPENROUTER_API_KEY || '';
  const message = String(error?.message || error || 'Unknown error');
  return sanitizeModelClientError(key.length >= 8 ? message.split(key).join('[REDACTED]') : message);
}

export function createOcrCompareHandler({ modelClient = invokeLabModel } = {}) {
  let active = false;
  return async function handler(req, res) {
    setJobSecurityHeaders(res);
    if (process.env.OCR_COMPARE_ENABLED !== 'true') return res.status(404).json({ error: 'OCR comparison is disabled.' });
    // No password is needed only for local use: APP_PASSWORD unset and not a production runtime.
    // Production with APP_PASSWORD unset is refused here, so past this line unset means local.
    const passwordRequired = Boolean(process.env.APP_PASSWORD);
    if (!process.env.APP_PASSWORD && isProductionRuntime()) return res.status(503).json({ error: 'APP_PASSWORD must be configured for OCR comparison.' });
    if (!(await requireJobPassword(req, res))) return;
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
    let pair;
    try { pair = models(); }
    catch (error) { return res.status(error.statusCode || 500).json({ error: error.message }); }
    if (req.method === 'GET') return res.status(200).json({ models: pair, passwordRequired, maxPages: MAX_PAGES, maxBytes: MAX_BYTES, renderScale: 2 });
    let upload;
    try {
      upload = validateUpload(req.body);
      pair = applyEfforts(pair, req.body.efforts);
    } catch (error) { return res.status(400).json({ error: error.message }); }
    const viaOpenRouter = pair[0].provider === 'openrouter';
    if (modelClient === invokeLabModel) {
      const keyError = viaOpenRouter ? (process.env.OPENROUTER_API_KEY ? null : 'OPENROUTER_API_KEY is required when OCR_COMPARE_PROVIDER=openrouter.') : geminiApiKeyError();
      if (keyError) return res.status(503).json({ error: keyError });
    }
    if (active) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({ error: 'A comparison is already running on this server instance. Wait before starting another.' });
    }
    active = true;
    try {
      const first = upload.pages[0];
      const messages = buildAbstractMessagesForChunk({ originalFilename: upload.filename, mediaType: first.mediaType, renderedImages: true }, first.bytes);
      const content = messages[0].content;
      content.splice(1, 0, ...upload.pages.slice(1).map(page => ({ type: 'image', source: { type: 'base64', media_type: page.mediaType, data: page.bytes.toString('base64') } })));
      const results = await Promise.all(pair.map(async model => {
        const started = Date.now();
        try {
          const result = await modelClient({ model: model.id, maxTokens: model.maxTokens, system: ABSTRACTION_PROMPT, messages, ...(isAnthropicModel(model.id) ? { effort: model.effort } : model.effort === 'default' ? {} : { thinkingLevel: model.effort }) }, { timeoutMs: viaOpenRouter ? OPENROUTER_TIMEOUT_MS : DIRECT_TIMEOUT_MS, createTimeoutSignal: ms => ({ signal: AbortSignal.timeout(ms), cleanup() {} }) });
          const text = String(result.text || '');
          const usage = withThinkingTokens(result.usage || {});
          return { ...model, text, fields: fieldsFromText(text), usage, latencyMs: Date.now() - started, stopReason: result.stopReason || null, modelVersion: result.model || model.id, ...(viaOpenRouter ? estimateOpenRouterCost(model.id, usage, result.costUsd, result.costSource) : estimateCost(model.id, usage)) };
        } catch (error) {
          return { ...model, error: viaOpenRouter ? sanitizeOpenRouterError(error) : sanitizeModelClientError(error), latencyMs: Date.now() - started };
        }
      }));
      return res.status(200).json({ filename: upload.filename, pageCount: upload.pages.length, inputMode: 'rendered_images', models: results });
    } finally { active = false; }
  };
}
