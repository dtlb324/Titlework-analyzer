import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import jobsRouteHandler from '../api/jobs/[...path].js';
import {
  buildFollowupMessages,
  buildSynthesisChunks,
  computePlanId,
  estimateRequestBytes,
  groupAbstractsByDocument,
  planSynthesisSegments,
  PARTIAL_SYNTHESIS_PROMPT,
  planJobSynthesis,
  processSynthesisSegment,
  processSynthesisJob,
  SYNTHESIS_PROMPT,
  getSynthesisConfig,
  getPartialSynthesisConfig,
  resolveFinalSynthesisModel,
  resolvePartialSynthesisModel,
  effectiveSynthesisChunkSize,
  resolveSynthesisBatchLimit,
  summarizeSynthesisWarningFlags,
  buildSynthesisMetricsEvent,
  synthesisStreamEnabled,
  synthesisCompactionEnabled,
  shouldForceMultiSegmentPlanning,
  shouldCompactBeforeMerge,
  COMPACTION_SYNTHESIS_PROMPT,
  tryRecoverMergePreview,
} from '../api/_lib/synthesis.js';
import {
  processSynthesisBatch,
  enqueueSynthesisJob,
  scheduleBackgroundSynthesis,
  getSynthesisBackgroundPromise,
} from '../api/_lib/queue.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');
const previousAppPassword = process.env.APP_PASSWORD;
process.env.APP_PASSWORD = 'test-password';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test';
process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-gemini-key';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function mockReq(method, body = null, headers = {}, query = {}, url = '/api/jobs/job_test_1') {
  return {
    method,
    body,
    query,
    headers: { 'x-forwarded-for': '198.51.100.10', 'x-app-password': 'test-password', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    url,
  };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
}

// --- Memory store for Phase 5 synthesis tests -------------------------------

function makeAbstract(overrides = {}) {
  return {
    chunkId: overrides.chunkId,
    documentId: Object.hasOwn(overrides, 'documentId') ? overrides.documentId : 'doc_1',
    chunkOrder: overrides.chunkOrder ?? 0,
    originalFilename: overrides.originalFilename || `${overrides.chunkId}.pdf`,
    filename: overrides.filename || overrides.originalFilename || `${overrides.chunkId}.pdf`,
    sourceFilename: overrides.sourceFilename,
    pageStart: overrides.pageStart,
    pageEnd: overrides.pageEnd,
    splitFrom: overrides.splitFrom,
    splitParentChunkId: overrides.splitParentChunkId,
    splitReason: overrides.splitReason,
    createdAt: overrides.createdAt,
    abstractText: overrides.abstractText || `DOC TYPE: Deed\nGRANTOR: Person ${overrides.chunkId}\nGRANTEE: Person ${overrides.chunkId}+1\nFRACTION CONVEYED: 1/4`,
    status: 'completed',
  };
}

