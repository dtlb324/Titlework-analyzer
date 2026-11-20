import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  assessAccuracy,
  extractCalendarDates,
  hasKeyIllegibleMarker,
  isDateEarlier,
  isFieldAbstained,
  parseAbstractFields,
  scoreAbstractAgainstText,
  scoreModel,
  validateAbstractQuality,
} from '../public/ocr-accuracy.js';

import {
  abstractOf,
  cleanCases,
  defectiveCases,
  DEED_TEXT,
  extraCleanCases,
  singleFaultCases,
  undetectableCases,
} from './fixtures/abstract-quality-corpus.js';

const identity = fields => ({ fields });

const comparisonScript = readFileSync(new URL('../scripts/compare-ocr-models.mjs', import.meta.url), 'utf8');
const comparisonScorer = runInNewContext(`${comparisonScript.slice(comparisonScript.indexOf('function normDate('), comparisonScript.indexOf('function mediaTypeForExt('))}\n${comparisonScript.slice(comparisonScript.indexOf('function isAbstained('), comparisonScript.indexOf('function countIllegible('))}\nscoreField`);

test('comparison CLI scores dates and recording references using their ground-truth field key', () => {
  assert.equal(comparisonScorer('April 7th, 1923', 'April 7, 1923', false, 'DATE_EXECUTED'), 'correct');
  assert.equal(comparisonScorer('Jan. 2, A.D. 1923', 'January 2, 1923', false, 'DATE_RECORDED'), 'correct');
  assert.equal(comparisonScorer('Vol. 1, Page 2', 'Volume 1, Pg. 2', false, 'RECORDING_REF'), 'correct');
});

test('comparison CLI preserves name, mismatch, missing, and degraded-field scores', () => {
  assert.equal(comparisonScorer('ADA OWNER', 'Ada Owner', false, 'GRANTOR'), 'correct');
  assert.equal(comparisonScorer('Ada Owner and wife', 'Ada Owner', false, 'GRANTOR'), 'partial');
  assert.equal(comparisonScorer('Ida Owner', 'Ada Owner', false, 'GRANTOR'), 'wrong');
  assert.equal(comparisonScorer('n/a', 'Ada Owner', false, 'GRANTOR'), 'missed');
  assert.equal(comparisonScorer('Ada Owner', null, false, 'GRANTOR'), 'no_gt');
  assert.equal(comparisonScorer('ILLEGIBLE - VERIFY MANUALLY', null, true, 'DATE_RECORDED'), 'correct_illegible');
  assert.equal(comparisonScorer('April 7, 1923', null, true, 'DATE_RECORDED'), 'fabricated');
});

test('April 7th, 1923 matches a document that says April 7, 1923', () => {
  assert.deepEqual(scoreModel('April 7, 1923', identity({
    GRANTOR: 'Ida Owner',
    GRANTEE: 'Ida Owner',
    'DATE EXECUTED': 'April 7th, 1923',
    'DATE RECORDED': 'Ida Owner',
    'RECORDING REF': 'Ida Owner',
  })), { status: 'scored', matched: 1, scored: 5, percent: 20 });
});

test('Vol. 1, Page 2 matches Volume 1, Pg. 2', () => {
  assert.deepEqual(scoreModel('Volume 1, Pg. 2', identity({
    GRANTOR: 'Ida Owner',
    GRANTEE: 'Ida Owner',
    'DATE EXECUTED': 'Ida Owner',
    'DATE RECORDED': 'Ida Owner',
    'RECORDING REF': 'Vol. 1, Page 2',
  })), { status: 'scored', matched: 1, scored: 5, percent: 20 });
});

test('Ada Owner matches and Ida Owner does not', () => {
  assert.deepEqual(scoreModel('Ada Owner', identity({ GRANTOR: 'Ada Owner' })), { status: 'scored', matched: 1, scored: 5, percent: 20 });
  assert.deepEqual(scoreModel('Ada Owner', identity({ GRANTOR: 'Ida Owner' })), { status: 'scored', matched: 0, scored: 5, percent: 0 });
});

test('an illegible grantor is not a miss and not a match', () => {
  assert.deepEqual(scoreModel('ILLEGIBLE - VERIFY MANUALLY Ada Owner', identity({
    GRANTOR: 'ILLEGIBLE - VERIFY MANUALLY',
    GRANTEE: 'Ada Owner',
  })), { status: 'scored', matched: 1, scored: 4, percent: 25 });
});

test('confidence and surface do not change the score', () => {
  const without = scoreModel('Ada Owner', identity({ GRANTOR: 'Ada Owner' }));
  const withJudgment = scoreModel('Ada Owner', identity({ GRANTOR: 'Ada Owner', CONFIDENCE: 'high', SURFACE: 'yes' }));
  assert.deepEqual(withJudgment, without);
  assert.deepEqual(withJudgment, { status: 'scored', matched: 1, scored: 5, percent: 20 });
});

test('blank document text is no-document-text', () => {
  assert.deepEqual(scoreModel('   ', identity({ GRANTOR: 'Ada Owner' })), { status: 'none', reason: 'no-document-text' });
  assert.deepEqual(scoreModel(undefined, { error: 'failed', fields: { GRANTOR: 'Ada Owner' } }), { status: 'none', reason: 'no-document-text' });
});

test('a model error is model-failed', () => {
  assert.deepEqual(scoreModel('Ada Owner', { error: 'failed', fields: { GRANTOR: 'Ada Owner' } }), { status: 'none', reason: 'model-failed' });
});

test('optional transcript fields count only when the model gave a value', () => {
  assert.deepEqual(scoreModel('Ada Owner', identity({
    GRANTOR: 'n/a', GRANTEE: 'none', 'DATE EXECUTED': 'none stated', 'DATE RECORDED': 'not applicable', 'RECORDING REF': 'not visible',
  })), { status: 'none', reason: 'no-fields' });
  assert.deepEqual(scoreModel('Ada Owner', identity({
    GRANTOR: 'n/a', GRANTEE: 'none', 'DATE EXECUTED': 'none stated', 'DATE RECORDED': 'not applicable', 'RECORDING REF': 'unclear', 'LEGAL DESC': 'Ada Owner',
  })), { status: 'scored', matched: 1, scored: 1, percent: 100 });
  assert.deepEqual(scoreModel('Ada Owner', identity({ GRANTOR: 'Ada Owner', 'FRACTION CONVEYED': '1/2', RESERVATIONS: 'none stated' })), { status: 'scored', matched: 1, scored: 6, percent: 16 });
});

test('month abbreviations and a.d. normalize, and sept does not', () => {
  assert.deepEqual(scoreModel('January 1, 1923', identity({ GRANTOR: 'Jan 1, A.D. 1923' })), { status: 'scored', matched: 1, scored: 5, percent: 20 });
  assert.deepEqual(scoreModel('September 2', identity({ GRANTOR: 'Sept 2' })), { status: 'scored', matched: 0, scored: 5, percent: 0 });
});

