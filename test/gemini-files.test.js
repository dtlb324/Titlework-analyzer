import {
  getGeminiFileApiConfig,
  shouldUseGeminiFileApi,
} from '../api/_lib/gemini-files.js';
import { anthropicMessagesToGeminiContents } from '../api/_lib/gemini-request.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('shouldUseGeminiFileApi respects min and max bytes', () => {
  const config = getGeminiFileApiConfig();
  assert(shouldUseGeminiFileApi(config.minBytes - 1) === false, 'Below min should not use Files API');
  assert(shouldUseGeminiFileApi(config.minBytes) === true, 'At min should use Files API');
  assert(shouldUseGeminiFileApi(config.maxBytes + 1) === false, 'Above max should not use Files API');
});

test('shouldUseGeminiFileApi can be disabled', () => {
  const prev = process.env.GEMINI_FILE_API_ENABLED;
  process.env.GEMINI_FILE_API_ENABLED = 'false';
  assert(shouldUseGeminiFileApi(5_000_000) === false, 'Disabled Files API');
  if (prev === undefined) delete process.env.GEMINI_FILE_API_ENABLED;
  else process.env.GEMINI_FILE_API_ENABLED = prev;
});

test('anthropicMessagesToGeminiContents maps file_uri document parts', () => {
  const contents = anthropicMessagesToGeminiContents([
    {
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'file_uri',
            media_type: 'application/pdf',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc123',
          },
        },
        { type: 'text', text: 'Abstract this deed.' },
      ],
    },
  ]);
  assert(contents[0].parts[0].file_data.mime_type === 'application/pdf', 'Expected pdf mime');
  assert(contents[0].parts[0].file_data.file_uri.includes('files/abc123'), 'Expected file URI part');
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
