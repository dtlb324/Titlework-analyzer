// Phase 5 — durable server-side synthesis.
//
// Reads completed abstracts from Postgres, plans dynamic synthesis segments,
// runs partial synthesis per segment with checkpointing, then merges segments
// into a final title opinion. Falls back to a binary split when a single
// segment hits 413/timeout, and to a tree-merge when the merge call itself
// would exceed the safe request envelope.
//
// Required env vars:
//   - GEMINI_API_KEY (partial segment synthesis; also final opinion when SYNTHESIS_MODEL is Gemini)
//   - ANTHROPIC_API_KEY (final title opinion / follow-ups when SYNTHESIS_MODEL is Claude; optional audit)
//   Override per call with options.modelClient
//
// Configurable (env):
//   - SYNTHESIS_MODEL (default: claude-sonnet-4-6; e.g. gemini-3.5-flash — Haiku is not allowed for final)
//   - SYNTHESIS_MAX_TOKENS (default: 6000)
//   - SYNTHESIS_CHUNK_SIZE (default: 50)
//   - REQUEST_ENVELOPE_SAFE_BYTES (default: 3_900_000)
//   - REQUEST_OVERHEAD_BYTES (default: 350_000)
//   - SYNTHESIS_MAX_ATTEMPTS (default: 3)
//   - SYNTHESIS_FOLLOWUP_HISTORY_TURNS (default: 4)
//   - SYNTHESIS_UPSTREAM_TIMEOUT_MS (default: 52_000)

import { createHash } from 'crypto';
import { isGeminiModel, invokeModel, invokeAnthropicModelStream, isAnthropicModel, geminiApiKeyError, sanitizeModelClientError } from './model-client.js';
import { buildMergeUserMessageContent } from './anthropic-request.js';
import { runWithConcurrency } from './concurrency.js';

const DEFAULT_FINAL_SYNTHESIS_MODEL = 'claude-sonnet-4-6';

export function resolveFinalSynthesisModel() {
  const configured = String(process.env.SYNTHESIS_MODEL || DEFAULT_FINAL_SYNTHESIS_MODEL).trim();
  if (/^claude-haiku/i.test(configured)) {
    return DEFAULT_FINAL_SYNTHESIS_MODEL;
  }
  return configured || DEFAULT_FINAL_SYNTHESIS_MODEL;
}

const DEFAULT_SYNTHESIS_MODEL = resolveFinalSynthesisModel();
const DEFAULT_PARTIAL_SYNTHESIS_MODEL_ID = 'gemini-2.5-flash';
const REMOVED_PARTIAL_SYNTHESIS_MODELS = new Set([
  'claude-haiku-4-5',
  'claude-3-5-haiku-20241022',
  'claude-3-5-haiku-latest',
]);

export function resolvePartialSynthesisModel() {
  const configured = String(process.env.SYNTHESIS_PARTIAL_MODEL || DEFAULT_PARTIAL_SYNTHESIS_MODEL_ID).trim();
  if (REMOVED_PARTIAL_SYNTHESIS_MODELS.has(configured) || /^claude-haiku/i.test(configured)) {
    return DEFAULT_PARTIAL_SYNTHESIS_MODEL_ID;
  }
  if (!isGeminiModel(configured)) {
    return DEFAULT_PARTIAL_SYNTHESIS_MODEL_ID;
  }
  return configured;
}

const DEFAULT_PARTIAL_SYNTHESIS_MODEL = resolvePartialSynthesisModel();
function defaultSynthesisBatchLimit() {
  const workflowBatch = clampInt(process.env.WORKFLOW_BATCH_LIMIT, 12, 1, 64);
  return clampInt(process.env.SYNTHESIS_BATCH_LIMIT, Math.min(4, workflowBatch), 1, 16);
}

export function resolveSynthesisBatchLimit(options = {}) {
  if (options.batchLimit != null) {
    return clampInt(options.batchLimit, defaultSynthesisBatchLimit(), 1, 16);
  }
  return defaultSynthesisBatchLimit();
}

const DEFAULT_SYNTHESIS_MAX_TOKENS = clampInt(process.env.SYNTHESIS_MAX_TOKENS, 6000, 256, 8192);
const DEFAULT_PARTIAL_MAX_TOKENS = clampInt(process.env.SYNTHESIS_PARTIAL_MAX_TOKENS, 5000, 512, 8192);
const DEFAULT_OPUS_AUDIT_MODEL = process.env.OPUS_AUDIT_MODEL || 'claude-opus-4-7';
const DEFAULT_OPUS_AUDIT_MAX_TOKENS = clampInt(process.env.OPUS_AUDIT_MAX_TOKENS, 8000, 512, 8192);
const DEFAULT_SYNTHESIS_CHUNK_SIZE = clampInt(process.env.SYNTHESIS_CHUNK_SIZE, 120, 1, 250);
const DEFAULT_BULK_SYNTHESIS_CHUNK_SIZE = 200;
const DEFAULT_BULK_JOB_MIN_ABSTRACTS = 100;
const SYNTHESIS_REPAIR_ENABLED = process.env.SYNTHESIS_REPAIR_ENABLED !== 'false';
const DEFAULT_REQUEST_ENVELOPE_SAFE_BYTES = clampInt(process.env.REQUEST_ENVELOPE_SAFE_BYTES, 12_000_000, 100_000, 20_000_000);
const DEFAULT_REQUEST_OVERHEAD_BYTES = clampInt(process.env.REQUEST_OVERHEAD_BYTES, 350_000, 0, 1_000_000);
const DEFAULT_MAX_ATTEMPTS = clampInt(process.env.SYNTHESIS_MAX_ATTEMPTS, 3, 1, 10);
const DEFAULT_FOLLOWUP_HISTORY_TURNS = clampInt(process.env.SYNTHESIS_FOLLOWUP_HISTORY_TURNS, 4, 0, 20);
const DEFAULT_UPSTREAM_TIMEOUT_MS = clampInt(process.env.SYNTHESIS_UPSTREAM_TIMEOUT_MS || process.env.CLOUD_RUN_UPSTREAM_TIMEOUT_MS, 240_000, 10_000, 300_000);
const DEFAULT_MERGE_LEASE_MS = clampInt(process.env.SYNTHESIS_MERGE_LEASE_MS || process.env.WORKFLOW_LEASE_MS, DEFAULT_UPSTREAM_TIMEOUT_MS + 60_000, 5_000, 600_000);
const DEFAULT_STALE_SYNTHESIS_LEASE_MS = clampInt(process.env.SYNTHESIS_STALE_LEASE_MS || process.env.WORKFLOW_STALE_LEASE_MS, DEFAULT_MERGE_LEASE_MS + 60_000, 5_000, 600_000);
const DEFAULT_SYNTHESIS_CONCURRENCY = clampInt(process.env.SYNTHESIS_CONCURRENCY || process.env.WORKFLOW_CONCURRENCY, 4, 1, 16);
const DEFAULT_MERGE_CONCURRENCY = clampInt(process.env.SYNTHESIS_MERGE_CONCURRENCY || process.env.WORKFLOW_CONCURRENCY, 4, 1, 8);
const MAX_RETRY_WAIT_MS = 5 * 60_000;
const DEFAULT_COMPACTION_MIN_SEGMENTS = 6;
const DEFAULT_COMPACTION_MIN_MERGE_TOKENS = 40_000;
const MIN_FINAL_OPINION_CHARS = 500;
const MIN_SEGMENT_SUMMARY_CHARS = 200;

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function summarizeSynthesisWarningFlags(warnings = []) {
  const text = (warnings || []).map(w => String(w)).join('\n');
  const flags = [];
  if (/repair_retry/i.test(text)) flags.push('repair_retry');
  if (/merge_tree_applied/i.test(text)) flags.push('merge_tree_applied');
  if (/merge_compaction_applied/i.test(text)) flags.push('merge_compaction_applied');
  if (/final_validation_failed/i.test(text)) flags.push('final_validation_failed');
  if (/segment_split|retry_wait/i.test(text)) flags.push('segment_split_or_retry');
  return flags;
}

export function buildSynthesisMetricsEvent(fields) {
  return { ...fields, ts: new Date().toISOString() };
}

export function synthesisStreamEnabled(options = {}) {
  if (options.streamFinalOpinion === true) return true;
  if (options.streamFinalOpinion === false) return false;
  return process.env.SYNTHESIS_STREAM_ENABLED === 'true';
}

export function synthesisCompactionEnabled(options = {}) {
  if (options.compactionEnabled === true) return true;
  if (options.compactionEnabled === false) return false;
  return process.env.SYNTHESIS_COMPACTION_ENABLED !== 'false';
}

export function resolveCompactionMinSegments() {
  return clampInt(process.env.SYNTHESIS_COMPACTION_MIN_SEGMENTS, DEFAULT_COMPACTION_MIN_SEGMENTS, 2, 64);
}

export function resolveCompactionMinMergeTokens() {
  return clampInt(process.env.SYNTHESIS_COMPACTION_MIN_MERGE_TOKENS, DEFAULT_COMPACTION_MIN_MERGE_TOKENS, 1024, 500_000);
}

export function shouldForceMultiSegmentPlanning(abstractCount) {
  if (process.env.SYNTHESIS_FORCE_SINGLE_PASS === 'true') return false;
  if (process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT !== 'true') return false;
  const bulkMin = clampInt(process.env.BULK_JOB_MIN_ABSTRACTS, DEFAULT_BULK_JOB_MIN_ABSTRACTS, 2, 400);
  return abstractCount >= bulkMin;
}

export function shouldCompactBeforeMerge({ segmentCount, mergeInputBytes, mergeInputTokens } = {}) {
  if (!synthesisCompactionEnabled()) return false;
  if ((segmentCount || 0) >= resolveCompactionMinSegments()) return true;
  const tokens = Number.isFinite(Number(mergeInputTokens))
    ? Number(mergeInputTokens)
    : Math.ceil((mergeInputBytes || 0) / 4);
  return tokens >= resolveCompactionMinMergeTokens();
}

