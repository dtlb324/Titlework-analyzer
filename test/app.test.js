import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import handler from '../api/analyze.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const indexHtml = readFileSync(join(root, 'public/index.html'), 'utf8');
const scriptStart = indexHtml.lastIndexOf('<script>\nconst MAX_FILES');
const script = indexHtml.slice(scriptStart + 8, indexHtml.indexOf('</script>', scriptStart));

function mockReq(body, headers = {}) {
  return {
    method: 'POST',
    body,
    headers: { 'x-forwarded-for': '203.0.113.99', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; },
  };
  return res;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('index.html JavaScript parses', () => {
  const tmp = join(root, '.tmp-index-script.js');
  writeFileSync(tmp, script);
  const result = spawnSync('node', ['--check', tmp], { encoding: 'utf8' });
  unlinkSync(tmp);
  assert(result.status === 0, `Syntax error: ${result.stderr}`);
});

test('uses Haiku for abstraction and Sonnet for synthesis', () => {
  assert(script.includes("ABSTRACT_MODEL = 'claude-haiku-4-5'"), 'Expected Haiku for abstraction');
  assert(script.includes("SYNTHESIS_MODEL = 'claude-sonnet-4-6'"), 'Expected Sonnet for synthesis');
  assert(!script.includes("'claude-opus-4-7'"), 'Opus 4.7 should not be hardcoded');
});

test('uses adaptive batching and parallel abstraction', () => {
  assert(script.includes('buildAdaptiveBatches'), 'Missing adaptive batching');
  assert(script.includes('runDocumentAbstraction'), 'Missing shared abstraction runner');
  assert(script.includes('ABSTRACT_CONCURRENCY = 2'), 'Missing parallel pool');
  assert(script.includes('MAX_DOCS_PER_BATCH = 2'), 'Max docs per batch should be 2 for timeout safety');
  assert(script.includes('isTimeoutError'), 'Missing timeout error detection');
  assert(script.includes('abstractSinglePdfOnTimeout'), 'Missing timeout PDF split retry');
  assert(script.includes('batchExceedsTimeoutLimit'), 'Missing proactive timeout batch check');
  assert(script.includes('finalizeBatchesForTimeout'), 'Missing timeout batch finalizer');
  assert(script.includes('CLOUD_RUN_REQUEST_TIMEOUT_MS = 240_000'), 'Missing Cloud Run request timeout budget');
  assert(script.includes('REQUEST_ENVELOPE_SAFE_BYTES = 12_000_000'), 'Missing larger Cloud Run request envelope budget');
  assert(script.includes('CLOUD_RUN_MAX_REQUEST_BYTES'), 'Missing Cloud Run payload guard');
  assert(script.includes('buildAbstractMessages'), 'Missing abstract message builder');
  assert(!script.includes('BATCH_SIZE'), 'Fixed BATCH_SIZE should be removed');
});

test('supports 400-document bulk upload', () => {
  assert(script.includes('const MAX_FILES = 400'), 'MAX_FILES should be 400');
  assert(script.includes('hierarchicalSynthesis'), 'Missing hierarchical synthesis');
  assert(script.includes('SYNTHESIS_CHUNK_SIZE = 50'), 'Synthesis chunk size should be 50');
  assert(script.includes('acquireRequestSlot'), 'Missing request throttling');
});

test('UI copy reflects 400-file limit', () => {
  assert(indexHtml.includes('up to 400 files'), 'Upload hint should mention 400 files');
});

test('UI accepted file copy matches backend-supported image types', () => {
  assert(!indexHtml.includes('TIFF'), 'Upload hint should not advertise TIFF when backend rejects image/tiff');
  assert(indexHtml.includes('accept=".pdf,.csv,.jpg,.jpeg,.png,.gif,.webp"'), 'File input accept list should match supported image types');
});

test('API ping works without API key (health check)', async () => {
  const req = mockReq({ ping: true });
  const res = mockRes();
  await handler(req, res);
  assert(res.statusCode === 200, `Ping should succeed, got ${res.statusCode}`);
  assert(res.body?.ok === true, 'Ping body should be { ok: true }');
});

test('API ping validates APP_PASSWORD when password gate is enabled', async () => {
  const prevPassword = process.env.APP_PASSWORD;
  process.env.APP_PASSWORD = 'secret-test-password';
  const missing = mockRes();
  await handler(mockReq({ ping: true }), missing);
  const valid = mockRes();
  await handler(mockReq({ ping: true }, { 'x-app-password': 'secret-test-password' }), valid);
  if (prevPassword) process.env.APP_PASSWORD = prevPassword;
  else delete process.env.APP_PASSWORD;

  assert(missing.statusCode === 401, `Expected missing ping password to return 401, got ${missing.statusCode}`);
  assert(valid.statusCode === 200, `Expected valid ping password to return 200, got ${valid.statusCode}`);
});

test('API rejects unknown model', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  const req = mockReq({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
  });
  const res = mockRes();
  await handler(req, res);
  if (prev) process.env.ANTHROPIC_API_KEY = prev;
  else delete process.env.ANTHROPIC_API_KEY;
  assert(res.statusCode === 400, `Expected 400, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert(String(res.body?.error).includes('model'), 'Should reject unknown model');
});

test('API accepts claude-haiku-4-5 and claude-sonnet-4-6', async () => {
  const prev = process.env.ANTHROPIC_API_KEY;
  const prevFetch = global.fetch;
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key';
  global.fetch = async () => ({
    status: 200,
    json: async () => ({ content: [{ text: 'ok' }], model: 'test-model', stop_reason: 'end_turn', usage: {} }),
  });
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-6']) {
    const req = mockReq({ model, messages: [{ role: 'user', content: 'hello' }] });
    const res = mockRes();
    await handler(req, res);
    assert(res.statusCode !== 400 || !String(res.body?.error).includes('model'), `${model} should pass model validation`);
  }
  global.fetch = prevFetch;
  if (prev) process.env.ANTHROPIC_API_KEY = prev;
  else delete process.env.ANTHROPIC_API_KEY;
});

test('rate limit default allows bulk throughput', () => {
  const analyzeJs = readFileSync(join(root, 'api/analyze.js'), 'utf8');
  assert(analyzeJs.includes("process.env.ANALYZE_RATE_LIMIT_MAX || '300'"), 'Rate limit should default to 300');
});


test('auto-splits large PDFs client-side', () => {
  assert(script.includes('splitPdfIntoEntries'), 'Missing PDF split helper');
  assert(script.includes('PDF_SPLIT_RAW_THRESHOLD'), 'Missing PDF split threshold');
  assert(indexHtml.includes('pdf-lib'), 'Missing pdf-lib script');
  assert(script.includes('ingestUploadedFiles'), 'Missing shared upload ingest helper');
});


test('shows estimated processing time during runs', () => {
  assert(indexHtml.includes('id="progressEta"'), 'Missing progress ETA element');
  assert(script.includes('createProgressTimer'), 'Missing progress timer');
  assert(script.includes('formatDurationPrecise'), 'Missing precise duration formatter');
  assert(script.includes('buildProcessingPlan'), 'Missing processing plan builder');
  assert(script.includes('formatInitialEstimate'), 'Missing initial estimate formatter');
  assert(script.includes('formatEtaRemaining'), 'Missing ETA formatter');
});


test('proactively splits batches before timeout', () => {
  assert(script.includes('CLOUD_RUN_REQUEST_TIMEOUT_MS = 240_000'), 'Missing Cloud Run timeout budget');
  assert(script.includes('batchExceedsTimeoutLimit'), 'Missing proactive timeout batch check');
  assert(script.includes('finalizeBatchesForTimeout'), 'Missing timeout batch finalizer');
  assert(script.includes('abstractSinglePdfOnTimeout'), 'Missing single-PDF timeout split');
});

test('preserves PDF data for retries via sourceFile', () => {
  assert(script.includes('sourceFile: file'), 'Should retain original File object on upload');
  assert(script.includes('async function ensureFileData'), 'Should re-read file data before API calls');
  assert(script.includes('async function readSourceFile'), 'Should have readSourceFile helper');
  assert(!script.includes('batchFiles.forEach(freeFileMemory)'), 'Should not free memory after each batch');
  assert(script.includes('files.forEach(freeFileMemory)'), 'Should free memory only after successful run');
});

test('registers job-linked durable uploads before browser-driven analysis', () => {
  assert(script.includes('async function getDurableStorageStatus'), 'Missing durable storage availability check');
  assert(script.includes('async function registerJobUploads'), 'Missing job-linked upload registration helper');
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}/documents'), 'Missing document registration endpoint call');
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}/documents/${encodeURIComponent(documentId)}/chunks'), 'Missing chunk registration endpoint call');
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}/chunks/${encodeURIComponent(chunkId)}'), 'Missing chunk upload status patch endpoint call');
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}/finalize-uploads'), 'Missing finalize uploads endpoint call');
  assert(script.includes("durableJsonFetch('/api/blob/upload'"), 'Missing signed GCS upload request');
  assert(script.includes('fetch(upload.uploadUrl'), 'Missing direct browser-to-GCS upload call');
  assert(script.includes('Durable file resume unavailable'), 'Missing graceful fallback warning copy');
});


// === Phase 6 ===

test('Phase 6: HTML defines view-home, view-job, view-history shells', () => {
  assert(indexHtml.includes('id="view-home"'), 'Missing #view-home wrapper');
  assert(indexHtml.includes('id="view-job"'), 'Missing #view-job wrapper');
  assert(indexHtml.includes('id="view-history"'), 'Missing #view-history wrapper');
});

test('Phase 6: hash router exposes parseHash and navigate', () => {
  assert(script.includes('function parseRoute'), 'Missing parseRoute() helper');
  assert(script.includes('function applyRoute'), 'Missing applyRoute() helper');
  assert(script.includes("window.addEventListener('hashchange'"), 'Router must listen for hashchange');
  assert(script.includes("'#/job/'") || script.includes('`#/job/'), 'Router must emit #/job/ links');
});

test('Phase 6: getJobLink emits hash route, getRequestedJobId reads it', () => {
  assert(script.includes('`${window.location.origin}${window.location.pathname}#/job/'),
    'getJobLink must emit hash route');
  assert(script.includes("hash.startsWith('#/job/')") || script.includes("startsWith('/job/')"),
    'getRequestedJobId must parse #/job/{id}');
});

test('Phase 6: #view-job contains required job page subsections', () => {
  assert(indexHtml.includes('id="jobHeader"'), 'Missing #jobHeader');
  assert(indexHtml.includes('id="jobProgress"'), 'Missing #jobProgress');
  assert(indexHtml.includes('id="jobStepper"'), 'Missing #jobStepper');
  assert(indexHtml.includes('id="jobDetail"'), 'Missing #jobDetail');
  assert(indexHtml.includes('id="jobActions"'), 'Missing #jobActions');
  assert(indexHtml.includes('id="jobResults"'), 'Missing #jobResults');
});

test('Phase 6: job stepper replaces close-tab banner above progress', () => {
  const headerIdx = indexHtml.indexOf('id="jobHeader"');
  const stepperIdx = indexHtml.indexOf('id="jobStepper"');
  const progressIdx = indexHtml.indexOf('id="jobProgress"');
  assert(headerIdx >= 0 && stepperIdx > headerIdx && progressIdx > stepperIdx,
    'Job stepper should render between the job header and progress card');
  assert(!indexHtml.includes('You can close this tab. Reopen this link to check progress.'),
    'Close-tab progress banner copy should be removed');
  assert(!indexHtml.includes('id="jobLeaveBanner"'),
    'Job leave banner should be removed from the job view');
  assert(!script.includes('jobLeaveBanner'),
    'Progress renderer should not toggle the removed job leave banner');
  assert(indexHtml.includes('#jobHeader { margin-bottom:.45rem; }'),
    'Job header should have a tight banner-specific bottom margin above the stepper');
  assert(indexHtml.includes('.job-stepper {') &&
         indexHtml.includes('margin:0 0 1rem'),
    'Job stepper should sit immediately below the job banner');
});

test('Phase 6: job header offers a clear start-new-job action', () => {
  assert(script.includes('id="jobStartNewBtn"'), 'Missing Start New Job button in job header');
  assert(script.includes('Start New Job'), 'Job header should label the new-job action clearly');
  assert(script.includes('class="btn-secondary" id="jobStartNewBtn"'),
    'Start New Job should use the smaller secondary button style');
  assert(script.includes("navigate('#/')") || script.includes('navigate("#/")'),
    'Start New Job action should navigate back to the home route');
});

test('Phase 6: completed job header downloads PDF instead of copying links', () => {
  assert(script.includes('id="jobDownloadPdfBtn"'), 'Missing durable job Download PDF button');
  assert(script.includes('Download PDF'), 'Job header should expose a PDF download action');
  assert(script.includes("downloadPDF({ rootElement: document.getElementById('jobResults'), tractOverride: title })"),
    'Durable job PDF download should be scoped to #jobResults and use the job title');
  assert(!script.includes('id="jobCopyLinkBtn"'), 'Job header should not expose Copy link');
  assert(!script.includes('navigator.clipboard?.writeText(link)'), 'Job header should not wire clipboard copy');
});

test('Phase 6: job header uses footer actions and editable job name', () => {
  assert(script.includes('id="jobHeaderActionsFooter"'), 'Job header should place actions in a footer row');
  assert(script.includes('id="jobRenameBtn"'), 'Job header should expose a Rename action');
  assert(script.includes('id="jobNameInput"'), 'Rename flow should render a job name input');
  assert(script.includes('async function saveJobName'), 'Missing saveJobName() helper');
  assert(script.includes('subjectTract: nextName'), 'Rename should persist through subjectTract for recent jobs');
  assert(script.includes('rememberRecentJob(updated)'), 'Rename should refresh the recent jobs cache');
  assert(indexHtml.includes('#jobHeaderActionsFooter .btn-primary') &&
         indexHtml.includes('width:auto') &&
         indexHtml.includes('margin-top:0'),
    'Job header action buttons should not inherit full-width primary CTA styling');
});

test('Phase 6: status badge CSS classes exist', () => {
  assert(indexHtml.includes('.status-badge'), 'Missing .status-badge style');
  assert(indexHtml.includes('.status-badge--complete'), 'Missing complete badge style');
  assert(indexHtml.includes('.status-badge--failed'), 'Missing failed badge style');
  assert(indexHtml.includes('.status-badge--partial'), 'Missing partial badge style');
});

test('Phase 6: job stepper renders visual stage cards with active progress accent', () => {
  assert(indexHtml.includes('.job-stepper .step-card'), 'Stepper should render each stage as a card');
  assert(indexHtml.includes('.job-stepper .step-meta'), 'Stepper cards should include Done/Now/Next metadata');
  assert(indexHtml.includes('.job-stepper .step-progress'), 'Active step should include a progress accent');
  assert(script.includes("const meta = i < activeIdx ? 'Done' : i === activeIdx ? 'Now' : 'Next';"),
    'Stepper renderer should label each phase by progress state');
  assert(script.includes('step-card active') && script.includes('step-progress'),
    'Active step card should render the active progress accent');
  assert(!script.includes('<span class="sep">→</span>'),
    'Stage-card stepper should not use arrow separators');
});

test('Phase 6: job view renderers exist', () => {
  for (const fn of ['renderJobHeader', 'renderJobProgressView', 'renderJobStepper',
                    'renderJobDetail', 'renderJobActions', 'renderJobResults']) {
    assert(script.includes(`function ${fn}`), `Missing ${fn}()`);
  }
  assert(script.includes('JOB_STATUS_LABELS'), 'Missing canonical status label map');
});

test('Phase 6: adaptive polling helper exists with documented intervals', () => {
  assert(script.includes('JOB_POLL_INTERVALS'), 'Missing JOB_POLL_INTERVALS table');
  assert(script.includes('function scheduleJobPoll'), 'Missing scheduleJobPoll()');
  assert(script.includes("document.addEventListener('visibilitychange'"),
    'Adaptive poller must respond to visibilitychange');
  assert(script.includes('429') && script.includes('503'),
    'Adaptive poller must back off on 429/503');
});

test('Phase 6: stopJobPoller cancels any pending poll', () => {
  assert(script.includes('function stopJobPoller'), 'Missing stopJobPoller()');
});

test('Phase 6: loadJobView fetches the job and hydrates the view', () => {
  assert(script.includes('async function loadJobView'), 'Missing loadJobView()');
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}`'),
    'loadJobView must call GET /api/jobs/:id');
  assert(script.includes('renderJobHeader(job)') &&
         script.includes('renderJobProgressView(job)') &&
         script.includes('renderJobStepper(job)'),
    'loadJobView must invoke header/progress/stepper renderers');
  assert(script.includes('Job not found'), 'loadJobView must handle 404 with friendly copy');
});

test('Phase 6: terminal job hydrates result via /result', () => {
  assert(script.includes('/api/jobs/${encodeURIComponent(job.id)}/result'),
    'Job view must fetch /result on terminal status');
});

test('Phase 6: durable uploads use bounded concurrency', () => {
  assert(script.includes('DURABLE_UPLOAD_CONCURRENCY'), 'Must define durable upload concurrency');
  assert(script.includes('runWithConcurrency(uploadTasks, DURABLE_UPLOAD_CONCURRENCY)'),
    'registerJobUploads must upload chunks with bounded concurrency');
});

test('Phase 6: stalled server polls kick /process endpoints', () => {
  assert(script.includes('processServerAbstractionBatch(jobId)'),
    'Abstraction poll stall must POST /abstraction/process');
  assert(script.includes('processServerSynthesisBatch(jobId)'),
    'Synthesis poll stall must POST /synthesis/process');
});

test('Phase 6: synthesis polling waits for merge and reuses batch result', () => {
  assert(script.includes('status.mergeInProgress'), 'Synthesis terminal check must wait for final merge');
  assert(script.includes('batchResult?.finalTitleOpinion'), 'Synthesis poll must cache title opinion from /process');
  assert(script.includes('publicJobResultFromApi(settled)'), 'runServerSynthesis must reuse polled/process result before /result');
});

test('Phase 6: job actions wire to existing API endpoints', () => {
  // Path components passed to runJobAction(job, '/<endpoint>') — URL is composed
  // inside runJobAction as `/api/jobs/${encodeURIComponent(job.id)}${endpointPath}`.
  assert(script.includes('/api/jobs/${encodeURIComponent(job.id)}${endpointPath}'),
    'runJobAction must compose /api/jobs/:id<endpointPath>');
  assert(script.includes("runJobAction(job, '/cancel')"),
    'Cancel button must POST /cancel');
  assert(script.includes("runJobAction(job, '/retry-failed')"),
    'Retry-failed button must POST /retry-failed');
  assert(script.includes("runJobAction(job, '/abstraction/process')"),
    'Kick abstraction must POST /abstraction/process');
  assert(script.includes("runJobAction(job, '/synthesis/process')"),
    'Kick synthesis must POST /synthesis/process');
  assert(script.includes("runJobAction(job, '/synthesis/start')"),
    'Retry/skip-failed synthesis must POST /synthesis/start');
  assert(script.includes('actionInFlight'), 'Must guard against concurrent actions');
  assert(script.includes("confirm('Cancel this job"),
    'Cancel action must confirm');
});

test('Phase 6: home view presents recent jobs as a utility toolbar action', () => {
  assert(indexHtml.includes('id="recentJobsToolbar"'), 'Home view must expose a recent jobs toolbar');
  assert(indexHtml.includes('id="recentJobsButton"'), 'Home view must include a recent jobs toolbar button');
  assert(!indexHtml.includes('id="homeStartOptions"'), 'Recent jobs should not be presented as a start option card');
  assert(script.includes('function renderRecentJobsToolbar'), 'Home view must render recent jobs availability');
});

test('Phase 6: analyze() navigates to #/job/{id} when durable storage is available', () => {
  assert(script.includes('navigate(`#/job/'), 'analyze() must navigate to #/job/{id} when durable');
});

