import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
const root = new URL('../', import.meta.url);
const ui = existsSync(new URL('public/ocr-compare.js', root)) ? await import('../public/ocr-compare.js') : {};
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.listeners = {}; this.value = ''; this.disabled = false; this.files = []; this.textContent = ''; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  setAttribute(name, value) { this[name] = value; }
  async fire(name) { return this.listeners[name]?.({ preventDefault() {} }); }
  click() { this.clicked = true; }
}
const allText = el => [el.textContent, ...el.children.map(allText)].join(' ');
function harness(overrides = {}) {
  const elements = Object.fromEntries(['password', 'document', 'compare-form', 'compare', 'status', 'settings', 'previews', 'baseline', 'candidate', 'challenger', 'differences', 'download', 'batch', 'accuracy-rank', 'accuracy-note'].map(id => [id, new Element()]));
  const calls = [], blobs = [], revoked = [];
  const document = { getElementById: id => elements[id], createElement: tag => new Element(tag) };
  const models = [
    { id: 'gemini-3.1-flash-lite', label: 'Baseline', thinkingLevel: 'default', maxTokens: 8000, text: '<script>unsafe</script>', fields: { grantor: '<img src=x onerror=bad()>', onlyBaseline: 0 }, usage: { input_tokens: 10, output_tokens: 20, thinking_tokens: 3 }, latencyMs: 120, stopReason: 'MAX_TOKENS', modelVersion: 'v1', costUsd: .001, costRates: { input: .25, output: 1.5, source: 'fixture' } },
    { id: 'gemini-3.8-flash', label: 'Candidate', thinkingLevel: 'minimal', maxTokens: 8000, text: '', fields: { grantor: 'Other', onlyCandidate: false }, usage: { input_tokens: 11, output_tokens: 0, thinking_tokens: 4 }, latencyMs: 130, stopReason: 'STOP', modelVersion: 'v2', costUsd: .002, costRates: { input: .5, output: 3, source: 'fixture' } },
    { id: 'claude-haiku-5-5', label: 'Challenger', thinkingLevel: 'adaptive, effort medium', maxTokens: 8000, text: 'GRANTOR: Third', fields: { grantor: 'Third', onlyCandidate: false }, usage: { input_tokens: 12, output_tokens: 5 }, latencyMs: 90, stopReason: 'end_turn', modelVersion: 'v3', costUsd: .0003, costRates: { input: .1, output: .5, source: 'fixture' } }
  ];
  const result = { filename: 'deed.png', pageCount: 1, inputMode: 'rendered_images', models };
  const deps = {
    document,
    fetch: async (url, options) => { calls.push({ url, ...options }); return { ok: true, json: async () => options.method === 'POST' ? result : { models, maxPages: 10, maxBytes: 12000000, renderScale: 2 } }; },
    prepareDocument: async () => [{ mediaType: 'image/png', data: 'YWJj', blob: new Blob(['abc']), width: 10, height: 10 }],
    URL: { createObjectURL: blob => { blobs.push(blob); return `blob:${blobs.length}`; }, revokeObjectURL: url => revoked.push(url) },
    setTimeout: fn => fn(),
    ...overrides
  };
  return { elements, calls, models, result, blobs, revoked, deps };
}

async function selected(h, file = { name: 'deed.png', type: 'image/png', size: 3 }) {
  h.elements.password.value = 'private-password';
  h.elements.document.files = [file];
  await h.elements.document.fire('change');
}

