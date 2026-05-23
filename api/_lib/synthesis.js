// Phase 5 — durable server-side synthesis.
//
// Reads completed abstracts from Postgres, plans dynamic synthesis segments,
// runs partial synthesis per segment with checkpointing, then merges segments
// into a final title opinion. Falls back to a binary split when a single
// segment hits 413/timeout, and to a tree-merge when the merge call itself
// would exceed the safe request envelope.
//
// Required env vars:
//   - ANTHROPIC_API_KEY (override per call with options.modelClient)
//
// Configurable (env):
//   - SYNTHESIS_MODEL (default: claude-sonnet-4-6)
//   - SYNTHESIS_MAX_TOKENS (default: 8000)
//   - SYNTHESIS_CHUNK_SIZE (default: 50)
//   - REQUEST_ENVELOPE_SAFE_BYTES (default: 3_900_000)
//   - REQUEST_OVERHEAD_BYTES (default: 350_000)
//   - SYNTHESIS_MAX_ATTEMPTS (default: 3)
//   - SYNTHESIS_FOLLOWUP_HISTORY_TURNS (default: 4)
//   - SYNTHESIS_UPSTREAM_TIMEOUT_MS (default: 52_000)

import { createHash } from 'crypto';

const DEFAULT_SYNTHESIS_MODEL = process.env.SYNTHESIS_MODEL || 'claude-sonnet-4-6';
const DEFAULT_SYNTHESIS_MAX_TOKENS = clampInt(process.env.SYNTHESIS_MAX_TOKENS, 8000, 256, 8192);
const DEFAULT_SYNTHESIS_CHUNK_SIZE = clampInt(process.env.SYNTHESIS_CHUNK_SIZE, 50, 1, 100);
const DEFAULT_REQUEST_ENVELOPE_SAFE_BYTES = clampInt(process.env.REQUEST_ENVELOPE_SAFE_BYTES, 3_900_000, 100_000, 4_400_000);
const DEFAULT_REQUEST_OVERHEAD_BYTES = clampInt(process.env.REQUEST_OVERHEAD_BYTES, 350_000, 0, 1_000_000);
const DEFAULT_MAX_ATTEMPTS = clampInt(process.env.SYNTHESIS_MAX_ATTEMPTS, 3, 1, 10);
const DEFAULT_FOLLOWUP_HISTORY_TURNS = clampInt(process.env.SYNTHESIS_FOLLOWUP_HISTORY_TURNS, 4, 0, 20);
const DEFAULT_UPSTREAM_TIMEOUT_MS = clampInt(process.env.SYNTHESIS_UPSTREAM_TIMEOUT_MS, 52_000, 10_000, 60_000);
const MAX_RETRY_WAIT_MS = 5 * 60_000;
const MIN_FINAL_OPINION_CHARS = 500;
const MIN_SEGMENT_SUMMARY_CHARS = 200;

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
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

You will receive abstracts for a subset of documents from a full run. Produce a partial chain-of-title analysis for this segment only.

Include:
- Chronological ownership flow for these documents
- Fractional math at each step
- Title defects and curative items found in this segment
- Running fractional balance at the end of this segment