function createPreviewWriter(store, jobId) {
  if (!store?.setSynthesisPreview || !jobId) {
    return {
      async begin() {},
      async flush() {},
      async complete() {},
      async discard() {},
    };
  }
  let buffer = '';
  let lastFlushAt = 0;
  const minFlushMs = 250;
  async function flush(force = false) {
    const now = Date.now();
    if (!force && now - lastFlushAt < minFlushMs) return;
    lastFlushAt = now;
    await store.setSynthesisPreview(jobId, {
      text: buffer,
      complete: false,
      bytesReceived: buffer.length,
    });
  }
  return {
    async begin() {
      buffer = '';
      lastFlushAt = 0;
      if (store.clearSynthesisPreview) await store.clearSynthesisPreview(jobId);
      await store.setSynthesisPreview(jobId, { text: '', complete: false, bytesReceived: 0 });
    },
    async onDelta(_delta, fullText) {
      buffer = fullText;
      await flush(false);
    },
    async complete() {
      await store.setSynthesisPreview(jobId, {
        text: buffer,
        complete: true,
        bytesReceived: buffer.length,
      });
    },
    async discard() {
      if (store.clearSynthesisPreview) await store.clearSynthesisPreview(jobId);
    },
    get text() {
      return buffer;
    },
  };
}

export function logSynthesisMetrics(fields) {
  console.log(JSON.stringify(buildSynthesisMetricsEvent(fields)));
}

export const SYNTHESIS_PROMPT = `You are a Texas-licensed oil and gas title attorney with 30+ years of experience rendering Drilling Title Opinions and Division Order Title Opinions.

Synthesize the provided document abstracts into a complete title opinion analysis.

CRITICAL RULES:
1. Only use facts from the abstracts. Do NOT invent dates, parties, fractions, or recording references.
2. If an abstract flagged something as illegible or unclear, treat it as a curative item — do not guess.
3. Show every fractional calculation step by step.
4. If the chain has gaps you cannot bridge, say so explicitly — do not fill gaps with assumptions.

## CHAIN OF TITLE
Chronological flow. At each link: Date · Document type · Recording ref · Grantor → Grantee · Interest conveyed · Running fractional balance with math shown · Any flags.

## MINERAL INTEREST CALCULATION
Step-by-step math. Use a table. Track separately: surface estate, mineral estate (executive rights), royalty interest, NPRI, outstanding leasehold, term interests. Show uncertainty ranges where applicable.

## TITLE DEFECTS & CURATIVE REQUIREMENTS
Every defect formally listed with the curative document needed (Affidavit of Heirship, Stipulation of Interest, Release, Quitclaim, etc.).

## FINAL OWNERSHIP DETERMINATION
| Owner | Mineral Interest | Royalty/NPRI | Subject To | Notes |

If ownership cannot be definitively determined, state so and list what additional records are needed.

## OPINION QUALIFICATIONS
List every assumption. List every illegible or unclear document. State: "This is an AI-assisted analytical aid. It is not a formal title opinion and should not be relied upon for drilling, leasing, division order, or any other action without verification by a licensed attorney in the state where the land lies."`;

export const PARTIAL_SYNTHESIS_PROMPT = `You are a Texas-licensed oil and gas title attorney synthesizing one segment of a larger chain of title.

You will receive abstracts for a subset of documents from a full run. Produce a partial chain-of-title segment summary only.

OUTPUT FORMAT (strict — no preamble, intro, or prose between sections):

## CHAIN ROWS
| Date | Doc Type | Recording Ref | Grantor | Grantee | Interest Conveyed | Running Balance | Flags |
(one row per instrument; show fractional math in Interest Conveyed or Running Balance)

## DEFECTS
| Issue | Curative Needed | Source Doc |
(list every defect, gap, illegible flag, or manual-verify item; write "none" if empty)

## RUNNING BALANCE
| Owner/Interest | Mineral Balance | Notes |

Rules:
- Only use facts from the abstracts provided.
- Do NOT produce a final ownership determination table — a later pass merges all segments.
- Do NOT add narrative paragraphs between table rows.
- Flag gaps explicitly instead of inventing links.`;

export const COMPACTION_SYNTHESIS_PROMPT = `You are compressing multiple partial chain-of-title segment summaries into one dense scaffold for a final title opinion merge.

You will receive N partial segment summaries. Merge them into a single compact scaffold preserving every chain row, defect, gap, fractional balance, and manual-verify flag.

OUTPUT FORMAT (strict — tables only, no preamble prose):

## CHAIN ROWS
| Date | Doc Type | Recording Ref | Grantor | Grantee | Interest Conveyed | Running Balance | Flags |

## DEFECTS
| Issue | Curative Needed | Source Doc |

## RUNNING BALANCE
| Owner/Interest | Mineral Balance | Notes |

Rules:
- Preserve all material facts from every segment.
- Do NOT produce final ownership determination prose — Sonnet expands this scaffold later.
- Do NOT add narrative between rows.
- Flag unresolved gaps explicitly.`;

export const FOLLOWUP_PROMPT = SYNTHESIS_PROMPT;

export const OPUS_AUDIT_PROMPT = `You are a senior Texas oil and gas title attorney auditing an AI-assisted title opinion.

You will receive source document abstracts and a draft final title opinion. Audit the draft for missed instruments, title-chain gaps, legal-description issues, exception/reservation handling, curative requirements, and fractional math errors.

If the draft is materially correct, return a polished complete title opinion preserving the draft's conclusions. If the draft is wrong or incomplete, rewrite it into the corrected complete title opinion.

Only use facts from the source abstracts and draft. Do NOT invent dates, parties, recording references, legal descriptions, or fractions. Preserve uncertainty and manual-verification warnings.

Return only the complete final title opinion in the same section structure:

## CHAIN OF TITLE
## MINERAL INTEREST CALCULATION
## TITLE DEFECTS & CURATIVE REQUIREMENTS
## FINAL OWNERSHIP DETERMINATION
## OPINION QUALIFICATIONS`;

export function getSynthesisConfig(overrides = {}) {
  return {
    model: overrides.model || DEFAULT_SYNTHESIS_MODEL,
    maxTokens: overrides.maxTokens || DEFAULT_SYNTHESIS_MAX_TOKENS,
    chunkSize: overrides.chunkSize || DEFAULT_SYNTHESIS_CHUNK_SIZE,
    partialModel: overrides.partialModel || DEFAULT_PARTIAL_SYNTHESIS_MODEL,
    partialMaxTokens: overrides.partialMaxTokens || DEFAULT_PARTIAL_MAX_TOKENS,
    requestEnvelopeSafeBytes: overrides.requestEnvelopeSafeBytes || DEFAULT_REQUEST_ENVELOPE_SAFE_BYTES,
    requestOverheadBytes: overrides.requestOverheadBytes || DEFAULT_REQUEST_OVERHEAD_BYTES,
    maxAttempts: overrides.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    followupHistoryTurns: overrides.followupHistoryTurns || DEFAULT_FOLLOWUP_HISTORY_TURNS,
    upstreamTimeoutMs: overrides.upstreamTimeoutMs || DEFAULT_UPSTREAM_TIMEOUT_MS,
    concurrency: overrides.concurrency || DEFAULT_SYNTHESIS_CONCURRENCY,
    mergeConcurrency: overrides.mergeConcurrency || DEFAULT_MERGE_CONCURRENCY,
  };
}

export function getPartialSynthesisConfig(overrides = {}) {
  const base = getSynthesisConfig(overrides);
  return {
    ...base,
    model: overrides.partialModel || base.partialModel,
    maxTokens: overrides.partialMaxTokens || base.partialMaxTokens,
  };
}

export function effectiveSynthesisChunkSize(abstractCount, config = {}) {
  const resolved = getSynthesisConfig(config);
  const bulkMin = clampInt(process.env.BULK_JOB_MIN_ABSTRACTS, DEFAULT_BULK_JOB_MIN_ABSTRACTS, 2, 400);
  const bulkSize = clampInt(process.env.BULK_SYNTHESIS_CHUNK_SIZE, DEFAULT_BULK_SYNTHESIS_CHUNK_SIZE, 10, 250);
  if (abstractCount >= bulkMin) {
    return Math.max(resolved.chunkSize, bulkSize);
  }
  return resolved.chunkSize;
}

function utf8ByteLength(value) {
  return Buffer.byteLength(String(value), 'utf8');
}

export function estimateRequestBytes(model, maxTokens, system, messages) {
  return utf8ByteLength(JSON.stringify({ model, max_tokens: maxTokens, system, messages }));
}

export function buildAbstractInput(abstracts, tract, ctx, preamble) {
  let input = `${preamble}\n\n`;
  if (tract) input += `**Subject Tract:** ${tract}\n\n`;
  if (ctx) input += `**Additional Context:** ${ctx}\n\n`;
  input += '---\n\n';
  abstracts.forEach((d, i) => {
    input += `### Document ${i + 1}: ${d.filename}\n\n${d.abstract}\n\n---\n\n`;
  });
  return input;
}

function compareNullableNumber(a, b) {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return a - b;
}

export function groupAbstractsByDocument(abstracts) {
  const orderedGroups = [];
  const byId = new Map();

  for (const abstract of abstracts || []) {
    const key = abstract.documentId || abstract.chunkId || abstract.id;
    if (!key) continue;

    let group = byId.get(key);
    if (!group) {
      group = {
        id: key,
        documentId: abstract.documentId || null,
        filename: abstract.sourceFilename || abstract.filename || abstract.originalFilename || abstract.chunkId || key,
        chunks: [],
      };
      byId.set(key, group);
      orderedGroups.push(group);
    }

    group.chunks.push(abstract);
  }

  return orderedGroups.map(group => {
    const chunks = [...group.chunks].sort((a, b) => {
      const byOrder = compareNullableNumber(a.chunkOrder, b.chunkOrder);
      if (byOrder !== 0) return byOrder;
      const byPage = compareNullableNumber(a.pageStart, b.pageStart);
      if (byPage !== 0) return byPage;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });

    if (chunks.length === 1) {
      return {
        id: group.id,
        documentId: group.documentId,
        filename: group.filename,
        abstract: chunks[0].abstract || chunks[0].abstractText || '',
        chunkIds: chunks.map(chunk => chunk.chunkId).filter(Boolean),
      };
    }

    const abstract = chunks
      .map((chunk, index) => {
        const text = chunk.abstract || chunk.abstractText || '';
        const range = chunk.pageStart != null && chunk.pageEnd != null
          ? `Pages ${chunk.pageStart}-${chunk.pageEnd}`
          : `Chunk ${chunk.chunkOrder != null ? chunk.chunkOrder + 1 : index + 1}`;
        return `**${range}:**\n\n${text}`;
      })
      .join('\n\n');

    return {
      id: group.id,
      documentId: group.documentId,
      filename: group.filename,
      abstract,
      chunkIds: chunks.map(chunk => chunk.chunkId).filter(Boolean),
    };
  });
}

