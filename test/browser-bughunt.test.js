import assert from 'node:assert/strict';
import { disposeAll, jsonResponse, loadIndex, makeJobServer, pngFile, tick } from './helpers/browser-index-harness.js';

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const browserOnlyStorage = { 'GET /api/blob/upload': async () => jsonResponse(200, { available: false, error: 'no bucket' }) };
const isSynthesisCall = call => call.model.startsWith('claude');
const errorText = app => app.getEl('errorBox').innerHTML.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function geminiOrSonnetReply(geminiText) {
  return body => (body.model.startsWith('gemini') ? geminiText : '## FINAL OWNERSHIP DETERMINATION\nBob.');
}

// Finding 1: label misattribution in browser abstraction batches.

test('finding 1: a batch answer missing a DOCUMENT label fails loudly instead of giving the file another document\'s facts', async () => {
  const server = makeJobServer({
    hooks: browserOnlyStorage,
    analyzeReply: geminiOrSonnetReply('DOCUMENT #1:\nDOC TYPE: Deed\nGRANTOR: Alice\nGRANTEE: Bob\nCONFIDENCE: high\n'),
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed-1.png', 'a'.repeat(40)), pngFile('deed-2.png', 'b'.repeat(40))]);
  await app.run('analyze()');
  await tick(20);

  assert.equal(server.analyze.filter(isSynthesisCall).length, 0, 'no synthesis may run on an incomplete extraction');
  assert.deepEqual(server.state.resultSaves, [], 'no result may be saved as finished');
  assert.ok(server.state.patches.some(p => p.status === 'failed'), 'job must be marked failed');
  assert.match(errorText(app), /deed-2\.png/, 'the user must be told which file has no extraction');
});

test('finding 1 control: labeled answers for every file synthesize each file with its own abstract', async () => {
  const server = makeJobServer({
    hooks: browserOnlyStorage,
    analyzeReply: geminiOrSonnetReply('DOCUMENT #1:\nGRANTOR: Alice\n\nDOCUMENT #2:\nGRANTOR: Carol\n'),
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed-1.png', 'a'.repeat(40)), pngFile('deed-2.png', 'b'.repeat(40))]);
  await app.run('analyze()');
  await tick(20);

  const synthesis = server.analyze.filter(isSynthesisCall);
  assert.equal(synthesis.length, 1);
  assert.match(synthesis[0].content, /### Document 1: deed-1\.png\n\nGRANTOR: Alice/);
  assert.match(synthesis[0].content, /### Document 2: deed-2\.png\n\nGRANTOR: Carol/);
  assert.equal(server.state.resultSaves.length, 1);
  assert.equal(server.state.resultSaves[0].status, 'complete');
});

test('finding 1 control: a single-file batch may use an unlabeled answer', async () => {
  const server = makeJobServer({
    hooks: browserOnlyStorage,
    analyzeReply: geminiOrSonnetReply('DOC TYPE: Deed\nGRANTOR: Alice\n'),
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed-1.png', 'a'.repeat(40))]);
  await app.run('analyze()');
  await tick(20);

  assert.match(server.analyze.find(isSynthesisCall).content, /### Document 1: deed-1\.png\n\nDOC TYPE: Deed/);
  assert.equal(server.state.resultSaves[0].status, 'complete');
});

test('finding 1: document #1 is not matched inside the label of document #10', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${i + 1}.png` }));
  const labeled = Array.from({ length: 11 }, (_, i) => `DOCUMENT #${i + 2}:\nbody ${i + 2}`).join('\n\n');
  app.ctx.__args = { result: labeled, files };
  assert.throws(() => app.run('parseBatchResult(__args.result, __args.files, 0)'), /f1\.png/);
});

test('finding 1 control: every label present maps each abstract to its own file, including multi-digit labels', () => {
  const app = loadIndex({ fetchImpl: async () => jsonResponse(404, {}) });
  const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${i + 1}.png` }));
  const labeled = Array.from({ length: 12 }, (_, i) => `DOCUMENT #${i + 1}:\nbody ${i + 1}`).join('\n\n');
  app.ctx.__args = { result: labeled, files };
  const parsed = app.run('parseBatchResult(__args.result, __args.files, 0)');
  assert.deepEqual(parsed.map(p => p.abstract), Array.from({ length: 12 }, (_, i) => `body ${i + 1}`));
  assert.deepEqual(parsed.map(p => p.filename), files.map(f => f.name));
});

// Finding 2: cancel and supersession must be owned by the run that started the work.

function cancelDuringFirstAbstractionPoll(getApp) {
  let canceled = false;
  return {
    'GET /api/jobs/job_1/abstraction/status': async server => {
      if (canceled) return undefined;
      canceled = true;
      await getApp().run("runJobAction({ id: 'job_1' }, '/cancel')");
      server.canceledAtAnalyzeCount = server.analyze.length;
      return undefined;
    },
  };
}

test('finding 2: cancel during server abstraction stops analyze() before any browser model call', async () => {
  let app;
  const server = makeJobServer({ hooks: cancelDuringFirstAbstractionPoll(() => app) });
  app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'x'.repeat(50))]);
  await app.run('analyze()');
  await tick(30);

  assert.ok(server.canceledAtAnalyzeCount !== undefined, 'cancel must have been exercised');
  assert.deepEqual(server.analyze.slice(server.canceledAtAnalyzeCount), [], 'no billable model call after cancel');
  assert.deepEqual(server.state.resultSaves, [], 'no result save after cancel');
});

test('finding 2: cancel during server abstraction stops analyzeAdditional() before any browser model call', async () => {
  let app;
  const server = makeJobServer({ hooks: cancelDuringFirstAbstractionPoll(() => app) });
  app = loadIndex({ fetchImpl: server.fetch });
  app.run("documentAbstracts = [{ filename: 'old.png', sourceFilename: 'old.png', abstract: 'OLD FACTS' }]");
  await app.ctx.handleAdditionalFiles([pngFile('new.png', 'y'.repeat(50))]);
  await app.run('analyzeAdditional()');
  await tick(30);

  assert.ok(server.canceledAtAnalyzeCount !== undefined, 'cancel must have been exercised');
  assert.deepEqual(server.analyze.slice(server.canceledAtAnalyzeCount), [], 'no billable model call after cancel');
  assert.deepEqual(server.state.resultSaves, [], 'no result save after cancel');
});

test('finding 2: a superseded run cannot publish its opinion into the run that replaced it', async () => {
  const analyzeCalls = [];
  let releaseRunA;
  const runAGate = new Promise(resolve => { releaseRunA = resolve; });
  let jobCounter = 0;
  const fetchImpl = async (url, options = {}) => {
    const method = options.method || 'GET';
    if (url === '/api/analyze') {
      const body = JSON.parse(options.body);
      const text = typeof body.messages[0].content === 'string' ? body.messages[0].content : 'IMAGE';
      analyzeCalls.push({ model: body.model, text });
      if (body.model.startsWith('gemini')) {
        const isRunA = analyzeCalls.filter(c => c.model.startsWith('gemini')).length === 1;
        if (isRunA) await runAGate;
        return jsonResponse(200, { content: [{ type: 'text', text: `${isRunA ? 'FACTS-A' : 'FACTS-B'}` }] });
      }
      return jsonResponse(200, { content: [{ type: 'text', text: text.includes('FACTS-A') ? 'OPINION-A' : 'OPINION-B' }] });
    }
    if (url === '/api/jobs' && method === 'POST') return jsonResponse(201, { job: { id: `job_${++jobCounter}`, status: 'created' } });
    if (url === '/api/blob/upload') return jsonResponse(200, { available: false, error: 'no bucket' });
    if (/^\/api\/jobs\/job_\d+$/.test(url) && method === 'PATCH') return jsonResponse(200, { job: { id: url.split('/').pop() } });
    if (/^\/api\/jobs\/job_\d+\/result$/.test(url) && method === 'POST') return jsonResponse(200, {});
    return jsonResponse(404, {});
  };
  const app = loadIndex({ fetchImpl });
  await app.ctx.handleFiles([pngFile('a.png', 'a'.repeat(40))]);
  const runA = app.run('analyze()');
  for (let i = 0; i < 200 && !analyzeCalls.length; i++) await tick(5);
  assert.equal(analyzeCalls.length, 1, 'run A must be waiting on its abstraction call');

  app.run('resetHomeForNewJob()');
  await app.ctx.handleFiles([pngFile('b.png', 'b'.repeat(40))]);
  await app.run('analyze()');
  await tick(30);
  releaseRunA();
  await runA;
  await tick(30);

  const synthesis = analyzeCalls.filter(c => c.model.startsWith('claude'));
  assert.equal(synthesis.length, 1, 'only the current run may synthesize');
  assert.match(synthesis[0].text, /FACTS-B/);
  const opinion = app.run("conversationHistory.filter(m => m.kind === 'title-opinion').map(m => m.content)");
  assert.deepEqual([...opinion], ['OPINION-B']);
  assert.deepEqual([...app.run('documentAbstracts.map(d => d.filename)')], ['b.png']);
});

// Finding 2: a canceled or replaced run must stop for good (no more billable calls, no saved result).

const cancelOnFirst = (app, predicate, afterCancel) => {
  let done = false;
  return async (server, options) => {
    if (done || !predicate(options)) return undefined;
    done = true;
    await app.run("runJobAction({ id: 'job_1' }, '/cancel')");
    afterCancel?.(server);
    return undefined;
  };
};
const isGeminiRequest = options => JSON.parse(options.body).model?.startsWith('gemini');

test('finding 2: canceling while the browser waits on server abstraction starts no browser fallback and saves nothing', async () => {
  const hooks = {};
  const server = makeJobServer({ hooks });
  const app = loadIndex({ fetchImpl: server.fetch });
  hooks['GET /api/jobs/job_1/abstraction/status'] = cancelOnFirst(app, () => true);
  await app.ctx.handleFiles([pngFile('deed.png', 'x'.repeat(50))]);
  await app.run('analyze()');
  await tick(30);

  assert.equal(server.state.canceled, true, 'the cancel request reached the server');
  assert.deepEqual(server.analyze.map(c => c.model), [], 'no billable browser request after cancel');
  assert.deepEqual(server.state.resultSaves, [], 'no result save after cancel');
});

test('finding 2: canceling during browser abstraction stops before synthesis and result save', async () => {
  const hooks = { ...browserOnlyStorage };
  const server = makeJobServer({ hooks, analyzeReply: geminiOrSonnetReply('DOCUMENT #1:\nGRANTOR: Alice\n') });
  const app = loadIndex({ fetchImpl: server.fetch });
  hooks['POST /api/analyze'] = cancelOnFirst(app, isGeminiRequest);
  await app.ctx.handleFiles([pngFile('deed.png', 'x'.repeat(50))]);
  await app.run('analyze()');
  await tick(30);

  assert.deepEqual(server.analyze.filter(isSynthesisCall), [], 'no synthesis request after cancel');
  assert.deepEqual(server.state.resultSaves, [], 'no result save after cancel');
});

test('finding 2: Start New Job (home reset) during a run also stops that run', async () => {
  const hooks = { ...browserOnlyStorage };
  const server = makeJobServer({ hooks, analyzeReply: geminiOrSonnetReply('DOCUMENT #1:\nGRANTOR: Alice\n') });
  const app = loadIndex({ fetchImpl: server.fetch });
  let reset = false;
  hooks['POST /api/analyze'] = async (_s, options) => {
    if (reset || !isGeminiRequest(options)) return undefined;
    reset = true;
    app.run('resetHomeForNewJob()');
    return undefined;
  };
  await app.ctx.handleFiles([pngFile('deed.png', 'x'.repeat(50))]);
  await app.run('analyze()');
  await tick(30);

  assert.deepEqual(server.analyze.filter(isSynthesisCall), [], 'the superseded run must not synthesize');
  assert.deepEqual(server.state.resultSaves, [], 'the superseded run must not save a result');
  assert.equal(app.run('conversationHistory.length'), 0, 'the superseded run must not publish into the reset page');
});

test('finding 2: canceling an add-more-documents run during browser abstraction stops before synthesis and save', async () => {
  const hooks = { ...browserOnlyStorage };
  const server = makeJobServer({ hooks, analyzeReply: geminiOrSonnetReply('DOCUMENT #2:\nGRANTOR: Carol\n') });
  const app = loadIndex({ fetchImpl: server.fetch });
  hooks['POST /api/analyze'] = cancelOnFirst(app, isGeminiRequest);
  app.run("documentAbstracts = [{ filename: 'old.png', abstract: 'GRANTOR: Alice' }]");
  await app.ctx.handleAdditionalFiles([pngFile('new.png', 'y'.repeat(50))]);
  await app.run('analyzeAdditional()');
  await tick(30);

  assert.deepEqual(server.analyze.filter(isSynthesisCall), [], 'no synthesis request after cancel');
  assert.deepEqual(server.state.resultSaves, [], 'no result save after cancel');
});

test('finding 2 control: an uncanceled run still synthesizes and saves once', async () => {
  const server = makeJobServer({ hooks: browserOnlyStorage, analyzeReply: geminiOrSonnetReply('DOCUMENT #1:\nGRANTOR: Alice\n') });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'x'.repeat(50))]);
  await app.run('analyze()');
  await tick(30);

  assert.equal(server.analyze.filter(isSynthesisCall).length, 1);
  assert.equal(server.state.resultSaves.length, 1);
});

// Truncated model output: a max_tokens reply is not a finished answer.

function truncatingAnalyze(truncate) {
  const calls = [];
  const synthesisInputs = [];
  const hook = async (server, options) => {
    const body = JSON.parse(options.body);
    if (body.ping) return undefined;
    calls.push(body.model);
    if (body.model.startsWith('claude')) synthesisInputs.push(body.messages[0].content);
    const geminiCall = calls.filter(model => model.startsWith('gemini')).length;
    const text = body.model.startsWith('gemini')
      ? `DOCUMENT #${Math.max(1, geminiCall - 1)}:\nDOC TYPE: Deed\nGRANTOR: Grantor ${geminiCall}\n`
      : '## FINAL OWNERSHIP DETERMINATION\nBob owns an undivided 1/';
    return jsonResponse(200, { content: [{ type: 'text', text }], stop_reason: truncate(body.model, geminiCall) ? 'max_tokens' : 'end_turn' });
  };
  return { calls, synthesisInputs, hooks: { ...browserOnlyStorage, 'POST /api/analyze': hook } };
}

test('truncation: a max_tokens browser synthesis is not saved as a complete opinion', async () => {
  const { calls, hooks } = truncatingAnalyze(model => model.startsWith('claude'));
  const server = makeJobServer({ hooks });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'x'.repeat(50))]);
  await app.run('analyze()');
  await tick(30);

  assert.equal(calls.filter(model => model.startsWith('claude')).length, 1, 'no same-limit synthesis retry');
  assert.deepEqual(server.state.resultSaves, [], 'a truncated opinion must not be saved');
  assert.ok(server.state.patches.some(p => p.status === 'failed'), 'job must be marked failed');
  assert.match(errorText(app), /Output truncated/);
});

