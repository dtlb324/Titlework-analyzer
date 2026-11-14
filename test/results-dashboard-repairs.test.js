// PR 135 repair prototype tests. Same style as test/results-dashboard.test.js; paste into that file
// (before the runner) when the repairs land. They run against the real inline script in the VM harness.
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
const kpi = md => JSON.parse(JSON.stringify(app.ctx.rdReconciledKpi(app.ctx.parseTitleOpinion(md))));

const RH = '| Owner | Reconciled Interest | Royalty/NPRI | Subject To |\n|---|---|---|---|';
const DH = '| # | Defect | Curative Needed | Source Doc |\n|---|---|---|---|';
const CH = '| # | Date | Doc Type | Recording Ref | Grantor | Grantee | Interest Conveyed | Running Balance | Flags |\n|---|---|---|---|---|---|---|---|---|';
const OPINION = ({ summary = '- Summary line.', chain = `${CH}\n| 1 | 1901 | Patent | V1 p2 | State | A | 1/1 | A: 1/1 | NONE |`, defects = DH, owners, ownerHeader = RH }) =>
  `## EXECUTIVE SUMMARY\n${summary}\n## CHAIN OF TITLE\n${chain}\n## TITLE DEFECTS & CURATIVE REQUIREMENTS\n${defects}\n## FINAL OWNERSHIP DETERMINATION\n${ownerHeader}\n${owners}\n`;
const HALF_OWNERS = '| A | 7/8 | none | none |\n| B | 1/8 | none | D1 |';

// ---- 1. Negation and bounds in the stated percent
const CLAIMS = [
  ['plain', '- Mineral title is 87.5% reconciled.', 'stated', 87.5],
  ['intensifier is not a hedge', '- Only 87.5% reconciled.', 'stated', 87.5],
  ['figure plus a denied bound', '- Title is 87.5% reconciled (not 100%).', 'stated', 87.5],
  ['not N%', '- Title is not 100% reconciled; 12.5% is subject to D1.', 'qualified', null],
  ['not yet N%', '- Title is not yet 100% reconciled.', 'qualified', null],
  ["isn't N%", "- Title isn't 100% reconciled.", 'qualified', null],
  ['less than N%', '- Title is less than 100% reconciled because of D1.', 'qualified', null],
  ['approximately N%', '- Title is approximately 90% reconciled.', 'qualified', null],
  ['at least N%', '- At least 80% of the interest is reconciled.', 'qualified', null],
  ['N% cannot be reconciled', '- 12.5% of the mineral interest cannot be reconciled until heirship is established (D1).', 'qualified', null],
  ['N% unreconciled', '- 50% unreconciled.', 'qualified', null],
  ['no figure, cannot be reconciled', '- Title cannot be reconciled.', 'qualified', null],
  ['not been fully reconciled', '- Ownership has not been fully reconciled.', 'qualified', null],
  ['N% remains to be reconciled', '- 12.5% remains to be reconciled.', 'qualified', null],
  ['N% still needs to be reconciled', '- 12.5% of the interest still needs to be reconciled.', 'qualified', null],
  ['requires reconciliation, no figure', '- The ownership table requires reconciliation against Doc 5.', 'qualified', null],
  ['has been reconciled is positive', '- 87.5% of the title has been reconciled.', 'stated', 87.5],
  ['no unreconciled interest is not a claim', '- No unreconciled interest remains.', 'none', null],
  ['over 100 is not a percent', '- Title is 120% reconciled.', 'none', null],
  ['decimal comma is not a percent', '- Title is 1,5% reconciled.', 'none', null],
];
for (const [name, bullet, state, pct] of CLAIMS) {
  test(`N1 ${name}: ${state}${pct == null ? '' : ` ${pct}`}`, () => {
    const s = parse(OPINION({ summary: bullet, owners: HALF_OWNERS })).stats;
    assert.equal(s.summaryClaim.state, state, JSON.stringify(s.summaryClaim));
    assert.equal(s.summaryPct, pct, 'only an unqualified figure becomes summaryPct');
  });
}

test('N1 a positive figure wins over a complementary negated one, whichever comes first', () => {
  const a = parse(OPINION({ summary: '- 12.5% of the interest cannot be reconciled until heirship is established.\n- Title is 87.5% reconciled.', owners: HALF_OWNERS })).stats;
  const b = parse(OPINION({ summary: '- Title is 87.5% reconciled.\n- The remaining 12.5% is unreconciled.', owners: HALF_OWNERS })).stats;
  assert.equal(a.summaryPct, 87.5);
  assert.equal(b.summaryPct, 87.5);
});

test('N1 conflicting figures are a conflict, not the first one', () => {
  const two = parse(OPINION({ summary: '- Title is 87.5% reconciled.\n- All of it, 100% reconciled.', owners: HALF_OWNERS })).stats.summaryClaim;
  assert.equal(two.state, 'conflict');
  assert.deepEqual(two.figures, [87.5, 100]);
  const clash = parse(OPINION({ summary: '- Title is 87.5% reconciled.\n- 25% of it is unreconciled.', owners: HALF_OWNERS })).stats.summaryClaim;
  assert.equal(clash.state, 'conflict');
  const denied = parse(OPINION({ summary: '- Title is 87.5% reconciled.\n- It is not 87.5% reconciled.', owners: HALF_OWNERS })).stats.summaryClaim;
  assert.equal(denied.state, 'conflict');
});