function createMemoryPhase5Store(initialState = {}) {
  const now = () => new Date().toISOString();
  const jobs = new Map([[ 'job_test_1', {
    id: 'job_test_1',
    status: initialState.jobStatus || 'synthesizing',
    subjectTract: initialState.tract || 'A.B. Survey, Block 1',
    contextNotes: initialState.contextNotes || 'Test',
    totalDocuments: (initialState.abstracts || []).length,
    completedDocuments: (initialState.abstracts || []).length,
    failedDocuments: (initialState.failedChunks || []).length,
    currentPhase: 'synthesizing',
    errorMessage: null,
    createdAt: now(),
    updatedAt: now(),
    synthesisPlanId: null,
  }]]);

  const abstracts = (initialState.abstracts || []).slice();
  const failedChunks = (initialState.failedChunks || []).slice();
  const pendingChunks = (initialState.pendingChunks || []).slice();
  const segments = new Map(); // segmentId -> row
  const results = new Map(); // jobId -> result row
  const followups = []; // ordered
  const synthesisPreviews = new Map(); // jobId -> preview
  let currentPlanIdByJob = new Map();
  let mergeClaimCalls = 0;
  let lastMergeLeaseMs = null;

  function rollupJobStatusOnResult(jobId, status) {
    const job = jobs.get(jobId);
    if (!job || job.status === 'canceled') return;
    const desired = status === 'complete' ? 'complete' : status === 'partial_failed' ? 'partial_failed' : 'failed';
    jobs.set(jobId, { ...job, status: desired, updatedAt: now(), completedAt: job.completedAt || now() });
  }

  return {
    jobs,
    abstracts,
    failedChunks,
    segments,
    results,
    followups,
    __setAbstracts(list) {
      abstracts.length = 0;
      list.forEach(item => abstracts.push(item));
    },
    async getJob(id) {
      return jobs.get(id) || null;
    },
    async updateJob(id, patch) {
      const job = jobs.get(id);
      if (!job) return null;
      const next = { ...job, ...patch, updatedAt: now() };
      jobs.set(id, next);
      return next;
    },
    async cancelJob(jobId, reason) {
      const job = jobs.get(jobId);
      if (!job) return null;
      const next = { ...job, status: 'canceled', currentPhase: 'canceled', errorMessage: reason || 'canceled', updatedAt: now() };
      jobs.set(jobId, next);
      return next;
    },
    async listDocumentAbstracts(jobId) {
      return abstracts
        .filter(a => (a.jobId || 'job_test_1') === jobId)
        .slice()
        .sort((a, b) => (a.chunkOrder ?? 0) - (b.chunkOrder ?? 0));
    },
    async listChunks(jobId) {
      return [
        ...abstracts.map(a => ({
          id: a.chunkId,
          documentId: a.documentId,
          chunkOrder: a.chunkOrder,
          originalFilename: a.originalFilename,
          abstractionStatus: 'completed',
          pageStart: a.pageStart,
          pageEnd: a.pageEnd,
          splitFrom: a.splitFrom,
          splitParentChunkId: a.splitParentChunkId,
          splitReason: a.splitReason,
        })),
        ...failedChunks.map(f => ({
          id: f.chunkId,
          documentId: f.documentId,
          chunkOrder: f.chunkOrder,
          originalFilename: f.originalFilename,
          abstractionStatus: 'failed',
          abstractionErrorType: f.errorType || 'provider_error',
          abstractionErrorMessage: f.errorMessage || 'failed',
          pageStart: f.pageStart,
          pageEnd: f.pageEnd,
        })),
        ...pendingChunks.map(p => ({
          id: p.chunkId,
          documentId: p.documentId,
          chunkOrder: p.chunkOrder,
          originalFilename: p.originalFilename,
          abstractionStatus: p.abstractionStatus || 'pending',
          abstractionErrorType: p.errorType || null,
          abstractionErrorMessage: p.errorMessage || null,
          pageStart: p.pageStart,
          pageEnd: p.pageEnd,
        })),
      ];
    },
    async saveSynthesisPlan(jobId, planInput) {
      const planId = planInput.planId;
      // Remove segments for other plans.
      for (const [id, segment] of segments.entries()) {
        if (segment.jobId === jobId && segment.planId !== planId) segments.delete(id);
      }
      currentPlanIdByJob.set(jobId, planId);
      const saved = [];
      for (const segment of planInput.segments) {
        const key = `${jobId}:${planId}:${segment.segmentIndex}`;
        const existing = [...segments.values()].find(s => s.jobId === jobId && s.planId === planId && s.segmentIndex === segment.segmentIndex);
        const id = existing?.id || `seg_${segment.segmentIndex}_${Math.random().toString(36).slice(2, 8)}`;
        const row = {
          id,
          jobId,
          planId,
          segmentIndex: segment.segmentIndex,
          startSequenceIndex: segment.startSequenceIndex,
          endSequenceIndex: segment.endSequenceIndex,
          documentIds: segment.documentIds.slice(),
          filenames: segment.filenames.slice(),
          estimatedBytes: segment.estimatedBytes ?? null,
          status: existing?.status || 'pending',
          attemptCount: existing?.attemptCount || 0,
          summaryText: existing?.summaryText || null,
          modelUsed: existing?.modelUsed || null,
          inputTokens: existing?.inputTokens || null,
          outputTokens: existing?.outputTokens || null,
          payloadBytes: existing?.payloadBytes || null,
          latencyMs: existing?.latencyMs || null,
          errorType: existing?.errorType || null,
          errorMessage: existing?.errorMessage || null,
          warnings: existing?.warnings || [],
          leaseExpiresAt: null,
          claimedAt: null,
          workerId: null,
          retryAt: null,
          createdAt: existing?.createdAt || now(),
          updatedAt: now(),
          completedAt: existing?.completedAt || null,
        };
        segments.set(id, row);
        saved.push(row);
      }
      return { planId, segments: saved };
    },
    async getCurrentSynthesisPlanId(jobId) {
      return currentPlanIdByJob.get(jobId) || null;
    },
    async listSynthesisSegments(jobId, planId) {
      const effectivePlanId = planId || currentPlanIdByJob.get(jobId);
      if (!effectivePlanId) return [];
      return [...segments.values()]
        .filter(s => s.jobId === jobId && s.planId === effectivePlanId)
        .sort((a, b) => a.segmentIndex - b.segmentIndex)
        .map(s => ({ ...s }));
    },
    async summarizeSynthesisSegments(jobId, planId) {
      const list = await this.listSynthesisSegments(jobId, planId);
      const counts = list.reduce((acc, segment) => {
        acc[segment.status] = (acc[segment.status] || 0) + 1;
        return acc;
      }, {});
      return {
        total: list.length,
        pending: counts.pending || 0,
        processing: counts.processing || 0,
        complete: counts.complete || 0,
        failed: counts.failed || 0,
        retry_wait: counts.retry_wait || 0,
      };
    },
    async listFailedChunks(jobId) {
      return (await this.listChunks(jobId)).filter(chunk => chunk.abstractionStatus === 'failed');
    },
    async listReadySynthesisSegments(jobId, planId, limit = 4) {
      const asOf = Date.now();
      return [...segments.values()]
        .filter(s => s.jobId === jobId && s.planId === planId)
        .filter(s => {
          if (s.status === 'pending') return true;
          if (s.status === 'retry_wait') {
            const retryAt = s.retryAt ? Date.parse(s.retryAt) : 0;
            return !retryAt || retryAt <= asOf;
          }
          if (s.status === 'processing') {
            const expires = s.leaseExpiresAt ? Date.parse(s.leaseExpiresAt) : 0;
            return !expires || expires <= asOf;
          }
          return false;
        })
        .sort((a, b) => a.segmentIndex - b.segmentIndex)
        .slice(0, limit)
        .map(s => ({ ...s }));
    },
    async claimSynthesisSegment(jobId, segmentId, options = {}) {
      const segment = segments.get(segmentId);
      if (!segment || segment.jobId !== jobId) return null;
      if (!['pending', 'retry_wait'].includes(segment.status) && segment.status !== 'processing') return null;
      const next = {
        ...segment,
        status: 'processing',
        attemptCount: (segment.attemptCount || 0) + 1,
        claimedAt: now(),
        leaseExpiresAt: new Date(Date.now() + (options.leaseMs || 120_000)).toISOString(),
        workerId: options.workerId || 'wkr_test',
        retryAt: null,
        errorType: null,
        errorMessage: null,
        updatedAt: now(),
      };
      segments.set(segmentId, next);
      return { ...next };
    },
    async completeSynthesisSegment(jobId, segmentId, payload) {
      const segment = segments.get(segmentId);
      if (!segment) return null;
      if (initialState.enforceWorkerLease && (!payload.workerId || segment.status !== 'processing' || segment.workerId !== payload.workerId)) {
        return null;
      }
      const next = {
        ...segment,
        status: 'complete',
        summaryText: payload.summaryText,
        modelUsed: payload.modelUsed,
        inputTokens: payload.inputTokens ?? null,
        outputTokens: payload.outputTokens ?? null,
        payloadBytes: payload.payloadBytes ?? null,
        latencyMs: payload.latencyMs ?? null,
        errorType: null,
        errorMessage: null,
        warnings: payload.warnings || [],
        claimedAt: null,
        leaseExpiresAt: null,
        workerId: null,
        retryAt: null,
        completedAt: now(),
        updatedAt: now(),
      };
      segments.set(segmentId, next);
      return { ...next };
    },
    async markSynthesisSegmentFailed(jobId, segmentId, failure) {
      const segment = segments.get(segmentId);
      if (!segment) return null;
      if (initialState.enforceWorkerLease && (!failure.workerId || segment.status !== 'processing' || segment.workerId !== failure.workerId)) {
        return null;
      }
      const next = {
        ...segment,
        status: 'failed',
        errorType: failure.errorType,
        errorMessage: failure.errorMessage,
        payloadBytes: failure.payloadBytes ?? segment.payloadBytes,
        latencyMs: failure.latencyMs ?? segment.latencyMs,
        modelUsed: failure.modelUsed ?? segment.modelUsed,
        claimedAt: null,
        leaseExpiresAt: null,
        workerId: null,
        retryAt: null,
        updatedAt: now(),
      };
      segments.set(segmentId, next);
      return { ...next };
    },
    async markSynthesisSegmentRetryWait(jobId, segmentId, failure) {
      const segment = segments.get(segmentId);
      if (!segment) return null;
      if (initialState.enforceWorkerLease && (!failure.workerId || segment.status !== 'processing' || segment.workerId !== failure.workerId)) {
        return null;
      }
      const next = {
        ...segment,
        status: 'retry_wait',
        errorType: failure.errorType,
        errorMessage: failure.errorMessage,
        retryAt: failure.retryAtIso,
        claimedAt: null,
        leaseExpiresAt: null,
        workerId: null,
        updatedAt: now(),
      };
      segments.set(segmentId, next);
      return { ...next };
    },
    async resetStaleSynthesisSegments(jobId, staleMs = 180_000) {
      const asOf = Date.now();
      const stale = [];
      for (const segment of [...segments.values()].filter(s => s.jobId === jobId && s.status === 'processing')) {
        const expires = segment.leaseExpiresAt ? Date.parse(segment.leaseExpiresAt) : 0;
        const updatedAt = segment.updatedAt ? Date.parse(segment.updatedAt) : 0;
        const isStale = (expires && expires <= asOf) || (!expires && updatedAt && (asOf - updatedAt) > staleMs);
        if (isStale) {
          const next = { ...segment, status: 'pending', claimedAt: null, leaseExpiresAt: null, workerId: null, updatedAt: now() };
          segments.set(segment.id, next);
          stale.push(next);
        }
      }
      return stale;
    },
    async resetFailedSynthesisSegments(jobId, planId) {
      const reset = [];
      for (const segment of [...segments.values()].filter(s => s.jobId === jobId && s.planId === planId && ['failed', 'retry_wait'].includes(s.status))) {
        const next = { ...segment, status: 'pending', errorType: null, errorMessage: null, retryAt: null, claimedAt: null, leaseExpiresAt: null, workerId: null, updatedAt: now() };
        segments.set(segment.id, next);
        reset.push(next);
      }
      return reset;
    },
    async saveJobResult(jobId, payload) {
      const id = `res_${jobId}`;
      const row = {
        id,
        jobId,
        planId: payload.planId,
        status: payload.status,
        finalTitleOpinion: payload.finalTitleOpinion,
        warnings: payload.warnings || [],
        failedDocuments: payload.failedDocuments || [],
        modelUsed: payload.modelUsed,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        payloadBytes: payload.payloadBytes,
        synthesisDurationMs: payload.synthesisDurationMs,
        generatedAt: now(),
      };
      results.set(jobId, row);
      rollupJobStatusOnResult(jobId, payload.status);
      return { ...row };
    },
    async getJobResult(jobId) {
      return results.has(jobId) ? { ...results.get(jobId) } : null;
    },
    async getJobResultMeta(jobId) {
      const result = results.get(jobId);
      if (!result) return null;
      return {
        jobId: result.jobId,
        planId: result.planId,
        status: result.status,
        modelUsed: result.modelUsed,
        generatedAt: result.generatedAt,
        hasOpinion: Boolean(result.finalTitleOpinion),
      };
    },
    async clearJobResult(jobId) {
      return results.delete(jobId);
    },
    async setSynthesisPreview(jobId, patch = {}) {
      const text = typeof patch.text === 'string' ? patch.text : '';
      const preview = {
        text,
        complete: Boolean(patch.complete),
        bytesReceived: Number.isFinite(Number(patch.bytesReceived)) ? Number(patch.bytesReceived) : text.length,
        updatedAt: now(),
      };
      synthesisPreviews.set(jobId, preview);
      return { ...preview };
    },
    async getSynthesisPreview(jobId) {
      const preview = synthesisPreviews.get(jobId);
      if (!preview) return { text: '', complete: false, bytesReceived: 0, updatedAt: null };
      return { ...preview };
    },
    async clearSynthesisPreview(jobId) {
      return synthesisPreviews.delete(jobId);
    },
    async claimSynthesisMerge(jobId, planId, options = {}) {
      mergeClaimCalls += 1;
      lastMergeLeaseMs = options.leaseMs || 120_000;
      if (initialState.mergeClaimResult === false) return null;
      return {
        jobId,
        planId,
        workerId: options.workerId || 'wkr_merge_test',
        leaseExpiresAt: new Date(Date.now() + (options.leaseMs || 120_000)).toISOString(),
      };
    },
    __mergeClaimCalls() {
      return mergeClaimCalls;
    },
    __lastMergeLeaseMs() {
      return lastMergeLeaseMs;
    },
    async appendFollowupMessage(jobId, payload) {
      const id = `flw_${followups.length + 1}`;
      const row = {
        id,
        jobId,
        question: payload.question,
        answer: payload.answer,
        modelUsed: payload.modelUsed,
        inputTokens: payload.inputTokens,
        outputTokens: payload.outputTokens,
        payloadBytes: payload.payloadBytes,
        retrievedDocumentIds: payload.retrievedDocumentIds || [],
        truncationWarning: payload.truncationWarning || null,
        createdAt: now(),
      };
      followups.push(row);
      return { ...row };
    },
    async listFollowupMessages(jobId, limit = 50) {
      return followups
        .filter(f => f.jobId === jobId)
        .slice(0, limit)
        .map(f => ({ ...f }));
    },
    async getSynthesisStatus(jobId, options = {}) {
      const planId = currentPlanIdByJob.get(jobId);
      const lightweight = options.lightweight !== false;
      const includeSegments = options.includeSegments === true;
      const includeResult = options.includeResult === true;
      const counts = planId
        ? await this.summarizeSynthesisSegments(jobId, planId)
        : { total: 0, pending: 0, processing: 0, complete: 0, failed: 0, retry_wait: 0 };
      const list = includeSegments && planId ? await this.listSynthesisSegments(jobId, planId) : [];
      const result = includeResult ? await this.getJobResult(jobId) : null;
      const resultMeta = lightweight && !includeResult ? await this.getJobResultMeta(jobId) : null;
      return {
        job: await this.getJob(jobId),
        planId,
        total: counts.total,
        pending: counts.pending,
        processing: counts.processing,
        complete: counts.complete,
        failed: counts.failed,
        retry_wait: counts.retry_wait,
        mergeInProgress: false,
        segments: list,
        hasResult: result
          ? Boolean(result.finalTitleOpinion)
          : Boolean(resultMeta?.hasOpinion),
        result,
        resultMeta,
      };
    },
  };
}

function manyAbstracts(count, opts = {}) {
  return Array.from({ length: count }, (_, i) => makeAbstract({
    chunkId: `chk_${String(i + 1).padStart(3, '0')}`,
    documentId: `doc_${String(i + 1).padStart(3, '0')}`,
    chunkOrder: i,
    originalFilename: `doc_${i + 1}.pdf`,
    abstractText: (opts.abstractTextFor && opts.abstractTextFor(i))
      || `DOC TYPE: Deed\nGRANTOR: Person ${i + 1}\nGRANTEE: Person ${i + 2}\nFRACTION CONVEYED: 1/4`,
  }));
}

function goodSegmentSummary(idx) {
  return [
    '## CHAIN ROWS',
    '| Date | Doc Type | Recording Ref | Grantor | Grantee | Interest Conveyed | Running Balance | Flags |',
    `| 1900 | Deed | Vol 1 p 2 | Person ${idx + 1} | Person ${idx + 2} | 1/4 mineral | 1/4 | |`,
    '## DEFECTS',
    '| Issue | Curative Needed | Source Doc |',
    '| none | | |',
    '## RUNNING BALANCE',
    '| Owner/Interest | Mineral Balance | Notes |',
    `| Person ${idx + 2} | 1/4 | end of segment ${idx + 1} |`,
    'x'.repeat(220),
  ].join('\n');
}