test('truncation: a max_tokens multi-file abstraction batch is split and each file abstracted on its own', async () => {
  const { calls, synthesisInputs, hooks } = truncatingAnalyze((model, geminiCall) => model.startsWith('gemini') && geminiCall === 1);
  const server = makeJobServer({ hooks });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed-1.png', 'a'.repeat(40)), pngFile('deed-2.png', 'b'.repeat(40))]);
  await app.run('analyze()');
  await tick(30);

  assert.equal(calls.filter(model => model.startsWith('gemini')).length, 3, 'one truncated batch call, then one call per file');
  assert.match(synthesisInputs[0], /### Document 1: deed-1\.png\n\nDOC TYPE: Deed\nGRANTOR: Grantor 2/);
  assert.match(synthesisInputs[0], /### Document 2: deed-2\.png\n\nDOC TYPE: Deed\nGRANTOR: Grantor 3/);
  assert.equal(server.state.resultSaves.length, 1);
  assert.equal(server.state.resultSaves[0].status, 'complete');
});

test('truncation control: a non-truncation API error on a multi-file batch is not split into more paid calls', async () => {
  const geminiCalls = [];
  const server = makeJobServer({
    hooks: {
      ...browserOnlyStorage,
      'POST /api/analyze': async (_server, options) => {
        const body = JSON.parse(options.body);
        if (body.ping) return undefined;
        geminiCalls.push(body.model);
        return jsonResponse(400, { error: 'Unsupported document content.' });
      },
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed-1.png', 'a'.repeat(40)), pngFile('deed-2.png', 'b'.repeat(40))]);
  await app.run('analyze()');
  await tick(30);

  assert.equal(geminiCalls.length, 1, 'a rejected batch is not re-sent as halves');
  assert.deepEqual(server.state.resultSaves, []);
  assert.match(errorText(app), /Unsupported document content/);
});

test('truncation control: an end_turn browser synthesis is saved complete', async () => {
  const { hooks } = truncatingAnalyze(() => false);
  const server = makeJobServer({ hooks });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'x'.repeat(50))]);
  await app.run('analyze()');
  await tick(30);

  assert.equal(server.state.resultSaves.length, 1);
  assert.equal(server.state.resultSaves[0].status, 'complete');
});

// Finding 3: a failed status read is not proof that durable work stopped.

const serverOpinion = app => [...app.run("conversationHistory.map(m => m.kind + ':' + m.content + ':' + m.sourceJobId)")];
const failOnce = (path, readNumber = 2) => {
  let reads = 0;
  return { [`GET ${path}`]: async () => (++reads === readNumber ? jsonResponse(502, { error: 'Bad gateway' }) : undefined) };
};
const alwaysFail = path => ({ [`GET ${path}`]: async () => jsonResponse(502, { error: 'Bad gateway' }) });
const failStart = path => ({ [`POST ${path}`]: async () => jsonResponse(502, { error: 'Bad gateway' }) });

async function runDurableAnalyze(options) {
  const server = makeJobServer(options);
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'x'.repeat(50))]);
  await app.run('analyze()');
  await tick(30);
  return { server, app };
}

