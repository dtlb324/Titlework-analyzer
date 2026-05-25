import { createHash } from 'crypto';
import { buildMessagesRequestBody } from './anthropic-request.js';
import { isAllowedStorageUrl, readObject, storageIsConfigured, writeObject } from './storage.js';

const REQUEST_ENVELOPE_SAFE_BYTES = clampInt(process.env.REQUEST_ENVELOPE_SAFE_BYTES, 12_000_000, 100_000, 20_000_000);
const REQUEST_OVERHEAD_BYTES = 350_000;
const ABSTRACT_MODEL = process.env.ABSTRACT_MODEL || 'claude-haiku-4-5';
const ABSTRACT_MAX_TOKENS = clampInt(process.env.ABSTRACT_MAX_TOKENS, 1600, 512, 4096);
const UPSTREAM_TIMEOUT_MS = clampInt(process.env.ABSTRACTION_UPSTREAM_TIMEOUT_MS || process.env.CLOUD_RUN_UPSTREAM_TIMEOUT_MS, 240_000, 10_000, 300_000);
const SPLITTABLE_PDF_FETCH_MAX_BYTES = clampInt(process.env.ABSTRACTION_SPLITTABLE_PDF_MAX_BYTES, 25_000_000, 1_000_000, 100_000_000);
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

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export const ABSTRACTION_PROMPT = `You are an expert oil and gas title attorney abstracting a single courthouse document. Be accurate, concise, and cautious. Extract only what is clearly visible.

Respond in this exact format - no extra commentary:

DOC TYPE: [type]
DATE EXECUTED: [date or "not visible"]
DATE RECORDED: [date or "not visible"]
RECORDING REF: [Vol/Page or instrument number, or "not visible"]
GRANTOR: [exact name(s) as written]
GRANTEE: [exact name(s) as written]
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

Write ILLEGIBLE - VERIFY MANUALLY for anything you cannot read. DO NOT GUESS or fill in missing information.`;