test('a non-string identity field is a miss', () => {
  assert.deepEqual(scoreModel('Ada Owner', identity({ GRANTOR: null, 'DATE EXECUTED': 'Ada Owner' })), { status: 'scored', matched: 1, scored: 5, percent: 20 });
});

test('ranking leaves out a file when any model failed and still ranks the first file', () => {
  const text = 'Ada Owner Bea Buyer April 7, 1923 Vol 1 Page 2';
  const baseline = {
    id: 'baseline', label: 'Baseline',
    fields: { GRANTOR: 'Ada Owner', GRANTEE: 'Bea Buyer', 'DATE EXECUTED': 'April 7, 1923', 'DATE RECORDED': 'April 7, 1923', 'RECORDING REF': 'Vol 1 Page 2' },
  };
  const candidate = { id: 'candidate', label: 'Candidate', fields: { ...baseline.fields, GRANTOR: 'Ida Owner' } };
  const files = [
    { filename: 'first.pdf', documentText: text, models: [baseline, candidate] },
    { filename: 'second.pdf', documentText: text, models: [baseline, { ...candidate, error: 'failed' }] },
  ];
  const before = structuredClone(files);
  const assessment = assessAccuracy(files);
  assert.deepEqual(files, before);
  assert.equal(assessment.ranking.documentCount, 1);
  assert.equal(assessment.ranking.fieldCount, 5);
  assert.deepEqual(assessment.ranking.rows, [
    { id: 'baseline', label: 'Baseline', matched: 5, scored: 5, percent: 100, rank: 1 },
    { id: 'candidate', label: 'Candidate', matched: 4, scored: 5, percent: 80, rank: 2 },
  ]);
  assert.deepEqual(assessment.byFile.get('first.pdf').models[0].accuracy, { status: 'scored', matched: 5, scored: 5, percent: 100 });
  assert.deepEqual(assessment.byFile.get('second.pdf').models[1].accuracy, { status: 'none', reason: 'model-failed' });
  const summed = assessAccuracy([
    files[0],
    { filename: 'third.pdf', documentText: text, models: [baseline, candidate] },
  ]);
  assert.equal(summed.ranking.documentCount, 2);
  assert.equal(summed.ranking.fieldCount, 10);
  assert.deepEqual(summed.ranking.rows.map(row => [row.id, row.matched, row.percent, row.rank]), [
    ['baseline', 10, 100, 1],
    ['candidate', 8, 80, 2],
  ]);
});

test('tied models share a rank and the next rank skips', () => {
  const text = 'Ada Owner Bea Buyer April 7, 1923 Vol 1 Page 2';
  const perfect = { fields: { GRANTOR: 'Ada Owner', GRANTEE: 'Bea Buyer', 'DATE EXECUTED': 'April 7, 1923', 'DATE RECORDED': 'April 7, 1923', 'RECORDING REF': 'Vol 1 Page 2' } };
  const assessment = assessAccuracy([{
    filename: 'deed.pdf',
    documentText: text,
    models: [
      { id: 'a', label: 'Baseline', ...perfect },
      { id: 'b', label: 'Candidate', ...perfect },
      { id: 'c', label: 'Challenger', fields: { ...perfect.fields, GRANTOR: 'Ida Owner' } },
    ],
  }]);
  assert.deepEqual(assessment.ranking.rows.map(row => [row.id, row.rank]), [['a', 1], ['b', 1], ['c', 3]]);
});

test('a file with no result yet is not ranked', () => {
  const assessment = assessAccuracy([{ filename: 'pending.pdf', documentText: 'Ada Owner', models: undefined }]);
  assert.equal(assessment.ranking.documentCount, 0);
  assert.deepEqual(assessment.ranking.rows, []);
  assert.equal(assessment.ranking.fieldCount, 0);
  assert.deepEqual(assessment.byFile.get('pending.pdf'), { models: [] });
});

const blankRefs = { GRANTEE: 'ILLEGIBLE', 'DATE EXECUTED': 'ILLEGIBLE', 'DATE RECORDED': 'ILLEGIBLE' };
const scoreGrantor = (documentText, grantor) => scoreModel(documentText, identity({ ...blankRefs, GRANTOR: grantor, 'RECORDING REF': 'ILLEGIBLE' }));
const hit = { status: 'scored', matched: 1, scored: 1, percent: 100 };
const miss = { status: 'scored', matched: 0, scored: 1, percent: 0 };

test('a field must match whole words and numbers, not the inside of a longer one', () => {
  const text = 'Warranty Deed. Grantor: Joanne Blacksmith. Recorded Vol 1123 Page 45. Instrument 2024001234.';
  assert.deepEqual(scoreModel(text, identity({ ...blankRefs, GRANTOR: 'Ann', 'RECORDING REF': '112' })), { status: 'scored', matched: 0, scored: 2, percent: 0 });
  assert.deepEqual(scoreModel(text, identity({ ...blankRefs, GRANTOR: 'Joanne', 'RECORDING REF': 'Vol 1123' })), { status: 'scored', matched: 2, scored: 2, percent: 100 });
  assert.deepEqual(scoreModel(text, identity({ ...blankRefs, GRANTOR: 'Joanne Blacksmith', 'RECORDING REF': '1123' })), { status: 'scored', matched: 2, scored: 2, percent: 100 });
  assert.deepEqual(scoreModel('Vol 1123 Page 45', identity({ ...blankRefs, GRANTOR: 'ol 1', 'RECORDING REF': 'Page 4' })), { status: 'scored', matched: 0, scored: 2, percent: 0 });
  assert.deepEqual(scoreModel('Sold 1/2 interest', identity({ ...blankRefs, GRANTOR: 'Sold', 'RECORDING REF': 'ILLEGIBLE', 'FRACTION CONVEYED': '1/2' })), { status: 'scored', matched: 2, scored: 2, percent: 100 });
  assert.deepEqual(scoreModel('Sold 11/2 interest', identity({ ...blankRefs, GRANTOR: 'Sold', 'RECORDING REF': 'ILLEGIBLE', 'FRACTION CONVEYED': '1/2' })), { status: 'scored', matched: 1, scored: 2, percent: 50 });
});

test('a whole-word match is found anywhere in the text, including after a partial hit', () => {
  assert.deepEqual(scoreModel('Ann Anne Joanne and then Ann Lee', identity({ ...blankRefs, GRANTOR: 'Ann Lee', 'RECORDING REF': 'Anne' })), { status: 'scored', matched: 2, scored: 2, percent: 100 });
  assert.deepEqual(scoreModel('Joanne then Annabel then Ann.', identity({ ...blankRefs, GRANTOR: 'Ann', 'RECORDING REF': 'Anna' })), { status: 'scored', matched: 1, scored: 2, percent: 50 });
  assert.deepEqual(scoreModel('Joanne then Annabel', identity({ ...blankRefs, GRANTOR: 'Ann', 'RECORDING REF': 'Anna' })), { status: 'scored', matched: 0, scored: 2, percent: 0 });
});