test('document preparation decodes real image bytes and rasterizes each PDF page at scale 2 without reading text layers', async () => {
  assert.equal(typeof ui.prepareDocument, 'function', 'document rasterizer is implemented');
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const image = new Blob([png], { type: 'image/png' });
  let closed = 0;
  const prepared = await ui.prepareDocument(image, { decodeImage: async blob => { assert.equal(blob, image); return { width: 20, height: 30, close: () => closed++ }; } });
  assert.equal(prepared[0].mediaType, 'image/png');
  assert.equal(Buffer.from(prepared[0].data, 'base64').compare(Buffer.from(png)), 0);
  assert.equal(closed, 1);
  const rendered = [], scales = [];
  let destroyed = 0;
  const pdf = { numPages: 2, getPage: async index => ({ getViewport: ({ scale }) => { scales.push(scale); return { width: 20, height: 30 }; }, render: options => { rendered.push({ index, options }); return { promise: Promise.resolve() }; }, getTextContent: () => { throw Error('text layers must not be read'); }, cleanup() {} }) };
  const pdfjs = { GlobalWorkerOptions: {}, getDocument: options => { assert.equal(options.isEvalSupported, false); assert.equal(options.wasmUrl, '/vendor/pdfjs/wasm/'); assert.equal(options.standardFontDataUrl, '/vendor/pdfjs/standard_fonts/'); return { promise: Promise.resolve(pdf), destroy: async () => destroyed++ }; } };
  const pages = await ui.prepareDocument(new Blob(['%PDF-1.7 sample'], { type: 'application/pdf' }), {
    loadPdfjs: async () => pdfjs,
    createCanvas: () => ({ width: 0, height: 0, getContext: () => ({}), toBlob: callback => callback(new Blob([png], { type: 'image/png' })) })
  });
  assert.equal(pages.length, 2);
  assert.deepEqual(scales, [2, 2]);
  assert.equal(rendered.length, 2);
  assert.equal(destroyed, 1);
  assert.equal(pdfjs.GlobalWorkerOptions.workerSrc, '/vendor/pdfjs/pdf.worker.mjs');
  assert.ok(pages.every(page => page.mediaType === 'image/png'));
  assert.match(read('public/ocr-compare.js'), /import\('\/vendor\/pdfjs\/pdf.mjs'\)/);
});

test('preparation rejects invalid signatures, undecodable images, oversized images and PDFs above caps', async () => {
  await assert.rejects(ui.prepareDocument(new Blob(['not an image'], { type: 'image/png' }), { decodeImage: async () => ({ width: 1, height: 1, close() {} }) }), /signature/i);
  await assert.rejects(ui.prepareDocument(new Blob(['abc'], { type: 'image/gif' })), /PDF, PNG, JPEG or WebP/);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await assert.rejects(ui.prepareDocument(new Blob([png], { type: 'image/png' }), { decodeImage: async () => { throw Error('decode failed'); } }), /decode failed/);
  await assert.rejects(ui.prepareDocument(new Blob([png, new Uint8Array(12000000)], { type: 'image/png' })), /12 MB/);
  let destroyed = 0;
  const pdf = { numPages: 11, getPage: async () => { throw Error('must not render'); } };
  const deps = { loadPdfjs: async () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => destroyed++ }) }) };
  await assert.rejects(ui.prepareDocument(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), deps), /10 pages/);
  assert.equal(destroyed, 1);
  pdf.numPages = 2;
  pdf.getPage = async () => ({ getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }), cleanup() {} });
  deps.createCanvas = () => ({ getContext: () => ({}), toBlob: fn => fn(new Blob([png, new Uint8Array(6000000)], { type: 'image/png' })) });
  await assert.rejects(ui.prepareDocument(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), deps), /12 MB/);
  pdf.getPage = async () => { throw Error('broken PDF page'); };
  await assert.rejects(ui.prepareDocument(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), deps), /broken PDF page/);
  assert.equal(destroyed, 3);
});

test('failed PDF loading destroys the PDF.js loading task', async () => {
  let destroyed = 0;
  const deps = { loadPdfjs: async () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.reject(new Error('corrupt PDF')), destroy: async () => destroyed++ }) }) };
  await assert.rejects(ui.prepareDocument(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), deps), /corrupt PDF/);
  assert.equal(destroyed, 1);
});

