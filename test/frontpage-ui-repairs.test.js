// Front page UI repairs from the PR 135 review: sticky-bar focus, completion subtitle,
// phone queue padding, subtitle contrast, dropzone name, Recent Jobs hint reach.
// Behavior runs the real inline script in the VM harness; CSS checks resolve the real stylesheet.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposeAll, jsonResponse, loadIndex, makeJobServer, pngFile, tick } from './helpers/browser-index-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '../public/index.html'), 'utf8');
const SAMPLE = readFileSync(join(here, 'fixtures/title-opinion-sample.md'), 'utf8');
const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');

// Flat, ordered rule list: { selectors, decls, media } with media '' for top level.
function parseRules(source) {
  const rules = [];
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = text.indexOf('{', i);
      if (open < 0) break;
      const head = text.slice(i, open).trim();
      let depth = 1, j = open + 1;
      while (depth && j < text.length) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
      const body = text.slice(open + 1, j - 1);
      if (head.startsWith('@media')) walk(body, head);
      else if (!head.startsWith('@')) {
        const decls = {};
        body.split(';').forEach(d => { const k = d.indexOf(':'); if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim(); });
        rules.push({ selectors: head.split(',').map(s => s.trim()), decls, media: media || '' });
      }
      i = j;
    }
  };
  walk(source, '');
  return rules;
}
const RULES = parseRules(css);
const mediaApplies = (media, width) => {
  if (!media) return true;
  if (/prefers-reduced-motion/.test(media)) return false;
  const max = media.match(/max-width:\s*(\d+)px/);
  const min = media.match(/min-width:\s*(\d+)px/);
  return (!max || width <= Number(max[1])) && (!min || width >= Number(min[1]));
};
// Winning value for a property on an element that carries `classes`, among simple class selectors.
function resolveForClasses(classes, prop, width) {
  let best = null;
  RULES.forEach((rule, order) => {
    if (!mediaApplies(rule.media, width) || !(prop in rule.decls)) return;
    rule.selectors.forEach(sel => {
      const m = sel.match(/^(?:\.[\w-]+)+$/);
      if (!m) return;
      const parts = sel.split('.').filter(Boolean);
      if (!parts.every(p => classes.includes(p))) return;
      const spec = parts.length;
      if (!best || spec > best.spec || (spec === best.spec && order >= best.order)) best = { spec, order, value: rule.decls[prop] };
    });
  });
  return best?.value;
}
const declFor = (selector, prop, width) => {
  let value;
  RULES.forEach(rule => { if (mediaApplies(rule.media, width) && rule.selectors.includes(selector) && prop in rule.decls) value = rule.decls[prop]; });
  return value;
};
const token = name => (css.match(new RegExp(`${name.replace(/[-]/g, '\\-')}:\\s*(#[0-9a-fA-F]{3,6})`)) || [])[1];
const resolveColor = v => (v?.startsWith('var(') ? token(v.slice(4, -1).trim()) : v);
const luminance = hex => {
  const h = hex.length === 4 ? hex.slice(1).split('').map(c => c + c).join('') : hex.slice(1);
  const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const openTag = id => (html.match(new RegExp(`<[a-z]+[^>]*\\bid="${id}"[^>]*>`)) || [''])[0];
const attr = (tag, name) => (tag.match(new RegExp(`\\s${name}="([^"]*)"`)) || [])[1];

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('U1 sticky focus: a visible follow-up bar reserves scroll padding so focused controls clear it on phones', () => {
  const pad = width => {
    let value;
    RULES.forEach(rule => {
      if (!mediaApplies(rule.media, width) || !('scroll-padding-bottom' in rule.decls)) return;
      if (rule.selectors.some(s => s.startsWith('html') && s.includes('#jobFollowup')) && rule.selectors.some(s => s.includes('#followupSection'))) value = parseFloat(rule.decls['scroll-padding-bottom']);
    });
    return value;
  };
  assert.ok(pad(1280) >= 80, `desktop scroll-padding-bottom under the action bar is ${pad(1280)}`);
  assert.ok(pad(390) >= 140, `phone scroll-padding-bottom must cover the wrapped two-row action bar, got ${pad(390)}`);
});

test('U2 subtitle: a completed analysis replaces the staged-files subtitle, and reset restores the default', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const subtitle = () => app.getEl('homeSubtitle').textContent;
  app.run(`files = [new File(['x'], 'a.pdf', { type: 'application/pdf' }), new File(['y'], 'b.pdf', { type: 'application/pdf' })]; updateStagedSummary();`);
  assert.match(subtitle(), /^2 documents ready\. Review the list, then build the chain of title\.$/, 'staged state keeps its count');
  app.ctx.__sample = SAMPLE;
  app.run(`conversationHistory = [
    { role: 'user', content: 'x', kind: 'analysis-input' },
    { role: 'assistant', content: __sample, kind: 'title-opinion' },
  ]; renderResults();`);
  assert.doesNotMatch(subtitle(), /staged and ready/, 'completed view must not claim files are still waiting to run');
  assert.match(subtitle(), /Analysis complete/);
  app.run('updateStagedSummary()');
  assert.match(subtitle(), /Analysis complete/, 'a later staged-summary refresh keeps the completed copy');
  app.run('resetHomeForNewJob()');
  assert.match(subtitle(), /^Add optional tract context/, 'reset returns to the empty-state copy');
});

test('U3 queue padding: the staged queue stays edge-to-edge on phones instead of inheriting card padding', () => {
  assert.equal(resolveForClasses(['card', 'queue-box'], 'padding', 1280), '0');
  assert.equal(resolveForClasses(['card', 'queue-box'], 'padding', 390), '0', 'mobile .card padding must not win over .queue-box');
  assert.equal(resolveForClasses(['card'], 'padding', 390), '16px', 'other cards keep their phone padding');
});