export function getAbstractionConfig() {
  return {
    requestEnvelopeSafeBytes: REQUEST_ENVELOPE_SAFE_BYTES,
    model: ABSTRACT_MODEL,
    maxTokens: ABSTRACT_MAX_TOKENS,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
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

function isPdfChunk(chunk) {
  return chunk.mediaType === 'application/pdf' || /\.pdf$/i.test(chunk.originalFilename || '');
}

function isPotentiallySplittablePdfChunk(chunk) {
  return isPdfChunk(chunk) && (!chunk.pageStart || !chunk.pageEnd || chunk.pageEnd > chunk.pageStart);
}

function isImageChunk(chunk) {
  return /^image\/[-+.a-z0-9]+$/i.test(chunk.mediaType || '');
}

function isCsvChunk(chunk) {
  return chunk.mediaType === 'text/csv' || /\.csv$/i.test(chunk.originalFilename || '');
}

function maxRawBlobBytesForChunk(chunk) {
  const available = Math.max(1, REQUEST_ENVELOPE_SAFE_BYTES - REQUEST_OVERHEAD_BYTES);
  if (isPotentiallySplittablePdfChunk(chunk)) return Math.max(Math.floor(available * 0.70), SPLITTABLE_PDF_FETCH_MAX_BYTES);
  if (isCsvChunk(chunk)) return available;
  return Math.floor(available * 0.70);
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
  if (chunk.pageStart && chunk.pageEnd && !/\(pp\s+\d+/i.test(chunk.originalFilename || '')) {
    return `${chunk.originalFilename} (pp ${chunk.pageStart}${chunk.pageEnd === chunk.pageStart ? '' : `-${chunk.pageEnd}`})`;
  }
  return chunk.originalFilename || chunk.id;
}

export function buildAbstractMessagesForChunk(chunk, payloadBytes, sequenceIndex = 0) {
  const bytes = normalizeBytes(payloadBytes);
  const docNum = sequenceIndex + 1;
  const name = chunkDisplayName(chunk);
  const content = [];
  let textPrompt = `Abstract the following document as DOCUMENT #${docNum} (${name}). Label the section clearly as DOCUMENT #${docNum}:. Extract every relevant fact. Do not guess at anything illegible.`;

  if (chunk.splitFrom || (chunk.pageStart && chunk.pageEnd)) {
    textPrompt += ' This file is a page range from a larger PDF. Abstract this part fully and note the source document/page range.';
  }

  if (isCsvChunk(chunk)) {
    const csvText = bytes.toString('utf8');
    textPrompt += `\n\nDOCUMENT #${docNum} (${name}) - CSV DATA:\n${csvText}\n\nAbstract this CSV as a structured ownership or lease record. Identify all owners, interests, fractions, and any other relevant title information.`;
  } else if (isPdfChunk(chunk)) {
    content.push({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: bytes.toString('base64'),
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
  if (status === 413 || /too large|payload|request entity/i.test(message)) return 'payload_too_large';
  if (status === 429 || /rate limit|overloaded/i.test(message)) return 'rate_limit';
  if ([504, 524].includes(status) || /timeout|aborted|FUNCTION_INVOCATION_TIMEOUT/i.test(message)) return 'upstream_timeout';
  if (/blob|storage|fetch/i.test(message)) return 'storage_error';
  return 'provider_error';
}

function sanitizeErrorMessage(err) {
  return String(err?.message || err || 'Unknown error')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(0, 1000);
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
    // Logging must never affect document processing.
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

export async function defaultBlobLoader(chunk) {
  if (!chunk.blobUrl) {
    const error = new Error(`Chunk ${chunk.id} is missing a storage URL.`);
    error.statusCode = 500;
    throw error;
  }
  assertSafeBlobUrl(chunk.blobUrl);
  assertBlobSizeWithinBudget(chunk, chunk.sizeBytes);
  const payload = await readObject(chunk);
  assertBlobSizeWithinBudget(chunk, payload.bytes.byteLength);
  return payload;
}

async function defaultModelClient(request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const error = new Error('ANTHROPIC_API_KEY is required for server-side abstraction.');
    error.statusCode = 503;
    throw error;
  }
  const body = JSON.stringify(buildMessagesRequestBody({
    model: request.model,
    maxTokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
  }));
  const timeout = createTimeoutSignal(UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
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
    };
  } finally {
    timeout.cleanup();
  }
}

function getBlobLoader(options) {
  return options.blobLoader || globalThis.__TITLE_ANALYZER_BLOB_LOADER__ || defaultBlobLoader;
}

function getModelClient(options) {
  return options.modelClient || globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ || defaultModelClient;
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

function stripDocumentLabel(text, docNum) {
  const value = String(text || '').trim();
  const regex = new RegExp(`^DOCUMENT\\s*#${docNum}\\s*:?\\s*`, 'i');
  return value.replace(regex, '').trim() || value;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function splitPdfChunk(parentChunk, bytes, reason, options) {
  if (!isPdfChunk(parentChunk)) {
    return false;
  }
  if (!options.store?.createSplitChunk || !options.store?.markChunkAbstractionSplitSuperseded) return false;
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(normalizeBytes(bytes), { ignoreEncryption: true });
  const pageCount = source.getPageCount();
  if (pageCount <= 1) return false;

  const sourcePageStart = parentChunk.pageStart || 1;
  const sourcePageEnd = parentChunk.pageEnd && parentChunk.pageEnd >= sourcePageStart
    ? parentChunk.pageEnd
    : sourcePageStart + pageCount - 1;
  if (sourcePageEnd <= sourcePageStart) return false;

  const leftCount = Math.ceil(pageCount / 2);
  const ranges = [
    { startPageIndex: 0, endPageIndex: leftCount - 1, pageStart: sourcePageStart, pageEnd: sourcePageStart + leftCount - 1 },
    { startPageIndex: leftCount, endPageIndex: pageCount - 1, pageStart: sourcePageStart + leftCount, pageEnd: sourcePageEnd },
  ];
  const baseName = String(parentChunk.originalFilename || 'document.pdf').replace(/\.pdf$/i, '');
  const createdChildIds = [];
  const splitFailure = {
    errorType: 'storage_error',
    errorMessage: 'PDF split child creation failed.',
    workerId: options.workerId,
  };

  for (const range of ranges) {
    const childDoc = await PDFDocument.create();
    const indices = [];
    for (let i = range.startPageIndex; i <= range.endPageIndex; i++) indices.push(i);
    const pages = await childDoc.copyPages(source, indices);
    for (const page of pages) childDoc.addPage(page);
    const childBytes = Buffer.from(await childDoc.save());
    const childName = `${baseName} (pp ${range.pageStart}${range.pageEnd === range.pageStart ? '' : `-${range.pageEnd}`}).pdf`;
    const blob = await getBlobWriter(options)(parentChunk, childName, childBytes);
    const child = await options.store.createSplitChunk(parentChunk.jobId, parentChunk.documentId, {
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
    if (!child) {
      if (options.store.markChunkAbstractionFailed) {
        for (const childId of createdChildIds) {
          await options.store.markChunkAbstractionFailed(parentChunk.jobId, childId, splitFailure);
        }
      }
      return false;
    }
    createdChildIds.push(child.id);
  }

  const superseded = await options.store.markChunkAbstractionSplitSuperseded(parentChunk.jobId, parentChunk.id, reason, options.workerId);
  if (!superseded) {
    if (options.store.markChunkAbstractionFailed) {
      for (const childId of createdChildIds) {
        await options.store.markChunkAbstractionFailed(parentChunk.jobId, childId, splitFailure);
      }
    }
    return false;
  }
  return true;
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

async function claimChunkWithLease(store, chunk, workerId, leaseMs) {
  if (store.claimChunkForAbstraction) {
    return await store.claimChunkForAbstraction(chunk.jobId, chunk.id, {
      workerId,
      leaseMs,
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
  // Skip peer reuse on retries (attempt > 1) so failed chunks are re-read and re-abstracted.
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
  const claimedChunk = await claimChunkWithLease(store, chunk, workerId, leaseMs);
  if (!claimedChunk) {
    return { status: 'skipped', chunkId: chunk.id };
  }
  const processingChunk = claimedChunk;
  const attemptCount = Math.max(1, Number(processingChunk.abstractionAttempts) || 1);
  const stageLoggingEnabled = options.logStages || process.env.WORKER_STAGE_LOGS === 'true';

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
    const payload = await getBlobLoader(options)(processingChunk);
    loadedPayload = payload;
    logChunkStage('loaded', processingChunk, {
      workerId,
      attemptCount,
      loadedBytes: payload.bytes?.byteLength ?? null,
      loadedMediaType: payload.mediaType || processingChunk.mediaType || null,
      elapsedMs: Date.now() - startedAt,
    }, stageLoggingEnabled);
    const messages = buildAbstractMessagesForChunk(processingChunk, payload.bytes, sequenceIndex);
    const payloadBytes = estimateRequestBytes(model, maxTokens, ABSTRACTION_PROMPT, messages);
    if (payloadBytes > REQUEST_ENVELOPE_SAFE_BYTES) {
      const error = new Error(`Abstraction request too large (${(payloadBytes / 1024 / 1024).toFixed(1)} MB).`);
      error.status = 413;
      throw error;
    }
    logChunkStage('model_start', processingChunk, { workerId, attemptCount, model, payloadBytes, elapsedMs: Date.now() - startedAt }, stageLoggingEnabled);
    const response = await getModelClient(options)({
      model,
      maxTokens,
      system: ABSTRACTION_PROMPT,
      messages,
      payloadBytes,
      chunk: processingChunk,
    });
    logChunkStage('model_response', processingChunk, {
      workerId,
      attemptCount,
      modelUsed: response.model || model,
      payloadBytes,
      elapsedMs: Date.now() - startedAt,
    }, stageLoggingEnabled);
    const usage = extractUsage(response.usage);
    const record = {
      jobId: processingChunk.jobId,
      documentId: processingChunk.documentId,
      chunkId: processingChunk.id,
      abstractText: stripDocumentLabel(response.text, sequenceIndex + 1),
      modelUsed: response.model || model,
      payloadBytes,
      latencyMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
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
      ? await store.getChunk(processingChunk.jobId, processingChunk.id)
      : processingChunk;
    if (
      !latestChunk
      || latestChunk.abstractionStatus !== 'processing'
      || (latestChunk.abstractionWorkerId && latestChunk.abstractionWorkerId !== workerId)
    ) {
      logChunkStage('save_stale', processingChunk, { workerId, attemptCount, payloadBytes, elapsedMs: Date.now() - startedAt }, stageLoggingEnabled);
      return { status: 'stale', chunkId: processingChunk.id };
    }
    const saved = await store.saveDocumentAbstract(record);
    if (!saved) {
      logChunkStage('save_stale', processingChunk, { workerId, attemptCount, payloadBytes, elapsedMs: Date.now() - startedAt }, stageLoggingEnabled);
      return { status: 'stale', chunkId: processingChunk.id };
    }
    logChunkStage('saved', processingChunk, { workerId, attemptCount, payloadBytes, elapsedMs: Date.now() - startedAt }, stageLoggingEnabled);
    return { status: 'completed', chunkId: processingChunk.id, abstract: record };
  } catch (err) {
    const errorType = classifyError(err);
    logChunkStage('error', processingChunk, {
      workerId,
      attemptCount,
      errorType,
      errorMessage: sanitizeErrorMessage(err),
      elapsedMs: Date.now() - startedAt,
    }, stageLoggingEnabled);
    if (loadedPayload && ['payload_too_large', 'upstream_timeout'].includes(errorType)) {
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
  if (!process.env.ANTHROPIC_API_KEY && !globalThis.__TITLE_ANALYZER_MODEL_CLIENT__) {
    return 'ANTHROPIC_API_KEY is required for server-side abstraction.';
  }
  return null;
}