function goodFinalOpinion(noteWarnings = '') {
  return [
    '## CHAIN OF TITLE',
    'Chronological chain has been reconstructed for the subject tract with running fractional balances.',
    '## MINERAL INTEREST CALCULATION',
    '| Owner | Mineral Interest |',
    '| Person | 1/4 |',
    '## TITLE DEFECTS & CURATIVE REQUIREMENTS',
    'No outstanding curative items identified beyond the noted exclusions.',
    '## FINAL OWNERSHIP DETERMINATION',
    '| Owner | Mineral Interest | Royalty/NPRI | Subject To | Notes |',
    '| Final Owner | 1/4 | none | none | as determined from the chain |',
    '## OPINION QUALIFICATIONS',
    'This is an AI-assisted analytical aid and is not a formal title opinion. Verify with counsel.',
    noteWarnings,
    'x'.repeat(600),
  ].join('\n');
}

// --- Tests ------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('Ordering: chunk order preserved and failed abstracts excluded from segment plan', async () => {
  const abstracts = [
    makeAbstract({ chunkId: 'chk_2', chunkOrder: 1, originalFilename: 'B.pdf', abstractText: 'BBBBB' }),
    makeAbstract({ chunkId: 'chk_1', chunkOrder: 0, originalFilename: 'A.pdf', abstractText: 'AAAAA' }),
  ];
  const store = createMemoryPhase5Store({ abstracts });
  const planInput = await store.listDocumentAbstracts('job_test_1');
  assert(planInput.map(a => a.chunkId).join(',') === 'chk_1,chk_2', 'Expected sorted by chunkOrder');
  // failed abstract should be omitted (abstractText empty)
  const mixed = [
    ...planInput,
    { chunkId: 'chk_3', chunkOrder: 2, originalFilename: 'C.pdf', abstractText: '' },
  ];
  const ok = mixed.filter(a => (a.abstractText || '').trim().length > 0);
  assert(ok.length === 2, 'Expected failed abstract excluded');
});

test('groupAbstractsByDocument preserves single chunk abstracts unchanged', () => {
  const grouped = groupAbstractsByDocument([
    makeAbstract({
      chunkId: 'chk_single',
      documentId: 'doc_single',
      sourceFilename: 'Single Source.pdf',
      abstractText: 'single chunk abstract',
    }),
  ]);

  assert(grouped.length === 1, `Expected one grouped document, got ${grouped.length}`);
  assert(grouped[0].documentId === 'doc_single', 'Expected source document ID');
  assert(grouped[0].filename === 'Single Source.pdf', 'Expected canonical source filename');
  assert(grouped[0].abstract === 'single chunk abstract', 'Expected single chunk abstract to pass through unchanged');
  assert(grouped[0].chunkIds.join(',') === 'chk_single', 'Expected chunk provenance to be retained');
  assert(!Object.hasOwn(grouped[0], 'chunkId'), 'Grouped document should not expose a top-level chunkId');
});

test('groupAbstractsByDocument merges split chunks with page headings in stable order', () => {
  const grouped = groupAbstractsByDocument([
    makeAbstract({
      chunkId: 'chk_2',
      documentId: 'doc_split',
      chunkOrder: 1,
      pageStart: 13,
      pageEnd: 24,
      sourceFilename: 'Split Source.pdf',
      abstractText: 'second chunk abstract',
      createdAt: '2026-05-23T00:00:02.000Z',
    }),
    makeAbstract({
      chunkId: 'chk_1',
      documentId: 'doc_split',
      chunkOrder: 0,
      pageStart: 1,
      pageEnd: 12,
      sourceFilename: 'Split Source.pdf',
      abstractText: 'first chunk abstract',
      createdAt: '2026-05-23T00:00:01.000Z',
    }),
  ]);

  assert(grouped.length === 1, `Expected one grouped document, got ${grouped.length}`);
  assert(grouped[0].chunkIds.join(',') === 'chk_1,chk_2', 'Expected chunk IDs in sorted order');
  assert(grouped[0].abstract.includes('**Pages 1-12:**\n\nfirst chunk abstract'), 'Expected first page range heading');
  assert(grouped[0].abstract.includes('**Pages 13-24:**\n\nsecond chunk abstract'), 'Expected second page range heading');
  assert(grouped[0].abstract.indexOf('first chunk abstract') < grouped[0].abstract.indexOf('second chunk abstract'), 'Expected chunk order to be stable');
});

test('groupAbstractsByDocument falls back to chunk grouping and chunk headings', () => {
  const grouped = groupAbstractsByDocument([
    makeAbstract({
      chunkId: 'chk_orphan_1',
      documentId: null,
      chunkOrder: 0,
      abstractText: 'first orphan abstract',
    }),
    makeAbstract({
      chunkId: 'chk_orphan_2',
      documentId: null,
      chunkOrder: 1,
      abstractText: 'second orphan abstract',
    }),
    makeAbstract({
      chunkId: 'chk_missing_pages_1',
      documentId: 'doc_missing_pages',
      chunkOrder: 0,
      sourceFilename: 'Missing Pages.pdf',
      abstractText: 'first missing-pages abstract',
    }),
    makeAbstract({
      chunkId: 'chk_missing_pages_2',
      documentId: 'doc_missing_pages',
      chunkOrder: 1,
      sourceFilename: 'Missing Pages.pdf',
      abstractText: 'second missing-pages abstract',
    }),
  ]);

  assert(grouped.length === 3, `Expected orphan chunks plus grouped split doc, got ${grouped.length}`);
  assert(grouped[0].id === 'chk_orphan_1', 'Expected orphan fallback ID to use chunk ID');
  assert(grouped[0].chunkIds.join(',') === 'chk_orphan_1', 'Expected first orphan to remain separate');
  assert(grouped[1].id === 'chk_orphan_2', 'Expected second orphan fallback ID to use chunk ID');
  assert(grouped[1].chunkIds.join(',') === 'chk_orphan_2', 'Expected second orphan to remain separate');
  assert(grouped[2].id === 'doc_missing_pages', 'Expected grouped document ID to be usable as fallback ID');
  assert(grouped[2].abstract.includes('**Chunk 1:**\n\nfirst missing-pages abstract'), 'Expected missing page range to use chunk heading');
  assert(grouped[2].abstract.includes('**Chunk 2:**\n\nsecond missing-pages abstract'), 'Expected second missing page range to use chunk heading');
});

test('buildSynthesisChunks respects 120-doc cap and byte cap', () => {
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  const previousChunkSize = process.env.SYNTHESIS_CHUNK_SIZE;
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  process.env.SYNTHESIS_CHUNK_SIZE = '120';
  const small = Array.from({ length: 250 }, (_, i) => ({ filename: `d${i}.pdf`, abstract: 'small abstract' }));
  const chunks = buildSynthesisChunks(small, '', '', 'pre', SYNTHESIS_PROMPT);
  assert(chunks.length >= 2, 'Expected multiple chunks at >120 docs');
  assert(chunks[0].length === 120, 'Expected first chunk capped at 120');
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
  if (previousChunkSize === undefined) delete process.env.SYNTHESIS_CHUNK_SIZE;
  else process.env.SYNTHESIS_CHUNK_SIZE = previousChunkSize;
  // Single huge abstract gets its own chunk (b > safe envelope means [a,b] and [b,c] both blow budget).
  const big = [
    { filename: 'a.pdf', abstract: 'a'.repeat(10) },
    { filename: 'b.pdf', abstract: 'x'.repeat(13_000_000) },
    { filename: 'c.pdf', abstract: 'short' },
  ];
  const bigChunks = buildSynthesisChunks(big, '', '', 'pre', SYNTHESIS_PROMPT);
  assert(bigChunks.some(c => c.length === 1 && c[0].filename === 'b.pdf'), 'Expected oversized abstract in its own chunk');
});

test('planSynthesisSegments produces stable planId for same inputs', () => {
  const abstracts = manyAbstracts(8);
  const plan1 = planSynthesisSegments(abstracts, 'Tract A', 'Notes');
  const planId1 = computePlanId({ jobId: 'job_test_1', tract: 'Tract A', contextNotes: 'Notes', documentIds: abstracts.map(a => a.chunkId) });
  const planId2 = computePlanId({ jobId: 'job_test_1', tract: 'Tract A', contextNotes: 'Notes', documentIds: abstracts.map(a => a.chunkId) });
  assert(planId1 === planId2, 'Expected stable planId');
  // Different document set -> different planId
  const planId3 = computePlanId({ jobId: 'job_test_1', tract: 'Tract A', contextNotes: 'Notes', documentIds: abstracts.slice(0, 5).map(a => a.chunkId) });
  assert(planId3 !== planId1, 'Expected different planId when documents change');
  assert(plan1.segments.length >= 1, 'Expected at least one segment');
});

test('computePlanId changes when abstract content changes', () => {
  const base = { jobId: 'job_test_1', tract: 'Tract A', contextNotes: 'Notes', documentIds: ['chk_1'] };
  const planId1 = computePlanId({ ...base, abstractDigests: ['first abstract version'] });
  const planId2 = computePlanId({ ...base, abstractDigests: ['updated abstract version'] });
  assert(planId1 !== planId2, 'Expected planId to change when abstract content changes');
});

