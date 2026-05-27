#!/usr/bin/env node
/**
 * Compare final title opinions: Claude Sonnet 4.6 vs Gemini 3.5 Flash on the same abstracts.
 *
 * Does NOT write to job_results — outputs markdown files for blind review.
 *
 * Usage:
 *   DATABASE_URL=... GEMINI_API_KEY=... ANTHROPIC_API_KEY=... \
 *     node scripts/compare-final-opinion.mjs --job-id job_abc123
 *
 * Optional:
 *   --out-dir eval/compare/my-run
 *   --gemini-model gemini-3.5-flash
 *   --sonnet-model claude-sonnet-4-6
 *   --gemini-thinking-level high   (or env GEMINI_THINKING_LEVEL)
 */

import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { buildMergeUserMessageContent } from '../api/_lib/anthropic-request.js';
import { getJobStore } from '../api/_lib/jobs.js';
import { invokeModel } from '../api/_lib/model-client.js';
import {
  SYNTHESIS_PROMPT,
  buildAbstractInput,
  getSynthesisConfig,
  groupAbstractsByDocument,
  planSynthesisSegments,
} from '../api/_lib/synthesis.js';

function parseArgs(argv) {
  const args = { jobId: null, outDir: null, geminiModel: 'gemini-3.5-flash', sonnetModel: 'claude-sonnet-4-6', geminiThinkingLevel: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--job-id') args.jobId = argv[++i];
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--gemini-model') args.geminiModel = argv[++i];
    else if (a === '--sonnet-model') args.sonnetModel = argv[++i];
    else if (a === '--gemini-thinking-level') args.geminiThinkingLevel = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function usage() {
  console.log(`Compare final title opinions (Sonnet vs Gemini) on frozen abstracts.

Required env: DATABASE_URL, GEMINI_API_KEY, ANTHROPIC_API_KEY

Options:
  --job-id <id>                 Completed or abstracted job (abstracts required)
  --out-dir <path>              Output directory (default: eval/compare/<jobId>-<ts>)
  --gemini-model <id>           Default: gemini-3.5-flash
  --sonnet-model <id>           Default: claude-sonnet-4-6
  --gemini-thinking-level <lvl> minimal|low|medium|high (or GEMINI_THINKING_LEVEL)
`);
}

function normalizeAbstracts(rows) {
  return groupAbstractsByDocument(
    rows
      .filter(row => String(row.abstractText || row.abstract || '').trim())
      .map(row => ({
        id: row.id,
        chunkId: row.chunkId,
        documentId: row.documentId,
        chunkOrder: row.chunkOrder,
        pageStart: row.pageStart,
        pageEnd: row.pageEnd,
        filename: row.sourceFilename || row.originalFilename || row.filename || row.chunkId,
        abstract: row.abstractText || row.abstract || '',
      })),
  );
}

function buildSegmentBlock(summaries) {
  let block = '';
  for (const summary of summaries) {
    block += `### ${summary.filename}\n\n${summary.abstract}\n\n---\n\n`;
  }
  return block;
}

async function loadJobContext(store, jobId) {
  const job = await store.getJob(jobId);
  if (!job) throw new Error(`Job not found: ${jobId}`);
  const rawAbstracts = await store.listDocumentAbstracts(jobId);
  const abstracts = normalizeAbstracts(rawAbstracts);
  if (!abstracts.length) {
    throw new Error('No completed abstracts on this job. Run abstraction first.');
  }
  const tract = job.subjectTract || '';
  const contextNotes = job.contextNotes || '';
  const planId = await store.getCurrentSynthesisPlanId?.(jobId);
  let segmentSummaries = [];
  if (planId && store.listSynthesisSegments) {
    const segments = await store.listSynthesisSegments(jobId, planId);
    segmentSummaries = segments
      .filter(seg => seg.status === 'complete' && String(seg.summaryText || '').trim())
      .sort((a, b) => a.segmentIndex - b.segmentIndex)
      .map(seg => ({
        segmentIndex: seg.segmentIndex,
        startSequenceIndex: seg.startSequenceIndex,
        endSequenceIndex: seg.endSequenceIndex,
        filename: `Segment ${seg.segmentIndex + 1} (Documents ${seg.startSequenceIndex + 1}-${seg.endSequenceIndex + 1})`,
        abstract: seg.summaryText,
      }));
  }
  const { segments: planned } = planSynthesisSegments(abstracts, tract, contextNotes);
  return { job, abstracts, tract, contextNotes, segmentSummaries, plannedSegmentCount: planned.length };
}

function resolveMode(ctx) {
  if (ctx.segmentSummaries.length > 1) return 'merge';
  if (ctx.plannedSegmentCount === 1) return 'single-pass';
  if (ctx.segmentSummaries.length === 1) return 'merge';
  throw new Error(
    `Job has ${ctx.plannedSegmentCount} planned segments but no completed segment summaries. `
    + 'Finish server synthesis on this job first, or use a smaller job that fits single-pass.',
  );
}

async function generateFinalOpinion({ mode, ctx, model, thinkingLevel }) {
  const config = getSynthesisConfig({ model });
  const started = Date.now();
  let messages;

  if (mode === 'single-pass') {
    const preamble = `Below are ${ctx.abstracts.length} document abstracts. Synthesize into a complete title opinion.`;
    messages = [{
      role: 'user',
      content: buildAbstractInput(ctx.abstracts, ctx.tract, ctx.contextNotes, preamble),
    }];
  } else {
    const total = ctx.abstracts.length;
    const preamble = `Below are ${ctx.segmentSummaries.length} partial chain-of-title segments covering all ${total} documents. Merge them into one complete title opinion.`;
    const content = buildMergeUserMessageContent({
      preamble,
      tract: ctx.tract,
      contextNotes: ctx.contextNotes,
      segmentBlock: buildSegmentBlock(ctx.segmentSummaries),
      cacheSegments: true,
    });
    messages = [{ role: 'user', content }];
  }

  const response = await invokeModel({
    model: config.model,
    maxTokens: config.maxTokens,
    system: SYNTHESIS_PROMPT,
    messages,
    thinkingLevel: thinkingLevel || undefined,
  });

  return {
    model: response.model || model,
    text: response.text || '',
    usage: response.usage || {},
    thoughtSummaries: response.thoughtSummaries,
    latencyMs: Date.now() - started,
    mode,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.jobId) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    console.error('DATABASE_URL is required.');
    process.exit(1);
  }

  const thinkingLevel = args.geminiThinkingLevel || process.env.GEMINI_THINKING_LEVEL || null;
  if (thinkingLevel) process.env.GEMINI_THINKING_LEVEL = thinkingLevel;

  const store = getJobStore();
  const ctx = await loadJobContext(store, args.jobId);
  const mode = resolveMode(ctx);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.outDir || join('eval', 'compare', `${args.jobId}-${ts}`);
  await mkdir(outDir, { recursive: true });

  console.log(`Job: ${args.jobId}`);
  console.log(`Mode: ${mode} (${ctx.abstracts.length} abstracts, ${ctx.segmentSummaries.length} segment summaries)`);
  console.log(`Output: ${outDir}\n`);

  const arms = [
    { id: 'sonnet', label: 'Claude Sonnet 4.6', model: args.sonnetModel },
    { id: 'gemini-35-flash', label: 'Gemini 3.5 Flash', model: args.geminiModel, thinkingLevel },
  ];

  const results = {};
  for (const arm of arms) {
    console.log(`Running ${arm.label} (${arm.model})...`);
    const result = await generateFinalOpinion({
      mode,
      ctx,
      model: arm.model,
      thinkingLevel: arm.thinkingLevel,
    });
    const opinionPath = join(outDir, `${arm.id}-opinion.md`);
    await writeFile(opinionPath, result.text, 'utf8');
    if (result.thoughtSummaries?.length) {
      await writeFile(
        join(outDir, `${arm.id}-thoughts.md`),
        result.thoughtSummaries.join('\n\n---\n\n'),
        'utf8',
      );
    }
    results[arm.id] = {
      model: result.model,
      mode: result.mode,
      latencyMs: result.latencyMs,
      usage: result.usage,
      opinionFile: opinionPath,
    };
    console.log(`  Wrote ${opinionPath} (${result.latencyMs} ms)\n`);
  }

  const baseline = await store.getJobResult?.(args.jobId);
  const meta = {
    jobId: args.jobId,
    tract: ctx.tract,
    abstractCount: ctx.abstracts.length,
    segmentSummaryCount: ctx.segmentSummaries.length,
    mode,
    geminiThinkingLevel: thinkingLevel,
    productionBaseline: baseline
      ? {
          modelUsed: baseline.modelUsed,
          inputTokens: baseline.inputTokens,
          outputTokens: baseline.outputTokens,
          synthesisDurationMs: baseline.synthesisDurationMs,
        }
      : null,
    arms: results,
  };
  await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  if (baseline?.finalTitleOpinion) {
    await writeFile(join(outDir, 'production-baseline-opinion.md'), baseline.finalTitleOpinion, 'utf8');
  }

  console.log('Done. Compare sonnet-opinion.md vs gemini-35-flash-opinion.md (production baseline saved if present).');
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