test('Phase 6: job results render title opinion when complete', () => {
  assert(script.includes('function renderJobResults'),
    'renderJobResults must exist');
  assert(script.includes('finalTitleOpinion'),
    'renderJobResults must render finalTitleOpinion');
});

test('Phase 6: job follow-up posts to /followup endpoint', () => {
  assert(script.includes('/followup'),
    'Follow-up must POST /api/jobs/:id/followup');
  assert(script.includes('jobFollowupHistory'),
    'Follow-up must render Q&A history');
});

test('Phase 6: recent jobs store caps at 20 entries', () => {
  assert(script.includes('title-analyzer:recent-jobs:v1'),
    'Must use a versioned localStorage key for recent jobs');
  assert(script.includes('RECENT_JOBS_LIMIT = 20') || script.includes('RECENT_JOBS_LIMIT=20'),
    'Must cap recent jobs at 20');
  assert(script.includes('function rememberRecentJob'), 'Missing rememberRecentJob()');
  assert(script.includes('function renderRecentJobsView'), 'Missing renderRecentJobsView()');
});


let passed = 0;
let failed = 0;
let skipped = 0;

for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    if (err.message === 'SKIP') {
      console.log(`○ ${name} (skipped)`);
      skipped++;
    } else {
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}`);
      failed++;
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed > 0 ? 1 : 0);