test('busy submissions cannot duplicate calls and selection changes discard in-flight results', async () => {
  let release;
  const h = harness();
  const fetch = h.deps.fetch;
  h.deps.fetch = async (url, options) => options.method === 'POST' ? new Promise(resolve => { h.calls.push({ url, ...options }); release = () => resolve({ ok: true, json: async () => h.result }); }) : fetch(url, options);
  ui.createCompareUI(h.deps);
  await selected(h);
  const first = h.elements['compare-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.elements.compare.disabled, true);
  const duplicate = h.elements['compare-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1, 'only one billable request');
  await duplicate;
  await selected(h, { name: 'new.png', type: 'image/png', size: 3 });
  release();
  await first;
  assert.equal(h.elements.download.disabled, true);
  assert.ok(!allText(h.elements.baseline).includes('unsafe'));
  assert.match(h.elements.status.textContent, /new.png/);
});

test('older preparation cannot overwrite a newer selected document', async () => {
  let release;
  const h = harness({ prepareDocument: file => file.name === 'old.png' ? new Promise(resolve => { release = resolve; }) : Promise.resolve([{ mediaType: 'image/png', data: 'YWJj', blob: new Blob(['abc']), width: 1, height: 1 }]) });
  ui.createCompareUI(h.deps);
  const old = selected(h, { name: 'old.png', type: 'image/png' });
  await selected(h, { name: 'new.png', type: 'image/png' });
  release([{ mediaType: 'image/png', data: 'b2xk', blob: new Blob(['old']), width: 1, height: 1 }]);
  await old;
  assert.equal(h.elements.previews.children.length, 1);
  await h.elements['compare-form'].fire('submit');
  assert.equal(JSON.parse(h.calls[1].body).pages[0].data, 'YWJj');
});

test('metadata failures are actionable and never submit or retry the document', async () => {
  for (const [status, message] of [[401, /password/i], [404, /disabled|unavailable/i], [503, /not configured/i]]) {
    const h = harness({ fetch: async (url, options) => { h.calls.push({ url, ...options }); return { ok: false, status, json: async () => ({ error: 'server unavailable' }) }; } });
    ui.createCompareUI(h.deps);
    await selected(h);
    await h.elements['compare-form'].fire('submit');
    assert.match(h.elements.status.textContent, message);
    assert.equal(h.calls.length, 1);
    assert.equal(h.elements.compare.disabled, false);
    assert.equal(h.elements.download.disabled, true);
  }
});

test('one model error is preserved independently without treating failed fields as differences', async () => {
  const h = harness();
  h.models[1] = { ...h.models[1], error: 'Provider failed', costUsd: null, fields: {}, text: '' };
  ui.createCompareUI(h.deps);
  await selected(h);
  await h.elements['compare-form'].fire('submit');
  assert.match(allText(h.elements.baseline), /unsafe/);
  assert.match(allText(h.elements.candidate), /Provider failed/);
  assert.match(allText(h.elements.challenger), /Third/, 'a failure in one model does not hide the third column');
  assert.match(allText(h.elements.candidate), /cost: unavailable/);
  assert.match(h.elements.status.textContent, /1 model failed/);
  assert.match(allText(h.elements.differences), /Unavailable/);
  assert.equal(h.elements.download.disabled, false);
  assert.equal(h.calls.length, 2);
});

test('server caps are enforced before billable POST and preparation failures leave no ready pages', async () => {
  const h = harness();
  const request = h.deps.fetch;
  h.deps.fetch = async (url, options) => { const response = await request(url, options); return { ...response, json: async () => ({ models: h.models, maxPages: 10, maxBytes: 2, renderScale: 2 }) }; };
  ui.createCompareUI(h.deps);
  await selected(h);
  await h.elements['compare-form'].fire('submit');
  assert.match(h.elements.status.textContent, /byte limit/i);
  assert.equal(h.calls.length, 1);
  const bad = harness({ prepareDocument: async () => { throw Error('PDF rendering failed'); } });
  ui.createCompareUI(bad.deps);
  await selected(bad);
  assert.match(bad.elements.status.textContent, /PDF rendering failed/);
  await bad.elements['compare-form'].fire('submit');
  assert.equal(bad.calls.length, 0);
});

test('field comparison ignores object key order while preserving array order and distinguishes missing from null', async () => {
  const h = harness();
  h.models[0].fields = { object: { a: 1, b: 2 }, array: [1, 2], absent: null };
  h.models[1].fields = { object: { b: 2, a: 1 }, array: [2, 1] };
  h.models[2].fields = { object: { a: 1, b: 2 }, array: [1, 2], absent: null };
  ui.createCompareUI(h.deps);
  await selected(h);
  await h.elements['compare-form'].fire('submit');
  const rows = Object.fromEntries(h.elements.differences.children.map(row => [row.children[0].textContent, row.children[4].textContent]));
  assert.equal(rows.object, 'Same');
  assert.equal(rows.array, 'Different');
  assert.equal(rows.absent, 'Different');
});

test('malformed model configuration prevents a billable POST', async () => {
  const h = harness();
  h.deps.fetch = async (url, options) => { h.calls.push({ url, ...options }); return { ok: true, json: async () => ({ models: h.models, maxPages: 10, maxBytes: 12000000, renderScale: 3 }) }; };
  ui.createCompareUI(h.deps);
  await selected(h);
  await h.elements['compare-form'].fire('submit');
  assert.match(h.elements.status.textContent, /configuration/i);
  assert.equal(h.calls.length, 1);
});

test('one upload compares server-selected models, renders safe union differences and downloads a byte-free report', async () => {
  assert.equal(typeof ui.createCompareUI, 'function', 'comparison controller is implemented');
  const h = harness();
  ui.createCompareUI(h.deps);
  await selected(h);
  assert.equal(h.elements.previews.children.length, 1);
  await h.elements['compare-form'].fire('submit');
  assert.deepEqual(h.calls.map(c => c.method), ['GET', 'POST']);
  assert.equal(h.calls[0].headers['x-app-password'], 'private-password');
  const payload = JSON.parse(h.calls[1].body);
  assert.deepEqual(payload, { filename: 'deed.png', pages: [{ mediaType: 'image/png', data: 'YWJj' }] });
  assert.match(allText(h.elements.settings), /gemini-3.1-flash-lite/);
  assert.match(allText(h.elements.baseline), /<script>unsafe<\/script>/);
  assert.match(allText(h.elements.baseline), /thinking 3/);
  assert.match(allText(h.elements.baseline), /truncated/i);
  assert.match(allText(h.elements.candidate), /empty/i);
  assert.equal(h.elements.differences.children.length, 3);
  assert.match(allText(h.elements.challenger), /Third/);
  assert.match(allText(h.elements.challenger), /adaptive, effort medium/);
  assert.match(allText(h.elements.settings), /claude-haiku-5-5/);
  assert.equal(h.elements.differences.children[0].children.length, 5, 'field + three models + comparison');
  assert.match(allText(h.elements.differences), /<img src=x onerror=bad\(\)>/);
  assert.equal(h.elements.download.disabled, false);
  await h.elements.download.fire('click');
  const report = JSON.parse(await h.blobs.at(-1).text());
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].models[0].text, '<script>unsafe</script>');
  assert.equal(report.files[0].models.length, 3);
  assert.ok(!JSON.stringify(report).includes('private-password'));
  assert.ok(!JSON.stringify(report).includes('YWJj'));
  assert.ok(h.revoked.includes('blob:2'));
  await selected(h);
  assert.ok(h.revoked.includes('blob:1'));
  assert.equal(h.elements.download.disabled, true);
  assert.equal(h.elements.differences.children.length, 0);
  assert.ok(!read('public/ocr-compare.js').includes('innerHTML'));
  assert.ok(!read('public/ocr-compare.js').includes('localStorage'));
});

