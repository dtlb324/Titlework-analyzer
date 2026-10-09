import test from 'node:test';
import assert from 'node:assert/strict';
import { assessAccuracy, scoreModel } from '../public/ocr-accuracy.js';

const identity = fields => ({ fields });

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