test('finding 3: one failed abstraction status read keeps the durable run and starts no browser model call', async () => {
  const { server, app } = await runDurableAnalyze({
    hooks: failOnce('/api/jobs/job_1/abstraction/status'),
    abstractionReadyAfter: 1,
    synthesisReadyAfter: 1,
  });
  assert.deepEqual(server.analyze, [], 'no browser model call');
  assert.deepEqual(server.state.resultSaves, [], 'browser must not save its own result');
  assert.deepEqual(serverOpinion(app), ['analysis-input:' + serverOpinion(app)[0].slice('analysis-input:'.length), 'title-opinion:SERVER OPINION:job_1']);
});

test('finding 3: one failed synthesis status read does not start a second browser merge', async () => {
  const { server, app } = await runDurableAnalyze({
    hooks: failOnce('/api/jobs/job_1/synthesis/status'),
    abstractionReadyAfter: 1,
    synthesisReadyAfter: 2,
  });
  assert.deepEqual(server.analyze, [], 'no browser model call');
  assert.deepEqual(server.state.resultSaves, []);
  assert.ok(serverOpinion(app).includes('title-opinion:SERVER OPINION:job_1'), 'server opinion is adopted');
});

test('finding 3: abstraction status that stays unreadable ends with a visible error and no browser billing', async () => {
  const { server, app } = await runDurableAnalyze({ hooks: alwaysFail('/api/jobs/job_1/abstraction/status') });
  assert.deepEqual(server.analyze, []);
  assert.deepEqual(server.state.resultSaves, []);
  assert.match(errorText(app), /job_1/);
  assert.match(errorText(app), /no browser analysis was started/i);
});