test('U4 contrast: the page subtitle meets 4.5:1 on the page background', () => {
  const fg = resolveColor(declFor('.page-head p', 'color', 1280));
  const bg = token('--bg');
  assert.ok(fg && bg, `colors resolved: ${fg} on ${bg}`);
  const ratio = contrast(fg, bg);
  assert.ok(ratio >= 4.5, `subtitle contrast ${ratio.toFixed(2)}:1 (${fg} on ${bg})`);
});

test('U5 dropzone: accessible name comes from its visible button text and the visible copy describes it', () => {
  const zone = openTag('uploadZone');
  assert.equal(attr(zone, 'role'), 'button');
  assert.equal(attr(zone, 'aria-label'), undefined, 'a hidden aria-label overrides the visible "Select Files" text');
  const labelledby = attr(zone, 'aria-labelledby');
  assert.ok(labelledby, 'dropzone must be labelled by visible text');
  labelledby.split(/\s+/).forEach(id => {
    const tag = openTag(id);
    assert.ok(tag, `labelledby target #${id} exists`);
    assert.notEqual(attr(tag, 'aria-hidden'), 'true', `#${id} must not be aria-hidden`);
  });
  assert.match(html.slice(html.indexOf(openTag(labelledby.split(/\s+/)[0]))).slice(0, 200), /Select Files/);
  const describedby = attr(zone, 'aria-describedby');
  assert.ok(describedby && openTag(describedby), 'dropzone description points at the visible drop copy');
});

test('U6 Recent Jobs: the disabled toolbar item stays focusable and hoverable so its hint is reachable', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const button = app.getEl('recentJobsButton');
  button.removeAttribute = k => { delete button[k]; };
  app.run('renderRecentJobsToolbar()');
  assert.equal(button.getAttribute('aria-disabled'), 'true');
  assert.equal(button.getAttribute('href'), null, 'disabled item still has no destination');
  assert.equal(button.getAttribute('tabindex'), '0', 'keyboard users must be able to reach the explanation');
  const tag = openTag('recentJobsButton');
  assert.equal(attr(tag, 'tabindex'), '0', 'initial markup is focusable before script runs');
  assert.equal(attr(tag, 'role'), 'link', 'an <a> without href needs an explicit role for aria-disabled to be announced');
  assert.equal(attr(tag, 'aria-describedby'), 'recentJobsToolbarHint');
  assert.notEqual(declFor('.recent-jobs-toolbar-button--disabled', 'pointer-events', 1280), 'none', 'pointer-events:none blocks hover and tap, so the hint never shows');
  app.run(`localStorage.setItem(RECENT_JOBS_KEY, JSON.stringify([{ id: 'j1', status: 'complete', lastViewedAt: Date.now(), documentCount: 1 }])); renderRecentJobsToolbar();`);
  assert.equal(button.getAttribute('aria-disabled'), 'false');
  assert.equal(button.getAttribute('href'), '#/jobs');
  assert.equal(button.getAttribute('tabindex'), '0');
});

// ---- Front-page audit findings F01-F11 (report.md). Behavior runs the real inline script in the VM harness.

const pdfFile = (name, body = '%PDF-1.4\n%%EOF\n') => new File([Buffer.from(body)], name, { type: 'application/pdf' });
const rowCount = app => (app.getEl('fileList').innerHTML.match(/class="file-item/g) || []).length;
const plainText = s => String(s).replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const homeApp = (fetchImpl = async () => jsonResponse(404, {})) => loadIndex({ fetchImpl });
const pngs = (n, prefix = 'deed') => Array.from({ length: n }, (_, i) => pngFile(`${prefix}-${String(i + 1).padStart(3, '0')}.png`, `x${i}`));
function recordingClassList(el) {
  const set = new Set();
  el.classList = { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c) };
  return set;
}

test('F01 queue: all 400 staged files render, searchable and filterable, with an explicit filtered state', async () => {
  const app = homeApp();
  await app.ctx.handleFiles([...pngs(397), pdfFile('Deed_Smith_1948 (pp 3-4).pdf'), new File(['a,b\n1,2'], 'runsheet.csv', { type: 'text/csv' }), pdfFile('Deed_Jones_1950.pdf')]);
  assert.equal(app.run('files.length'), 400);
  assert.equal(rowCount(app), 400, 'every staged file has a row, no 8-row cap');
  assert.match(plainText(app.getEl('fileList').innerHTML), /Showing 400 of 400 staged documents/);
  assert.equal(app.getEl('queueTools').hidden, false, 'search and filter appear once files are staged');
  const order = [...app.run('files.map(f => f.name)')];
  assert.equal(order[0], 'deed-001.png');
  assert.equal(order[399], 'Deed_Jones_1950.pdf', 'selection order kept');

  app.run("queueView.query = 'deed_'; renderFileList()");
  assert.equal(rowCount(app), 2, 'name search is case-insensitive');
  const filtered = plainText(app.getEl('fileList').innerHTML);
  assert.match(filtered, /Filtered: showing 2 of 400 files matching “deed_”/);
  assert.match(filtered, /Clear filter/);
  assert.match(filtered, /Showing 2 of 400 staged documents/);
  app.run("queueView.query = ''; queueView.type = 'pdf'; renderFileList()");
  assert.equal(rowCount(app), 2);
  app.run("queueView.type = 'csv'; renderFileList()");
  assert.equal(rowCount(app), 1);
  app.run("queueView.type = 'img'; renderFileList()");
  assert.equal(rowCount(app), 397);

  app.run("queueView.type = 'pdf'; renderFileList()");
  const smithId = app.run("files.find(f => f.name.startsWith('Deed_Smith')).stageId");
  assert.match(app.getEl('fileList').innerHTML, new RegExp(`onclick="removeStagedFile\\(${smithId}\\)"`), 'rows remove by stable id, not index');
  app.run(`removeStagedFile(${smithId})`);
  assert.equal(app.run('files.length'), 399);
  assert.equal(app.run("files.some(f => f.name.startsWith('Deed_Smith'))"), false, 'the filtered row removed is the one clicked');
  app.run('clearQueueFilter()');
  assert.equal(rowCount(app), 399);
  assert.doesNotMatch(app.getEl('fileList').innerHTML, /Filtered:/);
});

test('F02 intake queue: overlapping slow selections stage in order, Build waits, and the job counts what is staged', async () => {
  const posts = [];
  const server = makeJobServer({ hooks: { 'POST /api/jobs': async (_s, options) => { posts.push(JSON.parse(options.body)); return jsonResponse(500, { error: 'stop here' }); } } });
  const app = loadIndex({ fetchImpl: server.fetch });
  const Base = app.ctx.FileReader;
  app.ctx.FileReader = class extends Base { readAsDataURL(file) { setTimeout(() => super.readAsDataURL(file), 15); } };
  const first = app.ctx.handleFiles(pngs(2, 'A'));
  await tick(5);
  const second = app.ctx.handleFiles(pngs(10, 'B'));
  await first;
  assert.equal(app.getEl('analyzeBtn').disabled, true, 'Build stays off while the second selection is still reading');
  await app.run('analyze()');
  assert.equal(posts.length, 0, 'Build cannot start a job while intake is pending');
  await second;
  assert.equal(app.getEl('analyzeBtn').disabled, false);
  assert.deepEqual([...app.run('files.map(f => f.name[0])')], [...'AABBBBBBBBBB'], 'selections are processed strictly in order');
  await app.run('analyze()');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].totalDocuments, 12, 'submitted count equals the staged selection');
  assert.equal(app.run('files.length'), 12);
});

