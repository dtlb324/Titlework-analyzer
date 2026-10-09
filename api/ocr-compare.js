import { ABSTRACTION_PROMPT, buildAbstractMessagesForChunk, getAbstractionConfig } from './_lib/abstraction.js';
import { requireJobPassword, setJobSecurityHeaders } from './_lib/jobs.js';
import { geminiApiKeyError, invokeGeminiGenerateContent, resolveGeminiThinkingConfig } from './_lib/gemini-request.js';
import { invokeAnthropicModel, isAnthropicModel, sanitizeModelClientError } from './_lib/model-client.js';

const MAX_PAGES = 10;
// Lab-only output limit shared by all models. Production abstraction uses ~2,000
// tokens per chunk, but a 10-page upload can hold several instruments, and Haiku
// 5.5's thinking tokens count against the same limit. 8192 is the largest value
// the non-streaming Anthropic call allows (NON_STREAMING_MAX_TOKENS).
const DEFAULT_LAB_MAX_TOKENS = 8000;
const MIN_LAB_MAX_TOKENS = 512;
const MAX_LAB_MAX_TOKENS = 8192;
const MAX_BYTES = 12_000_000;
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4;
const PRICING_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';
const ANTHROPIC_PRICING_SOURCE = 'https://platform.claude.com/docs/en/about-claude/pricing';
const HAIKU_ID = 'claude-haiku-5-5';
const HAIKU_LONG_PROMPT_TOKENS = 100_000;

function labMaxTokens() {
  const raw = Number(process.env.OCR_COMPARE_MAX_TOKENS);
  return Number.isInteger(raw) && raw >= MIN_LAB_MAX_TOKENS && raw <= MAX_LAB_MAX_TOKENS ? raw : DEFAULT_LAB_MAX_TOKENS;
}

function models() {
  const config = getAbstractionConfig();
  const maxTokens = labMaxTokens();
  if (!/^gemini-3[.-][a-z0-9.-]+$/i.test(config.model)) {
    const error = new Error('OCR comparison requires a Gemini 3-series ABSTRACT_MODEL.');
    error.statusCode = 503;
    throw error;
  }
  return [
    { id: config.model, label: 'Current Gemini', thinkingLevel: resolveGeminiThinkingConfig(config.model)?.thinkingLevel || 'default', maxTokens },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', thinkingLevel: 'low', maxTokens },
    // Haiku 5.5 thinks adaptively. Medium effort is the lab setting under test for accuracy.
    { id: HAIKU_ID, label: 'Claude Haiku 5.5', thinkingLevel: 'adaptive, effort medium', effort: 'medium', maxTokens },
  ];
}

// Gemini and Claude are both called directly (never through OpenRouter),
// regardless of the production MODEL_PROVIDER.
function invokeLabModel(call, options) {
  return isAnthropicModel(call.model)
    ? invokeAnthropicModel(call, { ...options, direct: true })
    : invokeGeminiGenerateContent(call, options);
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
    : id === 'gemini-3.8-flash'
      ? (new Date().toISOString() < '2027-01-01' ? { input: 0.75, output: 3.75 } : { input: 1.5, output: 7.5 })
      : null;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  // Gemini omits thoughtsTokenCount when the model did not think, so absent means zero.
  // Missing input/output counts still produce no estimate.
  const thinking = usage?.thinking_tokens ?? 0;
  if (!rates || ![input, output, thinking].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return { costUsd: null, costRates: rates && { ...rates, source: PRICING_SOURCE } };
  return { costUsd: (input * rates.input + (output + thinking) * rates.output) / 1_000_000, costRates: { ...rates, source: PRICING_SOURCE } };
}

export function createOcrCompareHandler({ modelClient = invokeLabModel } = {}) {
  let active = false;
  return async function handler(req, res) {
    setJobSecurityHeaders(res);
    if (process.env.OCR_COMPARE_ENABLED !== 'true') return res.status(404).json({ error: 'OCR comparison is disabled.' });
    if (!process.env.APP_PASSWORD) return res.status(503).json({ error: 'APP_PASSWORD must be configured for OCR comparison.' });
    if (!(await requireJobPassword(req, res))) return;
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
    let pair;
    try { pair = models(); }
    catch (error) { return res.status(error.statusCode || 500).json({ error: error.message }); }
    if (req.method === 'GET') return res.status(200).json({ models: pair, maxPages: MAX_PAGES, maxBytes: MAX_BYTES, renderScale: 2 });
    let upload;
    try { upload = validateUpload(req.body); }
    catch (error) { return res.status(400).json({ error: error.message }); }
    if (modelClient === invokeLabModel && geminiApiKeyError()) return res.status(503).json({ error: geminiApiKeyError() });
    if (active) {
      res.setHeader('Retry-After', '5');
      return res.status(429).json({ error: 'A comparison is already running on this server instance. Wait before starting another.' });
    }
    active = true;
    try {
      const first = upload.pages[0];
      // The helper also infers PDF/CSV from the filename. Mark this as rendered
      // input so a .pdf source name cannot mislabel PNG bytes as a PDF block.
      const messages = buildAbstractMessagesForChunk({ originalFilename: `${upload.filename} (rendered pages)`, mediaType: first.mediaType }, first.bytes);
      const content = messages[0].content;
      content.splice(1, 0, ...upload.pages.slice(1).map(page => ({ type: 'image', source: { type: 'base64', media_type: page.mediaType, data: page.bytes.toString('base64') } })));
      const results = await Promise.all(pair.map(async model => {
        const started = Date.now();
        try {
          const result = await modelClient({ model: model.id, maxTokens: model.maxTokens, system: ABSTRACTION_PROMPT, messages, ...(model.effort ? { effort: model.effort } : model.thinkingLevel === 'default' ? {} : { thinkingLevel: model.thinkingLevel }) }, { timeoutMs: 240_000, createTimeoutSignal: ms => ({ signal: AbortSignal.timeout(ms), cleanup() {} }) });
          const text = String(result.text || '');
          const usage = withThinkingTokens(result.usage || {});
          return { ...model, text, fields: fieldsFromText(text), usage, latencyMs: Date.now() - started, stopReason: result.stopReason || null, modelVersion: result.model || model.id, ...estimateCost(model.id, usage) };
        } catch (error) {
          return { ...model, error: sanitizeModelClientError(error), latencyMs: Date.now() - started };
        }
      }));
      return res.status(200).json({ filename: upload.filename, pageCount: upload.pages.length, inputMode: 'rendered_images', models: results });
    } finally { active = false; }
  };
}