test('finding 3: synthesis status that stays unreadable ends with a visible error and no browser merge', async () => {
  const { server, app } = await runDurableAnalyze({ hooks: alwaysFail('/api/jobs/job_1/synthesis/status'), abstractionReadyAfter: 1 });
  assert.deepEqual(server.analyze, []);
  assert.deepEqual(server.state.resultSaves, []);
  assert.match(errorText(app), /job_1/);
  assert.match(errorText(app), /no browser analysis was started/i);
});

const failStartOnce = path => {
  let posts = 0;
  return { [`POST ${path}`]: async () => (++posts === 1 ? jsonResponse(502, { error: 'Bad gateway' }) : undefined) };
};

test('finding 3: one transient abstraction start failure is retried so the durable job is not stranded', async () => {
  const { server, app } = await runDurableAnalyze({
    hooks: failStartOnce('/api/jobs/job_1/abstraction/start'),
    abstractionReadyAfter: 1,
    synthesisReadyAfter: 1,
  });
  assert.equal(server.calls.filter(c => c === 'POST /api/jobs/job_1/abstraction/start').length, 2, 'start retried once');
  assert.deepEqual(server.analyze, [], 'no browser model call');
  assert.ok(serverOpinion(app).includes('title-opinion:SERVER OPINION:job_1'), 'server opinion is adopted');
});

test('finding 3: one transient synthesis start failure is retried so the durable job is not stranded', async () => {
  const { server, app } = await runDurableAnalyze({
    hooks: failStartOnce('/api/jobs/job_1/synthesis/start'),
    abstractionReadyAfter: 1,
    synthesisReadyAfter: 1,
  });
  assert.equal(server.calls.filter(c => c === 'POST /api/jobs/job_1/synthesis/start').length, 2, 'start retried once');
  assert.deepEqual(server.analyze, [], 'no browser merge');
  assert.ok(serverOpinion(app).includes('title-opinion:SERVER OPINION:job_1'), 'server opinion is adopted');
});

test('finding 3: a definite 4xx start rejection is not retried', async () => {
  let posts = 0;
  const { server } = await runDurableAnalyze({
    hooks: { 'POST /api/jobs/job_1/abstraction/start': async () => { posts++; return jsonResponse(409, { error: 'Uploads must be finalized.' }); } },
  });
  assert.equal(posts, 1);
  assert.deepEqual(server.analyze, []);
});

test('finding 3: an ambiguous abstraction start failure does not start browser abstraction', async () => {
  const { server, app } = await runDurableAnalyze({ hooks: failStart('/api/jobs/job_1/abstraction/start') });
  assert.deepEqual(server.analyze, []);
  assert.match(errorText(app), /no browser analysis was started/i);
});

test('finding 3: an ambiguous synthesis start failure does not start a browser merge', async () => {
  const { server, app } = await runDurableAnalyze({ hooks: failStart('/api/jobs/job_1/synthesis/start'), abstractionReadyAfter: 1 });
  assert.deepEqual(server.analyze, []);
  assert.deepEqual(server.state.resultSaves, []);
  assert.match(errorText(app), /no browser analysis was started/i);
});

test('finding 3: an unreadable final result after server synthesis finished does not rebill a browser merge', async () => {
  const { server } = await runDurableAnalyze({
    hooks: alwaysFail('/api/jobs/job_1/result'),
    abstractionReadyAfter: 1,
    synthesisReadyAfter: 1,
  });
  assert.deepEqual(server.analyze, []);
  assert.deepEqual(server.state.resultSaves, []);
});

test('finding 3: analyzeAdditional keeps the durable run through one failed abstraction status read', async () => {
  const server = makeJobServer({ hooks: failOnce('/api/jobs/job_1/abstraction/status'), abstractionReadyAfter: 1 });
  const app = loadIndex({ fetchImpl: server.fetch });
  app.run("documentAbstracts = [{ filename: 'old.png', sourceFilename: 'old.png', abstract: 'OLD FACTS' }]");
  await app.ctx.handleAdditionalFiles([pngFile('new.png', 'y'.repeat(50))]);
  await app.run('analyzeAdditional()');
  await tick(30);
  assert.deepEqual(server.analyze.filter(c => c.model.startsWith('gemini')), [], 'no browser abstraction call');
});

test('finding 3: analyzeAdditional does not start a browser merge after one failed synthesis status read', async () => {
  const server = makeJobServer({ hooks: failOnce('/api/jobs/job_1/synthesis/status'), abstractionReadyAfter: 1, synthesisReadyAfter: 2 });
  const app = loadIndex({ fetchImpl: server.fetch });
  app.run("activeJobId = 'job_0'; documentAbstracts = [{ filename: 'old.png', sourceFilename: 'old.png', abstract: 'OLD FACTS' }]");
  await app.ctx.handleAdditionalFiles([pngFile('new.png', 'y'.repeat(50))]);
  await app.run('analyzeAdditional()');
  await tick(30);
  assert.deepEqual(server.analyze, [], 'no browser model call');
  assert.ok(serverOpinion(app).includes('title-opinion:SERVER OPINION:job_1'));
});

