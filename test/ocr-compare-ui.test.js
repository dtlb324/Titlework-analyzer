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
  const elements = Object.fromEntries(['password', 'document', 'compare-form', 'compare', 'status', 'settings', 'previews', 'baseline', 'candidate', 'challenger', 'baseline-effort', 'candidate-effort', 'challenger-effort', 'differences', 'download', 'batch', 'accuracy-rank', 'accuracy-note'].map(id => [id, new Element()]));
  const calls = [], blobs = [], revoked = [];
  const document = { getElementById: id => elements[id], createElement: tag => new Element(tag) };
  const models = [
    { id: 'gemini-3.1-flash-lite', label: 'Baseline', effort: 'default', effortLevels: ['default', 'minimal', 'low', 'medium', 'high'], thinkingLevel: 'default', maxTokens: 8000, text: '<script>unsafe</script>', fields: { grantor: '<img src=x onerror=bad()>', onlyBaseline: 0 }, usage: { input_tokens: 10, output_tokens: 20, thinking_tokens: 3 }, latencyMs: 120, stopReason: 'MAX_TOKENS', modelVersion: 'v1', costUsd: .001, costRates: { input: .25, output: 1.5, source: 'fixture' } },
    { id: 'gemini-3.8-flash', label: 'Candidate', effort: 'medium', effortLevels: ['low', 'medium', 'high'], thinkingLevel: 'medium', maxTokens: 8000, text: '', fields: { grantor: 'Other', onlyCandidate: false }, usage: { input_tokens: 11, output_tokens: 0, thinking_tokens: 4 }, latencyMs: 130, stopReason: 'STOP', modelVersion: 'v2', costUsd: .002, costRates: { input: .5, output: 3, source: 'fixture' } },
    { id: 'claude-haiku-5-5', label: 'Challenger', effort: 'medium', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], thinkingLevel: 'adaptive, effort medium', maxTokens: 8000, text: 'GRANTOR: Third', fields: { grantor: 'Third', onlyCandidate: false }, usage: { input_tokens: 12, output_tokens: 5 }, latencyMs: 90, stopReason: 'end_turn', modelVersion: 'v3', costUsd: .0003, costRates: { input: .1, output: .5, source: 'fixture' } }
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
  const pdf = { numPages: 61, getPage: async () => { throw Error('must not render'); } };
  const deps = { loadPdfjs: async () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => destroyed++ }) }) };
  await assert.rejects(ui.prepareDocument(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), deps), /60 pages/);
  assert.equal(destroyed, 1);
  pdf.numPages = 2;
  pdf.getPage = async () => ({ getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }), cleanup() {} });
  deps.createCanvas = () => ({ getContext: () => ({}), toBlob: fn => fn(new Blob([png, new Uint8Array(6000000)], { type: 'image/png' })) });
  await assert.rejects(ui.prepareDocument(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), deps), /12 MB/);
  pdf.getPage = async () => { throw Error('broken PDF page'); };
  await assert.rejects(ui.prepareDocument(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), deps), /broken PDF page/);
  assert.equal(destroyed, 3);
});

test('a 60-page PDF stays inside the byte cap by falling back to JPEG for pages too big as PNG', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const jpeg = new Uint8Array([255, 216, 255, 224]);
  const pdf = { numPages: 60, getPage: async () => ({ getViewport: () => ({ width: 1, height: 1 }), render: () => ({ promise: Promise.resolve() }), cleanup() {} }) };
  const requested = [];
  const deps = {
    loadPdfjs: async () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => {} }) }),
    createCanvas: () => ({ getContext: () => ({}), toBlob: (fn, type, quality) => { requested.push([type, quality]); fn(type === 'image/png' ? new Blob([png, new Uint8Array(1000000)], { type }) : new Blob([jpeg, new Uint8Array(150000)], { type })); } })
  };
  const pages = await ui.prepareDocument(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), deps);
  assert.equal(pages.length, 60);
  assert.equal(pages[0].mediaType, 'image/jpeg');
  assert.ok(pages.filter(page => page.mediaType === 'image/jpeg').length >= 50);
  assert.ok(requested.some(([type, quality]) => type === 'image/jpeg' && quality === 0.92));
  assert.ok(pages.reduce((sum, page) => sum + page.blob.size, 0) <= 12000000);
  deps.createCanvas = () => ({ getContext: () => ({}), toBlob: (fn, type) => fn(new Blob([png], { type })) });
  assert.ok((await ui.prepareDocument(new Blob(['%PDF-1.7'], { type: 'application/pdf' }), deps)).every(page => page.mediaType === 'image/png'));
});