test('typographic apostrophes and dashes match their plain equivalents in either direction', () => {
  const doc = 'Grantor: Mary O\u2019Brien-Smith, a widow.';
  for (const grantor of ['Mary O\u2019Brien-Smith', "Mary O'Brien-Smith", 'Mary O\u2019Brien\u2013Smith', 'Mary O\u2018Brien\u2014Smith', 'Mary O\u02BCBrien\u2010Smith', 'Mary O\u2019Brien\u2011Smith']) assert.deepEqual(scoreGrantor(doc, grantor), hit, grantor);
  assert.deepEqual(scoreGrantor("Mary O'Brien-Smith", 'Mary O\u2019Brien\u2013Smith'), hit);
  assert.deepEqual(scoreGrantor('Mary O\u2019Brien\u2014Smith', 'Mary O\u2019Brien-Smith'), hit);
  assert.deepEqual(scoreGrantor('Range 2\u20134', 'Range 2-4'), hit);
});

test('punctuation normalization does not equate different names or numbers', () => {
  assert.deepEqual(scoreGrantor('Mary O\u2019Brien-Smith', 'Mary OBrien Smith'), miss, 'a hyphen is not a space');
  assert.deepEqual(scoreGrantor('Range 2\u20134', 'Range 24'), miss, 'a dash between numbers is not removed');
  assert.deepEqual(scoreGrantor('Mary Obrian', "Mary O'Brien"), miss);
});

test('half of a hyphenated name or number is not the whole value', () => {
  const doc = 'Grantor: Mary O\u2019Brien-Smith, lot 5-A, pages 2\u20134.';
  assert.deepEqual(scoreGrantor(doc, 'Mary O\u2019Brien'), miss);
  assert.deepEqual(scoreGrantor(doc, 'Smith'), miss);
  assert.deepEqual(scoreGrantor(doc, 'lot 5'), miss);
  assert.deepEqual(scoreGrantor(doc, 'A, pages 2'), miss);
  assert.deepEqual(scoreGrantor(doc, 'lot 5-A'), hit);
  assert.deepEqual(scoreGrantor('Mary Jones - John Smith', 'Mary Jones'), hit, 'a spaced dash separates words');
});

test('abstention ranking is unchanged by boundary matching', () => {
  const text = 'Grantor John Smith grantee Mary Jones executed 5 March 1990 recorded 7 March 1990 Vol 10 Page 20';
  const full = { id: 'full', label: 'Answers all', fields: { GRANTOR: 'John Smith', GRANTEE: 'Mary Jones', 'DATE EXECUTED': '5 March 1990', 'DATE RECORDED': '7 March 1990', 'RECORDING REF': 'Vol 11 Page 20' } };
  const shy = { id: 'shy', label: 'Abstains on 4 of 5', fields: { GRANTOR: 'John Smith', GRANTEE: 'ILLEGIBLE', 'DATE EXECUTED': 'ILLEGIBLE', 'DATE RECORDED': 'ILLEGIBLE', 'RECORDING REF': 'ILLEGIBLE' } };
  const { ranking } = assessAccuracy([{ filename: 'a.pdf', documentText: text, models: [full, shy] }]);
  assert.deepEqual(ranking.rows.map(row => [row.id, row.rank, row.matched, row.scored]), [['shy', 1, 1, 1], ['full', 2, 4, 5]]);
});

const CLEAN_BILATERAL_DEED = [
  'DOC TYPE: Warranty Deed',
  'DATE EXECUTED: April 7, 1923',
  'DATE RECORDED: April 10, 1923',
  'RECORDING REF: Vol 42, Page 118',
  'GRANTOR: Ada Owner',
  'GRANTEE: Bea Buyer',
  'LEGAL DESC: NW/4 of Section 12, Block C-9 (metes and bounds)',
  'SURFACE: yes',
  'MINERALS: yes - 1/2',
  'ROYALTY/NPRI: no',
  'TERM: perpetual',
  'AFTER-ACQUIRED TITLE: no',
  'FRACTION CONVEYED: an undivided 1/2 interest in the minerals',
  'RESERVATIONS: none stated',
  'WARRANTY: full',
  'ACKNOWLEDGMENT: yes',
  'ISSUES: none noted',
  'CONFIDENCE: High confidence across all fields.',
].join('\n');

test('parseAbstractFields handles DOCUMENT headers, bold/bullet labels, code fences, and continuation lines', () => {
  const raw = [
    '```',
    'DOCUMENT #3 (deed.pdf):',
    '- **DOC TYPE:** Mineral Deed',
    '* **GRANTOR**: Ada Owner',
    '  and John Owner',
    '• GRANTEE: Bea Buyer',
    '**LEGAL DESC:** Lot 1, Block 2',
    '  Survey Abstract 104',
    '```',
  ].join('\n');
  const fields = parseAbstractFields(raw);
  assert.equal(fields['DOC TYPE'], 'Mineral Deed');
  assert.equal(fields.GRANTOR, 'Ada Owner\nand John Owner');
  assert.equal(fields.GRANTEE, 'Bea Buyer');
  assert.equal(fields['LEGAL DESC'], 'Lot 1, Block 2\nSurvey Abstract 104');
});

test('extractCalendarDates and isDateEarlier handle courthouse phrasings and mixed precision', () => {
  assert.deepEqual(extractCalendarDates('April 7th, A.D. 1923'), [{ year: 1923, month: 4, day: 7 }]);
  assert.deepEqual(extractCalendarDates('7th day of April, A.D. 1923'), [{ year: 1923, month: 4, day: 7 }]);
  assert.deepEqual(extractCalendarDates('Sept. 15, 1954'), [{ year: 1954, month: 9, day: 15 }]);
  assert.deepEqual(extractCalendarDates('1923-04-07 and 04/10/1923'), [
    { year: 1923, month: 4, day: 7 },
    { year: 1923, month: 4, day: 10 },
  ]);
  assert.deepEqual(extractCalendarDates('April, 1923'), [{ year: 1923, month: 4, day: null }]);
  assert.deepEqual(extractCalendarDates('1923'), [{ year: 1923, month: null, day: null }]);

  assert.equal(isDateEarlier({ year: 1923, month: 4, day: 6 }, { year: 1923, month: 4, day: 7 }), true);
  assert.equal(isDateEarlier({ year: 1923, month: 4, day: 7 }, { year: 1923, month: 4, day: 7 }), false);
  assert.equal(isDateEarlier({ year: 1923, month: 4, day: null }, { year: 1923, month: 4, day: 7 }), false);
  assert.equal(isDateEarlier({ year: 1923, month: 3, day: null }, { year: 1923, month: 4, day: 7 }), true);
  assert.equal(isDateEarlier(null, { year: 1923, month: 4, day: 7 }), false);
});

