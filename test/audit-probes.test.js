import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecorder, exitCodeFor, formatRow } from '../scripts/audit/lib/checks.mjs';
import { clean } from '../scripts/audit/lib/harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const auditDir = join(here, '../scripts/audit');
const quiet = { log: () => {} };

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('a check row keeps name, observed, expected, pass and errors', () => {
  const rec = createRecorder('p0', quiet);
  const row = rec.check('one', { a: 1 }, 'a is 1', true, ['console: noise']);
  assert.deepEqual(row, { name: 'one', observed: { a: 1 }, expected: 'a is 1', pass: true, errors: ['console: noise'] });
});

test('an uncaught page exception fails an otherwise passing check', () => {
  const rec = createRecorder('p0', quiet);
  const row = rec.check('two', 'x', 'x', true, ['pageerror: boom']);
  assert.equal(row.pass, false);
});

test('pass must be a real boolean true; truthy values do not pass', () => {
  const rec = createRecorder('p0', quiet);
  assert.equal(rec.check('three', 1, 'x', 1).pass, false);
  assert.equal(rec.check('four', 1, 'x', 'yes').pass, false);
});

test('clean() keeps every pageerror after three console diagnostics, even one that looks like noise', () => {
  const captured = ['console: diagnostic one', 'console: diagnostic two', 'console: diagnostic three', 'console: Failed to load resource: 404', 'pageerror: Failed to load resource handler', 'pageerror: INDEPENDENT_UNCAUGHT_DEFECT'];
  const kept = clean(captured);
  assert.deepEqual(kept, ['console: diagnostic one', 'console: diagnostic two', 'console: diagnostic three', 'pageerror: Failed to load resource handler', 'pageerror: INDEPENDENT_UNCAUGHT_DEFECT']);
  const row = createRecorder('p0', quiet).check('pdf', 'ok', 'ok', true, kept);
  assert.equal(row.pass, false);
  assert.equal(row.errors.length, 5);
});

test('every probe check receives the full clean(errors) list, never a slice or filter of it', () => {
  for (const f of ['p4-actions.mjs', 'p6-pdf-recent.mjs', 'motion-reflow.mjs']) {
    const text = readFileSync(join(auditDir, f), 'utf8');
    const checks = text.match(/rec\.check\(/g).length;
    const full = (text.match(/clean\(errors\)(?![.\w])/g) || []).length;
    assert.equal(full, checks, `${f}: ${checks} rec.check calls, ${full} pass clean(errors) whole`);
    assert.doesNotMatch(text, /clean\(errors\)\s*\.|errors\.(slice|filter)\(/, `${f} narrows captured errors`);
  }
});

test('a crash is recorded as a failing row', () => {
  const rec = createRecorder('p0', quiet);
  const row = rec.crash('setup', new Error('Timeout 30000ms exceeded'));
  assert.equal(row.pass, false);
  assert.match(row.errors[0], /Timeout/);
});

test('exit code is 0 only when every probe recorded checks and all passed', () => {
  const ok = createRecorder('a', quiet); ok.check('x', 1, 1, true);
  const bad = createRecorder('b', quiet); bad.check('x', 1, 2, false);
  const empty = createRecorder('c', quiet);
  assert.equal(exitCodeFor([ok.summary()]), 0);
  assert.equal(exitCodeFor([ok.summary(), bad.summary()]), 1);
  assert.equal(exitCodeFor([ok.summary(), empty.summary()]), 1, 'a probe with zero checks is a failure');
  assert.equal(exitCodeFor([]), 1);
});

test('summary counts passed and failed rows', () => {
  const rec = createRecorder('p', quiet);
  rec.check('a', 1, 1, true); rec.check('b', 1, 2, false); rec.crash('c', new Error('x'));
  const s = rec.summary();
  assert.equal(s.probe, 'p');
  assert.equal(s.total, 3);
  assert.equal(s.passed, 1);
  assert.equal(s.failed, 2);
});

test('formatted row states PASS or FAIL first', () => {
  assert.match(formatRow({ name: 'n', observed: { v: 1 }, expected: 'e', pass: false, errors: [] }), /^FAIL n \| \{"v":1\} \| e \| -$/);
});

const walk = dir => readdirSync(dir).flatMap(f => {
  const p = join(dir, f);
  if (f === 'node_modules') return [];
  return statSync(p).isDirectory() ? walk(p) : [p];
});

test('audit files carry no machine-specific home paths', () => {
  const offenders = [];
  for (const file of walk(auditDir)) {
    const text = readFileSync(file, 'utf8');
    if (/\/Users\/|\/home\/[a-z]|C:\\\\Users/i.test(text)) offenders.push(relative(auditDir, file));
  }
  assert.deepEqual(offenders, []);
});

test('active probes import only node:, their own files, or packages declared in package.json', () => {
  const pkg = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8'));
  const declared = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})]);
  const pkgName = s => (s.startsWith('@') ? s.split('/').slice(0, 2).join('/') : s.split('/')[0]);
  for (const f of ['p4-actions.mjs', 'p6-pdf-recent.mjs', 'motion-reflow.mjs', 'run.mjs', 'lib/harness.mjs', 'lib/checks.mjs']) {
    const text = readFileSync(join(auditDir, f), 'utf8');
    const specs = [...text.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)].map(m => m[1]);
    for (const s of specs) assert.ok(s.startsWith('node:') || s.startsWith('./') || declared.has(pkgName(s)), `${f} imports ${s}`);
  }
  assert.ok(declared.has('playwright-core'), 'playwright-core must be declared for the probes');
});

test('the reduced-motion check requires the busy spinner to keep looping, and the 2 MB export asserts no wall-clock limit', () => {
  const motion = readFileSync(join(auditDir, 'motion-reflow.mjs'), 'utf8');
  assert.match(motion, /spinning\.length > 0/, 'reduced-motion check must assert the spinner still animates');
  const p6 = readFileSync(join(auditDir, 'p6-pdf-recent.mjs'), 'utf8');
  assert.doesNotMatch(p6, /ms\s*<\s*\d+/, 'a wall-clock threshold makes the 2 MB export check network-dependent');
  assert.doesNotMatch(p6, /allowCdn|cdnjs\.cloudflare\.com/, 'PDF probes run against locally served jsPDF without CDN access');
  assert.match(p6, /\/vendor\/jspdf\/jspdf\.umd\.min\.js/, 'p6 blocks the local jsPDF vendor route to verify missing-script recovery');
  const harness = readFileSync(join(auditDir, 'lib/harness.mjs'), 'utf8');
  assert.doesNotMatch(harness, /allowCdn|cdnjs\.cloudflare\.com/, 'audit harness aborts all external hosts');
});

test('the production image context excludes the audit probes', () => {
  const lines = readFileSync(join(here, '../.dockerignore'), 'utf8').split('\n').map(l => l.trim());
  assert.ok(lines.includes('scripts/audit/'), '.dockerignore must list scripts/audit/');
});

test('archived originals are inert: .before extension, never .mjs', () => {
  const files = readdirSync(join(auditDir, 'before'));
  for (const name of ['p4-actions.mjs.before', 'p6-pdf-recent.mjs.before', 'motion-reflow.mjs.before', 'lib.mjs.before', 'harness.mjs.before']) {
    assert.ok(files.includes(name), `missing ${name}`);
  }
  assert.deepEqual(files.filter(f => /\.(m?js|cjs)$/.test(f)), []);
});

let passed = 0;
let failed = 0;
for (const t of tests) {
  try {
    await t.fn();
    passed++;
    console.log(`✓ ${t.name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${t.name}\n  ${err.message.split('\n')[0]}`);
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