test('F03 cap: a selection over the free slots adds what fits and names the rest; a full queue says so', async () => {
  const app = homeApp();
  await app.ctx.handleFiles(pngs(398, 'base'));
  await app.ctx.handleFiles(pngs(5, 'extra'));
  assert.equal(app.run('files.length'), 400);
  const summary = plainText(app.getEl('intakeSummary').innerHTML);
  assert.match(summary, /Added 2 of 5\. 3 not added because the queue is limited to 400 files:/);
  for (const name of ['extra-003.png', 'extra-004.png', 'extra-005.png']) assert.ok(summary.includes(name), `omitted ${name} is listed`);
  assert.match(app.getEl('homeStatus').textContent, /Added 2 of 5 files\. 3 not added because the queue is limited to 400 files\./);

  await app.ctx.handleFiles(pngs(2, 'late'));
  const full = plainText(app.getEl('intakeSummary').innerHTML);
  assert.match(full, /The queue is full \(400 of 400 files\)\./);
  assert.match(full, /2 not added because the queue is limited to 400 files\. Remove staged files to make room:/);
  assert.ok(full.includes('late-001.png') && full.includes('late-002.png'));
});

test('F04 validation: unsupported, empty and non-PDF files are rejected by name; duplicates are staged and flagged', async () => {
  const app = homeApp();
  const same = pdfFile('DEED.PDF');
  await app.ctx.handleFiles([
    new File(['PK'], 'contract.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }),
    new File(['II*'], 'scan.tiff', { type: 'image/tiff' }),
    new File(['MZ'], 'setup.exe', { type: 'application/x-msdownload' }),
    new File(['plain'], 'README', { type: '' }),
    pdfFile('empty.pdf', ''),
    pdfFile('corrupt.pdf', 'this is not a pdf at all'),
    same,
  ]);
  await app.ctx.handleFiles([same]);
  assert.deepEqual([...app.run('files.map(f => f.name)')], ['DEED.PDF', 'DEED.PDF'], 'only the valid PDF is staged (and its repeat)');
  assert.deepEqual([...app.run('files.map(f => f.duplicate)')], [false, true]);
  const notes = app.getEl('intakeSummary').innerHTML;
  assert.match(plainText(notes), /1 has the same name, size and date as another staged file/, 'second selection reports the duplicate');
  assert.match(app.getEl('fileList').innerHTML, /file-status file-status--attn">Duplicate</);
  assert.match(app.getEl('fileList').innerHTML, /file-status">Staged</);
  app.run("queueView.type = 'attention'; renderFileList()");
  assert.equal(rowCount(app), 1, 'Needs attention shows the duplicate');

  const app2 = homeApp();
  await app2.ctx.handleFiles([
    new File(['PK'], 'contract.docx', { type: 'application/msword' }),
    new File(['II*'], 'scan.tiff', { type: 'image/tiff' }),
    new File(['plain'], 'README', { type: '' }),
    pdfFile('empty.pdf', ''),
    pdfFile('corrupt.pdf', 'this is not a pdf at all'),
  ]);
  assert.equal(app2.run('files.length'), 0);
  assert.equal(app2.getEl('analyzeBtn').disabled, true, 'nothing valid staged, Build stays off');
  const rejected = plainText(app2.getEl('intakeSummary').innerHTML);
  assert.match(rejected, /Added 0 of 5\. 5 not added:/);
  assert.match(rejected, /contract\.docx \.docx files are not supported/);
  assert.match(rejected, /scan\.tiff \.tiff files are not supported/);
  assert.match(rejected, /README No file type/);
  assert.match(rejected, /empty\.pdf The file is empty \(0 bytes\)/);
  assert.match(rejected, /corrupt\.pdf Not a readable PDF/);
});

test('F05 read failure: one unreadable file is named and skipped while the rest of the selection stages', async () => {
  const app = homeApp();
  const Base = app.ctx.FileReader;
  app.ctx.FileReader = class extends Base {
    readAsDataURL(file) { if (file.name.startsWith('bad')) { this.onerror?.(new Error('denied')); return; } super.readAsDataURL(file); }
  };
  await app.ctx.handleFiles([pdfFile('a_good.pdf'), pdfFile('bad_locked.pdf'), pdfFile('c_good.pdf'), pdfFile('d_good.pdf')]);
  assert.deepEqual([...app.run('files.map(f => f.name)')], ['a_good.pdf', 'c_good.pdf', 'd_good.pdf']);
  const summary = plainText(app.getEl('intakeSummary').innerHTML);
  assert.match(summary, /Added 3 of 4\. 1 not added: bad_locked\.pdf Could not be read/);
  assert.equal(app.getEl('analyzeBtn').disabled, false);
});

test('F06 Build errors: transport and parse failures become a plain recovery message in a focused alert region', async () => {
  assert.equal(attr(openTag('errorBox'), 'role'), 'alert');
  assert.equal(attr(openTag('errorBox'), 'tabindex'), '-1');
  const cases = {
    html502: async () => ({ ok: false, status: 502, headers: { get: () => null }, json: async () => { throw new SyntaxError("Unexpected token '<'"); } }),
    noJob: async () => jsonResponse(200, { ok: true }),
    network: async () => { throw new TypeError('Failed to fetch'); },
  };
  const expected = {
    html502: 'Could not start the run The server did not respond as expected (HTTP 502). Your files are still staged; try again.',
    noJob: 'Could not start the run The server did not respond as expected. Your files are still staged; try again.',
    network: 'Could not start the run The server could not be reached. Check your connection. Your files are still staged; try again.',
  };
  for (const [name, respond] of Object.entries(cases)) {
    const app = loadIndex({ fetchImpl: async (url, options = {}) => (url === '/api/jobs' && options.method === 'POST' ? respond() : jsonResponse(404, {})) });
    let focused = 0;
    app.getEl('errorBox').focus = () => { focused++; };
    await app.ctx.handleFiles(pngs(3));
    await app.run('analyze()');
    const text = plainText(app.getEl('errorBox').innerHTML);
    assert.equal(text, expected[name], name);
    assert.doesNotMatch(text, /Unexpected token|undefined|JSON|Cannot read/, name);
    assert.equal(focused, 1, `${name}: error box is focused`);
    assert.equal(app.run('files.length'), 3, `${name}: files stay staged`);
    assert.equal(app.getEl('analyzeBtn').disabled, false, `${name}: Build is available again`);
    assert.equal(app.getEl('uploadSection').style.display, 'block');
  }
});

test('F07 interruptions: leave guard covers staged files and runs in progress from this tab; a stopped browser run resumes as a plain notice', async () => {
  const app = homeApp();
  const warn = () => app.run('shouldWarnBeforeUnload()');
  assert.equal(warn(), false, 'empty page');
  await app.ctx.handleFiles(pngs(2));
  assert.equal(warn(), true, 'staged files, no run');
  app.run("activeAnalysisRun = { jobId: 'job_1', driver: 'browser' }");
  assert.equal(warn(), true, 'browser-driven run');
  app.run("activeAnalysisRun.driver = 'server'");
  assert.equal(warn(), true, 'a durable server run still pauses when this tab closes (F07b)');
  app.run("activeAnalysisRun = null; conversationHistory = [{ role: 'assistant', content: 'x', kind: 'title-opinion' }]");
  assert.equal(warn(), false, 'run finished');

  app.run("saveActiveJob({ id: 'job_keep' }, 'browser'); saveActiveJob({ id: 'job_keep', status: 'abstracting' })");
  assert.equal(app.run('loadSavedJobRecord().driver'), 'browser', 'progress saves keep the recorded driver');

  const calls = [];
  const resumed = loadIndex({ fetchImpl: async url => { calls.push(url); return jsonResponse(200, { job: { id: 'job_br', status: 'abstracting', totalDocuments: 12 } }); } });
  resumed.run("localStorage.setItem(getJobStorageKey(), JSON.stringify({ id: 'job_br', driver: 'browser' }))");
  await resumed.run('resumeLastAnalysisJob()');
  const notice = plainText(resumed.getEl('resumeNotice').innerHTML);
  assert.match(notice, /Your last run stopped when this tab closed\./);
  assert.match(notice, /no work continued after the tab closed or reloaded/);
  assert.notEqual(resumed.getEl('progressSection').style.display, 'block', 'no live-looking progress display');
  assert.equal(calls.length, 1, 'no polling for work that cannot continue');
});

test('F08 layout: one Build action sits after the queue with the error summary; phone filenames keep their tail', () => {
  const order = ['uploadZone', 'fileList', 'stageBar', 'analyzeBtn', 'errorBox'].map(id => html.indexOf(`id="${id}"`));
  assert.ok(order.every((v, i) => v > 0 && (i === 0 || v > order[i - 1])), `action bar follows the queue and precedes the error box: ${order}`);
  assert.equal((html.match(/id="analyzeBtn"/g) || []).length, 1, 'a single Build button');
  const head = html.slice(html.indexOf('class="page-head'), html.indexOf('id="uploadSection"'));
  assert.doesNotMatch(head, /analyzeBtn/, 'the header no longer carries a second Build control');
  assert.equal(declFor('.stage-bar .btn-primary', 'min-height', 390), '44px');
  assert.equal(declFor('.upload-hint .when-empty', 'display', 390), 'none', 'phone first screen drops the drag-only hint so Select Files fits');
  assert.equal(declFor('.upload-hint .when-empty', 'display', 1280), undefined);
  assert.equal(declFor('.fn-start', 'text-overflow', 390), 'ellipsis');
  const app = homeApp();
  const split = name => app.run(`fileNameHtml(${JSON.stringify(name)})`);
  assert.match(split('Warranty_Deed_Vane_to_Pettibone_Book_412_Page_88 (pp 3-4).pdf'), /<span class="fn-end">[^<]*Page_88 \(pp 3-4\)\.pdf<\/span>/);
  assert.match(split('001_Warranty_Deed_Vane_to_Pettibone_recorded_1948-03-02.pdf'), /<span class="fn-end">[^<]*1948-03-02\.pdf<\/span>/);
  assert.equal(plainText(split('short.pdf')), 'short.pdf');
  assert.equal(split('Warranty_Deed_<b>_Book_412_Page_88_final.pdf').includes('<b>'), false, 'filenames are escaped');
});

test('F09 accessibility: live status, focus after Remove, keyboard Add Documents zone with labeled Remove buttons and shared validation', async () => {
  assert.equal(attr(openTag('homeStatus'), 'aria-live'), 'polite');
  const zone2 = openTag('uploadZone2');
  assert.equal(attr(zone2, 'role'), 'button');
  assert.equal(attr(zone2, 'tabindex'), '0');
  assert.match(attr(zone2, 'onkeydown') || '', /Enter.*' '/);
  assert.ok(html.indexOf('id="fileList2"') > html.indexOf('id="fileInput2"'), 'Remove buttons are not nested inside the role=button zone');
  assert.equal(declFor('#fileList2 .file-remove', 'min-height', 1280), '28px');
  assert.equal(declFor('#fileList2 .file-remove', 'min-height', 390), '44px');

  const app = homeApp();
  const focusedSelectors = [];
  app.ctx.document.querySelector = selector => ({ focus: () => focusedSelectors.push(selector) });
  let zoneFocused = 0;
  app.getEl('uploadZone').focus = () => { zoneFocused++; };
  await app.ctx.handleFiles(pngs(3));
  assert.match(app.getEl('homeStatus').textContent, /Added 3 of 3 files\. 3 files staged\./);
  const ids = [...app.run('files.map(f => f.stageId)')];
  app.run(`removeStagedFile(${ids[1]})`);
  assert.equal(focusedSelectors.pop(), `#fileList [data-stage-id="${ids[2]}"] .file-remove`, 'focus moves to the next row');
  assert.match(app.getEl('homeStatus').textContent, /Removed deed-002\.png\. 2 files staged\./);
  app.run(`removeStagedFile(${ids[2]})`);
  assert.equal(focusedSelectors.pop(), `#fileList [data-stage-id="${ids[0]}"] .file-remove`, 'or the previous row when it was last');
  app.ctx.document.querySelector = () => null;
  app.run(`removeStagedFile(${ids[0]})`);
  assert.equal(zoneFocused, 1, 'empty queue returns focus to the drop zone');

  await app.ctx.handleAdditionalFiles([pngFile('new.png', 'n'), new File(['PK'], 'memo.docx', { type: 'application/msword' })]);
  const list2 = app.getEl('fileList2').innerHTML;
  assert.match(list2, /<button type="button" class="file-remove" aria-label="Remove new\.png"[^>]*>Remove<\/button>/);
  assert.match(plainText(app.getEl('intakeSummary2').innerHTML), /Added 1 of 2\. 1 not added: memo\.docx \.docx files are not supported/);
  assert.equal(app.getEl('addDocsBtn').disabled, false);
});

test('F10 saved job: finished runs show an Open results card with human labels; bad or missing ids are cleared', async () => {
  const jobs = {
    job_done: { id: 'job_done', status: 'complete', totalDocuments: 400, subjectTract: 'NW/4 Sec. 22' },
    job_part: { id: 'job_part', status: 'partial_failed', totalDocuments: 12 },
    job_fail: { id: 'job_fail', status: 'failed', totalDocuments: 12 },
  };
  const boot = async saved => {
    const calls = [];
    const app = loadIndex({ fetchImpl: async url => {
      calls.push(url);
      const id = decodeURIComponent(String(url).split('/').pop());
      return jobs[id] ? jsonResponse(200, { job: jobs[id] }) : jsonResponse(404, { error: 'Job not found.' });
    } });
    app.run(`localStorage.setItem(getJobStorageKey(), ${JSON.stringify(saved)})`);
    await app.run('resumeLastAnalysisJob()');
    return { app, calls, notice: app.getEl('resumeNotice').innerHTML, stored: app.run('localStorage.getItem(getJobStorageKey())') };
  };
  const done = await boot(JSON.stringify({ id: 'job_done' }));
  assert.match(plainText(done.notice), /Your last run finished\. Analysis complete · 400 documents · NW\/4 Sec\. 22 Open results/);
  assert.match(done.notice, /href="#\/job\/job_done"/);
  assert.equal(done.app.ctx.location.hash, '', 'stays on home');
  assert.notEqual(done.app.getEl('progressSection').style.display, 'block');
  const part = await boot(JSON.stringify({ id: 'job_part' }));
  assert.match(plainText(part.notice), /Finished with errors/);
  assert.doesNotMatch(part.notice, /partial_failed/);
  const fail = await boot(JSON.stringify({ id: 'job_fail' }));
  assert.match(plainText(fail.notice), /Job failed · 12 documents Open run details/);
  const gone = await boot(JSON.stringify({ id: 'job_gone' }));
  assert.equal(gone.stored, null, 'a confirmed 404 clears the stored id');
  assert.equal(gone.notice, '');
  for (const bad of [JSON.stringify({ id: { x: 1 } }), '"just-a-string"', '{not json', JSON.stringify({ id: '../../etc' })]) {
    const r = await boot(bad);
    assert.equal(r.calls.length, 0, `no request for ${bad}`);
    assert.equal(r.stored, null, `${bad} is dropped`);
  }
});

test('F11 copy: plain staged copy, no batching or model talk on intake, full badge only at the cap', async () => {
  const addDocs = html.slice(html.indexOf('id="addDocsSection"'), html.indexOf('id="addDocsBtn"'));
  assert.doesNotMatch(addDocs, /Claude|synthesis|batch/i);
  const app = homeApp();
  const badgeClasses = recordingClassList(app.getEl('stagedBadge'));
  await app.ctx.handleFiles(pngs(3));
  assert.equal(app.getEl('homeSubtitle').textContent, '3 documents ready. Review the list, then build the chain of title.');
  assert.equal(badgeClasses.has('full'), false, 'three files is not full');
  assert.match(app.getEl('stagedBadge').textContent, /^3 \/ 400 files · /);
  assert.doesNotMatch(app.getEl('stagedBadge').textContent, /batch/i);
  const queueHtml = app.getEl('fileList').innerHTML;
  const outsideDetails = queueHtml.replace(/<details class="q-tech"[\s\S]*?<\/details>/, '');
  assert.doesNotMatch(outsideDetails, /batch|synthesis|Claude/i, 'technical sizing lives only in the disclosure');
  assert.match(queueHtml, /<details class="q-tech"><summary>Technical details<\/summary>/);
  for (const text of [app.getEl('homeSubtitle').textContent, app.getEl('stageBarText').textContent]) {
    assert.doesNotMatch(text, /adaptive|synthesis|batch|Claude/i);
  }
  await app.ctx.handleFiles(pngs(397, 'more'));
  assert.equal(badgeClasses.has('full'), true, 'full styling at 400');
});

test('F07b durable runs: the leave warning stays on while a server job from this tab is in progress, and goes off at a terminal status', async () => {
  const statuses = { job_srv: 'abstracting' };
  const app = loadIndex({ fetchImpl: async url => {
    const id = decodeURIComponent(String(url).split('/').pop());
    return statuses[id] ? jsonResponse(200, { job: { id, status: statuses[id], totalDocuments: 12, completedDocuments: 3 } }) : jsonResponse(404, {});
  } });
  const warn = () => app.run('shouldWarnBeforeUnload()');
  app.run("localStorage.setItem(getJobStorageKey(), JSON.stringify({ id: 'job_srv', driver: 'server' }))");
  await app.run('resumeLastAnalysisJob()');
  assert.equal(app.run('activeJobId'), 'job_srv', 'durable job resumed into progress polling');
  assert.equal(app.run('files.length'), 0, 'nothing staged, so only the run can trigger the warning');
  assert.equal(warn(), true, 'durable run in progress: closing pauses it');
  app.run("activeJobPollState.lastJob = { id: 'job_srv', status: 'synthesizing' }");
  assert.equal(warn(), true, 'still in progress');
  statuses.job_srv = 'complete';
  app.run("renderPolledJobStatus({ id: 'job_srv', status: 'complete', totalDocuments: 12 })");
  assert.equal(warn(), false, 'same job complete: no warning');
  app.run("startJobPolling('job_srv'); activeJobPollState.lastJob = { id: 'job_srv', status: 'canceled' }");
  assert.equal(warn(), false, 'terminal status known to the poller: no warning');
  app.run('stopJobPolling(); activeAnalysisRun = { jobId: "job_x", driver: "server" }');
  assert.equal(warn(), true, 'a server-driven run started from this tab warns too');

  assert.equal(app.run('KEEP_OPEN_NOTICE'), 'Keep this tab open until the run finishes. Closing this tab pauses the run. Reopen the job to continue.');
  assert.doesNotMatch(app.run('KEEP_OPEN_NOTICE'), /worker loop|safely close/i);
});

// ---- Round 2: @buggy break-test findings BF1-BF8 on the F01-F11 fixes.

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const stageBarPad = width => {
  let value;
  RULES.forEach(rule => {
    if (!mediaApplies(rule.media, width) || !('scroll-padding-bottom' in rule.decls)) return;
    if (rule.selectors.some(s => s.startsWith('html') && s.includes('#stageBar:not([hidden])'))) value = parseFloat(rule.decls['scroll-padding-bottom']);
  });
  return value;
};

test('BF1 sticky Build bar: the page reserves scroll padding under the bar so focused queue controls are never covered', () => {
  // Measured in Chrome: bar 60px tall + 12px gap on desktop; 66px + 8px on phones, about 20px more while reading.
  assert.ok(stageBarPad(1280) >= 80, `desktop scroll-padding-bottom ${stageBarPad(1280)} must clear a 72px bar`);
  assert.ok(stageBarPad(390) >= 104, `phone scroll-padding-bottom ${stageBarPad(390)} must clear the 94px reading-state bar`);
  assert.ok(stageBarPad(320) >= 104);
  const sel = RULES.find(rule => rule.selectors.some(s => s.includes('#stageBar:not([hidden])')))?.selectors[0] || '';
  assert.match(sel, /#uploadSection:not\(\[style\*="none"\]\) > #stageBar:not\(\[hidden\]\)/, 'only while the bar is actually on screen');
  const followup = RULES.filter(rule => rule.selectors.some(s => s.includes('#jobFollowup')) && 'scroll-padding-bottom' in rule.decls);
  const ours = RULES.filter(rule => rule.selectors.some(s => s.includes('#stageBar:not([hidden])')));
  assert.ok(RULES.indexOf(ours.at(-1)) < RULES.indexOf(followup[0]), 'the follow-up bar rule still wins when both are present');
});

test('BF2 resume race: a slow saved-job check that lands during or after Build never takes over, and a failed create leaves the upload form', async () => {
  const scenario = async order => {
    const resumeGet = deferred();
    const create = deferred();
    const calls = [];
    const app = loadIndex({ fetchImpl: async (url, options = {}) => {
      const method = options.method || 'GET';
      calls.push(`${method} ${url}`);
      if (url === '/api/jobs/job_old') { await resumeGet.promise; return jsonResponse(200, { job: { id: 'job_old', status: 'abstracting', totalDocuments: 9, completedDocuments: 2 } }); }
      if (url === '/api/jobs' && method === 'POST') { await create.promise; return jsonResponse(500, { error: 'Database is unavailable.' }); }
      return jsonResponse(404, {});
    } });
    app.run("localStorage.setItem(getJobStorageKey(), JSON.stringify({ id: 'job_old', driver: 'server' }))");
    await app.ctx.handleFiles(pngs(2));
    const resume = app.run('resumeLastAnalysisJob()');
    const build = app.run('analyze()');
    await tick();
    assert.equal(app.run('loadSavedJobRecord()'), null, `${order}: Build supersedes the old saved record at once`);
    if (order === 'resume-first') { resumeGet.resolve(); await resume; create.resolve(); await build; }
    else { create.resolve(); await build; resumeGet.resolve(); await resume; }
    await tick();
    assert.notEqual(app.run('activeJobId'), 'job_old', `${order}: old job never becomes the active job`);
    assert.doesNotMatch(app.getEl('progressStatus').textContent, /job_old/, `${order}: old job never shows in the progress panel`);
    assert.equal(calls.filter(c => c.endsWith('/api/jobs/job_old')).length, 1, `${order}: no polling of the old job`);
    assert.equal(app.getEl('progressSection').style.display, 'none', `${order}: failed create hides the progress panel`);
    assert.equal(app.getEl('uploadSection').style.display, 'block', `${order}: upload form is back`);
    assert.match(plainText(app.getEl('errorBox').innerHTML), /^Could not start the run Database is unavailable\. Your files are still staged; try again\.$/);
    assert.equal(app.getEl('resumeNotice').innerHTML, '', `${order}: no stale resume card either`);
    assert.equal(app.run('files.length'), 2);
  };
  await scenario('resume-first');
  await scenario('create-first');
});

test('BF3 Add Documents errors: job-create failures use the Build recovery message and focus the alert', async () => {
  const cases = {
    html502: async () => ({ ok: false, status: 502, headers: { get: () => null }, json: async () => { throw new SyntaxError("Unexpected token '<'"); } }),
    network: async () => { throw new TypeError('Failed to fetch'); },
    json500: async () => jsonResponse(500, { error: 'Database is unavailable.' }),
  };
  const expected = {
    html502: 'Could not start the run The server did not respond as expected (HTTP 502). Your files are still staged; try again.',
    network: 'Could not start the run The server could not be reached. Check your connection. Your files are still staged; try again.',
    json500: 'Could not start the run Database is unavailable. Your files are still staged; try again.',
  };
  for (const [name, respond] of Object.entries(cases)) {
    const app = loadIndex({ fetchImpl: async (url, options = {}) => (url === '/api/jobs' && options.method === 'POST' ? respond() : jsonResponse(404, {})) });
    let focused = 0;
    app.getEl('errorBox').focus = () => { focused++; };
    await app.ctx.handleAdditionalFiles(pngs(2, 'more'));
    await app.run('analyzeAdditional()');
    const text = plainText(app.getEl('errorBox').innerHTML);
    assert.equal(text, expected[name], name);
    assert.doesNotMatch(text, /Job setup failed|Failed to fetch|Unexpected token/, name);
    assert.equal(focused, 1, `${name}: error box is focused`);
    assert.equal(app.run('additionalFiles.length'), 2, `${name}: files stay staged`);
    assert.equal(app.getEl('addDocsBtn').disabled, false);
    assert.equal(app.getEl('addDocsSection').style.display, 'block');
  }
});

test('BF4 duplicates follow the current list: removing the original clears the survivor, including mid-read removals', async () => {
  const app = homeApp();
  const same = pdfFile('same.pdf');
  await app.ctx.handleFiles([same]);
  await app.ctx.handleFiles([same]);
  assert.deepEqual([...app.run('files.map(f => f.duplicate)')], [false, true]);
  const [original] = app.run('files.map(f => f.stageId)');
  app.run(`removeStagedFile(${original})`);
  assert.deepEqual([...app.run('files.map(f => f.duplicate)')], [false], 'the survivor is no longer a duplicate');
  assert.match(app.getEl('fileList').innerHTML, /file-status">Staged</);
  assert.doesNotMatch(app.getEl('fileList').innerHTML, />Duplicate</);
  assert.doesNotMatch(app.getEl('stageBarText').textContent, /Duplicate/);
  app.run("queueView.type = 'attention'; renderFileList()");
  assert.equal(rowCount(app), 0, 'Needs attention is empty');

  const slow = homeApp();
  const Base = slow.ctx.FileReader;
  const gate = deferred();
  slow.ctx.FileReader = class extends Base { readAsDataURL(file) { if (file.__slow) gate.promise.then(() => super.readAsDataURL(file)); else super.readAsDataURL(file); } };
  const twin = pdfFile('twin.pdf');
  await slow.ctx.handleFiles([twin]);
  const again = new File([twin], twin.name, { type: twin.type, lastModified: twin.lastModified });
  again.__slow = true;
  const reading = slow.ctx.handleFiles([again]);
  await tick(5);
  slow.run(`removeStagedFile(${slow.run('files[0].stageId')})`);
  gate.resolve();
  await reading;
  assert.deepEqual([...slow.run('files.map(f => f.duplicate)')], [false], 'original removed while its copy was reading');
  assert.doesNotMatch(plainText(slow.getEl('intakeSummary').innerHTML), /same name, size and date/, 'the summary does not claim a duplicate either');

  const add = homeApp();
  await add.ctx.handleAdditionalFiles([same]);
  await add.ctx.handleAdditionalFiles([same]);
  add.run(`removeAdditionalFile(${add.run('additionalFiles[0].stageId')})`);
  assert.doesNotMatch(add.getEl('fileList2').innerHTML, /Duplicate/, 'Add Documents list follows the same rule');
});

test('BF5 dismiss focus: dismissing the file summary or the last-run card moves focus to the drop zone, not the page body', async () => {
  const app = homeApp();
  let zone = 0, zone2 = 0;
  app.getEl('uploadZone').focus = () => { zone++; };
  app.getEl('uploadZone2').focus = () => { zone2++; };
  await app.ctx.handleFiles([new File(['PK'], 'memo.docx', { type: 'application/msword' })]);
  assert.match(app.getEl('intakeSummary').innerHTML, /onclick="dismissIntakeSummary\('home'\)"/);
  app.run("dismissIntakeSummary('home')");
  assert.equal(app.getEl('intakeSummary').innerHTML, '');
  assert.equal(zone, 1);
  await app.ctx.handleAdditionalFiles([new File(['PK'], 'memo.docx', { type: 'application/msword' })]);
  app.run("dismissIntakeSummary('additional')");
  assert.equal(zone2, 1, 'Add Documents summary returns focus to its own zone');
  app.run("renderResumeNotice('finished', { id: 'job_done', status: 'complete' })");
  app.run('dismissResumeNotice()');
  assert.equal(app.getEl('resumeNotice').innerHTML, '');
  assert.equal(zone, 2);
  app.run('hideAddDocs()');
  assert.equal(zone2, 1, 'closing Add Documents clears its summary without stealing focus');
});

test('BF6 announcements: reading progress speaks at start and each quarter only; filter results are announced politely', async () => {
  for (const id of ['intakeProgress', 'intakeProgress2']) {
    const tag = openTag(id);
    assert.equal(attr(tag, 'role'), 'status', `#${id} is a polite live region`);
    assert.ok(openTag(`${id}Say`) && /aria-hidden="true"/.test(openTag(`${id}Text`)), `#${id} keeps the ticking counter out of speech`);
  }
  const app = homeApp();
  const spoken = [];
  let value = '';
  Object.defineProperty(app.getEl('intakeProgressSay'), 'textContent', { get: () => value, set: v => { value = v; if (v) spoken.push(v); } });
  await app.ctx.handleFiles(pngs(400));
  assert.deepEqual(spoken, ['Reading files…', 'Read 100 of 400 files.', 'Read 200 of 400 files.', 'Read 300 of 400 files.'], '400 files, 4 announcements');
  assert.equal(app.getEl('intakeProgressText').textContent, '', 'visible counter clears when done');
  assert.match(app.getEl('homeStatus').textContent, /^Added 400 of 400 files\./, 'the finish is the intake summary');

  assert.match(html, /getElementById\('queueSearch'\)\.addEventListener\('input'[\s\S]{0,160}announceQueueView\(QUEUE_SEARCH_ANNOUNCE_DELAY_MS\)/);
  assert.match(html, /getElementById\('queueFilter'\)\.addEventListener\('change'[\s\S]{0,120}announceQueueView\(\)/);
  app.run("queueView.query = 'deed-00'; renderFileList(); announceQueueView(QUEUE_SEARCH_ANNOUNCE_DELAY_MS)");
  assert.match(app.getEl('homeStatus').textContent, /^Added 400/, 'search results wait for typing to pause');
  await tick(5);
  assert.equal(app.getEl('homeStatus').textContent, 'Showing 9 of 400 staged files.');
  app.run("queueView.query = 'zzz'; renderFileList(); announceQueueView()");
  assert.equal(app.getEl('homeStatus').textContent, 'No staged files match this filter. 400 files staged.');
  app.run('clearQueueFilter()');
  assert.equal(app.getEl('homeStatus').textContent, 'Showing all 400 staged files.');
  app.run("queueView.query = 'deed-01'; announceQueueView(QUEUE_SEARCH_ANNOUNCE_DELAY_MS); announce('Removed deed-001.png. 399 files staged.')");
  await tick(5);
  assert.equal(app.getEl('homeStatus').textContent, 'Removed deed-001.png. 399 files staged.', 'a newer message is not overwritten by a pending search result');
});

test('BF7 long names: the last-run card and the filter note wrap unbroken tract and query text', () => {
  assert.equal(declFor('.resume-copy', 'overflow-wrap', 320), 'anywhere');
  assert.equal(declFor('.q-filter-note > span', 'overflow-wrap', 320), 'anywhere');
  assert.equal(declFor('.q-filter-note > span', 'min-width', 320), '0');
  assert.equal(declFor('.intake-note li', 'overflow-wrap', 320), 'anywhere');
});

test('BF8 320 wide: the drop zone sheds its icon and some spacing so Select Files is on the first screen; wider screens are unchanged', () => {
  assert.equal(declFor('.drop-icon', 'display', 320), 'none');
  assert.notEqual(declFor('.drop-icon', 'display', 390), 'none', '390 keeps the icon');
  assert.equal(declFor('.upload-zone', 'padding', 390), '20px 18px');
  assert.equal(declFor('.upload-zone', 'padding', 320), '14px 16px 16px');
  assert.equal(declFor('.ctx-bar', 'padding', 390), '14px');
  assert.equal(declFor('.ctx-bar', 'padding', 1280), '12px 18px');
});

test('BF copy: job errors keep their own end punctuation, and failed or canceled runs read "stopped"', () => {
  const app = homeApp();
  const msg = m => app.run(`jobSetupErrorMessage({ message: ${JSON.stringify(m)} })`);
  assert.equal(msg('Quota exceeded!'), 'Could not start the run: Quota exceeded! Your files are still staged; try again.');
  assert.equal(msg('Is the server up?'), 'Could not start the run: Is the server up? Your files are still staged; try again.');
  assert.equal(msg('Database is unavailable.'), 'Could not start the run: Database is unavailable. Your files are still staged; try again.');
  assert.equal(msg('Database is unavailable'), 'Could not start the run: Database is unavailable. Your files are still staged; try again.');
  const lead = status => {
    app.run(`renderResumeNotice('finished', { id: 'job_x', status: '${status}', totalDocuments: 3 })`);
    return plainText(app.getEl('resumeNotice').innerHTML).split(' Analysis')[0].split(' Job')[0].split(' Finished')[0].split(' Canceled')[0];
  };
  assert.equal(lead('complete'), 'Your last run finished.');
  assert.equal(lead('partial_failed'), 'Your last run finished.');
  assert.equal(lead('failed'), 'Your last run stopped.');
  assert.equal(lead('canceled'), 'Your last run stopped.');
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
disposeAll();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