test('planJobSynthesis groups split chunks and stores source document IDs', async () => {
  const abstracts = [
    makeAbstract({
      chunkId: 'chk_split_1',
      documentId: 'doc_split',
      chunkOrder: 0,
      pageStart: 1,
      pageEnd: 10,
      sourceFilename: 'Split Source.pdf',
      abstractText: 'split abstract one',
    }),
    makeAbstract({
      chunkId: 'chk_split_2',
      documentId: 'doc_split',
      chunkOrder: 1,
      pageStart: 11,
      pageEnd: 20,
      sourceFilename: 'Split Source.pdf',
      abstractText: 'split abstract two',
    }),
    makeAbstract({
      chunkId: 'chk_single',
      documentId: 'doc_single',
      chunkOrder: 2,
      sourceFilename: 'Single Source.pdf',
      abstractText: 'single abstract',
    }),
  ];
  const store = createMemoryPhase5Store({ abstracts });

  const { plan, abstracts: plannedAbstracts } = await planJobSynthesis('job_test_1', { store });

  assert(plannedAbstracts.length === 2, `Expected 2 grouped abstracts, got ${plannedAbstracts.length}`);
  assert(plannedAbstracts[0].documentId === 'doc_split', 'Expected split document first');
  assert(plannedAbstracts[0].abstract.includes('**Pages 1-10:**'), 'Expected grouped split abstract to include first page range');
  assert(plannedAbstracts[0].abstract.includes('**Pages 11-20:**'), 'Expected grouped split abstract to include second page range');
  assert(plannedAbstracts[1].abstract === 'single abstract', 'Expected single document abstract to pass through');
  assert(plan.segments[0].documentIds.join(',') === 'doc_split,doc_single', `Expected source document IDs, got ${plan.segments[0].documentIds.join(',')}`);
});

test('planJobSynthesis rejects pending abstraction chunks', async () => {
  const store = createMemoryPhase5Store({
    abstracts: manyAbstracts(1),
    pendingChunks: [{
      chunkId: 'chk_pending',
      documentId: 'doc_pending',
      chunkOrder: 1,
      originalFilename: 'pending.pdf',
      abstractionStatus: 'processing',
    }],
  });

  let rejected = false;
  try {
    await planJobSynthesis('job_test_1', { store });
  } catch (err) {
    rejected = err.statusCode === 409 && /abstraction/i.test(err.message);
  }
  assert(rejected, 'Expected synthesis planning to reject incomplete abstraction work');
});

test('processSynthesisSegment resolves grouped abstracts by document ID', async () => {
  const store = createMemoryPhase5Store({ abstracts: [] });
  const segment = {
    id: 'seg_grouped',
    jobId: 'job_test_1',
    planId: 'plan_grouped',
    segmentIndex: 0,
    startSequenceIndex: 0,
    endSequenceIndex: 0,
    documentIds: ['doc_grouped'],
    filenames: ['Grouped Source.pdf'],
    status: 'pending',
    attemptCount: 0,
  };
  store.segments.set(segment.id, segment);

  let promptContent = '';
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    promptContent = request.messages[0].content;
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };

  const result = await processSynthesisSegment('job_test_1', segment, [{
    documentId: 'doc_grouped',
    filename: 'Grouped Source.pdf',
    abstract: 'grouped source abstract',
    chunkIds: ['chk_1', 'chk_2'],
  }], {
    store,
    workerId: 'wkr_grouped',
    singlePass: true,
  });

  assert(result.status === 'complete', `Expected grouped segment to complete, got ${result.status}`);
  assert(promptContent.includes('Grouped Source.pdf'), 'Expected grouped source filename in synthesis prompt');
  assert(promptContent.includes('grouped source abstract'), 'Expected grouped abstract in synthesis prompt');
});

test('processSynthesisSegment resolves legacy chunk IDs against grouped chunkIds', async () => {
  const store = createMemoryPhase5Store({ abstracts: [] });
  const segment = {
    id: 'seg_legacy_chunk',
    jobId: 'job_test_1',
    planId: 'plan_legacy_chunk',
    segmentIndex: 0,
    startSequenceIndex: 0,
    endSequenceIndex: 0,
    documentIds: ['chk_legacy_1'],
    filenames: ['Grouped Legacy.pdf'],
    status: 'pending',
    attemptCount: 0,
  };
  store.segments.set(segment.id, segment);

  let promptContent = '';
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    promptContent = request.messages[0].content;
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };

  const result = await processSynthesisSegment('job_test_1', segment, [{
    id: 'doc_legacy',
    documentId: 'doc_legacy',
    filename: 'Grouped Legacy.pdf',
    abstract: 'legacy grouped abstract',
    chunkIds: ['chk_legacy_1', 'chk_legacy_2'],
  }], {
    store,
    workerId: 'wkr_legacy',
    singlePass: true,
  });

  assert(result.status === 'complete', `Expected legacy chunk segment to complete, got ${result.status}`);
  assert(promptContent.includes('legacy grouped abstract'), 'Expected grouped abstract resolved by legacy chunk ID');
});

test('processSynthesisSegment deduplicates legacy chunk IDs from one grouped document', async () => {
  const store = createMemoryPhase5Store({ abstracts: [] });
  const segment = {
    id: 'seg_legacy_duplicate_chunks',
    jobId: 'job_test_1',
    planId: 'plan_legacy_duplicate_chunks',
    segmentIndex: 0,
    startSequenceIndex: 0,
    endSequenceIndex: 1,
    documentIds: ['chk_legacy_1', 'chk_legacy_2'],
    filenames: ['Grouped Legacy.pdf', 'Grouped Legacy.pdf'],
    status: 'pending',
    attemptCount: 0,
  };
  store.segments.set(segment.id, segment);

  let promptContent = '';
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    promptContent = request.messages[0].content;
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };

  const result = await processSynthesisSegment('job_test_1', segment, [{
    id: 'doc_legacy',
    documentId: 'doc_legacy',
    filename: 'Grouped Legacy.pdf',
    abstract: 'legacy grouped abstract',
    chunkIds: ['chk_legacy_1', 'chk_legacy_2'],
  }], {
    store,
    workerId: 'wkr_legacy_dedupe',
    singlePass: true,
  });

  assert(result.status === 'complete', `Expected legacy chunk segment to complete, got ${result.status}`);
  assert((promptContent.match(/legacy grouped abstract/g) || []).length === 1, 'Expected grouped abstract to appear once');
  assert(!/Document 2:\s+Grouped Legacy\.pdf/.test(promptContent), 'Expected no duplicate document heading for the same grouped source');
});

test('Single-pass synthesis: ≤50 ok abstracts → one synthesis call yields title opinion', async () => {
  const abstracts = manyAbstracts(5);
  const store = createMemoryPhase5Store({ abstracts });
  let calls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    calls += 1;
    assert(request.system === SYNTHESIS_PROMPT, 'Single-pass should use SYNTHESIS_PROMPT');
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 800 } };
  };
  const result = await processSynthesisJob('job_test_1', { store });
  assert(calls === 1, `Expected one model call, got ${calls}`);
  assert(result.result?.finalTitleOpinion.includes('CHAIN OF TITLE'), 'Expected stored final opinion');
  assert(result.result.status === 'complete', `Expected complete status, got ${result.result.status}`);
  const job = await store.getJob('job_test_1');
  assert(job.status === 'complete', `Expected job complete, got ${job.status}`);
});

test('SYNTHESIS_PROMPT uses table format for chain of title', () => {
  assert(
    SYNTHESIS_PROMPT.includes('## CHAIN OF TITLE'),
    'SYNTHESIS_PROMPT must include CHAIN OF TITLE heading',
  );
  assert(
    /\| # \| Date \| Doc Type \| Recording Ref \| Grantor \| Grantee \| Interest Conveyed \| Running Balance \| Flags \|/.test(SYNTHESIS_PROMPT),
    'SYNTHESIS_PROMPT must include the full chain-of-title table header',
  );
  assert(
    SYNTHESIS_PROMPT.includes('Reconciled Interest'),
    'SYNTHESIS_PROMPT must include Reconciled Interest column',
  );
  assert(
    SYNTHESIS_PROMPT.includes('AI-assisted analytical aid'),
    'SYNTHESIS_PROMPT must include the AI-disclaimer text verbatim',
  );
});

test('Synthesis segment stale worker cannot overwrite a reclaimed segment', async () => {
  const abstracts = manyAbstracts(1);
  const store = createMemoryPhase5Store({ abstracts, enforceWorkerLease: true });
  const { plan } = await planJobSynthesis('job_test_1', { store });
  const segment = plan.segments[0];
  let raced = false;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => {
    if (!raced) {
      raced = true;
      const current = store.segments.get(segment.id);
      store.segments.set(segment.id, {
        ...current,
        status: 'complete',
        summaryText: goodFinalOpinion('new worker result'),
        workerId: null,
        leaseExpiresAt: null,
        completedAt: new Date().toISOString(),
      });
    }
    return { text: goodFinalOpinion('stale worker result'), model: 'claude-sonnet-4-6', usage: {} };
  };

  const result = await processSynthesisSegment('job_test_1', segment, abstracts, {
    store,
    workerId: 'wkr_old',
    singlePass: true,
    config: { maxAttempts: 1 },
  });

  const finalSegment = (await store.listSynthesisSegments('job_test_1', plan.planId))[0];
  assert(result.status === 'stale', `Expected stale segment writer to be skipped, got ${result.status}`);
  assert(finalSegment.summaryText.includes('new worker result'), 'Expected newer segment summary to remain intact');
});

test('Invalid single-pass model output fails instead of persisting a complete result', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1) });
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => ({
    text: 'too short',
    model: 'claude-sonnet-4-6',
    usage: {},
  });

  const result = await processSynthesisJob('job_test_1', {
    store,
    budgetMs: 30_000,
    config: { maxAttempts: 1 },
  });

  assert(result.result?.status === 'failed', `Expected invalid output to save failed result, got ${result.result?.status}`);
  assert(!result.result.finalTitleOpinion, 'Expected invalid final opinion not to be persisted');
  const segments = await store.listSynthesisSegments('job_test_1', result.planId);
  assert(segments[0].status === 'failed', `Expected segment failed, got ${segments[0].status}`);
  assert(segments[0].errorType === 'validation_failed', `Expected validation_failed, got ${segments[0].errorType}`);
});