test('N1 the KPI shows the opinion\'s words, never a clean figure, for a qualified or conflicting claim', () => {
  const md = OPINION({ summary: '- Mineral title is not 100% reconciled; 1/16 is clouded by an overgrant (D1).', defects: `${DH}\n| D1 | Grant 1/4, habendum 5/16. | Stipulation | Doc 6 |`, owners: '| A | 3/4 | none | none |\n| B | 1/4 | none | D1 |' });
  const k = kpi(md);
  assert.equal(k.state, 'qualified');
  assert.equal(k.value, null);
  assert.doesNotMatch(k.tone, /teal/);
  assert.match(k.warn, /not 100% reconciled/);
  assert.match(k.sub.join(' '), /Table computes 100%/);
  const html = render(md);
  assert.match(html, /data-rd-kpi="qualified"/);
  assert.doesNotMatch(html, /data-count="100"/, 'no animated 100% headline');
  assert.doesNotMatch(html, /<span class="ok">/, 'no green highlight on the headline');
  assert.equal(kpi(OPINION({ summary: '- 87.5% reconciled.\n- 100% reconciled.', owners: HALF_OWNERS })).state, 'conflict');
});

test('N1 an open figure the table complements is consistent; one it does not is flagged', () => {
  const ok = kpi(OPINION({ summary: '- 12.5% of the mineral interest cannot be reconciled.', owners: '| A | 7/8 | none | none |\n| Heirs of B | 1/8 | none | none |' }));
  assert.equal(ok.state, 'computed');
  assert.equal(ok.value, 87.5);
  const bad = kpi(OPINION({ summary: '- 50% unreconciled.', owners: '| A | 1/1 | none | none |' }));
  assert.equal(bad.state, 'qualified');
  assert.match(bad.warn, /50% unreconciled/);
});

test('N1 a stated figure beside an unquantified open claim is never a clean stated figure', () => {
  const hundred = parse(OPINION({ summary: '- 100% reconciled. Title cannot be reconciled.', owners: '| A | 1/1 | none | none |' })).stats;
  assert.equal(hundred.summaryClaim.state, 'conflict', JSON.stringify(hundred.summaryClaim));
  assert.equal(hundred.summaryPct, null);
  assert.match(hundred.summaryClaim.quote, /cannot be reconciled/);
  const reversed = parse(OPINION({ summary: '- Title cannot be reconciled.\n- 100% reconciled.', owners: '| A | 1/1 | none | none |' })).stats.summaryClaim;
  assert.equal(reversed.state, 'conflict');
  const partial = parse(OPINION({ summary: '- 87.5% reconciled.\n- The remainder cannot be reconciled until heirship is established.', owners: HALF_OWNERS })).stats;
  assert.equal(partial.summaryClaim.state, 'qualified', JSON.stringify(partial.summaryClaim));
  assert.equal(partial.summaryPct, null);
});

test('N1 the KPI for "100% reconciled. Title cannot be reconciled." is amber text, not a green 100', () => {
  const md = `## EXECUTIVE SUMMARY\n- 100% reconciled. Title cannot be reconciled.\n## TITLE DEFECTS & CURATIVE REQUIREMENTS\n| # | Defect | Curative |\n|---|---|---|\n| none | none | none |\n## FINAL OWNERSHIP DETERMINATION\n| Owner | Reconciled Interest |\n|---|---|\n| A | 1/1 |\n`;
  const k = kpi(md);
  assert.equal(k.state, 'conflict');
  assert.equal(k.value, null);
  assert.doesNotMatch(k.tone, /teal/);
  assert.match(k.warn, /Title cannot be reconciled/);
  const html = render(md);
  assert.match(html, /data-rd-kpi="conflict"/);
  assert.doesNotMatch(html, /data-count="100"/, 'no animated 100% headline');
  assert.doesNotMatch(html, /<span class="ok">/, 'no green highlight on the headline');
});

