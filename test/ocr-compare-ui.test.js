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
  const elements = Object.fromEntries(['password', 'document', 'compare-form', 'compare', 'status', 'settings', 'previews', 'baseline', 'candidate', 'differences', 'download'].map(id => [id, new Element()]));
  const calls = [], blobs = [], revoked = [];
  const document = { getElementById: id => elements[id], createElement: tag => new Element(tag) };
  const models = [
    { id: 'gemini-3.1-flash-lite', label: 'Baseline', thinkingLevel: 'default', maxTokens: 8000, text: '<script>unsafe</script>', fields: { grantor: '<img src=x onerror=bad()>', onlyBaseline: 0 }, usage: { input_tokens: 10, output_tokens: 20, thinking_tokens: 3 }, latencyMs: 120, stopReason: 'MAX_TOKENS', modelVersion: 'v1', costUsd: .001, costRates: { input: .25, output: 1.5, source: 'fixture' } },
    { id: 'gemini-3.8-flash', label: 'Candidate', thinkingLevel: 'minimal', maxTokens: 8000, text: '', fields: { grantor: 'Other', onlyCandidate: false }, usage: { input_tokens: 11, output_tokens: 0, thinking_tokens: 4 }, latencyMs: 130, stopReason: 'STOP', modelVersion: 'v2', costUsd: .002, costRates: { input: .5, output: 3, source: 'fixture' } }
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
  ui.createCompareUI(h.deps);
  await selected(h);
  await h.elements['compare-form'].fire('submit');
  const rows = Object.fromEntries(h.elements.differences.children.map(row => [row.children[0].textContent, row.children[3].textContent]));
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
  assert.match(allText(h.elements.differences), /<img src=x onerror=bad\(\)>/);
  assert.equal(h.elements.download.disabled, false);
  await h.elements.download.fire('click');
  const report = JSON.parse(await h.blobs.at(-1).text());
  assert.equal(report.models[0].text, '<script>unsafe</script>');
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
