import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodeFor } from './lib/checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBES = ['p4-actions', 'p6-pdf-recent', 'motion-reflow'];
const picked = process.argv.slice(2);
const unknown = picked.filter(p => !PROBES.includes(p));
if (unknown.length) {
  console.error(`Unknown probe(s): ${unknown.join(', ')}. Known: ${PROBES.join(', ')}`);
  process.exit(2);
}
const probes = picked.length ? picked : PROBES;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(process.env.AUDIT_OUT || path.join(os.tmpdir(), 'titlework-audit', stamp));
fs.mkdirSync(out, { recursive: true });

function runOne(probe) {
  const jsonFile = path.join(out, `${probe}.json`);
  fs.rmSync(jsonFile, { force: true });
  const log = fs.createWriteStream(path.join(out, `${probe}.log`));
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(HERE, `${probe}.mjs`)], { env: { ...process.env, AUDIT_OUT: out }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const s of [child.stdout, child.stderr]) s.on('data', d => { process.stdout.write(d); log.write(d); });
    child.on('close', code => {
      log.end();
      let summary;
      try { summary = JSON.parse(fs.readFileSync(jsonFile, 'utf8')); } catch { summary = { probe, total: 0, passed: 0, failed: 0, rows: [], note: 'no summary written' }; }
      if (code !== 0 && summary.failed === 0) {
        summary = { ...summary, failed: summary.failed + 1, total: summary.total + 1, note: `process exited ${code}` };
      }
      resolve({ ...summary, exitCode: code });
    });
  });
}

const summaries = [];
for (const probe of probes) summaries.push(await runOne(probe));
const code = exitCodeFor(summaries);
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ ok: code === 0, probes: summaries }, null, 2));

console.log('\n== audit:ui summary ==');
const b = summaries.find(s => s.browser)?.browser;
if (b) console.log(`browser: ${b.engine} ${b.version} | ${b.userAgent}\napp: ${b.appVersion} (${b.repo})`);
for (const s of summaries) {
  console.log(`${s.failed === 0 && s.total > 0 ? 'PASS' : 'FAIL'} ${s.probe}: ${s.passed}/${s.total} checks passed${s.note ? ` (${s.note})` : ''}`);
  for (const r of s.rows.filter(r => !r.pass)) console.log(`     FAIL ${r.name}`);
}
console.log(`output: ${out}`);
process.exit(code);
