// Results dashboard: parseTitleOpinion() tolerance, KPI math, fallback and escaping.
// Runs the real inline script from public/index.html in the VM harness.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { disposeAll, jsonResponse, loadIndex, tick } from './helpers/browser-index-harness.js';

const here = dirname(fileURLToPath(import.meta.url));
const SAMPLE = readFileSync(join(here, 'fixtures/title-opinion-sample.md'), 'utf8');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
const parse = md => JSON.parse(JSON.stringify(app.ctx.parseTitleOpinion(md)));
const render = md => app.ctx.renderResultsDashboard(app.ctx.parseTitleOpinion(md), md, { askInputId: 'jobFollowupInput', totalDocuments: 400 });

const OWNERS_ONLY = (rows, header = '| Owner | Reconciled Interest | Decimal | Royalty/NPRI | Subject To |') => `# Title Opinion: Test Tract
## EXECUTIVE SUMMARY
- Summary line.
## FINAL OWNERSHIP DETERMINATION
${header}
|---|---|---|---|---|
${rows.join('\n')}
`;

test('sample opinion parses into every section', () => {
  const p = parse(SAMPLE);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.title, 'NW/4 of Section 22, Block C-9, Larkspur Rail Survey, Mesquite Flats County, TX');
  assert.equal(p.summary.length, 5);
  assert.equal(p.chain.length, 10);
  assert.equal(p.defects.length, 4);
  assert.equal(p.owners.length, 7);
  assert.equal(p.qualifications.length, 3);
  assert.equal(p.qualifications[0].label, 'Assumption');
  assert.deepEqual(p.chain[5].flags, ['OVERGRANT', 'AMBIG']);
  assert.equal(p.chain[5].conveyed, '1/4');
  assert.equal(p.chain[5].convNote, 'habendum recites 5/16');
  assert.equal(p.chain[6].ref, 'Vol. 402 p. 77');
  assert.deepEqual(p.defects.map(d => d.severity), ['material', 'material', 'curative', 'clarify']);
  assert.equal(p.defects[0].sourceDoc, '3');
  assert.deepEqual(p.owners[1].subjectTo, ['D2', 'D3']);
  assert.equal(p.owners[5].royaltyOnly, true);
});

test('sample opinion KPIs: 87.5% reconciled, 7 owners, 4 defects, 10 instruments', () => {
  const s = parse(SAMPLE).stats;
  assert.equal(s.reconciledPct, 87.5);
  assert.equal(s.summaryPct, 87.5);
  assert.equal(s.sumState, 'whole');
  assert.equal(s.ownerCount, 7);
  assert.equal(s.mineralOwners, 5);
  assert.equal(s.royaltyOwners, 1);
  assert.equal(s.divestedOwners, 1);
  assert.equal(s.defectCount, 4);
  assert.equal(s.chainCount, 10);
  assert.equal(s.flaggedCount, 3);
  assert.equal(s.firstYear, 1912);
  assert.equal(s.lastYear, 2011);
  assert.deepEqual(s.unreconciledOwners.map(o => o.name), ['Heirs of Wendell Ashby']);
});