test('validateAbstractQuality accepts clean bilateral deeds and unilateral affidavits', () => {
  const bilateral = validateAbstractQuality(CLEAN_BILATERAL_DEED);
  assert.equal(bilateral.valid, true);
  assert.deepEqual(bilateral.reasons, []);

  const affidavit = CLEAN_BILATERAL_DEED
    .replace('DOC TYPE: Warranty Deed', 'DOC TYPE: Affidavit of Heirship')
    .replace('GRANTEE: Bea Buyer', 'GRANTEE: not applicable')
    .replace('SURFACE: yes', 'SURFACE: unclear')
    .replace('ACKNOWLEDGMENT: yes', 'ACKNOWLEDGMENT: unclear')
    .replace('DATE RECORDED: April 10, 1923\n', '');
  const unilateral = validateAbstractQuality(affidavit);
  assert.equal(unilateral.valid, true, JSON.stringify(unilateral.reasons));
});

test('validateAbstractQuality rejects not applicable grantee on bilateral conveyances', () => {
  const result = validateAbstractQuality(CLEAN_BILATERAL_DEED.replace('GRANTEE: Bea Buyer', 'GRANTEE: not applicable'));
  assert.equal(result.valid, false);
  assert(result.reasons.includes('abstained_required_field:GRANTEE'));
});