function renderedPdfFixture(pngSizes, jpegSizes = () => 100000) {
  const seen = { rendered: [], scales: [], encodings: [], cleaned: [], destroyed: 0, canvases: [], encoded: [] };
  const pdf = {
    numPages: pngSizes.length,
    getPage: async index => ({
      getViewport: ({ scale }) => { seen.scales.push(scale); return { width: index * 10, height: 20 }; },
      render: ({ canvasContext }) => { canvasContext.index = index; seen.rendered.push(index); return { promise: Promise.resolve() }; },
      cleanup: () => seen.cleaned.push(index),
    }),
  };
  const deps = {
    loadPdfjs: async () => ({ GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve(pdf), destroy: async () => seen.destroyed++ }) }),
    createCanvas: () => {
      assert.ok(seen.canvases.every(canvas => canvas.width === 0 && canvas.height === 0), 'previous canvas is released before rendering another page');
      const context = {};
      const canvas = { getContext: () => context, toBlob: (callback, type, quality) => {
        const index = context.index;
        seen.encodings.push({ index, type, quality });
        const size = type === 'image/png' ? pngSizes[index - 1] : jpegSizes(index, quality);
        const blob = new Blob([new Uint8Array(size).fill(index)], { type });
        const arrayBuffer = blob.arrayBuffer.bind(blob);
        blob.arrayBuffer = () => { seen.encoded.push(index); return arrayBuffer(); };
        callback(blob);
      } };
      seen.canvases.push(canvas);
      return canvas;
    },
  };
  return { deps, seen, pdf, file: new Blob(['%PDF-1.7'], { type: 'application/pdf' }) };
}