test('finding 3 control: server setup unavailable (503 with fallback hint) still runs browser abstraction', async () => {
  const { server } = await runDurableAnalyze({
    hooks: { 'POST /api/jobs/job_1/abstraction/start': async () => jsonResponse(503, { error: 'Queue not configured', fallback: 'browser_abstraction' }) },
    analyzeReply: geminiOrSonnetReply('DOCUMENT #1:\nGRANTOR: Alice\n'),
  });
  assert.equal(server.analyze.filter(c => c.model.startsWith('gemini')).length, 1);
  assert.equal(server.state.resultSaves[0]?.synthesisDriver, 'browser');
});

test('finding 3 control: synthesis setup unavailable (503 with fallback hint) still runs browser synthesis', async () => {
  const { server } = await runDurableAnalyze({
    hooks: { 'POST /api/jobs/job_1/synthesis/start': async () => jsonResponse(503, { error: 'Synthesis not configured', fallback: 'browser_synthesis' }) },
    abstractionReadyAfter: 1,
  });
  assert.equal(server.analyze.filter(isSynthesisCall).length, 1);
  assert.equal(server.state.resultSaves[0]?.synthesisDriver, 'browser');
});

test('finding 3 control: storage unavailable before durable work keeps explicit browser-only operation', async () => {
  const server = makeJobServer({ hooks: browserOnlyStorage, analyzeReply: geminiOrSonnetReply('DOCUMENT #1:\nGRANTOR: Alice\n') });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('deed.png', 'x'.repeat(50))]);
  await app.run('analyze()');
  await tick(30);
  assert.equal(server.calls.filter(c => c.includes('/abstraction/') || c.includes('/synthesis/')).length, 0, 'no durable workflow route touched');
  assert.equal(server.analyze.length, 2);
  assert.equal(server.state.resultSaves[0].synthesisDriver, 'browser');
  assert.match(errorText(app), /Continuing with browser-only analysis/);
});

// Finding 10: reopening Add More Documents must not multiply selected files.

async function selectOneAdditionalFileAfterOpening(openCount, via) {
  const jobPosts = [];
  const fetchImpl = async (url, options = {}) => {
    if (url === '/api/jobs' && options.method === 'POST') {
      jobPosts.push(JSON.parse(options.body));
      return jsonResponse(500, { error: 'stop here' });
    }
    return jsonResponse(404, {});
  };
  const app = loadIndex({ fetchImpl });
  for (let i = 0; i < openCount; i++) {
    app.run('showAddDocs()');
    if (i < openCount - 1) app.run('hideAddDocs()');
  }
  const file = pngFile('deed-A.png');
  if (via === 'picker') {
    const input = app.getEl('fileInput2');
    input.files = [file];
    await input.dispatch('change');
  } else {
    await app.getEl('uploadZone2').dispatch('drop', { dataTransfer: { files: [file] } });
  }
  await tick(20);
  const names = [...app.run('additionalFiles.map(f => f.name)')];
  await app.run('analyzeAdditional()');
  return { names, postedTotal: jobPosts[0]?.totalDocuments };
}

for (const openCount of [1, 2, 3]) {
  for (const via of ['picker', 'drop']) {
    test(`finding 10: ${via} selection after opening Add More Documents ${openCount} time(s) adds the file once`, async () => {
      const { names, postedTotal } = await selectOneAdditionalFileAfterOpening(openCount, via);
      assert.deepEqual(names, ['deed-A.png']);
      assert.equal(postedTotal, 1);
    });
  }
}

// Finding 11: the job-view follow-up must not send twice while a request is in flight.

function openJobFollowup(followupResponses) {
  const questions = [];
  const gates = [];
  const fetchImpl = async (url, options = {}) => {
    if (!url.endsWith('/followup')) return jsonResponse(404, {});
    questions.push(JSON.parse(options.body).question);
    const gate = new Promise(resolve => gates.push(resolve));
    await gate;
    return followupResponses.shift()();
  };
  const app = loadIndex({ fetchImpl });
  app.run("renderJobResults({ id: 'job_1' }, { finalTitleOpinion: '## OPINION', warnings: [], failedDocuments: [] })");
  const input = app.getEl('jobFollowupInput');
  const button = app.getEl('jobFollowupBtn');
  const history = () => app.run("(jobFollowupHistoryByJob.get('job_1') || []).map(p => p.question + '=>' + p.answer)");
  return { app, input, button, questions, gates, history };
}
const answered = text => () => jsonResponse(200, { followup: { answer: text } });

test('finding 11: pressing Enter twice before the answer sends one follow-up and stores one turn', async () => {
  const { input, questions, gates, history } = openJobFollowup([answered('A1')]);
  input.value = 'Who owns the minerals?';
  input.onkeydown({ key: 'Enter' });
  await tick(5);
  input.onkeydown({ key: 'Enter' });
  await tick(5);
  gates.forEach(release => release());
  await tick(30);

  assert.deepEqual(questions, ['Who owns the minerals?']);
  assert.deepEqual([...history()], ['Who owns the minerals?=>A1']);
});

test('finding 11: Enter then the Ask button before the answer sends one follow-up', async () => {
  const { input, button, questions, gates, history } = openJobFollowup([answered('A1')]);
  input.value = 'Who owns the minerals?';
  input.onkeydown({ key: 'Enter' });
  await tick(5);
  button.onclick();
  await tick(5);
  gates.forEach(release => release());
  await tick(30);

  assert.deepEqual(questions, ['Who owns the minerals?']);
  assert.equal(history().length, 1);
});

test('finding 11 control: a second question after the first answer is sent normally', async () => {
  const { app, questions, gates, history } = openJobFollowup([answered('A1'), answered('A2')]);
  app.getEl('jobFollowupInput').value = 'Q1';
  app.getEl('jobFollowupInput').onkeydown({ key: 'Enter' });
  await tick(5);
  gates.shift()();
  await tick(30);
  app.getEl('jobFollowupInput').value = 'Q2';
  app.getEl('jobFollowupInput').onkeydown({ key: 'Enter' });
  await tick(5);
  gates.shift()();
  await tick(30);

  assert.deepEqual(questions, ['Q1', 'Q2']);
  assert.deepEqual([...history()], ['Q1=>A1', 'Q2=>A2']);
});

