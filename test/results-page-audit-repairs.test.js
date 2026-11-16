// Regression tests for the result-page audit findings R01-R12 and the cross-page findings C01-C02.
// Each runs the real inline script of public/index.html in the VM harness.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StubElement, disposeAll, jsonResponse, loadIndex, makeJobServer, pngFile, tick } from './helpers/browser-index-harness.js';

// The shared stub lacks removeAttribute (renderRecentJobsToolbar calls it); add it here so job loads can run.
if (!StubElement.prototype.removeAttribute) StubElement.prototype.removeAttribute = function removeAttribute(k) { delete this[k]; };

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(here, 'fixtures/title-opinion-sample.md'), 'utf8');
const INDEX = readFileSync(join(here, '../public/index.html'), 'utf8');
const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// A response whose body is not JSON (an HTML error page, a proxy page).
const textResponse = (status, text) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => JSON.parse(text),
  text: async () => text,
});
const squash = s => String(s).replace(/\s+/g, '');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

// ---- Fake jsPDF: records drawn text, pages and orientations; wraps text by a fixed glyph width.
function fakeJsPdf() {
  const log = { texts: [], pages: [], saved: [] };
  class FakeDoc {
    constructor(opts = {}) {
      this.orientation = opts.orientation || 'portrait';
      this.fs = 10;
      log.pages.push(this.orientation);
      const self = this;
      this.internal = {
        pageSize: {
          getWidth: () => (self.orientation === 'landscape' ? 279.4 : 215.9),
          getHeight: () => (self.orientation === 'landscape' ? 215.9 : 279.4),
        },
        getNumberOfPages: () => log.pages.length,
        scaleFactor: 72 / 25.4,
      };
    }
    setFontSize(s) { this.fs = s; }
    getFontSize() { return this.fs; }
    setFillColor() {} setDrawColor() {} setLineWidth() {} rect() {} setTextColor() {} setFont() {} line() {} setPage() {}
    addPage(format, orientation) { if (orientation) this.orientation = orientation; log.pages.push(this.orientation); }
    getTextWidth(t) { return String(t).length * this.fs * 0.19; }
    splitTextToSize(text, width) {
      const per = Math.max(1, Math.floor(width / (this.fs * 0.19)));
      const lines = [];
      for (const para of String(text).split('\n')) {
        let cur = '';
        for (let word of para.split(/\s+/).filter(Boolean)) {
          while (word.length > per) { if (cur) { lines.push(cur); cur = ''; } lines.push(word.slice(0, per)); word = word.slice(per); }
          if (!cur) cur = word;
          else if ((cur + ' ' + word).length <= per) cur += ' ' + word;
          else { lines.push(cur); cur = word; }
        }
        lines.push(cur);
      }
      return lines;
    }
    text(t) { (Array.isArray(t) ? t : [t]).forEach(s => log.texts.push(String(s))); }
    save(name) { log.saved.push(name); }
  }
  return { log, jspdf: { jsPDF: FakeDoc } };
}

// Markdown -> the minimal node shapes downloadPDF walks (an `.analysis-card` with an `.ac` child list).
function mdCardRoot(md) {
  const nodes = [];
  const blocks = md.split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter(Boolean);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*\|/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) {
          if (!/^\s*\|[\s|:-]+\|\s*$/.test(lines[i])) rows.push(lines[i].trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()));
          i++;
        }
        i--;
        const rowNodes = rows.map((cells, ri) => {
          const cellNodes = cells.map(c => ({ textContent: c.replace(/\*\*/g, ''), innerText: ri === 0 ? c.toUpperCase() : c }));
          return { querySelectorAll: () => cellNodes, querySelector: sel => (sel === 'th' && ri === 0 ? cellNodes[0] : null) };
        });
        nodes.push({ nodeType: 1, tagName: 'TABLE', textContent: 'table', innerText: 'table', querySelectorAll: sel => (sel === 'tr' ? rowNodes : []) });
      } else if (/^#{1,3} /.test(line)) {
        const text = line.replace(/^#+ /, '');
        nodes.push({ nodeType: 1, tagName: line.startsWith('# ') ? 'H2' : 'H3', textContent: text, innerText: text, innerHTML: text });
      } else if (/^- /.test(line)) {
        const items = [];
        while (i < lines.length && /^- /.test(lines[i])) { items.push(lines[i].slice(2).replace(/\*\*/g, '')); i++; }
        i--;
        const lis = items.map(t => ({ textContent: t, innerText: t }));
        nodes.push({ nodeType: 1, tagName: 'UL', textContent: items.join(' '), innerText: items.join(' '), querySelectorAll: () => lis });
      } else {
        nodes.push({ nodeType: 1, tagName: 'P', textContent: line, innerText: line, innerHTML: line });
      }
    }
  }
  const card = { querySelector: sel => (sel === '.ac' ? { childNodes: nodes } : null) };
  return { querySelectorAll: sel => (sel === '.analysis-card' ? [card] : []) };
}

const tableCells = md => md.split('\n').filter(l => /^\s*\|/.test(l) && !/^\s*\|[\s|:-]+\|\s*$/.test(l))
  .flatMap(l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim().replace(/\*\*/g, ''))).filter(Boolean);

const BIG_CHAIN = (() => {
  const rows = ['## CHAIN OF TITLE', '| # | Date | Doc Type | Recording Ref | Grantor | Grantee | Interest Conveyed | Running Balance | Flags |', '|---|---|---|---|---|---|---|---|---|'];
  for (let i = 1; i <= 90; i++) rows.push(`| ${i} | 19${String(10 + (i % 89)).padStart(2, '0')}-03-0${(i % 9) + 1} | Mineral Deed | Vol. ${100 + i} p. ${i * 3} | Grantor Number ${i} Family Trust | Grantee Number ${i + 1} | 1/${2 ** ((i % 6) + 1)} | Grantee ${i + 1}: 1/${2 ** ((i % 6) + 1)}; Grantor ${i}: remainder of the tract | ${i % 9 ? 'NONE' : 'AMBIG'} |`);
  return rows.join('\n');
})();

function pdfRun(md, setup) {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const pdf = fakeJsPdf();
  app.ctx.jspdf = pdf.jspdf;
  const root = mdCardRoot(md);
  if (setup) setup(app, root);
  app.ctx.downloadPDF({ rootElement: root, tractOverride: 'T' });
  return { app, log: pdf.log, all: pdf.log.texts.join('\n') };
}

// ---- R01: every wrapped line of every table cell reaches the PDF, and headers repeat on page breaks.
test('R01 PDF tables draw every wrapped line of every cell and repeat the header row after a page break', () => {
  const md = `${SAMPLE}\n\n${BIG_CHAIN}\n`;
  const { log } = pdfRun(md);
  assert.equal(log.saved.length, 1, 'the PDF is saved');
  const hay = squash(log.texts.join(''));
  const missing = [...new Set(tableCells(md))].filter(c => !hay.includes(squash(c)));
  assert.deepEqual(missing.slice(0, 6), [], `${missing.length} table cells lost in the PDF`);
  for (const token of ['Vol. 41 p. 207', 'Wendell Ashby died 1988; no probate or heirship of record.', 'Ranch Co.: 7/8; Ashby: 1/8', '0.06250000']) {
    assert.ok(hay.includes(squash(token)), `${token} survives whole`);
  }
  const headerRepeats = log.texts.filter(t => t.trim() === 'Running Balance' || t.trim() === 'Running').length;
  assert.ok(log.pages.length >= 3, 'the 90-row chain spans pages');
  assert.ok(headerRepeats >= 3, `chain header is repeated on each page (seen ${headerRepeats})`);
  assert.ok(log.texts.includes('Date'), 'header text is the source text, not the CSS-uppercased innerText');
});

