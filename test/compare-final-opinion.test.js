import { buildCompareArms } from '../scripts/compare-final-opinion.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('buildCompareArms default includes sonnet and one gemini arm', () => {
  const arms = buildCompareArms({
    sonnetModel: 'claude-sonnet-4-6',
    geminiModel: 'gemini-3.5-flash',
    geminiThinkingLevels: [],
    geminiThinkingLevel: null,
    skipSonnet: false,
  });
  assert(arms.length === 2, `Expected 2 arms, got ${arms.length}`);
  assert(arms[0].id === 'sonnet', 'First arm should be sonnet');
  assert(arms[1].id === 'gemini-35-flash', 'Second arm should be default gemini id');
});

test('buildCompareArms expands medium and high gemini arms', () => {
  const arms = buildCompareArms({
    sonnetModel: 'claude-sonnet-4-6',
    geminiModel: 'gemini-3.5-flash',
    geminiThinkingLevels: ['medium', 'high'],
    geminiThinkingLevel: null,
    skipSonnet: true,
  });
  assert(arms.length === 2, `Expected 2 gemini arms, got ${arms.length}`);
  assert(arms[0].thinkingLevel === 'medium', 'First gemini arm should be medium');
  assert(arms[1].thinkingLevel === 'high', 'Second gemini arm should be high');
  assert(arms[0].id === 'gemini-35-flash-medium', 'Expected medium id suffix');
});

test('buildCompareArms can include sonnet with multiple gemini levels', () => {
  const arms = buildCompareArms({
    sonnetModel: 'claude-sonnet-4-6',
    geminiModel: 'gemini-3.5-flash',
    geminiThinkingLevels: ['medium', 'high'],
    geminiThinkingLevel: null,
    skipSonnet: false,
    sonnetOnly: false,
  });
  assert(arms.length === 3, `Expected 3 arms, got ${arms.length}`);
  assert(arms[0].id === 'sonnet', 'Sonnet should be first');
});

test('buildCompareArms sonnet-only returns a single sonnet arm', () => {
  const arms = buildCompareArms({
    sonnetModel: 'claude-sonnet-4-6',
    geminiModel: 'gemini-3.5-flash',
    geminiThinkingLevels: [],
    geminiThinkingLevel: null,
    skipSonnet: false,
    sonnetOnly: true,
  });
  assert(arms.length === 1, `Expected 1 arm, got ${arms.length}`);
  assert(arms[0].id === 'sonnet', 'Expected sonnet-only arm');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(`  ${err.message}`);
  }
}
if (failed > 0) process.exit(1);