test('sample dashboard markup carries final KPI values, donut, defect cards and the PDF source card', () => {
  const html = render(SAMPLE);
  assert.match(html, /<span data-count="87\.5" data-dec="1" data-suffix="%">87\.5%<\/span>/);
  assert.match(html, /<span data-count="7">7<\/span>/);
  assert.match(html, /<span data-count="4">4<\/span>/);
  assert.match(html, /<span data-count="10">10<\/span>/);
  assert.equal((html.match(/class="rd-seg"/g) || []).length, 5, 'one donut segment per owner with a mineral decimal');
  assert.equal((html.match(/<article class="rd-dcard /g) || []).length, 4);
  assert.match(html, /0\.50000000/);
  assert.match(html, /Sums to whole/);
  assert.match(html, /AI draft · verify against instruments/);
  assert.match(html, /data-rd-ask="D1" data-rd-input="jobFollowupInput"/);
  assert.match(html, /<div class="analysis-card"><div class="ac">/, 'full opinion stays in the DOM for downloadPDF');
  assert.match(html, /from 400 documents/);
});

test('tolerates ### headings, renamed and reordered columns, no separator row and stray whitespace', () => {
  const md = `###   Executive Summary
* Title is 100% reconciled.

### Final Ownership
|   Name of Owner |  Decimal Interest | Fraction | Burdens / Subject To | NPRI | Basis |
|  Jane Roe  | 0.75000000 | 3/4 | none | — | Deed 1 |
| John Roe | 0.25000000 | 1/4 |  | | Deed 2 |

### Chain of Title (runsheet)
| No. | Instrument | Recorded | From | To | Interest | Balance after | Issues | Extra |
| 1 | Deed | Bk 1 Pg 2 | A | Jane Roe | 3/4 | Jane 3/4 | none | x |
`;
  const p = parse(md);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.owners.length, 2);
  assert.equal(p.owners[0].name, 'Jane Roe');
  assert.equal(p.owners[0].value, 0.75);
  assert.equal(p.owners[0].interest, '3/4');
  assert.equal(p.owners[0].note, 'Deed 1');
  assert.equal(p.owners[1].royalty, '');
  assert.equal(p.stats.reconciledPct, 100);
  assert.equal(p.chain[0].grantee, 'Jane Roe');
  assert.equal(p.chain[0].ref, 'Bk 1 Pg 2');
  assert.deepEqual(p.chain[0].flags, []);
});

test('bold-line headings are accepted for known sections only', () => {
  const p = parse(`**EXECUTIVE SUMMARY**\n- One.\n\n**FINAL OWNERSHIP DETERMINATION**\n| Owner | Decimal |\n|---|---|\n| A | 1.00000000 |\n`);
  assert.equal(p.ok, true, p.reason);
  assert.equal(p.owners[0].name, 'A');
});

test('decimals that do not sum to 1 are reported, never rounded away', () => {
  const p = parse(OWNERS_ONLY(['| A | 1/2 | 0.50000000 | none | none |', '| B | 1/4 | 0.25000000 | none | none |']));
  assert.equal(p.stats.sumState, 'under');
  assert.equal(p.stats.decimalTotal, 0.75);
  assert.equal(p.stats.reconciledPct, 75, 'the missing quarter counts as open');
  assert.match(render(OWNERS_ONLY(['| A | 1/2 | 0.50000000 | none | none |', '| B | 1/4 | 0.25000000 | none | none |'])), /0\.25000000 unaccounted/);
  const over = parse(OWNERS_ONLY(['| A | 3/4 | 0.75000000 | none | none |', '| B | 1/2 | 0.50000000 | none | none |']));
  assert.equal(over.stats.sumState, 'over');
  assert.match(render(OWNERS_ONLY(['| A | 3/4 | 0.75000000 | none | none |', '| B | 1/2 | 0.50000000 | none | none |'])), /Over by 0\.25000000/);
});

test('non-numeric decimals show a dash instead of an invented percentage', () => {
  const md = OWNERS_ONLY(['| A | undivided half | unknown | none | none |', '| B | 1/2 | 0.50000000 | none | none |']);
  const p = parse(md);
  assert.equal(p.ok, true);
  assert.equal(p.stats.reconciledPct, null);
  assert.equal(p.stats.reconciledWhy, '1 decimal not numeric');
  const html = render(md);
  assert.doesNotMatch(html, /data-count="\d+(\.\d+)?" data-dec/);
  assert.match(html, /1 decimal not numeric/);
});

test('decimal falls back to a plain fraction in the interest column', () => {
  const p = parse(OWNERS_ONLY(['| A | 1/2 | — | none | none |', '| B | 1/2 | — | none | none |']));
  assert.equal(p.stats.reconciledPct, 100);
});

test('NPRI-only owners do not count as mineral owners or unreadable decimals', () => {
  const p = parse(OWNERS_ONLY(['| A | 1/1 | 1.00000000 | none | none |', '| Royalty Co. | — | n/a | NPRI 1/16 | none |']));
  assert.equal(p.owners[1].royaltyOnly, true);
  assert.equal(p.stats.reconciledPct, 100);
  assert.equal(p.stats.mineralOwners, 1);
  assert.equal(p.stats.royaltyOwners, 1);
});

test('an ownership table with zero rows renders an empty state', () => {
  const md = OWNERS_ONLY([]);
  const p = parse(md);
  assert.equal(p.ok, true);
  assert.equal(p.owners.length, 0);
  assert.equal(p.stats.reconciledPct, null);
  const html = render(md);
  assert.match(html, /No owners are listed/);
  assert.match(html, /No owners listed/);
});

test('falls back (ok=false) on garbage, odd output and missing key sections', () => {
  for (const md of [
    '',
    '   ',
    '## OPINION',
    'lorem ipsum | dolor\n<<<>>>\n|||',
    '# Title Opinion: X\n## EXECUTIVE SUMMARY\n- No table anywhere.',
    '## FINAL OWNERSHIP DETERMINATION\nOwnership cannot be determined from these documents.\n## CHAIN OF TITLE\n| # | Date |\n| 1 | 1900 |',
    '## FINAL OWNERSHIP DETERMINATION\n| Owner | Decimal |\n| A | 1 |',
  ]) {
    assert.equal(parse(md).ok, false, `expected fallback for: ${JSON.stringify(md).slice(0, 60)}`);
  }
  assert.equal(app.ctx.parseTitleOpinion(null).ok, false);
  assert.equal(app.ctx.parseTitleOpinion({}).ok, false);
});

test('model text is escaped everywhere, including <script> in cells', () => {
  const evil = '<script>alert(1)</script>';
  const md = `# Title Opinion: ${evil}
## EXECUTIVE SUMMARY
- ${evil} is 50% reconciled.
- **${evil}**
## CHAIN OF TITLE
| # | Date | Doc Type | Recording Ref | Grantor | Grantee | Interest Conveyed | Running Balance | Flags |
|---|---|---|---|---|---|---|---|---|
| 1 | ${evil} | ${evil} | ${evil} | ${evil} | ${evil} | ${evil} (${evil}) | ${evil} | ${evil} |
## TITLE DEFECTS & CURATIVE REQUIREMENTS
| # | Defect | Curative Needed | Source Doc |
|---|---|---|---|
| D1"><img src=x onerror=alert(2)> | ${evil} | ${evil} | Doc 1 |
## FINAL OWNERSHIP DETERMINATION
| Owner | Reconciled Interest | Decimal | Royalty/NPRI | Subject To |
|---|---|---|---|---|
| ${evil} | ${evil} | 1.00000000 | ${evil} | D1, ${evil} |
## OPINION QUALIFICATIONS
- ${evil}: ${evil}
`;
  const p = parse(md);
  assert.equal(p.ok, true, p.reason);
  const html = render(md);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test('very long cell text is kept whole and escaped', () => {
  const long = 'Lorem <b> ipsum '.repeat(400);
  const md = OWNERS_ONLY([`| ${long} | 1/1 | 1.00000000 | none | none |`]);
  const html = render(md);
  assert.ok(html.includes(long.trim().replace(/</g, '&lt;').replace(/>/g, '&gt;')));
});

test('renderJobResults shows the dashboard plus partial-result warnings, and keeps the follow-up wiring', () => {
  const run = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  run.ctx.renderJobResults({ id: 'job_d', totalDocuments: 400, subjectTract: 'NW/4' }, {
    finalTitleOpinion: SAMPLE,
    warnings: ['synthesis_driver:browser', '3 chunks truncated'],
    failedDocuments: [{ id: 'd1' }],
  });
  const html = run.getEl('jobResults').innerHTML;
  assert.match(html, /class="rd[ "]/);
  assert.match(html, /Browser synthesis fallback/);
  assert.match(html, /3 chunks truncated/);
  assert.match(html, /Excluded 1 failed document\./);
  assert.equal(run.getEl('jobFollowup').style.display, '');
  assert.equal(typeof run.getEl('jobFollowupBtn').onclick, 'function');
  assert.equal(typeof run.getEl('jobBarDownloadBtn').onclick, 'function');
  assert.equal(run.getEl('jobBarStatus').textContent, 'Draft · 4 open defects');
});

test('renderJobResults does not rewrite identical results (poller applies a finished job twice)', () => {
  const run = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const job = { id: 'job_twice', totalDocuments: 400 };
  const result = { finalTitleOpinion: SAMPLE, warnings: [], failedDocuments: [] };
  run.ctx.renderJobResults(job, result);
  const el = run.getEl('jobResults');
  el.innerHTML = 'SENTINEL';
  run.ctx.renderJobResults(job, result);
  assert.equal(el.innerHTML, 'SENTINEL', 'same job + same result keeps the DOM');
  run.ctx.renderJobResults(job, { ...result, warnings: ['new warning'] });
  assert.match(el.innerHTML, /new warning/, 'a changed result re-renders');
  run.ctx.renderJobResults(job, null);
  assert.equal(el.innerHTML, '');
  run.ctx.renderJobResults(job, { ...result, warnings: ['new warning'] });
  assert.match(el.innerHTML, /class="rd[ "]/, 'cleared view renders again');
});

test('renderJobResults falls back to the markdown card for unparseable output', () => {
  const run = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  run.ctx.renderJobResults({ id: 'job_1' }, { finalTitleOpinion: '## OPINION\nPlain prose <b>here</b>.', warnings: [], failedDocuments: [] });
  const html = run.getEl('jobResults').innerHTML;
  assert.doesNotMatch(html, /class="rd[ "]/);
  assert.match(html, /<div class="analysis-card"><div class="ac"><h3>OPINION<\/h3>/);
  assert.match(html, /&lt;b&gt;here&lt;\/b&gt;/);
  assert.equal(run.getEl('jobBarStatus').textContent, 'AI draft');
});

test('in-tab renderResults uses the dashboard for the newest opinion and markdown for the rest', () => {
  const run = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  run.ctx.__sample = SAMPLE;
  run.run(`conversationHistory = [
    { role: 'user', content: 'x', kind: 'analysis-input' },
    { role: 'assistant', content: __sample, kind: 'title-opinion' },
    { role: 'user', content: 'Who owns D1?', kind: 'followup' },
    { role: 'assistant', content: 'The heirs of Ashby.', kind: 'followup' },
  ]; renderResults();`);
  const html = run.getEl('results').innerHTML;
  assert.match(html, /class="rd[ "]/);
  assert.match(html, /data-rd-input="followupInput"/);
  assert.match(html, /Q: Who owns D1\?/);
  assert.match(html, /The heirs of Ashby\./);
  run.run(`conversationHistory = [
    { role: 'user', content: 'x', kind: 'analysis-input' },
    { role: 'assistant', content: 'Garbage output', kind: 'title-opinion' },
  ]; renderResults();`);
  assert.match(run.getEl('results').innerHTML, /Verify before relying on this/);
});

