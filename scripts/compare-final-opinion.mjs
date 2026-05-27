#!/usr/bin/env node
/**
 * Compare final title opinions on frozen job abstracts (does not write job_results).
 *
 * Default: Claude Sonnet 4.6 vs Gemini 3.5 Flash (one Gemini thinking level).
 *
 * Usage:
 *   DATABASE_URL=... GEMINI_API_KEY=... ANTHROPIC_API_KEY=... \
 *     node scripts/compare-final-opinion.mjs --job-id job_abc123
 *
 * Gemini medium + high only:
 *   node scripts/compare-final-opinion.mjs --job-id job_abc123 \
 *     --gemini-thinking-levels medium,high --skip-sonnet
 *
 * Sonnet only (separate run):
 *   node scripts/compare-final-opinion.mjs --job-id job_abc123 --sonnet-only
 */

import { mkdir, writeFile } from 'fs/promises';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
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

const GEMINI_THINKING_LEVELS = new Set(['minimal', 'low', 'medium', 'high']);

function parseThinkingLevelsCsv(raw) {
  if (!raw) return [];
  const levels = [];
  for (const part of String(raw).split(',')) {
    const level = part.trim().toLowerCase();
    if (!level) continue;
    if (!GEMINI_THINKING_LEVELS.has(level)) {
      throw new Error(`Invalid Gemini thinking level "${part.trim()}". Use: minimal, low, medium, high.`);
    }
    if (!levels.includes(level)) levels.push(level);
  }
  return levels;
}

function parseArgs(argv) {
  const args = {
    jobId: null,
    outDir: null,
    geminiModel: 'gemini-3.5-flash',
    sonnetModel: 'claude-sonnet-4-6',
    geminiThinkingLevel: null,
    geminiThinkingLevels: [],
    skipSonnet: false,
    sonnetOnly: false,
    noHtml: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--job-id') args.jobId = argv[++i];
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--gemini-model') args.geminiModel = argv[++i];
    else if (a === '--sonnet-model') args.sonnetModel = argv[++i];
    else if (a === '--gemini-thinking-level') args.geminiThinkingLevel = argv[++i];
    else if (a === '--gemini-thinking-levels') args.geminiThinkingLevels = parseThinkingLevelsCsv(argv[++i]);
    else if (a === '--skip-sonnet') args.skipSonnet = true;
    else if (a === '--sonnet-only') args.sonnetOnly = true;
    else if (a === '--no-html') args.noHtml = true;
    else if (a === '--help' || a === '-h') args.help = true;
  }
  return args;
}

function validateCompareArgs(args) {
  if (args.sonnetOnly && args.skipSonnet) {
    throw new Error('Use either --sonnet-only or --skip-sonnet, not both.');
  }
  if (args.sonnetOnly && (args.geminiThinkingLevels.length || args.geminiThinkingLevel)) {
    throw new Error('--sonnet-only cannot be combined with --gemini-thinking-level or --gemini-thinking-levels.');
  }
  if (args.sonnetOnly && process.env.GEMINI_THINKING_LEVEL) {
    throw new Error('Unset GEMINI_THINKING_LEVEL when using --sonnet-only, or pass --sonnet-only in a clean shell.');
  }
}

/** @returns {{ id: string, label: string, model: string, thinkingLevel?: string }[]} */
export function buildCompareArms(args) {
  const arms = [];
  if (!args.skipSonnet) {
    arms.push({ id: 'sonnet', label: 'Claude Sonnet 4.6', model: args.sonnetModel });
  }
  if (args.sonnetOnly) {
    return arms;
  }

  const levels = args.geminiThinkingLevels.length
    ? args.geminiThinkingLevels
    : (args.geminiThinkingLevel || process.env.GEMINI_THINKING_LEVEL
      ? [String(args.geminiThinkingLevel || process.env.GEMINI_THINKING_LEVEL).trim().toLowerCase()]
      : [null]);

  for (const level of levels) {
    if (level && !GEMINI_THINKING_LEVELS.has(level)) {
      throw new Error(`Invalid Gemini thinking level "${level}". Use: minimal, low, medium, high.`);
    }
  }

  for (const level of levels) {
    const suffix = level || 'default';
    const id = level ? `gemini-35-flash-${level}` : 'gemini-35-flash';
    const levelLabel = level
      ? `Gemini 3.5 Flash (${level} thinking)`
      : 'Gemini 3.5 Flash (API default thinking)';
    arms.push({
      id,
      label: levelLabel,
      model: args.geminiModel,
      thinkingLevel: level || undefined,
      geminiThinkingSuffix: suffix,
    });
  }

  return arms;
}