const read = name => existsSync(new URL(name, root)) ? readFileSync(new URL(name, root), 'utf8') : '';

test('isolated page has labelled controls, live status, local assets and responsive comparison layout', () => {
  const html = read('public/ocr-compare.html');
  assert.match(html, /<title>OCR model comparison/);
  for (const id of ['password', 'document']) assert.match(html, new RegExp(`for="${id}"`));
  assert.match(html, /<input id="document" type="file" multiple /, 'the document picker accepts several files');
  assert.match(html, /id="batch"/);
  assert.match(html, /type="password"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /href="\/"/);
  assert.match(html, /src="\/ocr-compare.js"/);
  assert.match(html, /href="\/ocr-compare.css"/);
  assert.match(html, /Differences are not accuracy scores/);
  assert.match(html, /production escalation and batching are excluded/i);
  assert.match(html, /same max output token limit/i);
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /img-src 'self' blob:/);
  assert.match(html, /object-src 'none'/);
  assert.match(read('public/ocr-compare.css'), /@media/);
});

const named = name => ({ name, type: 'image/png', size: 3 });
async function selectMany(h, files) {
  h.elements.password.value = 'private-password';
  h.elements.document.files = files;
  await h.elements.document.fire('change');
}
function multiHarness(overrides = {}) {
  const h = harness(overrides);
  // Each POST echoes its filename and tags every model's text so results can be told apart.
  h.deps.fetch = async (url, options) => {
    h.calls.push({ url, ...options });
    if (options.method !== 'POST') return { ok: true, json: async () => ({ models: h.models, maxPages: 10, maxBytes: 12000000, renderScale: 2 }) };
    const { filename } = JSON.parse(options.body);
    if (h.failOn === filename) return { ok: false, status: 429, json: async () => ({ error: 'A comparison is already running' }) };
    return { ok: true, json: async () => ({ ...h.result, filename, models: h.models.map(model => ({ ...model, text: `${filename}:${model.id}`, stopReason: 'STOP' })) }) };
  };
  return h;
}

