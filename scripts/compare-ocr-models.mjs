#!/usr/bin/env node
/**
 * Dev harness: compare OCR/abstraction models on scanned title documents.
 *
 * If ground_truth.json exists alongside the images, computes per-model
 * transcription accuracy (GRANTOR, GRANTEE, DATE EXECUTED, DATE RECORDED,
 * RECORDING REF) and fabrication rate (degraded fields correctly flagged vs
 * invented). Without ground truth, falls back to the cross-model fabrication
 * signal from the previous run.
 *
 * Usage:
 *   node --env-file=.env.local scripts/compare-ocr-models.mjs scripts/sample-docs
 *
 * source .env.local && node scripts/compare-ocr-models.mjs scripts/sample-docs
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, statSync, existsSync } from 'fs';
import { join, extname, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  resolveChunkDelivery,
  buildAbstractMessagesForChunk,
  ABSTRACTION_PROMPT,
} from '../api/_lib/abstraction.js';
import { invokeModel } from '../api/_lib/model-client.js';

// ---------------------------------------------------------------------------
// Models — edit IDs here. Confirmed against Gemini API June 2026.
// 2.5 uses thinkingBudget; gen-3+ uses thinkingLevel. minimal beats higher
// effort for OCR transcription on socOCRbench.
// ---------------------------------------------------------------------------
const MODELS = [
  { id: 'gemini-2.5-flash',      thinking: { thinkingBudget: 0 } },
  { id: 'gemini-3.1-flash-lite', thinking: { thinkingLevel: 'minimal' } },
  { id: 'gemini-3-flash-preview', thinking: { thinkingLevel: 'minimal' } },
  { id: 'gemini-3.5-flash',      thinking: { thinkingLevel: 'minimal' } },
];

// USD per 1M tokens, standard tier. Verified Jun 2026. Batch API ≈ 50%.
const PRICING = {
  'gemini-2.5-flash':      { in: 0.30, out: 2.50 },
  'gemini-3.1-flash-lite': { in: 0.25, out: 1.50 },
  'gemini-3-flash-preview':{ in: 0.50, out: 3.00 },
  'gemini-3.5-flash':      { in: 1.50, out: 9.00 },
};

// Fields the accuracy checker scores against ground_truth.json.
// Keys match the ground_truth.json field names (uppercase_with_underscores).
const ACCURACY_FIELDS = [
  { gt: 'GRANTOR',        parsed: 'GRANTOR' },
  { gt: 'GRANTEE',        parsed: 'GRANTEE' },
  { gt: 'DATE_EXECUTED',  parsed: 'DATE EXECUTED' },
  { gt: 'DATE_RECORDED',  parsed: 'DATE RECORDED' },
  { gt: 'RECORDING_REF',  parsed: 'RECORDING REF' },
];

// Fields checked for fabrication signal (cross-model disagreement fallback).
const FABRICATION_FIELDS = [
  'GRANTOR', 'GRANTEE', 'DATE EXECUTED', 'DATE RECORDED', 'RECORDING REF',
];

const MAX_TOKENS    = 2000;
const MAX_RAW_BYTES = 14_000_000;
const SUPPORTED_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.tif', '.tiff', '.webp']);

const __dirname    = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR  = join(__dirname, 'ocr-comparison-results');

// ---------------------------------------------------------------------------
// Normalisation for accuracy comparison
// ---------------------------------------------------------------------------
function normDate(s) {
  // Collapse ordinals and abbreviations so "April 7th, 1923" == "April 7, 1923"
  return s
    .toLowerCase()
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/\bjan\b/g, 'january').replace(/\bfeb\b/g, 'february')
    .replace(/\bmar\b/g, 'march').replace(/\bapr\b/g, 'april')
    .replace(/\bjun\b/g, 'june').replace(/\bjul\b/g, 'july')
    .replace(/\baug\b/g, 'august').replace(/\bsep\b/g, 'september')
    .replace(/\boct\b/g, 'october').replace(/\bnov\b/g, 'november')
    .replace(/\bdec\b/g, 'december')
    .replace(/\ba\.d\.\s*/g, '').replace(/[.,;:'"]/g, '')
    .replace(/\s+/g, ' ').trim();
}

function normName(s) {
  return s
    .toLowerCase()
    .replace(/[.,;:'"]/g, '')
    .replace(/\band\s+wife\b/g, 'and wife')
    .replace(/\s+/g, ' ').trim();
}

function normRef(s) {
  return s
    .toLowerCase()
    .replace(/\bvolume\b/g, 'vol').replace(/\bpage\b/g, 'page').replace(/\bpg\b/g, 'page')
    .replace(/[.,;:'"]/g, '').replace(/\s+/g, ' ').trim();
}

function normalise(fieldKey, value) {
  if (!value) return '';
  const s = String(value).trim();
  if (fieldKey.includes('DATE')) return normDate(s);
  if (fieldKey === 'RECORDING_REF') return normRef(s);
  return normName(s);
}

// CORRECT = normalised exact match
// PARTIAL = one contains the other (handles "and wife" trailing clauses)
// WRONG   = non-empty mismatch
// MISSED  = model returned empty/n/a when GT has a value
function scoreField(modelRaw, gtValue, isDegraded) {
  if (isDegraded) {
    return isAbstained(modelRaw) ? 'correct_illegible' : 'fabricated';
  }
  if (gtValue === undefined || gtValue === null) return 'no_gt';
  if (!modelRaw || isAbstained(modelRaw)) return 'missed';
  const gtKey = ''; // normalise uses the gt field key; we pass empty for generic norm
  const mn = normalise('', modelRaw);
  const gn = normalise('', gtValue);
  if (mn === gn) return 'correct';
  if (mn.includes(gn) || gn.includes(mn)) return 'partial';
  return 'wrong';
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function mediaTypeForExt(ext) {
  switch (ext.toLowerCase()) {
    case '.pdf':  return 'application/pdf';
    case '.png':  return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.tif':
    case '.tiff': return 'image/tiff';
    case '.webp': return 'image/webp';
    default:      return 'application/octet-stream';
  }
}

function safeName(s) { return String(s).replace(/[^a-z0-9._-]+/gi, '_'); }

function parseFields(text) {
  const fields = {};
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^([A-Z][A-Z /-]*[A-Z]):\s*(.*)$/);
    if (m) fields[m[1].trim()] = m[2].trim();
  }
  return fields;
}

function isAbstained(value) {
  if (!value) return true;
  return /illegible|not visible|verify manually|unclear|^n\/a$|^none$|not applicable/i.test(String(value).trim());
}

function countIllegible(text) {
  const m = String(text || '').match(/illegible|not visible|verify manually/gi);
  return m ? m.length : 0;
}

function truncate(s, n = 60) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

async function runOne(model, messages) {
  const started = Date.now();
  const res = await invokeModel({
    model: model.id,
    maxTokens: MAX_TOKENS,
    system: ABSTRACTION_PROMPT,
    messages,
    ...model.thinking,
  });
  return { text: res.text || '', usage: res.usage || {}, latencyMs: Date.now() - started };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const folder = process.argv[2];
  if (!folder) {
    console.error('Usage: node scripts/compare-ocr-models.mjs <folder>');
    process.exit(1);
  }
  if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
    console.error('GEMINI_API_KEY not set. Run: source .env.local && node ...');
    process.exit(1);
  }

  // Load ground truth if present
  const gtPath = join(folder, 'ground_truth.json');
  let groundTruth = null;
  if (existsSync(gtPath)) {
    groundTruth = Object.fromEntries(
      JSON.parse(readFileSync(gtPath, 'utf8')).map(e => [e.file, e]),
    );
    console.log(`Ground truth loaded: ${Object.keys(groundTruth).length} entries`);
  } else {
    console.log('No ground_truth.json found — using cross-model fabrication signal only.');
  }

  const entries = readdirSync(folder)
    .filter(f => SUPPORTED_EXT.has(extname(f).toLowerCase()))
    .sort();
  if (!entries.length) {
    console.error(`No supported files found in ${folder}`);
    process.exit(1);
  }

  mkdirSync(RESULTS_DIR, { recursive: true });
  console.log(`\nModels: ${MODELS.map(m => m.id).join(', ')}`);
  console.log(`Documents: ${entries.length}\n`);

  const docResults = [];

  for (const file of entries) {
    const fullPath = join(folder, file);
    if (!statSync(fullPath).isFile()) continue;
    const bytes = readFileSync(fullPath);
    const chunk = {
      id: `cmp_${safeName(file)}`,
      jobId: 'cmp',
      documentId: `doc_${safeName(file)}`,
      originalFilename: file,
      mediaType: mediaTypeForExt(extname(file)),
    };

    if (bytes.byteLength > MAX_RAW_BYTES) {
      console.log(`- ${file}: SKIPPED (${(bytes.byteLength / 1e6).toFixed(1)} MB)`);
      docResults.push({ name: file, skipped: 'too_large' });
      continue;
    }

    let delivery;
    try { delivery = await resolveChunkDelivery(chunk, bytes); }
    catch (err) {
      docResults.push({ name: file, skipped: `delivery_error: ${err.message}` });
      continue;
    }
    const mode = delivery?.mode || 'visual';
    const messages = buildAbstractMessagesForChunk(chunk, bytes, 0, delivery);
    const gt = groundTruth?.[file] || null;

    const modeNote = mode === 'text' ? '  ⚠ text-extracted locally — not an OCR test' : '';
    console.log(`- ${file}${modeNote}`);

    const perModel = {};
    for (const model of MODELS) {
      try {
        const out = await runOne(model, messages);
        const fields = parseFields(out.text);

        // Score each accuracy field against ground truth
        const scores = {};
        if (gt) {
          for (const { gt: gtKey, parsed } of ACCURACY_FIELDS) {
            const isDeg = gt.degraded_fields?.includes(gtKey) ||
                          (gt.degraded_stamp && (gtKey === 'DATE_RECORDED' || gtKey === 'RECORDING_REF'));
            const modelVal = fields[parsed] ?? '';
            const gtVal = gt.fields?.[gtKey];
            scores[gtKey] = scoreField(modelVal, gtVal, isDeg);
          }
        }

        perModel[model.id] = { ...out, fields, scores };
        writeFileSync(
          join(RESULTS_DIR, `${safeName(file)}.${safeName(model.id)}.txt`),
          out.text,
        );

        const scoreStr = gt
          ? ' | ' + ACCURACY_FIELDS.map(({ gt: k }) => {
              const s = scores[k];
              if (s === 'correct') return '✓';
              if (s === 'partial') return '~';
              if (s === 'correct_illegible') return '⊘';
              if (s === 'fabricated') return '✗FAB';
              if (s === 'missed') return '?';
              if (s === 'wrong') return '✗';
              return '-';
            }).join(' ')
          : '';
        console.log(`    ${model.id}: ${out.latencyMs}ms  in=${out.usage.input_tokens ?? '?'} out=${out.usage.output_tokens ?? '?'}  illegible=${countIllegible(out.text)}${scoreStr}`);
      } catch (err) {
        perModel[model.id] = { error: err.message };
        console.log(`    ${model.id}: ERROR ${err.message}`);
      }
    }
    docResults.push({ name: file, mode, gt, perModel });
  }

  writeFileSync(join(RESULTS_DIR, 'report.md'), buildReport(docResults, groundTruth));
  console.log(`\nReport: ${join(RESULTS_DIR, 'report.md')}`);
  console.log(`Raw outputs: ${RESULTS_DIR}/<doc>.<model>.txt`);
  if (groundTruth) {
    console.log('\nScore legend: ✓=correct  ~=partial  ⊘=correctly flagged illegible  ✗FAB=fabricated  ?=missed  ✗=wrong');
    console.log('Columns: GRANTOR  GRANTEE  DATE_EXECUTED  DATE_RECORDED  RECORDING_REF');
  }
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------
function buildReport(docResults, groundTruth) {
  const modelIds = MODELS.map(m => m.id);
  const hasGT = !!groundTruth;
  const lines = [];
  lines.push('# OCR/abstraction model comparison\n');
  lines.push(`Models: ${modelIds.map(m => `\`${m}\``).join(', ')}\n`);

  // ── per-model tallies ──────────────────────────────────────────────────────
  const tally = Object.fromEntries(modelIds.map(id => [id, {
    docs: 0, latencySum: 0, inTok: 0, outTok: 0, abstains: 0,
    fillWhileOtherAbstained: 0, errors: 0,
    acc: Object.fromEntries(ACCURACY_FIELDS.map(f => [f.gt, { correct: 0, partial: 0, wrong: 0, missed: 0, fabricated: 0, correct_illegible: 0, total: 0, total_degraded: 0 }])),
  }]));

  // fabrication disagreements (cross-model, no GT needed)
  const disagreements = [];

  for (const doc of docResults) {
    if (doc.skipped || !doc.perModel) continue;
    for (const id of modelIds) {
      const r = doc.perModel[id];
      if (!r) continue;
      if (r.error) { tally[id].errors++; continue; }
      tally[id].docs++;
      tally[id].latencySum += r.latencyMs || 0;
      tally[id].inTok  += r.usage?.input_tokens || 0;
      tally[id].outTok += r.usage?.output_tokens || 0;

      // accuracy tallying
      if (hasGT && r.scores) {
        for (const { gt: gtKey } of ACCURACY_FIELDS) {
          const s = r.scores[gtKey];
          const at = tally[id].acc[gtKey];
          if (!s || s === 'no_gt') continue;
          at.total++;
          if (s === 'correct_illegible') { at.correct_illegible++; at.total_degraded++; }
          else if (s === 'fabricated') { at.fabricated++; at.total_degraded++; }
          else if (s === 'correct') at.correct++;
          else if (s === 'partial') at.partial++;
          else if (s === 'wrong')   at.wrong++;
          else if (s === 'missed')  at.missed++;
        }
      }
    }

    // cross-model fabrication disagreements (FABRICATION_FIELDS)
    for (const field of FABRICATION_FIELDS) {
      const states = {};
      let anyAbstain = false, anyFill = false;
      for (const id of modelIds) {
        const r = doc.perModel[id];
        if (!r || r.error) continue;
        const value = r.fields?.[field] ?? '';
        const abstained = isAbstained(value);
        states[id] = { value, abstained };
        if (abstained) anyAbstain = true; else anyFill = true;
      }
      for (const id of modelIds) {
        if (states[id]?.abstained) tally[id].abstains++;
      }
      if (anyAbstain && anyFill) {
        for (const id of modelIds) {
          if (states[id] && !states[id].abstained) tally[id].fillWhileOtherAbstained++;
        }
        disagreements.push({ doc: doc.name, field, states });
      }
    }
  }

  // ── cost + summary ─────────────────────────────────────────────────────────
  lines.push('## Performance & cost summary\n');
  lines.push('| Model | Docs | Avg latency | In tok | Out tok | Cost (run) | Est. $/1k docs | Errors |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const id of modelIds) {
    const t = tally[id];
    const avg = t.docs ? Math.round(t.latencySum / t.docs) : 0;
    const p = PRICING[id] || { in: 0, out: 0 };
    const costRun = (t.inTok / 1e6) * p.in + (t.outTok / 1e6) * p.out;
    const per1k   = t.docs ? (costRun / t.docs) * 1000 : 0;
    lines.push(`| \`${id}\` | ${t.docs} | ${avg}ms | ${t.inTok} | ${t.outTok} | $${costRun.toFixed(4)} | **$${per1k.toFixed(2)}** | ${t.errors} |`);
  }
  lines.push('');
  lines.push('> **Est. $/1k docs** = per-doc token average × 1,000. Standard tier pricing. Batch API ≈ half.\n');

  // ── accuracy table (only when GT present) ─────────────────────────────────
  if (hasGT) {
    lines.push('## Transcription accuracy\n');
    lines.push('> Scored against `ground_truth.json`. **GRANTOR / GRANTEE / DATE EXECUTED / DATE RECORDED / RECORDING REF.**');
    lines.push('> Degraded fields: correct = model wrote ILLEGIBLE; fabricated = model invented a value.\n');

    // overall accuracy row per model
    lines.push('### Overall\n');
    lines.push('| Model | Correct | Partial | Wrong | Missed | Deg-correct (✓ILL) | Fabricated (✗) |');
    lines.push('|---|---|---|---|---|---|---|');
    for (const id of modelIds) {
      const acc = tally[id].acc;
      let correct = 0, partial = 0, wrong = 0, missed = 0, ci = 0, fab = 0, total = 0, totalDeg = 0;
      for (const { gt: k } of ACCURACY_FIELDS) {
        correct += acc[k].correct; partial += acc[k].partial;
        wrong   += acc[k].wrong;  missed  += acc[k].missed;
        ci      += acc[k].correct_illegible; fab += acc[k].fabricated;
        total   += acc[k].total; totalDeg += acc[k].total_degraded;
      }
      const pct = n => total ? Math.round(n / total * 100) + '%' : '-';
      const dpct = n => totalDeg ? Math.round(n / totalDeg * 100) + '%' : '-';
      lines.push(`| \`${id}\` | ${correct} (${pct(correct)}) | ${partial} (${pct(partial)}) | ${wrong} (${pct(wrong)}) | ${missed} (${pct(missed)}) | ${ci} (${dpct(ci)}) | **${fab}** (${dpct(fab)}) |`);
    }
    lines.push('');

    // per-field breakdown
    lines.push('### By field\n');
    lines.push('| Field | Model | Correct | Partial | Wrong | Missed | Deg-correct | Fabricated |');
    lines.push('|---|---|---|---|---|---|---|---|');
    for (const { gt: k } of ACCURACY_FIELDS) {
      for (const id of modelIds) {
        const a = tally[id].acc[k];
        lines.push(`| ${k} | \`${id}\` | ${a.correct} | ${a.partial} | ${a.wrong} | ${a.missed} | ${a.correct_illegible} | **${a.fabricated}** |`);
      }
      lines.push('| | | | | | | | |');
    }
    lines.push('');

    // per-doc accuracy grid
    lines.push('### Per-document accuracy grid\n');
    lines.push('> ✓=correct  ~=partial  ✗=wrong  ?=missed  ⊘=correctly illegible  **F**=fabricated\n');
    const fieldCols = ACCURACY_FIELDS.map(f => f.gt.replace('_', ' '));
    lines.push('| Doc | Model | ' + fieldCols.join(' | ') + ' |');
    lines.push('|---|---|' + fieldCols.map(() => '---').join('|') + '|');
    for (const doc of docResults) {
      if (doc.skipped || !doc.perModel || !doc.gt) continue;
      const shortName = doc.name.replace('.png', '').replace('.pdf', '').slice(0, 30);
      for (const id of modelIds) {
        const r = doc.perModel[id];
        if (!r || r.error) continue;
        const cells = ACCURACY_FIELDS.map(({ gt: k }) => {
          const s = r.scores?.[k] || '-';
          return s === 'correct' ? '✓' : s === 'partial' ? '~' : s === 'wrong' ? '✗' :
                 s === 'missed' ? '?' : s === 'correct_illegible' ? '⊘' :
                 s === 'fabricated' ? '**F**' : '-';
        });
        lines.push(`| ${shortName} | \`${id}\` | ${cells.join(' | ')} |`);
      }
      lines.push('| | | | | | | |');
    }
    lines.push('');
  }

  // ── cross-model fabrication signal ────────────────────────────────────────
  lines.push('## Cross-model disagreements (fabrication signal)\n');
  lines.push('> Fields where one model wrote ILLEGIBLE/not visible but another gave a confident value.');
  lines.push('> With ground truth this supplements the accuracy table; without GT it is the primary signal.\n');
  if (!disagreements.length) {
    lines.push('_No cross-model identity-field disagreements found._\n');
  } else {
    for (const d of disagreements) {
      lines.push(`### ${d.doc} — ${d.field}`);
      lines.push('| Model | Value | State |');
      lines.push('|---|---|---|');
      for (const id of modelIds) {
        const s = d.states[id];
        if (!s) continue;
        lines.push(`| \`${id}\` | ${truncate(s.value) || '_(blank)_'} | ${s.abstained ? 'abstained' : '**FILLED**'} |`);
      }
      lines.push('');
    }
  }

  // ── skipped / text-mode notes ─────────────────────────────────────────────
  const skipped  = docResults.filter(d => d.skipped);
  const textMode = docResults.filter(d => d.mode === 'text');
  if (skipped.length) {
    lines.push('## Skipped\n');
    skipped.forEach(d => lines.push(`- ${d.name}: ${d.skipped}`));
    lines.push('');
  }
  if (textMode.length) {
    lines.push('## Text-extracted docs (not OCR tests)\n');
    lines.push('Local unpdf extraction succeeded — model did not perform OCR:');
    textMode.forEach(d => lines.push(`- ${d.name}`));
    lines.push('');
  }

  return lines.join('\n');
}

main().catch(err => { console.error(err); process.exit(1); });
