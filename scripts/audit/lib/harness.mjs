import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { createRecorder, exitCodeFor } from './checks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(process.env.AUDIT_REPO || path.join(HERE, '../../..'));
export const OUT = path.resolve(process.env.AUDIT_OUT || path.join(os.tmpdir(), 'titlework-audit', 'latest'));
export const fixture = name => fs.readFileSync(path.join(HERE, '../fixtures', name), 'utf8');

export const NOISE = /X-Frame-Options|ERR_FAILED|Failed to load resource/;
export const clean = errs => errs.filter(e => e.startsWith('pageerror:') || !NOISE.test(e));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

export async function startServer(logName) {
  const port = Number(process.env.AUDIT_PORT) || await freePort();
  fs.mkdirSync(OUT, { recursive: true });
  const log = fs.openSync(path.join(OUT, `${logName}.server.log`), 'w');
  const child = spawn(process.execPath, ['server.js'], {
    cwd: REPO,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), NODE_ENV: 'test' },
    stdio: ['ignore', log, log],
  });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(timer);
    }
    fs.closeSync(log);
  };
  const base = `http://127.0.0.1:${port}/`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(base + 'api/healthz');
      if (r.ok) {
        const health = await r.json().catch(() => ({}));
        const served = await (await fetch(base)).text();
        if (served !== fs.readFileSync(path.join(REPO, 'public/index.html'), 'utf8')) {
          await stop();
          throw new Error(`server on ${port} does not serve ${REPO}/public/index.html`);
        }
        return { base, port, version: health?.release?.version || health?.version || null, stop };
      }
    } catch (err) { if (/does not serve/.test(err.message)) throw err; }
    await new Promise(r => setTimeout(r, 100));
  }
  await stop();
  throw new Error(`server.js did not answer /api/healthz on port ${port} (log: ${logName}.server.log)`);
}

export async function launch() {
  if (process.env.AUDIT_CHROME === 'real') return { browser: await chromium.launch({ channel: 'chrome', headless: false }), engine: 'real Google Chrome (headed)' };
  if (process.env.AUDIT_CHROME_PATH) return { browser: await chromium.launch({ executablePath: process.env.AUDIT_CHROME_PATH, headless: true }), engine: `headless ${process.env.AUDIT_CHROME_PATH}` };
  return { browser: await chromium.launch({ headless: true }), engine: 'Playwright chromium headless shell' };
}

export const DESKTOP = { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 };
export const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const now = Date.now();
const iso = ms => new Date(now - ms).toISOString();
export const JOBS = {
  job_complete: {
    job: { id: 'job_complete', status: 'complete', name: 'NW/4 Sec 22 Larkspur', subjectTract: 'NW/4 Sec. 22, Block C-9, Larkspur Rail Survey', totalDocuments: 400, completedDocuments: 400, createdAt: iso(600000), updatedAt: iso(252000) },
    result: { finalTitleOpinion: fixture('opinion.md'), warnings: [], failedDocuments: [] },
  },
  job_partial: {
    job: { id: 'job_partial', status: 'partial_failed', subjectTract: 'NW/4 Sec. 22 (partial run)', totalDocuments: 400, completedDocuments: 396, failedDocuments: 4, createdAt: iso(600000), updatedAt: iso(60000) },
    result: { finalTitleOpinion: fixture('opinion.md'), warnings: ['synthesis_driver:browser', '4 abstraction chunk(s) failed and were omitted from browser synthesis.', 'Final opinion was truncated at the model output limit; the last section may be incomplete.'], failedDocuments: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] },
  },
  job_defect: {
    job: { id: 'job_defect', status: 'complete', subjectTract: 'Smith tract (62.5% stated)', totalDocuments: 3, completedDocuments: 3, createdAt: iso(600000), updatedAt: iso(60000) },
    result: { finalTitleOpinion: fixture('defect-625.md'), warnings: [], failedDocuments: [] },
  },
  job_over: {
    job: { id: 'job_over', status: 'complete', subjectTract: 'Smith tract (over-allocated)', totalDocuments: 3, completedDocuments: 3, createdAt: iso(600000), updatedAt: iso(60000) },
    result: { finalTitleOpinion: fixture('over-alloc.md'), warnings: [], failedDocuments: [] },
  },
  job_fallback: {
    job: { id: 'job_fallback', status: 'complete', subjectTract: 'Malformed output job', totalDocuments: 12, completedDocuments: 12, createdAt: iso(600000), updatedAt: iso(60000) },
    result: { finalTitleOpinion: 'The model returned prose instead of the required sections.\n\n## Notes\n- Owner list unavailable\n\n| a | b |\n|---|---|\n| 1 | 2 |', warnings: [], failedDocuments: [] },
  },
  job_running: {
    job: { id: 'job_running', status: 'abstracting', name: 'SE/4 Sec 14 Reeves', subjectTract: 'SE/4 of Section 14, T-3-N, R-5-W, Reeves County, TX', totalDocuments: 12, completedDocuments: 5, createdAt: iso(120000), updatedAt: iso(1000) },
  },
  job_failed: {
    job: { id: 'job_failed', status: 'failed', subjectTract: 'Failed run', totalDocuments: 12, completedDocuments: 0, error: 'Synthesis failed after 3 attempts.', createdAt: iso(120000), updatedAt: iso(1000) },
  },
  job_canceled: {
    job: { id: 'job_canceled', status: 'canceled', subjectTract: 'Canceled run', totalDocuments: 12, completedDocuments: 4, createdAt: iso(120000), updatedAt: iso(1000) },
  },
};