test('N1 quoted claim text is escaped', () => {
  const html = render(OPINION({ summary: '- Not 100% reconciled <img src=x onerror=alert(1)> & more.', owners: HALF_OWNERS }));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('N1 the sample opinion is unchanged', () => {
  const s = parse(SAMPLE).stats;
  assert.equal(s.summaryClaim.state, 'stated');
  assert.equal(s.summaryPct, 87.5);
});

// ---- 2. Prose and uncertain defects
const PROSE_OPINION = (defectLines, summary = '- Mineral title is 100% reconciled.') =>
  `## EXECUTIVE SUMMARY\n${summary}\n## TITLE DEFECTS & CURATIVE REQUIREMENTS\n${defectLines}\n## FINAL OWNERSHIP DETERMINATION\n${RH}\n| B | 1/1 | none | D1 |\n`;

test('N2 defects written as a bullet are shown as text, never counted as none', () => {
  const md = PROSE_OPINION('- D1: Missing deed requires a corrective deed.');
  const p = parse(md);
  assert.equal(p.ok, true);
  assert.equal(p.stats.defectsState, 'prose');
  assert.equal(p.stats.defectCount, 0);
  assert.deepEqual(p.defectProse, ['D1: Missing deed requires a corrective deed.']);
  const html = render(md);
  assert.doesNotMatch(html.split('<details class="rd-raw')[0], /No title defects are listed/);
  assert.match(html.split('<details class="rd-raw')[0], /Missing deed requires a corrective deed/);
  assert.match(html, /See text/);
  assert.equal(app.ctx.rdBarStatus(app.ctx.parseTitleOpinion(md)), 'Draft · defects listed as text');
  assert.doesNotMatch(kpi(md).tone, /teal/, 'a stated 100% is not green while defects exist as text');
});

test('N2 none placeholders, separators and an absent section keep their own states', () => {
  for (const line of ['None identified.', '- None', '- No title defects identified.', 'N/A', '| # | Defect | Curative |\n|---|---|---|\n| none | none | none |']) {
    assert.equal(parse(PROSE_OPINION(line)).stats.defectsState, 'none', line);
  }
  const absent = parse('## EXECUTIVE SUMMARY\n- ok\n## FINAL OWNERSHIP DETERMINATION\n| Owner | Decimal |\n|---|---|\n| A | 1.00000000 |\n');
  assert.equal(absent.stats.defectsState, 'missing');
  assert.equal(app.ctx.rdBarStatus(absent), 'Draft · no defects section');
});

test('N2 an empty defects section is unknown, never none, and never a green 100', () => {
  for (const [name, body] of [['nothing', ''], ['blank lines', '\n\n'], ['separator only', '---'], ['table header only', DH]]) {
    const md = PROSE_OPINION(body);
    const p = parse(md);
    assert.equal(p.stats.defectsState, 'unknown', name);
    assert.equal(p.stats.defectCount, 0, name);
    const html = render(md);
    assert.doesNotMatch(html, /No title defects are listed/, `${name}: the card must not claim none`);
    assert.match(html, /defects section is empty/i, name);
    assert.doesNotMatch(kpi(md).tone, /teal/, `${name}: a stated 100% is not green when the defects section is empty`);
    assert.equal(app.ctx.rdBarStatus(app.ctx.parseTitleOpinion(md)), 'Draft · defects section empty', name);
  }
});

test('N2 an explicit none still reads as none and keeps the clean 100', () => {
  const md = PROSE_OPINION('None identified.');
  assert.equal(parse(md).stats.defectsState, 'none');
  assert.match(render(md), /No title defects are listed/);
  assert.match(kpi(md).tone, /teal/);
  assert.equal(app.ctx.rdBarStatus(app.ctx.parseTitleOpinion(md)), 'Draft · no open defects');
});

test('N2 a table keeps its rows; prose beside it is still shown as a note', () => {
  const p = parse(PROSE_OPINION(`${DH}\n| D1 | Missing deed. | Deed | Doc 1 |\nSee also the 1937 mortgage.`));
  assert.equal(p.stats.defectsState, 'listed');
  assert.equal(p.stats.defectCount, 1);
  assert.match(render(`## EXECUTIVE SUMMARY\n- x\n## TITLE DEFECTS & CURATIVE REQUIREMENTS\n${DH}\n| D1 | Missing deed. | Deed | Doc 1 |\nSee also the 1937 mortgage.\n## FINAL OWNERSHIP DETERMINATION\n${RH}\n| B | 1/1 | none | D1 |\n`), /See also the 1937 mortgage/);
});

test('N2 wrapped bullets read as one defect text', () => {
  const p = parse(PROSE_OPINION('- D1: Missing deed\n  requires a corrective deed.'));
  assert.deepEqual(p.defectProse, ['D1: Missing deed requires a corrective deed.']);
});

// ---- 3. Nested headings
test('N3 a deeper heading inside qualifications keeps its text', () => {
  const p = parse(`## EXECUTIVE SUMMARY\n- ok\n## FINAL OWNERSHIP DETERMINATION\n| Owner | Decimal |\n|---|---|\n| A | 1.00000000 |\n## OPINION QUALIFICATIONS\n### Missing records\nThis opinion excludes outstanding recorded liens.\n`);
  assert.match(p.qualifications.map(q => q.text).join(' | '), /excludes outstanding recorded liens/);
  assert.match(p.qualifications.map(q => q.text).join(' | '), /Missing records/);
});

test('N3 owner tables split by sub-headings are all read', () => {
  const p = parse(`## EXECUTIVE SUMMARY\n- ok\n## FINAL OWNERSHIP DETERMINATION\n### Mineral owners\n| Owner | Decimal |\n|---|---|\n| A | 0.75000000 |\n### Royalty owners\n| Owner | Decimal |\n|---|---|\n| B | 0.25000000 |\n`);
  assert.deepEqual(p.owners.map(o => o.name), ['A', 'B']);
  assert.equal(p.stats.sumState, 'whole');
});

test('N3 a deeper heading that resembles another section does not steal its lines', () => {
  const p = parse(`## EXECUTIVE SUMMARY\n- ok\n## FINAL OWNERSHIP DETERMINATION\n| Owner | Decimal |\n|---|---|\n| A | 1.00000000 |\n## OPINION QUALIFICATIONS\n### Defect-related assumptions\n- Assumption: records are complete.\n`);
  assert.equal(p.defects.length, 0);
  assert.equal(p.sections.includes('defects'), false);
  assert.equal(p.qualifications.length, 2);
});

test('N3 same-level unknown headings still close a section; section names still switch at any depth', () => {
  const closed = parse(`## EXECUTIVE SUMMARY\n- ok\n## FINAL OWNERSHIP DETERMINATION\n| Owner | Decimal |\n|---|---|\n| A | 1.00000000 |\n## OPINION QUALIFICATIONS\n- Assumption: x\n## APPENDIX\n- not a qualification\n`);
  assert.equal(closed.qualifications.length, 1);
  const switched = parse(`## EXECUTIVE SUMMARY\n- ok\n### FINAL OWNERSHIP DETERMINATION\n| Owner | Decimal |\n|---|---|\n| A | 1.00000000 |\n`);
  assert.equal(switched.owners.length, 1);
});

// ---- 4. Mixed defect references
const SUBJECT = cell => parse(OPINION({ defects: `${DH}\n| D1 | A | B | Doc 1 |\n| D2 | C | D | Doc 2 |`, owners: `| A | 1/1 | none | ${cell} |` })).owners[0];

test('N4 defect ids keep their free text, and free text keeps its ids', () => {
  assert.deepEqual([SUBJECT('D1; unreleased 1937 mortgage').subjectTo, SUBJECT('D1; unreleased 1937 mortgage').subjectOther], [['D1'], 'unreleased 1937 mortgage']);
  assert.deepEqual([SUBJECT('D1, D2').subjectTo, SUBJECT('D1, D2').subjectOther], [['D1', 'D2'], '']);
  assert.deepEqual([SUBJECT('D2 and D1').subjectTo, SUBJECT('D2 and D1').subjectOther], [['D2', 'D1'], '']);
  assert.deepEqual([SUBJECT('**D-01**').subjectTo, SUBJECT('**D-01**').subjectOther], [['D1'], '']);
  assert.deepEqual([SUBJECT('D1 (see Vol. 2 p3)').subjectTo, SUBJECT('D1 (see Vol. 2 p3)').subjectOther], [['D1'], 'see Vol. 2 p3']);
});

test('N4 tokens that merely look like ids stay text', () => {
  const o = SUBJECT('Doc3, p3, V1');
  assert.deepEqual(o.subjectTo, []);
  assert.equal(o.subjectOther, 'Doc3, p3, V1');
  assert.deepEqual(SUBJECT('none').subjectTo, []);
  assert.equal(SUBJECT('n/a').subjectOther, '');
  assert.equal(SUBJECT('unknown lien').subjectOther, 'unknown lien');
});

test('N4 a non-D id is a chip only when the opinion lists that defect', () => {
  const md = OPINION({ defects: `${DH}\n| C-1 | A | B | Doc 1 |`, owners: '| A | 1/1 | none | C1, X9 |' });
  const o = parse(md).owners[0];
  assert.deepEqual(o.subjectTo, ['C1']);
  assert.equal(o.subjectOther, 'X9');
});

test('N4 the owners table shows the chip and the extra text together', () => {
  const html = render(OPINION({ defects: `${DH}\n| D1 | A | B | Doc 1 |`, owners: '| A | 1/1 | none | D1; unreleased 1937 mortgage |' }));
  assert.match(html.split('<details class="rd-raw')[0], /rd-chip d[^>]*>D1<\/span><\/span> unreleased 1937 mortgage/);
});

// ---- 5. Fraction / decimal conflict and negative shares
const OWN = (rows, header = '| Owner | Reconciled Interest | Decimal | Royalty/NPRI | Subject To |') => `## EXECUTIVE SUMMARY\n- ok\n## FINAL OWNERSHIP DETERMINATION\n${header}\n|---|---|---|---|---|\n${rows.join('\n')}\n`;

test('N5 a fraction that disagrees with its decimal is unreadable, never "sums to whole"', () => {
  const md = OWN(['| B | 1/2 | 1.00000000 | none | none |']);
  const p = parse(md);
  assert.equal(p.owners[0].value, null);
  assert.equal(p.owners[0].issue, 'conflict');
  assert.equal(p.stats.sumState, 'unknown');
  assert.equal(p.stats.reconciledPct, null);
  const html = render(md);
  assert.doesNotMatch(html, /Sums to whole/);
  assert.match(html, /Interest and decimal disagree/);
  assert.match(html, /Total not computed/);
  assert.match(kpi(md).sub.join(' '), /disagrees with its decimal/);
});

test('N5 a decimal agreeing with its fraction to its own rounding is accepted', () => {
  for (const [frac, dec] of [['1/3', '0.33333333'], ['1/3', '0.3333'], ['1/3', '0.33'], ['2/3', '0.67'], ['1/2', '0.5'], ['1/8', '0,125'], ['0', '0.00000000'], ['1/1', '1'], ['3/16', '0.18750000']]) {
    const o = parse(OWN([`| A | ${frac} | ${dec} | none | none |`])).owners[0];
    assert.equal(o.issue, '', `${frac} vs ${dec}`);
    assert.notEqual(o.value, null, `${frac} vs ${dec}`);
  }
});

test('N5 conflicts that must be caught', () => {
  for (const [frac, dec] of [['1/2', '1'], ['1/8', '0.00000000'], ['1/4', '0.30'], ['3/4', '0.7'], ['1/3', '0.25']]) {
    assert.equal(parse(OWN([`| A | ${frac} | ${dec} | none | none |`])).owners[0].issue, 'conflict', `${frac} vs ${dec}`);
  }
});

test('N5 an unreadable decimal still falls back to the fraction; a fraction with no decimal is untouched', () => {
  assert.equal(parse(OWN(['| A | 1/2 | TBD | none | none |'])).owners[0].value, 0.5);
  assert.equal(parse(OWN(['| A | 1/2 | | none | none |'])).owners[0].value, 0.5);
  assert.equal(parse(OWN(['| A | none | 0.25000000 | none | none |'])).owners[0].value, 0.25);
});

test('N5 a negative share is unreadable and never hidden by the total', () => {
  const md = OWN(['| A | 1/1 | 1.00000000 | none | none |', '| B | 1/4 | -0.25000000 | none | none |']);
  const p = parse(md);
  assert.equal(p.owners[1].issue, 'negative');
  assert.equal(p.owners[1].value, null);
  assert.equal(p.stats.sumState, 'unknown');
  assert.doesNotMatch(render(md), /Sums to whole/);
  assert.equal(parse(OWN(['| A | -1/4 | | none | none |'])).owners[0].value, null);
});

test('N5 a royalty-only row with a zero decimal and zero interest is still royalty only', () => {
  const o = parse(OWN(['| A | 1/1 | 1.00000000 | none | none |', '| T | 0 | 0.00000000 | NPRI 1/32 | D4 |'])).owners[1];
  assert.equal(o.royaltyOnly, true);
  assert.equal(o.issue, '');
});

// ---- 6. Unsafe chain matching
const citeOf = (md, id = 'D1') => {
  const html = render(md);
  const card = html.split('<article class="rd-dcard').slice(1).find(c => c.includes(`>${id}<`));
  const btn = card.match(/<button[^>]*class="rd-cite" data-rd-goto="[^"]*-chain-(\d+)"/);
  return btn ? Number(btn[1]) : null;
};
const chainOf = rows => `${CH}\n${rows.join('\n')}`;

test('N6 a year elsewhere in the defect plus one shared word does not link a row', () => {
  const md = OPINION({
    chain: chainOf(['| 1 | 1959-02-11 | Mineral Deed | Vol. 210 p. 514 | A | Ashby | 1/8 | A: 7/8 | NONE |', '| 2 | 1988-05-02 | Mineral Deed | Vol. 590 p. 3 | A | Pike | 1/64 | A: 3/4 | NONE |']),
    defects: `${DH}\n| D1 | Wendell Ashby died 1988; his 1/8 mineral interest has no heirship of record. | Affidavit of Heirship | Doc 1 |`,
    owners: '| Heirs of Ashby | 1/8 | none | D1 |',
  });
  assert.equal(citeOf(md), null);
  const card = render(md).split('<article class="rd-dcard')[1].split('</article>')[0];
  assert.doesNotMatch(card, /Vol\. 590 p\. 3/, 'a recording ref the defect never gave is not shown on its card');
});

test('N6 naming an instrument by year and type alone does not link a row', () => {
  const rows = ['| 1 | 1901 | Patent | V1 p2 | State | A | 1/1 | A: 1/1 | NONE |', '| 2 | 1974-03-22 | Mineral Deed | Vol. 319 p. 260 | A | Pettibone | 1/4 | A: 1/2 | OVERGRANT |', '| 3 | 1981-08-14 | O&G Lease | Vol. 402 p. 77 | P | Dunmore | Leasehold | n/a | UNRELEASED |'];
  const md = OPINION({
    chain: chainOf(rows),
    defects: `${DH}\n| D1 | The 1974 mineral deed to Pettibone grants 1/4 but recites 5/16. | Stipulation | Doc 2 |\n| D2 | 1981 oil and gas lease to Dunmore not released of record. | Release | Doc 3 |`,
    owners: '| A | 1/1 | none | D1, D2 |',
  });
  assert.equal(citeOf(md, 'D1'), null);
  assert.equal(citeOf(md, 'D2'), null);
});

test('N6 an explicit recording reference still links, with or without the year', () => {
  const rows = ['| 1 | 1901 | Patent | V1 p2 | State | A | 1/1 | A: 1/1 | NONE |', '| 2 | 1974-03-22 | Mineral Deed | Vol. 319 p. 260 | A | Pettibone | 1/4 | A: 1/2 | OVERGRANT |', '| 3 | 1981-08-14 | O&G Lease | Vol. 402 p. 77 | P | Dunmore | Leasehold | n/a | UNRELEASED |'];
  const md = OPINION({
    chain: chainOf(rows),
    defects: `${DH}\n| D1 | The 1974 mineral deed to Pettibone grants 1/4 but recites 5/16. | Stipulation | Vol. 319 p. 260 |\n| D2 | Lease to Dunmore not released of record (Vol. 402, Pg 77). | Release | Doc 3 |`,
    owners: '| A | 1/1 | none | D1, D2 |',
  });
  assert.equal(citeOf(md, 'D1'), 1);
  assert.equal(citeOf(md, 'D2'), 2);
});

const CHAIN_DOC_H = '| # | Date | Doc Type | Source Doc | Recording Ref | Grantor | Grantee | Interest Conveyed | Running Balance | Flags |\n|---|---|---|---|---|---|---|---|---|---|';

test('N6 a unique source doc links the row, and beats a year-and-type reading of the defect text', () => {
  const md = OPINION({
    chain: `${CHAIN_DOC_H}\n| 1 | 1974-03-22 | Mineral Deed | Doc 2 | | A | Pettibone | 1/4 | A: 1/2 | NONE |\n| 2 | 1988-05-02 | Mineral Deed | Doc 5 | | A | Pike | 1/64 | A: 3/4 | NONE |`,
    defects: `${DH}\n| D1 | The 1974 mineral deed to Pettibone is not acknowledged. | Correction deed | Doc 5 |`,
    owners: '| A | 1/1 | none | D1 |',
  });
  assert.equal(citeOf(md), 1, 'the defect cites Doc 5; the 1974 wording must not pull it to the Doc 2 row');
});

test('N6 two named documents with one unambiguous source doc link the source doc row', () => {
  const md = OPINION({
    chain: `${CHAIN_DOC_H}\n| 1 | 1974-03-22 | Mineral Deed | Doc 2 | | A | Pettibone | 1/4 | A: 1/2 | NONE |\n| 2 | 1988-05-02 | Mineral Deed | Doc 5 | | A | Pike | 1/64 | A: 3/4 | NONE |`,
    defects: `${DH}\n| D1 | The 1974 mineral deed to Pettibone conflicts with the 1988 mineral deed to Pike. | Stipulation | Doc 5 |`,
    owners: '| A | 1/1 | none | D1 |',
  });
  assert.equal(citeOf(md), 1);
});

test('N6 a source doc shared by two chain rows is ambiguous, so no link', () => {
  const md = OPINION({
    chain: `${CHAIN_DOC_H}\n| 1 | 1974-03-22 | Mineral Deed | Doc 5 | | A | Pettibone | 1/4 | A: 1/2 | NONE |\n| 2 | 1988-05-02 | Mineral Deed | Doc 5 | | A | Pike | 1/64 | A: 3/4 | NONE |`,
    defects: `${DH}\n| D1 | The 1974 mineral deed to Pettibone is not acknowledged. | Correction deed | Doc 5 |`,
    owners: '| A | 1/1 | none | D1 |',
  });
  assert.equal(citeOf(md), null);
});

test('N6 two rows with the same year and type are ambiguous, so no link', () => {
  const md = OPINION({
    chain: chainOf(['| 1 | 1974-01-01 | Mineral Deed | Vol. 1 p. 1 | A | B | 1/8 | x | NONE |', '| 2 | 1974-06-01 | Mineral Deed | Vol. 2 p. 2 | A | C | 1/8 | y | NONE |']),
    defects: `${DH}\n| D1 | The 1974 mineral deed overgrants. | Stipulation | Doc 1 |`,
    owners: '| A | 1/1 | none | D1 |',
  });
  assert.equal(citeOf(md), null);
});

test('N6 a bare number is not a recording reference', () => {
  const md = OPINION({
    chain: chainOf(['| 1 | 1950 | Deed | 12 | A | B | 1/1 | B: 1/1 | NONE |', '| 2 | 1960 | Deed | Vol 4 | B | C | 1/1 | C: 1/1 | NONE |']),
    defects: `${DH}\n| D1 | 12.5% of the interest is unclear in Vol 4. | Stipulation | Doc 12 |`,
    owners: '| A | 1/1 | none | D1 |',
  });
  assert.equal(citeOf(md), null);
});

test('N6 a full recording reference (volume and page) still links, even beside a longer page number', () => {
  const md = OPINION({
    chain: chainOf(['| 1 | 1950 | Deed | Vol. 41 p. 207 | A | B | 1/1 | B: 1/1 | NONE |', '| 2 | 1960 | Deed | Vol. 41 p. 20 | B | C | 1/1 | C: 1/1 | NONE |']),
    defects: `${DH}\n| D1 | Acknowledgment missing. | Correction | Vol. 41 p. 207 |\n| D2 | Acknowledgment missing. | Correction | Vol. 41 p. 20 |`,
    owners: '| A | 1/1 | none | D1, D2 |',
  });
  assert.equal(citeOf(md, 'D1'), 0);
  assert.equal(citeOf(md, 'D2'), 1);
});

// ---- 8. Hostile input stays linear
test('N8 long hostile cells and summaries parse in well under a second', () => {
  const N = 100000;
  const time = md => { const t0 = Date.now(); parse(md); return Date.now() - t0; };
  const sum = b => `## EXECUTIVE SUMMARY\n- ${b}\n## FINAL OWNERSHIP DETERMINATION\n| Owner | Interest | Subject To |\n|---|---|---|\n| A | 1/1 | none |\n`;
  assert.ok(time(sum('5% reconciled, '.repeat(N / 10))) < 1500, 'many figures in one clause');
  assert.ok(time(sum('not '.repeat(N) + '50% reconciled')) < 1500, 'many negators');
  assert.ok(time(`## EXECUTIVE SUMMARY\n- ok\n## TITLE DEFECTS\n| # | Defect |\n|---|---|\n| D${' '.repeat(N)}x | a |\n## FINAL OWNERSHIP DETERMINATION\n| Owner | Interest |\n|---|---|\n| A | 1/1 |\n`) < 1500, 'defect id with a long whitespace run');
  assert.ok(time(`## EXECUTIVE SUMMARY\n- ok\n## FINAL OWNERSHIP DETERMINATION\n| Owner | Interest | Subject To |\n|---|---|---|\n| A | 1/1 | D${' '.repeat(N)}x |\n`) < 1500, 'subject cell with a long whitespace run');
});

// ---- 7. Stale follow-up
test('N7 a follow-up that finishes after the opinion changed redraws the new opinion, and marks the answer', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const run = loadIndex({ fetchImpl: async url => (String(url).endsWith('/followup') ? (await gate, jsonResponse(200, { followup: { answer: 'About the old draft' } })) : jsonResponse(404, {})) });
  const job = { id: 'job_A', status: 'complete', totalDocuments: 1 };
  const op = who => `## EXECUTIVE SUMMARY\n- ${who}\n## FINAL OWNERSHIP DETERMINATION\n| Owner | Decimal |\n|---|---|\n| ${who} | 1.00000000 |\n`;
  run.ctx.renderJobResults(job, { finalTitleOpinion: op('OLDOWNER') });
  run.getEl('jobFollowupInput').value = 'What happened?';
  const pending = run.getEl('jobFollowupBtn').onclick();
  await tick(5);
  run.ctx.renderJobResults(job, { finalTitleOpinion: op('NEWOWNER') });
  assert.match(run.getEl('jobResults').innerHTML, /NEWOWNER/);
  release();
  await pending;
  await tick(10);
  const results = run.getEl('jobResults').innerHTML;
  assert.match(results, /NEWOWNER/);
  assert.doesNotMatch(results, /OLDOWNER/, 'the old opinion is not painted back');
  assert.match(run.getEl('jobFollowupHistory').innerHTML, /About the old draft/);
  assert.match(run.getEl('jobFollowupHistory').innerHTML, /asked about an earlier draft/);
  assert.equal(run.getEl('jobFollowupBtn').disabled, false);
});

test('N7 an answer to the draft on screen is not marked stale', async () => {
  const run = loadIndex({ fetchImpl: async url => (String(url).endsWith('/followup') ? jsonResponse(200, { followup: { answer: 'Fresh answer' } }) : jsonResponse(404, {})) });
  const job = { id: 'job_B', status: 'complete', totalDocuments: 1 };
  run.ctx.renderJobResults(job, { finalTitleOpinion: SAMPLE });
  run.getEl('jobFollowupInput').value = 'Who owns D1?';
  await run.getEl('jobFollowupBtn').onclick();
  await tick(10);
  assert.match(run.getEl('jobFollowupHistory').innerHTML, /Fresh answer/);
  assert.doesNotMatch(run.getEl('jobFollowupHistory').innerHTML, /earlier draft/);
});

// ---- 9. Qualified and negated summaries never become a clean figure
const QUALIFIED_SUMMARIES = [
  ['not currently', '- Title is not currently 100% reconciled.'],
  ['not yet fully', '- Title is not yet fully 100% reconciled.'],
  ['not, however,', '- Title is not, however, 100% reconciled.'],
  ['far from', '- Title is far from 100% reconciled.'],
  ['none of', '- None of the title is 100% reconciled.'],
  ['not all of the', '- Not all of the title is 100% reconciled.'],
  ['close to', '- Title is close to 100% reconciled.'],
  ['essentially', '- Title is essentially 100% reconciled.'],
  ['except', '- Title is 100% reconciled except the NPRI.'],
  ['but not as to', '- Title is 100% reconciled as to the mineral estate, but not as to the NPRI.'],
  ['subject to', '- Title is 100% reconciled, subject to D1 curative.'],
  ["isn't (no figure)", "- Title isn't reconciled."],
  ["hasn't (no figure)", "- Ownership hasn't been reconciled."],
  ['remains open (no figure)', '- Reconciliation of the heirs remains open.'],
];
for (const [name, bullet] of QUALIFIED_SUMMARIES) {
  test(`N9 ${name} is a qualified claim, not a clean figure`, () => {
    const md = OPINION({ summary: bullet, defects: 'None identified.', owners: '| A | 1/1 | none | none |' });
    const claim = parse(md).stats.summaryClaim;
    assert.notEqual(claim.state, 'stated', JSON.stringify(claim));
    assert.notEqual(claim.state, 'none', JSON.stringify(claim));
    assert.equal(parse(md).stats.summaryPct, null);
    const k = kpi(md);
    assert.equal(k.value, null);
    assert.doesNotMatch(k.tone, /teal/);
  });
}

test('N9 plain and denied-bound figures stay stated', () => {
  assert.equal(parse(OPINION({ summary: '- Mineral title is 87.5% reconciled.', owners: HALF_OWNERS })).stats.summaryClaim.state, 'stated');
  assert.equal(parse(OPINION({ summary: '- Title is 87.5% reconciled (not 100%).', owners: HALF_OWNERS })).stats.summaryClaim.state, 'stated');
  assert.equal(parse(OPINION({ summary: '- No unreconciled interest remains.', owners: HALF_OWNERS })).stats.summaryClaim.state, 'none');
});

// ---- 10. Section headings keep their place and their text
const CHAIN_ROW = '| 1 | 1901 | Patent | V1 p2 | State | A | 1/1 | A: 1/1 | NONE |';
const E_OWNERS = `## FINAL OWNERSHIP DETERMINATION\n${RH}\n| A | 1/1 | none | none |\n`;

test('N10 a bare "### Defects" heading after the chain section starts the defects section', () => {
  const p = parse(`## EXECUTIVE SUMMARY\n- ok\n## CHAIN OF TITLE\n${CH}\n${CHAIN_ROW}\n### Defects\n${DH}\n| D1 | Missing deed | Corrective deed | Doc 1 |\n${E_OWNERS}`);
  assert.equal(p.defects.length, 1);
  assert.equal(p.chain.length, 1);
  assert.equal(p.defects[0].defect, 'Missing deed');
});

test('N10 "## Chain of Title Analysis" under a level-1 summary heading starts the chain section', () => {
  const p = parse(`# EXECUTIVE SUMMARY\n- ok\n## Chain of Title Analysis\n${CH}\n${CHAIN_ROW}\n# TITLE DEFECTS & CURATIVE REQUIREMENTS\nNone identified.\n# FINAL OWNERSHIP DETERMINATION\n${RH}\n| A | 1/1 | none | none |\n`);
  assert.equal(p.chain.length, 1);
  assert.equal(p.stats.defectsState, 'none');
});

test('N10 a "### Defect D1: ..." heading under defects keeps its text', () => {
  const p = parse(`## EXECUTIVE SUMMARY\n- ok\n## TITLE DEFECTS & CURATIVE REQUIREMENTS\n### Defect D1: Missing heirship for Ashby\nRequires an affidavit of heirship.\n${E_OWNERS}`);
  const prose = p.defectProse.join(' | ');
  assert.match(prose, /Missing heirship for Ashby/);
  assert.match(prose, /affidavit of heirship/);
  assert.equal(p.stats.defectsState, 'prose');
});

test('N10 a heading that only repeats its own section name adds no text', () => {
  const p = parse(`## EXECUTIVE SUMMARY\n- ok\n## TITLE DEFECTS & CURATIVE REQUIREMENTS\n### Defects\nNone identified.\n${E_OWNERS}`);
  assert.deepEqual(p.defectProse, []);
  assert.equal(p.stats.defectsState, 'none');
});

// ---- 11. A late follow-up answer keeps what the reader typed next
test('N11 a late answer clears its own question but not a newer one typed while waiting', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const run = loadIndex({ fetchImpl: async url => (String(url).endsWith('/followup') ? (await gate, jsonResponse(200, { followup: { answer: 'A1' } })) : jsonResponse(404, {})) });
  run.ctx.renderJobResults({ id: 'job_late', status: 'complete', totalDocuments: 1 }, { finalTitleOpinion: SAMPLE });
  run.getEl('jobFollowupInput').value = 'first question';
  const pending = run.getEl('jobFollowupBtn').onclick();
  await tick(5);
  run.getEl('jobFollowupInput').value = 'second question typed while waiting';
  release();
  await pending;
  await tick(10);
  assert.equal(run.getEl('jobFollowupInput').value, 'second question typed while waiting');
  assert.match(run.getEl('jobFollowupHistory').innerHTML, /A1/);
});