test('Multi-segment: 250 abstracts → segments + merge with checkpoints written', async () => {
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  const previousChunkSize = process.env.SYNTHESIS_CHUNK_SIZE;
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  process.env.SYNTHESIS_CHUNK_SIZE = '120';
  const abstracts = manyAbstracts(250);
  const store = createMemoryPhase5Store({ abstracts });
  let segmentCalls = 0;
  let mergeCalls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      segmentCalls += 1;
      return { text: goodSegmentSummary(segmentCalls - 1), model: 'claude-sonnet-4-6', usage: { input_tokens: 500, output_tokens: 400 } };
    }
    if (request.system === SYNTHESIS_PROMPT) {
      mergeCalls += 1;
      return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: { input_tokens: 800, output_tokens: 1200 } };
    }
    throw new Error('unexpected system prompt');
  };
  const result = await processSynthesisJob('job_test_1', { store, budgetMs: 30_000 });
  assert(segmentCalls === 3, `Expected 3 partial syntheses for 250/120, got ${segmentCalls}`);
  assert(mergeCalls === 1, `Expected one final merge call, got ${mergeCalls}`);
  const segments = await store.listSynthesisSegments('job_test_1');
  assert(segments.length === 3, `Expected 3 segments stored, got ${segments.length}`);
  assert(segments.every(s => s.status === 'complete'), 'Expected all segments complete');
  assert(result.result?.status === 'complete', `Expected complete status, got ${result.result?.status}`);
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
  if (previousChunkSize === undefined) delete process.env.SYNTHESIS_CHUNK_SIZE;
  else process.env.SYNTHESIS_CHUNK_SIZE = previousChunkSize;
});

test('Final merge claim lease exceeds upstream model timeout by default', async () => {
  const abstracts = manyAbstracts(120);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      return { text: goodSegmentSummary(0), model: 'claude-sonnet-4-6', usage: {} };
    }
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };

  await processSynthesisJob('job_test_1', { store, budgetMs: 30_000 });

  const defaultModelTimeoutMs = 240_000;
  assert(store.__lastMergeLeaseMs() > defaultModelTimeoutMs, `Expected merge lease ${store.__lastMergeLeaseMs()} to exceed model timeout ${defaultModelTimeoutMs}`);
});

test('Final merge honors single-writer claim and skips merge when claim is unavailable', async () => {
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  const abstracts = manyAbstracts(250);
  const store = createMemoryPhase5Store({ abstracts, mergeClaimResult: false });
  let segmentCalls = 0;
  let mergeCalls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      segmentCalls += 1;
      return { text: goodSegmentSummary(segmentCalls - 1), model: 'claude-sonnet-4-6', usage: {} };
    }
    mergeCalls += 1;
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };

  const result = await processSynthesisJob('job_test_1', { store, budgetMs: 30_000 });

  assert(store.__mergeClaimCalls() >= 1, 'Expected final merge claim to be attempted');
  assert(mergeCalls === 0, `Expected no merge call without claim, got ${mergeCalls}`);
  assert(!result.result, 'Expected no final result when merge claim is unavailable');
  assert(result.hasMore === true, 'Expected caller to keep polling when another worker owns final merge');
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
});

test('Final merge error persists failed result instead of leaving no-result terminal state', async () => {
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  const abstracts = manyAbstracts(250);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      return { text: goodSegmentSummary(0), model: 'claude-sonnet-4-6', usage: {} };
    }
    const err = new Error('merge provider failure');
    err.status = 500;
    throw err;
  };

  const result = await processSynthesisJob('job_test_1', {
    store,
    budgetMs: 30_000,
    config: { maxAttempts: 1 },
  });

  assert(result.result?.status === 'failed', `Expected failed result, got ${result.result?.status}`);
  assert(result.result.warnings.some(w => /final_merge_failed/i.test(w)), `Expected final merge warning, got ${JSON.stringify(result.result?.warnings)}`);
  assert(result.hasMore === false, 'Expected terminal failed result rather than polling a no-result state');
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
});

test('Partial job: failed abstract omitted; warnings list excluded documents', async () => {
  const abstracts = manyAbstracts(3);
  const failedChunks = [{
    chunkId: 'chk_fail',
    documentId: 'doc_fail',
    chunkOrder: 3,
    originalFilename: 'missing.pdf',
    errorType: 'provider_error',
    errorMessage: 'failed during abstraction',
  }];
  const store = createMemoryPhase5Store({ abstracts, failedChunks });
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => ({
    text: goodFinalOpinion(),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  const result = await processSynthesisJob('job_test_1', { store });
  assert(result.result?.status === 'partial_failed', `Expected partial_failed, got ${result.result?.status}`);
  assert(result.result.failedDocuments.some(f => f.chunkId === 'chk_fail'), 'Expected failed chunk listed');
  assert(result.result.warnings.some(w => /excluded/i.test(w)), `Expected exclusion warning, got ${JSON.stringify(result.result.warnings)}`);
});

test('Split-degraded documents produce final result warnings even when all chunks succeed', async () => {
  const abstracts = [
    makeAbstract({
      chunkId: 'chk_split_left',
      documentId: 'doc_deed',
      chunkOrder: 0,
      originalFilename: 'Deed (pp 1-2).pdf',
      splitFrom: 'Deed.pdf',
      splitParentChunkId: 'chk_parent',
      splitReason: 'payload_too_large',
      pageStart: 1,
      pageEnd: 2,
      abstractText: 'DOC TYPE: Deed\nGRANTOR: A\nGRANTEE: B\nFRACTION CONVEYED: 1/2',
    }),
    makeAbstract({
      chunkId: 'chk_split_right',
      documentId: 'doc_deed',
      chunkOrder: 0,
      originalFilename: 'Deed (pp 3-4).pdf',
      splitFrom: 'Deed.pdf',
      splitParentChunkId: 'chk_parent',
      splitReason: 'payload_too_large',
      pageStart: 3,
      pageEnd: 4,
      abstractText: 'DOC TYPE: Deed\nGRANTOR: A\nGRANTEE: B\nFRACTION CONVEYED: 1/2',
    }),
  ];
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => ({
    text: goodFinalOpinion(),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  const result = await processSynthesisJob('job_test_1', { store });

  assert(result.result?.status === 'complete', `Expected complete result, got ${result.result?.status}`);
  assert(result.result.failedDocuments.length === 0, 'Expected no failed documents');
  assert(result.result.warnings.some(w => /page-range segments/i.test(w) && /Deed\.pdf/.test(w)), `Expected split degradation warning, got ${JSON.stringify(result.result.warnings)}`);
  assert(result.result.warnings.some(w => /clause continuity|legal descriptions|exhibits/i.test(w)), 'Expected legal continuity warning language');
  assert(!result.result.warnings.some(w => /instrument separation/i.test(w)), 'Split warning should not mention multi-instrument separation');
});

test('Segment timeout triggers binary split retry', async () => {
  // Force a 504 on the first segment call so we hit the binary split path.
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  const abstracts = manyAbstracts(250);
  const store = createMemoryPhase5Store({ abstracts });
  let segmentCalls = 0;
  let mergeCalls = 0;
  let timeoutTriggered = false;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      segmentCalls += 1;
      // First call hits a 504 once on the largest input
      if (!timeoutTriggered) {
        timeoutTriggered = true;
        const err = new Error('Timeout error (HTTP 504): synthetic test');
        err.status = 504;
        throw err;
      }
      return { text: goodSegmentSummary(segmentCalls - 1), model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } };
    }
    mergeCalls += 1;
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const result = await processSynthesisJob('job_test_1', { store, budgetMs: 30_000 });
  assert(timeoutTriggered, 'Expected a 504 to be issued');
  assert(result.result?.status === 'complete', `Expected complete after split, got ${result.result?.status}`);
  assert(segmentCalls > 2, `Expected extra calls from binary split; saw ${segmentCalls}`);
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
});

test('Merge too large triggers tree merge of segment summaries', async () => {
  // Force tree merge by making segment summaries huge so the merge call would exceed budget.
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  const previousCompaction = process.env.SYNTHESIS_COMPACTION_ENABLED;
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  process.env.SYNTHESIS_COMPACTION_ENABLED = 'false';
  const abstracts = manyAbstracts(250);
  const store = createMemoryPhase5Store({ abstracts });
  let mergeCalls = 0;
  let treeMergeCalls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      // Two cases: original segment work or tree-merge partials. Both are PARTIAL.
      const userText = request.messages[0].content;
      if (/Merge these two adjacent partial chain-of-title segments/.test(userText)) {
        treeMergeCalls += 1;
        return {
          text: 'consolidated segment summary ' + treeMergeCalls + '\nChain summary preserved across segments.' + 'x'.repeat(220),
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      }
      // Original segment: return a huge summary so the merge step blows past budget
      const big = 'a'.repeat(5_000_000);
      return { text: 'CHAIN big section ' + big, model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } };
    }
    mergeCalls += 1;
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } };
  };
  const result = await processSynthesisJob('job_test_1', { store, budgetMs: 30_000 });
  assert(treeMergeCalls > 0, `Expected tree-merge to run, got ${treeMergeCalls}`);
  assert(result.result?.status === 'complete', `Expected complete after tree merge, got ${result.result?.status}`);
  assert(result.result.warnings.some(w => w === 'merge_tree_applied'), `Expected merge_tree_applied warning, got ${JSON.stringify(result.result.warnings)}`);
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
  if (previousCompaction === undefined) delete process.env.SYNTHESIS_COMPACTION_ENABLED;
  else process.env.SYNTHESIS_COMPACTION_ENABLED = previousCompaction;
});

test('Resume: completed segments are not re-run on a second process pass', async () => {
  const abstracts = manyAbstracts(120);
  const store = createMemoryPhase5Store({ abstracts });
  let pass = 0;
  let totalCalls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    totalCalls += 1;
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      if (pass === 0 && totalCalls >= 2) {
        // Simulate worker death after first segment completes - throw to break the loop.
        const err = new Error('synthetic worker crash');
        err.status = 500;
        throw err;
      }
      return { text: goodSegmentSummary(totalCalls), model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } };
    }
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: 1 } };
  };
  // First pass: complete 1 segment, then "crash" causes others to fail.
  await processSynthesisJob('job_test_1', { store, budgetMs: 30_000, config: { maxAttempts: 1 } }).catch(() => {});
  const after1 = await store.listSynthesisSegments('job_test_1');
  const completedAfter1 = after1.filter(s => s.status === 'complete').length;
  assert(completedAfter1 >= 1, 'Expected at least one segment complete after crash');
  // Reset failed segments to pending so the second pass picks them up.
  const currentPlanId = await store.getCurrentSynthesisPlanId('job_test_1');
  await store.resetFailedSynthesisSegments('job_test_1', currentPlanId);
  pass = 1;
  // Second pass: only the remaining segments should be called; total calls should be limited.
  const callsBeforePass2 = totalCalls;
  await processSynthesisJob('job_test_1', { store, budgetMs: 30_000 });
  const callsAfterPass2 = totalCalls;
  const segmentsCount = (await store.listSynthesisSegments('job_test_1')).length;
  // Pass 2 should not redo completed segments: pass2 calls < remaining segments + merge*2
  assert(callsAfterPass2 - callsBeforePass2 <= segmentsCount, `Expected at most ${segmentsCount} model calls in pass 2, got ${callsAfterPass2 - callsBeforePass2}`);
  const finalSegments = await store.listSynthesisSegments('job_test_1');
  assert(finalSegments.every(s => s.status === 'complete'), 'Expected all segments complete after resume');
});