test('finding 11 control: a failed follow-up releases the lock so the question can be retried', async () => {
  const { app, questions, gates, history } = openJobFollowup([() => jsonResponse(500, { error: 'boom' }), answered('A1')]);
  app.getEl('jobFollowupInput').value = 'Q1';
  app.getEl('jobFollowupInput').onkeydown({ key: 'Enter' });
  await tick(5);
  gates.shift()();
  await tick(30);
  assert.equal(history().length, 0);
  app.getEl('jobFollowupInput').onkeydown({ key: 'Enter' });
  await tick(5);
  gates.shift()();
  await tick(30);

  assert.deepEqual(questions, ['Q1', 'Q1']);
  assert.deepEqual([...history()], ['Q1=>A1']);
});

// Finding 12: home follow-ups asked back to back must keep question and answer pairs together.

function openHomeFollowup({ failQuestions = [] } = {}) {
  const requests = [];
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const fetchImpl = async (url, options = {}) => {
    if (url !== '/api/analyze') return jsonResponse(404, {});
    const content = JSON.parse(options.body).messages[0].content;
    const question = content.split('## Follow-up Question\n\n').pop();
    requests.push({ question, content });
    if (question.endsWith('slow')) await slowGate;
    if (failQuestions.includes(question)) return jsonResponse(500, { error: `failed ${question}` });
    return jsonResponse(200, { content: [{ type: 'text', text: `ANSWER-TO-${question.split(' ')[0]}` }] });
  };
  const app = loadIndex({ fetchImpl });
  app.run("conversationHistory = [{ role: 'user', content: 'x', displayText: 'Analyzed 1', kind: 'analysis-input' }, { role: 'assistant', content: 'OPINION', kind: 'title-opinion', sourceJobId: null }]");
  const ask = question => {
    app.getEl('followupInput').value = question;
    return app.run('askFollowup()');
  };
  const rendered = () => [...app.getEl('results').innerHTML.replace(/\s+/g, ' ').matchAll(/Q: (Q\d)|(ANSWER-TO-Q\d)/g)].map(m => m[1] || m[2]);
  const turns = () => [...app.run("conversationHistory.slice(2).map(m => m.role + ':' + m.content)")];
  return { app, requests, releaseSlow, ask, rendered, turns };
}

test('finding 12: a slow first follow-up and a fast second one render as Q1, A1, Q2, A2', async () => {
  const { requests, releaseSlow, ask, rendered, turns } = openHomeFollowup();
  const first = ask('Q1 slow');
  const second = ask('Q2 fast');
  await tick(30);
  releaseSlow();
  await Promise.all([first, second]);

  assert.deepEqual(rendered(), ['Q1', 'ANSWER-TO-Q1', 'Q2', 'ANSWER-TO-Q2']);
  assert.deepEqual(turns(), ['user:Q1 slow', 'assistant:ANSWER-TO-Q1', 'user:Q2 fast', 'assistant:ANSWER-TO-Q2']);
  assert.equal(requests.length, 2);
});

test('finding 12: the second follow-up request carries the first completed turn as context', async () => {
  const { requests, releaseSlow, ask } = openHomeFollowup();
  const first = ask('Q1 slow');
  const second = ask('Q2 fast');
  await tick(30);
  releaseSlow();
  await Promise.all([first, second]);

  const q2 = requests.find(r => r.question === 'Q2 fast');
  assert.match(q2.content, /User: Q1 slow\n\nAssistant: ANSWER-TO-Q1/);
});

test('finding 12: a failed first follow-up removes only its own question and leaves the second turn intact', async () => {
  const { app, releaseSlow, ask, rendered, turns } = openHomeFollowup({ failQuestions: ['Q1 slow'] });
  const first = ask('Q1 slow');
  const second = ask('Q2 fast');
  await tick(30);
  releaseSlow();
  await Promise.all([first, second]);

  assert.deepEqual(turns(), ['user:Q2 fast', 'assistant:ANSWER-TO-Q2']);
  // Round 2 (R06): the failed question is kept as an inline Ask again card after the conversation, not lost.
  assert.deepEqual(rendered(), ['Q2', 'ANSWER-TO-Q2', 'Q1']);
  const html = app.getEl('results').innerHTML;
  assert.equal((html.match(/data-followup-retry=/g) || []).length, 1);
  assert.match(html, /Q: Q1 slow[\s\S]*The answer could not be loaded/);
});

test('finding 12: an answer that arrives after Start New Job is not published into the reset page', async () => {
  const { app, releaseSlow, ask, turns } = openHomeFollowup();
  const pending = ask('Q1 slow');
  await tick(30);
  app.run('resetHomeForNewJob()');
  releaseSlow();
  await pending;

  assert.deepEqual(turns(), []);
  assert.equal(app.getEl('results').innerHTML.trim(), '');
});

test('finding 12 control: one follow-up renders its question then its answer', async () => {
  const { ask, rendered, turns } = openHomeFollowup();
  await ask('Q1 only');
  assert.deepEqual(rendered(), ['Q1', 'ANSWER-TO-Q1']);
  assert.deepEqual(turns(), ['user:Q1 only', 'assistant:ANSWER-TO-Q1']);
});

function makePdfFile(name, extraBytes = 0) {
  const head = Buffer.from('%PDF-1.4\n');
  const tail = Buffer.from('\n%%EOF\n');
  const buf = extraBytes > 0 ? Buffer.concat([head, Buffer.alloc(extraBytes, 65), tail]) : Buffer.concat([head, tail]);
  return new File([buf], name, { type: 'application/pdf' });
}

const hasVisualBlock = body =>
  Array.isArray(body?.messages?.[0]?.content) &&
  body.messages[0].content.some(block => block?.type === 'document' || block?.type === 'image');

const parseBlocks = call => (call.content.startsWith('[') ? JSON.parse(call.content) : null);

