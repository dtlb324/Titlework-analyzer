import { buildMessagesRequestBody, buildSystemParam, buildMergeUserMessageContent, estimateTextTokens } from '../api/_lib/anthropic-request.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const previousCache = process.env.ANTHROPIC_PROMPT_CACHE;

test('buildSystemParam enables ephemeral cache for long prompts by default', () => {
  process.env.ANTHROPIC_PROMPT_CACHE = 'true';
  const system = buildSystemParam('x'.repeat(400));
  assert(Array.isArray(system), 'Expected cached system array');
  assert(system[0].cache_control?.type === 'ephemeral', 'Expected ephemeral cache_control');
});

test('buildMessagesRequestBody passes through cached system blocks', () => {
  process.env.ANTHROPIC_PROMPT_CACHE = 'true';
  const body = buildMessagesRequestBody({
    model: 'claude-haiku-4-5',
    maxTokens: 1000,
    system: 'y'.repeat(400),
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert(body.model === 'claude-haiku-4-5', 'Expected model preserved');
  assert(Array.isArray(body.system), 'Expected system array in request body');
});

test('buildMergeUserMessageContent caches large segment blocks', () => {
  process.env.ANTHROPIC_PROMPT_CACHE = 'true';
  const segments = 'x'.repeat(5000);
  assert(estimateTextTokens(segments) >= 1024, 'Expected test segment block above cache threshold');
  const content = buildMergeUserMessageContent({
    preamble: 'Merge these segments.',
    tract: 'Tract A',
    contextNotes: 'Notes',
    segmentBlock: segments,
    cacheSegments: true,
  });
  assert(Array.isArray(content), 'Expected structured user content with cache block');
  assert(content.some(block => block.cache_control?.type === 'ephemeral'), 'Expected ephemeral cache on segment block');
});

let passed = 0;
let failed = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}

if (previousCache === undefined) delete process.env.ANTHROPIC_PROMPT_CACHE;
else process.env.ANTHROPIC_PROMPT_CACHE = previousCache;

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
