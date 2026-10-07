import { ABSTRACTION_PROMPT, buildAbstractMessagesForChunk, getAbstractionConfig } from './_lib/abstraction.js';
import { requireJobPassword, setJobSecurityHeaders } from './_lib/jobs.js';
import { geminiApiKeyError, invokeGeminiGenerateContent, resolveGeminiThinkingConfig } from './_lib/gemini-request.js';
import { sanitizeModelClientError } from './_lib/model-client.js';

const MAX_PAGES = 10;
const MAX_BYTES = 12_000_000;
const MAX_BASE64_CHARS = Math.ceil(MAX_BYTES / 3) * 4;
const PRICING_SOURCE = 'https://ai.google.dev/gemini-api/docs/pricing';

function models() {
  const config = getAbstractionConfig();
  if (!/^gemini-3[.-][a-z0-9.-]+$/i.test(config.model)) {
    const error = new Error('OCR comparison requires a Gemini 3-series ABSTRACT_MODEL.');
    error.statusCode = 503;
    throw error;
  }
  return [
    { id: config.model, label: 'Current Gemini', thinkingLevel: resolveGeminiThinkingConfig(config.model)?.thinkingLevel || 'default', maxTokens: config.maxTokens },
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', thinkingLevel: 'low', maxTokens: config.maxTokens },
  ];
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

function estimateCost(id, usage) {
  const rates = id === 'gemini-3.1-flash-lite'
    ? { input: 0.25, output: 1.5 }
    : id === 'gemini-3.8-flash'
      ? (new Date().toISOString() < '2027-01-01' ? { input: 0.75, output: 3.75 } : { input: 1.5, output: 7.5 })
      : null;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  const thinking = usage?.thinking_tokens;
  if (!rates || ![input, output, thinking].every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return { costUsd: null, costRates: rates && { ...rates, source: PRICING_SOURCE } };
  return { costUsd: (input * rates.input + (output + thinking) * rates.output) / 1_000_000, costRates: { ...rates, source: PRICING_SOURCE } };
}

export function createOcrCompareHandler({ modelClient = invokeGeminiGenerateContent } = {}) {
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
    if (modelClient === invokeGeminiGenerateContent && geminiApiKeyError()) return res.status(503).json({ error: geminiApiKeyError() });
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
          const result = await modelClient({ model: model.id, maxTokens: model.maxTokens, system: ABSTRACTION_PROMPT, messages, ...(model.thinkingLevel === 'default' ? {} : { thinkingLevel: model.thinkingLevel }) }, { timeoutMs: 240_000, createTimeoutSignal: ms => ({ signal: AbortSignal.timeout(ms), cleanup() {} }) });
          const text = String(result.text || '');
          const usage = result.usage || {};
          return { ...model, text, fields: fieldsFromText(text), usage, latencyMs: Date.now() - started, stopReason: result.stopReason || null, modelVersion: result.model || model.id, ...estimateCost(model.id, usage) };
        } catch (error) {
          return { ...model, error: sanitizeModelClientError(error), latencyMs: Date.now() - started };
        }
      }));
      return res.status(200).json({ filename: upload.filename, pageCount: upload.pages.length, inputMode: 'rendered_images', models: results });
    } finally { active = false; }
  };
}
