#!/usr/bin/env node
/**
 * Structural + TLC check for the synthesis merge/cancel protocol.
 * Exit 0 only when the code still has the merge gate, TLC ran, must-hold
 * invariants hold, and NoResultWhileCanceled still fails (known finding).
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const MODEL_DIR = join(__dirname, 'model');
const SPEC = join(MODEL_DIR, 'SynthesisMergeCancel.tla');
const CONFIG = join(MODEL_DIR, 'SynthesisMergeCancel.cfg');
const VIEW = join(MODEL_DIR, 'SynthesisMergeCancelView.mjs');
const SYNTHESIS_JS = join(REPO_ROOT, 'api/_lib/synthesis.js');
const JOBS_JS = join(REPO_ROOT, 'api/_lib/jobs.js');

const TLC_JAR_URL =
  'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar';
const TLC_JAR_SHA256 =
  '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';

/** Invariants that must hold for the current protocol. */
const MUST_HOLD = new Set([
  'TypeOK',
  'CanceledNeverLeaves',
  'SingleMergeOwner',
  'BillOnlyAfterLiveGate',
]);

/**
 * Invariants that currently fail on the real SQL split between INSERT and
 * status CAS (cancel can land between them). A pass here means the race closed.
 */
const KNOWN_FINDINGS = new Set(['NoResultWhileCanceled']);

function fail(message, extra = {}) {
  console.log(JSON.stringify({ ok: false, message, ...extra }, null, 2));
  process.exit(1);
}

function ok(payload) {
  console.log(JSON.stringify({ ok: true, ...payload }, null, 2));
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function checkCodeAnchors() {
  const synthesis = read(SYNTHESIS_JS);
  const jobs = read(JOBS_JS);

  const gateRe =
    /const mergeGateJob = await store\.getJob\(jobId\);\s*const mergeCanceled = mergeGateJob\?\.status === 'canceled';/;
  if (!gateRe.test(synthesis)) {
    fail('processSynthesisJob is missing the mergeCanceled gate before the final merge branches.', {
      file: 'api/_lib/synthesis.js',
      expect: 'mergeGateJob / mergeCanceled check',
    });
  }

  const mergeBranches = [
    /if \(!mergeCanceled && !existingResult && completedSegments\.length === refreshedSegments\.length/,
    /else if \(!mergeCanceled && !existingResult && failedSegments\.length && !stillPending\.length\)/,
  ];
  for (const re of mergeBranches) {
    if (!re.test(synthesis)) {
      fail('A final-merge branch no longer consults mergeCanceled.', {
        file: 'api/_lib/synthesis.js',
        pattern: String(re),
      });
    }
  }

  const claimFn = jobs.slice(jobs.indexOf('async claimSynthesisMerge'));
  if (!claimFn.includes("AND status <> 'canceled'")) {
    fail('claimSynthesisMerge must refuse canceled jobs.', { file: 'api/_lib/jobs.js' });
  }

  const saveFn = jobs.slice(jobs.indexOf('async saveJobResult'));
  if (!/AND status = \$\{job\.status\}/.test(saveFn)) {
    fail('saveJobResult must CAS job status with AND status = ${job.status}.', {
      file: 'api/_lib/jobs.js',
    });
  }
  if (!saveFn.includes("AND aj.status <> 'canceled'")) {
    fail('saveJobResult insert must refuse canceled jobs.', { file: 'api/_lib/jobs.js' });
  }

  return {
    synthesisGate: true,
    claimRefusesCanceled: true,
    saveJobResultCas: true,
  };
}

async function ensureTlcJar() {
  if (process.env.TLA2TOOLS && existsSync(process.env.TLA2TOOLS)) {
    return process.env.TLA2TOOLS;
  }
  const cacheDir = join(homedir(), '.cache', 'tla');
  const jarPath = join(cacheDir, 'tla2tools.jar');
  if (existsSync(jarPath)) {
    const hash = createHash('sha256').update(readFileSync(jarPath)).digest('hex');
    if (hash === TLC_JAR_SHA256) return jarPath;
  }
  mkdirSync(cacheDir, { recursive: true });
  const response = await fetch(TLC_JAR_URL);
  if (!response.ok || !response.body) {
    fail(`Failed to download tla2tools.jar (${response.status}). Set TLA2TOOLS instead.`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(jarPath));
  const hash = createHash('sha256').update(readFileSync(jarPath)).digest('hex');
  if (hash !== TLC_JAR_SHA256) {
    fail('Downloaded tla2tools.jar failed the pinned sha256 check.', { hash, expect: TLC_JAR_SHA256 });
  }
  return jarPath;
}

function findStatechartLauncher() {
  const envOverride = process.env.PSTACK_STATECHART;
  if (envOverride && existsSync(envOverride)) return envOverride;

  const roots = [
    join(homedir(), '.cursor/plugins/cache/cursor-public'),
    join(homedir(), '.cursor/skills'),
  ];
  const needle = join('skills', 'statechart', 'scripts', 'statechart');
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop();
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const ent of entries) {
        const full = join(dir, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === 'node_modules' || ent.name === '.git') continue;
          stack.push(full);
        } else if (ent.name === 'statechart' && full.endsWith(needle)) {
          return full;
        }
      }
    }
  }
  return null;
}