test('validateAbstractQuality flags missing, blank, placeholder, and abstained required fields', () => {
  for (const field of ['GRANTOR', 'GRANTEE', 'DATE EXECUTED', 'RECORDING REF', 'LEGAL DESC']) {
    const missing = CLEAN_BILATERAL_DEED.replace(new RegExp(`^${field}:.*$`, 'm'), '');
    assert(validateAbstractQuality(missing).reasons.includes(`missing_required_field:${field}`), `missing ${field}`);

    const blank = CLEAN_BILATERAL_DEED.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}:   `);
    assert(validateAbstractQuality(blank).reasons.includes(`missing_required_field:${field}`), `blank ${field}`);

    for (const badValue of ['not visible', 'unclear', 'n/a', 'none stated', '[placeholder]']) {
      const abstained = CLEAN_BILATERAL_DEED.replace(new RegExp(`^${field}:.*$`, 'm'), `${field}: ${badValue}`);
      assert(
        validateAbstractQuality(abstained).reasons.includes(`abstained_required_field:${field}`),
        `${field}: ${badValue}`,
      );
    }
  }
});

test('validateAbstractQuality handles DATE RECORDED uncertainty without false positives on valid unclear flags', () => {
  const uncertainRecorded = validateAbstractQuality(
    CLEAN_BILATERAL_DEED.replace('DATE RECORDED: April 10, 1923', 'DATE RECORDED: not visible'),
  );
  assert.equal(uncertainRecorded.valid, false);
  assert(uncertainRecorded.reasons.includes('abstained_key_field:DATE RECORDED'));

  const unclearRecorded = validateAbstractQuality(
    CLEAN_BILATERAL_DEED.replace('DATE RECORDED: April 10, 1923', 'DATE RECORDED: unclear'),
  );
  assert(unclearRecorded.reasons.includes('abstained_key_field:DATE RECORDED'));

  const unrecorded = validateAbstractQuality(
    CLEAN_BILATERAL_DEED.replace('DATE RECORDED: April 10, 1923', 'DATE RECORDED: unrecorded'),
  );
  assert.equal(unrecorded.valid, true, JSON.stringify(unrecorded.reasons));

  const validUnclearFlags = validateAbstractQuality(
    CLEAN_BILATERAL_DEED
      .replace('SURFACE: yes', 'SURFACE: unclear')
      .replace('ACKNOWLEDGMENT: yes', 'ACKNOWLEDGMENT: unclear'),
  );
  assert.equal(validUnclearFlags.valid, true, JSON.stringify(validUnclearFlags.reasons));
});

test('validateAbstractQuality detects inverted dates and minerals without fraction conveyed', () => {
  const inverted = validateAbstractQuality(
    CLEAN_BILATERAL_DEED.replace('DATE RECORDED: April 10, 1923', 'DATE RECORDED: April 1, 1923'),
  );
  assert.equal(inverted.valid, false);
  assert(inverted.reasons.includes('inverted_dates'));

  const sameDay = validateAbstractQuality(
    CLEAN_BILATERAL_DEED.replace('DATE RECORDED: April 10, 1923', 'DATE RECORDED: April 7, 1923'),
  );
  assert.equal(sameDay.valid, true);

  const multiGrantorExec = validateAbstractQuality(
    CLEAN_BILATERAL_DEED
      .replace('DATE EXECUTED: April 7, 1923', 'DATE EXECUTED: April 7, 1923 and April 12, 1923')
      .replace('DATE RECORDED: April 10, 1923', 'DATE RECORDED: April 10, 1923'),
  );
  assert.equal(multiGrantorExec.valid, true, 'latest recorded vs earliest executed should not false-positive');

  for (const badFraction of ['', 'none stated', 'unclear', 'not applicable']) {
    const replacement = badFraction === '' ? '' : `FRACTION CONVEYED: ${badFraction}`;
    const missingFraction = validateAbstractQuality(
      CLEAN_BILATERAL_DEED.replace('FRACTION CONVEYED: an undivided 1/2 interest in the minerals', replacement),
    );
    assert(missingFraction.reasons.includes('minerals_without_fraction'), `fraction=${badFraction}`);
  }

  const mineralsNo = validateAbstractQuality(
    CLEAN_BILATERAL_DEED
      .replace('MINERALS: yes - 1/2', 'MINERALS: no')
      .replace('FRACTION CONVEYED: an undivided 1/2 interest in the minerals', 'FRACTION CONVEYED: none stated'),
  );
  assert.equal(mineralsNo.valid, true);

  const affidavitMinerals = validateAbstractQuality(
    CLEAN_BILATERAL_DEED
      .replace('DOC TYPE: Warranty Deed', 'DOC TYPE: Affidavit of Heirship')
      .replace('GRANTEE: Bea Buyer', 'GRANTEE: not applicable')
      .replace('FRACTION CONVEYED: an undivided 1/2 interest in the minerals', 'FRACTION CONVEYED: not applicable'),
  );
  assert.equal(affidavitMinerals.valid, true);
});

test('validateAbstractQuality and scoreAbstractAgainstText ground identity fields against embedded PDF text', () => {
  const embeddedText = [
    'WARRANTY DEED',
    'Know all men by these presents that Ada Owner, grantor, for valuable consideration, grants to Bea Buyer, grantee,',
    'all of the NW/4 of Section 12, Block C-9, Ward County, Texas.',
    'Witness my hand this 7th day of April, A.D. 1923.',
    'Recorded April 10, 1923 in Book 42, Page 118, Deed Records.',
  ].join('\n');

  const grounded = validateAbstractQuality(CLEAN_BILATERAL_DEED, { documentText: embeddedText });
  assert.equal(grounded.valid, true, JSON.stringify(grounded));
  assert.equal(grounded.textMatch.status, 'scored');
  assert.equal(grounded.textMatch.percent, 100);

  const oneMismatch = validateAbstractQuality(
    CLEAN_BILATERAL_DEED.replace('DATE RECORDED: April 10, 1923', 'DATE RECORDED: April 11, 1923'),
    { documentText: embeddedText },
  );
  assert.equal(oneMismatch.textMatch.percent, 80);
  assert.equal(oneMismatch.valid, true, '4/5 = 80% should pass default 65% grounding threshold');

  const hallucinated = validateAbstractQuality(
    CLEAN_BILATERAL_DEED
      .replace('GRANTOR: Ada Owner', 'GRANTOR: Zebra Corp')
      .replace('GRANTEE: Bea Buyer', 'GRANTEE: Omega Trust')
      .replace('RECORDING REF: Vol 42, Page 118', 'RECORDING REF: Vol 999, Page 1'),
    { documentText: embeddedText },
  );
  assert.equal(hallucinated.valid, false);
  assert(hallucinated.reasons.includes('low_text_match'));
  assert(hallucinated.textMatch.percent < 65);

  const multiParty = scoreAbstractAgainstText(
    'Ada Owner and John Owner convey to Bea Buyer and Carl Buyer on 04/07/1923 in Instrument No. 2024-55.',
    {
      GRANTOR: 'Ada Owner; John Owner',
      GRANTEE: 'Bea Buyer\nCarl Buyer',
      'DATE EXECUTED': 'April 7, 1923',
      'RECORDING REF': 'Doc #2024-55',
    },
  );
  assert.equal(multiParty.matched, 4);
  assert.equal(multiParty.scored, 4);
  assert.equal(multiParty.percent, 100);
});

test('hasKeyIllegibleMarker scopes ILLEGIBLE triggers to key title fields and allows secondary fields', () => {
  assert.equal(hasKeyIllegibleMarker(CLEAN_BILATERAL_DEED), false);

  const secondaryIllegible = CLEAN_BILATERAL_DEED
    .replace('WARRANTY: full', 'WARRANTY: ILLEGIBLE - VERIFY MANUALLY')
    .replace('TERM: perpetual', 'TERM: ILLEGIBLE - VERIFY MANUALLY')
    .replace('AFTER-ACQUIRED TITLE: no', 'AFTER-ACQUIRED TITLE: ILLEGIBLE - VERIFY MANUALLY')
    .replace('ACKNOWLEDGMENT: yes', 'ACKNOWLEDGMENT: ILLEGIBLE - VERIFY MANUALLY')
    .replace('SURFACE: yes', 'SURFACE: ILLEGIBLE - VERIFY MANUALLY')
    .replace('ISSUES: none noted', 'ISSUES: Notary seal is ILLEGIBLE - VERIFY MANUALLY');
  assert.equal(hasKeyIllegibleMarker(secondaryIllegible), false);

  for (const [before, after] of [
    ['GRANTOR: Ada Owner', 'GRANTOR: ILLEGIBLE - VERIFY MANUALLY'],
    ['RECORDING REF: Vol 42, Page 118', 'RECORDING REF: ILLEGIBLE - VERIFY MANUALLY'],
    ['RESERVATIONS: none stated', 'RESERVATIONS: 1/8 royalty — remainder ILLEGIBLE - VERIFY MANUALLY'],
    ['LEGAL DESC: NW/4 of Section 12, Block C-9 (metes and bounds)', 'LEGAL DESC: NW/4 of Section 12\nmetes and bounds ILLEGIBLE - VERIFY MANUALLY'],
  ]) {
    assert.equal(hasKeyIllegibleMarker(CLEAN_BILATERAL_DEED.replace(before, after)), true, after);
  }

  assert.equal(
    hasKeyIllegibleMarker('Instrument: Warranty Deed\nDate: [ILLEGIBLE - VERIFY MANUALLY]'),
    true,
    'Unstructured non-template output still falls back to matching ILLEGIBLE markers',
  );
});

test('validateAbstractQuality allows consistently unrecorded instruments and scoreModel abstains on not stated / unrecorded', () => {
  const unrecorded = validateAbstractQuality(
    CLEAN_BILATERAL_DEED
      .replace('DATE RECORDED: April 10, 1923', 'DATE RECORDED: unrecorded')
      .replace('RECORDING REF: Vol 42, Page 118', 'RECORDING REF: unrecorded'),
  );
  assert.equal(unrecorded.valid, true, JSON.stringify(unrecorded.reasons));

  const contradictory = validateAbstractQuality(
    CLEAN_BILATERAL_DEED.replace('RECORDING REF: Vol 42, Page 118', 'RECORDING REF: unrecorded'),
  );
  assert.equal(contradictory.valid, false);
  assert(contradictory.reasons.includes('abstained_required_field:RECORDING REF'));

  assert.deepEqual(scoreModel('Ada Owner', identity({
    GRANTOR: 'Ada Owner',
    GRANTEE: 'not stated',
    'DATE EXECUTED': 'not stated',
    'DATE RECORDED': 'unrecorded',
    'RECORDING REF': 'unrecorded',
  })), { status: 'scored', matched: 1, scored: 1, percent: 100 });
});

// Labeled corpus: clean abstracts must pass, defective ones must keep their reason.
test('corpus has the expected size', () => {
  assert(cleanCases.length >= 31, `need 21 originals + 10 variants, got ${cleanCases.length}`);
  assert(extraCleanCases.length >= 10);
  assert(defectiveCases.length >= 20);
});

for (const c of cleanCases) {
  test(`clean without text is not flagged: ${c.name}`, () => {
    const result = validateAbstractQuality(c.abstract);
    assert.deepEqual(result.reasons, []);
  });
  test(`clean with text is not flagged: ${c.name}`, () => {
    const result = validateAbstractQuality(c.abstract, { documentText: c.text });
    assert.deepEqual(result.reasons, []);
  });
}

for (const c of defectiveCases) {
  const reasonOf = result => result.reasons.filter(reason => reason.startsWith(c.reason));
  test(`defective with text is flagged (${c.reason}): ${c.name}`, () => {
    const result = validateAbstractQuality(c.abstract, { documentText: c.text });
    assert(reasonOf(result).length > 0, `expected ${c.reason}, got ${JSON.stringify(result.reasons)}`);
  });
  if (!c.needsText) {
    test(`defective without text is flagged (${c.reason}): ${c.name}`, () => {
      const result = validateAbstractQuality(c.abstract);
      assert(reasonOf(result).length > 0, `expected ${c.reason}, got ${JSON.stringify(result.reasons)}`);
    });
  } else {
    test(`text-only defect has no verdict without text: ${c.name}`, () => {
      assert.equal(validateAbstractQuality(c.abstract).valid, true);
    });
  }
}

for (const c of singleFaultCases) {
  test(`single wrong field is not matched to the text: ${c.name}`, () => {
    const fields = parseAbstractFields(c.abstract);
    const score = scoreAbstractAgainstText(c.text, fields);
    assert.equal(score.matched, score.scored - 1, JSON.stringify(score));
  });
}

test('swapped grantor and grantee is a documented gap of containment matching', () => {
  const [c] = undetectableCases;
  assert.equal(validateAbstractQuality(c.abstract, { documentText: c.text }).valid, true);
});

test('isFieldAbstained: party names that contain the word unknown are not abstentions', () => {
  for (const value of [
    'Unknown Heirs of Silas Brooks',
    'The Unknown Heirs, Devisees, Successors and Assigns of Silas Brooks, deceased',
    'Unknown Owners of Lot 4',
    'Unknown Spouse of John Doe',
    'Unknown owners of the minerals under Section 5',
  ]) assert.equal(isFieldAbstained(value), false, value);
});

test('isFieldAbstained: stand-alone unknown/unclear and read-failure markers abstain anywhere', () => {
  for (const value of [
    '', '[ ]', '-', 'Unknown', 'unknown - cannot read', 'Unclear', 'Name unclear', 'the name is not stated', 'Name not stated here', 'not stated',
    'JOHN [ILLEGIBLE - VERIFY MANUALLY] SMITH', 'John Smith (not visible)', 'N/A', 'None',
    'Unknown owner', 'Unknown party', 'The unknown heirs of ____', 'Unknown heirs', 'John Doe and Unknown Spouse', 'Unknown grantor',
  ]) assert.equal(isFieldAbstained(value), true, value);
});

test('abstract quality: Not applicable follows the instrument type', () => {
  const base = { GRANTOR: 'Not applicable', GRANTEE: 'Not applicable', 'LEGAL DESC': 'Not applicable' };
  const reasonsFor = docType => validateAbstractQuality(abstractOf({ ...base, 'DOC TYPE': docType })).reasons;
  for (const docType of ['Certificate of Death', 'Affidavit of Heirship', 'Order Admitting Will to Probate', 'Power of Attorney', 'Plat of Highland Addition', 'Release of Lease', 'Notice of Termination']) {
    assert.deepEqual(reasonsFor(docType), [], docType);
  }
  for (const docType of ['Warranty Deed', 'Oil and Gas Lease', 'Assignment of Lease', 'Bill of Sale']) {
    assert.deepEqual(
      reasonsFor(docType).sort(),
      ['abstained_required_field:GRANTEE', 'abstained_required_field:GRANTOR', 'abstained_required_field:LEGAL DESC'],
      docType,
    );
  }
  const date = validateAbstractQuality(abstractOf({ 'DOC TYPE': 'Certificate of Death', 'DATE EXECUTED': 'Not applicable', 'RECORDING REF': 'Not applicable' }));
  assert.deepEqual(date.reasons.sort(), ['abstained_required_field:DATE EXECUTED', 'abstained_required_field:RECORDING REF']);
});

test('abstract quality: a read failure is flagged on every instrument type', () => {
  for (const docType of ['Certificate of Death', 'Warranty Deed', 'Release of Lease']) {
    for (const value of ['', '[ILLEGIBLE - VERIFY MANUALLY]', 'not visible', '[name]']) {
      const reasons = validateAbstractQuality(abstractOf({ 'DOC TYPE': docType, GRANTEE: value, 'LEGAL DESC': value })).reasons;
      assert(reasons.some(r => r.endsWith(':GRANTEE')), `${docType} / ${value}`);
      assert(reasons.some(r => r.endsWith(':LEGAL DESC')), `${docType} / ${value}`);
    }
  }
});

test('abstract quality: GRANTEE None is accepted on a unilateral instrument only', () => {
  assert.deepEqual(validateAbstractQuality(abstractOf({ 'DOC TYPE': 'Release of Lease', GRANTEE: 'None', MINERALS: 'no' })).reasons, []);
  assert.deepEqual(validateAbstractQuality(abstractOf({ 'DOC TYPE': 'Warranty Deed', GRANTEE: 'None' })).reasons, ['abstained_required_field:GRANTEE']);
});

test('abstract quality: a lease with a none-stated fraction passes, a deed or assignment does not', () => {
  for (const value of ['none stated', 'None', 'Not applicable', 'N/A']) {
    const lease = validateAbstractQuality(abstractOf({ 'DOC TYPE': 'Oil and Gas Lease', 'FRACTION CONVEYED': value }));
    assert.deepEqual(lease.reasons, [], `lease / ${value}`);
    for (const docType of ['Warranty Deed', 'Assignment of Oil and Gas Lease', 'Mineral Deed']) {
      const reasons = validateAbstractQuality(abstractOf({ 'DOC TYPE': docType, 'FRACTION CONVEYED': value })).reasons;
      assert.deepEqual(reasons, ['minerals_without_fraction'], `${docType} / ${value}`);
    }
  }
  for (const value of ['', 'ILLEGIBLE - VERIFY MANUALLY', '[unreadable]']) {
    const reasons = validateAbstractQuality(abstractOf({ 'DOC TYPE': 'Oil and Gas Lease', 'FRACTION CONVEYED': value })).reasons;
    assert.deepEqual(reasons, ['minerals_without_fraction'], `lease / ${value}`);
  }
});

test('party names match the text after role tags and capacity clauses are stripped', () => {
  const text = 'Eleanor R. Whitfield, a widow, Lessor, leases to Sunbelt Energy Corporation, Lessee. Clyde Ferris and Opal Ferris, husband and wife.';
  const score = fields => scoreAbstractAgainstText(text, fields);
  assert.equal(score({ GRANTOR: 'Eleanor R. Whitfield (Lessor)', GRANTEE: 'Sunbelt Energy Corporation (Lessee)' }).matched, 2);
  assert.equal(score({ GRANTOR: 'Eleanor R. Whitfield, a single woman', GRANTEE: 'Sunbelt Energy Corporation' }).matched, 2);
  assert.equal(score({ GRANTOR: 'Opal Ferris & Clyde Ferris, husband and wife' }).matched, 1);
  assert.equal(score({ GRANTOR: 'Clyde Ferris et ux' }).matched, 1);
});

test('party names must really appear: a wrong or partial name stays unmatched', () => {
  const text = 'Clyde Ferris and Opal Ferris, Grantors, convey to Prairie Minerals Trust. Annette Leeds signs.';
  const matched = grantor => scoreAbstractAgainstText(text, { GRANTOR: grantor, GRANTEE: 'Prairie Minerals Trust' }).matched;
  assert.equal(matched('Clyde Ferris and Opal Jones'), 1, 'one wrong party');
  assert.equal(matched('Zed Ferris (Grantor)'), 1, 'wrong first name');
  assert.equal(matched('Ann Lee, a widow'), 1, 'substring of a longer word');
  assert.equal(matched('Clyde Ferris & Opal Ferris'), 2);
  assert.equal(matched('Clyde Ferris; Opal Jones'), 1, 'one wrong party across a semicolon list');
  assert.equal(matched('Clyde Ferris\nOpal Ferris'), 2);
});

test('two-digit year dates match the long-form document date', () => {
  const text = 'Signed this 14th day of March, 1952. Filed for record March 20, 1952. Book 90, Page 5. Nell Pruitt to Walter Pruitt.';
  const fields = date => ({ GRANTOR: 'Nell Pruitt', GRANTEE: 'Walter Pruitt', 'DATE EXECUTED': date, 'RECORDING REF': 'Book 90, Page 5' });
  assert.equal(scoreAbstractAgainstText(text, fields('3/14/52')).matched, 4);
  assert.equal(scoreAbstractAgainstText(text, fields('3-14-52')).matched, 4);
  assert.equal(scoreAbstractAgainstText(text, fields('03/14/52')).matched, 4);
  assert.equal(scoreAbstractAgainstText(text, fields('3/15/52')).matched, 3, 'wrong day');
  assert.equal(scoreAbstractAgainstText(text, fields('3/14/62')).matched, 3, 'wrong decade');
  assert.deepEqual(extractCalendarDates('3/14/52'), [], 'ordering checks stay four-digit only');
});

test('DEED_TEXT fixture is a real deed for the defective cases', () => {
  assert.deepEqual(validateAbstractQuality(abstractOf(), { documentText: DEED_TEXT }).reasons, []);
});

// ---- Review round: compound types, sentence-form abstentions, unknown parties, text match, speed ----
const reasonsOf = (overrides, documentText) => validateAbstractQuality(abstractOf(overrides), documentText ? { documentText } : {}).reasons;
const NA = 'Not applicable';

test('compound conveying DOC TYPEs do not accept Not applicable grantor, grantee or legal description', () => {
  for (const docType of [
    "Sheriff's Deed pursuant to Order of Sale", "Executor's Deed pursuant to Decree", 'Mineral Deed pursuant to Order of Court',
    'Quitclaim Deed and Release', 'Release and Assignment', 'Oil and Gas Lease with Ratification', 'Deed of Release',
    'Order Conveying Mineral Interest', 'Power of Attorney to convey minerals', 'Probate Order Approving Sale of Mineral Interest',
    "Executor's Deed in Probate",
  ]) {
    assert.deepEqual(
      reasonsOf({ 'DOC TYPE': docType, GRANTOR: NA, GRANTEE: NA, 'LEGAL DESC': NA }).sort(),
      ['abstained_required_field:GRANTEE', 'abstained_required_field:GRANTOR', 'abstained_required_field:LEGAL DESC'],
      docType,
    );
  }
});

test('head-noun non-land DOC TYPEs still accept Not applicable', () => {
  for (const docType of [
    'Release of Oil and Gas Lease', 'Termination of Lease', 'Ratification of Oil and Gas Lease', 'Notice of Lease', 'Memorandum of Lease',
    'Affidavit of Heirship', 'Order Admitting Will to Probate', 'Certificate of Death', 'General Power of Attorney', 'Plat',
    'Abstract of Judgment', 'Notice of Lis Pendens',
  ]) {
    assert.deepEqual(reasonsOf({ 'DOC TYPE': docType, GRANTOR: NA, GRANTEE: NA, 'LEGAL DESC': NA }), [], docType);
  }
});

test('fraction none/n/a: accepted on lease and security instruments, flagged on conveyances, read failures flagged everywhere', () => {
  const accepted = ['Oil and Gas Lease', 'Mortgage', 'Deed of Trust', 'Lien', 'Declaration of Pooled Unit', 'Pooling Agreement', 'Unit Declaration', 'Farmout Agreement', 'Memorandum of Lease', 'Release of Lease'];
  const flagged = ['Warranty Deed', 'Mineral Deed', 'Royalty Deed', 'Assignment of Oil and Gas Lease', 'Quitclaim Deed and Release', 'Release and Assignment', "Executor's Deed pursuant to Decree", 'Power of Attorney to convey minerals', 'Mineral Deed subject to Lease', 'Oil and Gas Lease and Mineral Deed'];
  for (const value of ['none', 'N/A', 'Not applicable', 'none stated']) {
    for (const docType of accepted) assert.deepEqual(reasonsOf({ 'DOC TYPE': docType, 'FRACTION CONVEYED': value }), [], `${docType} / ${value}`);
    for (const docType of flagged) assert.deepEqual(reasonsOf({ 'DOC TYPE': docType, 'FRACTION CONVEYED': value }), ['minerals_without_fraction'], `${docType} / ${value}`);
  }
  for (const value of ['', 'ILLEGIBLE - VERIFY MANUALLY', '[unreadable]', '[ ]', '-', 'Not applicable - ILLEGIBLE']) {
    for (const docType of [...accepted, ...flagged]) assert.deepEqual(reasonsOf({ 'DOC TYPE': docType, 'FRACTION CONVEYED': value }), ['minerals_without_fraction'], `${docType} / ${value}`);
  }
});

test('sentence-form abstentions are flagged wherever the soft word sits', () => {
  for (const [field, value] of [
    ['GRANTEE', 'Grantee not shown on this page'],
    ['LEGAL DESC', 'Legal description missing from the page provided'],
    ['DATE EXECUTED', 'Date not stated on the face of the instrument'],
    ['RECORDING REF', 'recording stamp is missing from the scanned page'],
    ['GRANTOR', 'Smith (first name unclear) and Jones'],
    ['GRANTOR', 'Grantor name unclear, appears to be J. Smith'],
    ['LEGAL DESC', 'Section 12, Township unclear, Range 3 West, Garvin County, Oklahoma'],
    ['GRANTEE', 'Name omitted from the copy'],
    ['GRANTOR', 'Unknown grantor'],
  ]) assert.deepEqual(reasonsOf({ [field]: value }), [`abstained_required_field:${field}`], `${field}: ${value}`);
});

test('soft words that are part of a statement stay clean: stated year with a missing part, the word blank inside a description', () => {
  assert.deepEqual(reasonsOf({ 'DATE EXECUTED': 'ca. 1952 (day and month not stated)' }), []);
  assert.deepEqual(reasonsOf({ 'DATE EXECUTED': 'March 1952 (day not given)' }), []);
  assert.deepEqual(reasonsOf({ 'LEGAL DESC': 'The blank 5-acre tract in the NE/4 of Section 12, Garvin County, Oklahoma' }), []);
  assert.deepEqual(reasonsOf({ 'DATE EXECUTED': '1952 (month unclear)' }), ['abstained_required_field:DATE EXECUTED'], 'unclear is a read failure even with a year');
});

test('unknown-party exemption needs naming text after the noun', () => {
  for (const [field, value] of [
    ['GRANTOR', 'Unknown owner'], ['GRANTEE', 'Unknown party'], ['GRANTEE', 'The unknown heirs of ____'], ['GRANTOR', 'Unknown heirs'],
    ['GRANTEE', 'Unknown heirs of [ ]'], ['GRANTOR', 'Unknown Owners'], ['GRANTOR', 'Unknown heirs of Silas Brooks and ____'],
  ]) assert.deepEqual(reasonsOf({ [field]: value }), [`abstained_required_field:${field}`], `${field}: ${value}`);
  for (const value of [
    'Unknown Heirs of Silas Brooks', 'The Unknown Heirs, Devisees and Successors of Silas Brooks', 'Unknown owners of the minerals under Section 5',
    'Unknown Spouse of John Doe', 'The unknown heirs, devisees and assigns of Silas Brooks, deceased',
  ]) assert.deepEqual(reasonsOf({ GRANTEE: value }), [], value);
});

test('party text match: capacity phrases are bounded and what follows them is still checked', () => {
  const text = 'John A. Smith, Grantor, conveys to Robert L. Jones, Grantee. Mary Jones signs as witness. Silas Brooks, Executor of the Estate of John Smith, joins.';
  const matched = grantor => scoreAbstractAgainstText(text, { GRANTOR: grantor }).matched;
  for (const fabricated of [
    'John A. Smith, as Trustee of the Smith Trust and Zebra Land Corp',
    'John A. Smith, individually and Zebra Land Corp',
    'John A. Smith, as Trustee of the Zebra Family Trust',
    'John A. Smith (Zebra Land Corp)',
    'Jones, as Trustee of the Omega Trust',
    'John A. Smith and Mary',
    'John A. Smith, a single man, and Zebra Land Corp',
    'John A. Smith, Zebra Land Corp, 123 Fake Street',
    'John A. Smith, individually and as Executor of the Estate of Zed Quill',
  ]) assert.equal(matched(fabricated), 0, fabricated);
  for (const legit of [
    'John A. Smith, individually',
    'John A. Smith (Grantor)',
    'John A. Smith (Lessor and Surviving Spouse)',
    'John A. Smith, a single man',
    'John A. Smith (a/k/a J. A. Smith)',
    'John A. Smith (f/k/a Zed Smith)',
    'Silas Brooks, as Executor of the Estate of John Smith',
    'Silas Brooks, individually and as Independent Executor of the Estate of John Smith',
    'John A. Smith and Mary Jones',
    'Mary Jones and John A. Smith',
  ]) assert.equal(matched(legit), 1, legit);
});

test('party text match: an alias parenthetical is satisfied by either spelling', () => {
  const grantor = { GRANTOR: 'John A. Smith (a/k/a J. A. Smith)' };
  assert.equal(scoreAbstractAgainstText('J. A. Smith, Grantor, conveys.', grantor).matched, 1, 'alias only');
  assert.equal(scoreAbstractAgainstText('John A. Smith, Grantor, conveys.', grantor).matched, 1, 'name only');
  assert.equal(scoreAbstractAgainstText('Zed Quill, Grantor, conveys.', grantor).matched, 0, 'neither');
});

test('party text match: a named trust must appear in the document when the capacity names one', () => {
  const withTrust = 'John A. Smith, Trustee of the Smith Family Trust, Grantor.';
  const without = 'John A. Smith, Trustee, Grantor.';
  const abstract = { GRANTOR: 'John A. Smith, as Trustee of the Smith Family Trust' };
  assert.equal(scoreAbstractAgainstText(withTrust, abstract).matched, 1);
  assert.equal(scoreAbstractAgainstText(without, abstract).matched, 0);
});

test('party text match: wife-style leading spouse and two-digit years are matched in full', () => {
  const text = 'WARRANTY DEED\nJOHN SMITH, Grantor, and MARY SMITH, Grantor, convey to ROBERT L. JONES, Grantee, the NE/4 of Section 12. Signed March 14, 2005. Filed March 20, 2005, Vol. 412, Page 233.';
  const fields = { GRANTOR: 'John Smith and wife, Mary Smith', GRANTEE: 'Robert L. Jones', 'DATE EXECUTED': '3/14/05', 'DATE RECORDED': '3/20/05', 'RECORDING REF': 'Vol. 412, Page 233' };
  assert.deepEqual(scoreAbstractAgainstText(text, fields), { status: 'scored', matched: 5, scored: 5, percent: 100 });
  assert.equal(scoreAbstractAgainstText(text, { ...fields, 'DATE EXECUTED': '3/14/95' }).matched, 4, 'wrong year');
});

test('hard read-failure markers beat a stated Not applicable or none', () => {
  assert.deepEqual(reasonsOf({ 'DOC TYPE': 'Affidavit of Heirship', GRANTOR: 'Not applicable - ILLEGIBLE' }), ['abstained_required_field:GRANTOR']);
  assert.deepEqual(reasonsOf({ 'DOC TYPE': 'Affidavit of Heirship', GRANTOR: 'None' }), ['abstained_required_field:GRANTOR']);
  assert.deepEqual(reasonsOf({ 'DOC TYPE': 'Oil and Gas Lease', 'FRACTION CONVEYED': 'Not applicable - ILLEGIBLE' }), ['minerals_without_fraction']);
  assert.deepEqual(reasonsOf({ 'DOC TYPE': "Executor's Deed in Probate", GRANTOR: NA }), ['abstained_required_field:GRANTOR']);
  assert.deepEqual(reasonsOf({ GRANTOR: 'not legible' }), ['abstained_required_field:GRANTOR']);
});

test('pathological whitespace and unclosed parentheses stay fast', () => {
  const hostile = [
    `John${' '.repeat(65536)}(`,
    `${' '.repeat(65536)}(unclosed`,
    `John Smith${' '.repeat(65536)},`,
    `John Smith ${'('.repeat(65536)}`,
    `John Smith ${'(a '.repeat(20000)}`,
    `John Smith, ${'as Trustee '.repeat(5000)}`,
    `John Smith${' and '.repeat(10000)}`,
  ];
  for (const value of hostile) {
    const started = performance.now();
    scoreAbstractAgainstText('John Smith conveys to Robert Jones. Filed March 3, 1952.', { GRANTOR: value, GRANTEE: 'Robert Jones' });
    isFieldAbstained(value);
    validateAbstractQuality(abstractOf({ GRANTOR: value }), { documentText: 'John Smith conveys to Robert Jones.' });
    const elapsed = performance.now() - started;
    assert(elapsed < 500, `${value.slice(0, 24).replace(/\s+/g, ' ')}... took ${Math.round(elapsed)} ms`);
  }
});
