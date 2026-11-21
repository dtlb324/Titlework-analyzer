import { createHash } from 'crypto';
import { hasKeyIllegibleMarker, validateAbstractQuality } from '../../public/ocr-accuracy.js';
import { abstractionApiKeyError, invokeModel, isGeminiModel, sanitizeModelClientError, shouldUseOpenRouter } from './model-client.js';
import { callLeaseMs, chunkLeaseLostError, isChunkLeaseLostError, renewChunkLease } from './abstraction-lease.js';
import { getGeminiFileApiConfig, shouldUseGeminiFileApi, uploadGeminiFile } from './gemini-files.js';
import { messagesHaveVisualMedia, resolveGeminiMediaResolution } from './gemini-request.js';
import { estimatePdfPlanningPayloadBytes, resolvePdfTextDelivery } from './pdf-text.js';
import { getStorageConfig, isAllowedStorageUrl, readObject, storageIsConfigured, writeObject } from './storage.js';

const REQUEST_ENVELOPE_SAFE_BYTES = clampInt(process.env.REQUEST_ENVELOPE_SAFE_BYTES, 18_000_000, 100_000, 20_000_000);
const REQUEST_OVERHEAD_BYTES = 350_000;
const DEFAULT_ABSTRACT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_ESCALATION_MODEL = 'claude-sonnet-5-5';
const REMOVED_ABSTRACT_MODELS = new Set(['claude-haiku-4-5', 'claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest']);

export function resolveAbstractModel() {
  const configured = String(process.env.ABSTRACT_MODEL || DEFAULT_ABSTRACT_MODEL).trim();
  if (REMOVED_ABSTRACT_MODELS.has(configured) || /^claude-haiku/i.test(configured)) {
    return DEFAULT_ABSTRACT_MODEL;
  }
  return configured;
}

export function resolveEscalationModel() {
  return String(process.env.ABSTRACT_ESCALATION_MODEL || DEFAULT_ESCALATION_MODEL).trim() || DEFAULT_ESCALATION_MODEL;
}

export function resolveEscalationMaxTokens() {
  return clampInt(process.env.ABSTRACT_ESCALATION_MAX_TOKENS, 4096, 512, 8192);
}

const ABSTRACT_MODEL = resolveAbstractModel();
const ABSTRACT_MAX_TOKENS = clampInt(process.env.ABSTRACT_MAX_TOKENS, 2000, 512, 4096);
const UPSTREAM_TIMEOUT_MS = clampInt(process.env.ABSTRACTION_UPSTREAM_TIMEOUT_MS || process.env.CLOUD_RUN_UPSTREAM_TIMEOUT_MS, 240_000, 10_000, 300_000);
const SPLITTABLE_PDF_FETCH_MAX_BYTES = clampInt(process.env.ABSTRACTION_SPLITTABLE_PDF_MAX_BYTES, 25_000_000, 1_000_000, 100_000_000);
export const ABSTRACTION_WAVE_RAW_BYTES = 128_000_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const STALE_PROCESSING_MS = 2 * 60 * 1000;
const DEFAULT_LEASE_MS = 90_000;
const MAX_RETRY_WAIT_MS = 5 * 60_000;
const RAW_PERSISTENCE_KEYS = new Set([
  'data',
  'base64',
  'rawBase64',
  'rawPdfBase64',
  'rawImageBase64',
  'pdfBase64',
  'imageBase64',
  'documentData',
  'rawDocument',
  'csvText',
  'sourceBytes',
]);

export const BATCH_ABSTRACT_RESPONSE_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      docIndex: { type: 'integer' },
      abstract: { type: 'string' },
    },
    required: ['docIndex', 'abstract'],
  },
};

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export const ABSTRACTION_PROMPT = `You are an expert oil and gas title attorney abstracting a single courthouse instrument. Be accurate, concise, and cautious. Extract only what is clearly visible.

Respond in this exact format - no extra commentary:

DOC TYPE: [type]
DATE EXECUTED: [date, "not stated", or ILLEGIBLE - VERIFY MANUALLY]
DATE RECORDED: [date, "unrecorded", "not stated", or ILLEGIBLE - VERIFY MANUALLY]
RECORDING REF: [Vol/Page or instrument number, "unrecorded", "not stated", or ILLEGIBLE - VERIFY MANUALLY]
GRANTOR: [exact name(s) as written, "not stated", or ILLEGIBLE - VERIFY MANUALLY]
GRANTEE: [exact name(s) as written, "not applicable" if this instrument type has no grantee, "not stated", or ILLEGIBLE - VERIFY MANUALLY]
LEGAL DESC: [quoted description, abbreviated if long - note survey type]
SURFACE: [yes/no/unclear]
MINERALS: [yes/no/unclear - fraction if stated]
ROYALTY/NPRI: [yes/no - fraction if stated]
TERM: [perpetual/term - specify if term]
AFTER-ACQUIRED TITLE: [yes/no]
FRACTION CONVEYED: [exact wording]
RESERVATIONS: [quote verbatim - if none, write "none stated"]
WARRANTY: [full/special/quitclaim]
ACKNOWLEDGMENT: [yes/no/unclear]
ISSUES: [list any illegible text, marital property concerns, execution defects, ambiguities - or "none noted"]
CONFIDENCE: [one sentence]

Write ILLEGIBLE - VERIFY MANUALLY only for text that is present (or clipped/obscured) on the document but cannot be read clearly. Never write "not visible", "N/A", or leave a field blank as a substitute for unreadable text — use ILLEGIBLE - VERIFY MANUALLY. When the document is legible and a field is genuinely omitted, write "not stated" (or "unrecorded" for an unrecorded instrument's recording date/reference, or "not applicable" when a field genuinely does not exist for this instrument type). DO NOT GUESS or fill in missing information.`;

export function getAbstractionConfig() {
  return {
    requestEnvelopeSafeBytes: REQUEST_ENVELOPE_SAFE_BYTES,
    model: ABSTRACT_MODEL,
    maxTokens: ABSTRACT_MAX_TOKENS,
    escalationModel: resolveEscalationModel(),
    escalationMaxTokens: resolveEscalationMaxTokens(),
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
  };
}

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

function safeJsonStringify(value) {
  return JSON.stringify(value);
}

export function estimateRequestBytes(model, maxTokens, system, messages) {
  return utf8ByteLength(safeJsonStringify({ model, max_tokens: maxTokens, system, messages }));
}

function normalizeBytes(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  return Buffer.from(String(payload || ''), 'utf8');
}

const ALLOWED_RENDERED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export function getRenderedImagePages(chunk, delivery = null) {
  if (Array.isArray(delivery?.pages) && delivery.pages.length) return delivery.pages;
  if (Array.isArray(chunk?.renderedImages) && chunk.renderedImages.length) return chunk.renderedImages;
  return null;
}

export function buildRenderedImageBlocks(pages) {
  return pages.map((page, index) => {
    const mediaType = String(page?.mediaType || '').toLowerCase();
    if (!ALLOWED_RENDERED_IMAGE_TYPES.has(mediaType)) {
      const error = new Error(`Unsupported rendered page image type at page ${index + 1}: ${page?.mediaType || 'unknown'}`);
      error.status = 400;
      throw error;
    }
    let data = '';
    if (typeof page?.data === 'string' && page.data.trim()) {
      data = page.data.trim();
    } else if (page?.bytes != null) {
      data = normalizeBytes(page.bytes).toString('base64');
    }
    if (!data) {
      const error = new Error(`Rendered page ${index + 1} is missing image data.`);
      error.status = 400;
      throw error;
    }
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data,
      },
    };
  });
}

function isPdfChunk(chunk) {
  return !chunk.renderedImages && (chunk.mediaType === 'application/pdf' || /\.pdf$/i.test(chunk.originalFilename || ''));
}

function isPotentiallySplittablePdfChunk(chunk) {
  return isPdfChunk(chunk) && (!chunk.pageStart || !chunk.pageEnd || chunk.pageEnd > chunk.pageStart);
}