// ---- Regression tests for the @buggy findings (F1, F6, F7, F7b, F10, F12, F12b, PDF, details state).

const RH = '| Owner | Reconciled Interest | Royalty/NPRI | Subject To |\n|---|---|---|---|';
const DH = '| # | Defect | Curative Needed | Source Doc |\n|---|---|---|---|';
const CHAIN = '| # | Date | Doc Type | Recording Ref | Grantor | Grantee | Interest Conveyed | Running Balance | Flags |\n|---|---|---|---|---|---|---|---|---|\n| 1 | 1901 | Patent | V1 p2 | State | A | 1/1 | A: 1/1 | NONE |\n| 2 | 1950 | Mortgage | V9 p9 | A | Bank | lien | n/a | UNRELEASED |';
const OPINION = ({ summary = '- Summary line.', defects = DH, owners, chain = CHAIN, ownerHeader = RH }) =>
  `## EXECUTIVE SUMMARY\n${summary}\n## CHAIN OF TITLE\n${chain}\n## TITLE DEFECTS & CURATIVE REQUIREMENTS\n${defects}\n## FINAL OWNERSHIP DETERMINATION\n${ownerHeader}\n${owners}\n`;
const kpiCard = html => (html.match(/<div class="rd-kpi" data-rd-kpi="[^"]*">.*?<\/div><\/div>(?=\s*<div class="rd-kpi">)/s) || [''])[0];
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('F1: the KPI shows the opinion\'s stated 62.5% and warns that the table computes 100%', () => {
  const md = OPINION({
    summary: '- Mineral title is 62.5% reconciled; the remaining 37.5% is subject to 3 material defects.',
    defects: `${DH}\n| D1 | Mortgage never released. | Release of Lien | Doc 2 |\n| D2 | Deed grants 3/4 of 1/2. | Correction Deed | Doc 2 |`,
    owners: '| A | 1/2 | none | D1 |\n| B | 1/2 | none | D2 |',
  });
  const p = parse(md);
  assert.equal(p.stats.summaryPct, 62.5);
  assert.equal(p.stats.reconciledPct, 100);
  const card = kpiCard(render(md));
  assert.match(card, /data-rd-kpi="mismatch"/);
  assert.match(card, /data-count="62\.5"[^>]*>62\.5%</);
  assert.doesNotMatch(card, /class="val teal"/, 'never a clean green figure on a mismatch');
  assert.doesNotMatch(card, /All listed interest reconciled/);
  assert.match(plain(card), /As stated in the opinion/);
  assert.match(plain(card), /Ownership table computes 100%/);
  assert.doesNotMatch(render(md), /<span class="ok">62\.5% reconciled<\/span>/, 'headline figure is not painted green');
});

test('F1: a stated figure that matches the table is shown plainly, labelled as stated', () => {
  const card = kpiCard(render(SAMPLE));
  assert.match(card, /data-rd-kpi="stated"/);
  assert.match(card, /class="val teal"/);
  assert.match(plain(card), /As stated in the opinion · 12\.5% open/);
  assert.doesNotMatch(card, /class="sub warn"/);
  assert.match(render(SAMPLE), /<span class="ok">87\.5% reconciled<\/span>/, 'headline colour follows the KPI');
});

test('F1: a computed 100% with open defects is never green', () => {
  const md = OPINION({ defects: `${DH}\n| D1 | Mortgage never released. | Release of Lien | Doc 2 |`, owners: '| A | 1/1 | none | D1 |' });
  const card = kpiCard(render(md));
  assert.match(card, /data-rd-kpi="computed"/);
  assert.match(card, /class="val "/);
  assert.match(plain(card), /All listed interest reconciled · 1 defect open/);
  const clean = kpiCard(render(OPINION({ defects: `${DH}\n| none | none | none | none |`, owners: '| A | 1/1 | none | none |' })));
  assert.match(clean, /class="val teal"/, 'an explicit none row: 100% may be green');
});

test('F6: decimal commas read as 0.5, never as 5; ambiguous commas are unreadable', () => {
  const DEC = '| Owner | Decimal | Royalty/NPRI | Subject To |\n|---|---|---|---|';
  const s = parse(OPINION({ ownerHeader: DEC, owners: '| A | 0,5 | none | none |\n| B | 0,5 | none | none |' })).stats;
  assert.equal(s.decimalTotal, 1);
  assert.equal(s.sumState, 'whole');
  const bad = parse(OPINION({ ownerHeader: DEC, owners: '| A | 1,5 | none | none |\n| B | 0,5,1 | none | none |' })).stats;
  assert.equal(bad.reconciledPct, null);
  assert.equal(bad.sumState, 'unknown');
  assert.equal(app.ctx.rdParseNumber('0,5'), 0.5);
  assert.equal(app.ctx.rdParseNumber('1,5'), null);
});

test('F7: over-allocated shares (3/4 + 1/2) show an over-allocated warning, not 100%', () => {
  const md = OPINION({ owners: '| A | 3/4 | none | none |\n| B | 1/2 | none | none |' });
  const s = parse(md).stats;
  assert.equal(s.sumState, 'over');
  assert.equal(s.reconciledPct, null);
  const html = render(md);
  const card = kpiCard(html);
  assert.match(card, /data-rd-kpi="over"/);
  assert.match(card, /Over-allocated/);
  assert.doesNotMatch(card, /data-count/);
  assert.match(plain(card), /Shares total 1\.25 of the whole/);
  assert.doesNotMatch(plain(html), /\b100%/);
});

test('F7b: Heirs 3/4 + B 1/2 is not normalised into an invented 40%', () => {
  const md = OPINION({ owners: '| Heirs of X | 3/4 | none | none |\n| B | 1/2 | none | none |' });
  const s = parse(md).stats;
  assert.equal(s.reconciledPct, null);
  assert.equal(s.overReconciled, 0.5);
  const html = render(md);
  assert.doesNotMatch(plain(html), /\b40(\.0)?%/);
  assert.match(plain(kpiCard(html)), /Shares total 1\.25 of the whole, 0\.5 reconciled; no percentage/);
  const stated = kpiCard(render(OPINION({ summary: '- Title is 50% reconciled.', owners: '| Heirs of X | 3/4 | none | none |\n| B | 1/2 | none | none |' })));
  assert.match(stated, /data-rd-kpi="mismatch"/, 'a stated figure still warns when the table is over-allocated');
});

test('F10: "Doc 2" is not linked to chain row #2; only an unambiguous reference attaches a recording ref', () => {
  const chain = CHAIN.replace('| 1 | 1901 | Patent | V1 p2', '| X | 1901 | Patent | V1 p2').replace('| 2 | 1950 | Mortgage | V9 p9', '| 1 | 1950 | Mortgage | V9 p9').replace('| X | 1901', '| 2 | 1901');
  const md = OPINION({
    chain,
    defects: `${DH}\n| D1 | Mortgage never released | Release | Doc 2 |\n| D2 | 1950 mortgage never released | Release | Doc 2 |\n| D3 | Patent reservation unclear | Stipulation | V1 p2 |`,
    owners: '| A | 1/1 | none | D1 |',
  });
  const cites = [...render(md).matchAll(/<(span|button)[^>]*class="rd-cite"[^>]*>(.*?)<\/\1>/g)].map(m => [m[1], plain(m[2]).trim(), (m[0].match(/data-rd-goto="[^"]*-chain-(\d+)"/) || [])[1]]);
  assert.deepEqual(cites[0], ['span', 'Doc 2', undefined], 'bare upload number: text only, no ref, no link');
  assert.deepEqual(cites[1], ['span', 'Doc 2', undefined], 'year + instrument type alone is not a pointer: text only, no ref, no link');
  assert.deepEqual(cites[2], ['button', 'V1 p2', '0'], 'source cites the recording ref itself');
  assert.doesNotMatch(cites[0][1], /V1 p2/);
});

test('F12: same job, equal-length result with different content re-renders', () => {
  const run = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const A = OPINION({ owners: '| Aaaa | 1/2 | none | none |\n| Bbbb | 1/2 | none | none |' });
  const B = A.replace('| Aaaa | 1/2', '| Aaaa | 1/4').replace('| Bbbb | 1/2', '| Bbbb | 3/4');
  assert.equal(A.length, B.length);
  run.ctx.renderJobResults({ id: 'j' }, { finalTitleOpinion: A, warnings: [], failedDocuments: [] });
  const el = run.getEl('jobResults');
  el.innerHTML = el.innerHTML.replace('rd-kpis', 'rd-kpis SENTINEL');
  run.ctx.renderJobResults({ id: 'j' }, { finalTitleOpinion: B, warnings: [], failedDocuments: [] });
  assert.doesNotMatch(el.innerHTML, /SENTINEL/);
  assert.match(plain(el.innerHTML.split('Full opinion text')[0]), /3\/4/);
});

test('F12b: a changed job.totalDocuments with the same result re-renders', () => {
  const run = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const result = { finalTitleOpinion: SAMPLE, warnings: [], failedDocuments: [] };
  run.ctx.renderJobResults({ id: 'j', totalDocuments: 7 }, result);
  assert.match(run.getEl('jobResults').innerHTML, /from 7 documents/);
  run.ctx.renderJobResults({ id: 'j', totalDocuments: 999 }, result);
  assert.match(run.getEl('jobResults').innerHTML, /from 999 documents/);
});

test('null warning entries render without throwing', () => {
  const run = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  run.ctx.renderJobResults({ id: 'w' }, { finalTitleOpinion: SAMPLE, warnings: [null, { message: 'obj' }], failedDocuments: [] });
  assert.match(run.getEl('jobResults').innerHTML, /<li>obj<\/li>/);
});

function pdfHarness({ throwOnSplit = false } = {}) {
  const run = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const texts = [];
  const saved = [];
  run.ctx.jspdf = {
    jsPDF: class {
      constructor() { this.internal = { pageSize: { getWidth: () => 216, getHeight: () => 279 }, getNumberOfPages: () => 1 }; }
      setFillColor() {} setDrawColor() {} rect() {} setTextColor() {} setFontSize() {} setFont() {} line() {} addPage() {} setPage() {}
      text(t) { texts.push(Array.isArray(t) ? t.join('|') : String(t)); }
      splitTextToSize(t) { if (throwOnSplit) throw new Error('boom in jsPDF'); return [t]; }
      save(name) { saved.push(name); }
    },
  };
  const details = { open: false };
  const para = { nodeType: 1, tagName: 'P', innerText: 'Smith & Jones', textContent: 'Smith & Jones', innerHTML: 'Smith &amp; Jones &lt;LLC&gt;<br>hold 1/2' };
  const card = { querySelector: sel => (sel === '.ac' ? { childNodes: [para] } : null) };
  const root = { querySelectorAll: sel => (sel === '.analysis-card' ? [card] : sel.startsWith('details.rd-raw') ? [details] : []) };
  return { run, texts, saved, details, root };
}

test('downloadPDF restores the collapsed "Full opinion text" even when jsPDF throws', () => {
  const ok = pdfHarness();
  ok.run.ctx.downloadPDF({ rootElement: ok.root, tractOverride: 'T' });
  assert.equal(ok.details.open, false);
  assert.equal(ok.saved.length, 1);
  assert.ok(ok.texts.includes('Smith & Jones <LLC> hold 1/2'), 'PDF paragraph text has entities decoded');
  const bad = pdfHarness({ throwOnSplit: true });
  assert.throws(() => bad.run.ctx.downloadPDF({ rootElement: bad.root, tractOverride: 'T' }), /boom in jsPDF/);
  assert.equal(bad.details.open, false, 'restored in finally');
});

test('"Full opinion text" keeps its open state across re-renders (in-tab follow-up and job view)', () => {
  const run = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  run.ctx.__sample = SAMPLE;
  run.run(`conversationHistory = [
    { role: 'user', content: 'x', kind: 'analysis-input' },
    { role: 'assistant', content: __sample, kind: 'title-opinion' },
  ]; renderResults();`);
  const results = run.getEl('results');
  assert.doesNotMatch(results.innerHTML, /<details class="rd-raw[^>]*\sopen>/, 'collapsed by default');
  results.querySelector = sel => (sel === 'details.rd-raw' ? { open: true } : null);
  run.run(`conversationHistory.push({ role: 'user', content: 'who?', kind: 'followup' }, { role: 'assistant', content: 'them', kind: 'followup' }); renderResults();`);
  assert.match(results.innerHTML, /<details class="rd-raw[^>]*\sopen>/, 'stays open after a follow-up');
  results.querySelector = sel => (sel === 'details.rd-raw' ? { open: false } : null);
  run.run('renderResults();');
  assert.doesNotMatch(results.innerHTML, /<details class="rd-raw[^>]*\sopen>/, 'stays closed when closed');

  const job = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  job.ctx.renderJobResults({ id: 'j' }, { finalTitleOpinion: SAMPLE, warnings: [], failedDocuments: [] });
  const el = job.getEl('jobResults');
  el.querySelector = sel => (sel === 'details.rd-raw' ? { open: true } : null);
  job.ctx.renderJobResults({ id: 'j' }, { finalTitleOpinion: SAMPLE, warnings: ['new'], failedDocuments: [] });
  assert.match(el.innerHTML, /<details class="rd-raw[^>]*\sopen>/);
  job.ctx.renderJobResults({ id: 'other' }, { finalTitleOpinion: SAMPLE, warnings: [], failedDocuments: [] });
  assert.doesNotMatch(el.innerHTML, /<details class="rd-raw[^>]*\sopen>/, 'a different job starts collapsed');
});

test('a late follow-up answer for job A does not repaint the view after switching to job B', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const run = loadIndex({ fetchImpl: async url => (String(url).endsWith('/followup') ? (await gate, jsonResponse(200, { followup: { answer: 'A-ANSWER' } })) : jsonResponse(404, {})) });
  const A = { finalTitleOpinion: SAMPLE, warnings: [], failedDocuments: [] };
  const B = { finalTitleOpinion: SAMPLE.replace('Calloway Minerals LP', 'BRAVO MINERALS LP'), warnings: [], failedDocuments: [] };
  run.ctx.renderJobResults({ id: 'a' }, A);
  run.getEl('jobFollowupInput').value = 'question about A';
  run.getEl('jobFollowupBtn').onclick();
  await tick(5);
  run.ctx.renderJobResults({ id: 'b' }, B);
  run.getEl('jobFollowupInput').value = 'draft for B';
  release();
  await tick(30);
  assert.match(run.getEl('jobResults').innerHTML, /BRAVO MINERALS LP/);
  assert.doesNotMatch(run.getEl('jobFollowupHistory').innerHTML, /A-ANSWER/);
  assert.equal(run.getEl('jobFollowupInput').value, 'draft for B', 'B\'s draft question is not cleared');
  assert.equal(run.run("JSON.stringify((jobFollowupHistoryByJob.get('a') || []).map(p => p.answer))"), '["A-ANSWER"]', 'A keeps its answer for later');
});

test('a failed result re-fetch keeps the dashboard already shown for that job', async () => {
  let fail = false;
  const run = loadIndex({ fetchImpl: async url => (String(url).endsWith('/result') ? (fail ? jsonResponse(500, {}) : jsonResponse(200, { result: { finalTitleOpinion: SAMPLE, warnings: [], failedDocuments: [] } })) : jsonResponse(404, {})) });
  const job = { id: 'x', status: 'complete', totalDocuments: 7, completedDocuments: 7 };
  await run.ctx.applyJobToView(job);
  assert.match(run.getEl('jobResults').innerHTML, /class="rd[ "]/);
  fail = true;
  await run.ctx.applyJobToView(job);
  assert.match(run.getEl('jobResults').innerHTML, /class="rd[ "]/, 'blip does not wipe the view');
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