// ---- R02: the PDF opens with the same completeness notices the page shows.
test('R02 a partial job PDF carries the completeness notices and documents-analyzed count on page one', () => {
  const { all, app } = pdfRun(SAMPLE, (app, root) => {
    app.ctx.renderJobResults(
      { id: 'job_partial', status: 'partial_failed', totalDocuments: 400, completedDocuments: 396, failedDocuments: 4 },
      { finalTitleOpinion: SAMPLE, warnings: ['synthesis_driver:browser', '4 abstraction chunk(s) failed and were omitted from browser synthesis.', 'Final opinion was truncated at the model output limit; the last section may be incomplete.'], failedDocuments: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] },
    );
    const jobResults = app.getEl('jobResults');
    jobResults.querySelectorAll = root.querySelectorAll;
    app.ctx.__root = jobResults;
  });
  // downloadPDF above used the plain root; run again from the job view's own element.
  const pdf = fakeJsPdf();
  app.ctx.jspdf = pdf.jspdf;
  app.ctx.downloadPDF({ rootElement: app.getEl('jobResults'), tractOverride: 'T' });
  const text = pdf.log.texts.join(' ').replace(/\s+/g, ' ');
  assert.match(text, /may be incomplete/i);
  assert.match(text, /Excluded 4 failed documents/);
  assert.match(text, /browser/i);
  assert.match(text, /cut off/i, 'opinion truncation is stated');
  assert.match(text, /Documents analyzed: 396 of 400/);
  assert.ok(text.indexOf('Documents analyzed') < text.indexOf('EXECUTIVE SUMMARY'), 'notices come before the opinion');
  assert.doesNotMatch(text, /synthesis_driver:browser/, 'no raw codes in the export');
  assert.ok(all.length > 0);
});

// ---- R11: a missing jsPDF shows an inline, retryable message instead of throwing.
test('R11 Download PDF without jsPDF shows an inline alert with Retry that reloads the pinned script and exports', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const appended = [];
  app.ctx.document.head = { appendChild: el => appended.push(el) };
  app.ctx.document.createElement = tag => {
    const el = { tagName: String(tag).toUpperCase(), attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; } };
    return el;
  };
  const root = mdCardRoot(SAMPLE);
  assert.doesNotThrow(() => app.ctx.downloadPDF({ rootElement: root, tractOverride: 'T' }));
  assert.equal(app.log.filter(l => l.startsWith('ALERT')).length, 0, 'no alert()');
  const notice = app.getEl('jobExportNotice').innerHTML + app.getEl('exportNotice').innerHTML;
  assert.match(notice, /role="alert"/);
  assert.match(notice, /PDF export could not load\. Check your connection and try again\./);
  assert.match(notice, /Retry/);
  app.run('retryPdfExport()');
  assert.equal(appended.length, 1, 'retry loads the script again');
  const script = appended[0];
  assert.equal(script.src, '/vendor/jspdf/jspdf.umd.min.js');
  assert.equal(script.integrity || script.attrs.integrity, 'sha384-qovJwSBbRDPP5cEjCp8S0UP66wrvnjaa60XMOGzTNanrThcrGfXfnZkvgY8N1KT3');
  const pdf = fakeJsPdf();
  app.ctx.jspdf = pdf.jspdf;
  script.onload();
  assert.equal(pdf.log.saved.length, 1, 'export runs once the script loads');
});

// ---- R04: malformed loads end in a visible state with Retry; a missing result is "Result unavailable".
test('R04 an HTML body, a job without status, and a missing result end in visible states with Retry', async () => {
  const bodies = { '/api/jobs/job_html': textResponse(200, '<html>Bad gateway</html>'), '/api/jobs/job_nostatus': jsonResponse(200, { job: { id: 'job_nostatus' } }) };
  const app = loadIndex({ fetchImpl: async url => bodies[url] || (url === '/api/jobs/job_done' ? jsonResponse(200, { job: { id: 'job_done', status: 'complete', totalDocuments: 3 } }) : jsonResponse(404, { error: 'No result.' })) });
  for (const id of ['job_html', 'job_nostatus']) {
    app.ctx.location.hash = `#/job/${id}`;
    await app.ctx.loadJobView(id);
    const header = app.getEl('jobHeader').innerHTML;
    assert.doesNotMatch(header, /Loading job/, `${id}: never stuck loading`);
    assert.match(header, /Retry/, `${id}: offers Retry`);
    assert.doesNotMatch(header, /JSON|Unexpected token|undefined|TypeError/, `${id}: no parser text`);
  }
  app.ctx.location.hash = '#/job/job_done';
  await app.ctx.loadJobView('job_done');
  const results = app.getEl('jobResults').innerHTML;
  assert.match(results, /Result unavailable/);
  assert.match(results, /Retry/);
  const header = app.getEl('jobHeader').innerHTML;
  assert.match(header, /id="jobDownloadPdfBtn"[^>]*disabled/, 'Download PDF is disabled without an opinion');
  assert.match(header, /id="jobDownloadPdfBtn"[^>]*title="[^"]+"/, 'and says why');
});

// ---- R05: reconnect status, 401 and 404 handling, and leaving the route stops the poller.
function pollApp(responder) {
  const timers = [];
  const calls = [];
  const app = loadIndex({ fetchImpl: async (url, options = {}) => { calls.push(`${options.method || 'GET'} ${url}`); return responder(url, options); } });
  app.ctx.setTimeout = fn => { timers.push(fn); return timers.length; };
  app.ctx.clearTimeout = () => {};
  return { app, timers, calls };
}
const RUNNING = { id: 'job_run', status: 'abstracting', totalDocuments: 12, completedDocuments: 5 };

test('R05 a failed poll shows "Connection lost. Retrying..." and the next success clears it', async () => {
  let mode = 'ok';
  const { app } = pollApp(async url => {
    if (url !== '/api/jobs/job_run') return jsonResponse(404, {});
    if (mode === 'down') throw new TypeError('Failed to fetch');
    return jsonResponse(200, { job: RUNNING });
  });
  app.ctx.location.hash = '#/job/job_run';
  await app.ctx.loadJobView('job_run');
  mode = 'down';
  await app.run('runJobPollTick(activeJobPollState)');
  assert.match(app.getEl('jobConnStatus').textContent, /Connection lost\. Retrying/);
  mode = 'ok';
  await app.run('runJobPollTick(activeJobPollState)');
  assert.doesNotMatch(app.getEl('jobConnStatus').textContent, /Connection lost/);
});

test('R05 a poll 404 stops polling and shows "Job not found" with Remove from Recent Jobs', async () => {
  let gone = false;
  const { app, timers } = pollApp(async url => (url === '/api/jobs/job_run' && !gone ? jsonResponse(200, { job: RUNNING }) : jsonResponse(404, { error: 'Job not found.' })));
  app.ctx.location.hash = '#/job/job_run';
  await app.ctx.loadJobView('job_run');
  gone = true;
  const before = timers.length;
  await app.run('runJobPollTick(activeJobPollState)');
  assert.equal(timers.length, before, 'no further poll is scheduled');
  assert.match(app.getEl('jobHeader').innerHTML, /Job not found/);
  assert.match(app.getEl('jobHeader').innerHTML, /Remove from Recent Jobs/);
});

test('R05 leaving the job for Recent Jobs stops its poller: GET count stays flat and no workflow POST follows', async () => {
  const { app, timers, calls } = pollApp(async url => (url === '/api/jobs/job_run' ? jsonResponse(200, { job: RUNNING }) : jsonResponse(200, { status: { pending: 3 } })));
  app.ctx.location.hash = '#/job/job_run';
  await app.ctx.loadJobView('job_run');
  app.ctx.location.hash = '#/jobs';
  app.run('applyRoute(parseRoute())');
  const count = calls.length;
  for (let i = 0; i < 6; i++) { for (const fn of timers.splice(0)) await fn(); await tick(); }
  assert.deepEqual(calls.slice(count), [], 'no GET or POST after leaving the job');
});

