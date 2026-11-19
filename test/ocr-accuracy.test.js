import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
  assessAccuracy,
  extractCalendarDates,
  isDateEarlier,
  parseAbstractFields,
  scoreAbstractAgainstText,
  scoreModel,
  validateAbstractQuality,
} from '../public/ocr-accuracy.js';

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
