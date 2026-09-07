import {
  parseArgs,
  resolveModels,
  scoreField,
  normalise,
  buildReport,
} from '../scripts/compare-ocr-models.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('parseArgs reads folder, models, and limit', () => {
  const args = parseArgs(['scripts/sample-docs', '--models', 'a,b', '--limit', '3']);
  assert(args.folder === 'scripts/sample-docs', 'Expected folder');
  assert(args.models === 'a,b', 'Expected models spec');
  assert(args.limit === 3, 'Expected limit 3');
});

test('resolveModels defaults to 3.1 flash-lite vs 3.8 flash', () => {
  const models = resolveModels(null);
  assert(models.length === 2, 'Expected two default models');
  assert(models[0].id === 'gemini-3.1-flash-lite', 'Expected 3.1 flash-lite first');
  assert(models[0].thinking.thinkingLevel === 'minimal', 'Expected minimal on flash-lite');
  assert(models[1].id === 'gemini-3.8-flash', 'Expected 3.8 flash second');
  assert(models[1].thinking.thinkingLevel === 'low', 'Expected low on 3.8 (minimal unsupported)');
});

test('resolveModels remaps 3.8 minimal override to low', () => {
  const models = resolveModels('gemini-3.8-flash:minimal');
  assert(models[0].thinking.thinkingLevel === 'low', '3.8 Flash must not send minimal');
});

test('resolveModels accepts per-model thinking overrides', () => {
  const models = resolveModels('gemini-3.1-flash-lite:minimal,gemini-3.8-flash:medium');
  assert(models[0].thinking.thinkingLevel === 'minimal', 'Expected minimal override');
  assert(models[1].thinking.thinkingLevel === 'medium', 'Expected medium override');
});

test('scoreField uses date normalisation', () => {
  assert(
    scoreField('April 7th, 1923', 'April 7, 1923', false, 'DATE_EXECUTED') === 'correct',
    'Ordinal date should match',
  );
  assert(
    scoreField('Vol. 12, Page 3', 'Volume 12, Page 3', false, 'RECORDING_REF') === 'correct',
    'Volume abbreviation should match',
  );
  assert(
    normalise('DATE_EXECUTED', 'April 7th, 1923') === normalise('DATE_EXECUTED', 'April 7, 1923'),
    'normDate should collapse ordinals',
  );
});

test('scoreField treats degraded ILLEGIBLE as correct and fills as fabricated', () => {
  assert(scoreField('ILLEGIBLE', null, true, 'GRANTOR') === 'correct_illegible', 'Expected abstain');
  assert(scoreField('John Doe', null, true, 'GRANTOR') === 'fabricated', 'Expected fabrication');
});

test('buildReport includes both model ids and thinking levels', () => {
  const models = resolveModels('gemini-3.1-flash-lite,gemini-3.8-flash');
  const md = buildReport([], null, models);
  assert(md.includes('gemini-3.1-flash-lite'), 'Expected lite in report');
  assert(md.includes('gemini-3.8-flash'), 'Expected 3.8 in report');
  assert(md.includes('thinkingLevel=minimal'), 'Expected minimal noted');
  assert(md.includes('thinkingLevel=low'), 'Expected low noted');
});

let failures = 0;
for (const t of tests) {
  try {
    await t.fn();
    console.log(`ok - ${t.name}`);
  } catch (err) {
    failures++;
    console.error(`not ok - ${t.name}`);
    console.error(err.stack || err.message || err);
  }
}
if (failures) process.exit(1);