// ---- C01: one unauthorized handler; the ping only accepts a valid 200.
test('C01 a 500 or rejected password ping never reveals the app and offers Retry', async () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(500, { error: 'boom' }) });
  const ok = await app.ctx.checkPasswordRequired();
  assert.equal(ok, false, 'a 500 is not acceptance');
  assert.notEqual(app.getEl('mainApp').style.display, 'block');
  assert.equal(app.getEl('passwordGate').style.display, 'block');
  assert.match(app.getEl('passwordError').innerHTML, /Could not reach the server/);
  assert.match(app.getEl('passwordError').innerHTML, /Retry/);

  const down = loadIndex({ fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
  down.getEl('passwordInput').value = 'pw';
  await down.ctx.checkPassword();
  assert.notEqual(down.getEl('mainApp').style.display, 'block', 'a rejected submit keeps the gate up');
  assert.match(down.getEl('passwordError').innerHTML, /Could not reach the server/);
});

test('C01 a poll 401 shows the gate, keeps staged files and the route, and re-entry resumes the job', async () => {
  let auth = true;
  const { app, calls } = pollApp(async (url, options) => {
    if (url === '/api/analyze') return options.headers['x-app-password'] === 'right' ? jsonResponse(200, { ok: true }) : jsonResponse(401, {});
    if (!auth) return jsonResponse(401, { error: 'Unauthorized' });
    return url === '/api/jobs/job_run' ? jsonResponse(200, { job: RUNNING }) : jsonResponse(404, {});
  });
  app.run("files.push({ name: 'kept.pdf', size: 10, stageId: 99 })");
  app.run("appPassword = 'stale'");
  app.ctx.location.hash = '#/job/job_run';
  await app.ctx.loadJobView('job_run');
  auth = false;
  await app.run('runJobPollTick(activeJobPollState)');
  assert.equal(app.getEl('passwordGate').style.display, 'block', 'gate shown on poll 401');
  assert.equal(app.run('files.length'), 1, 'staged work kept');
  assert.equal(app.ctx.location.hash, '#/job/job_run', 'route kept');
  assert.equal(app.run('appPassword'), '', 'stored password cleared');
  assert.equal(app.run('activeJobPollState && activeJobPollState.pausedForAuth'), true, 'poller paused');
  auth = true;
  const before = calls.filter(c => c === 'GET /api/jobs/job_run').length;
  app.getEl('passwordInput').value = 'right';
  await app.ctx.checkPassword();
  await tick(5);
  assert.ok(calls.filter(c => c === 'GET /api/jobs/job_run').length > before, 'route re-applied after re-entry');
});

test('C01 a Build 401 routes to the shared handler and keeps the staged files', async () => {
  const app = loadIndex({ fetchImpl: async url => (url === '/api/jobs' ? jsonResponse(401, { error: 'Unauthorized' }) : jsonResponse(404, {})) });
  app.run("files.push({ name: 'kept.pdf', size: 10, stageId: 7, base64: 'x' })");
  await app.run('analyze()');
  assert.equal(app.getEl('passwordGate').style.display, 'block');
  assert.equal(app.run('files.length'), 1);
});

// ---- R03: the rename editor survives polling, closes on Save/Cancel/Escape, and keeps errors inline.
test('R03 rename: polling keeps the editor; Escape, Cancel and a successful Save close it and return focus', async () => {
  let fail = false;
  const app = loadIndex({ fetchImpl: async (url, options = {}) => {
    if (options.method === 'PATCH') return fail ? jsonResponse(500, { error: 'db down' }) : jsonResponse(200, { job: { id: 'job_n', status: 'complete', subjectTract: JSON.parse(options.body).subjectTract } });
    return jsonResponse(404, {});
  } });
  const focused = [];
  app.getEl('jobRenameBtn').focus = () => focused.push('jobRenameBtn');
  const job = { id: 'job_n', status: 'abstracting', subjectTract: 'Old name' };
  // The editor lives in the job view; a Save reply only closes it while that job's route is shown (round 2).
  app.ctx.location.hash = '#/job/job_n';
  app.ctx.renderJobHeader(job);
  assert.match(app.getEl('jobHeader').innerHTML, /id="jobRenameBtn"/, 'header renders');
  app.ctx.renderJobNameEditor(job, 'Old name');
  assert.match(app.getEl('jobTitleBlock').innerHTML, /<label[^>]*for="jobNameInput"/, 'input has a label');
  const headerWithEditor = app.getEl('jobHeader').innerHTML;
  app.ctx.renderJobHeader({ ...job, updatedAt: 'later' });
  assert.equal(app.getEl('jobHeader').innerHTML, headerWithEditor, 'a poll re-render keeps the open editor');
  await app.getEl('jobNameInput').dispatch('keydown', { key: 'Escape' });
  assert.match(app.getEl('jobHeader').innerHTML, /jobTitleText/, 'Escape closes the editor');
  assert.ok(focused.length >= 1, 'focus returns to Rename');
  app.ctx.renderJobNameEditor(job, 'Old name');
  fail = true;
  app.getEl('jobNameInput').value = 'New name';
  await app.ctx.saveJobName(job, 'New name');
  assert.match(app.getEl('jobTitleBlock').innerHTML + app.getEl('jobNameError').innerHTML, /Could not rename/, 'failure stays open with an inline error');
  assert.equal(app.log.filter(l => l.startsWith('ALERT')).length, 0, 'no alert');
  fail = false;
  await app.ctx.saveJobName(job, 'New name');
  app.ctx.renderJobHeader({ ...job, subjectTract: 'New name' });
  assert.match(app.getEl('jobHeader').innerHTML, /New name/, 'Save closes the editor; later renders show the new name');
});

// ---- R10: canceling another job does not reset the home workspace.
test('R10 canceling a different job keeps the staged home file and shows the canceled job', async () => {
  let canceled = false;
  const app = loadIndex({ fetchImpl: async (url, options = {}) => {
    if (url === '/api/jobs/job_other/cancel') { canceled = true; return jsonResponse(200, { job: { id: 'job_other', status: 'canceled' } }); }
    if (url === '/api/jobs/job_other') return jsonResponse(200, { job: { id: 'job_other', status: canceled ? 'canceled' : 'abstracting', totalDocuments: 4, completedDocuments: 1 } });
    return jsonResponse(404, {});
  } });
  app.run("files.push({ name: 'staged.pdf', size: 10, stageId: 3 })");
  app.ctx.location.hash = '#/job/job_other';
  await app.ctx.runJobAction({ id: 'job_other', status: 'abstracting' }, '/cancel');
  await tick(5);
  assert.equal(app.run('files.length'), 1, 'staged home file kept');
  assert.equal(app.ctx.location.hash, '#/job/job_other', 'stays on the canceled job');
  assert.match(app.getEl('jobHeader').innerHTML, /Canceled/);
  assert.equal(app.run("loadRecentJobs().find(e => e.id === 'job_other').status"), 'canceled');
});