test('several files are compared one at a time in selection order, each with its own result', async () => {
  const h = multiHarness();
  let running = 0, maxRunning = 0;
  const inner = h.deps.fetch;
  h.deps.fetch = async (url, options) => { if (options.method === 'POST') { running++; maxRunning = Math.max(maxRunning, running); await new Promise(resolve => setImmediate(resolve)); running--; } return inner(url, options); };
  ui.createCompareUI(h.deps);
  await selectMany(h, [named('a.png'), named('b.png'), named('c.png')]);
  assert.match(h.elements.status.textContent, /3 of 3 files ready/);
  assert.match(h.elements.status.textContent, /9 in total/, 'billable calls are stated before running');
  assert.equal(h.elements.batch.children.length, 3);
  await h.elements['compare-form'].fire('submit');
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST', 'POST'], 'metadata once, then one POST per file');
  assert.deepEqual(h.calls.slice(1).map(call => JSON.parse(call.body).filename), ['a.png', 'b.png', 'c.png']);
  assert.equal(maxRunning, 1, 'files are never compared in parallel');
  assert.match(h.elements.status.textContent, /Comparison complete for 3 files/);
  assert.match(allText(h.elements.batch), /a\.png/);
  assert.equal(h.elements.batch.children.filter(row => /Done/.test(allText(row))).length, 3);
  assert.match(allText(h.elements.baseline), /c\.png:gemini-3\.1-flash-lite/, 'the last file is shown after the run');
  // Selecting View on the first row swaps the previews and outputs without a new request.
  const callsBefore = h.calls.length;
  const view = h.elements.batch.children[0].children[5].children[0];
  await view.fire('click');
  assert.match(allText(h.elements.baseline), /a\.png:gemini-3\.1-flash-lite/);
  assert.equal(h.calls.length, callsBefore);
  await h.elements.download.fire('click');
  const report = JSON.parse(await h.blobs.at(-1).text());
  assert.deepEqual(report.files.map(file => file.filename), ['a.png', 'b.png', 'c.png']);
  assert.ok(!JSON.stringify(report).includes('private-password'));
});

test('more than ten files are rejected before any preparation or request', async () => {
  const h = multiHarness();
  let prepared = 0;
  h.deps.prepareDocument = async () => { prepared++; return []; };
  ui.createCompareUI(h.deps);
  await selectMany(h, Array.from({ length: 11 }, (_, index) => named(`f${index}.png`)));
  assert.match(h.elements.status.textContent, /at most 10 files/);
  assert.equal(prepared, 0);
  await h.elements['compare-form'].fire('submit');
  assert.equal(h.calls.length, 0);
  await selectMany(h, Array.from({ length: 10 }, (_, index) => named(`f${index}.png`)));
  assert.match(h.elements.status.textContent, /10 of 10 files ready/);
});