function isImageChunk(chunk) {
  return /^image\/[-+.a-z0-9]+$/i.test(chunk.mediaType || '');
}

function isCsvChunk(chunk) {
  return !chunk.renderedImages && (chunk.mediaType === 'text/csv' || /\.csv$/i.test(chunk.originalFilename || ''));
}

function inlineRawBytesLimit() {
  return Math.floor(Math.max(1, REQUEST_ENVELOPE_SAFE_BYTES - REQUEST_OVERHEAD_BYTES) * 0.70);
}

function geminiFilesCanCarryAbstraction() {
  return getGeminiFileApiConfig().enabled && isGeminiModel(ABSTRACT_MODEL) && !shouldUseOpenRouter(ABSTRACT_MODEL);
}

// A multi-page PDF of any uploadable size can be split by page range, but one chunk must fit in a queue
// wave or planAbstractionWave never admits it.
function maxRawBlobBytesForChunk(chunk) {
  if (isPotentiallySplittablePdfChunk(chunk)) {
    return Math.max(inlineRawBytesLimit(), SPLITTABLE_PDF_FETCH_MAX_BYTES, Math.min(getStorageConfig().maxUploadBytes, ABSTRACTION_WAVE_RAW_BYTES));
  }
  if (isCsvChunk(chunk)) return Math.max(1, REQUEST_ENVELOPE_SAFE_BYTES - REQUEST_OVERHEAD_BYTES);
  if (geminiFilesCanCarryAbstraction()) return Math.max(inlineRawBytesLimit(), getGeminiFileApiConfig().maxBytes);
  return inlineRawBytesLimit();
}

// Building a base64 request that cannot fit the envelope costs about five times the file in memory.
function assertInlineVisualCanFit(chunk, payloadBytes, delivery) {
  const renderedPages = getRenderedImagePages(chunk, delivery);
  if (renderedPages) {
    const base64Bytes = renderedPages.reduce((sum, page) => {
      if (typeof page?.data === 'string') return sum + page.data.length;
      if (page?.bytes != null) return sum + Math.ceil(normalizeBytes(page.bytes).byteLength / 3) * 4;
      return sum;
    }, 0);
    if (base64Bytes > REQUEST_ENVELOPE_SAFE_BYTES) {
      const error = new Error(`Rendered page images are too large to send inline (${(base64Bytes / 1024 / 1024).toFixed(1)} MB).`);
      error.status = 413;
      throw error;
    }
    return;
  }
  if (!(isPdfChunk(chunk) || isImageChunk(chunk)) || delivery.fileUri) return;
  if (delivery.mode !== 'visual' && delivery.mode !== 'hybrid') return;
  const visual = delivery.mode === 'hybrid' && delivery.visualBytes ? delivery.visualBytes : payloadBytes;
  const base64Bytes = Math.ceil(visual.byteLength / 3) * 4;
  if (base64Bytes > REQUEST_ENVELOPE_SAFE_BYTES) {
    const error = new Error(`Chunk is too large to send inline (${(visual.byteLength / 1024 / 1024).toFixed(1)} MB).`);
    error.status = 413;
    throw error;
  }
}

function assertBlobSizeWithinBudget(chunk, sizeBytes) {
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size < 0) return;
  const maxBytes = maxRawBlobBytesForChunk(chunk);
  if (size > maxBytes) {
    const error = new Error(`Chunk Blob is too large for abstraction request budget (${(size / 1024 / 1024).toFixed(1)} MB).`);
    error.status = 413;
    throw error;
  }
}

function chunkDisplayName(chunk) {
  if (chunk.renderedImages) return `${chunk.originalFilename || chunk.id} (rendered pages)`;
  if (chunk.pageStart && chunk.pageEnd && !/\(pp\s+\d+/i.test(chunk.originalFilename || '')) {
    return `${chunk.originalFilename} (pp ${chunk.pageStart}${chunk.pageEnd === chunk.pageStart ? '' : `-${chunk.pageEnd}`})`;
  }
  return chunk.originalFilename || chunk.id;
}

export function buildAbstractMessagesForChunk(chunk, payloadBytes, sequenceIndex = 0, delivery = null) {
  const bytes = normalizeBytes(payloadBytes);
  const docNum = sequenceIndex + 1;
  const name = chunkDisplayName(chunk);
  const content = [];
  let textPrompt = `Abstract the following document as DOCUMENT #${docNum} (${name}). Label the section clearly as DOCUMENT #${docNum}:. Extract every relevant fact. Do not guess at anything illegible.`;

  if (chunk.splitFrom || (chunk.pageStart && chunk.pageEnd)) {
    textPrompt += ' This file is a page range from a larger PDF. Abstract this part fully and note the source document/page range.';
  }

  const renderedPages = getRenderedImagePages(chunk, delivery);
  if (renderedPages) {
    content.push(...buildRenderedImageBlocks(renderedPages));
    if (renderedPages.length > 1) {
      textPrompt += ' This document is provided as high-DPI rendered page images in page order.';
    }
  } else if (isCsvChunk(chunk)) {
    const csvText = bytes.toString('utf8');
    textPrompt += `\n\nDOCUMENT #${docNum} (${name}) - CSV DATA:\n${csvText}\n\nAbstract this CSV as a structured ownership or lease record. Identify all owners, interests, fractions, and any other relevant title information.`;
  } else if (isPdfChunk(chunk)) {
    const pdf = pdfDeliveryParts(bytes, delivery, docNum, name);
    textPrompt += pdf.promptSuffix;
    if (pdf.documentBlock) content.push(pdf.documentBlock);
  } else if (isImageChunk(chunk) && delivery?.mode === 'gemini_file' && delivery.fileUri) {
    content.push({
      type: 'image',
      source: {
        type: 'file_uri',
        media_type: delivery.mimeType || chunk.mediaType,
        uri: delivery.fileUri,
        geminiFileName: delivery.geminiFileName || null,
      },
    });
  } else if (isImageChunk(chunk)) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: chunk.mediaType,
        data: bytes.toString('base64'),
      },
    });
  } else {
    throw new Error(`Unsupported chunk media type: ${chunk.mediaType || 'unknown'}`);
  }

  content.push({ type: 'text', text: textPrompt });
  return [{ role: 'user', content }];
}

function visualPdfDocumentBlock(delivery, bytes) {
  if (delivery?.fileUri) {
    return {
      type: 'document',
      source: {
        type: 'file_uri',
        media_type: delivery.mimeType || 'application/pdf',
        uri: delivery.fileUri,
        geminiFileName: delivery.geminiFileName || null,
      },
    };
  }
  const visual = delivery?.visualBytes ? normalizeBytes(delivery.visualBytes) : bytes;
  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: visual.toString('base64'),
    },
  };
}

function pdfDeliveryParts(bytes, delivery, docNum, name) {
  if (delivery?.mode === 'text' && delivery.extractedText) {
    return {
      promptSuffix: `\n\nDOCUMENT #${docNum} (${name}) - EXTRACTED PDF TEXT:\n${delivery.extractedText}\n\nAbstract from this extracted text. If extraction omitted visible content, note gaps under ISSUES and write ILLEGIBLE - VERIFY MANUALLY where needed.`,
      documentBlock: null,
    };
  }
  if (delivery?.mode === 'hybrid' && delivery.extractedText) {
    const visualPageList = Array.isArray(delivery.visualPages) && delivery.visualPages.length
      ? delivery.visualPages
      : (Array.isArray(delivery.sparsePages) && delivery.sparsePages.length ? delivery.sparsePages : null);
    const pagesLabel = visualPageList ? visualPageList.join(', ') : 'scanned, stamped, or sparse pages';
    return {
      promptSuffix: `\n\nDOCUMENT #${docNum} (${name}) - HYBRID PDF:\nText-extracted pages:\n${delivery.extractedText}\n\nPages (${pagesLabel}) contain visual content (scans, stamps, signatures, or sparse/noisy text) and are attached as a visual PDF in that original page order. Abstract those pages — including any recording stamps, handwritten notes, signatures, or marginalia — from the attached PDF. Stay coverage-complete across extracted text and attached pages.`,
      documentBlock: visualPdfDocumentBlock(delivery, bytes),
    };
  }
  if (delivery?.mode === 'gemini_file' && delivery.fileUri) {
    return { promptSuffix: '', documentBlock: visualPdfDocumentBlock(delivery, bytes) };
  }
  return { promptSuffix: '', documentBlock: visualPdfDocumentBlock(delivery, bytes) };
}