test('Synthesis retryable errors schedule durable retry_wait instead of terminal failure', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1) });
  let calls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => {
    calls += 1;
    const err = new Error('rate limit');
    err.status = 429;
    err.retryAfterMs = 1;
    throw err;
  };

  const result = await processSynthesisJob('job_test_1', {
    store,
    budgetMs: 30_000,
    config: { maxAttempts: 2 },
  });
  const segments = await store.listSynthesisSegments('job_test_1');

  assert(calls === 1, `Expected one model call before durable backoff, got ${calls}`);
  assert(result.retryScheduledInBatch === 1, `Expected one retry_wait segment, got ${result.retryScheduledInBatch}`);
  assert(segments[0].status === 'retry_wait', `Expected segment retry_wait, got ${segments[0].status}`);
  assert(!result.result, 'Retry-waiting synthesis should not persist a terminal result');
});

test('Mixed synthesis segment failures persist partial_failed result instead of stranding the job', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(2) });
  let partialCalls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      partialCalls += 1;
      if (partialCalls === 1) {
        return { text: goodSegmentSummary(0), model: 'claude-sonnet-4-6', usage: {} };
      }
      const err = new Error('bad segment');
      err.status = 400;
      throw err;
    }
    return { text: goodFinalOpinion('One synthesis segment failed.'), model: 'claude-sonnet-4-6', usage: {} };
  };

  const result = await processSynthesisJob('job_test_1', {
    store,
    budgetMs: 30_000,
    config: { chunkSize: 1, maxAttempts: 1 },
  });

  assert(result.result?.status === 'partial_failed', `Expected partial_failed result, got ${result.result?.status}`);
  assert(result.result.finalTitleOpinion.includes('CHAIN OF TITLE'), 'Expected a persisted degraded final opinion');
  assert(result.result.warnings.some(w => /segment_2_failed/i.test(w)), `Expected failed segment warning, got ${JSON.stringify(result.result.warnings)}`);
  assert(result.hasMore === false, 'Mixed terminal segment state should not report more work');
});

test('Retry synthesis clears failed result and requeues failed segments', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1), jobStatus: 'failed' });
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => {
    const err = new Error('first synthesis failed');
    err.status = 400;
    throw err;
  };
  await processSynthesisJob('job_test_1', {
    store,
    budgetMs: 30_000,
    config: { maxAttempts: 1 },
  });
  const failedResult = await store.getJobResult('job_test_1');
  assert(failedResult?.status === 'failed', 'Expected initial failed result');

  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => ({
    text: goodFinalOpinion(),
    model: 'claude-sonnet-4-6',
    usage: {},
  });
  await enqueueSynthesisJob('job_test_1', { store });
  const retry = await processSynthesisJob('job_test_1', {
    store,
    budgetMs: 30_000,
    config: { maxAttempts: 1 },
  });

  assert(retry.result?.status === 'complete', `Expected retry to save complete result, got ${retry.result?.status}`);
  assert(retry.result.finalTitleOpinion.includes('CHAIN OF TITLE'), 'Expected retry to replace failed result with final opinion');
});

test('Cancellation during synthesis stops further segment work', async () => {
  const abstracts = manyAbstracts(120);
  const store = createMemoryPhase5Store({ abstracts });
  // Cancel the job immediately
  await store.cancelJob('job_test_1', 'test cancel');
  let calls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => {
    calls += 1;
    return { text: goodSegmentSummary(0), model: 'claude-sonnet-4-6', usage: {} };
  };
  // enqueueSynthesisJob should throw because of canceled state.
  let threw = false;
  try {
    await enqueueSynthesisJob('job_test_1', { store });
  } catch (err) {
    threw = err.statusCode === 409;
  }
  assert(threw, 'Expected 409 when enqueueing canceled job');
  // processSynthesisBatch should also not call the model.
  await processSynthesisJob('job_test_1', { store }).catch(() => {});
  // No segments planned because plan was never persisted; model not called.
  assert(calls === 0, `Expected zero model calls after cancel, got ${calls}`);
});

test('GET /api/jobs/:id/result returns stored title opinion via route handler', async () => {
  const abstracts = manyAbstracts(4);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => ({
    text: goodFinalOpinion(),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 100, output_tokens: 200 },
  });
  await processSynthesisJob('job_test_1', { store });

  const res = mockRes();
  await jobsRouteHandler(mockReq('GET', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/result'), res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.result?.finalTitleOpinion?.includes('FINAL OWNERSHIP'), 'Expected final opinion in response');
  assert(res.body.result.status === 'complete', `Expected complete, got ${res.body.result.status}`);
});

test('Follow-up uses stored title opinion only — no raw analysis-input payloads', async () => {
  const abstracts = manyAbstracts(4);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  let observedMessages = null;
  let callCount = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    callCount += 1;
    if (callCount === 1) {
      // synthesis call
      return { text: goodFinalOpinion('Reservation noted in deed #3.'), model: 'claude-sonnet-4-6', usage: {} };
    }
    observedMessages = request.messages;
    return { text: 'Direct answer using only title opinion.', model: 'claude-sonnet-4-6', usage: {} };
  };
  await processSynthesisJob('job_test_1', { store });

  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', { question: 'What does the chain say about Person 2?' }, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/followup'), res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert(res.body.followup?.answer === 'Direct answer using only title opinion.', `Expected stored answer, got ${res.body.followup?.answer}`);
  const followupContent = observedMessages?.[0]?.content || '';
  assert(followupContent.includes('Completed Title Opinion'), 'Expected title opinion in follow-up prompt');
  // Verify we did NOT send raw abstracts (no DOC TYPE per-doc headers from abstractText)
  assert(!/Document\s+\d+:\s+chk_/i.test(followupContent), 'Expected no raw analysis-input bundle in follow-up');
});