test('a file that cannot be prepared is listed but skipped while the others still run', async () => {
  const h = multiHarness();
  h.deps.prepareDocument = async file => { if (file.name === 'bad.png') throw new Error('PDF rendering failed'); return [{ mediaType: 'image/png', data: 'YWJj', blob: new Blob(['abc']), width: 1, height: 1 }]; };
  ui.createCompareUI(h.deps);
  await selectMany(h, [named('a.png'), named('bad.png'), named('c.png')]);
  assert.match(h.elements.status.textContent, /2 of 3 files ready.*1 cannot be compared/);
  assert.match(allText(h.elements.batch), /Cannot compare: PDF rendering failed/);
  await h.elements['compare-form'].fire('submit');
  assert.deepEqual(h.calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body).filename), ['a.png', 'c.png']);
});

test('a request-level failure stops the remaining files, keeps finished results and never retries', async () => {
  const h = multiHarness();
  h.failOn = 'b.png';
  ui.createCompareUI(h.deps);
  await selectMany(h, [named('a.png'), named('b.png'), named('c.png')]);
  await h.elements['compare-form'].fire('submit');
  assert.deepEqual(h.calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body).filename), ['a.png', 'b.png'], 'c.png is not sent and b.png is not retried');
  assert.match(h.elements.status.textContent, /No automatic retry was made\. 1 of 3 files completed; 1 not run/);
  const statuses = h.elements.batch.children.map(row => allText(row.children[2]));
  assert.match(statuses[0], /Done/);
  assert.match(statuses[1], /Failed/);
  assert.match(statuses[2], /Not run/);
  assert.equal(h.elements.download.disabled, false, 'finished results can still be downloaded');
  await h.elements.download.fire('click');
  assert.deepEqual(JSON.parse(await h.blobs.at(-1).text()).files.map(file => file.filename), ['a.png']);
  assert.equal(h.elements.compare.disabled, false);
});

function pdfHarness() {
  const h = harness();
  const seen = { textReads: 0, destroyed: 0, cleaned: 0, options: null };
  const pdfjs = {
    GlobalWorkerOptions: {},
    getDocument: options => {
      seen.options = options;
      return {
        promise: Promise.resolve({
          numPages: 1,
          getPage: async () => ({
            getTextContent: async () => { seen.textReads += 1; return { items: [{ str: 'Ada' }, { str: 'Owner' }] }; },
            cleanup() { seen.cleaned += 1; },
          }),
        }),
        destroy: async () => { seen.destroyed += 1; },
      };
    },
  };
  h.deps.loadPdfjs = async () => pdfjs;
  return { h, seen, pdfjs };
}
const pdfFile = () => new File(['%PDF-1.7 sample'], 'deed.pdf', { type: 'application/pdf' });