// ---- R06: follow-up shows a pending card, rejects empty answers inline, and never alerts.
test('R06 job-view follow-up: pending Q card at once, empty answer is an inline retryable error, then an announced answer', async () => {
  const replies = [];
  const app = loadIndex({ fetchImpl: async url => (String(url).endsWith('/followup') ? (await replies.shift()) : jsonResponse(404, {})) });
  app.ctx.renderJobResults({ id: 'job_f', status: 'complete' }, { finalTitleOpinion: SAMPLE, warnings: [], failedDocuments: [] });
  const first = deferred();
  replies.push(first.promise);
  app.getEl('jobFollowupInput').value = 'Who owns the NPRI?';
  const pending = app.getEl('jobFollowupBtn').onclick();
  await tick();
  assert.match(app.getEl('jobFollowupHistory').innerHTML, /Who owns the NPRI\?/, 'question shown at once');
  assert.match(app.getEl('jobFollowupHistory').innerHTML, /Working on the answer/);
  first.resolve(jsonResponse(200, { followup: { answer: '' } }));
  await pending;
  assert.match(app.getEl('jobFollowupHistory').innerHTML, /The answer came back empty\. Try asking again\./);
  assert.match(app.getEl('jobFollowupHistory').innerHTML, /data-followup-retry/);
  replies.push(Promise.resolve(jsonResponse(500, { error: 'upstream timeout' })));
  app.getEl('jobFollowupInput').value = 'Second?';
  await app.getEl('jobFollowupBtn').onclick();
  assert.equal(app.log.filter(l => l.startsWith('ALERT')).length, 0, 'no alert on failure');
  assert.match(app.getEl('jobFollowupHistory').innerHTML, /Second\?/);
  replies.push(Promise.resolve(jsonResponse(200, { followup: { answer: 'NPRI belongs to Tobin Creek.' } })));
  app.getEl('jobFollowupInput').value = 'Third?';
  await app.getEl('jobFollowupBtn').onclick();
  assert.match(app.getEl('jobFollowupHistory').innerHTML, /NPRI belongs to Tobin Creek/);
  assert.match(app.getEl('jobFollowupStatus').textContent, /Answer ready/);
});

test('R06 in-tab follow-up: Ask shows a pending label, the question waits on a pending line, duplicates are ignored', async () => {
  const gate = deferred();
  let posts = 0;
  const app = loadIndex({ fetchImpl: async url => {
    if (String(url).endsWith('/followup')) { posts++; await gate.promise; return jsonResponse(200, { followup: { answer: '' } }); }
    return jsonResponse(404, {});
  } });
  app.ctx.__op = SAMPLE;
  app.run("conversationHistory = [{ role: 'user', content: 'docs' }, { role: 'assistant', content: __op, kind: 'title-opinion', sourceJobId: 'job_t' }]; renderResults();");
  app.getEl('followupInput').value = 'Who owns it?';
  const turn = app.run('askFollowup()');
  app.getEl('followupInput').value = 'Who owns it?';
  app.run('askFollowup()');
  await tick(5);
  assert.equal(app.getEl('followupAskBtn').disabled, true);
  assert.match(app.getEl('followupAskBtn').textContent, /Asking/);
  assert.match(app.getEl('results').innerHTML, /Working on the answer/);
  gate.resolve();
  await turn;
  await tick(5);
  assert.equal(posts, 1, 'the duplicate was ignored');
  assert.match(app.getEl('results').innerHTML, /The answer came back empty\. Try asking again\./);
  assert.equal(app.getEl('followupAskBtn').disabled, false);
});

// ---- R07: failure reasons in plain words, honest steppers, one completeness block, primary action first.
test('R07 failed and canceled jobs: plain reason, Details for unknown codes, stepper never says Next', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const failed = { id: 'job_x', status: 'failed', totalDocuments: 12, completedDocuments: 12, errorMessage: 'Synthesis attempt limit exceeded.' };
  app.ctx.renderJobDetail(failed);
  assert.match(app.getEl('jobDetail').innerHTML, /Building the chain of title failed after several attempts/);
  app.ctx.renderJobDetail({ ...failed, errorMessage: 'weird_code_42' });
  const detail = app.getEl('jobDetail').innerHTML;
  assert.match(detail, /<details/);
  assert.ok(detail.indexOf('weird_code_42') > detail.indexOf('<details'), 'the code only appears inside Details');
  app.ctx.renderJobStepper(failed);
  const stepper = app.getEl('jobStepper').innerHTML;
  assert.doesNotMatch(stepper, />Next</);
  assert.match(stepper, /Stopped here/);
  assert.match(stepper, /Done/);
  app.ctx.renderJobStepper({ id: 'job_c', status: 'canceled', totalDocuments: 12, completedDocuments: 4 });
  assert.doesNotMatch(app.getEl('jobStepper').innerHTML, />Next</);
  assert.match(app.getEl('jobStepper').innerHTML, /Not reached/);
});

test('R07 partial results show one plain completeness block and lead with Retry; rebuild says it replaces the opinion', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const job = { id: 'job_p', status: 'partial_failed', totalDocuments: 400, completedDocuments: 396, failedDocuments: 4 };
  app.ctx.renderJobResults(job, { finalTitleOpinion: SAMPLE, warnings: ['synthesis_driver:browser', '4 abstraction chunk(s) failed and were omitted from browser synthesis.', 'Final opinion was truncated at the model output limit; the last section may be incomplete.'], failedDocuments: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });
  const html = app.getEl('jobResults').innerHTML;
  assert.equal(html.match(/may be incomplete/gi).length, 1, 'one consolidated block');
  assert.doesNotMatch(html, /Warnings:/);
  assert.doesNotMatch(html.split('<details class="rd-raw')[0], /synthesis_driver:browser/, 'no raw code');
  assert.equal(html.match(/Excluded 4 failed documents/g).length, 1, 'the omitted documents are stated once');
  const confirms = [];
  app.ctx.confirm = msg => { confirms.push(msg); return false; };
  app.ctx.renderJobActions(job);
  const actions = app.getEl('jobActions').innerHTML;
  const labels = [...actions.matchAll(/>([^<]+)<\/button>/g)].map(m => m[1]);
  assert.equal(labels[0], 'Retry 4 failed', 'primary recovery action first');
  assert.ok(labels.includes('Rebuild opinion without failed documents'), labels.join(' | '));
  assert.ok(!labels.includes('Synthesize with warnings'));
  const idx = labels.indexOf('Rebuild opinion without failed documents');
  app.run(`jobActionButtons[${idx}].onClick()`);
  assert.match(confirms.join(' '), /replace the opinion/i);
});

