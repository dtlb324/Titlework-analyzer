import { mdToHtml } from '../scripts/compare-final-opinion.mjs';

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