test('whole-file PNGs below the byte cap stay lossless regardless of page order', async () => {
  for (const sizes of [[6000000, 1000000, 1000000], [1000000, 6000000, 1000000], [1000000, 1000000, 6000000]]) {
    const { deps, seen, file } = renderedPdfFixture(sizes);
    const pages = await ui.prepareDocument(file, deps);
    assert.deepEqual(pages.map(page => page.mediaType), ['image/png', 'image/png', 'image/png']);
    assert.deepEqual(pages.map(page => page.blob.size), sizes);
    assert.deepEqual(pages.map(page => [page.width, page.height]), [[10, 20], [20, 20], [30, 20]]);
    assert.deepEqual(seen.rendered, [1, 2, 3]);
    assert.deepEqual(seen.scales, [2, 2, 2]);
    assert.equal(seen.encodings.filter(encoding => encoding.type === 'image/jpeg').length, 0);
    assert.deepEqual(seen.cleaned, [1, 2, 3]);
    assert.equal(seen.destroyed, 1);
    assert.ok(seen.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  }
});

test('oversized aggregate compresses only the largest page at the highest quality resolving the deficit', async () => {
  const { deps, seen, file } = renderedPdfFixture([9000000, 3000000, 1000000], (index, quality) => quality === 0.92 ? 8800000 : quality === 0.85 ? 8000000 : 2000000);
  const pages = await ui.prepareDocument(file, deps);
  assert.deepEqual(pages.map(page => page.mediaType), ['image/jpeg', 'image/png', 'image/png']);
  assert.deepEqual(pages.map(page => page.blob.size), [8000000, 3000000, 1000000]);
  assert.deepEqual(seen.encodings.filter(encoding => encoding.type === 'image/jpeg'), [
    { index: 1, type: 'image/jpeg', quality: 0.92 },
    { index: 1, type: 'image/jpeg', quality: 0.85 },
  ]);
  assert.deepEqual(seen.rendered, [1, 2, 3, 1]);
  assert.deepEqual(seen.scales, [2, 2, 2, 2]);
  assert.deepEqual(seen.cleaned, [1, 2, 3, 1]);
  assert.equal(seen.destroyed, 1);
  assert.deepEqual(seen.encoded, [1, 2, 3], 'only final selected blobs become base64');
  assert.deepEqual(pages.map(page => Buffer.from(page.data, 'base64').length), [8000000, 3000000, 1000000]);
});

test('aggregate compression combines savings across pages without changing their order', async () => {
  const { deps, seen, file } = renderedPdfFixture([8000000, 7000000, 1000000], (index, quality) => index === 1
    ? ({ 0.92: 7900000, 0.85: 7800000, 0.75: 7700000, 0.65: 7500000, 0.55: 7200000, 0.45: 7000000 })[quality]
    : quality === 0.92 ? 4500000 : 4000000);
  const pages = await ui.prepareDocument(file, deps);
  assert.deepEqual(pages.map(page => page.blob.size), [7000000, 4000000, 1000000]);
  assert.deepEqual(pages.map(page => page.mediaType), ['image/jpeg', 'image/jpeg', 'image/png']);
  assert.deepEqual(pages.map(page => Buffer.from(page.data, 'base64')[0]), [1, 2, 3]);
  assert.deepEqual(seen.rendered, [1, 2, 3, 1, 2]);
  assert.deepEqual(seen.encodings.filter(encoding => encoding.type === 'image/jpeg').map(({ index, quality }) => [index, quality]), [
    [1, 0.92], [1, 0.85], [1, 0.75], [1, 0.65], [1, 0.55], [1, 0.45], [2, 0.92], [2, 0.85],
  ]);
  assert.deepEqual(seen.encoded, [1, 2, 3]);
  assert.equal(seen.destroyed, 1);
});

test('aggregate compression keeps PNG when JPEG is larger and saves bytes on another page', async () => {
  const { deps, seen, file } = renderedPdfFixture([7000000, 6000000], index => index === 1 ? 8000000 : 5000000);
  const pages = await ui.prepareDocument(file, deps);
  assert.deepEqual(pages.map(page => page.blob.size), [7000000, 5000000]);
  assert.deepEqual(pages.map(page => page.mediaType), ['image/png', 'image/jpeg']);
  assert.deepEqual(seen.rendered, [1, 2, 1, 2]);
  assert.deepEqual(seen.cleaned, [1, 2, 1, 2]);
  assert.equal(seen.destroyed, 1);
});

test('truly oversized aggregate exhausts the JPEG ladder before rejection and releases all rendering resources', async () => {
  const { deps, seen, file } = renderedPdfFixture([8000000, 8000000], () => 6500000);
  await assert.rejects(ui.prepareDocument(file, deps), /exceed the total 12 MB limit/);
  assert.deepEqual(seen.rendered, [1, 2, 1, 2]);
  assert.deepEqual(seen.encodings.filter(encoding => encoding.type === 'image/jpeg').map(({ index, quality }) => [index, quality]), [1, 2].flatMap(index => [0.92, 0.85, 0.75, 0.65, 0.55, 0.45].map(quality => [index, quality])));
  assert.deepEqual(seen.cleaned, [1, 2, 1, 2]);
  assert.deepEqual(seen.encoded, [], 'rejected files never allocate base64 payloads');
  assert.equal(seen.destroyed, 1);
  assert.ok(seen.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
});

test('PDF rendering failures release the page, canvas and loading task at every preparation stage', async () => {
  for (const stage of ['viewport', 'canvas', 'render', 'png', 'jpeg']) {
    const { deps, seen, pdf, file } = renderedPdfFixture(stage === 'jpeg' ? [13000000] : [100]);
    const getPage = pdf.getPage;
    pdf.getPage = async index => {
      const page = await getPage(index);
      if (stage === 'viewport') page.getViewport = () => { throw Error('failed viewport'); };
      if (stage === 'render') page.render = () => ({ promise: Promise.reject(Error('failed render')) });
      return page;
    };
    const createCanvas = deps.createCanvas;
    deps.createCanvas = () => {
      if (stage === 'canvas') throw Error('failed canvas');
      const canvas = createCanvas();
      const toBlob = canvas.toBlob;
      canvas.toBlob = (callback, type, quality) => {
        if (stage === 'png' && type === 'image/png') return callback(null);
        if (stage === 'jpeg' && type === 'image/jpeg') throw Error('failed jpeg');
        return toBlob(callback, type, quality);
      };
      return canvas;
    };
    await assert.rejects(ui.prepareDocument(file, deps), stage === 'png' ? /Could not encode PDF page 1/ : new RegExp(`failed ${stage}`));
    assert.deepEqual(seen.cleaned, stage === 'jpeg' ? [1, 1] : [1]);
    assert.equal(seen.destroyed, 1);
    assert.deepEqual(seen.encoded, []);
    assert.ok(seen.canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  }
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
  assert.deepEqual(payload, { filename: 'deed.png', pages: [{ mediaType: 'image/png', data: 'YWJj' }], efforts: ['default', 'medium', 'medium'] });
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

const effortButtons = bar => bar.children.filter(child => child.tagName === 'button');
const pressed = bar => effortButtons(bar).filter(button => button['aria-pressed'] === 'true').map(button => button.textContent);

test('effort buttons load from server metadata once a password is entered and drive each model\'s requested effort', async () => {
  const h = harness();
  ui.createCompareUI(h.deps);
  h.elements.password.value = 'private-password';
  await h.elements.password.fire('change');
  assert.deepEqual(h.calls.map(call => call.method), ['GET'], 'loading levels makes no billable call');
  assert.deepEqual(effortButtons(h.elements['candidate-effort']).map(button => button.textContent), ['low', 'medium', 'high']);
  assert.deepEqual(effortButtons(h.elements['challenger-effort']).map(button => button.textContent), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual([h.elements['baseline-effort'], h.elements['candidate-effort'], h.elements['challenger-effort']].map(pressed), [['default'], ['medium'], ['medium']]);
  await effortButtons(h.elements['candidate-effort']).find(button => button.textContent === 'high').fire('click');
  await effortButtons(h.elements['challenger-effort']).find(button => button.textContent === 'low').fire('click');
  assert.deepEqual(pressed(h.elements['candidate-effort']), ['high']);
  assert.deepEqual(pressed(h.elements['challenger-effort']), ['low']);
  await selected(h);
  await h.elements['compare-form'].fire('submit');
  const post = h.calls.find(call => call.method === 'POST');
  assert.deepEqual(JSON.parse(post.body).efforts, ['default', 'high', 'low'], 'clicked levels survive the pre-compare metadata refresh');
  assert.match(allText(h.elements.settings), /gemini-3.8-flash · effort high/);
  assert.match(allText(h.elements.settings), /claude-haiku-5-5 · effort low/);
});

test('effort buttons are locked while a comparison runs', async () => {
  let release;
  const h = harness();
  const base = h.deps.fetch;
  h.deps.fetch = async (url, options) => options.method === 'POST' ? (await new Promise(resolve => { release = resolve; }), base(url, options)) : base(url, options);
  ui.createCompareUI(h.deps);
  await selected(h);
  const running = h.elements['compare-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(effortButtons(h.elements['candidate-effort']).every(button => button.disabled), 'locked during the billable call');
  await effortButtons(h.elements['candidate-effort']).find(button => button.textContent === 'low').fire('click');
  assert.deepEqual(pressed(h.elements['candidate-effort']), ['medium'], 'a click while busy changes nothing');
  release();
  await running;
  assert.ok(effortButtons(h.elements['candidate-effort']).every(button => !button.disabled));
});

test('a failed effort-level load is shown under the buttons and never replaces the document status', async () => {
  const h = harness();
  const base = h.deps.fetch;
  let reject = true;
  h.deps.fetch = async (url, options) => reject && options.method === 'GET' ? { ok: false, status: 401, json: async () => ({}) } : base(url, options);
  ui.createCompareUI(h.deps);
  await selected(h);
  const status = h.elements.status.textContent;
  h.elements.password.value = 'wrong';
  await h.elements.password.fire('change');
  assert.equal(h.elements.status.textContent, status, 'document status is not overwritten');
  assert.match(allText(h.elements['candidate-effort']), /Could not load effort levels: Application password rejected/);
  reject = false;
  h.elements.password.value = 'private-password';
  await h.elements.password.fire('change');
  assert.doesNotMatch(allText(h.elements['candidate-effort']), /Could not load/, 'error clears once the right password loads levels');
  assert.deepEqual(pressed(h.elements['candidate-effort']), ['medium']);
});

test('metadata error survives file selection and control updates until current credentials refresh successfully', async () => {
  const h = harness();
  const fetch = h.deps.fetch;
  h.deps.fetch = async (url, options) => options.headers['x-app-password'] === 'wrong'
    ? { ok: false, status: 401, json: async () => ({}) } : fetch(url, options);
  ui.createCompareUI(h.deps);
  h.elements.password.value = 'private-password';
  await h.elements.password.fire('change');
  await effortButtons(h.elements['candidate-effort']).find(button => button.textContent === 'high').fire('click');
  h.elements.password.value = 'wrong';
  await h.elements.password.fire('change');
  assert.match(allText(h.elements['candidate-effort']), /Could not load effort levels: Application password rejected/);
  h.elements.document.files = [named('new.png')];
  await h.elements.document.fire('change');
  assert.match(h.elements.status.textContent, /new.png: 1 page image/);
  assert.match(allText(h.elements['candidate-effort']), /Could not load effort levels: Application password rejected/);
  assert.equal(effortButtons(h.elements['candidate-effort']).length, 0, 'stale choices are not rendered under a credential error');
  await h.elements['compare-form'].fire('submit');
  assert.match(allText(h.elements['candidate-effort']), /Could not load effort levels: Application password rejected/);
  assert.match(h.elements.status.textContent, /Comparison failed: Application password rejected/);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
  h.elements.password.value = 'private-password';
  await h.elements.password.fire('change');
  assert.doesNotMatch(allText(h.elements['candidate-effort']), /Could not load/);
  assert.deepEqual(pressed(h.elements['candidate-effort']), ['high'], 'supported picks survive a valid refresh of the same model');
});

test('clearing the password invalidates a pending metadata response immediately', async () => {
  for (const event of ['input', 'change']) {
    const h = harness();
    let release;
    h.deps.fetch = async (url, options) => {
      h.calls.push({ url, ...options });
      return new Promise(resolve => { release = resolve; });
    };
    ui.createCompareUI(h.deps);
    h.elements.password.value = 'private-password';
    const loading = h.elements.password.fire('change');
    h.elements.password.value = '';
    await h.elements.password.fire(event);
    release({ ok: true, json: async () => ({ models: h.models, maxPages: 60, maxBytes: 12000000, renderScale: 2 }) });
    await loading;
    assert.equal(h.calls.length, 1, 'clearing the credential starts no request');
    for (const slot of ['baseline', 'candidate', 'challenger']) {
      assert.equal(effortButtons(h.elements[`${slot}-effort`]).length, 0, `${event} discards obsolete levels`);
      assert.match(allText(h.elements[`${slot}-effort`]), /Enter the application password/);
    }
  }
});

test('pre-compare metadata failure supersedes pending loads and remains visible until a valid refresh', async () => {
  const h = harness();
  let requests = 0, release;
  const fetch = h.deps.fetch;
  h.deps.fetch = async (url, options) => {
    if (options.method === 'GET') {
      requests++;
      if (requests === 2) return new Promise(resolve => { release = resolve; });
      if (requests === 3) return { ok: false, status: 401, json: async () => ({}) };
    }
    return fetch(url, options);
  };
  ui.createCompareUI(h.deps);
  await selected(h);
  await h.elements.password.fire('change');
  await effortButtons(h.elements['candidate-effort']).find(button => button.textContent === 'high').fire('click');
  h.elements.password.value = 'wrong';
  const obsolete = h.elements.password.fire('change');
  await h.elements['compare-form'].fire('submit');
  assert.match(h.elements.status.textContent, /Application password rejected/);
  assert.match(allText(h.elements['candidate-effort']), /Could not load effort levels: Application password rejected/);
  release({ ok: true, json: async () => ({ models: h.models, maxPages: 60, maxBytes: 12000000, renderScale: 2 }) });
  await obsolete;
  h.elements.document.files = [named('new.png')];
  await h.elements.document.fire('change');
  assert.match(allText(h.elements['candidate-effort']), /Could not load effort levels: Application password rejected/);
  assert.equal(effortButtons(h.elements['candidate-effort']).length, 0);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 0);
  h.elements.password.value = 'private-password';
  await h.elements.password.fire('input');
  await h.elements['compare-form'].fire('submit');
  assert.doesNotMatch(allText(h.elements['candidate-effort']), /Could not load/);
  assert.deepEqual(JSON.parse(h.calls.find(call => call.method === 'POST').body).efforts, ['default', 'high', 'medium']);
});

test('untouched columns follow a server level change while picked columns keep their level', async () => {
  const h = harness();
  ui.createCompareUI(h.deps);
  h.elements.password.value = 'private-password';
  await h.elements.password.fire('change');
  await effortButtons(h.elements['challenger-effort']).find(button => button.textContent === 'high').fire('click');
  h.models[0].effort = 'low';
  h.models[1].effort = 'high';
  await selected(h);
  await h.elements['compare-form'].fire('submit');
  assert.deepEqual(JSON.parse(h.calls.find(call => call.method === 'POST').body).efforts, ['low', 'high', 'high']);
});

test('a picked level the server no longer offers resets with a note', async () => {
  const h = harness();
  ui.createCompareUI(h.deps);
  h.elements.password.value = 'private-password';
  await h.elements.password.fire('change');
  await effortButtons(h.elements['challenger-effort']).find(button => button.textContent === 'max').fire('click');
  h.models[2].effortLevels = ['low', 'medium', 'high'];
  await h.elements.password.fire('change');
  assert.deepEqual(pressed(h.elements['challenger-effort']), ['medium']);
  assert.match(allText(h.elements['challenger-effort']), /max selection is not available for claude-haiku-5-5; reset to medium/);
});

test('metadata without effort options is rejected before any billable POST', async () => {
  const h = harness();
  h.models.forEach(model => { delete model.effortLevels; });
  ui.createCompareUI(h.deps);
  await selected(h);
  await h.elements['compare-form'].fire('submit');
  assert.match(h.elements.status.textContent, /configuration/i);
  assert.ok(!h.calls.some(call => call.method === 'POST'));
});

const read = name => existsSync(new URL(name, root)) ? readFileSync(new URL(name, root), 'utf8') : '';

test('isolated page has labelled controls, live status, local assets and responsive comparison layout', () => {
  const html = read('public/ocr-compare.html');
  assert.match(html, /<title>OCR model comparison/);
  for (const id of ['password', 'document']) assert.match(html, new RegExp(`for="${id}"`));
  for (const slot of ['baseline', 'candidate', 'challenger']) assert.match(html, new RegExp(`id="${slot}-effort" class="effort" role="group" aria-label="[A-Za-z]+ effort level"`), `${slot} has an effort button group above its output`);
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

test('explicit rerun reuses prepared done, failed and skipped files with newly selected effort', async () => {
  const h = multiHarness();
  const prepare = h.deps.prepareDocument;
  let preparations = 0;
  h.deps.prepareDocument = async file => { preparations++; return prepare(file); };
  h.failOn = 'b.png';
  const fetch = h.deps.fetch;
  let release, hold = false;
  h.deps.fetch = async (url, options) => {
    if (options.method === 'POST' && hold && !release) await new Promise(resolve => { release = resolve; });
    return fetch(url, options);
  };
  ui.createCompareUI(h.deps);
  await selectMany(h, [named('a.png'), named('b.png'), named('c.png')]);
  await h.elements['compare-form'].fire('submit');
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST']);
  assert.deepEqual(h.elements.batch.children.map(row => row.children[2].textContent), ['Done', 'Failed: HTTP 429: A comparison is already running', 'Not run']);
  await effortButtons(h.elements['candidate-effort']).find(button => button.textContent === 'high').fire('click');
  assert.equal(h.calls.length, 3, 'effort selection never starts an automatic comparison');
  h.failOn = null;
  hold = true;
  const rerun = h.elements['compare-form'].fire('submit');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.elements.compare.disabled, true);
  await h.elements['compare-form'].fire('submit');
  assert.deepEqual(h.calls.map(call => call.method), ['GET', 'POST', 'POST', 'GET'], 'overlapping rerun cannot load metadata or send a second request');
  release();
  await rerun;
  assert.equal(preparations, 3, 'rerun never prepares the files a second time');
  const posts = h.calls.filter(call => call.method === 'POST').map(call => JSON.parse(call.body));
  assert.deepEqual(posts.map(post => post.filename), ['a.png', 'b.png', 'a.png', 'b.png', 'c.png']);
  assert.deepEqual(posts.slice(2).map(post => post.efforts), Array.from({ length: 3 }, () => ['default', 'high', 'medium']));
  assert.deepEqual(posts.map(post => post.pages), Array.from({ length: 5 }, () => [{ mediaType: 'image/png', data: 'YWJj' }]));
  assert.deepEqual(h.elements.batch.children.map(row => row.children[2].textContent), ['Done', 'Done', 'Done']);
  assert.match(h.elements.status.textContent, /Comparison complete for 3 files/);
  await h.elements.download.fire('click');
  assert.deepEqual(JSON.parse(await h.blobs.at(-1).text()).files.map(file => file.filename), ['a.png', 'b.png', 'c.png']);
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
  assert.deepEqual(payload, { filename: 'deed.pdf', pages: [{ mediaType: 'image/png', data: 'YWJj' }], efforts: ['default', 'medium', 'medium'] });
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
