import {
  anthropicMessagesToGeminiContents,
  buildGeminiGenerateContentBody,
  extractGeminiText,
  isGeminiModel,
  normalizeGeminiUsage,
} from '../api/_lib/gemini-request.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('isGeminiModel detects gemini model ids', () => {
  assert(isGeminiModel('gemini-2.5-flash'), 'Expected gemini-2.5-flash');
  assert(!isGeminiModel('claude-haiku-4-5'), 'Claude should not match');
});

test('anthropicMessagesToGeminiContents maps file_uri document blocks', () => {
  const contents = anthropicMessagesToGeminiContents([
    {
      role: 'user',
      content: [
        {
          type: 'document',
          source: {
            type: 'file_uri',
            media_type: 'application/pdf',
            uri: 'https://generativelanguage.googleapis.com/v1beta/files/test123',
            geminiFileName: 'files/test123',
          },
        },
      ],
    },
  ]);
  assert(contents[0].parts[0].file_data.file_uri.includes('files/test123'), 'Expected Gemini file URI');
});

test('anthropicMessagesToGeminiContents maps pdf and text blocks', () => {
  const contents = anthropicMessagesToGeminiContents([
    {
      role: 'user',
      content: [
        {
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: 'abc123' },
        },
        { type: 'text', text: 'Abstract this deed.' },
      ],
    },
  ]);
  assert(contents.length === 1, 'Expected one Gemini content entry');
  assert(contents[0].role === 'user', 'Expected user role');
  assert(contents[0].parts.length === 2, 'Expected pdf + text parts');
  assert(contents[0].parts[0].inline_data.mime_type === 'application/pdf', 'Expected pdf mime type');
  assert(contents[0].parts[1].text === 'Abstract this deed.', 'Expected prompt text');
});

test('buildGeminiGenerateContentBody includes system and thinking budget', () => {
  const body = buildGeminiGenerateContentBody({
    model: 'gemini-2.5-flash',
    maxTokens: 3000,
    system: 'You are a title attorney.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    thinkingBudget: 0,
  });
  assert(body.systemInstruction.parts[0].text === 'You are a title attorney.', 'Expected system instruction');
  assert(body.generationConfig.maxOutputTokens === 3000, 'Expected max output tokens');
  assert(body.generationConfig.thinkingConfig.thinkingBudget === 0, 'Expected thinking budget');
});

test('normalizeGeminiUsage maps token counts', () => {
  const usage = normalizeGeminiUsage({ promptTokenCount: 1200, candidatesTokenCount: 450 });
  assert(usage.input_tokens === 1200, 'Expected input token mapping');
  assert(usage.output_tokens === 450, 'Expected output token mapping');
});

test('extractGeminiText joins candidate parts', () => {
  const text = extractGeminiText({
    candidates: [{ content: { parts: [{ text: 'DOC TYPE: deed\n' }, { text: 'GRANTOR: Smith' }] } }],
  });
  assert(text.includes('DOC TYPE: deed'), 'Expected first part text');
  assert(text.includes('GRANTOR: Smith'), 'Expected second part text');
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(err.stack || err.message || String(err));
  }
}
process.exit(failed ? 1 : 0);
