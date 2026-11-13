import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { mdToHtml, resolveFinalOpinionThinking } from '../scripts/compare-final-opinion.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('comparison renderer converts markdown pipe tables into HTML tables', () => {
  const html = mdToHtml([
    '## TITLE DEFECTS',
    '',
    '| # | Defect | Curative Needed |',
    '|---|---|---|',
    '| 1 | **Gap** | Obtain full copy |',
  ].join('\n'));

  assert(html.includes('<h2>TITLE DEFECTS</h2>'), 'Expected heading to render');
  assert(html.includes('<table>'), 'Expected markdown table to render as a table');
  assert(html.includes('<th>#</th>'), 'Expected header cells to render');
  assert(html.includes('<strong>Gap</strong>'), 'Expected inline bold inside table cells to render');
  assert(!html.includes('|---|---|---|'), 'Expected table separator not to render as raw text');
});

test('comparison renderer does not fold tables into adjacent headings', () => {
  const html = mdToHtml([
    '## CHAIN OF TITLE',
    '| # | Owner |',
    '|---|---|',
    '| 1 | Abel Parker |',
  ].join('\n'));

  assert(html.includes('<h2>CHAIN OF TITLE</h2>'), 'Expected standalone heading');
  assert(html.includes('<table>'), 'Expected adjacent table to render separately');
  assert(!html.includes('<h2>CHAIN OF TITLE<br>'), 'Expected heading not to contain table text');
});

test('final-opinion arms: Gemini 4 never gets a budget or minimal, xhigh is Hydrogen-only, 3 and 2.5 keep their defaults', () => {
  const prev = process.env.GEMINI_THINKING_BUDGET;
  delete process.env.GEMINI_THINKING_BUDGET;
  try {
    const eq = (actual, expected, label) => assert(JSON.stringify(actual) === JSON.stringify(expected), `${label}: got ${JSON.stringify(actual)}`);
    eq(resolveFinalOpinionThinking('gemini-4-hydrogen', null), {}, 'Hydrogen default is the model default, no override');
    eq(resolveFinalOpinionThinking('gemini-4-hydrogen', 'xhigh'), { thinkingLevel: 'xhigh' }, 'Hydrogen xhigh');
    eq(resolveFinalOpinionThinking('gemini-4-hydrogen', 'minimal'), {}, 'Hydrogen minimal is dropped');
    eq(resolveFinalOpinionThinking('gemini-4-carbon', 'xhigh'), {}, 'Carbon xhigh is dropped');
    eq(resolveFinalOpinionThinking('gemini-4-argon', 'minimal'), {}, 'Argon minimal is dropped');
    eq(resolveFinalOpinionThinking('gemini-4-argon', 'high'), { thinkingLevel: 'high' }, 'Argon high');
    for (const id of ['gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon']) {
      assert(resolveFinalOpinionThinking(id, null).thinkingBudget === undefined, `${id} must not get a budget`);
    }
    eq(resolveFinalOpinionThinking('gemini-3.5-flash', null), { thinkingLevel: 'minimal' }, 'gemini-3 defaults to minimal');
    eq(resolveFinalOpinionThinking('gemini-3.5-flash', 'high'), { thinkingLevel: 'high' }, 'gemini-3 explicit level');
    eq(resolveFinalOpinionThinking('gemini-2.5-pro', null), { thinkingBudget: -1 }, '2.5 dynamic budget');
    process.env.GEMINI_THINKING_BUDGET = '0';
    eq(resolveFinalOpinionThinking('gemini-2.5-pro', null), {}, '2.5 with env budget leaves it to the env');
    eq(resolveFinalOpinionThinking('claude-sonnet-5-5', null), {}, 'non-Gemini');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_THINKING_BUDGET; else process.env.GEMINI_THINKING_BUDGET = prev;
  }
});

test('final-opinion --help lists xhigh and the Gemini 4 scope', () => {
  const script = fileURLToPath(new URL('../scripts/compare-final-opinion.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', env: { ...process.env, GEMINI_API_KEY: '', GOOGLE_API_KEY: '', ANTHROPIC_API_KEY: '' } });
  assert(result.status === 0, `--help exited ${result.status}: ${result.stderr}`);
  assert(/xhigh/.test(result.stdout) && /gemini-4-hydrogen only/.test(result.stdout), `Help text missing xhigh: ${result.stdout}`);
});

test('final-opinion CLI rejects a Gemini 4 level the model lacks before touching the database', () => {
  const script = fileURLToPath(new URL('../scripts/compare-final-opinion.mjs', import.meta.url));
  const run = (model, level) => spawnSync(process.execPath, [script, '--job-id', 'j1', '--gemini-model', model, '--gemini-thinking-level', level], {
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: 'postgres://unused.invalid/db', GEMINI_API_KEY: '', GOOGLE_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_THINKING_LEVEL: '' },
  });
  for (const [model, level] of [['gemini-4-carbon', 'xhigh'], ['gemini-4-argon', 'xhigh'], ['gemini-4-hydrogen', 'minimal'], ['gemini-4-carbon', 'minimal']]) {
    const result = run(model, level);
    assert(result.status === 1, `${model} ${level} should exit 1, got ${result.status}`);
    assert(result.stderr.includes(`"${level}" is not supported by ${model}`), `Unexpected stderr for ${model} ${level}: ${result.stderr}`);
  }
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

if (failures) {
  process.exit(1);
}