test('a PDF preparation records document text and does not upload it', async () => {
  const { h, seen, pdfjs } = pdfHarness();
  h.models[0].fields = { ...h.models[0].fields, GRANTOR: 'Ada Owner' };
  ui.createCompareUI(h.deps);
  await selected(h, pdfFile());
  assert.equal(seen.textReads, 1);
  assert.equal(seen.cleaned, 1);
  assert.equal(seen.destroyed, 1);
  assert.equal(seen.options.isEvalSupported, false);
  assert.equal(seen.options.wasmUrl, '/vendor/pdfjs/wasm/');
  assert.equal(seen.options.standardFontDataUrl, '/vendor/pdfjs/standard_fonts/');
  assert.equal(seen.options.iccUrl, '/vendor/pdfjs/iccs/');
  assert.equal(pdfjs.GlobalWorkerOptions.workerSrc, '/vendor/pdfjs/pdf.worker.mjs');
  assert.match(h.elements.status.textContent, /page image\(s\) ready/);
  await h.elements['compare-form'].fire('submit');
  const payload = JSON.parse(h.calls.find(call => call.method === 'POST').body);
  assert.deepEqual(payload, { filename: 'deed.pdf', pages: [{ mediaType: 'image/png', data: 'YWJj' }] });
  assert.equal(payload.documentText, undefined);
  const paragraphs = h.elements.baseline.children.filter(child => child.tagName === 'p');
  const cost = paragraphs.findIndex(item => item.textContent.startsWith('Estimated cost:'));
  assert.equal(paragraphs[cost + 1].textContent, 'Document accuracy: 20% (1 of 5 fields found in the document).');
  assert.equal(h.elements['accuracy-note'].textContent, 'Ranked on 1 document. The percent is transcribed fields found in the document text.');
  assert.deepEqual(h.elements['accuracy-rank'].children.map(row => row.children.map(cell => cell.textContent)), [
    ['1', 'Baseline', '20% (1 of 5 fields)'],
    ['2', 'Candidate', '0% (0 of 5 fields)'],
    ['2', 'Challenger', '0% (0 of 5 fields)'],
  ]);
  await h.elements.download.fire('click');
  const report = JSON.parse(await h.blobs.at(-1).text());
  assert.deepEqual(report.files[0].models[0].accuracy, { matched: 1, scored: 5, percent: 20 });
  assert.equal(report.files[0].models[1].accuracy.percent, 0);
  assert.ok(!JSON.stringify(report).includes('documentText'));
  assert.ok(!JSON.stringify(report).includes('YWJj'));
});

test('an image file with no text renders no embedded text', async () => {
  let loaded = 0;
  const h = harness();
  h.deps.loadPdfjs = async () => { loaded += 1; throw new Error('pdf.js should not load'); };
  ui.createCompareUI(h.deps);
  await selected(h);
  assert.equal(loaded, 0);
  await h.elements['compare-form'].fire('submit');
  assert.match(allText(h.elements.baseline), /Document accuracy: no embedded text in this document\./);
  assert.equal(h.elements['accuracy-rank'].children.length, 0);
  assert.equal(h.elements['accuracy-note'].textContent, 'Accuracy is the share of transcribed fields found in the document\'s own text. Scans without embedded text have no score. Field differences below are still not accuracy.');
  await h.elements.download.fire('click');
  const report = JSON.parse(await h.blobs.at(-1).text());
  assert.equal(report.files[0].models[0].accuracy, undefined);
  assert.ok(!JSON.stringify(report).includes('documentText'));
});

test('a failed text read does not fail preparation', async () => {
  const h = harness();
  h.deps.loadPdfjs = async () => { throw new Error('pdf.js failed'); };
  ui.createCompareUI(h.deps);
  await selected(h, pdfFile());
  assert.match(h.elements.status.textContent, /page image\(s\) ready/);
  await h.elements['compare-form'].fire('submit');
  assert.match(allText(h.elements.baseline), /no embedded text/);
});

test('a failed model on a text PDF is not scored and the file is not ranked', async () => {
  const { h } = pdfHarness();
  h.models[0].fields = { GRANTOR: 'Ada Owner' };
  h.models[2] = { ...h.models[2], error: 'Provider failed', fields: {} };
  ui.createCompareUI(h.deps);
  await selected(h, pdfFile());
  await h.elements['compare-form'].fire('submit');
  assert.match(allText(h.elements.baseline), /Document accuracy: 20% \(1 of 5 fields found in the document\)\./);
  assert.match(allText(h.elements.challenger), /Document accuracy: not scored \(model failed\)\./);
  assert.equal(h.elements['accuracy-rank'].children.length, 0);
});

test('abstained transcript fields render no transcribed fields to score', async () => {
  const { h } = pdfHarness();
  const fields = { GRANTOR: 'n/a', GRANTEE: 'none', 'DATE EXECUTED': 'none stated', 'DATE RECORDED': 'not applicable', 'RECORDING REF': 'unclear' };
  h.models.forEach(model => { model.fields = fields; });
  ui.createCompareUI(h.deps);
  await selected(h, pdfFile());
  await h.elements['compare-form'].fire('submit');
  assert.match(allText(h.elements.baseline), /Document accuracy: no transcribed fields to score\./);
  assert.equal(h.elements['accuracy-rank'].children.length, 0);
});