export function buildAbstractMessagesForChunks(items, globalStartIdx = 0) {
  const labels = items.map((item, index) => {
    const docNum = globalStartIdx + index + 1;
    return `Document #${docNum} (${chunkDisplayName(item.chunk)})`;
  });
  const docNums = items.map((_, index) => globalStartIdx + index + 1);
  let instructionsPrompt = `Abstract each of the following ${items.length} document${items.length === 1 ? '' : 's'} in order: ${labels.join(', ')}.

Return a JSON array of exactly ${items.length} object${items.length === 1 ? '' : 's'}, each with {"docIndex": <number>, "abstract": "<string>"}, matching the exact document numbers above (${docNums.join(', ')}). Each "abstract" must follow the output format from your instructions. If a document has no abstractable content, use the string "No abstractable content."

Extract every relevant fact. Do not guess at anything illegible.`;
  if (items.some(item => item.chunk.splitFrom || (item.chunk.pageStart && item.chunk.pageEnd))) {
    instructionsPrompt += ' Some files are page ranges from a larger PDF. Abstract each part fully and note the source document/page range.';
  }

  let hasVisualBlock = false;
  const interleavedContent = [];
  const textSections = [];

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const docNum = globalStartIdx + index + 1;
    const name = chunkDisplayName(item.chunk);
    const startMarker = `--- START DOCUMENT #${docNum} (${name}) ---`;
    const endMarker = `--- END DOCUMENT #${docNum} (${name}) ---`;
    const bytes = normalizeBytes(item.payloadBytes);
    const delivery = item.delivery || null;
    const renderedPages = getRenderedImagePages(item.chunk, delivery);

    if (renderedPages) {
      hasVisualBlock = true;
      const pageNote = renderedPages.length > 1
        ? `\nDOCUMENT #${docNum} (${name}) is provided as ${renderedPages.length} high-DPI rendered page images in page order.`
        : '';
      interleavedContent.push({ type: 'text', text: `${startMarker}${pageNote}` });
      interleavedContent.push(...buildRenderedImageBlocks(renderedPages));
      interleavedContent.push({ type: 'text', text: endMarker });
    } else if (isCsvChunk(item.chunk)) {
      const csvText = bytes.toString('utf8');
      const sectionText = `${startMarker}\nDOCUMENT #${docNum} (${name}) - CSV DATA:\n${csvText}\n\nAbstract this CSV as a structured ownership or lease record. Identify all owners, interests, fractions, and any other relevant title information.\n${endMarker}`;
      textSections.push(`\n\n${sectionText}`);
      interleavedContent.push({ type: 'text', text: sectionText });
    } else if (isPdfChunk(item.chunk)) {
      const pdf = pdfDeliveryParts(bytes, delivery, docNum, name);
      if (pdf.documentBlock) {
        hasVisualBlock = true;
        interleavedContent.push({ type: 'text', text: `${startMarker}${pdf.promptSuffix}` });
        interleavedContent.push(pdf.documentBlock);
        interleavedContent.push({ type: 'text', text: endMarker });
      } else {
        const sectionText = `${startMarker}${pdf.promptSuffix}\n${endMarker}`;
        textSections.push(`\n\n${sectionText}`);
        interleavedContent.push({ type: 'text', text: sectionText });
      }
    } else if (isImageChunk(item.chunk) && delivery?.mode === 'gemini_file' && delivery.fileUri) {
      hasVisualBlock = true;
      interleavedContent.push({ type: 'text', text: startMarker });
      interleavedContent.push({
        type: 'image',
        source: {
          type: 'file_uri',
          media_type: delivery.mimeType || item.chunk.mediaType,
          uri: delivery.fileUri,
          geminiFileName: delivery.geminiFileName || null,
        },
      });
      interleavedContent.push({ type: 'text', text: endMarker });
    } else if (isImageChunk(item.chunk)) {
      hasVisualBlock = true;
      interleavedContent.push({ type: 'text', text: startMarker });
      interleavedContent.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: item.chunk.mediaType,
          data: bytes.toString('base64'),
        },
      });
      interleavedContent.push({ type: 'text', text: endMarker });
    } else {
      throw new Error(`Unsupported chunk media type: ${item.chunk.mediaType || 'unknown'}`);
    }
  }

  const content = hasVisualBlock
    ? [...interleavedContent, { type: 'text', text: instructionsPrompt }]
    : [{ type: 'text', text: `${instructionsPrompt}${textSections.join('')}` }];
  return [{ role: 'user', content }];
}

export function parseBatchAbstracts(result, items, globalStartIdx = 0) {
  const trimmed = String(result || '').trim();
  const cleaned = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let parsed = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch (_) {
  }

  const expectedDocNums = new Set(items.map((_, index) => globalStartIdx + index + 1));
  const byDocIndex = new Map();
  let valid = Array.isArray(parsed) && parsed.length === items.length;
  if (valid) {
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        valid = false;
        break;
      }
      if (!Number.isInteger(entry.docIndex) || !expectedDocNums.has(entry.docIndex) || byDocIndex.has(entry.docIndex)) {
        valid = false;
        break;
      }
      if (typeof entry.abstract !== 'string') {
        valid = false;
        break;
      }
      const abstractText = entry.abstract.trim();
      const headerMatch = abstractText.match(/^DOCUMENT\s*#(\d+)\s*:?/i);
      if (headerMatch && Number(headerMatch[1]) !== entry.docIndex) {
        valid = false;
        break;
      }
      byDocIndex.set(entry.docIndex, abstractText);
    }
  }
  if (byDocIndex.size !== items.length) {
    valid = false;
  }

  return items.map((item, index) => ({
    chunk: item.chunk,
    abstractText: valid ? (byDocIndex.get(globalStartIdx + index + 1) ?? '') : '',
    sequenceIndex: globalStartIdx + index,
  }));
}

export function validateAbstractPersistenceInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, reason: 'Invalid abstract persistence payload.' };
  }
  const stack = [input];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (RAW_PERSISTENCE_KEYS.has(key)) {
        return { valid: false, reason: 'Stored abstract records must not include raw document bytes, CSV text, or base64 payloads.' };
      }
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  if (typeof input.abstractText !== 'string' || !input.abstractText.trim()) {
    return { valid: false, reason: 'abstractText is required.' };
  }
  return { valid: true };
}

function createTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return { signal: AbortSignal.timeout(ms), cleanup() {} };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cleanup: () => clearTimeout(timeout) };
}

function classifyError(err) {
  const status = Number(err?.status || err?.statusCode || err?.response?.status || 0);
  const message = String(err?.message || err || '');
  if (err?.code === 'output_truncated') return 'output_truncated';
  if (status === 413 || /too large|payload|request entity/i.test(message)) return 'payload_too_large';
  if (status === 429 || /rate limit|overloaded/i.test(message)) return 'rate_limit';
  if ([504, 524].includes(status) || /timeout|aborted|FUNCTION_INVOCATION_TIMEOUT/i.test(message)) return 'upstream_timeout';
  if (/blob|storage|fetch/i.test(message)) return 'storage_error';
  return 'provider_error';
}

