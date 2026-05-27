import {
  consumeGeminiGenerateContentStream,
  extractGeminiStreamTextParts,
  mergeGeminiStreamText,
} from '../api/_lib/gemini-stream.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function encodeSse(payload) {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

function mockStreamBody(chunks) {
  let index = 0;
  return {
    getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true, value: undefined };
          return { done: false, value: chunks[index++] };
        },
      };
    },
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('mergeGeminiStreamText handles incremental and cumulative chunks', () => {
  assert(mergeGeminiStreamText('', 'Hi') === 'Hi', 'incremental from empty');
  assert(mergeGeminiStreamText('Hi', ' there') === 'Hi there', 'incremental append');
  assert(mergeGeminiStreamText('Hi', 'Hi there') === 'Hi there', 'cumulative replace');
});

test('extractGeminiStreamTextParts skips thought parts', () => {
  const text = extractGeminiStreamTextParts({
    candidates: [{
      content: {
        parts: [
          { thought: true, text: 'reasoning' },
          { text: 'Answer' },
        ],
      },
    }],
  });
  assert(text === 'Answer', 'Expected answer text only');
});

test('consumeGeminiGenerateContentStream accumulates answer deltas', async () => {
  const chunks = [
    encodeSse({
      modelVersion: 'gemini-3.5-flash',
      candidates: [{ content: { parts: [{ text: '## CHAIN' }] } }],
    }),
    encodeSse({
      candidates: [{ content: { parts: [{ text: ' OF TITLE' }] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
    }),
  ];
  const deltas = [];
  const result = await consumeGeminiGenerateContentStream(mockStreamBody(chunks), {
    onDelta: async (delta, fullText) => {
      deltas.push({ delta, fullText });
    },
  });
  assert(result.text === '## CHAIN OF TITLE', `Expected merged text, got ${result.text}`);
  assert(result.model === 'gemini-3.5-flash', 'Expected model version from stream');
  assert(deltas.length === 2, 'Expected two delta callbacks');
  assert(result.firstDeltaAt != null, 'Expected first delta timestamp');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(err.stack || err.message || String(err));
  }
}
process.exit(failed ? 1 : 0);