test('N11 an unchanged question is still cleared after its answer', async () => {
  const run = loadIndex({ fetchImpl: async url => (String(url).endsWith('/followup') ? jsonResponse(200, { followup: { answer: 'A1' } }) : jsonResponse(404, {})) });
  run.ctx.renderJobResults({ id: 'job_clear', status: 'complete', totalDocuments: 1 }, { finalTitleOpinion: SAMPLE });
  run.getEl('jobFollowupInput').value = '  first question  ';
  await run.getEl('jobFollowupBtn').onclick();
  await tick(10);
  assert.equal(run.getEl('jobFollowupInput').value, '');
});

// ---- 12. Round 3: a hedge word in another clause does not qualify the figure
const UNRELATED_HEDGES = [
  ['"Although not all..." preamble', '- Although not all instruments were recorded in order, title is 100% reconciled.'],
  ['"Over the 1901-2020 chain" preamble', '- Over the 1901-2020 chain, title is 100% reconciled.'],
  ['"More than 400 documents" in an earlier clause', '- More than 400 documents were reviewed and title is 100% reconciled.'],
  ['"Under the 1950 lease" preamble', '- Under the 1950 lease, title is 100% reconciled.'],
  ['"up to 4 documents" preamble', '- Based on up to 4 documents, title is 100% reconciled.'],
];
for (const [name, bullet] of UNRELATED_HEDGES) {
  test(`N12 ${name} leaves a clean figure stated`, () => {
    const s = parse(OPINION({ summary: bullet, owners: '| A | 1/1 | none | none |' })).stats;
    assert.equal(s.summaryClaim.state, 'stated', JSON.stringify(s.summaryClaim));
    assert.equal(s.summaryPct, 100);
    assert.equal(kpi(OPINION({ summary: bullet, owners: '| A | 1/1 | none | none |' })).value, 100);
  });
}