function sanitizeErrorMessage(err) {
  return sanitizeModelClientError(err);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logChunkStage(stage, chunk, details = {}, enabled = false) {
  if (!enabled) return;
  try {
    console.log(JSON.stringify({
      event: 'chunk_abstraction_stage',
      stage,
      jobId: chunk?.jobId,
      chunkId: chunk?.id,
      documentId: chunk?.documentId,
      mediaType: chunk?.mediaType,
      sizeBytes: chunk?.sizeBytes ?? null,
      ...details,
    }));
  } catch {
  }
}

export function assertSafeBlobUrl(blobUrl) {
  let parsed;
  try {
    parsed = new URL(blobUrl);
  } catch {
    const error = new Error('Invalid storage URL.');
    error.statusCode = 400;
    throw error;
  }
  if (!isAllowedStorageUrl(blobUrl)) {
    const error = new Error('Chunk storage URL must be a Google Cloud Storage object URL.');
    error.statusCode = 400;
    throw error;
  }
  return parsed;
}

export function abstractionReadLimit(chunk) {
  const declared = Number(chunk.sizeBytes);
  const maximum = maxRawBlobBytesForChunk(chunk);
  return Number.isFinite(declared) && declared > 0 ? Math.min(Math.ceil(declared), maximum) : maximum;
}

export async function defaultBlobLoader(chunk, options = {}) {
  if (!chunk.blobUrl) {
    const error = new Error(`Chunk ${chunk.id} is missing a storage URL.`);
    error.statusCode = 500;
    throw error;
  }
  assertSafeBlobUrl(chunk.blobUrl);
  assertBlobSizeWithinBudget(chunk, chunk.sizeBytes);
  const maxBytes = abstractionReadLimit(chunk);
  const loader = options.blobLoader || options.objectReader || globalThis.__TITLE_ANALYZER_OBJECT_READER__ || globalThis.__TITLE_ANALYZER_BLOB_LOADER__;
  const payload = loader
    ? await loader(chunk)
    : await readObject(chunk, { ...options, maxBytes });
  assertBlobSizeWithinBudget(chunk, payload.bytes.byteLength);
  if (payload.bytes.byteLength > maxBytes) {
    const error = new Error('Chunk storage bytes exceed the admitted raw byte limit.');
    error.status = 413;
    throw error;
  }
  return payload;
}

async function defaultModelClient(request) {
  const timeout = createTimeoutSignal(UPSTREAM_TIMEOUT_MS);
  try {
    return await invokeModel(request, {
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      createTimeoutSignal: () => timeout,
    });
  } finally {
    timeout.cleanup();
  }
}

export function getBlobLoader(options) {
  return options.blobLoader || globalThis.__TITLE_ANALYZER_BLOB_LOADER__ || defaultBlobLoader;
}

function getModelClient(options) {
  return options.modelClient || globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ || defaultModelClient;
}

export async function resolveChunkDelivery(chunk, payloadBytes) {
  if (Array.isArray(chunk?.renderedImages) && chunk.renderedImages.length) {
    return { mode: 'rendered_images', pages: chunk.renderedImages };
  }
  if (isPdfChunk(chunk)) {
    return await resolvePdfTextDelivery(payloadBytes, {
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
    });
  }
  return { mode: 'visual' };
}

export async function enrichVisualDeliveryForModel(delivery, chunk, payloadBytes, model) {
  if (getRenderedImagePages(chunk, delivery)) {
    return delivery;
  }
  if (!delivery || !isGeminiModel(model)) {
    return delivery;
  }
  const needsVisualUpload = delivery.mode === 'visual' || delivery.mode === 'hybrid';
  if (!needsVisualUpload) return delivery;
  if (shouldUseOpenRouter(model)) {
    return delivery;
  }
  const bytes = delivery.mode === 'hybrid' && delivery.visualBytes
    ? normalizeBytes(delivery.visualBytes)
    : normalizeBytes(payloadBytes);
  if (!shouldUseGeminiFileApi(bytes.byteLength)) {
    return delivery;
  }
  if (!isPdfChunk(chunk) && !isImageChunk(chunk)) {
    return delivery;
  }
  const mimeType = isPdfChunk(chunk) ? 'application/pdf' : (chunk.mediaType || 'image/jpeg');
  try {
    const uploaded = await uploadGeminiFile(bytes, mimeType, chunkDisplayName(chunk));
    if (delivery.mode === 'hybrid') {
      return {
        ...delivery,
        fileUri: uploaded.uri,
        geminiFileName: uploaded.name,
        mimeType: uploaded.mimeType,
        sizeBytes: bytes.byteLength,
      };
    }
    return {
      mode: 'gemini_file',
      fileUri: uploaded.uri,
      geminiFileName: uploaded.name,
      mimeType: uploaded.mimeType,
      reason: 'gemini_file_api',
      sizeBytes: bytes.byteLength,
    };
  } catch (err) {
    console.warn(JSON.stringify({
      event: 'gemini_file_upload_fallback',
      chunkId: chunk?.id,
      message: String(err?.message || err).slice(0, 500),
    }));
    return delivery;
  }
}

export function estimateAbstractPayloadBytes(chunk, payloadBytes = null, delivery = null) {
  const renderedPages = getRenderedImagePages(chunk, delivery);
  if (renderedPages) {
    const imageBytes = renderedPages.reduce((sum, page) => {
      if (typeof page?.data === 'string') return sum + page.data.length;
      if (page?.bytes != null) return sum + Math.ceil(normalizeBytes(page.bytes).byteLength * 1.37);
      return sum;
    }, 0);
    return imageBytes + 2_000;
  }
  if (delivery?.mode === 'text') {
    return Math.min(
      REQUEST_ENVELOPE_SAFE_BYTES,
      Buffer.byteLength(String(delivery.extractedText || ''), 'utf8') + 4_000,
    );
  }
  if (delivery?.mode === 'hybrid') {
    const textBytes = Buffer.byteLength(String(delivery.extractedText || ''), 'utf8') + 4_000;
    if (delivery.fileUri) return textBytes + 6_000;
    const visual = delivery.visualBytes?.byteLength || 0;
    return textBytes + Math.ceil(visual * 1.37);
  }
  if (delivery?.mode === 'gemini_file') {
    return 6_000;
  }
  if (isCsvChunk(chunk)) {
    const size = (payloadBytes?.byteLength ?? Number(chunk.sizeBytes)) || 0;
    return size + 500;
  }
  const size = (payloadBytes?.byteLength ?? Number(chunk.sizeBytes)) || 0;
  if (isPdfChunk(chunk)) {
    return estimatePdfPlanningPayloadBytes(size, {
      geminiFileMinBytes: Number(process.env.GEMINI_FILE_API_MIN_BYTES) || 1_500_000,
    });
  }
  if (payloadBytes) {
    return Math.ceil(payloadBytes.byteLength * 1.37);
  }
  return Math.ceil(size * 1.37);
}

function sanitizeEscalationWarningMessage(message) {
  let sanitized = sanitizeModelClientError(message);
  for (const envKey of ['ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']) {
    const secret = process.env[envKey];
    if (typeof secret === 'string' && secret.length >= 8) {
      sanitized = sanitized.split(secret).join('[REDACTED]');
    }
  }
  return sanitized.slice(0, 500);
}

function logEscalationFailure({ chunk = null, model, reasons = [], errorType, message }) {
  try {
    console.warn(JSON.stringify({
      event: 'abstraction_escalation_failed',
      jobId: chunk?.jobId ?? null,
      chunkId: chunk?.id ?? null,
      model,
      reasons,
      errorType,
      message: sanitizeEscalationWarningMessage(message),
    }));
  } catch {
  }
}

export function isAbstractionEscalationEnabled({ model, escalationModel, options = {}, responseSchema = null } = {}) {
  return !responseSchema
    && options?.escalationEnabled !== false
    && process.env.ABSTRACTION_ESCALATION_ENABLED !== 'false'
    && Boolean(escalationModel)
    && escalationModel !== model;
}

export function buildEscalationQualityContext(chunk, delivery = null) {
  const isCsv = chunk ? isCsvChunk(chunk) : false;
  return {
    isCsv,
    documentText: !isCsv && delivery?.mode === 'text' ? (delivery.extractedText || null) : null,
  };
}

export async function buildEscalationRequestForChunk({
  chunk,
  payloadBytes,
  sequenceIndex = 0,
  escalationModel = resolveEscalationModel(),
  escalationMaxTokens = resolveEscalationMaxTokens(),
}) {
  const rawBytes = normalizeBytes(payloadBytes);
  const delivery = await enrichVisualDeliveryForModel({ mode: 'visual' }, chunk, rawBytes, escalationModel);
  assertInlineVisualCanFit(chunk, rawBytes, delivery);
  const messages = buildAbstractMessagesForChunk(chunk, rawBytes, sequenceIndex, delivery);
  const requestBytes = estimateRequestBytes(escalationModel, escalationMaxTokens, ABSTRACTION_PROMPT, messages);
  if (requestBytes > REQUEST_ENVELOPE_SAFE_BYTES) {
    const error = new Error(`Escalation request too large (${(requestBytes / 1024 / 1024).toFixed(1)} MB).`);
    error.status = 413;
    throw error;
  }
  return { messages, payloadBytes: requestBytes, delivery };
}

export async function runChunkEscalation({
  chunk,
  payloadBytes,
  sequenceIndex = 0,
  escalationModel = resolveEscalationModel(),
  escalationMaxTokens = resolveEscalationMaxTokens(),
  reasons = [],
  mediaResolution = undefined,
  options = {},
}) {
  const modelClient = getModelClient(options);
  let guardError = null;
  try {
    const request = await buildEscalationRequestForChunk({
      chunk,
      payloadBytes,
      sequenceIndex,
      escalationModel,
      escalationMaxTokens,
    });
    const escalationMediaResolution = isGeminiModel(escalationModel) && !shouldUseOpenRouter(escalationModel) && messagesHaveVisualMedia(request.messages)
      ? resolveGeminiMediaResolution(mediaResolution)
      : null;
    try {
      await options.modelCallGuard?.();
    } catch (err) {
      guardError = err;
      throw err;
    }
    const escalatedResponse = await modelClient({
      model: escalationModel,
      maxTokens: escalationMaxTokens,
      system: ABSTRACTION_PROMPT,
      messages: request.messages,
      payloadBytes: request.payloadBytes,
      escalation: true,
      ...(escalationMediaResolution ? { mediaResolution: escalationMediaResolution } : {}),
    });
    const usage = extractUsage(escalatedResponse?.usage);
    if (escalatedResponse?.stopReason === 'max_tokens') {
      logEscalationFailure({
        chunk,
        model: escalationModel,
        reasons,
        errorType: 'output_truncated',
        message: 'Escalated model output was truncated at the token limit (max_tokens).',
      });
      return {
        ok: false,
        truncated: true,
        usage,
        response: escalatedResponse,
        payloadBytes: request.payloadBytes,
      };
    }
    const text = String(escalatedResponse?.text || '').trim();
    if (!text) {
      logEscalationFailure({
        chunk,
        model: escalationModel,
        reasons,
        errorType: 'empty_output',
        message: 'Escalated model returned empty output.',
      });
      return {
        ok: false,
        truncated: false,
        usage,
        response: escalatedResponse,
        payloadBytes: request.payloadBytes,
      };
    }
    return {
      ok: true,
      text: escalatedResponse.text || '',
      model: escalatedResponse.model || escalationModel,
      usage,
      payloadBytes: request.payloadBytes,
      deliveryMode: request.delivery.mode,
      stopReason: escalatedResponse.stopReason || null,
    };
  } catch (err) {
    if (guardError) throw guardError;
    logEscalationFailure({
      chunk,
      model: escalationModel,
      reasons,
      errorType: classifyError(err),
      message: err?.message || String(err),
    });
    return {
      ok: false,
      truncated: false,
      usage: null,
      error: err,
    };
  }
}

export async function runModelAbstraction({
  messages,
  model,
  maxTokens,
  payloadBytes,
  escalationModel = resolveEscalationModel(),
  escalationMaxTokens = resolveEscalationMaxTokens(),
  responseSchema = null,
  chunk = null,
  rawPayloadBytes = null,
  sequenceIndex = 0,
  escalationContext = {},
  mediaResolution = undefined,
  options = {},
}) {
  const modelClient = getModelClient(options);
  const schemaForModel = responseSchema && isGeminiModel(model) ? responseSchema : null;
  const hasVisualMedia = messagesHaveVisualMedia(messages);
  const mediaResolutionForModel = isGeminiModel(model) && !shouldUseOpenRouter(model) && hasVisualMedia
    ? resolveGeminiMediaResolution(mediaResolution)
    : null;
  // Awaited before every billable call. A guard error (lost lease) propagates and is never swallowed.
  const guard = typeof options.modelCallGuard === 'function' ? options.modelCallGuard : null;
  if (guard) await guard();
  let response = await modelClient({
    model,
    maxTokens,
    system: ABSTRACTION_PROMPT,
    messages,
    payloadBytes,
    ...(schemaForModel ? { responseSchema: schemaForModel } : {}),
    ...(mediaResolutionForModel ? { mediaResolution: mediaResolutionForModel } : {}),
  });
  let usage = extractUsage(response.usage);
  let finalPayloadBytes = payloadBytes;
  const escalationEnabled = isAbstractionEscalationEnabled({ model, escalationModel, options, responseSchema });
  const assessment = escalationEnabled
    ? evaluateAbstractEscalation(response.text, usage, maxTokens, escalationContext)
    : { shouldEscalate: false, reasons: [], quality: null };
  let escalated = false;

  if (escalationEnabled && assessment.shouldEscalate) {
    if (chunk && rawPayloadBytes != null) {
      const escalatedResult = await runChunkEscalation({
        chunk,
        payloadBytes: rawPayloadBytes,
        sequenceIndex,
        escalationModel,
        escalationMaxTokens,
        reasons: assessment.reasons,
        mediaResolution,
        options,
      });
      if (escalatedResult.usage) {
        usage = addUsage(usage, escalatedResult.usage);
      }
      if (escalatedResult.ok) {
        response = {
          text: escalatedResult.text,
          model: escalatedResult.model,
          stopReason: escalatedResult.stopReason,
        };
        finalPayloadBytes = escalatedResult.payloadBytes ?? finalPayloadBytes;
        escalated = true;
      } else if (escalatedResult.truncated) {
        response = escalatedResult.response;
        finalPayloadBytes = escalatedResult.payloadBytes ?? finalPayloadBytes;
        escalated = true;
      }
    } else {
      const escalationMediaResolution = isGeminiModel(escalationModel) && !shouldUseOpenRouter(escalationModel) && hasVisualMedia
        ? resolveGeminiMediaResolution(mediaResolution)
        : null;
      let guardError = null;
      try {
        try {
          if (guard) await guard();
        } catch (err) {
          guardError = err;
          throw err;
        }
        const escalatedResponse = await modelClient({
          model: escalationModel,
          maxTokens: escalationMaxTokens,
          system: ABSTRACTION_PROMPT,
          messages,
          payloadBytes,
          escalation: true,
          ...(escalationMediaResolution ? { mediaResolution: escalationMediaResolution } : {}),
        });
        usage = addUsage(usage, extractUsage(escalatedResponse.usage));
        if (escalatedResponse?.stopReason === 'max_tokens') {
          logEscalationFailure({
            chunk,
            model: escalationModel,
            reasons: assessment.reasons,
            errorType: 'output_truncated',
            message: 'Escalated model output was truncated at the token limit (max_tokens).',
          });
          response = escalatedResponse;
          escalated = true;
        } else if (String(escalatedResponse?.text || '').trim()) {
          response = escalatedResponse;
          escalated = true;
        } else {
          logEscalationFailure({
            chunk,
            model: escalationModel,
            reasons: assessment.reasons,
            errorType: 'empty_output',
            message: 'Escalated model returned empty output.',
          });
        }
      } catch (err) {
        if (guardError) throw guardError;
        logEscalationFailure({
          chunk,
          model: escalationModel,
          reasons: assessment.reasons,
          errorType: classifyError(err),
          message: err?.message || String(err),
        });
      }
    }
  }
  if (response.stopReason === 'max_tokens') {
    const err = new Error('Model output was truncated at the token limit (max_tokens).');
    err.code = 'output_truncated';
    throw err;
  }
  return {
    text: response.text || '',
    model: response.model || model,
    usage,
    escalated,
    escalationReasons: escalated ? assessment.reasons : [],
    payloadBytes: finalPayloadBytes,
  };
}

export async function persistCompletedAbstract({
  store,
  chunk,
  workerId,
  sequenceIndex,
  abstractText,
  modelUsed,
  payloadBytes,
  usage,
  latencyMs,
  attemptCount,
}) {
  const record = {
    jobId: chunk.jobId,
    documentId: chunk.documentId,
    chunkId: chunk.id,
    abstractText: stripDocumentLabel(abstractText, sequenceIndex + 1),
    modelUsed,
    payloadBytes,
    latencyMs,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    status: 'completed',
    attemptCount,
    workerId,
  };
  const validation = validateAbstractPersistenceInput(record);
  if (!validation.valid) {
    const error = new Error(validation.reason);
    error.status = 500;
    throw error;
  }
  const latestChunk = store.getChunk
    ? await store.getChunk(chunk.jobId, chunk.id)
    : chunk;
  if (
    !latestChunk
    || latestChunk.abstractionStatus !== 'processing'
    || (latestChunk.abstractionWorkerId && latestChunk.abstractionWorkerId !== workerId)
  ) {
    return { status: 'stale', chunkId: chunk.id };
  }
  const saved = await store.saveDocumentAbstract(record);
  if (!saved) {
    return { status: 'stale', chunkId: chunk.id };
  }
  return { status: 'completed', chunkId: chunk.id, abstract: record };
}

async function defaultBlobWriter(parentChunk, childName, bytes) {
  return await writeObject(parentChunk, childName, bytes);
}

function getBlobWriter(options) {
  return options.blobWriter || globalThis.__TITLE_ANALYZER_BLOB_WRITER__ || defaultBlobWriter;
}

function extractUsage(usage = {}) {
  return {
    inputTokens: Number.isInteger(usage.input_tokens) ? usage.input_tokens : Number.isInteger(usage.inputTokens) ? usage.inputTokens : null,
    outputTokens: Number.isInteger(usage.output_tokens) ? usage.output_tokens : Number.isInteger(usage.outputTokens) ? usage.outputTokens : null,
  };
}

function sumNullableTokenCounts(a, b) {
  if (a == null && b == null) return null;
  return (a || 0) + (b || 0);
}

export function addUsage(left, right) {
  return {
    inputTokens: sumNullableTokenCounts(left?.inputTokens, right?.inputTokens),
    outputTokens: sumNullableTokenCounts(left?.outputTokens, right?.outputTokens),
  };
}

export function evaluateAbstractEscalation(text, usage = {}, maxTokens = ABSTRACT_MAX_TOKENS, context = {}) {
  const value = String(text || '').trim();
  const reasons = [];
  if (!value) {
    reasons.push('empty_output');
  } else {
    if (!context?.isCsv && hasKeyIllegibleMarker(value)) {
      reasons.push('illegible_marker');
    }
    if (/CONFIDENCE:\s*(low|limited|poor|unclear|uncertain)/i.test(value)) {
      reasons.push('low_confidence');
    }
  }
  const outputTokens = Number(usage?.outputTokens ?? usage?.output_tokens ?? 0);
  if (Number.isFinite(outputTokens) && maxTokens > 0 && outputTokens >= Math.floor(maxTokens * 0.9)) {
    reasons.push('near_token_limit');
  }
  let quality = null;
  if (value && context?.checkStructure !== false && !context?.isCsv) {
    quality = validateAbstractQuality(value, { documentText: context?.documentText ?? null });
    for (const reason of quality.reasons) {
      reasons.push(reason);
    }
  }
  return {
    shouldEscalate: reasons.length > 0,
    reasons,
    quality,
  };
}

export function shouldEscalateAbstract(text, usage = {}, maxTokens = ABSTRACT_MAX_TOKENS, context = {}) {
  return evaluateAbstractEscalation(text, usage, maxTokens, context).shouldEscalate;
}

export function stripDocumentLabel(text, docNum) {
  const value = String(text || '').trim();
  const regex = new RegExp(`^DOCUMENT\\s*#${docNum}\\s*:?\\s*`, 'i');
  return value.replace(regex, '').trim() || value;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function computePdfSplitRanges(pageCount, sourcePageStart = 1, sourcePageEnd = null) {
  if (!Number.isInteger(pageCount) || pageCount <= 1) return [];
  const start = Number.isInteger(sourcePageStart) && sourcePageStart >= 1 ? sourcePageStart : 1;
  const end = Number.isInteger(sourcePageEnd) && sourcePageEnd >= start ? sourcePageEnd : start + pageCount - 1;
  if (end <= start) return [];

  const overlap = pageCount >= 4 ? 1 : 0;
  const leftCount = Math.ceil(pageCount / 2);
  const rightStartIndex = leftCount - overlap;
  return [
    { startPageIndex: 0, endPageIndex: leftCount - 1, pageStart: start, pageEnd: start + leftCount - 1 },
    { startPageIndex: rightStartIndex, endPageIndex: pageCount - 1, pageStart: start + rightStartIndex, pageEnd: end },
  ];
}

async function splitPdfChunk(parentChunk, bytes, reason, options) {
  if (!isPdfChunk(parentChunk)) {
    return false;
  }
  const hasAtomicCommit = typeof options.store?.commitSplitPdfChunks === 'function';
  if (!hasAtomicCommit && (!options.store?.createSplitChunk || !options.store?.markChunkAbstractionSplitSuperseded)) {
    return false;
  }
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(normalizeBytes(bytes), { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  if (pageCount <= 1) return false;

  const sourcePageStart = parentChunk.pageStart || 1;
  const sourcePageEnd = parentChunk.pageEnd && parentChunk.pageEnd >= sourcePageStart
    ? parentChunk.pageEnd
    : sourcePageStart + pageCount - 1;
  const ranges = computePdfSplitRanges(pageCount, sourcePageStart, sourcePageEnd);
  if (!ranges.length) return false;
  const baseName = String(parentChunk.originalFilename || 'document.pdf').replace(/\.pdf$/i, '');

  const preparedChildren = [];
  for (const range of ranges) {
    const childDoc = await PDFDocument.create();
    const indices = [];
    for (let i = range.startPageIndex; i <= range.endPageIndex; i++) indices.push(i);
    const pages = await childDoc.copyPages(source, indices);
    for (const page of pages) childDoc.addPage(page);
    const childBytes = Buffer.from(await childDoc.save());
    const childName = `${baseName} (pp ${range.pageStart}${range.pageEnd === range.pageStart ? '' : `-${range.pageEnd}`}).pdf`;
    const blob = await getBlobWriter(options)(parentChunk, childName, childBytes);
    preparedChildren.push({
      originalFilename: childName,
      mediaType: 'application/pdf',
      sizeBytes: childBytes.byteLength,
      pageStart: range.pageStart,
      pageEnd: range.pageEnd,
      splitFrom: parentChunk.splitFrom || parentChunk.originalFilename,
      fingerprint: `${parentChunk.fingerprint || parentChunk.id}:split:${range.pageStart}-${range.pageEnd}`,
      checksumSha256: sha256Hex(childBytes),
      chunkOrder: parentChunk.chunkOrder,
      blobKey: blob.blobKey,
      blobUrl: blob.blobUrl,
      splitParentChunkId: parentChunk.id,
      splitReason: reason,
      workerId: options.workerId,
    });
  }

  if (hasAtomicCommit) {
    const committed = await options.store.commitSplitPdfChunks(
      parentChunk.jobId,
      parentChunk.documentId,
      parentChunk.id,
      preparedChildren,
      { reason, workerId: options.workerId },
    );
    return Boolean(committed);
  }

  const createdChildIds = [];
  const splitFailure = {
    errorType: 'storage_error',
    errorMessage: 'PDF split child creation failed.',
    workerId: options.workerId,
  };
  let splitComplete = false;
  try {
    for (const childInput of preparedChildren) {
      const child = await options.store.createSplitChunk(parentChunk.jobId, parentChunk.documentId, childInput);
      if (!child) return false;
      createdChildIds.push(child.id);
    }

    const superseded = await options.store.markChunkAbstractionSplitSuperseded(parentChunk.jobId, parentChunk.id, reason, options.workerId);
    if (!superseded) return false;
    splitComplete = true;
    return true;
  } finally {
    if (!splitComplete) await abandonSplitChildren(options.store, parentChunk, createdChildIds, splitFailure);
  }
}

// Cleanup must never replace the error that abandoned the split, so failures here are swallowed.
async function abandonSplitChildren(store, parentChunk, childIds, failure) {
  const abandon = store.discardSplitChunk
    ? childId => store.discardSplitChunk(parentChunk.jobId, childId, { splitParentChunkId: parentChunk.id, workerId: failure.workerId })
    : store.markChunkAbstractionFailed
      ? childId => store.markChunkAbstractionFailed(parentChunk.jobId, childId, failure)
      : null;
  if (abandon) await Promise.allSettled(childIds.map(abandon));
}

function computeRetryBackoff(attempt, retryAfter) {
  if (retryAfter > 0) {
    return Math.min(retryAfter > 1000 ? retryAfter : retryAfter * 1000, MAX_RETRY_WAIT_MS);
  }
  return Math.min(2000 * (2 ** Math.max(0, attempt - 1)), MAX_RETRY_WAIT_MS);
}

function extractRetryAfter(err) {
  const raw = err?.retryAfter ?? err?.retryAfterMs ?? err?.headers?.['retry-after'] ?? 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

async function claimChunkWithLease(store, chunk, workerId, leaseMs, maxAttempts) {
  if (store.claimChunkForAbstraction) {
    return await store.claimChunkForAbstraction(chunk.jobId, chunk.id, {
      workerId,
      leaseMs,
      maxAttempts,
    });
  }
  if (store.markChunkAbstractionProcessing) {
    return await store.markChunkAbstractionProcessing(chunk.jobId, chunk.id);
  }
  return chunk;
}

export async function tryReuseExistingAbstract(store, chunk, workerId) {
  if (!store?.getDocumentAbstractByChunkId) return null;
  if ((chunk.abstractionStatus || 'pending') !== 'processing') return null;
  if (chunk.abstractionWorkerId && workerId && chunk.abstractionWorkerId !== workerId) return null;
  const existing = await store.getDocumentAbstractByChunkId(chunk.jobId, chunk.id);
  if (existing?.abstractText?.trim()) {
    return { source: 'same_chunk', abstractText: existing.abstractText, modelUsed: existing.modelUsed || ABSTRACT_MODEL };
  }
  const attemptCount = Math.max(0, Number(chunk.abstractionAttempts) || 0);
  if (attemptCount <= 1 && store.findReusableAbstractForChunk) {
    const donor = await store.findReusableAbstractForChunk(chunk.jobId, chunk);
    if (donor?.abstractText?.trim()) {
      return {
        source: 'peer_chunk',
        abstractText: donor.abstractText,
        modelUsed: donor.modelUsed || ABSTRACT_MODEL,
        donorChunkId: donor.chunkId,
      };
    }
  }
  return null;
}

export async function processChunkAbstraction(chunk, options = {}) {
  const store = options.store;
  const model = options.model || ABSTRACT_MODEL;
  const maxTokens = options.maxTokens || ABSTRACT_MAX_TOKENS;
  const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
  const leaseMs = options.leaseMs || DEFAULT_LEASE_MS;
  const workerId = options.workerId || `wkr_${Math.random().toString(36).slice(2, 10)}`;
  const sequenceIndex = Number.isInteger(options.sequenceIndex) ? options.sequenceIndex : chunk.chunkOrder || 0;
  const startedAt = Date.now();
  const claimedChunk = await claimChunkWithLease(store, chunk, workerId, leaseMs, maxAttempts);
  if (!claimedChunk) {
    return { status: 'skipped', chunkId: chunk.id };
  }
  if (claimedChunk.abstractionStatus === 'failed') {
    return {
      status: 'failed',
      chunkId: claimedChunk.id,
      failure: {
        errorType: claimedChunk.abstractionErrorType || 'max_attempts',
        errorMessage: claimedChunk.abstractionErrorMessage || 'Abstraction attempt limit exceeded.',
      },
    };
  }
  const processingChunk = claimedChunk;
  const upstreamTimeoutMs = options.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const attemptCount = Math.max(1, Number(processingChunk.abstractionAttempts) || 1);
  const stageLoggingEnabled = options.logStages || process.env.WORKER_STAGE_LOGS === 'true';

  // Renew this chunk's lease before every billable call; stop before paying if another worker owns it now.
  const renewLeaseMs = callLeaseMs(leaseMs, upstreamTimeoutMs);
  const modelCallGuard = async () => {
    if (typeof options.chunkLeaseGuard === 'function') {
      const outcome = await options.chunkLeaseGuard(processingChunk, renewLeaseMs);
      if (outcome === 'lost') throw chunkLeaseLostError(processingChunk.id);
      if (outcome !== undefined) return;
    }
    const outcome = await renewChunkLease(store, processingChunk, { workerId, leaseMs: renewLeaseMs });
    if (outcome === 'lost') throw chunkLeaseLostError(processingChunk.id);
  };

  let loadedPayload = null;
  try {
    const reuse = await tryReuseExistingAbstract(store, claimedChunk, workerId);
    if (reuse) {
      const record = {
        jobId: processingChunk.jobId,
        documentId: processingChunk.documentId,
        chunkId: processingChunk.id,
        abstractText: stripDocumentLabel(reuse.abstractText, sequenceIndex + 1),
        modelUsed: reuse.modelUsed,
        payloadBytes: 0,
        latencyMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
        status: 'completed',
        attemptCount,
        workerId,
      };
      const validation = validateAbstractPersistenceInput(record);
      if (!validation.valid) {
        const error = new Error(validation.reason);
        error.status = 500;
        throw error;
      }
      const saved = await store.saveDocumentAbstract(record, { reuseSource: reuse.source });
      if (!saved) {
        return { status: 'stale', chunkId: processingChunk.id };
      }
      logChunkStage('reused_abstract', processingChunk, {
        workerId,
        attemptCount,
        reuseSource: reuse.source,
        donorChunkId: reuse.donorChunkId || null,
        elapsedMs: Date.now() - startedAt,
      }, stageLoggingEnabled);
      return { status: 'completed', chunkId: processingChunk.id, abstract: record, reused: true };
    }
    logChunkStage('claimed', processingChunk, { workerId, attemptCount }, stageLoggingEnabled);
    const payload = options.preloadedPayload?.chunkId === processingChunk.id
      ? options.preloadedPayload.payload
      : await getBlobLoader(options)(processingChunk);
    loadedPayload = payload;
    logChunkStage('loaded', processingChunk, {
      workerId,
      attemptCount,
      loadedBytes: payload.bytes?.byteLength ?? null,
      loadedMediaType: payload.mediaType || processingChunk.mediaType || null,
      elapsedMs: Date.now() - startedAt,
    }, stageLoggingEnabled);
    const resolvedDelivery = options.preloadedDelivery?.chunkId === processingChunk.id
      ? options.preloadedDelivery.delivery
      : await resolveChunkDelivery(processingChunk, payload.bytes);
    const delivery = await enrichVisualDeliveryForModel(
      resolvedDelivery,
      processingChunk,
      payload.bytes,
      model,
    );
    assertInlineVisualCanFit(processingChunk, payload.bytes, delivery);
    const messages = buildAbstractMessagesForChunk(processingChunk, payload.bytes, sequenceIndex, delivery);
    const payloadBytes = estimateRequestBytes(model, maxTokens, ABSTRACTION_PROMPT, messages);
    if (payloadBytes > REQUEST_ENVELOPE_SAFE_BYTES) {
      const error = new Error(`Abstraction request too large (${(payloadBytes / 1024 / 1024).toFixed(1)} MB).`);
      error.status = 413;
      throw error;
    }
    logChunkStage('model_start', processingChunk, {
      workerId,
      attemptCount,
      model,
      payloadBytes,
      deliveryMode: delivery.mode,
      elapsedMs: Date.now() - startedAt,
    }, stageLoggingEnabled);
    const modelResult = await runModelAbstraction({
      messages,
      model,
      maxTokens,
      payloadBytes,
      escalationModel: options.escalationModel ?? resolveEscalationModel(),
      escalationMaxTokens: options.escalationMaxTokens ?? resolveEscalationMaxTokens(),
      chunk: processingChunk,
      rawPayloadBytes: payload.bytes,
      sequenceIndex,
      escalationContext: buildEscalationQualityContext(processingChunk, delivery),
      mediaResolution: options.mediaResolution,
      options: { ...options, modelCallGuard },
    });
    const finalPayloadBytes = modelResult.payloadBytes ?? payloadBytes;
    logChunkStage('model_response', processingChunk, {
      workerId,
      attemptCount,
      modelUsed: modelResult.model,
      payloadBytes: finalPayloadBytes,
      deliveryMode: delivery.mode,
      escalated: modelResult.escalated,
      ...(modelResult.escalated ? { escalationReasons: modelResult.escalationReasons } : {}),
      elapsedMs: Date.now() - startedAt,
    }, stageLoggingEnabled);
    const saved = await persistCompletedAbstract({
      store,
      chunk: processingChunk,
      workerId,
      sequenceIndex,
      abstractText: modelResult.text,
      modelUsed: modelResult.model,
      payloadBytes: finalPayloadBytes,
      usage: modelResult.usage,
      latencyMs: Date.now() - startedAt,
      attemptCount,
    });
    if (saved.status === 'completed') {
      logChunkStage('saved', processingChunk, { workerId, attemptCount, payloadBytes: finalPayloadBytes, elapsedMs: Date.now() - startedAt }, stageLoggingEnabled);
    }
    return saved;
  } catch (err) {
    // Lease lost: the new owner's row is not ours to mark failed, retry_wait or split.
    if (isChunkLeaseLostError(err)) return { status: 'stale', chunkId: processingChunk.id };
    const errorType = classifyError(err);
    logChunkStage('error', processingChunk, {
      workerId,
      attemptCount,
      errorType,
      errorMessage: sanitizeErrorMessage(err),
      elapsedMs: Date.now() - startedAt,
    }, stageLoggingEnabled);
    if (loadedPayload && ['payload_too_large', 'upstream_timeout', 'output_truncated'].includes(errorType)) {
      const split = await splitPdfChunk(processingChunk, loadedPayload.bytes, errorType, { ...options, workerId }).catch(() => false);
      if (split) {
        return { status: 'split_superseded', chunkId: processingChunk.id };
      }
    }
    const failure = {
      errorType,
      errorMessage: sanitizeErrorMessage(err),
      latencyMs: Date.now() - startedAt,
      modelUsed: model,
      workerId,
    };
    const isRetryable = ['rate_limit', 'upstream_timeout', 'provider_error', 'storage_error'].includes(errorType);
    const hasAttemptsLeft = attemptCount < maxAttempts;
    if (isRetryable && hasAttemptsLeft && store.markChunkAbstractionRetryWait) {
      const retryAtMs = Date.now() + computeRetryBackoff(attemptCount, extractRetryAfter(err));
      const updated = await store.markChunkAbstractionRetryWait(processingChunk.jobId, processingChunk.id, {
        ...failure,
        retryAtIso: new Date(retryAtMs).toISOString(),
      });
      if (!updated) return { status: 'stale', chunkId: processingChunk.id };
      return { status: 'retry_wait', chunkId: processingChunk.id, failure, retryAt: retryAtMs };
    }
    if (store.markChunkAbstractionFailed) {
      const updated = await store.markChunkAbstractionFailed(processingChunk.jobId, processingChunk.id, failure);
      if (!updated) return { status: 'stale', chunkId: processingChunk.id };
    }
    return { status: 'failed', chunkId: processingChunk.id, failure };
  }
}

export async function processJobAbstraction(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required.');
  if (store.resetStaleProcessingChunks) {
    await store.resetStaleProcessingChunks(jobId, options.staleProcessingMs || STALE_PROCESSING_MS);
  }
  const job = await store.getJob(jobId);
  if (!job) {
    const error = new Error('Job not found.');
    error.statusCode = 404;
    throw error;
  }
  if (job.status === 'canceled') {
    const error = new Error('Job has been canceled.');
    error.statusCode = 409;
    throw error;
  }
  if (store.updateJob && !['abstracting', 'synthesizing', 'partial_failed', 'failed'].includes(job.status)) {
    await store.updateJob(jobId, { status: 'abstracting', currentPhase: 'Starting server-side abstraction' });
  }
  let completed = 0;
  let failed = 0;
  for (let pass = 0; pass < 20; pass++) {
    const refreshed = await store.getJob(jobId);
    if (!refreshed || refreshed.status === 'canceled') break;
    const chunks = await store.listChunks(jobId);
    const now = Date.now();
    const work = chunks.filter(chunk => {
      if (chunk.uploadStatus !== 'uploaded') return false;
      const status = chunk.abstractionStatus || 'pending';
      if (status === 'pending') return true;
      if (status === 'retry_wait') {
        const retryAt = chunk.abstractionRetryAt ? Date.parse(chunk.abstractionRetryAt) : 0;
        return !retryAt || retryAt <= now;
      }
      return false;
    });
    if (!work.length) break;
    for (const chunk of work) {
      const result = await processChunkAbstraction(chunk, {
        ...options,
        store,
        sequenceIndex: chunk.chunkOrder || 0,
      });
      if (result.status === 'completed') completed += 1;
      else if (result.status === 'failed') failed += 1;
    }
  }
  const status = store.getAbstractionStatus
    ? await store.getAbstractionStatus(jobId)
    : { completed, failed, total: completed + failed };
  return {
    total: status.total ?? 0,
    completed: status.completed ?? completed,
    failed: status.failed ?? failed,
    pending: status.pending ?? 0,
    processing: status.processing ?? 0,
    retry_wait: status.retry_wait ?? 0,
    failedChunks: status.failedChunks || [],
    job: status.job || await store.getJob(jobId),
  };
}

export async function retryChunkAbstraction(jobId, chunkId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required.');
  if (store.resetStaleProcessingChunks) {
    await store.resetStaleProcessingChunks(jobId, options.staleProcessingMs || STALE_PROCESSING_MS);
  }
  const job = await store.getJob(jobId);
  if (job?.status === 'canceled') {
    const error = new Error('Job has been canceled.');
    error.statusCode = 409;
    throw error;
  }
  const chunk = await store.getChunk(jobId, chunkId);
  if (!chunk) {
    const error = new Error('Chunk not found.');
    error.statusCode = 404;
    throw error;
  }
  if (!['failed', 'retry_wait'].includes(chunk.abstractionStatus)) {
    const error = new Error('Only failed or retry_wait chunks can be retried.');
    error.statusCode = 409;
    throw error;
  }
  const reset = store.resetChunkAbstraction ? await store.resetChunkAbstraction(jobId, chunkId) : { ...chunk, abstractionStatus: 'pending' };
  const result = await processChunkAbstraction(reset, { ...options, store, sequenceIndex: reset.chunkOrder || 0 });
  const status = store.getAbstractionStatus ? await store.getAbstractionStatus(jobId) : null;
  return { result, status };
}

export function serverAbstractionSetupError() {
  if (!storageIsConfigured() && !globalThis.__TITLE_ANALYZER_BLOB_LOADER__) {
    return 'Google Cloud Storage is not configured. Set GCS_BUCKET to enable server-side abstraction.';
  }
  if (!globalThis.__TITLE_ANALYZER_MODEL_CLIENT__) {
    const keyError = abstractionApiKeyError(ABSTRACT_MODEL);
    if (keyError) return keyError;
  }
  return null;
}