export function buildSynthesisChunks(abstracts, tract, ctx, preamble, systemPrompt, configOverrides = {}) {
  const baseConfig = getSynthesisConfig(configOverrides);
  const config = {
    ...baseConfig,
    chunkSize: configOverrides.forceChunkSize != null
      ? clampInt(configOverrides.forceChunkSize, baseConfig.chunkSize, 1, 250)
      : effectiveSynthesisChunkSize(abstracts.length, configOverrides),
  };
  const estimateModel = systemPrompt === SYNTHESIS_PROMPT ? config.model : config.partialModel;
  const chunks = [];
  let current = [];
  for (const abstract of abstracts) {
    const candidate = [...current, abstract];
    const candidateInput = buildAbstractInput(candidate, tract, ctx, preamble);
    const candidateBytes = estimateRequestBytes(
      estimateModel,
      config.maxTokens,
      systemPrompt || SYNTHESIS_PROMPT,
      [{ role: 'user', content: candidateInput }],
    );
    if (current.length && (current.length >= config.chunkSize || candidateBytes > config.requestEnvelopeSafeBytes)) {
      chunks.push(current);
      current = [abstract];
    } else {
      current = candidate;
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
}

export function computePlanId({ jobId, tract, contextNotes, documentIds, abstractDigests }) {
  const hash = createHash('sha256');
  hash.update(String(jobId || ''));
  hash.update('|');
  hash.update(String(tract || ''));
  hash.update('|');
  hash.update(String(contextNotes || ''));
  hash.update('|');
  hash.update((documentIds || []).join(','));
  hash.update('|');
  hash.update((abstractDigests || []).join(','));
  return hash.digest('hex').slice(0, 32);
}

function computeAbstractDigest(item) {
  const hash = createHash('sha256');
  hash.update(String(item.documentId || item.chunkId || item.id || ''));
  hash.update('|');
  hash.update(String(item.abstract || item.abstractText || ''));
  return hash.digest('hex').slice(0, 16);
}

export function planSynthesisSegments(abstracts, tract, contextNotes, configOverrides = {}) {
  const preamble = `Below are ${abstracts.length} document abstracts. Synthesize into a complete title opinion.`;
  let chunkLists = buildSynthesisChunks(
    abstracts,
    tract,
    contextNotes,
    preamble,
    SYNTHESIS_PROMPT,
    configOverrides,
  );
  if (chunkLists.length === 1 && shouldForceMultiSegmentPlanning(abstracts.length)) {
    const baseConfig = getSynthesisConfig(configOverrides);
    chunkLists = buildSynthesisChunks(
      abstracts,
      tract,
      contextNotes,
      preamble,
      SYNTHESIS_PROMPT,
      { ...configOverrides, forceChunkSize: baseConfig.chunkSize },
    );
  }
  let cursor = 0;
  const segments = chunkLists.map((chunk, index) => {
    const start = cursor;
    const end = cursor + chunk.length - 1;
    cursor = end + 1;
    const segmentInput = buildAbstractInput(
      chunk,
      tract,
      contextNotes,
      `Below are document abstracts ${start + 1}-${end + 1} of ${abstracts.length}. Produce a partial chain-of-title segment.`,
    );
    const config = getSynthesisConfig(configOverrides);
    const segmentModel = chunkLists.length === 1 ? config.model : config.partialModel;
    const segmentMaxTokens = chunkLists.length === 1 ? config.maxTokens : config.partialMaxTokens;
    const segmentPrompt = chunkLists.length === 1 ? SYNTHESIS_PROMPT : PARTIAL_SYNTHESIS_PROMPT;
    const estimatedBytes = estimateRequestBytes(
      segmentModel,
      segmentMaxTokens,
      segmentPrompt,
      [{ role: 'user', content: segmentInput }],
    );
    return {
      segmentIndex: index,
      startSequenceIndex: start,
      endSequenceIndex: end,
      documentIds: chunk.map(item => item.documentId || item.chunkId || item.id),
      filenames: chunk.map(item => item.filename),
      estimatedBytes,
    };
  });
  return { segments, totalSegments: segments.length };
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
  return 'provider_error';
}

function sanitizeErrorMessage(err) {
  return sanitizeModelClientError(err);
}

function extractUsage(usage = {}) {
  return {
    inputTokens: Number.isInteger(usage.input_tokens) ? usage.input_tokens : Number.isInteger(usage.inputTokens) ? usage.inputTokens : null,
    outputTokens: Number.isInteger(usage.output_tokens) ? usage.output_tokens : Number.isInteger(usage.outputTokens) ? usage.outputTokens : null,
    cacheCreationInputTokens: Number.isInteger(usage.cache_creation_input_tokens)
      ? usage.cache_creation_input_tokens
      : Number.isInteger(usage.cacheCreationInputTokens) ? usage.cacheCreationInputTokens : null,
    cacheReadInputTokens: Number.isInteger(usage.cache_read_input_tokens)
      ? usage.cache_read_input_tokens
      : Number.isInteger(usage.cacheReadInputTokens) ? usage.cacheReadInputTokens : null,
  };
}

async function defaultModelClient(request) {
  const timeoutMs = request.upstreamTimeoutMs || DEFAULT_UPSTREAM_TIMEOUT_MS;
  const timeout = createTimeoutSignal(timeoutMs);
  try {
    if (request.stream && isAnthropicModel(request.model)) {
      return await invokeAnthropicModelStream(request, {
        timeoutMs,
        createTimeoutSignal: () => timeout,
        onDelta: request.onDelta,
        onEvent: request.onEvent,
      });
    }
    return await invokeModel(request, {
      timeoutMs,
      createTimeoutSignal: () => timeout,
    });
  } finally {
    timeout.cleanup();
  }
}

function getModelClient(options) {
  return options.modelClient || globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ || globalThis.__TITLE_ANALYZER_MODEL_CLIENT__ || defaultModelClient;
}

function validateFinalOpinion(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'Final opinion is not a string.' };
  const trimmed = text.trim();
  if (trimmed.length < MIN_FINAL_OPINION_CHARS) return { ok: false, reason: 'Final opinion is too short.' };
  const lower = trimmed.toLowerCase();
  const required = ['chain of title', 'final ownership', 'opinion qualifications'];
  for (const heading of required) {
    if (!lower.includes(heading)) return { ok: false, reason: `Missing required section: ${heading}.` };
  }
  return { ok: true };
}

function validateSegmentSummary(text) {
  if (typeof text !== 'string') return { ok: false, reason: 'Segment summary is not a string.' };
  const trimmed = text.trim();
  if (trimmed.length < MIN_SEGMENT_SUMMARY_CHARS) return { ok: false, reason: 'Segment summary is too short.' };
  const lower = trimmed.toLowerCase();
  const hasChainContent = lower.includes('chain') || lower.includes('ownership') || lower.includes('grantor');
  const hasTableShape = trimmed.includes('|') && (lower.includes('running balance') || lower.includes('chain rows'));
  if (!hasChainContent && !hasTableShape) {
    return { ok: false, reason: 'Segment summary missing chain/ownership content.' };
  }
  return { ok: true };
}

function buildSegmentSummaryBlock(abstracts) {
  let block = '';
  abstracts.forEach((d, i) => {
    block += `### Document ${i + 1}: ${d.filename}\n\n${d.abstract}\n\n---\n\n`;
  });
  return block;
}

function buildSegmentMessages(abstracts, tract, ctx, preamble, options = {}) {
  if (options.cacheMergeSegments) {
    const content = buildMergeUserMessageContent({
      preamble,
      tract,
      contextNotes: ctx,
      segmentBlock: buildSegmentSummaryBlock(abstracts),
      cacheSegments: true,
    });
    return [{ role: 'user', content }];
  }
  return [{ role: 'user', content: buildAbstractInput(abstracts, tract, ctx, preamble) }];
}

// Opus audit is opt-in only (OPUS_AUDIT_ENABLED=true). Production keeps this off.
function opusAuditEnabled(options = {}) {
  if (options.opusAuditEnabled === true) return true;
  if (options.opusAuditEnabled === false) return false;
  return process.env.OPUS_AUDIT_ENABLED === 'true';
}

function appendUniqueWarning(warnings, warning) {
  if (!warning) return warnings;
  if (!warnings.includes(warning)) warnings.push(warning);
  return warnings;
}

function addTokenCounts(a, b) {
  return (Number(a) || 0) + (Number(b) || 0);
}

function abstractRiskText(abstract) {
  return String(abstract?.abstract || abstract?.abstractText || '');
}

export function shouldRunOpusAudit({ status, warnings = [], failedDocuments = [], abstracts = [] } = {}) {
  const reasons = [];
  if (status === 'partial_failed') reasons.push('partial_failed result');
  if ((failedDocuments || []).length > 0) reasons.push('failed document exclusions');

  const warningText = (warnings || []).map(w => typeof w === 'string' ? w : JSON.stringify(w)).join('\n');
  if (/page-range segments|segment_split|repair_retry|merge_tree_applied|final_validation_failed|excluded|failed/i.test(warningText)) {
    reasons.push('synthesis warnings');
  }

  const sourceText = (abstracts || []).map(abstractRiskText).join('\n\n');
  if (/ILLEGIBLE\s*[-—]\s*VERIFY MANUALLY/i.test(sourceText)) reasons.push('manual verification flags');
  if (/CONFIDENCE:\s*(low|limited|poor|unclear|uncertain)/i.test(sourceText)) reasons.push('low confidence abstracts');

  return { run: reasons.length > 0, reasons };
}

function buildOpusAuditMessages({ abstracts, tract, contextNotes, finalTitleOpinion }) {
  const sourceInput = buildAbstractInput(
    abstracts,
    tract,
    contextNotes,
    'Below are the source document abstracts used to prepare the draft title opinion.',
  );
  return [{
    role: 'user',
    content: `${sourceInput}\n\n---\n\n## DRAFT FINAL TITLE OPINION\n\n${finalTitleOpinion}\n\nAudit and rewrite the draft only as needed. Return the complete final title opinion only.`,
  }];
}

async function runOpusFinalAudit({ payload, abstracts, tract, contextNotes, options, config }) {
  const auditModel = options.opusAuditModel || DEFAULT_OPUS_AUDIT_MODEL;
  const auditMaxTokens = options.opusAuditMaxTokens || DEFAULT_OPUS_AUDIT_MAX_TOKENS;
  const messages = buildOpusAuditMessages({
    abstracts,
    tract,
    contextNotes,
    finalTitleOpinion: payload.finalTitleOpinion,
  });
  const payloadBytes = estimateRequestBytes(auditModel, auditMaxTokens, OPUS_AUDIT_PROMPT, messages);
  if (payloadBytes > config.requestEnvelopeSafeBytes) {
    const err = new Error(`Opus audit request too large (${(payloadBytes / 1024 / 1024).toFixed(1)} MB).`);
    err.status = 413;
    throw err;
  }
  const started = Date.now();
  const response = await getModelClient(options)({
    model: auditModel,
    maxTokens: auditMaxTokens,
    system: OPUS_AUDIT_PROMPT,
    messages,
    payloadBytes,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
    audit: true,
    initialModel: payload.modelUsed || config.model,
  });
  return {
    text: response.text || '',
    model: response.model || auditModel,
    usage: extractUsage(response.usage),
    payloadBytes,
    latencyMs: Date.now() - started,
  };
}

async function applyOpusAuditIfNeeded({ payload, abstracts, tract, contextNotes, options, config }) {
  if (!payload?.finalTitleOpinion || !opusAuditEnabled(options)) return payload;
  const decision = shouldRunOpusAudit({
    status: payload.status,
    warnings: payload.warnings,
    failedDocuments: payload.failedDocuments,
    abstracts,
  });
  if (!decision.run) return payload;

  const warnings = [...(payload.warnings || [])];
  try {
    const audit = await runOpusFinalAudit({ payload, abstracts, tract, contextNotes, options, config });
    const validation = validateFinalOpinion(audit.text);
    if (!validation.ok) {
      appendUniqueWarning(warnings, `Opus 4.7 audit failed: ${validation.reason}`);
      return { ...payload, warnings };
    }
    appendUniqueWarning(warnings, `Opus 4.7 audit applied: ${decision.reasons.join('; ')}`);
    return {
      ...payload,
      finalTitleOpinion: audit.text,
      warnings,
      modelUsed: audit.model,
      inputTokens: addTokenCounts(payload.inputTokens, audit.usage.inputTokens),
      outputTokens: addTokenCounts(payload.outputTokens, audit.usage.outputTokens),
      synthesisDurationMs: addTokenCounts(payload.synthesisDurationMs, audit.latencyMs),
    };
  } catch (err) {
    appendUniqueWarning(warnings, `Opus 4.7 audit failed: ${classifyError(err)}`);
    return { ...payload, warnings };
  }
}

async function callSynthesisModel({
  abstracts,
  tract,
  contextNotes,
  preamble,
  systemPrompt,
  config,
  options,
}) {
  const messages = buildSegmentMessages(abstracts, tract, contextNotes, preamble, {
    cacheMergeSegments: Boolean(options.cacheMergeSegments),
  });
  const payloadBytes = estimateRequestBytes(config.model, config.maxTokens, systemPrompt, messages);
  if (payloadBytes > config.requestEnvelopeSafeBytes) {
    const err = new Error(`Synthesis request too large (${(payloadBytes / 1024 / 1024).toFixed(1)} MB).`);
    err.status = 413;
    throw err;
  }
  const shouldStream = Boolean(options.enableFinalStream)
    && synthesisStreamEnabled(options)
    && systemPrompt === SYNTHESIS_PROMPT
    && isAnthropicModel(config.model);
  const previewWriter = shouldStream
    ? (options.previewWriter || createPreviewWriter(options.store, options.jobId))
    : null;
  if (previewWriter?.begin) await previewWriter.begin();
  const started = Date.now();
  try {
    const response = await getModelClient(options)({
      model: config.model,
      maxTokens: config.maxTokens,
      system: systemPrompt,
      messages,
      payloadBytes,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
      stream: shouldStream,
      onDelta: previewWriter ? (delta, fullText) => previewWriter.onDelta(delta, fullText) : undefined,
    });
    if (previewWriter?.complete) await previewWriter.complete();
    if (shouldStream && response.timeToFirstDeltaMs != null) {
      logSynthesisMetrics({
        event: 'synthesis_merge_stream_delta',
        jobId: options.jobId || null,
        timeToFirstDeltaMs: response.timeToFirstDeltaMs,
        outputBytes: (response.text || '').length,
      });
    }
    const usage = extractUsage(response.usage);
    if ((usage.cacheReadInputTokens || 0) > 0 || (usage.cacheCreationInputTokens || 0) > 0) {
      logSynthesisMetrics({
        event: 'synthesis_prompt_cache_usage',
        jobId: options.jobId || null,
        model: response.model || config.model,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
        mergeCached: Boolean(options.cacheMergeSegments),
      });
    }
    return {
      text: response.text || '',
      model: response.model || config.model,
      usage,
      payloadBytes,
      latencyMs: Date.now() - started,
      streamed: shouldStream,
      timeToFirstDeltaMs: response.timeToFirstDeltaMs ?? null,
    };
  } catch (err) {
    if (previewWriter?.discard) await previewWriter.discard();
    throw err;
  }
}

async function synthesizeWithBinarySplit({
  abstracts,
  tract,
  contextNotes,
  preamble,
  systemPrompt,
  config,
  options,
  reason,
}) {
  if (abstracts.length <= 1) {
    return await callSynthesisModel({
      abstracts,
      tract,
      contextNotes,
      preamble,
      systemPrompt,
      config,
      options,
    });
  }
  const mid = Math.ceil(abstracts.length / 2);
  const left = abstracts.slice(0, mid);
  const right = abstracts.slice(mid);
  const splitPreamble = `${preamble}\n\nThis subset was split automatically because the original synthesis hit ${reason}. Produce a faithful partial chain-of-title segment.`;
  const leftResult = await tryRecursiveSegment(left, tract, contextNotes, splitPreamble, PARTIAL_SYNTHESIS_PROMPT, config, options);
  const rightResult = await tryRecursiveSegment(right, tract, contextNotes, splitPreamble, PARTIAL_SYNTHESIS_PROMPT, config, options);
  const mergeAbstracts = [
    { filename: `Documents 1-${left.length} partial synthesis`, abstract: leftResult.text },
    { filename: `Documents ${left.length + 1}-${abstracts.length} partial synthesis`, abstract: rightResult.text },
  ];
  const merged = await callSynthesisModel({
    abstracts: mergeAbstracts,
    tract,
    contextNotes,
    preamble: 'Merge these partial chain-of-title syntheses into one coherent segment summary. Preserve all caveats, gaps, curative requirements, and fractional calculations.',
    systemPrompt,
    config,
    options,
  });
  return {
    ...merged,
    usage: {
      inputTokens: (merged.usage.inputTokens || 0) + (leftResult.usage.inputTokens || 0) + (rightResult.usage.inputTokens || 0),
      outputTokens: (merged.usage.outputTokens || 0) + (leftResult.usage.outputTokens || 0) + (rightResult.usage.outputTokens || 0),
    },
    payloadBytes: merged.payloadBytes,
    latencyMs: merged.latencyMs + leftResult.latencyMs + rightResult.latencyMs,
    splitApplied: true,
  };
}

async function tryRecursiveSegment(abstracts, tract, contextNotes, preamble, systemPrompt, config, options) {
  try {
    return await callSynthesisModel({
      abstracts,
      tract,
      contextNotes,
      preamble,
      systemPrompt,
      config,
      options,
    });
  } catch (err) {
    const type = classifyError(err);
    if (abstracts.length > 1 && (type === 'payload_too_large' || type === 'upstream_timeout')) {
      return await synthesizeWithBinarySplit({
        abstracts,
        tract,
        contextNotes,
        preamble,
        systemPrompt,
        config,
        options,
        reason: type === 'payload_too_large' ? 'request size' : 'timeout',
      });
    }
    throw err;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

export async function processSynthesisSegment(jobId, segment, abstracts, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to process synthesis segments.');
  const config = getSynthesisConfig(options.config || {});
  const isSinglePass = options.singlePass === true;
  const activeConfig = isSinglePass ? config : getPartialSynthesisConfig(options.config || {});
  const workerId = options.workerId || `wkr_${Math.random().toString(36).slice(2, 10)}`;
  const leaseMs = options.leaseMs || 120_000;
  const tract = options.tract || '';
  const contextNotes = options.contextNotes || '';

  const claimed = await store.claimSynthesisSegment(jobId, segment.id, { workerId, leaseMs });
  if (!claimed) {
    return { status: 'skipped', segmentId: segment.id };
  }

  // Build the abstracts list for this segment in stable order.
  const byDocumentId = new Map(
    abstracts
      .filter(item => item.documentId)
      .map(item => [item.documentId, item]),
  );
  const byChunkId = new Map();
  for (const item of abstracts) {
    if (item.chunkId) byChunkId.set(item.chunkId, item);
    for (const chunkId of item.chunkIds || []) {
      byChunkId.set(chunkId, item);
    }
  }
  const seenAbstractKeys = new Set();
  const segmentAbstracts = [];
  for (const id of segment.documentIds || []) {
    const record = byDocumentId.get(id) || byChunkId.get(id);
    if (!record) continue;
    const recordKey = record.documentId || record.id || record.chunkId || (record.chunkIds || []).join('|') || id;
    if (seenAbstractKeys.has(recordKey)) continue;
    seenAbstractKeys.add(recordKey);
    const item = {
      filename: record.filename || record.originalFilename || record.documentId || record.chunkId,
      abstract: record.abstract || record.abstractText || '',
      documentId: record.documentId,
      chunkId: record.chunkId,
      chunkIds: record.chunkIds || (record.chunkId ? [record.chunkId] : []),
    };
    if (item.abstract.trim().length > 0) segmentAbstracts.push(item);
  }

  if (!segmentAbstracts.length) {
    const updated = await store.markSynthesisSegmentFailed(jobId, segment.id, {
      errorType: 'missing_abstracts',
      errorMessage: 'Segment has no abstracts available for synthesis.',
      workerId,
    });
    if (!updated) return { status: 'stale', segmentId: segment.id };
    return { status: 'failed', segmentId: segment.id, failure: { errorType: 'missing_abstracts' } };
  }

  const totalDocs = abstracts.length;
  const start = segment.startSequenceIndex + 1;
  const end = segment.endSequenceIndex + 1;
  const systemPrompt = isSinglePass ? SYNTHESIS_PROMPT : PARTIAL_SYNTHESIS_PROMPT;
  const preamble = isSinglePass
    ? `Below are ${totalDocs} document abstracts. Synthesize into a complete title opinion.`
    : `Below are document abstracts ${start}-${end} of ${totalDocs}. Produce a partial chain-of-title segment.`;

  const startedAt = Date.now();
  let lastError = null;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const result = await tryRecursiveSegment(segmentAbstracts, tract, contextNotes, preamble, systemPrompt, activeConfig, options);
      const validation = isSinglePass ? validateFinalOpinion(result.text) : validateSegmentSummary(result.text);
      const warnings = [];
      if (result.splitApplied) warnings.push('segment_split');
      if (!validation.ok && attempt < config.maxAttempts && SYNTHESIS_REPAIR_ENABLED) {
        // Repair retry: ask model to be more complete.
        const repairAbstracts = segmentAbstracts;
        const repairPreamble = `${preamble}\n\nPrevious response was incomplete or missing required sections: ${validation.reason} Produce a complete response that includes every required section.`;
        const retry = await callSynthesisModel({
          abstracts: repairAbstracts,
          tract,
          contextNotes,
          preamble: repairPreamble,
          systemPrompt,
          config: activeConfig,
          options,
        });
        const repairValidation = isSinglePass ? validateFinalOpinion(retry.text) : validateSegmentSummary(retry.text);
        if (repairValidation.ok) {
          const updated = await store.completeSynthesisSegment(jobId, segment.id, {
            summaryText: retry.text,
            modelUsed: retry.model,
            inputTokens: (result.usage.inputTokens || 0) + (retry.usage.inputTokens || 0),
            outputTokens: (result.usage.outputTokens || 0) + (retry.usage.outputTokens || 0),
            payloadBytes: retry.payloadBytes,
            latencyMs: (Date.now() - startedAt),
            warnings: [...warnings, 'repair_retry'],
            workerId,
          });
          if (!updated) return { status: 'stale', segmentId: segment.id };
          return { status: 'complete', segmentId: segment.id };
        }
      }
      if (!validation.ok) {
        const failure = {
          errorType: 'validation_failed',
          errorMessage: validation.reason,
          modelUsed: result.model || config.model,
          payloadBytes: result.payloadBytes,
          latencyMs: Date.now() - startedAt,
          workerId,
        };
        if (attempt < config.maxAttempts && store.markSynthesisSegmentRetryWait) {
          const retryAtMs = Date.now() + computeRetryBackoff(attempt, 0);
          const updated = await store.markSynthesisSegmentRetryWait(jobId, segment.id, {
            ...failure,
            retryAtIso: new Date(retryAtMs).toISOString(),
          });
          if (!updated) return { status: 'stale', segmentId: segment.id };
          return { status: 'retry_wait', segmentId: segment.id, failure };
        }
        const updated = await store.markSynthesisSegmentFailed(jobId, segment.id, failure);
        if (!updated) return { status: 'stale', segmentId: segment.id };
        return { status: 'failed', segmentId: segment.id, failure };
      }
      const updated = await store.completeSynthesisSegment(jobId, segment.id, {
        summaryText: result.text,
        modelUsed: result.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        payloadBytes: result.payloadBytes,
        latencyMs: Date.now() - startedAt,
        warnings,
        workerId,
      });
      if (!updated) return { status: 'stale', segmentId: segment.id };
      return { status: 'complete', segmentId: segment.id };
    } catch (err) {
      lastError = err;
      const errorType = classifyError(err);
      const isRetryable = ['rate_limit', 'upstream_timeout', 'provider_error'].includes(errorType);
      const failure = {
        errorType,
        errorMessage: sanitizeErrorMessage(err),
        modelUsed: config.model,
        latencyMs: Date.now() - startedAt,
      };
      if (isRetryable && attempt < config.maxAttempts && store.markSynthesisSegmentRetryWait) {
        const retryAtMs = Date.now() + computeRetryBackoff(attempt, extractRetryAfter(err));
        const updated = await store.markSynthesisSegmentRetryWait(jobId, segment.id, {
          ...failure,
          retryAtIso: new Date(retryAtMs).toISOString(),
          workerId,
        });
        if (!updated) return { status: 'stale', segmentId: segment.id };
        return { status: 'retry_wait', segmentId: segment.id, failure };
      }
      if (!isRetryable || attempt >= config.maxAttempts) {
        const updated = await store.markSynthesisSegmentFailed(jobId, segment.id, { ...failure, workerId });
        if (!updated) return { status: 'stale', segmentId: segment.id };
        return { status: 'failed', segmentId: segment.id, failure };
      }
      // Wait then loop for another attempt within the same claim window.
      await sleep(computeRetryBackoff(attempt, extractRetryAfter(err)));
    }
  }
  return { status: 'failed', segmentId: segment.id, failure: { errorType: 'unknown', errorMessage: sanitizeErrorMessage(lastError) } };
}

function fitsRequestBudget(abstracts, tract, contextNotes, preamble, systemPrompt, config, options = {}) {
  const messages = buildSegmentMessages(abstracts, tract, contextNotes, preamble, {
    cacheMergeSegments: Boolean(options.cacheMergeSegments),
  });
  const bytes = estimateRequestBytes(config.model, config.maxTokens, systemPrompt, messages);
  return { fits: bytes <= config.requestEnvelopeSafeBytes, bytes };
}

async function compactSegmentSummariesForMerge({
  segmentSummaries,
  totalAbstracts,
  tract,
  contextNotes,
  partialConfig,
  options,
  tokensAccum,
}) {
  const mergeAbstracts = segmentSummaries.map(summary => ({
    filename: `Segment ${summary.segmentIndex + 1} (Documents ${summary.startSequenceIndex + 1}-${summary.endSequenceIndex + 1})`,
    abstract: summary.summaryText,
  }));
  const preamble = `Below are ${segmentSummaries.length} partial chain-of-title segments covering all ${totalAbstracts} documents. Compact them into one dense scaffold for final title opinion merge.`;
  const result = await callSynthesisModel({
    abstracts: mergeAbstracts,
    tract,
    contextNotes,
    preamble,
    systemPrompt: COMPACTION_SYNTHESIS_PROMPT,
    config: partialConfig,
    options: {
      ...options,
      enableFinalStream: false,
      cacheMergeSegments: false,
    },
  });
  tokensAccum.inputTokens += result.usage.inputTokens || 0;
  tokensAccum.outputTokens += result.usage.outputTokens || 0;
  const first = segmentSummaries[0];
  const last = segmentSummaries[segmentSummaries.length - 1];
  return [{
    segmentIndex: 0,
    startSequenceIndex: first?.startSequenceIndex ?? 0,
    endSequenceIndex: last?.endSequenceIndex ?? Math.max(0, totalAbstracts - 1),
    summaryText: result.text,
  }];
}

async function mergeSegmentsIntoOpinion({
  segmentSummaries,
  totalAbstracts,
  tract,
  contextNotes,
  config,
  partialConfig,
  options,
  warningsAccum,
  tokensAccum,
}) {
  const partial = partialConfig || getPartialSynthesisConfig(config || {});
  const finalConfig = config || getSynthesisConfig();
  let workingSummaries = segmentSummaries;
  const mergeAbstractsPreview = workingSummaries.map(summary => ({
    filename: `Segment ${summary.segmentIndex + 1} (Documents ${summary.startSequenceIndex + 1}-${summary.endSequenceIndex + 1})`,
    abstract: summary.summaryText,
  }));
  const preamble = `Below are ${workingSummaries.length} partial chain-of-title segments covering all ${totalAbstracts} documents. Merge them into one complete title opinion.`;
  let fit = fitsRequestBudget(mergeAbstractsPreview, tract, contextNotes, preamble, SYNTHESIS_PROMPT, finalConfig, {
    cacheMergeSegments: true,
  });
  if (shouldCompactBeforeMerge({
    segmentCount: workingSummaries.length,
    mergeInputBytes: fit.bytes,
  })) {
    warningsAccum.push('merge_compaction_applied');
    logSynthesisMetrics({
      event: 'synthesis_merge_compaction_start',
      jobId: options.jobId || null,
      segmentCount: workingSummaries.length,
      mergeInputBytes: fit.bytes,
    });
    workingSummaries = await compactSegmentSummariesForMerge({
      segmentSummaries: workingSummaries,
      totalAbstracts,
      tract,
      contextNotes,
      partialConfig: partial,
      options,
      tokensAccum,
    });
    fit = fitsRequestBudget(
      workingSummaries.map(summary => ({
        filename: `Segment ${summary.segmentIndex + 1} (Documents ${summary.startSequenceIndex + 1}-${summary.endSequenceIndex + 1})`,
        abstract: summary.summaryText,
      })),
      tract,
      contextNotes,
      `Below are ${workingSummaries.length} compacted partial chain-of-title segment(s) covering all ${totalAbstracts} documents. Merge them into one complete title opinion.`,
      SYNTHESIS_PROMPT,
      finalConfig,
      { cacheMergeSegments: true },
    );
  }
  const mergeAbstracts = workingSummaries.map(summary => ({
    filename: `Segment ${summary.segmentIndex + 1} (Documents ${summary.startSequenceIndex + 1}-${summary.endSequenceIndex + 1})`,
    abstract: summary.summaryText,
  }));
  const mergePreamble = workingSummaries.length === segmentSummaries.length
    ? preamble
    : `Below are ${workingSummaries.length} compacted partial chain-of-title segment(s) covering all ${totalAbstracts} documents. Merge them into one complete title opinion.`;
  if (!fit.fits && mergeAbstracts.length > 2) {
    // Tree-merge: pair segments and partial-merge until one summary remains.
    warningsAccum.push('merge_tree_applied');
    let working = workingSummaries.map((summary, idx) => ({
      filename: `Segment ${summary.segmentIndex + 1} (Documents ${summary.startSequenceIndex + 1}-${summary.endSequenceIndex + 1})`,
      abstract: summary.summaryText,
      segmentRange: [summary.startSequenceIndex, summary.endSequenceIndex],
      index: idx,
    }));
    while (working.length > 2) {
      const pairSlots = [];
      for (let i = 0; i < working.length; i += 2) {
        pairSlots.push({
          slot: i / 2,
          left: working[i],
          right: working[i + 1] || null,
        });
      }
      const next = new Array(pairSlots.length);
      const mergePairs = pairSlots.filter(slot => slot.right);
      const mergedNodes = await runWithConcurrency(mergePairs, finalConfig.mergeConcurrency, async slot => {
        const { left, right } = slot;
        const pair = [
          { filename: left.filename, abstract: left.abstract },
          { filename: right.filename, abstract: right.abstract },
        ];
        const partialPreamble = `Merge these two adjacent partial chain-of-title segments into one consolidated segment summary. Preserve every defect, gap, and fractional balance.`;
        const result = await tryRecursiveSegment(
          pair,
          tract,
          contextNotes,
          partialPreamble,
          PARTIAL_SYNTHESIS_PROMPT,
          partial,
          options,
        );
        tokensAccum.inputTokens += result.usage.inputTokens || 0;
        tokensAccum.outputTokens += result.usage.outputTokens || 0;
        return {
          slot: slot.slot,
          node: {
            filename: `Merged (Documents ${left.segmentRange[0] + 1}-${right.segmentRange[1] + 1})`,
            abstract: result.text,
            segmentRange: [left.segmentRange[0], right.segmentRange[1]],
          },
        };
      });
      for (const slot of pairSlots) {
        if (!slot.right) next[slot.slot] = slot.left;
      }
      for (const { slot, node } of mergedNodes) {
        next[slot] = node;
      }
      working = next;
    }
    const mergedPair = working.map(item => ({ filename: item.filename, abstract: item.abstract }));
    const merged = await tryRecursiveSegment(
      mergedPair,
      tract,
      contextNotes,
      mergePreamble,
      SYNTHESIS_PROMPT,
      finalConfig,
      {
        ...options,
        enableFinalStream: true,
        cacheMergeSegments: true,
        jobId: options.jobId,
      },
    );
    tokensAccum.inputTokens += merged.usage.inputTokens || 0;
    tokensAccum.outputTokens += merged.usage.outputTokens || 0;
    return {
      text: merged.text,
      model: merged.model,
      payloadBytes: merged.payloadBytes,
      latencyMs: merged.latencyMs,
      streamed: Boolean(merged.streamed),
      timeToFirstDeltaMs: merged.timeToFirstDeltaMs ?? null,
    };
  }
  const result = await tryRecursiveSegment(
    mergeAbstracts,
    tract,
    contextNotes,
    mergePreamble,
    SYNTHESIS_PROMPT,
    finalConfig,
    {
      ...options,
      enableFinalStream: true,
      cacheMergeSegments: true,
      jobId: options.jobId,
    },
  );
  tokensAccum.inputTokens += result.usage.inputTokens || 0;
  tokensAccum.outputTokens += result.usage.outputTokens || 0;
  return {
    text: result.text,
    model: result.model,
    payloadBytes: result.payloadBytes,
    latencyMs: result.latencyMs,
    streamed: Boolean(result.streamed),
    timeToFirstDeltaMs: result.timeToFirstDeltaMs ?? null,
  };
}

export async function planJobSynthesis(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to plan synthesis.');
  const job = await store.getJob(jobId);
  if (!job) {
    const err = new Error('Job not found.');
    err.statusCode = 404;
    throw err;
  }
  if (job.status === 'canceled') {
    const err = new Error('Job has been canceled.');
    err.statusCode = 409;
    throw err;
  }
  if (store.getAbstractionStatus) {
    const abstractionStatus = await store.getAbstractionStatus(jobId);
    const blockers = (abstractionStatus?.pending || 0) + (abstractionStatus?.processing || 0) + (abstractionStatus?.retry_wait || 0);
    if (blockers > 0) {
      const err = new Error('Synthesis cannot start until all abstraction chunks are completed or failed.');
      err.statusCode = 409;
      throw err;
    }
  } else if (store.listChunks) {
    const chunks = await store.listChunks(jobId);
    const blockers = chunks.filter(chunk => ['pending', 'processing', 'retry_wait'].includes(chunk.abstractionStatus || 'pending'));
    if (blockers.length) {
      const err = new Error('Synthesis cannot start until all abstraction chunks are completed or failed.');
      err.statusCode = 409;
      throw err;
    }
  }
  const abstracts = await store.listDocumentAbstracts(jobId);
  const normalizedAbstracts = abstracts
    .filter(item => (item.abstractText || item.abstract || '').trim().length > 0)
    .map(item => ({
      id: item.id,
      chunkId: item.chunkId,
      documentId: item.documentId,
      chunkOrder: item.chunkOrder,
      pageStart: item.pageStart,
      pageEnd: item.pageEnd,
      createdAt: item.createdAt,
      filename: item.sourceFilename || item.originalFilename || item.filename || item.chunkId,
      originalFilename: item.originalFilename,
      sourceFilename: item.sourceFilename,
      abstract: item.abstractText || item.abstract || '',
    }));
  const orderedAbstracts = groupAbstractsByDocument(normalizedAbstracts);
  if (!orderedAbstracts.length) {
    const err = new Error('No abstracts available for synthesis.');
    err.statusCode = 409;
    throw err;
  }
  const planId = computePlanId({
    jobId,
    tract: job.subjectTract || options.tract || '',
    contextNotes: job.contextNotes || options.contextNotes || '',
    documentIds: orderedAbstracts.map(item => item.documentId || item.id),
    abstractDigests: orderedAbstracts.map(computeAbstractDigest),
  });

  const existingPlanId = await store.getCurrentSynthesisPlanId(jobId);
  let plan = null;
  if (existingPlanId === planId) {
    // Idempotent re-plan with identical inputs: leave existing checkpoints intact.
    const existingSegments = await store.listSynthesisSegments(jobId, planId);
    if (existingSegments.length) {
      plan = { planId, segments: existingSegments };
    }
  }
  if (!plan) {
    const { segments } = planSynthesisSegments(
      orderedAbstracts,
      job.subjectTract || options.tract || '',
      job.contextNotes || options.contextNotes || '',
      options.config || {},
    );
    plan = await store.saveSynthesisPlan(jobId, { planId, segments });
  }
  return { plan, abstracts: orderedAbstracts, job };
}

export async function processSynthesisJob(jobId, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required to process synthesis.');
  const config = getSynthesisConfig(options.config || {});
  const startedAt = Date.now();
  const budgetMs = options.budgetMs || 45_000;
  const deadline = startedAt + budgetMs;
  const mergeWorkerId = options.workerId || `wkr_merge_${Math.random().toString(36).slice(2, 10)}`;

  // Recover any stranded leases first.
  if (store.resetStaleSynthesisSegments) {
    await store.resetStaleSynthesisSegments(jobId, options.staleLeaseMs || DEFAULT_STALE_SYNTHESIS_LEASE_MS);
  }

  const planResult = await planJobSynthesis(jobId, options);
  const { plan, abstracts, job } = planResult;
  const planId = plan.planId;
  const singlePass = plan.segments.length === 1;
  let completedInBatch = 0;
  let failedInBatch = 0;
  let retryInBatch = 0;
  let lastError = null;

  while (Date.now() < deadline) {
    let currentJob = await store.getJob(jobId);
    if (currentJob?.status === 'canceled') break;
    const ready = await store.listReadySynthesisSegments(
      jobId,
      planId,
      resolveSynthesisBatchLimit(options),
    );
    if (!ready.length) break;
    const segmentResults = await runWithConcurrency(ready, config.concurrency, async segment => {
      if (Date.now() >= deadline) {
        return { status: 'skipped', segmentId: segment.id, reason: 'deadline' };
      }
      if (!currentJob || currentJob.status === 'canceled') {
        return { status: 'skipped', segmentId: segment.id, reason: 'canceled' };
      }
      return await processSynthesisSegment(jobId, segment, abstracts, {
        ...options,
        store,
        config,
        tract: job.subjectTract || options.tract || '',
        contextNotes: job.contextNotes || options.contextNotes || '',
        singlePass,
      });
    });
    currentJob = await store.getJob(jobId);
    for (const result of segmentResults) {
      if (!result || result.status === 'skipped' || result.status === 'stale') continue;
      if (result.status === 'complete') completedInBatch += 1;
      else if (result.status === 'failed') { failedInBatch += 1; lastError = result.failure; }
      else if (result.status === 'retry_wait') { retryInBatch += 1; lastError = result.failure; }
    }
    if (currentJob?.status === 'canceled') break;
  }

  // After segment work, attempt the final merge if every segment is complete and no result exists yet.
  const refreshedSegments = await store.listSynthesisSegments(jobId, planId);
  const completedSegments = refreshedSegments.filter(s => s.status === 'complete');
  const failedSegments = refreshedSegments.filter(s => s.status === 'failed');
  const stillPending = refreshedSegments.filter(s => ['pending', 'processing', 'retry_wait'].includes(s.status));

  const storedResult = store.getJobResult ? await store.getJobResult(jobId) : null;
  const existingResult = storedResult?.planId === planId ? storedResult : null;
  const tract = job.subjectTract || options.tract || '';
  const contextNotes = job.contextNotes || options.contextNotes || '';

  let result = existingResult || null;
  let failedDocumentRefs = null;
  async function failedDocumentsForMerge() {
    if (!failedDocumentRefs) failedDocumentRefs = await collectFailedDocuments(store, jobId);
    return failedDocumentRefs;
  }
  let splitDegradationWarningRefs = null;
  async function splitDegradationWarningsForMerge() {
    if (!splitDegradationWarningRefs) splitDegradationWarningRefs = await collectSplitDegradationWarnings(store, jobId);
    return splitDegradationWarningRefs;
  }
  async function appendResultWarnings(warnings) {
    const splitWarnings = await splitDegradationWarningsForMerge();
    for (const warning of splitWarnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    return warnings;
  }
  let mergeRanInThisBatch = false;
  let mergeClaimBlocked = false;
  let lastMergeStreamMeta = null;
  async function claimFinalWriter() {
    if (!store.claimSynthesisMerge) return { workerId: null };
    const claim = await store.claimSynthesisMerge(jobId, planId, { workerId: mergeWorkerId, leaseMs: options.mergeLeaseMs || DEFAULT_MERGE_LEASE_MS });
    if (!claim) {
      mergeClaimBlocked = true;
      return null;
    }
    return claim;
  }
  if (!existingResult && completedSegments.length === refreshedSegments.length && refreshedSegments.length > 0) {
    const mergeClaim = await claimFinalWriter();
    if (!mergeClaim) {
      // Another worker is already performing the final write. Report hasMore so
      // callers continue polling instead of treating segment completion as final.
    } else if (singlePass) {
      const onlySummary = completedSegments[0];
      const validation = validateFinalOpinion(onlySummary.summaryText || '');
      const opinionWarnings = [];
      if (!validation.ok) opinionWarnings.push(`final_validation_failed: ${validation.reason}`);
      const failedDocs = await failedDocumentsForMerge();
      if (failedDocs.length) opinionWarnings.push(`${failedDocs.length} document abstract(s) excluded due to abstraction failure.`);
      await appendResultWarnings(opinionWarnings);
      const status = !validation.ok ? 'failed' : failedDocs.length ? 'partial_failed' : 'complete';
      const resultPayload = await applyOpusAuditIfNeeded({
        payload: {
          planId,
          status,
          finalTitleOpinion: validation.ok ? (onlySummary.summaryText || '') : '',
          warnings: opinionWarnings,
          failedDocuments: failedDocs,
          modelUsed: onlySummary.modelUsed || config.model,
          inputTokens: onlySummary.inputTokens || 0,
          outputTokens: onlySummary.outputTokens || 0,
          payloadBytes: onlySummary.payloadBytes || 0,
          synthesisDurationMs: Date.now() - startedAt,
          mergeWorkerId: mergeClaim.workerId,
        },
        abstracts,
        tract,
        contextNotes,
        options,
        config,
      });
      result = await store.saveJobResult(jobId, resultPayload);
      mergeRanInThisBatch = Boolean(result);
    } else {
      const warningsAccum = [];
      const tokensAccum = { inputTokens: 0, outputTokens: 0 };
      completedSegments.forEach(segment => {
        tokensAccum.inputTokens += segment.inputTokens || 0;
        tokensAccum.outputTokens += segment.outputTokens || 0;
        (segment.warnings || []).forEach(w => warningsAccum.push(`segment_${segment.segmentIndex + 1}:${w}`));
      });
      try {
        const merged = await mergeSegmentsIntoOpinion({
          segmentSummaries: completedSegments.sort((a, b) => a.segmentIndex - b.segmentIndex),
          totalAbstracts: abstracts.length,
          tract,
          contextNotes,
          config,
          partialConfig: getPartialSynthesisConfig(options.config || {}),
          options: { ...options, store, jobId },
          warningsAccum,
          tokensAccum,
        });
        const validation = validateFinalOpinion(merged.text);
        if (!validation.ok) {
          warningsAccum.push(`final_validation_failed: ${validation.reason}`);
          if (store.clearSynthesisPreview) await store.clearSynthesisPreview(jobId);
        }
        lastMergeStreamMeta = { streamed: merged.streamed, timeToFirstDeltaMs: merged.timeToFirstDeltaMs };
        const failedDocs = await failedDocumentsForMerge();
        if (failedDocs.length) warningsAccum.push(`${failedDocs.length} document abstract(s) excluded due to abstraction failure.`);
        await appendResultWarnings(warningsAccum);
        const status = !validation.ok ? 'failed' : failedDocs.length ? 'partial_failed' : 'complete';
        const resultPayload = await applyOpusAuditIfNeeded({
          payload: {
            planId,
            status,
            finalTitleOpinion: validation.ok ? merged.text : '',
            warnings: warningsAccum,
            failedDocuments: failedDocs,
            modelUsed: merged.model,
            inputTokens: tokensAccum.inputTokens,
            outputTokens: tokensAccum.outputTokens,
            payloadBytes: merged.payloadBytes,
            synthesisDurationMs: Date.now() - startedAt,
            mergeWorkerId: mergeClaim.workerId,
          },
          abstracts,
          tract,
          contextNotes,
          options,
          config,
        });
        result = await store.saveJobResult(jobId, resultPayload);
        mergeRanInThisBatch = Boolean(result);
      } catch (err) {
        lastError = { errorType: classifyError(err), errorMessage: sanitizeErrorMessage(err) };
        const finalWarnings = await appendResultWarnings([`final_merge_failed: ${lastError.errorType}`]);
        result = await store.saveJobResult(jobId, {
          planId,
          status: 'failed',
          finalTitleOpinion: '',
          warnings: finalWarnings,
          failedDocuments: await failedDocumentsForMerge(),
          modelUsed: config.model,
          inputTokens: tokensAccum.inputTokens,
          outputTokens: tokensAccum.outputTokens,
          payloadBytes: 0,
          synthesisDurationMs: Date.now() - startedAt,
          mergeWorkerId: mergeClaim.workerId,
        });
        mergeRanInThisBatch = Boolean(result);
      }
    }
  } else if (!existingResult && failedSegments.length && !stillPending.length) {
    // All work finished with at least one failed segment. Preserve any completed
    // segment work as a degraded result instead of stranding the job with no result.
    const mergeClaim = await claimFinalWriter();
    if (!mergeClaim) {
      // Another worker owns finalization.
    } else {
      const failureWarnings = failedSegments.map(s => `segment_${s.segmentIndex + 1}_failed: ${s.errorType || 'unknown'}`);
      if (completedSegments.length) {
        const warningsAccum = [...failureWarnings];
        const tokensAccum = { inputTokens: 0, outputTokens: 0 };
        completedSegments.forEach(segment => {
          tokensAccum.inputTokens += segment.inputTokens || 0;
          tokensAccum.outputTokens += segment.outputTokens || 0;
          (segment.warnings || []).forEach(w => warningsAccum.push(`segment_${segment.segmentIndex + 1}:${w}`));
        });
        try {
          const merged = await mergeSegmentsIntoOpinion({
            segmentSummaries: completedSegments.sort((a, b) => a.segmentIndex - b.segmentIndex),
            totalAbstracts: abstracts.length,
            tract,
            contextNotes,
            config,
            partialConfig: getPartialSynthesisConfig(options.config || {}),
            options: { ...options, store, jobId },
            warningsAccum,
            tokensAccum,
          });
          const validation = validateFinalOpinion(merged.text);
          if (!validation.ok) {
            warningsAccum.push(`final_validation_failed: ${validation.reason}`);
            if (store.clearSynthesisPreview) await store.clearSynthesisPreview(jobId);
          }
          lastMergeStreamMeta = { streamed: merged.streamed, timeToFirstDeltaMs: merged.timeToFirstDeltaMs };
          const failedDocs = await failedDocumentsForMerge();
          if (failedDocs.length) warningsAccum.push(`${failedDocs.length} document abstract(s) excluded due to abstraction failure.`);
          await appendResultWarnings(warningsAccum);
          const resultStatus = validation.ok ? 'partial_failed' : 'failed';
          const resultPayload = await applyOpusAuditIfNeeded({
            payload: {
              planId,
              status: resultStatus,
              finalTitleOpinion: validation.ok ? merged.text : '',
              warnings: warningsAccum,
              failedDocuments: failedDocs,
              modelUsed: merged.model,
              inputTokens: tokensAccum.inputTokens,
              outputTokens: tokensAccum.outputTokens,
              payloadBytes: merged.payloadBytes,
              synthesisDurationMs: Date.now() - startedAt,
              mergeWorkerId: mergeClaim.workerId,
            },
            abstracts,
            tract,
            contextNotes,
            options,
            config,
          });
          result = await store.saveJobResult(jobId, resultPayload);
          mergeRanInThisBatch = Boolean(result);
        } catch (err) {
          lastError = { errorType: classifyError(err), errorMessage: sanitizeErrorMessage(err) };
          await appendResultWarnings(warningsAccum);
          result = await store.saveJobResult(jobId, {
            planId,
            status: 'failed',
            finalTitleOpinion: '',
            warnings: [...warningsAccum, `final_merge_failed: ${lastError.errorType}`],
            failedDocuments: await failedDocumentsForMerge(),
            modelUsed: config.model,
            inputTokens: tokensAccum.inputTokens,
            outputTokens: tokensAccum.outputTokens,
            payloadBytes: 0,
            synthesisDurationMs: Date.now() - startedAt,
            mergeWorkerId: mergeClaim.workerId,
          });
          mergeRanInThisBatch = Boolean(result);
        }
      } else {
        const failureWarnings = [
          'all_segments_failed',
          ...failedSegments.map(s => `segment_${s.segmentIndex + 1}_failed: ${s.errorType || 'unknown'}`),
        ];
        await appendResultWarnings(failureWarnings);
        result = await store.saveJobResult(jobId, {
          planId,
          status: 'failed',
          finalTitleOpinion: '',
          warnings: failureWarnings,
          failedDocuments: await failedDocumentsForMerge(),
          modelUsed: config.model,
          inputTokens: 0,
          outputTokens: 0,
          payloadBytes: 0,
          synthesisDurationMs: Date.now() - startedAt,
          mergeWorkerId: mergeClaim.workerId,
        });
        mergeRanInThisBatch = Boolean(result);
      }
    }
  }

  const status = await store.getSynthesisStatus(jobId, { lightweight: true });
  if (mergeRanInThisBatch && result) {
    logSynthesisMetrics({
      event: 'synthesis_merge_complete',
      jobId,
      planId: result.planId || planId,
      segmentCount: plan.segments.length,
      singlePass,
      status: result.status,
      synthesisDurationMs: result.synthesisDurationMs ?? null,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      payloadBytes: result.payloadBytes ?? null,
      modelUsed: result.modelUsed || null,
      warningFlags: summarizeSynthesisWarningFlags(result.warnings),
      synthesisDriver: 'server',
      streamed: Boolean(lastMergeStreamMeta?.streamed),
      timeToFirstDeltaMs: lastMergeStreamMeta?.timeToFirstDeltaMs ?? null,
    });
  }
  logSynthesisMetrics({
    event: 'synthesis_batch_complete',
    jobId,
    planId,
    segmentCount: plan.segments.length,
    singlePass,
    completedInBatch,
    failedInBatch,
    retryScheduledInBatch: retryInBatch,
    mergeRan: mergeRanInThisBatch,
    elapsedMs: Date.now() - startedAt,
    pendingSegments: (status?.pending || 0) + (status?.processing || 0) + (status?.retry_wait || 0),
    mergeInProgress: Boolean(status?.mergeInProgress),
    synthesisDriver: 'server',
  });
  return {
    planId,
    plan,
    segments: [],
    completedInBatch,
    failedInBatch,
    retryScheduledInBatch: retryInBatch,
    mergeRan: mergeRanInThisBatch,
    elapsedMs: Date.now() - startedAt,
    result,
    status,
    lastError: lastError ? { errorType: lastError.errorType, errorMessage: lastError.errorMessage } : null,
    hasMore: mergeClaimBlocked
      || Boolean(status?.mergeInProgress)
      || ((status?.pending || 0) + (status?.processing || 0) + (status?.retry_wait || 0) > 0),
  };
}

async function collectFailedDocuments(store, jobId) {
  try {
    const chunks = store.listFailedChunks
      ? await store.listFailedChunks(jobId)
      : (store.listChunks ? (await store.listChunks(jobId)).filter(chunk => chunk.abstractionStatus === 'failed') : []);
    return chunks.map(chunk => ({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      chunkOrder: chunk.chunkOrder,
      filename: chunk.originalFilename,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      errorType: chunk.abstractionErrorType,
      errorMessage: chunk.abstractionErrorMessage,
    }));
  } catch {
    return [];
  }
}

async function collectSplitDegradationWarnings(store, jobId) {
  if (!store.listChunks) return [];
  try {
    const chunks = await store.listChunks(jobId);
    const splitChildren = chunks.filter(chunk => chunk.splitParentChunkId && chunk.abstractionStatus !== 'split_superseded');
    const byDocument = new Map();
    for (const chunk of splitChildren) {
      const key = chunk.documentId || chunk.splitFrom || chunk.originalFilename || chunk.splitParentChunkId;
      const existing = byDocument.get(key) || {
        filename: chunk.splitFrom || chunk.originalFilename || 'A PDF',
        reason: chunk.splitReason || chunk.abstractionErrorType || 'model_request_limit',
        ranges: [],
      };
      if (chunk.splitFrom) existing.filename = chunk.splitFrom;
      if (chunk.pageStart && chunk.pageEnd) existing.ranges.push([chunk.pageStart, chunk.pageEnd]);
      byDocument.set(key, existing);
    }
    return [...byDocument.values()].map(item => {
      const orderedRanges = item.ranges
        .sort((a, b) => a[0] - b[0])
        .map(([start, end]) => `pp ${start}${end === start ? '' : `-${end}`}`)
        .join(', ');
      const rangeText = orderedRanges ? ` (${orderedRanges})` : '';
      return `${item.filename}${rangeText} exceeded model request limits and was abstracted in page-range segments. Verify clause continuity, legal descriptions, exceptions, exhibits, and cross-page context manually.`;
    });
  } catch {
    return [];
  }
}

function truncateForBudget(text, maxBytes) {
  if (utf8ByteLength(text) <= maxBytes) return text;
  // Approximate by character slicing; UTF-8 chars can be multi-byte but title
  // opinions are predominantly ASCII so this is conservative enough.
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (utf8ByteLength(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

export function buildFollowupMessages({
  question,
  finalTitleOpinion,
  recentTurns = [],
  retrievedAbstracts = [],
  configOverrides = {},
}) {
  const config = getSynthesisConfig(configOverrides);
  const safeOpinion = String(finalTitleOpinion || '');
  let truncationWarning = null;

  function build(historyTurns, opinion, abstractBlock = '') {
    const recentText = historyTurns
      .map(turn => `User: ${turn.question}\n\nAssistant: ${turn.answer}`)
      .join('\n\n');
    const content =
      `Use the completed title opinion below to answer the landman's follow-up question. Do not rely on the original raw document abstracts unless they are quoted in the title opinion. If the answer requires checking source documents, say so clearly.\n\n` +
      `## Completed Title Opinion\n\n${opinion}\n\n` +
      (recentText ? `## Recent Follow-up Context\n\n${recentText}\n\n` : '') +
      (abstractBlock ? `## Source Excerpts (verification only)\n\n${abstractBlock}\n\n` : '') +
      `## Follow-up Question\n\n${question}`;
    return [{ role: 'user', content }];
  }

  function fits(messages) {
    return estimateRequestBytes(config.model, config.maxTokens, FOLLOWUP_PROMPT, messages) <= config.requestEnvelopeSafeBytes;
  }

  const abstractBlock = retrievedAbstracts.length
    ? retrievedAbstracts
        .map(item => `### ${item.filename}\n\n${item.abstract}`)
        .join('\n\n---\n\n')
    : '';

  // Drop oldest follow-up history first.
  for (let turns = config.followupHistoryTurns; turns >= 0; turns--) {
    const subset = recentTurns.slice(-turns);
    const messages = build(subset, safeOpinion, abstractBlock);
    if (fits(messages)) return { messages, truncationWarning };
  }
  // Truncate opinion next.
  let keepBytes = Math.min(utf8ByteLength(safeOpinion), Math.max(0, config.requestEnvelopeSafeBytes - 100_000));
  while (keepBytes > 0) {
    const trimmed = truncateForBudget(safeOpinion, keepBytes);
    const messages = build([], trimmed, abstractBlock);
    if (fits(messages)) {
      truncationWarning = `Title opinion truncated to ${(keepBytes / 1024).toFixed(1)} KB to fit follow-up request budget; some details may be missing.`;
      return { messages, truncationWarning };
    }
    keepBytes = Math.floor(keepBytes * 0.75);
  }
  truncationWarning = 'Title opinion is too large to include in follow-up request. Narrow the question or rerun a smaller analysis.';
  return {
    messages: [{
      role: 'user',
      content: `${truncationWarning}\n\n## Follow-up Question\n\n${question}`,
    }],
    truncationWarning,
  };
}

export async function answerFollowupQuestion(jobId, question, options = {}) {
  const store = options.store;
  if (!store) throw new Error('A job store is required for follow-ups.');
  const result = await store.getJobResult(jobId);
  if (!result || !result.finalTitleOpinion) {
    const err = new Error('Final title opinion not available for this job. Run synthesis first.');
    err.statusCode = 409;
    throw err;
  }
  const config = getSynthesisConfig(options.config || {});
  const priorMessages = store.listFollowupMessages
    ? await store.listFollowupMessages(jobId, 50)
    : [];
  const { messages, truncationWarning } = buildFollowupMessages({
    question,
    finalTitleOpinion: result.finalTitleOpinion,
    recentTurns: priorMessages.slice(-config.followupHistoryTurns).map(m => ({ question: m.question, answer: m.answer })),
    retrievedAbstracts: [],
    configOverrides: options.config || {},
  });
  const payloadBytes = estimateRequestBytes(config.model, config.maxTokens, FOLLOWUP_PROMPT, messages);
  const started = Date.now();
  let response;
  try {
    response = await getModelClient(options)({
      model: config.model,
      maxTokens: config.maxTokens,
      system: FOLLOWUP_PROMPT,
      messages,
      payloadBytes,
      upstreamTimeoutMs: config.upstreamTimeoutMs,
    });
  } catch (err) {
    const wrapped = new Error(sanitizeErrorMessage(err));
    wrapped.statusCode = err?.statusCode || err?.status || 502;
    wrapped.errorType = classifyError(err);
    throw wrapped;
  }
  const usage = extractUsage(response.usage);
  const answer = response.text || '';
  const saved = await store.appendFollowupMessage(jobId, {
    question,
    answer,
    modelUsed: response.model || config.model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    payloadBytes,
    retrievedDocumentIds: [],
    truncationWarning,
  });
  return {
    followup: saved,
    truncationWarning,
    latencyMs: Date.now() - started,
  };
}

export function synthesisSetupError() {
  if (globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ || globalThis.__TITLE_ANALYZER_MODEL_CLIENT__) {
    return null;
  }
  const missing = [];
  const finalModel = resolveFinalSynthesisModel();
  const partialModel = resolvePartialSynthesisModel();
  if (isGeminiModel(finalModel) || isGeminiModel(partialModel)) {
    const geminiError = geminiApiKeyError();
    if (geminiError) missing.push(geminiError);
  }
  if (isAnthropicModel(finalModel)) {
    if (!process.env.ANTHROPIC_API_KEY) {
      missing.push('ANTHROPIC_API_KEY is required when SYNTHESIS_MODEL is a Claude model.');
    }
  } else if (!isGeminiModel(finalModel)) {
    missing.push(`Unsupported SYNTHESIS_MODEL: ${finalModel}`);
  }
  return missing.length ? missing.join(' ') : null;
}