test('Follow-up endpoint rejects raw payload fields', async () => {
  const abstracts = manyAbstracts(2);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  const res = mockRes();
  await jobsRouteHandler(
    mockReq('POST', { question: 'Q', abstract: 'should reject' }, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/followup'),
    res,
  );
  assert(res.statusCode === 400, `Expected 400, got ${res.statusCode}`);
  assert(/must not include raw/i.test(res.body.error), `Expected rejection message, got ${res.body.error}`);
});

test('Synthesis routes reject raw payload fields', async () => {
  const abstracts = manyAbstracts(2);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  const res = mockRes();
  await jobsRouteHandler(
    mockReq('POST', { abstractText: 'should reject' }, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/synthesis/start'),
    res,
  );
  assert(res.statusCode === 400, `Expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert(/must not accept/i.test(res.body.error), `Expected raw-payload rejection, got ${res.body.error}`);
});

test('Synthesis endpoint returns 503 with fallback hint when API keys missing', async () => {
  const previousAnthropic = process.env.ANTHROPIC_API_KEY;
  const previousGemini = process.env.GEMINI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__;
  delete globalThis.__TITLE_ANALYZER_MODEL_CLIENT__;
  const abstracts = manyAbstracts(2);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/synthesis/start'), res);
  assert(res.statusCode === 503, `Expected 503, got ${res.statusCode}`);
  assert(res.body.fallback === 'browser_synthesis', `Expected browser_synthesis fallback, got ${res.body.fallback}`);
  if (previousAnthropic) process.env.ANTHROPIC_API_KEY = previousAnthropic;
  else process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  if (previousGemini) process.env.GEMINI_API_KEY = previousGemini;
  else process.env.GEMINI_API_KEY = 'test-gemini-key';
});

test('effectiveSynthesisChunkSize enlarges segments for bulk jobs', () => {
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  const previousChunkSize = process.env.SYNTHESIS_CHUNK_SIZE;
  delete process.env.BULK_JOB_MIN_ABSTRACTS;
  process.env.SYNTHESIS_CHUNK_SIZE = '120';
  assert(effectiveSynthesisChunkSize(50, {}) === 120, 'Small jobs should use explicit SYNTHESIS_CHUNK_SIZE');
  assert(effectiveSynthesisChunkSize(150, {}) >= 200, 'Bulk jobs should use larger synthesis segments');
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
  if (previousChunkSize === undefined) delete process.env.SYNTHESIS_CHUNK_SIZE;
  else process.env.SYNTHESIS_CHUNK_SIZE = previousChunkSize;
});

test('resolveFinalSynthesisModel keeps Sonnet for final title opinions', () => {
  const previous = process.env.SYNTHESIS_MODEL;
  process.env.SYNTHESIS_MODEL = 'gemini-2.5-pro';
  assert(resolveFinalSynthesisModel() === 'claude-sonnet-4-6', 'Gemini SYNTHESIS_MODEL must not be used for final opinions');
  process.env.SYNTHESIS_MODEL = 'claude-haiku-4-5';
  assert(resolveFinalSynthesisModel() === 'claude-sonnet-4-6', 'Haiku SYNTHESIS_MODEL must not be used for final opinions');
  process.env.SYNTHESIS_MODEL = 'claude-sonnet-4-6';
  assert(resolveFinalSynthesisModel() === 'claude-sonnet-4-6', 'Sonnet should be honored');
  if (previous) process.env.SYNTHESIS_MODEL = previous;
  else delete process.env.SYNTHESIS_MODEL;
});

test('getSynthesisConfig uses Sonnet for final merge model', () => {
  const config = getSynthesisConfig();
  assert(config.model === 'claude-sonnet-4-6', `Expected Sonnet final model, got ${config.model}`);
});

test('resolvePartialSynthesisModel uses Gemini Flash for segment work', () => {
  const previous = process.env.SYNTHESIS_PARTIAL_MODEL;
  process.env.SYNTHESIS_PARTIAL_MODEL = 'claude-haiku-4-5';
  assert(resolvePartialSynthesisModel() === 'gemini-2.5-flash', 'Haiku partial override must fall back to Gemini Flash');
  process.env.SYNTHESIS_PARTIAL_MODEL = 'claude-sonnet-4-6';
  assert(resolvePartialSynthesisModel() === 'gemini-2.5-flash', 'Sonnet partial override must fall back to Gemini Flash');
  if (previous) process.env.SYNTHESIS_PARTIAL_MODEL = previous;
  else delete process.env.SYNTHESIS_PARTIAL_MODEL;
});

test('getPartialSynthesisConfig defaults to Gemini Flash for segment work', () => {
  const partial = getPartialSynthesisConfig();
  assert(partial.model === 'gemini-2.5-flash', `Expected Gemini Flash partial model, got ${partial.model}`);
  assert(partial.maxTokens === 5000, 'Partial synthesis should use the configured partial output cap');
});

test('Synthesis status lightweight poll omits full title opinion payload', async () => {
  const abstracts = manyAbstracts(4);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => ({
    text: goodFinalOpinion(),
    model: 'claude-sonnet-4-6',
    usage: {},
  });
  await processSynthesisJob('job_test_1', { store });
  const res = mockRes();
  await jobsRouteHandler(mockReq('GET', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/synthesis/status'), res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.status.hasResult === true, 'Expected hasResult true');
  assert(!res.body.status.segments?.length, 'Lightweight status should omit segment rows');
  const detailRes = mockRes();
  await jobsRouteHandler(mockReq('GET', null, {}, { detail: 'true', id: 'job_test_1' }, '/api/jobs/job_test_1/synthesis/status?detail=true'), detailRes);
  assert(detailRes.body.status.segments?.length >= 1, 'Detail status should include segments');
});

test('Synthesis status reports segment progress and warnings', async () => {
  const abstracts = manyAbstracts(60);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      return { text: goodSegmentSummary(0), model: 'claude-sonnet-4-6', usage: {} };
    }
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };
  await processSynthesisJob('job_test_1', { store });
  const res = mockRes();
  await jobsRouteHandler(mockReq('GET', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/synthesis/status'), res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.status.complete >= 1, `Expected complete segments reported, got ${res.body.status.complete}`);
  assert(res.body.status.hasResult === true, 'Expected hasResult true');
});

test('Synthesis /start enqueues quickly for the Cloud Run worker', async () => {
  const abstracts = manyAbstracts(4);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => ({
    text: goodFinalOpinion(),
    model: 'claude-sonnet-4-6',
    usage: {},
  });
  const startedAt = Date.now();
  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/synthesis/start'), res);
  const elapsed = Date.now() - startedAt;
  assert(res.statusCode === 202, `Expected 202, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert(elapsed < 2000, `Expected /synthesis/start to return quickly, took ${elapsed}ms`);
  const kickPromise = getSynthesisBackgroundPromise('job_test_1');
  assert(kickPromise, 'Expected synthesis/start to kick a bounded background batch');
  await kickPromise;
  const result = await store.getJobResult('job_test_1');
  assert(result?.finalTitleOpinion?.includes('FINAL OWNERSHIP'), 'Expected background work to save final opinion');
});

test('Cancellation during /synthesis/process returns 409 and runs no work', async () => {
  const abstracts = manyAbstracts(4);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  await store.cancelJob('job_test_1', 'test cancel');
  let calls = 0;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => {
    calls += 1;
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };
  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/synthesis/process'), res);
  assert(res.statusCode === 409, `Expected 409, got ${res.statusCode}`);
  assert(calls === 0, `Expected no model calls on canceled job, got ${calls}`);
});

test('Frontend contains server-synthesis start/poll/result hooks and browser fallback', () => {
  assert(indexHtml.includes('startServerSynthesis'), 'Expected server synthesis start hook');
  assert(indexHtml.includes('/synthesis/status'), 'Expected synthesis status polling endpoint');
  assert(indexHtml.includes('/synthesis/process'), 'Expected synthesis process endpoint hook');
  assert(indexHtml.includes('fetchServerJobResult'), 'Expected final result fetch helper');
  assert(indexHtml.includes('falling back to browser synthesis'), 'Expected browser fallback warning');
  assert(indexHtml.includes('askServerFollowup'), 'Expected server follow-up hook');
  assert(indexHtml.includes('hierarchicalSynthesis'), 'Expected browser fallback synthesis preserved');
});

test('buildFollowupMessages prefers full title opinion + recent turns and truncates when oversized', () => {
  const recent = Array.from({ length: 8 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
  const { messages, truncationWarning } = buildFollowupMessages({
    question: 'final question',
    finalTitleOpinion: 'Opinion content.',
    recentTurns: recent,
  });
  const config = getSynthesisConfig({});
  const bytes = estimateRequestBytes(config.model, config.maxTokens, SYNTHESIS_PROMPT, messages);
  assert(bytes <= config.requestEnvelopeSafeBytes, 'Expected follow-up below safe envelope');
  assert(messages[0].content.includes('Opinion content.'), 'Expected opinion included');
  assert(messages[0].content.includes('final question'), 'Expected current question included');
  assert(!truncationWarning, 'Did not expect truncation for small opinion');
  // Oversized opinion: ensure truncation kicks in
  const big = 'x'.repeat(14_000_000);
  const oversized = buildFollowupMessages({
    question: 'q',
    finalTitleOpinion: big,
    recentTurns: [],
  });
  const bytesOver = estimateRequestBytes(config.model, config.maxTokens, SYNTHESIS_PROMPT, oversized.messages);
  assert(bytesOver <= config.requestEnvelopeSafeBytes, 'Expected truncated follow-up below safe envelope');
  assert(oversized.truncationWarning, 'Expected truncation warning on oversized opinion');
});

test('Synthesis /process drains next batch and reports result for the route', async () => {
  const abstracts = manyAbstracts(5);
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async () => ({
    text: goodFinalOpinion(),
    model: 'claude-sonnet-4-6',
    usage: { input_tokens: 100, output_tokens: 200 },
  });
  const res = mockRes();
  await jobsRouteHandler(mockReq('POST', null, {}, { id: 'job_test_1' }, '/api/jobs/job_test_1/synthesis/process'), res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert(res.body.result?.status === 'complete', `Expected complete after process, got ${res.body.result?.status}`);
  assert(res.body.hasMore === false, 'Expected no more work after batch drain');
});

test('summarizeSynthesisWarningFlags extracts repair and merge flags', () => {
  const flags = summarizeSynthesisWarningFlags([
    'segment_1:repair_retry',
    'merge_tree_applied',
    'final_validation_failed: missing section',
  ]);
  assert(flags.includes('repair_retry'), 'Expected repair_retry flag');
  assert(flags.includes('merge_tree_applied'), 'Expected merge_tree_applied flag');
  assert(flags.includes('final_validation_failed'), 'Expected final_validation_failed flag');
});

test('buildSynthesisMetricsEvent includes event name and timestamp', () => {
  const event = buildSynthesisMetricsEvent({ event: 'synthesis_merge_complete', jobId: 'job_test_1' });
  assert(event.event === 'synthesis_merge_complete', 'Expected event name');
  assert(typeof event.ts === 'string' && event.ts.includes('T'), 'Expected ISO timestamp');
});

test('resolveSynthesisBatchLimit defaults to 4 and honors SYNTHESIS_BATCH_LIMIT', () => {
  const previous = process.env.SYNTHESIS_BATCH_LIMIT;
  delete process.env.SYNTHESIS_BATCH_LIMIT;
  assert(resolveSynthesisBatchLimit() === 4, 'Expected default synthesis batch limit of 4');
  assert(resolveSynthesisBatchLimit({ batchLimit: 8 }) === 8, 'Expected explicit batchLimit override');
  process.env.SYNTHESIS_BATCH_LIMIT = '8';
  assert(resolveSynthesisBatchLimit() === 8, 'Expected env SYNTHESIS_BATCH_LIMIT=8');
  if (previous === undefined) delete process.env.SYNTHESIS_BATCH_LIMIT;
  else process.env.SYNTHESIS_BATCH_LIMIT = previous;
});

test('processSynthesisBatch claims up to configured batchLimit ready segments per pass', async () => {
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  const abstracts = manyAbstracts(250);
  let maxReadyLimit = 0;
  const store = createMemoryPhase5Store({ abstracts });
  const originalListReady = store.listReadySynthesisSegments.bind(store);
  store.listReadySynthesisSegments = async (jobId, planId, limit = 4) => {
    maxReadyLimit = Math.max(maxReadyLimit, limit);
    return originalListReady(jobId, planId, limit);
  };
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      return { text: goodSegmentSummary(0), model: 'gemini-2.5-flash', usage: {} };
    }
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };
  await processSynthesisBatch('job_test_1', { store, budgetMs: 5_000, batchLimit: 8 });
  assert(maxReadyLimit === 8, `Expected batch limit 8, saw ${maxReadyLimit}`);
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
});

test('synthesisStreamEnabled respects env and option overrides', () => {
  const previous = process.env.SYNTHESIS_STREAM_ENABLED;
  delete process.env.SYNTHESIS_STREAM_ENABLED;
  assert(synthesisStreamEnabled() === false, 'Expected streaming disabled by default');
  process.env.SYNTHESIS_STREAM_ENABLED = 'true';
  assert(synthesisStreamEnabled() === true, 'Expected streaming enabled from env');
  assert(synthesisStreamEnabled({ streamFinalOpinion: false }) === false, 'Expected option override off');
  if (previous === undefined) delete process.env.SYNTHESIS_STREAM_ENABLED;
  else process.env.SYNTHESIS_STREAM_ENABLED = previous;
});

test('final merge writes streaming preview during Sonnet merge when enabled', async () => {
  const previousStream = process.env.SYNTHESIS_STREAM_ENABLED;
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  process.env.SYNTHESIS_STREAM_ENABLED = 'true';
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  const abstracts = manyAbstracts(250);
  let maxPreviewBytes = 0;
  let streamCalled = false;
  const store = createMemoryPhase5Store({ abstracts });
  const originalSetPreview = store.setSynthesisPreview.bind(store);
  store.setSynthesisPreview = async (...args) => {
    const preview = await originalSetPreview(...args);
    maxPreviewBytes = Math.max(maxPreviewBytes, preview.bytesReceived || 0);
    return preview;
  };
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      return { text: goodSegmentSummary(0), model: 'gemini-2.5-flash', usage: {} };
    }
    if (request.stream) {
      streamCalled = true;
      if (request.onDelta) {
        await request.onDelta('## CHAIN', '## CHAIN');
        await request.onDelta(' OF TITLE\n', '## CHAIN OF TITLE\n');
      }
      return {
        text: goodFinalOpinion(),
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 10, output_tokens: 20 },
        timeToFirstDeltaMs: 12,
      };
    }
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };
  const batch = await processSynthesisJob('job_test_1', { store, budgetMs: 60_000, batchLimit: 8 });
  assert(streamCalled, 'Expected streaming final merge call');
  assert(maxPreviewBytes > 0, 'Expected preview bytes while streaming');
  assert(batch.result?.finalTitleOpinion, 'Expected saved final opinion after streamed merge');
  if (previousStream === undefined) delete process.env.SYNTHESIS_STREAM_ENABLED;
  else process.env.SYNTHESIS_STREAM_ENABLED = previousStream;
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
});

test('GET /api/jobs/:id/synthesis/preview returns buffered merge text', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1) });
  await store.setSynthesisPreview('job_test_1', {
    text: 'Draft opinion preview',
    complete: false,
    bytesReceived: 21,
  });
  globalThis.__TITLE_ANALYZER_JOB_STORE__ = store;
  const req = {
    method: 'GET',
    url: '/api/jobs/job_test_1/synthesis/preview',
    query: { path: ['job_test_1', 'synthesis', 'preview'] },
    headers: { 'x-app-password': process.env.APP_PASSWORD || 'test-password' },
  };
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  await jobsRouteHandler(req, res);
  assert(res.statusCode === 200, `Expected 200, got ${res.statusCode}`);
  assert(res.body.preview.text === 'Draft opinion preview', 'Expected preview text');
  assert(res.body.preview.bytesReceived === 21, 'Expected preview byte count');
});