// ---- R08: phone layout hooks: stacked owner rows, sticky first chain column, one-row action bar.
test('R08 phone layout: owner cells carry stacking labels and the <=560px rules compact the header and bar', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const html = app.ctx.renderResultsDashboard(app.ctx.parseTitleOpinion(SAMPLE), SAMPLE, { askInputId: 'jobFollowupInput' });
  assert.match(html, /<td[^>]*data-label="Decimal"/);
  const css = INDEX.slice(0, INDEX.indexOf('</style>'));
  const phone = css.slice(css.indexOf('@media (max-width: 560px)'));
  assert.ok(css.includes('@media (max-width: 560px)'), 'a <=560px block exists');
  assert.match(phone, /\.rd-owners[^{]*\{[^}]*display:\s*block/, 'owner table stacks');
  assert.match(phone, /\.rd-chain[^{]*(td|th):first-child[^{]*\{[^}]*position:\s*sticky/, 'chain first column is sticky');
  assert.match(phone, /\.rd-actionbar[^{]*\{[^}]*flex-wrap:\s*nowrap/, 'action bar stays one row');
});

// ---- R09: navigation for big results; export is independent of on-screen filters.
test('R09 big results: section jump bar, chain filter with a count, and defects collapse above eight', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const defects = ['## TITLE DEFECTS & CURATIVE REQUIREMENTS', '| # | Defect | Curative Needed | Source Doc |', '|---|---|---|---|'];
  for (let d = 1; d <= 12; d++) defects.push(`| D${d} | Defect number ${d} is open. | Release | Doc ${d} |`);
  const big = SAMPLE.replace(/## TITLE DEFECTS[\s\S]*?(?=## FINAL)/, defects.join('\n') + '\n\n').replace(/## CHAIN OF TITLE[\s\S]*?(?=## TITLE)/, BIG_CHAIN + '\n\n');
  const html = app.ctx.renderResultsDashboard(app.ctx.parseTitleOpinion(big), big, {});
  assert.match(html, /class="rd-jump"/);
  for (const name of ['Summary', 'Ownership', 'Defects', 'Chain', 'Qualifications']) assert.match(html, new RegExp(`data-rd-jump[^>]*>${name}<`));
  assert.match(html, /data-rd-chain-filter="flagged"/);
  assert.match(html, /data-rd-chain-search/);
  assert.match(html, /Showing 90 of 90/);
  assert.match(html, /data-rd-defects-toggle/);
  assert.doesNotMatch(html, /<details class="rd-dmore" open/, 'more than eight defects start collapsed');
  const small = app.ctx.renderResultsDashboard(app.ctx.parseTitleOpinion(SAMPLE), SAMPLE, {});
  assert.match(small, /<details class="rd-dmore" open/, 'eight or fewer start expanded');
  const noDefects = SAMPLE.replace(/## TITLE DEFECTS[\s\S]*?(?=## FINAL)/, '');
  assert.doesNotMatch(app.ctx.renderResultsDashboard(app.ctx.parseTitleOpinion(noDefects), noDefects, {}), /data-rd-jump[^>]*>Defects</, 'only sections that exist');
  assert.match(html.split('<details class="rd-raw')[1], /Vol\. 190 p\. 270/, 'the full opinion the export reads keeps every row');
});

// ---- R12: Recent Jobs labels cached status, refreshes on demand, and removes entries.
test('R12 Recent Jobs: "Last seen" labels, Refresh with concurrency 4 updates rows, 404 offers Remove, network errors leave rows', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const app = loadIndex({ fetchImpl: async url => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    await tick(2);
    inFlight--;
    const id = String(url).split('/').pop();
    if (id === 'job_gone') return jsonResponse(404, { error: 'Job not found.' });
    if (id === 'job_net') throw new TypeError('Failed to fetch');
    return jsonResponse(200, { job: { id, status: 'complete', totalDocuments: 2 } });
  } });
  const now = Date.now();
  const list = ['job_a', 'job_b', 'job_c', 'job_d', 'job_e', 'job_gone', 'job_net'].map((id, i) => ({ id, status: 'abstracting', documentCount: 2, lastViewedAt: now - i }));
  app.ctx.localStorage.setItem('title-analyzer:recent-jobs:v1', JSON.stringify(list));
  app.ctx.renderRecentJobsView();
  assert.match(app.getEl('view-history').innerHTML, /Last seen: Reading documents/);
  assert.match(app.getEl('view-history').innerHTML, /id="recentJobsRefreshBtn"/);
  await app.run('refreshRecentJobs()');
  assert.ok(maxInFlight <= 4, `concurrency ${maxInFlight}`);
  const stored = JSON.parse(app.ctx.localStorage.getItem('title-analyzer:recent-jobs:v1'));
  assert.equal(stored.find(e => e.id === 'job_a').status, 'complete');
  assert.equal(stored.find(e => e.id === 'job_net').status, 'abstracting', 'network error leaves the entry');
  const html = app.getEl('view-history').innerHTML;
  assert.match(html, /Not found/);
  assert.match(html, /data-recent-remove="job_gone"/);
  app.run("removeRecentJob('job_gone')");
  assert.equal(JSON.parse(app.ctx.localStorage.getItem('title-analyzer:recent-jobs:v1')).some(e => e.id === 'job_gone'), false);
  const extra = Object.keys(stored.find(e => e.id === 'job_a')).filter(k => !(k in list[0]));
  assert.deepEqual(extra.filter(k => k !== 'checkedAt'), [], 'only status and timestamps change');
  assert.equal(stored.find(e => e.id === 'job_a').documentCount, 2);
});

// ---- C02: table semantics, a real summary heading, a labelled rename input, no closed-tooltip overflow.
test('C02 semantics: captions, scoped headers, a summary heading, and the closed tooltip leaves layout', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const html = app.ctx.renderResultsDashboard(app.ctx.parseTitleOpinion(SAMPLE), SAMPLE, {});
  // The dashboard's owners and chain tables; the Full opinion text tables are covered by the round-2 C02 test.
  assert.equal((html.split('<details class="rd-raw')[0].match(/<caption/g) || []).length, 2, 'owners and chain tables have captions');
  assert.ok(!/<th(?=[\s>])(?![^>]*scope="col")[^>]*>/.test(html.split('<details class="rd-raw')[0]), 'every dashboard header cell has scope="col"');
  assert.match(html, /<h3 class="rd-eyebrow"[^>]*>Executive summary<\/h3>/);
  const css = INDEX.slice(0, INDEX.indexOf('</style>'));
  assert.match(css, /\.recent-jobs-toolbar:not\(:hover\):not\(:focus-within\) \.recent-jobs-hint \{[^}]*display:\s*none/, 'closed tooltip takes no layout space');
});

// ======================================================================================================
// Round 2: regression tests for the confirmed @buggy break-test findings on the round-1 repairs.
// ======================================================================================================

// A stricter fake jsPDF: like the real library, rect/text reject non-finite coordinates.
function strictJsPdf() {
  const pdf = fakeJsPdf();
  const Base = pdf.jspdf.jsPDF;
  class Strict extends Base {
    rect(...args) { if (!args.slice(0, 4).every(Number.isFinite)) throw new Error('Invalid arguments passed to jsPDF.rect'); }
    text(t, x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid arguments passed to jsPDF.text');
      super.text(t);
    }
  }
  pdf.jspdf.jsPDF = Strict;
  return pdf;
}

// The characters jsPDF's built-in Helvetica (WinAnsi) can draw.
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
const drawable = s => [...String(s)].every(ch => {
  const c = ch.codePointAt(0);
  return c === 10 || c === 9 || (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.includes(ch);
});

// Drives a real home Build in the VM against the fake durable backend: two files, one failed part,
// server synthesis returning a truncated, partial result. Mirrors buggy-probes/home-run-export.mjs.
const HOME_OPINION = `${SAMPLE}\n\nHOMEOPINIONMARKER.`;
const HOME_RESULT = {
  finalTitleOpinion: HOME_OPINION,
  warnings: ['1 abstraction chunk(s) failed and were omitted from browser synthesis.', 'Final opinion was truncated at the model output limit; the last section may be incomplete.'],
  failedDocuments: [{ id: 'doc_failed' }],
};
function homeBuild({ holdAbstraction } = {}) {
  let entered;
  const started = new Promise(r => { entered = r; });
  const held = deferred();
  const server = makeJobServer({
    abstractionReadyAfter: 0,
    synthesisReadyAfter: 0,
    hooks: {
      'POST /api/jobs/job_1/abstraction/start': async () => { entered(); if (holdAbstraction) await held.promise; return undefined; },
      'GET /api/jobs/job_1/abstraction/status': async () => jsonResponse(200, { status: { total: 2, pending: 0, processing: 0, completed: 1, failed: 1, retry_wait: 0 } }),
      'GET /api/jobs/job_1/result': async () => jsonResponse(200, { result: HOME_RESULT }),
      'GET /api/jobs/job_1': async () => jsonResponse(200, { job: { id: 'job_1', status: 'abstracting', totalDocuments: 2, completedDocuments: 0 } }),
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  return { app, server, started, release: held.resolve };
}

// ---- R2-1 (R01 High): the home Download PDF reads only the home results, never other views' cards.
test('R2 R01 home Download PDF exports only the home run, never a job opened since', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const home = mdCardRoot('# Home opinion\n\nHOMEOPINIONMARKER.');
  const foreign = mdCardRoot('# Foreign opinion\n\nFOREIGNOPINIONMARKER.');
  app.getEl('results').querySelectorAll = home.querySelectorAll;
  app.getEl('jobResults').querySelectorAll = foreign.querySelectorAll;
  app.ctx.document.querySelectorAll = sel => [...home.querySelectorAll(sel), ...foreign.querySelectorAll(sel)];
  // Job B was opened (and rendered) after the home run finished.
  app.ctx.renderJobResults({ id: 'job_b', status: 'partial_failed', totalDocuments: 9, completedDocuments: 5, failedDocuments: 4 }, { finalTitleOpinion: SAMPLE, warnings: [], failedDocuments: [] });
  app.getEl('jobResults').querySelectorAll = foreign.querySelectorAll;
  let pdf = fakeJsPdf();
  app.ctx.jspdf = pdf.jspdf;
  app.run('downloadPDF()');
  let text = pdf.log.texts.join(' ');
  assert.equal(pdf.log.saved.length, 1, 'home export saved');
  assert.match(text, /HOMEOPINIONMARKER/);
  assert.doesNotMatch(text, /FOREIGNOPINIONMARKER/, 'job B is not in the home export');
  assert.doesNotMatch(text, /Documents analyzed: 5 of 9/, 'nor are job B notices');
  pdf = fakeJsPdf();
  app.ctx.jspdf = pdf.jspdf;
  app.ctx.downloadPDF({ rootElement: app.getEl('jobResults'), tractOverride: 'B' });
  text = pdf.log.texts.join(' ');
  assert.match(text, /FOREIGNOPINIONMARKER/);
  assert.doesNotMatch(text, /HOMEOPINIONMARKER/, 'a job export holds only its own job');
});

// ---- R2-2 (R02 High): a real home Build keeps its job/result metadata for the export's page-one notices.
test('R2 R02 a partial home Build exports its completeness notices and Documents analyzed: 1 of 2', async () => {
  const { app } = homeBuild();
  await app.ctx.handleFiles([pngFile('deed-1.png', 'a'.repeat(40)), pngFile('deed-2.png', 'b'.repeat(40))]);
  await app.run('analyze()');
  await tick(30);
  assert.ok(app.run("conversationHistory.some(m => m.kind === 'title-opinion' && /HOMEOPINIONMARKER/.test(m.content))"), 'the Build finished with the server opinion');
  app.getEl('results').querySelectorAll = mdCardRoot(HOME_OPINION).querySelectorAll;
  const pdf = fakeJsPdf();
  app.ctx.jspdf = pdf.jspdf;
  app.run('downloadPDF()');
  const text = pdf.log.texts.join(' ').replace(/\s+/g, ' ');
  assert.equal(pdf.log.saved.length, 1);
  assert.match(text, /This result may be incomplete/);
  assert.match(text, /Excluded 1 failed document/);
  assert.match(text, /cut off/);
  assert.match(text, /Documents analyzed: 1 of 2/);
  assert.ok(text.indexOf('Documents analyzed') < text.indexOf('HOMEOPINIONMARKER'), 'notices sit on page one, before the opinion');
});

// ---- R2-3 (R01 High): md() keeps the last table row at EOF and the paragraph after a table; text nodes export.
test('R2 R01 md() renders an EOF table row and prose after a table; the exporter draws loose text nodes', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const defectsOnly = app.ctx.md('## TITLE DEFECTS & CURATIVE REQUIREMENTS\n\n| # | Defect | Curative Needed | Source Doc |\n|---|---|---|---|\n| D1 | No probate of record. | Obtain probate and heirship TAILDEFECT. | Doc 2 |');
  assert.match(defectsOnly, /<td>D1<\/td>/);
  assert.match(defectsOnly, /<td>Obtain probate and heirship TAILDEFECT\.<\/td>/);
  assert.match(defectsOnly, /<td>Doc 2<\/td>/);
  assert.doesNotMatch(defectsOnly, /\|\s*D1/, 'no raw pipe row');
  const tail = app.ctx.md('# Opinion\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nSentence tail SENTENCETAIL.');
  assert.match(tail, /<p>Sentence tail SENTENCETAIL\.<\/p>/, 'prose after a table is a paragraph');
  const fallback = app.ctx.md('The model returned prose instead of the required sections.\n\n## Notes\n- Owner list unavailable\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(fallback, /<td>1<\/td><td>2<\/td>/, 'the fallback card renders its final row');
  // A text node directly inside the opinion card is drawn too.
  const root = mdCardRoot('# Opinion\n\nFirst.');
  const ac = root.querySelectorAll('.analysis-card')[0].querySelector('.ac');
  ac.childNodes.push({ nodeType: 3, textContent: 'Loose text node LOOSETEXTTAIL.' });
  const pdf = fakeJsPdf();
  app.ctx.jspdf = pdf.jspdf;
  app.ctx.downloadPDF({ rootElement: root, tractOverride: 'T' });
  assert.match(pdf.log.texts.join(' '), /LOOSETEXTTAIL/);
});

// ---- R2-4 (R01 High): characters Helvetica cannot draw become ?, are counted, and page one says so.
test('R2 R01 Unicode owner names: undrawable characters become ? with a page-one notice, Latin-1 stays intact', () => {
  const md = '# Unicode\n\n| Owner | Interest |\n|---|---|\n| José Muñoz | 1/4 |\n| 李明 Trust | 1/4 |\n| Łukasz Żółć | 1/4 |\n| O’Connor & Sons | 1/4 |\n\nTail UNICODETAIL.';
  const { log } = pdfRun(md);
  assert.equal(log.saved.length, 1);
  const text = log.texts.join(' ').replace(/\s+/g, ' ');
  assert.match(text, /José Muñoz/);
  assert.match(text, /\?\? Trust/);
  assert.match(text, /\?ukasz \?ó\?\?/);
  assert.match(text, /O’Connor & Sons/);
  assert.match(text, /6 characters in this opinion could not be shown in this PDF and appear as \?\. Check owner names against the on-screen opinion or the source documents\./);
  assert.ok(text.indexOf('6 characters') < text.indexOf('José'), 'the notice is on page one, before the opinion');
  const bad = log.texts.filter(t => !drawable(t));
  assert.deepEqual(bad, [], 'every drawn string is drawable in Helvetica');
});

// ---- R2-5 (R01 Med): an unbreakable reference gets finite widths and every character survives.
test('R2 R01 a very long unbroken recording reference exports in full with finite widths', () => {
  const ref = 'Vol.41p.' + Array.from({ length: 130 }, (_, i) => 207 + i).join('-');
  const md = `# Long reference\n\n| Ref | Owner | Interest |\n|---|---|---|\n| ${ref} | Smith | 1/16 |\n\nUNBROKENTAIL.`;
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const pdf = strictJsPdf();
  app.ctx.jspdf = pdf.jspdf;
  assert.doesNotThrow(() => app.ctx.downloadPDF({ rootElement: mdCardRoot(md), tractOverride: 'T' }));
  assert.equal(pdf.log.saved.length, 1, 'downloaded');
  const hay = squash(pdf.log.texts.join(''));
  assert.ok(hay.includes(ref), 'every character of the reference is drawn');
  assert.ok(hay.includes('UNBROKENTAIL'));
});

// ---- R2-6 (R03 Med): a rename answered after the reader moved to another job only updates the cache.
test('R2 R03 a late rename for job A updates A in Recent Jobs but leaves job B header, editor and focus alone', async () => {
  const patch = deferred();
  const { app } = pollApp(async (url, options = {}) => {
    if (options.method === 'PATCH') { await patch.promise; return jsonResponse(200, { job: { id: 'job_a', status: 'abstracting', subjectTract: 'LATE A NAME' } }); }
    if (url === '/api/jobs/job_a') return jsonResponse(200, { job: { id: 'job_a', status: 'abstracting', subjectTract: 'A name' } });
    if (url === '/api/jobs/job_b') return jsonResponse(200, { job: { id: 'job_b', status: 'abstracting', subjectTract: 'B name' } });
    return jsonResponse(404, {});
  });
  app.ctx.location.hash = '#/job/job_a';
  await app.ctx.loadJobView('job_a');
  app.getEl('jobRenameBtn').onclick();
  app.getEl('jobNameInput').value = 'LATE A NAME';
  const saving = app.getEl('jobNameSaveBtn').onclick();
  app.ctx.location.hash = '#/job/job_b';
  await app.ctx.loadJobView('job_b');
  const bHeader = app.getEl('jobHeader').innerHTML;
  assert.match(bHeader, /B name/);
  app.getEl('jobRenameBtn').onclick();
  app.getEl('jobNameInput').value = 'B draft';
  const focused = [];
  app.getEl('jobRenameBtn').focus = () => focused.push('rename');
  patch.resolve();
  await saving;
  await tick(3);
  assert.equal(app.getEl('jobHeader').innerHTML, bHeader, 'B header untouched');
  assert.doesNotMatch(app.getEl('jobHeader').innerHTML, /LATE A NAME/);
  assert.equal(app.run('jobNameEditor.jobId'), 'job_b', "B's open editor stays open");
  assert.equal(app.getEl('jobNameInput').value, 'B draft');
  assert.deepEqual(focused, [], 'focus is not moved');
  assert.equal(app.run("loadRecentJobs().find(e => e.id === 'job_a').tractDescription"), 'LATE A NAME', 'A is updated in the cache');
});

// ---- R2-7 (R03 Med): renaming another job never overwrites the home run's resume record.
test('R2 R03 renaming another job while home runs a browser job keeps the last-job record and its driver', async () => {
  const app = loadIndex({ fetchImpl: async (url, options = {}) => (options.method === 'PATCH'
    ? jsonResponse(200, { job: { id: 'job_complete', status: 'complete', subjectTract: 'renamed other' } })
    : jsonResponse(404, {})) });
  app.run("activeJobId = 'job_running'; beginAnalysisRun('job_running'); saveActiveJob({ id: 'job_running' }, 'browser');");
  const before = app.ctx.localStorage.getItem('title-analyzer:last-job');
  assert.match(before, /"driver":"browser"/);
  const job = { id: 'job_complete', status: 'complete', subjectTract: 'Other job' };
  app.ctx.renderJobHeader(job);
  app.ctx.renderJobNameEditor(job, 'Other job');
  await app.ctx.saveJobName(job, 'renamed other');
  assert.equal(app.ctx.localStorage.getItem('title-analyzer:last-job'), before, 'resume pointer unchanged');
  assert.equal(app.run('activeJobId'), 'job_running');
});

// ---- R2-8 (R03 Low): one Save in flight per editor.
test('R2 R03 pressing Enter twice while Save is pending sends one PATCH', async () => {
  const gate = deferred();
  let patches = 0;
  const app = loadIndex({ fetchImpl: async (url, options = {}) => {
    if (options.method === 'PATCH') { patches++; await gate.promise; return jsonResponse(200, { job: { id: 'job_n', status: 'complete', subjectTract: 'Saved name' } }); }
    return jsonResponse(404, {});
  } });
  const job = { id: 'job_n', status: 'complete', subjectTract: 'Old' };
  app.ctx.renderJobHeader(job);
  app.ctx.renderJobNameEditor(job, 'Old');
  app.getEl('jobNameInput').value = 'Saved name';
  const first = app.getEl('jobNameInput').dispatch('keydown', { key: 'Enter' });
  const second = app.getEl('jobNameInput').dispatch('keydown', { key: 'Enter' });
  const click = app.getEl('jobNameSaveBtn').onclick();
  await tick(2);
  gate.resolve();
  await Promise.all([first, second, click]);
  assert.equal(patches, 1);
});

// ---- R2-9 (R04 Med): a failed re-fetch of a shown result, 404 included, keeps the opinion under a banner.
test('R2 R04 a 404 on re-fetching a shown result keeps the opinion and says the saved result was not found', async () => {
  let status = 200;
  const app = loadIndex({ fetchImpl: async url => {
    if (url === '/api/jobs/job_done') return jsonResponse(200, { job: { id: 'job_done', status: 'complete', totalDocuments: 3, completedDocuments: 3 } });
    if (url === '/api/jobs/job_done/result') return status === 200 ? jsonResponse(200, { result: { finalTitleOpinion: SAMPLE, warnings: [], failedDocuments: [] } }) : jsonResponse(status, { error: 'Gone' });
    return jsonResponse(404, {});
  } });
  app.ctx.location.hash = '#/job/job_done';
  await app.ctx.loadJobView('job_done');
  assert.equal(app.run('jobResultView.state'), 'ready');
  const shown = app.getEl('jobResults').innerHTML;
  for (const s of [404, 500]) {
    status = s;
    await app.run('loadJobResult(rdLatestJob.job, () => true)');
    assert.equal(app.run('jobResultView.state'), 'ready', `${s}: still ready`);
    assert.equal(app.run('jobResultView.refreshFailed'), true);
    assert.equal(app.getEl('jobResults').innerHTML, shown, `${s}: the opinion stays`);
    assert.doesNotMatch(app.getEl('jobResults').innerHTML, /Result unavailable/);
    if (s === 404) assert.match(app.getEl('jobResultNotice').innerHTML, /The saved result could not be found\. Showing the last loaded copy\./);
    else assert.match(app.getEl('jobResultNotice').innerHTML, /Could not refresh this result/);
  }
});

// ---- R2-10 (R04 Med): a response for another job id is rejected, never painted or remembered.
test('R2 R04 a job response whose id differs from the requested job shows the load problem with Retry', async () => {
  const { app, calls } = pollApp(async url => {
    if (url === '/api/jobs/job_complete') return jsonResponse(200, { job: { id: 'job_wrong', status: 'complete', subjectTract: 'Wrong job' } });
    if (url === '/api/jobs/job_run') return jsonResponse(200, { job: RUNNING });
    return jsonResponse(200, { result: { finalTitleOpinion: 'WRONG OPINION' } });
  });
  app.ctx.location.hash = '#/job/job_complete';
  await app.ctx.loadJobView('job_complete');
  const header = app.getEl('jobHeader').innerHTML;
  assert.match(header, /id="jobLoadRetryBtn"/);
  assert.doesNotMatch(header, /Wrong job/);
  assert.equal(calls.filter(c => c.includes('job_wrong')).length, 0, 'no request for the other job');
  assert.equal(app.run("loadRecentJobs().some(e => e.id === 'job_wrong')"), false, 'not remembered');
  // A poll answer for another job is not painted either.
  app.ctx.location.hash = '#/job/job_run';
  await app.ctx.loadJobView('job_run');
  const state = app.run('activeJobPollState');
  app.ctx.fetch = async () => jsonResponse(200, { job: { ...RUNNING, id: 'job_other', subjectTract: 'Other job title' } });
  await app.run('runJobPollTick(activeJobPollState)');
  assert.doesNotMatch(app.getEl('jobHeader').innerHTML, /Other job title/);
  assert.equal(Boolean(state.lastJob && state.lastJob.id === 'job_other'), false, 'the other job is not remembered as this poll');
  assert.match(app.getEl('jobConnStatus').textContent, /Connection lost/, 'an unreadable poll reply counts as a failed poll');
  // An action reply naming another job is shown as an unreadable reply, never applied.
  app.ctx.fetch = async () => jsonResponse(200, { job: { id: 'job_other', status: 'abstracting' } });
  app.run('stopJobPoller()');
  await app.run("runJobAction({ id: 'job_run', status: 'abstracting', failedDocuments: 1 }, '/retry-failed')");
  assert.match(app.run('jobActionError.text'), /could not read/);
  assert.equal(app.run("loadRecentJobs().some(e => e.id === 'job_other')"), false);
});

// ---- R2-11 (R05 Med): a poller that lost its route never sends the workflow kick it was waiting to send.
test('R2 R05 leaving for Recent Jobs while the fifth stalled status GET is pending sends no workflow POST', async () => {
  let statusGets = 0;
  const held = deferred();
  let entered;
  const arrived = new Promise(r => { entered = r; });
  const { app, calls } = pollApp(async url => {
    if (url === '/api/jobs/job_run') return jsonResponse(200, { job: RUNNING });
    if (String(url).endsWith('/abstraction/status')) {
      statusGets++;
      if (statusGets === 5) { entered(); await held.promise; }
      return jsonResponse(200, { status: { pending: 1, processing: 0, failed: 0, completed: 0 } });
    }
    return jsonResponse(200, { ok: true });
  });
  app.ctx.location.hash = '#/job/job_run';
  await app.ctx.loadJobView('job_run');
  for (let i = 0; i < 4; i++) await app.run('runJobPollTick(activeJobPollState)');
  const fifth = app.run('runJobPollTick(activeJobPollState)');
  await arrived;
  app.ctx.location.hash = '#/jobs';
  app.run('applyRoute(parseRoute())');
  held.resolve();
  await fifth;
  await tick(3);
  assert.equal(statusGets, 5);
  assert.deepEqual(calls.filter(c => c.startsWith('POST')), [], 'no workflow kick after leaving');
});

// ---- R2-12 (R05 Med): Home keeps the poller of the run this tab is driving.
test('R2 R05 a real home Build keeps its run-scoped poller through Recent Jobs and back Home', async () => {
  const { app, server, started, release } = homeBuild({ holdAbstraction: true });
  await app.ctx.handleFiles([pngFile('deed-1.png', 'a'.repeat(40)), pngFile('deed-2.png', 'b'.repeat(40))]);
  const run = app.run('analyze()');
  await started;
  assert.equal(app.run('activeJobPollState && activeJobPollState.scope'), 'run');
  app.ctx.location.hash = '#/jobs';
  app.run('applyRoute(parseRoute())');
  assert.equal(app.run('activeJobPollState && activeJobPollState.scope'), 'run', 'Recent Jobs keeps it');
  app.ctx.location.hash = '#/';
  app.run('applyRoute(parseRoute())');
  assert.equal(app.run('activeJobPollState && activeJobPollState.scope'), 'run', 'Home keeps it');
  assert.equal(app.run('activeJobPollState.cancelled'), false);
  const gets = () => server.calls.filter(c => c === 'GET /api/jobs/job_1').length;
  const before = gets();
  await tick(10);
  assert.ok(gets() > before, 'and it is still polling');
  release();
  await run;
});

// ---- R2-13 (R06 Med): a home follow-up that fails (500 or abort) keeps the question with Ask again.
test('R2 R06 a home follow-up 500 or aborted fetch keeps the question as one inline Ask again card', async () => {
  for (const mode of ['500', 'abort']) {
    const app = loadIndex({ fetchImpl: async url => {
      if (String(url).endsWith('/followup')) {
        if (mode === 'abort') throw new TypeError('Failed to fetch');
        return jsonResponse(500, { error: 'upstream timeout' });
      }
      return jsonResponse(404, {});
    } });
    app.ctx.__op = SAMPLE;
    app.run("conversationHistory = [{ role: 'user', content: 'docs' }, { role: 'assistant', content: __op, kind: 'title-opinion', sourceJobId: 'job_t' }]; renderResults();");
    app.getEl('followupInput').value = 'Home question?';
    await app.run('askFollowup()');
    await tick(3);
    const html = app.getEl('results').innerHTML;
    assert.equal((html.match(/data-followup-retry=/g) || []).length, 1, `${mode}: one retry card`);
    assert.match(html, /Home question\?/, `${mode}: the question is kept`);
    assert.match(html, /The answer could not be loaded\./, `${mode}: same copy as the job view`);
    assert.match(app.getEl('followupStatus').textContent, /The answer could not be loaded\./);
  }
});

// ---- R2-14 (R11 Low): one tracked jsPDF loader; retries never stack script tags.
test('R2 R11 three blocked retries then success leave exactly one jsPDF script tag', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const SRC = '/vendor/jspdf/jspdf.umd.min.js';
  const head = { children: [] };
  const makeScript = () => {
    const el = { tagName: 'SCRIPT', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return k === 'src' ? this.src : (this.attrs[k] ?? null); } };
    el.remove = () => { head.children = head.children.filter(c => c !== el); };
    return el;
  };
  head.appendChild = el => { head.children.push(el); return el; };
  head.removeChild = el => { head.children = head.children.filter(c => c !== el); return el; };
  const staticTag = makeScript();
  staticTag.src = SRC;
  head.appendChild(staticTag);
  app.ctx.document.head = head;
  app.ctx.document.createElement = () => makeScript();
  app.ctx.document.querySelectorAll = sel => (/script/.test(sel) ? head.children.slice() : []);
  const jsTags = () => head.children.filter(c => c.src === SRC);
  app.ctx.downloadPDF({ rootElement: mdCardRoot(SAMPLE), tractOverride: 'T' });
  for (let i = 0; i < 3; i++) {
    app.run('retryPdfExport()');
    app.run('retryPdfExport()');
    assert.equal(jsTags().length, 1, `attempt ${i + 1}: one tag while loading, a double click reuses it`);
    jsTags()[0].onerror();
    assert.ok(jsTags().length <= 1, `attempt ${i + 1}: failed tags do not pile up`);
  }
  app.run('retryPdfExport()');
  assert.equal(jsTags().length, 1);
  const tag = jsTags()[0];
  assert.equal(tag.src, SRC);
  assert.equal(tag.integrity || tag.attrs.integrity, 'sha384-qovJwSBbRDPP5cEjCp8S0UP66wrvnjaa60XMOGzTNanrThcrGfXfnZkvgY8N1KT3');
  assert.equal(tag.crossOrigin || tag.attrs.crossorigin, 'anonymous');
  const pdf = fakeJsPdf();
  app.ctx.jspdf = pdf.jspdf;
  tag.onload();
  assert.equal(pdf.log.saved.length, 1, 'the export runs once');
  assert.equal(jsTags().length, 1, 'exactly one jsPDF script tag after success');
});

// ---- R2-15 (C02 Low): the shared markdown table path carries a caption and scoped headers.
test('R2 C02 fallback and Full opinion text tables have a visually hidden caption and scope="col" headers', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const fallback = app.ctx.md('The model returned prose instead of the required sections.\n\n## Notes\n- Owner list unavailable\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.match(fallback, /<table><caption class="rd-sr">Notes<\/caption>/);
  assert.match(fallback, /<th scope="col">a<\/th><th scope="col">b<\/th>/);
  const untitled = app.ctx.md('| a | b |\n|---|---|\n| 1 | 2 |\n');
  assert.match(untitled, /<caption class="rd-sr">Table<\/caption>/);
  const html = app.ctx.renderResultsDashboard(app.ctx.parseTitleOpinion(SAMPLE), SAMPLE, {});
  const raw = html.split('<details class="rd-raw')[1];
  const tables = (raw.match(/<table/g) || []).length;
  assert.ok(tables >= 1);
  assert.equal((raw.match(/<caption class="rd-sr">/g) || []).length, tables, 'every raw-card table has a caption');
  assert.ok(!/<th(?=[\s>])(?![^>]*scope="col")[^>]*>/.test(raw), 'every raw-card header cell is scoped');
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
    console.log(`✗ ${t.name}\n  ${err.stack || err.message}`);
  }
}
disposeAll();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
