import {
  anthropicMessagesToGeminiContents,
  buildGeminiGenerateContentBody,
  extractGeminiText,
  extractGeminiThoughtSummaries,
  invokeGeminiGenerateContent,
  isGemini3SeriesModel,
  isGemini4HydrogenModel,
  isGemini4SeriesModel,
  isGeminiModel,
  messagesHaveVisualMedia,
  normalizeGeminiMediaResolution,
  normalizeGeminiUsage,
  resolveGeminiMediaResolution,
  resolveGeminiThinkingConfig,
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

test('buildGeminiGenerateContentBody includes system and thinking budget for 2.5', () => {
  const body = buildGeminiGenerateContentBody({
    model: 'gemini-2.5-flash',
    maxTokens: 3000,
    system: 'You are a title attorney.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    thinkingConfig: { thinkingBudget: 0 },
  });
  assert(body.systemInstruction.parts[0].text === 'You are a title attorney.', 'Expected system instruction');
  assert(body.generationConfig.maxOutputTokens === 3000, 'Expected max output tokens');
  assert(body.generationConfig.thinkingConfig.thinkingBudget === 0, 'Expected thinking budget');
});

test('resolveGeminiThinkingConfig uses thinkingLevel for Gemini 3.5', () => {
  const prevLevel = process.env.GEMINI_THINKING_LEVEL;
  process.env.GEMINI_THINKING_LEVEL = 'high';
  try {
    const config = resolveGeminiThinkingConfig('gemini-3.5-flash');
    assert(config.thinkingLevel === 'high', 'Expected high thinking level');
    assert(config.thinkingBudget === undefined, 'Gemini 3.5 must not use thinkingBudget from env');
    const body = buildGeminiGenerateContentBody({
      model: 'gemini-3.5-flash',
      maxTokens: 2000,
      system: 'Test',
      messages: [{ role: 'user', content: 'Hi' }],
      thinkingConfig: config,
    });
    assert(body.generationConfig.thinkingConfig.thinkingLevel === 'high', 'Expected high in request body');
  } finally {
    if (prevLevel === undefined) delete process.env.GEMINI_THINKING_LEVEL;
    else process.env.GEMINI_THINKING_LEVEL = prevLevel;
  }
});

test('isGemini3SeriesModel distinguishes 2.5 and 3.5', () => {
  assert(isGemini3SeriesModel('gemini-3.5-flash'), 'Expected 3.5');
  assert(!isGemini3SeriesModel('gemini-2.5-flash'), 'Expected 2.5 false');
  assert(!isGemini3SeriesModel('gemini-4-hydrogen'), 'Gemini 4 is not the 3 series');
});

test('Gemini 4 Hydrogen uses thinkingLevel, not the 2.5 thinkingBudget branch', () => {
  const prev = { level: process.env.GEMINI_THINKING_LEVEL, budget: process.env.GEMINI_THINKING_BUDGET };
  delete process.env.GEMINI_THINKING_LEVEL;
  process.env.GEMINI_THINKING_BUDGET = '1024';
  try {
    assert(isGemini4SeriesModel('gemini-4-hydrogen'), 'Expected Hydrogen to be Gemini 4');
    assert(!isGemini4SeriesModel('gemini-3.5-flash') && !isGemini4SeriesModel('gemini-2.5-flash'), 'Only gemini-4 ids match');
    for (const level of ['low', 'medium', 'high', 'xhigh']) {
      const config = resolveGeminiThinkingConfig('gemini-4-hydrogen', { thinkingLevel: level });
      assert(JSON.stringify(config) === JSON.stringify({ thinkingLevel: level }), `Expected only thinkingLevel ${level}, got ${JSON.stringify(config)}`);
    }
    assert(resolveGeminiThinkingConfig('gemini-4-hydrogen', { thinkingLevel: ' XHigh ' }).thinkingLevel === 'xhigh', 'Expected normalized xhigh');
    assert(resolveGeminiThinkingConfig('gemini-4-hydrogen') === null, 'No level set: send no thinkingConfig so the model default (high) applies');
    assert(resolveGeminiThinkingConfig('gemini-4-hydrogen', { thinkingBudget: 0 }) === null, 'A budget must never be sent to Gemini 4');
    assert(resolveGeminiThinkingConfig('gemini-4-hydrogen', { thinkingLevel: 'minimal' }) === null, 'Hydrogen has no minimal level');
    const body = buildGeminiGenerateContentBody({
      model: 'gemini-4-hydrogen',
      maxTokens: 2000,
      system: 'Test',
      messages: [{ role: 'user', content: 'Hi' }],
      thinkingLevel: 'xhigh',
    });
    assert(JSON.stringify(body.generationConfig.thinkingConfig) === '{"thinkingLevel":"xhigh"}', `Unexpected body ${JSON.stringify(body.generationConfig)}`);
    process.env.GEMINI_THINKING_LEVEL = 'xhigh';
    assert(resolveGeminiThinkingConfig('gemini-4-hydrogen').thinkingLevel === 'xhigh', 'Expected env level');
    process.env.GEMINI_THINKING_LEVEL = 'minimal';
    assert(resolveGeminiThinkingConfig('gemini-4-hydrogen') === null, 'Env minimal is ignored for Hydrogen');
  } finally {
    for (const [key, value] of [['GEMINI_THINKING_LEVEL', prev.level], ['GEMINI_THINKING_BUDGET', prev.budget]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('Gemini 3 and 2.5 thinking config are unchanged by Gemini 4 support', () => {
  const prev = { level: process.env.GEMINI_THINKING_LEVEL, budget: process.env.GEMINI_THINKING_BUDGET };
  delete process.env.GEMINI_THINKING_LEVEL;
  delete process.env.GEMINI_THINKING_BUDGET;
  try {
    for (const level of ['minimal', 'low', 'medium', 'high']) {
      assert(JSON.stringify(resolveGeminiThinkingConfig('gemini-3.1-flash-lite', { thinkingLevel: level })) === JSON.stringify({ thinkingLevel: level }), `gemini-3 ${level}`);
    }
    assert(resolveGeminiThinkingConfig('gemini-3.8-flash', { thinkingLevel: 'xhigh' }) === null, 'xhigh is not a gemini-3 level');
    assert(resolveGeminiThinkingConfig('gemini-3.1-flash-lite', { thinkingLevel: 'xhigh' }) === null, 'xhigh is not a gemini-3 level');
    assert(resolveGeminiThinkingConfig('gemini-3.1-flash-lite') === null, 'gemini-3 with no level sends nothing');
    assert(JSON.stringify(resolveGeminiThinkingConfig('gemini-2.5-flash')) === '{"thinkingBudget":0}', '2.5 default budget');
    assert(JSON.stringify(resolveGeminiThinkingConfig('gemini-2.5-flash', { thinkingBudget: 1024 })) === '{"thinkingBudget":1024}', '2.5 explicit budget');
    assert(resolveGeminiThinkingConfig('gemini-2.5-flash', { thinkingLevel: 'xhigh' }).thinkingLevel === undefined, '2.5 ignores levels');
    assert(resolveGeminiThinkingConfig('claude-haiku-5-5', { thinkingLevel: 'high' }) === null, 'non-Gemini model');
  } finally {
    for (const [key, value] of [['GEMINI_THINKING_LEVEL', prev.level], ['GEMINI_THINKING_BUDGET', prev.budget]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('xhigh is accepted only by Hydrogen ids; Carbon and Argon stop at high', () => {
  const prev = process.env.GEMINI_THINKING_LEVEL;
  delete process.env.GEMINI_THINKING_LEVEL;
  try {
    for (const id of ['gemini-4-hydrogen', 'Gemini-4-Hydrogen', ' gemini-4-hydrogen ', 'gemini-4-hydrogen-preview', 'gemini-4-hydrogen-preview-11-2026']) {
      assert(isGemini4HydrogenModel(id), `Expected ${id} to be Hydrogen`);
      assert(resolveGeminiThinkingConfig(id, { thinkingLevel: 'xhigh' })?.thinkingLevel === 'xhigh', `${id} accepts xhigh`);
      assert(resolveGeminiThinkingConfig(id, { thinkingLevel: 'minimal' }) === null, `${id} rejects minimal`);
    }
    for (const id of ['gemini-4-carbon', 'gemini-4-argon', 'gemini-4', 'gemini-4-carbon-cyber-permissive', 'gemini-4-hydrogenx']) {
      assert(!isGemini4HydrogenModel(id), `Expected ${id} not to be Hydrogen`);
      assert(resolveGeminiThinkingConfig(id, { thinkingLevel: 'xhigh' }) === null, `${id} rejects xhigh`);
      assert(resolveGeminiThinkingConfig(id, { thinkingLevel: 'minimal' }) === null, `${id} rejects minimal`);
      for (const level of ['low', 'medium', 'high']) {
        assert(JSON.stringify(resolveGeminiThinkingConfig(id, { thinkingLevel: level })) === JSON.stringify({ thinkingLevel: level }), `${id} accepts ${level}`);
      }
      process.env.GEMINI_THINKING_LEVEL = 'xhigh';
      assert(resolveGeminiThinkingConfig(id) === null, `${id} ignores env xhigh`);
      delete process.env.GEMINI_THINKING_LEVEL;
      const body = buildGeminiGenerateContentBody({ model: id, maxTokens: 100, system: 'S', messages: [{ role: 'user', content: 'Hi' }], thinkingLevel: 'xhigh' });
      assert(!('thinkingConfig' in body.generationConfig), `${id} xhigh sends no thinkingConfig, got ${JSON.stringify(body.generationConfig)}`);
    }
  } finally {
    if (prev === undefined) delete process.env.GEMINI_THINKING_LEVEL; else process.env.GEMINI_THINKING_LEVEL = prev;
  }
});

test('buildGeminiGenerateContentBody never sends thinkingBudget to Gemini 4', () => {
  const prev = { level: process.env.GEMINI_THINKING_LEVEL, budget: process.env.GEMINI_THINKING_BUDGET };
  delete process.env.GEMINI_THINKING_LEVEL;
  delete process.env.GEMINI_THINKING_BUDGET;
  try {
    const build = (model, extra) => buildGeminiGenerateContentBody({ model, maxTokens: 100, system: 'S', messages: [{ role: 'user', content: 'Hi' }], ...extra });
    for (const id of ['gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon', 'Gemini-4-Hydrogen']) {
      for (const thinkingBudget of [-1, 0, 1024, null, '512']) {
        const body = build(id, { thinkingBudget });
        assert(!('thinkingConfig' in body.generationConfig), `${id} budget ${JSON.stringify(thinkingBudget)} leaked: ${JSON.stringify(body.generationConfig)}`);
      }
      const both = build(id, { thinkingBudget: 1024, thinkingLevel: 'low' });
      assert(JSON.stringify(both.generationConfig.thinkingConfig) === '{"thinkingLevel":"low"}', `${id} level wins and budget is dropped`);
    }
    // Non-Gemini-4 bodies keep their exact shape.
    assert(JSON.stringify(build('gemini-3.5-flash', { thinkingBudget: 1024 }).generationConfig) === '{"maxOutputTokens":100,"thinkingConfig":{"thinkingBudget":1024}}', 'gemini-3 fallback budget unchanged');
    assert(JSON.stringify(build('gemini-3.5-flash', { thinkingLevel: 'low', thinkingBudget: 1024 }).generationConfig.thinkingConfig) === '{"thinkingLevel":"low"}', 'gemini-3 level unchanged');
    assert(JSON.stringify(build('gemini-2.5-flash', { thinkingBudget: -1 }).generationConfig.thinkingConfig) === '{"thinkingBudget":-1}', '2.5 dynamic budget unchanged');
    assert(JSON.stringify(build('gemini-2.5-flash', { thinkingBudget: 0 }).generationConfig.thinkingConfig) === '{"thinkingBudget":0}', '2.5 zero budget unchanged');
    assert(JSON.stringify(build('gemini-2.5-flash').generationConfig.thinkingConfig) === '{"thinkingBudget":0}', '2.5 default budget unchanged');
  } finally {
    for (const [key, value] of [['GEMINI_THINKING_LEVEL', prev.level], ['GEMINI_THINKING_BUDGET', prev.budget]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('extractGeminiText omits thought summary parts', () => {
  const text = extractGeminiText({
    candidates: [{
      content: {
        parts: [
          { thought: true, text: 'internal reasoning' },
          { text: 'DOC TYPE: deed' },
        ],
      },
    }],
  });
  assert(!text.includes('internal reasoning'), 'Thought parts must not appear in output text');
  assert(text.includes('DOC TYPE: deed'), 'Expected answer text');
});

test('extractGeminiThoughtSummaries returns thought parts only', () => {
  const thoughts = extractGeminiThoughtSummaries({
    candidates: [{
      content: {
        parts: [
          { thought: true, text: 'Step 1: check grantor.' },
          { text: 'Final answer' },
        ],
      },
    }],
  });
  assert(thoughts.length === 1 && thoughts[0].includes('grantor'), 'Expected thought summary');
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

test('normalizeGeminiMediaResolution and resolveGeminiMediaResolution default to MEDIA_RESOLUTION_HIGH and honor env overrides', () => {
  const prev = process.env.GEMINI_PDF_MEDIA_RESOLUTION;
  delete process.env.GEMINI_PDF_MEDIA_RESOLUTION;
  try {
    assert(resolveGeminiMediaResolution() === 'MEDIA_RESOLUTION_HIGH', 'Expected default MEDIA_RESOLUTION_HIGH');
    assert(normalizeGeminiMediaResolution('low') === 'MEDIA_RESOLUTION_LOW', 'Expected short low normalization');
    assert(normalizeGeminiMediaResolution('Medium') === 'MEDIA_RESOLUTION_MEDIUM', 'Expected case-insensitive medium normalization');
    assert(normalizeGeminiMediaResolution('MEDIA_RESOLUTION_HIGH') === 'MEDIA_RESOLUTION_HIGH', 'Expected full enum normalization');
    for (const offValue of ['off', 'false', 'none', 'invalid']) {
      assert(normalizeGeminiMediaResolution(offValue) === null, `Expected null for ${offValue}`);
      process.env.GEMINI_PDF_MEDIA_RESOLUTION = offValue;
      assert(resolveGeminiMediaResolution() === null, `Expected env ${offValue} to resolve null`);
    }
    process.env.GEMINI_PDF_MEDIA_RESOLUTION = 'medium';
    assert(resolveGeminiMediaResolution() === 'MEDIA_RESOLUTION_MEDIUM', 'Expected env medium to resolve');
    assert(resolveGeminiMediaResolution('low') === 'MEDIA_RESOLUTION_LOW', 'Expected explicit override to win over env');
  } finally {
    if (prev === undefined) delete process.env.GEMINI_PDF_MEDIA_RESOLUTION;
    else process.env.GEMINI_PDF_MEDIA_RESOLUTION = prev;
  }
});

test('buildGeminiGenerateContentBody sets mediaResolution only when visual media is present', () => {
  const base64PdfMessages = [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
      { type: 'text', text: 'Abstract this deed.' },
    ],
  }];
  const fileUriPdfMessages = [{
    role: 'user',
    content: [
      { type: 'document', source: { type: 'file_uri', media_type: 'application/pdf', uri: 'https://generativelanguage.googleapis.com/v1beta/files/abc' } },
      { type: 'text', text: 'Abstract this deed.' },
    ],
  }];
  const imageMessages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' } },
      { type: 'text', text: 'Abstract this image.' },
    ],
  }];
  const textOnlyMessages = [{
    role: 'user',
    content: [{ type: 'text', text: 'Abstract extracted text.' }],
  }];

  assert(messagesHaveVisualMedia(base64PdfMessages) === true, 'Expected base64 PDF to count as visual');
  assert(messagesHaveVisualMedia(fileUriPdfMessages) === true, 'Expected file_uri PDF to count as visual');
  assert(messagesHaveVisualMedia(imageMessages) === true, 'Expected image to count as visual');
  assert(messagesHaveVisualMedia(textOnlyMessages) === false, 'Expected text-only messages not to count as visual');

  for (const messages of [base64PdfMessages, fileUriPdfMessages, imageMessages]) {
    const body = buildGeminiGenerateContentBody({
      model: 'gemini-3.1-flash-lite',
      maxTokens: 2000,
      system: 'System',
      messages,
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
    });
    assert(body.generationConfig.mediaResolution === 'MEDIA_RESOLUTION_HIGH', 'Expected mediaResolution on visual body');
    const omitted = buildGeminiGenerateContentBody({
      model: 'gemini-3.1-flash-lite',
      maxTokens: 2000,
      system: 'System',
      messages,
    });
    assert(!('mediaResolution' in omitted.generationConfig), 'Expected mediaResolution omitted when not requested');
  }

  const textBody = buildGeminiGenerateContentBody({
    model: 'gemini-3.1-flash-lite',
    maxTokens: 2000,
    system: 'System',
    messages: textOnlyMessages,
    mediaResolution: 'MEDIA_RESOLUTION_HIGH',
  });
  assert(!('mediaResolution' in textBody.generationConfig), 'Text-only body must omit mediaResolution even when passed');
});

test('invokeGeminiGenerateContent includes mediaResolution on visual PDF requests and omits it on text-only requests', async () => {
  const prevKey = process.env.GEMINI_API_KEY;
  const prevFetch = global.fetch;
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  const sentBodies = [];
  global.fetch = async (_url, init) => {
    sentBodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'DOC TYPE: Deed' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 },
        modelVersion: 'gemini-3.1-flash-lite',
      }),
    };
  };

  try {
    await invokeGeminiGenerateContent({
      model: 'gemini-3.1-flash-lite',
      maxTokens: 2000,
      system: 'System',
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
          { type: 'text', text: 'Abstract visual deed.' },
        ],
      }],
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
    });

    await invokeGeminiGenerateContent({
      model: 'gemini-3.1-flash-lite',
      maxTokens: 2000,
      system: 'System',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Abstract text-only deed.' }] }],
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
    });
  } finally {
    global.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevKey;
  }

  assert(sentBodies.length === 2, `Expected 2 requests, got ${sentBodies.length}`);
  assert(sentBodies[0].generationConfig.mediaResolution === 'MEDIA_RESOLUTION_HIGH', 'Visual request must send mediaResolution');
  assert(!('mediaResolution' in sentBodies[1].generationConfig), 'Text-only request must omit mediaResolution');
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