export const json = (r, status, body) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

// Playwright runs routes in reverse registration order: routes added after this call take precedence.
export async function newPage(ctx, opts = {}) {
  const jobs = opts.jobs || structuredClone(JOBS);
  const page = await ctx.newPage();
  const errors = [];
  const calls = [];
  const external = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.route('**/*', r => {
    const u = new URL(r.request().url());
    if (u.hostname === '127.0.0.1' || u.protocol === 'data:' || u.protocol === 'blob:') return r.fallback();
    if (opts.allowCdn && u.hostname === 'cdnjs.cloudflare.com') return r.fallback();
    external.push(u.origin + u.pathname);
    return r.abort();
  });
  await page.route('**/api/**', r => {
    const req = r.request();
    const u = new URL(req.url());
    calls.push(`${req.method()} ${u.pathname}`);
    if (u.pathname === '/api/healthz') return r.continue();
    if (opts.password && req.headers()['x-app-password'] !== opts.password) return json(r, 401, { error: 'Unauthorized' });
    if (u.pathname === '/api/analyze') return json(r, 200, { ok: true });
    const m = u.pathname.match(/^\/api\/jobs\/([^/]+)(?:\/(.*))?$/);
    if (m && req.method() === 'GET') {
      const j = jobs[decodeURIComponent(m[1])];
      if (!j) return json(r, 404, { error: 'Job not found.' });
      if (!m[2]) return json(r, 200, { job: j.job });
      if (m[2] === 'result') return j.result ? json(r, 200, { result: j.result }) : json(r, 404, { error: 'No result.' });
    }
    return json(r, 404, { error: `unmocked ${req.method()} ${u.pathname}` });
  });
  return { page, errors, calls, external, jobs };
}

export async function withPage(browser, opts, fn) {
  const ctx = await browser.newContext({ ...(opts.device || DESKTOP), reducedMotion: opts.motion || 'reduce' });
  try {
    if (opts.init) for (const script of [].concat(opts.init)) await ctx.addInitScript(script);
    const p = await newPage(ctx, opts);
    p.dialogs = [];
    p.page.on('dialog', d => { p.dialogs.push({ type: d.type(), message: d.message() }); (opts.dialog === 'dismiss' ? d.dismiss() : d.accept()).catch(() => {}); });
    for (const [match, handler] of opts.overrides || []) await p.page.route(match, handler);
    return await fn({ ...p, ctx });
  } finally {
    await ctx.close().catch(() => {});
  }
}