test('priority 6: browser callAbstractionWithEscalation escalates once to claude-sonnet-5-5 on ILLEGIBLE marker', async () => {
  const server = makeJobServer({
    hooks: browserOnlyStorage,
    analyzeReply: body => {
      if (body.model.startsWith('gemini')) return 'Instrument: Warranty Deed\nDate: [ILLEGIBLE - VERIFY MANUALLY]';
      if (hasVisualBlock(body)) return 'Instrument: Warranty Deed\nDate: 1991-05-10\nGrantee: Alice.';
      return '## FINAL OWNERSHIP DETERMINATION\nAlice owns 100%.';
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  await app.ctx.handleFiles([pngFile('illegible.png')]);
  await app.run('analyze()');
  await tick(30);

  assert.equal(server.analyze.length, 3);
  assert.equal(server.analyze[0].model.startsWith('gemini'), true);
  assert.equal(server.analyze[1].model, 'claude-sonnet-5-5');
  assert.equal(Array.isArray(parseBlocks(server.analyze[1])), true);
  assert.equal(server.analyze[2].model, 'claude-sonnet-5-5');
  assert.equal(parseBlocks(server.analyze[2]), null);
  assert.equal(app.getEl('highDpiRereadBar').innerHTML, '');
});

test('priority 6: staging a 15+ page PDF shows multi-instrument split hint in #intakeSummary', async () => {
  const server = makeJobServer({ hooks: browserOnlyStorage });
  const app = loadIndex({ fetchImpl: server.fetch });
  app.ctx.PDFLib = { PDFDocument: { load: async () => ({ getPageCount: () => 18 }) } };
  await app.ctx.handleFiles([makePdfFile('long-bundle.pdf')]);

  const html = app.getEl('intakeSummary').innerHTML;
  assert.match(html, /18 pages/i);
  assert.match(html, /split|separate|instrument/i);
  assert.doesNotMatch(html, /\b(batch|synthesis|adaptive|claude)\b/i);
});

test('priority 7: fast default raw PDF run sends document block and never invokes PDF rasterizer', async () => {
  const server = makeJobServer({
    hooks: browserOnlyStorage,
    analyzeReply: geminiOrSonnetReply('Instrument: Mineral Deed\nGrantor: Bob\nGrantee: Alice.'),
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  let rasterCalls = 0;
  app.ctx.__TITLE_ANALYZER_PDF_RASTER__ = {
    prepareDocument: async () => {
      rasterCalls++;
      return [];
    },
  };
  app.ctx.PDFLib = { PDFDocument: { load: async () => ({ getPageCount: () => 2 }) } };

  await app.ctx.handleFiles([makePdfFile('fast-deed.pdf')]);
  await app.run('analyze()');
  await tick(30);

  assert.equal(rasterCalls, 0);
  const geminiCall = server.analyze.find(call => call.model.startsWith('gemini'));
  assert.ok(geminiCall);
  const blocks = parseBlocks(geminiCall);
  assert.equal(Array.isArray(blocks), true);
  assert.equal(blocks.some(b => b.type === 'document'), true);
  assert.equal(blocks.some(b => b.type === 'image'), false);
  assert.equal(app.getEl('highDpiRereadBar').innerHTML, '');
});

test('priority 7: flagged PDF reveals #highDpiRereadBar and selective reread renders only flagged PDF as images', async () => {
  let synthesisPass = 0;
  const server = makeJobServer({
    hooks: browserOnlyStorage,
    analyzeReply: body => {
      if (hasVisualBlock(body)) {
        const content = body.messages[0].content;
        if (content.some(b => b.type === 'document')) {
          return 'Instrument: Oil Lease\nRecording: [ILLEGIBLE - VERIFY MANUALLY]';
        }
        const images = content.filter(b => b.type === 'image');
        if (images.length >= 2) {
          return 'Instrument: Oil Lease\nRecording: Vol. 42, Page 109 (High-DPI Clear).';
        }
        return 'Instrument: Assignment\nClean PNG abstract to Alice.';
      }
      synthesisPass++;
      const text = typeof body.messages[0].content === 'string'
        ? body.messages[0].content
        : body.messages[0].content.map(b => b.text || '').join('\n');
      assert.match(text, /Clean PNG abstract to Alice/);
      return synthesisPass === 1
        ? '## FINAL OWNERSHIP DETERMINATION\nInitial uncertain lease.'
        : '## FINAL OWNERSHIP DETERMINATION\nUpdated Carol Vol. 42, Page 109.';
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  const rasterizedNames = [];
  app.ctx.__TITLE_ANALYZER_PDF_RASTER__ = {
    prepareDocument: async file => {
      rasterizedNames.push(file.name);
      return [
        { mediaType: 'image/png', data: Buffer.from('page-1-png').toString('base64') },
        { mediaType: 'image/png', data: Buffer.from('page-2-png').toString('base64') },
      ];
    },
  };
  app.ctx.PDFLib = { PDFDocument: { load: async () => ({ getPageCount: () => 2 }) } };

  const flaggedPdf = makePdfFile('flagged.pdf', 700_000);
  const cleanPng = pngFile('clean.png');
  await app.ctx.handleFiles([flaggedPdf, cleanPng]);
  await app.run('analyze()');
  await tick(30);

  assert.deepEqual(rasterizedNames, []);
  const callsBeforeReread = server.analyze.length;
  assert.equal(callsBeforeReread, 4);
  assert.match(app.getEl('highDpiRereadBar').innerHTML, /Re-read as high-DPI page images/);

  await app.ctx.rereadFlaggedPdfsAsHighDpi();

  assert.deepEqual(rasterizedNames, ['flagged.pdf']);
  const newCalls = server.analyze.slice(callsBeforeReread);
  assert.equal(newCalls.length, 2);
  assert.equal(newCalls[0].model.startsWith('gemini'), true);
  const rereadBlocks = parseBlocks(newCalls[0]);
  assert.equal(rereadBlocks.some(b => b.type === 'document'), false);
  assert.equal(rereadBlocks.filter(b => b.type === 'image').length, 2);
  assert.equal(newCalls[1].model, 'claude-sonnet-5-5');
  assert.match(newCalls[1].content, /Clean PNG abstract to Alice/);
  assert.match(newCalls[1].content, /Vol\. 42, Page 109/);
  assert.equal(app.getEl('highDpiRereadBar').innerHTML, '');
  assert.match(app.getEl('results').innerHTML, /Updated Carol Vol\. 42, Page 109/);
});

test('priority 7: raw PDF failure renders #highDpiRetryBtn and retry skips GCS upload and completes with images', async () => {
  let blobAvailable = false;
  let postUploadAttempts = 0;
  const server = makeJobServer({
    hooks: {
      'GET /api/blob/upload': async () => jsonResponse(200, { available: blobAvailable }),
      'POST /api/blob/upload': async () => {
        postUploadAttempts++;
        return jsonResponse(500, { error: 'should not upload during high-DPI retry' });
      },
      'POST /api/analyze': async (_server, options) => {
        const body = JSON.parse(options.body || '{}');
        if (body.ping) return undefined;
        if (hasVisualBlock(body) && body.messages[0].content.some(b => b?.type === 'document')) {
          return jsonResponse(400, { error: 'Could not read scanned PDF' });
        }
        return undefined;
      },
    },
    analyzeReply: body => {
      if (hasVisualBlock(body)) return 'Instrument: Mineral Deed\nRecovered via high-DPI images.';
      return '## FINAL OWNERSHIP DETERMINATION\nRecovered Alice.';
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  const rasterizedNames = [];
  app.ctx.__TITLE_ANALYZER_PDF_RASTER__ = {
    prepareDocument: async file => {
      rasterizedNames.push(file.name);
      return [{ mediaType: 'image/png', data: Buffer.from('recovered-page-1').toString('base64') }];
    },
  };
  app.ctx.PDFLib = { PDFDocument: { load: async () => ({ getPageCount: () => 1 }) } };

  await app.ctx.handleFiles([makePdfFile('broken-scan.pdf')]);
  await app.run('analyze()');
  await tick(30);

  assert.match(app.getEl('errorBox').innerHTML, /id="highDpiRetryBtn"[^>]*>Re-read as high-DPI page images/);

  blobAvailable = true;
  await app.ctx.retryFailedWithHighDpiImages();
  await tick(30);

  assert.equal(postUploadAttempts, 0);
  assert.equal(server.calls.includes('POST /api/blob/upload'), false);
  assert.deepEqual(rasterizedNames, ['broken-scan.pdf']);
  const imageCall = server.analyze.find(c => {
    const blocks = parseBlocks(c);
    return Array.isArray(blocks) && blocks.some(b => b.type === 'image') && !blocks.some(b => b.type === 'document');
  });
  assert.ok(imageCall);
  assert.match(app.getEl('results').innerHTML, /Recovered Alice/);
});

test('priority 6/7: secondary-field ILLEGIBLE markers, CSVs, and opinion prose do not false-positive escalate or show high-DPI reread', async () => {
  const secondaryOnlyAbstract = [
    'DOC TYPE: Warranty Deed',
    'DATE EXECUTED: April 7, 1923',
    'DATE RECORDED: unrecorded',
    'RECORDING REF: unrecorded',
    'GRANTOR: Ada Owner',
    'GRANTEE: Bea Buyer',
    'LEGAL DESC: NW/4 of Section 12, Block C-9',
    'SURFACE: ILLEGIBLE - VERIFY MANUALLY',
    'MINERALS: yes - 1/2',
    'ROYALTY/NPRI: no',
    'TERM: ILLEGIBLE - VERIFY MANUALLY',
    'AFTER-ACQUIRED TITLE: ILLEGIBLE - VERIFY MANUALLY',
    'FRACTION CONVEYED: an undivided 1/2 mineral interest',
    'RESERVATIONS: none stated',
    'WARRANTY: ILLEGIBLE - VERIFY MANUALLY',
    'ACKNOWLEDGMENT: ILLEGIBLE - VERIFY MANUALLY',
    'ISSUES: Notary seal is ILLEGIBLE - VERIFY MANUALLY',
    'CONFIDENCE: High confidence across key identity fields.',
  ].join('\n');

  const server = makeJobServer({
    hooks: browserOnlyStorage,
    analyzeReply: body => {
      if (hasVisualBlock(body)) return secondaryOnlyAbstract;
      return '## FINAL OWNERSHIP DETERMINATION\nNo illegible key fields found. Bea Buyer owns 1/2 minerals.';
    },
  });
  const app = loadIndex({ fetchImpl: server.fetch });
  app.ctx.PDFLib = { PDFDocument: { load: async () => ({ getPageCount: () => 2 }) } };

  await app.ctx.handleFiles([makePdfFile('secondary-only.pdf')]);
  await app.run('analyze()');
  await tick(30);

  // Only 1 Gemini abstraction + 1 Sonnet synthesis; no Sonnet escalation call.
  assert.equal(server.analyze.length, 2);
  assert.equal(server.analyze[0].model.startsWith('gemini'), true);
  assert.equal(server.analyze[1].model, 'claude-sonnet-5-5');
  assert.equal(parseBlocks(server.analyze[1]), null);
  assert.equal(app.getEl('highDpiRereadBar').innerHTML, '');

  // Key-field ILLEGIBLE still triggers both escalation and high-DPI candidate detection.
  const keyFieldAbstract = secondaryOnlyAbstract.replace('GRANTOR: Ada Owner', 'GRANTOR: ILLEGIBLE - VERIFY MANUALLY');
  assert.equal(app.ctx.shouldEscalateAbstractText(secondaryOnlyAbstract), false);
  assert.equal(app.ctx.shouldEscalateAbstractText(keyFieldAbstract), true);
  assert.equal(app.ctx.shouldEscalateAbstractText(keyFieldAbstract, { isCsv: true }), false);

  // jobHasHighDpiCandidates must not match prose like "No illegible fields" and must honor clean cached abstracts.
  app.ctx.__testPdf = makePdfFile('clean-job.pdf');
  app.ctx.__testCleanAbstract = secondaryOnlyAbstract;
  app.run(`
    sessionSourceFilesByJob.set('job_prose', [__testPdf]);
    rdLatestJob.jobId = 'job_prose';
    rdLatestJob.result = { finalTitleOpinion: 'All instruments are clear; no illegible entries noted.' };
  `);
  assert.equal(app.ctx.jobHasHighDpiCandidates({ id: 'job_prose', status: 'completed' }), false);

  app.run(`rdLatestJob.result = { finalTitleOpinion: '| #1 | Deed | Vol 1 Pg 2 | ILLEGIBLE |' };`);
  assert.equal(app.ctx.jobHasHighDpiCandidates({ id: 'job_prose', status: 'completed' }), true);

  // Cached clean abstracts take precedence over opinion text.
  app.run(`sessionAbstractsByJob.set('job_prose', [{ filename: 'clean-job.pdf', abstract: __testCleanAbstract }]);`);
  assert.equal(app.ctx.jobHasHighDpiCandidates({ id: 'job_prose', status: 'completed' }), false);
});

let failed = 0;
for (const { name, fn } of tests) {
  try {
    await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(new Error('test timed out after 10s')), 10_000).unref())]);
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
  } finally {
    disposeAll();
  }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