test('tryRecoverMergePreview reuses a completed, valid preview', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1) });
  const opinion = goodFinalOpinion('Recovered from preview.');
  await store.setSynthesisPreview('job_test_1', { text: opinion, complete: true });
  const recovered = await tryRecoverMergePreview(store, 'job_test_1', getSynthesisConfig());
  assert(recovered, 'Expected recovery from a completed valid preview');
  assert(recovered.text === opinion, 'Expected the preview text returned verbatim');
  assert(recovered.streamed === false && recovered.recovered === true, 'Expected recovered metadata flags');
  assert(recovered.timeToFirstDeltaMs === null, 'Expected timeToFirstDeltaMs present (null) for contract parity with the merge object');
});

test('tryRecoverMergePreview returns null when the preview is incomplete', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1) });
  await store.setSynthesisPreview('job_test_1', { text: goodFinalOpinion('partial'), complete: false });
  const recovered = await tryRecoverMergePreview(store, 'job_test_1', getSynthesisConfig());
  assert(recovered === null, 'Expected null for an incomplete preview');
});

test('tryRecoverMergePreview returns null when completed preview text is not a valid opinion', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1) });
  await store.setSynthesisPreview('job_test_1', { text: 'too short / garbage', complete: true });
  const recovered = await tryRecoverMergePreview(store, 'job_test_1', getSynthesisConfig());
  assert(recovered === null, 'Expected null when completed preview fails opinion validation');
});

test('shouldForceMultiSegmentPlanning is gated by SYNTHESIS_LARGE_JOB_MULTI_SEGMENT', () => {
  const previousMulti = process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT;
  const previousForce = process.env.SYNTHESIS_FORCE_SINGLE_PASS;
  const previousBulk = process.env.BULK_JOB_MIN_ABSTRACTS;
  delete process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT;
  delete process.env.SYNTHESIS_FORCE_SINGLE_PASS;
  process.env.BULK_JOB_MIN_ABSTRACTS = '50';
  assert(shouldForceMultiSegmentPlanning(100) === false, 'Expected multi-segment forcing off by default');
  process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT = 'true';
  assert(shouldForceMultiSegmentPlanning(100) === true, 'Expected forcing when enabled and above bulk min');
  process.env.SYNTHESIS_FORCE_SINGLE_PASS = 'true';
  assert(shouldForceMultiSegmentPlanning(100) === false, 'Expected opt-out via SYNTHESIS_FORCE_SINGLE_PASS');
  if (previousMulti === undefined) delete process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT;
  else process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT = previousMulti;
  if (previousForce === undefined) delete process.env.SYNTHESIS_FORCE_SINGLE_PASS;
  else process.env.SYNTHESIS_FORCE_SINGLE_PASS = previousForce;
  if (previousBulk === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulk;
});

test('shouldCompactBeforeMerge triggers at segment threshold', () => {
  const previous = process.env.SYNTHESIS_COMPACTION_ENABLED;
  process.env.SYNTHESIS_COMPACTION_ENABLED = 'true';
  assert(shouldCompactBeforeMerge({ segmentCount: 6, mergeInputBytes: 1000 }) === true, 'Expected compaction at 6 segments');
  assert(shouldCompactBeforeMerge({ segmentCount: 2, mergeInputBytes: 200_000 }) === true, 'Expected compaction for large merge input');
  assert(shouldCompactBeforeMerge({ segmentCount: 2, mergeInputBytes: 1000 }) === false, 'Expected no compaction for small jobs');
  if (previous === undefined) delete process.env.SYNTHESIS_COMPACTION_ENABLED;
  else process.env.SYNTHESIS_COMPACTION_ENABLED = previous;
});

test('merge compaction applies Gemini scaffold before final Sonnet merge', async () => {
  const previousCompaction = process.env.SYNTHESIS_COMPACTION_ENABLED;
  const previousMinSegments = process.env.SYNTHESIS_COMPACTION_MIN_SEGMENTS;
  const previousBulkMin = process.env.BULK_JOB_MIN_ABSTRACTS;
  process.env.SYNTHESIS_COMPACTION_ENABLED = 'true';
  process.env.SYNTHESIS_COMPACTION_MIN_SEGMENTS = '3';
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  const abstracts = manyAbstracts(250);
  let compactionCalls = 0;
  const store = createMemoryPhase5Store({ abstracts });
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === COMPACTION_SYNTHESIS_PROMPT) {
      compactionCalls += 1;
      return { text: goodSegmentSummary(0), model: 'gemini-2.5-flash', usage: { input_tokens: 1, output_tokens: 1 } };
    }
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      return { text: goodSegmentSummary(0), model: 'gemini-2.5-flash', usage: {} };
    }
    return { text: goodFinalOpinion(), model: 'claude-sonnet-4-6', usage: {} };
  };
  const batch = await processSynthesisJob('job_test_1', { store, budgetMs: 120_000, batchLimit: 8 });
  assert(compactionCalls >= 1, `Expected compaction call, saw ${compactionCalls}`);
  assert((batch.result?.warnings || []).some(w => String(w).includes('merge_compaction_applied')), 'Expected compaction warning');
  if (previousCompaction === undefined) delete process.env.SYNTHESIS_COMPACTION_ENABLED;
  else process.env.SYNTHESIS_COMPACTION_ENABLED = previousCompaction;
  if (previousMinSegments === undefined) delete process.env.SYNTHESIS_COMPACTION_MIN_SEGMENTS;
  else process.env.SYNTHESIS_COMPACTION_MIN_SEGMENTS = previousMinSegments;
  if (previousBulkMin === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulkMin;
});

test('planSynthesisSegments splits large single-pass jobs when multi-segment forcing enabled', () => {
  const previousMulti = process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT;
  const previousBulk = process.env.BULK_JOB_MIN_ABSTRACTS;
  process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT = 'true';
  process.env.BULK_JOB_MIN_ABSTRACTS = '50';
  const abstracts = manyAbstracts(200);
  const plan = planSynthesisSegments(abstracts, 'Tract A', 'Notes');
  assert(plan.segments.length > 1, `Expected multiple segments, got ${plan.segments.length}`);
  if (previousMulti === undefined) delete process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT;
  else process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT = previousMulti;
  if (previousBulk === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulk;
});

test('planSynthesisSegments uses configured chunk size for all forced multi-segment jobs', () => {
  const previousMulti = process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT;
  const previousBulk = process.env.BULK_JOB_MIN_ABSTRACTS;
  const previousBulkSize = process.env.BULK_SYNTHESIS_CHUNK_SIZE;
  process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT = 'true';
  process.env.BULK_JOB_MIN_ABSTRACTS = '50';
  delete process.env.BULK_SYNTHESIS_CHUNK_SIZE;
  const abstracts = manyAbstracts(400);
  const plan = planSynthesisSegments(abstracts, 'Tract A', 'Notes', { chunkSize: 50 });
  assert(plan.segments.length === 8, `Expected 8 forced 50-doc segments, got ${plan.segments.length}`);
  assert(plan.segments.every(seg => seg.documentIds.length <= 50), 'Expected every forced segment capped at 50 docs');
  if (previousMulti === undefined) delete process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT;
  else process.env.SYNTHESIS_LARGE_JOB_MULTI_SEGMENT = previousMulti;
  if (previousBulk === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS;
  else process.env.BULK_JOB_MIN_ABSTRACTS = previousBulk;
  if (previousBulkSize === undefined) delete process.env.BULK_SYNTHESIS_CHUNK_SIZE;
  else process.env.BULK_SYNTHESIS_CHUNK_SIZE = previousBulkSize;
});

// --- Run --------------------------------------------------------------------

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
  delete globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__;
  delete globalThis.__TITLE_ANALYZER_MODEL_CLIENT__;
  try {
    await fn();
    console.log(`ok - ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`not ok - ${name}`);
    console.error(err);
    failed += 1;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
delete globalThis.__TITLE_ANALYZER_JOB_STORE__;
delete globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__;
delete globalThis.__TITLE_ANALYZER_MODEL_CLIENT__;
if (previousAppPassword) process.env.APP_PASSWORD = previousAppPassword;
process.exit(failed > 0 ? 1 : 0);