function parseBrokenInvariants(reportText) {
  const broken = new Set();
  for (const name of [...MUST_HOLD, ...KNOWN_FINDINGS]) {
    const heading = new RegExp(`##\\s+${name}\\s+breaks`, 'i');
    if (heading.test(reportText)) broken.add(name);
    const holdsLine = reportText.match(/## Rules that hold\n([^\n#]+)/);
    // absence from holds is not enough; rely on explicit breaks headings + TLC text
    if (new RegExp(`Invariant\\s+${name}\\s+is violated`, 'i').test(reportText)) broken.add(name);
    if (new RegExp(`Error: Invariant\\s+${name}\\s+failed`, 'i').test(reportText)) broken.add(name);
  }
  const holdsMatch = reportText.match(/## Rules that hold\n([^\n]+)/);
  if (holdsMatch) {
    const holding = new Set(
      holdsMatch[1]
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    );
    for (const name of [...MUST_HOLD, ...KNOWN_FINDINGS]) {
      if (!holding.has(name) && reportText.includes(name)) {
        // If named in a breaks section already captured; otherwise leave alone.
      }
    }
  }
  return broken;
}

function runTlc(jarPath) {
  const launcher = findStatechartLauncher();
  if (!launcher) {
    fail(
      'Could not find the pstack statechart launcher. Set PSTACK_STATECHART to skills/statechart/scripts/statechart.',
    );
  }

  const outDir = mkdtempSync(join(tmpdir(), 'synthesis-merge-cancel-'));
  const result = spawnSync(
    launcher,
    [SPEC, '--config', CONFIG, '--view', VIEW, '--out', outDir],
    {
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        TLA2TOOLS: jarPath,
        JAVA: process.env.JAVA || 'java',
      },
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  const reportPath = join(outDir, 'report.md');
  const tlcOutPath = join(outDir, 'tlc.out');
  if (!existsSync(reportPath) || !existsSync(tlcOutPath)) {
    fail('statechart did not produce report.md / tlc.out. TLC did not run.', {
      outDir,
      exitCode: result.status,
      stdout: (result.stdout || '').slice(0, 2000),
      stderr: (result.stderr || '').slice(0, 2000),
    });
  }

  const report = read(reportPath);
  const tlcOut = read(tlcOutPath);
  const combined = `${report}\n${tlcOut}\n${result.stdout || ''}\n${result.stderr || ''}`;
  const broken = parseBrokenInvariants(combined);

  return {
    launcher,
    outDir,
    exitCode: result.status,
    broken: [...broken].sort(),
    report,
    reportSnippet: report.slice(0, 4000),
  };
}

async function main() {
  const command = process.argv[2] || 'check';
  if (command !== 'check') {
    fail(`Unknown command ${command}. Use: node verify.mjs check`);
  }

  const anchors = checkCodeAnchors();
  const jarPath = await ensureTlcJar();
  const tlc = runTlc(jarPath);
  const broken = new Set(tlc.broken);

  const unexpected = [...broken].filter(name => !KNOWN_FINDINGS.has(name));
  const missingFindings = [...KNOWN_FINDINGS].filter(name => !broken.has(name));
  const failedMustHold = [...MUST_HOLD].filter(name => broken.has(name));

  // Cross-check the report's "Rules that hold" line.
  const holdsMatch = tlc.report.match(/## Rules that hold\n([^\n]+)/);
  const holding = new Set(
    (holdsMatch?.[1] || '')
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
  );
  for (const name of MUST_HOLD) {
    if (!holding.has(name)) failedMustHold.push(name);
  }
  for (const name of KNOWN_FINDINGS) {
    if (holding.has(name) && !broken.has(name)) {
      // finding now holds
    } else if (!holding.has(name)) {
      broken.add(name);
    }
  }

  const uniqueFailedMustHold = [...new Set(failedMustHold)];
  if (uniqueFailedMustHold.length || unexpected.length) {
    fail('TLC reported a regression in a must-hold invariant.', {
      anchors,
      broken: [...broken],
      unexpected,
      failedMustHold: uniqueFailedMustHold,
      outDir: tlc.outDir,
      reportSnippet: tlc.reportSnippet,
    });
  }

  const findingsStillFailing = [...KNOWN_FINDINGS].filter(
    name => broken.has(name) || !holding.has(name),
  );
  const findingsNowHolding = [...KNOWN_FINDINGS].filter(name => holding.has(name));

  if (findingsStillFailing.length === 0) {
    fail(
      'NoResultWhileCanceled now holds. If saveJobResult closed the insert/cancel race, update KNOWN_FINDINGS in this script and the skill.',
      {
        anchors,
        outDir: tlc.outDir,
        holding: [...holding],
      },
    );
  }

  ok({
    anchors,
    knownFindings: [...KNOWN_FINDINGS],
    knownFindingsStillFailing: findingsStillFailing,
    knownFindingsNowHolding: findingsNowHolding,
    mustHold: [...MUST_HOLD],
    holding: [...holding],
    outDir: tlc.outDir,
    tla2tools: jarPath,
    note: 'Structural gate intact; must-hold invariants OK; NoResultWhileCanceled still fails (insert vs CAS race).',
  });
}

main().catch(error => {
  fail(error?.message || String(error));
});