test('N12 a hedge in the same clause as the figure still qualifies it', () => {
  for (const bullet of [
    '- Although title was reviewed in full, it is not 100% reconciled.',
    '- Based on 4 documents, title is not yet 100% reconciled.',
    '- Over the whole chain, title is less than 100% reconciled.',
    '- Title is not, however, 100% reconciled.',
    '- Title is never 100% reconciled.',
    '- Under the 1950 lease, title is approximately 90% reconciled.',
    '- More than 90% of title is reconciled.',
  ]) {
    const s = parse(OPINION({ summary: bullet, owners: HALF_OWNERS })).stats;
    assert.equal(s.summaryClaim.state, 'qualified', `${bullet} ${JSON.stringify(s.summaryClaim)}`);
    assert.equal(s.summaryPct, null, bullet);
  }
});

// ---- 13. Round 3: a one-place decimal agrees with a fraction it rounds from
test('N13 a one-place decimal agrees with the fraction it rounds', () => {
  for (const [frac, dec] of [['1/3', '0.3'], ['2/3', '0.7'], ['1/6', '0.2'], ['1/2', '0.5']]) {
    const o = parse(OWN([`| A | ${frac} | ${dec} | none | none |`])).owners[0];
    assert.equal(o.issue, '', `${frac} vs ${dec}`);
    assert.equal(o.value, Number(dec), `${frac} vs ${dec}`);
  }
});