Do NOT produce a final ownership determination table — a later pass merges all segments. Only use facts from the abstracts provided. Flag gaps explicitly.`;

export const FOLLOWUP_PROMPT = SYNTHESIS_PROMPT;

export function getSynthesisConfig(overrides = {}) {
  return {
    model: overrides.model || DEFAULT_SYNTHESIS_MODEL,
    maxTokens: overrides.maxTokens || DEFAULT_SYNTHESIS_MAX_TOKENS,
    chunkSize: overrides.chunkSize || DEFAULT_SYNTHESIS_CHUNK_SIZE,
    requestEnvelopeSafeBytes: overrides.requestEnvelopeSafeBytes || DEFAULT_REQUEST_ENVELOPE_SAFE_BYTES,
    requestOverheadBytes: overrides.requestOverheadBytes || DEFAULT_REQUEST_OVERHEAD_BYTES,
    maxAttempts: overrides.maxAttempts || DEFAULT_MAX_ATTEMPTS,
    followupHistoryTurns: overrides.followupHistoryTurns || DEFAULT_FOLLOWUP_HISTORY_TURNS,
    upstreamTimeoutMs: overrides.upstreamTimeoutMs || DEFAULT_UPSTREAM_TIMEOUT_MS,
  };
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
  const config = getSynthesisConfig(configOverrides);
  const chunks = [];
  let current = [];
  for (const abstract of abstracts) {
    const candidate = [...current, abstract];
    const candidateInput = buildAbstractInput(candidate, tract, ctx, preamble);
    const candidateBytes = estimateRequestBytes(
      config.model,
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
  const chunkLists = buildSynthesisChunks(
    abstracts,
    tract,
    contextNotes,
    preamble,
    SYNTHESIS_PROMPT,
    configOverrides,
  );
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
    const estimatedBytes = estimateRequestBytes(
      config.model,
      config.maxTokens,
      chunkLists.length === 1 ? SYNTHESIS_PROMPT : PARTIAL_SYNTHESIS_PROMPT,
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
  return String(err?.message || err || 'Unknown error')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, '[REDACTED]')
    .slice(0, 1000);
}

function extractUsage(usage = {}) {
  return {
    inputTokens: Number.isInteger(usage.input_tokens) ? usage.input_tokens : Number.isInteger(usage.inputTokens) ? usage.inputTokens : null,
    outputTokens: Number.isInteger(usage.output_tokens) ? usage.output_tokens : Number.isInteger(usage.outputTokens) ? usage.outputTokens : null,
  };
}

async function defaultModelClient(request) {
  if (!process.env.ANTHROPIC_API_KEY) {
    const error = new Error('ANTHROPIC_API_KEY is required for server-side synthesis.');
    error.statusCode = 503;
    throw error;
  }
  const body = JSON.stringify({
    model: request.model,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
  });
  const timeout = createTimeoutSignal(request.upstreamTimeoutMs || DEFAULT_UPSTREAM_TIMEOUT_MS);
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
  if (!lower.includes('chain') && !lower.includes('ownership')) {
    return { ok: false, reason: 'Segment summary missing chain/ownership content.' };
  }
  return { ok: true };
}

function buildSegmentMessages(abstracts, tract, ctx, preamble) {
  return [{ role: 'user', content: buildAbstractInput(abstracts, tract, ctx, preamble) }];
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
  const messages = buildSegmentMessages(abstracts, tract, contextNotes, preamble);
  const payloadBytes = estimateRequestBytes(config.model, config.maxTokens, systemPrompt, messages);
  if (payloadBytes > config.requestEnvelopeSafeBytes) {
    const err = new Error(`Synthesis request too large (${(payloadBytes / 1024 / 1024).toFixed(1)} MB).`);
    err.status = 413;
    throw err;
  }
  const started = Date.now();
  const response = await getModelClient(options)({
    model: config.model,
    maxTokens: config.maxTokens,
    system: systemPrompt,
    messages,
    payloadBytes,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
  });
  return {
    text: response.text || '',
    model: response.model || config.model,
    usage: extractUsage(response.usage),
    payloadBytes,
    latencyMs: Date.now() - started,
  };
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
  const segmentAbstracts = (segment.documentIds || [])
    .map(id => byDocumentId.get(id) || byChunkId.get(id))
    .filter(Boolean)
    .map(record => ({
      filename: record.filename || record.originalFilename || record.documentId || record.chunkId,
      abstract: record.abstract || record.abstractText || '',
      documentId: record.documentId,
      chunkId: record.chunkId,
      chunkIds: record.chunkIds || (record.chunkId ? [record.chunkId] : []),
    }))
    .filter(item => item.abstract.trim().length > 0);

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
  const isSinglePass = options.singlePass === true;
  const systemPrompt = isSinglePass ? SYNTHESIS_PROMPT : PARTIAL_SYNTHESIS_PROMPT;
  const preamble = isSinglePass
    ? `Below are ${totalDocs} document abstracts. Synthesize into a complete title opinion.`
    : `Below are document abstracts ${start}-${end} of ${totalDocs}. Produce a partial chain-of-title segment.`;

  const startedAt = Date.now();
  let lastError = null;
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      const result = await tryRecursiveSegment(segmentAbstracts, tract, contextNotes, preamble, systemPrompt, config, options);
      const validation = isSinglePass ? validateFinalOpinion(result.text) : validateSegmentSummary(result.text);
      const warnings = [];
      if (result.splitApplied) warnings.push('segment_split');
      if (!validation.ok && attempt < config.maxAttempts) {
        // Repair retry: ask model to be more complete.
        const repairAbstracts = segmentAbstracts;
        const repairPreamble = `${preamble}\n\nPrevious response was incomplete or missing required sections: ${validation.reason} Produce a complete response that includes every required section.`;
        const retry = await callSynthesisModel({
          abstracts: repairAbstracts,
          tract,
          contextNotes,
          preamble: repairPreamble,
          systemPrompt,
          config,
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

function fitsRequestBudget(abstracts, tract, contextNotes, preamble, systemPrompt, config) {
  const messages = buildSegmentMessages(abstracts, tract, contextNotes, preamble);
  const bytes = estimateRequestBytes(config.model, config.maxTokens, systemPrompt, messages);
  return { fits: bytes <= config.requestEnvelopeSafeBytes, bytes };
}

async function mergeSegmentsIntoOpinion({
  segmentSummaries,
  totalAbstracts,
  tract,
  contextNotes,
  config,
  options,
  warningsAccum,
  tokensAccum,
}) {
  const mergeAbstracts = segmentSummaries.map(summary => ({
    filename: `Segment ${summary.segmentIndex + 1} (Documents ${summary.startSequenceIndex + 1}-${summary.endSequenceIndex + 1})`,
    abstract: summary.summaryText,
  }));
  const preamble = `Below are ${segmentSummaries.length} partial chain-of-title segments covering all ${totalAbstracts} documents. Merge them into one complete title opinion.`;
  const fit = fitsRequestBudget(mergeAbstracts, tract, contextNotes, preamble, SYNTHESIS_PROMPT, config);
  if (!fit.fits && mergeAbstracts.length > 2) {
    // Tree-merge: pair segments and partial-merge until one summary remains.
    warningsAccum.push('merge_tree_applied');
    let working = segmentSummaries.map((summary, idx) => ({
      filename: `Segment ${summary.segmentIndex + 1} (Documents ${summary.startSequenceIndex + 1}-${summary.endSequenceIndex + 1})`,
      abstract: summary.summaryText,
      segmentRange: [summary.startSequenceIndex, summary.endSequenceIndex],
      index: idx,
    }));
    while (working.length > 2) {
      const next = [];
      for (let i = 0; i < working.length; i += 2) {
        const left = working[i];
        const right = working[i + 1];
        if (!right) { next.push(left); continue; }
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
          config,
          options,
        );
        tokensAccum.inputTokens += result.usage.inputTokens || 0;
        tokensAccum.outputTokens += result.usage.outputTokens || 0;
        next.push({
          filename: `Merged (Documents ${left.segmentRange[0] + 1}-${right.segmentRange[1] + 1})`,
          abstract: result.text,
          segmentRange: [left.segmentRange[0], right.segmentRange[1]],
          index: next.length,
        });
      }
      working = next;
    }
    const mergedPair = working.map(item => ({ filename: item.filename, abstract: item.abstract }));
    const merged = await tryRecursiveSegment(
      mergedPair,
      tract,
      contextNotes,
      preamble,
      SYNTHESIS_PROMPT,
      config,
      options,
    );
    tokensAccum.inputTokens += merged.usage.inputTokens || 0;
    tokensAccum.outputTokens += merged.usage.outputTokens || 0;
    return {
      text: merged.text,
      model: merged.model,
      payloadBytes: merged.payloadBytes,
      latencyMs: merged.latencyMs,
    };
  }
  const result = await tryRecursiveSegment(
    mergeAbstracts,
    tract,
    contextNotes,
    preamble,
    SYNTHESIS_PROMPT,
    config,
    options,
  );
  tokensAccum.inputTokens += result.usage.inputTokens || 0;
  tokensAccum.outputTokens += result.usage.outputTokens || 0;
  return {
    text: result.text,
    model: result.model,
    payloadBytes: result.payloadBytes,
    latencyMs: result.latencyMs,
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
    await store.resetStaleSynthesisSegments(jobId, options.staleLeaseMs || 180_000);
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
    const currentJob = await store.getJob(jobId);
    if (currentJob?.status === 'canceled') break;
    const ready = await store.listReadySynthesisSegments(jobId, planId, options.batchLimit || 4);
    if (!ready.length) break;
    for (const segment of ready) {
      if (Date.now() >= deadline) break;
      const refreshedJob = await store.getJob(jobId);
      if (refreshedJob?.status === 'canceled') break;
      const result = await processSynthesisSegment(jobId, segment, abstracts, {
        ...options,
        store,
        config,
        tract: job.subjectTract || options.tract || '',
        contextNotes: job.contextNotes || options.contextNotes || '',
        singlePass,
      });
      if (result.status === 'complete') completedInBatch += 1;
      else if (result.status === 'failed') { failedInBatch += 1; lastError = result.failure; }
      else if (result.status === 'retry_wait') { retryInBatch += 1; lastError = result.failure; }
    }
  }

  // After segment work, attempt the final merge if every segment is complete and no result exists yet.
  const refreshedSegments = await store.listSynthesisSegments(jobId, planId);
  const completedSegments = refreshedSegments.filter(s => s.status === 'complete');
  const failedSegments = refreshedSegments.filter(s => s.status === 'failed');
  const stillPending = refreshedSegments.filter(s => ['pending', 'processing', 'retry_wait'].includes(s.status));

  const storedResult = store.getJobResult ? await store.getJobResult(jobId) : null;
  const existingResult = storedResult?.planId === planId ? storedResult : null;
  const failedDocumentRefs = await collectFailedDocuments(store, jobId);
  const tract = job.subjectTract || options.tract || '';
  const contextNotes = job.contextNotes || options.contextNotes || '';

  let result = existingResult || null;
  let mergeRanInThisBatch = false;
  let mergeClaimBlocked = false;
  async function claimFinalWriter() {
    if (!store.claimSynthesisMerge) return { workerId: null };
    const claim = await store.claimSynthesisMerge(jobId, planId, { workerId: mergeWorkerId, leaseMs: options.mergeLeaseMs || 120_000 });
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
      if (failedDocumentRefs.length) opinionWarnings.push(`${failedDocumentRefs.length} document abstract(s) excluded due to abstraction failure.`);
      const status = !validation.ok ? 'failed' : failedDocumentRefs.length ? 'partial_failed' : 'complete';
      result = await store.saveJobResult(jobId, {
        planId,
        status,
        finalTitleOpinion: validation.ok ? (onlySummary.summaryText || '') : '',
        warnings: opinionWarnings,
        failedDocuments: failedDocumentRefs,
        modelUsed: onlySummary.modelUsed || config.model,
        inputTokens: onlySummary.inputTokens || 0,
        outputTokens: onlySummary.outputTokens || 0,
        payloadBytes: onlySummary.payloadBytes || 0,
        synthesisDurationMs: Date.now() - startedAt,
        mergeWorkerId: mergeClaim.workerId,
      });
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
          options,
          warningsAccum,
          tokensAccum,
        });
        const validation = validateFinalOpinion(merged.text);
        if (!validation.ok) warningsAccum.push(`final_validation_failed: ${validation.reason}`);
        if (failedDocumentRefs.length) warningsAccum.push(`${failedDocumentRefs.length} document abstract(s) excluded due to abstraction failure.`);
        const status = !validation.ok ? 'failed' : failedDocumentRefs.length ? 'partial_failed' : 'complete';
        result = await store.saveJobResult(jobId, {
          planId,
          status,
          finalTitleOpinion: validation.ok ? merged.text : '',
          warnings: warningsAccum,
          failedDocuments: failedDocumentRefs,
          modelUsed: merged.model,
          inputTokens: tokensAccum.inputTokens,
          outputTokens: tokensAccum.outputTokens,
          payloadBytes: merged.payloadBytes,
          synthesisDurationMs: Date.now() - startedAt,
          mergeWorkerId: mergeClaim.workerId,
        });
        mergeRanInThisBatch = Boolean(result);
      } catch (err) {
        lastError = { errorType: classifyError(err), errorMessage: sanitizeErrorMessage(err) };
        result = await store.saveJobResult(jobId, {
          planId,
          status: 'failed',
          finalTitleOpinion: '',
          warnings: [`final_merge_failed: ${lastError.errorType}`],
          failedDocuments: failedDocumentRefs,
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
            options,
            warningsAccum,
            tokensAccum,
          });
          const validation = validateFinalOpinion(merged.text);
          if (!validation.ok) warningsAccum.push(`final_validation_failed: ${validation.reason}`);
          if (failedDocumentRefs.length) warningsAccum.push(`${failedDocumentRefs.length} document abstract(s) excluded due to abstraction failure.`);
          const resultStatus = validation.ok ? 'partial_failed' : 'failed';
          result = await store.saveJobResult(jobId, {
            planId,
            status: resultStatus,
            finalTitleOpinion: validation.ok ? merged.text : '',
            warnings: warningsAccum,
            failedDocuments: failedDocumentRefs,
            modelUsed: merged.model,
            inputTokens: tokensAccum.inputTokens,
            outputTokens: tokensAccum.outputTokens,
            payloadBytes: merged.payloadBytes,
            synthesisDurationMs: Date.now() - startedAt,
            mergeWorkerId: mergeClaim.workerId,
          });
          mergeRanInThisBatch = Boolean(result);
        } catch (err) {
          lastError = { errorType: classifyError(err), errorMessage: sanitizeErrorMessage(err) };
          result = await store.saveJobResult(jobId, {
            planId,
            status: 'failed',
            finalTitleOpinion: '',
            warnings: [...warningsAccum, `final_merge_failed: ${lastError.errorType}`],
            failedDocuments: failedDocumentRefs,
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
        result = await store.saveJobResult(jobId, {
          planId,
          status: 'failed',
          finalTitleOpinion: '',
          warnings: failureWarnings,
          failedDocuments: failedDocumentRefs,
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

  const finalSegments = await store.listSynthesisSegments(jobId, planId);
  const status = await store.getSynthesisStatus(jobId);
  return {
    planId,
    plan,
    segments: finalSegments,
    completedInBatch,
    failedInBatch,
    retryScheduledInBatch: retryInBatch,
    mergeRan: mergeRanInThisBatch,
    elapsedMs: Date.now() - startedAt,
    result,
    status,
    lastError: lastError ? { errorType: lastError.errorType, errorMessage: lastError.errorMessage } : null,
    hasMore: mergeClaimBlocked || ((status?.pending || 0) + (status?.processing || 0) + (status?.retry_wait || 0) > 0),
  };
}

async function collectFailedDocuments(store, jobId) {
  if (!store.listChunks) return [];
  try {
    const chunks = await store.listChunks(jobId);
    return chunks
      .filter(chunk => chunk.abstractionStatus === 'failed')
      .map(chunk => ({
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
  if (!process.env.ANTHROPIC_API_KEY
    && !globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__
    && !globalThis.__TITLE_ANALYZER_MODEL_CLIENT__) {
    return 'ANTHROPIC_API_KEY is required for server-side synthesis.';
  }
  return null;
}