export function visibleText(page, selector) {
  return page.evaluate(sel => {
    const el = document.querySelector(sel);
    if (!el) return '';
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (el.hidden || s.display === 'none' || s.visibility === 'hidden' || r.width === 0 || r.height === 0) return '';
    return el.innerText.replace(/\s+/g, ' ').trim();
  }, selector);
}

const pdf = title => Buffer.from(`%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 44>>stream
BT /F1 18 Tf 72 720 Td (${title}) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

export function fileObjs(n, { padBytes = 0, start = 1 } = {}) {
  return Array.from({ length: n }, (_, j) => {
    const i = start - 1 + j;
    const k = String(i + 1).padStart(3, '0');
    if (i % 11 === 2) return { name: `${k}_Runsheet_Sec22.csv`, mimeType: 'text/csv', buffer: Buffer.from('grantor,grantee,date\nVane,Pettibone,1948-03-02\n'.repeat(40)) };
    if (i % 11 === 3) return { name: `${k}_MineralDeed_scan.png`, mimeType: 'image/png', buffer: PNG };
    const name = `${k}_WarrantyDeed_Vane_to_Pettibone_${1900 + i}.pdf`;
    return { name, mimeType: 'application/pdf', buffer: Buffer.concat([pdf(name), Buffer.alloc(padBytes, 32)]) };
  });
}

export const READ_GATE = () => {
  const gate = { open: true, waiting: [] };
  window.__readGate = gate;
  window.__closeReadGate = () => { gate.open = false; };
  window.__openReadGate = () => { gate.open = true; gate.waiting.splice(0).forEach(run => run()); };
  for (const name of ['readAsDataURL', 'readAsText', 'readAsArrayBuffer', 'readAsBinaryString']) {
    const orig = FileReader.prototype[name];
    if (!orig) continue;
    FileReader.prototype[name] = function (...args) {
      if (gate.open) return orig.apply(this, args);
      gate.waiting.push(() => orig.apply(this, args));
    };
  }
};

export async function measure(page) {
  return page.evaluate(() => {
    const over = [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > innerWidth + 1; })
      .map(e => e.id || String(e.className).split(' ')[0] || e.tagName).slice(0, 8);
    return { overflowX: document.documentElement.scrollWidth - window.innerWidth, pastRightEdge: over };
  });
}

export async function fullShot(page, file) {
  const vp = page.viewportSize();
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: vp.width, height: Math.min(h, 12000) });
  await page.waitForTimeout(150);
  await page.screenshot({ path: file });
  await page.setViewportSize(vp);
}

export async function runProbe(probe, body) {
  const rec = createRecorder(probe);
  const step = async (name, fn) => { try { await fn(); } catch (err) { rec.crash(name, err); } };
  let srv = null;
  let browser = null;
  let info = null;
  const onSignal = sig => { srv?.stop().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143)); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    srv = await startServer(probe);
    const launched = await launch();
    browser = launched.browser;
    const uaCtx = await browser.newContext();
    const userAgent = await (await uaCtx.newPage()).evaluate(() => navigator.userAgent);
    await uaCtx.close();
    info = { engine: launched.engine, version: browser.version(), userAgent, appVersion: srv.version, repo: path.basename(REPO), port: srv.port, out: OUT };
    console.log(`# ${probe}: ${info.engine} ${info.version} | ${userAgent} | app ${info.appVersion} | port ${info.port} | out ${OUT}`);
    await body({ rec, step, srv, browser });
  } catch (err) {
    rec.crash(probe, err);
  } finally {
    await browser?.close().catch(() => {});
    await srv?.stop().catch(() => {});
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  const summary = { ...rec.summary(), browser: info };
  fs.writeFileSync(path.join(OUT, `${probe}.json`), JSON.stringify(summary, null, 2));
  console.log(`# ${probe}: ${summary.passed}/${summary.total} passed, ${summary.failed} failed`);
  process.exitCode = exitCodeFor([summary]);
  return summary;
}