function usage() {
  console.log(`Compare final title opinions on frozen abstracts (writes markdown + compare.html).

Required env: DATABASE_URL
GEMINI_API_KEY when any Gemini arm runs. ANTHROPIC_API_KEY when Sonnet runs.

Options:
  --job-id <id>                      Job with completed abstracts (merge needs segment summaries)
  --out-dir <path>                   Output directory (default: eval/compare/<jobId>-<ts>)
  --gemini-model <id>                Default: gemini-3.5-flash
  --sonnet-model <id>                Default: claude-sonnet-4-6
  --gemini-thinking-level <lvl>      Single Gemini arm: minimal|low|medium|high
  --gemini-thinking-levels <a,b,...> Multiple Gemini arms, e.g. medium,high
  --skip-sonnet                      Gemini arm(s) only (no Sonnet)
  --sonnet-only                      Sonnet only (no Gemini) — use in a separate run
  --no-html                          Skip compare.html side-by-side viewer

Examples:
  Run 1 — Gemini medium vs high:
    --job-id job_xxx --gemini-thinking-levels medium,high --skip-sonnet

  Run 2 — Sonnet only:
    --job-id job_xxx --sonnet-only

  Default (both models, one Gemini thinking level):
    --job-id job_xxx
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
    thinkingLevel: thinkingLevel || null,
  };
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function buildCompareHtml(panels) {
  const columns = panels
    .map(
      p => `<section class="panel">
  <h2>${escapeHtml(p.label)}</h2>
  <pre>${escapeHtml(p.text)}</pre>
</section>`,
    )
    .join('\n');

  const count = Math.max(1, panels.length);
  const gridColumns = count === 2
    ? '1fr 1fr'
    : count === 3
      ? '1fr 1fr 1fr'
      : `repeat(${count}, minmax(0, 1fr))`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Title opinion compare</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, sans-serif; background: #f0f2f5; color: #111; }
    header { padding: 12px 16px; background: #1a1a2e; color: #fff; font-size: 14px; }
    .grid {
      display: grid;
      grid-template-columns: ${gridColumns};
      gap: 12px;
      padding: 12px;
      min-height: calc(100vh - 48px);
    }
    @media (max-width: 900px) {
      .grid { grid-template-columns: 1fr !important; }
    }
    .panel {
      display: flex;
      flex-direction: column;
      min-height: 320px;
      max-height: calc(100vh - 72px);
      background: #fff;
      border: 1px solid #d0d5dd;
      border-radius: 8px;
      overflow: hidden;
      box-shadow: 0 1px 2px rgba(0,0,0,0.06);
    }
    .panel h2 {
      margin: 0;
      padding: 10px 14px;
      font-size: 13px;
      font-weight: 600;
      background: #f8f9fb;
      border-bottom: 1px solid #e4e7ec;
    }
    .panel pre {
      flex: 1;
      margin: 0;
      padding: 14px;
      overflow: auto;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 12px;
      line-height: 1.45;
    }
  </style>
</head>
<body>
  <header>Title opinion compare — open panels side by side (scroll independently)</header>
  <div class="grid">
${columns}
  </div>
</body>
</html>
`;
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

  try {
    validateCompareArgs(args);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  const arms = buildCompareArms(args);
  if (!arms.length) {
    console.error('No comparison arms configured. Use --sonnet-only, --skip-sonnet + --gemini-thinking-level(s), or defaults.');
    process.exit(1);
  }

  const store = getJobStore();
  const ctx = await loadJobContext(store, args.jobId);
  const mode = resolveMode(ctx);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.outDir || join('eval', 'compare', `${args.jobId}-${ts}`);
  await mkdir(outDir, { recursive: true });

  console.log(`Job: ${args.jobId}`);
  console.log(`Mode: ${mode} (${ctx.abstracts.length} abstracts, ${ctx.segmentSummaries.length} segment summaries)`);
  console.log(`Arms: ${arms.map(a => a.label).join(' | ')}`);
  console.log(`Output: ${outDir}\n`);

  const results = {};
  const htmlPanels = [];

  for (const arm of arms) {
    const thinkingNote = arm.thinkingLevel ? `, thinking=${arm.thinkingLevel}` : '';
    console.log(`Running ${arm.label} (${arm.model}${thinkingNote})...`);
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
      label: arm.label,
      model: result.model,
      thinkingLevel: result.thinkingLevel,
      mode: result.mode,
      latencyMs: result.latencyMs,
      usage: result.usage,
      opinionFile: opinionPath,
    };
    htmlPanels.push({ label: arm.label, text: result.text });
    console.log(`  Wrote ${opinionPath} (${result.latencyMs} ms)\n`);
  }

  const baseline = await store.getJobResult?.(args.jobId);
  const meta = {
    jobId: args.jobId,
    tract: ctx.tract,
    abstractCount: ctx.abstracts.length,
    segmentSummaryCount: ctx.segmentSummaries.length,
    mode,
    geminiThinkingLevels: args.geminiThinkingLevels.length
      ? args.geminiThinkingLevels
      : (args.geminiThinkingLevel || process.env.GEMINI_THINKING_LEVEL || null),
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
    htmlPanels.push({ label: 'Production baseline (saved job result)', text: baseline.finalTitleOpinion });
  }

  if (!args.noHtml && htmlPanels.length) {
    const htmlPath = join(outDir, 'compare.html');
    await writeFile(htmlPath, buildCompareHtml(htmlPanels), 'utf8');
    console.log(`Side-by-side viewer: file://${htmlPath}`);
  }

  const mdFiles = arms.map(a => `${a.id}-opinion.md`).join(', ');
  console.log(`Done. Compare: ${mdFiles}`);
  if (baseline?.finalTitleOpinion) console.log('(plus production-baseline-opinion.md if present)');
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch(err => {
    console.error(err.message || err);
    process.exit(1);
  });
}