test('N13 a one-place decimal still conflicts with a fraction it does not round', () => {
  for (const [frac, dec] of [['1/2', '0.3'], ['1/4', '0.5'], ['3/4', '0.7'], ['1/8', '0.5'], ['1/2', '1']]) {
    assert.equal(parse(OWN([`| A | ${frac} | ${dec} | none | none |`])).owners[0].issue, 'conflict', `${frac} vs ${dec}`);
  }
});

// ---- 14. Round 3: a qualifications heading nested under another section
test('N14 "### Qualifications and Limitations" under owners keeps its notes as qualifications', () => {
  const md = `## EXECUTIVE SUMMARY\n- ok\n## FINAL OWNERSHIP DETERMINATION\n${RH}\n| A | 1/1 | none | none |\n### Qualifications and Limitations\n- Assumes Doc 3 is genuine.\n`;
  const p = parse(md);
  assert.equal(p.qualifications.length, 1);
  assert.match(p.qualifications[0].text, /Assumes Doc 3/);
  assert.equal(p.owners.length, 1);
  assert.match(render(md), /Opinion qualifications/);
});

test('N14 "### Limitations and Qualifications" and "### Limitations" under defects start the qualifications', () => {
  for (const head of ['Limitations and Qualifications', 'Limitations', 'Qualifications &amp; Limitations'.replace('&amp;', '&')]) {
    const md = `## EXECUTIVE SUMMARY\n- ok\n## TITLE DEFECTS & CURATIVE REQUIREMENTS\n${DH}\n| D1 | Missing deed | Deed | Doc 1 |\n### ${head}\n- Assumes Doc 3 genuine.\n## FINAL OWNERSHIP DETERMINATION\n${RH}\n| A | 1/1 | none | D1 |\n`;
    const p = parse(md);
    assert.equal(p.qualifications.length, 1, head);
    assert.equal(p.defects.length, 1, head);
  }
});

// ---- 15. Round 3: repeated percent claims in one sentence stay linear
test('N15 a sentence of 32000 percent claims renders in well under a second', () => {
  const md = OPINION({ summary: `- ${'Title is 50% reconciled, '.repeat(32000)}done.`, owners: HALF_OWNERS });
  const t0 = Date.now();
  render(md);
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `${ms}ms`);
});

test('N15 repeated figures with a trailing exception are still bounded by it', () => {
  const s = parse(OPINION({ summary: '- Title is 87.5% reconciled except Doc 3.', owners: HALF_OWNERS })).stats;
  assert.equal(s.summaryClaim.state, 'qualified');
  const t = parse(OPINION({ summary: `- ${'Title is 50% reconciled, '.repeat(50)}except Doc 3.`, owners: HALF_OWNERS })).stats;
  assert.equal(t.summaryClaim.state, 'qualified');
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
