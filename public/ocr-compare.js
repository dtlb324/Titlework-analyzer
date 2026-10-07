const LIMITS = { maxPages: 10, maxBytes: 12000000, renderScale: 2 };

async function encodePage(blob, width, height) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return { mediaType: blob.type, data: btoa(binary), blob, width, height };
}

export async function prepareDocument(file, deps = {}) {
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error('Choose a PDF, PNG, JPEG or WebP file.');
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const starts = signature => signature.every((value, index) => head[index] === value);
  const ascii = (offset, value) => [...value].every((char, index) => head[offset + index] === char.charCodeAt(0));
  const valid = file.type === 'application/pdf' ? ascii(0, '%PDF-')
    : file.type === 'image/png' ? starts([137, 80, 78, 71, 13, 10, 26, 10])
    : file.type === 'image/jpeg' ? starts([255, 216, 255])
    : ascii(0, 'RIFF') && ascii(8, 'WEBP');
  if (!valid) throw new Error('File signature does not match the selected document type.');
  if (file.type !== 'application/pdf') {
    if (file.size > LIMITS.maxBytes) throw new Error('Image exceeds the 12 MB limit.');
    const bitmap = await (deps.decodeImage || globalThis.createImageBitmap)(file);
    try { return [await encodePage(file, bitmap.width, bitmap.height)]; }
    finally { bitmap.close(); }
  }
  const pdfjs = await (deps.loadPdfjs || (() => import('/vendor/pdfjs/pdf.mjs')))();
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, wasmUrl: '/vendor/pdfjs/wasm/', standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', iccUrl: '/vendor/pdfjs/iccs/' });
  const pages = [];
  let totalBytes = 0;
  try {
    const pdf = await task.promise;
    if (pdf.numPages > LIMITS.maxPages) throw new Error('PDF exceeds the 10 pages limit.');
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: LIMITS.renderScale });
      const canvas = deps.createCanvas ? deps.createCanvas() : document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error(`Could not encode PDF page ${index}.`);
        totalBytes += blob.size;
        if (totalBytes > LIMITS.maxBytes) throw new Error('Rendered PDF page images exceed the total 12 MB limit.');
        pages.push(await encodePage(blob, canvas.width, canvas.height));
      } finally { canvas.width = 0; canvas.height = 0; page.cleanup(); }
    }
    return pages;
  } finally { await task.destroy(); }
}


export function createCompareUI(deps = {}) {
  const doc = deps.document || document;
  const request = deps.fetch || globalThis.fetch.bind(globalThis);
  const prepare = deps.prepareDocument || (file => prepareDocument(file));
  const urls = deps.URL || URL;
  const delay = deps.setTimeout || setTimeout;
  const el = Object.fromEntries(['password', 'document', 'compare-form', 'compare', 'status', 'settings', 'previews', 'baseline', 'candidate', 'differences', 'download'].map(id => [id, doc.getElementById(id)]));
  let file, pages = [], report, previewUrls = [];
  let generation = 0, busy = false, preparing = false;
  const updateControls = () => {
    el.compare.disabled = busy || preparing;
    el.document.disabled = busy;
    el.password.disabled = busy;
  };
  const node = (tag, text, className) => {
    const item = doc.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  };
  const clearResults = () => {
    report = undefined;
    el.download.disabled = true;
    el.baseline.replaceChildren(node('p', 'Waiting for comparison.', 'muted'));
    el.candidate.replaceChildren(node('p', 'Waiting for comparison.', 'muted'));
    el.differences.replaceChildren();
    el.settings.textContent = '';
  };
  const modelSettings = model => `${model.label}: ${model.id} · thinking ${model.thinkingLevel} · max output ${model.maxTokens} tokens`;
  const displayModel = (target, model) => {
    target.replaceChildren(node('h3', model.label), node('p', modelSettings(model), 'metrics'));
    target.append(node('p', `Version ${model.modelVersion ?? 'not reported'} · stop ${model.stopReason ?? 'not reported'}`, 'metrics'));
    const usage = model.usage || {};
    target.append(node('p', `${model.latencyMs ?? '—'} ms · input ${usage.input_tokens ?? '—'} · output ${usage.output_tokens ?? '—'} · thinking ${usage.thinking_tokens ?? '—'} tokens`, 'metrics'));
    target.append(node('p', `Estimated cost: ${typeof model.costUsd === 'number' ? '$' + model.costUsd.toFixed(6) : 'unavailable'}`, 'metrics'));
    if (model.costRates) target.append(node('p', `Rates / million tokens: input $${model.costRates.input}, output $${model.costRates.output} (${model.costRates.source})`, 'metrics'));
    if (model.error) target.append(node('p', model.error, 'error'));
    if (/MAX_TOKENS|LENGTH/i.test(model.stopReason || '')) target.append(node('p', 'Warning: output may be truncated by the token limit.', 'warning'));
    if (!model.text?.trim()) target.append(node('p', 'Warning: empty output. This is not evidence of an empty document.', 'warning'));
    target.append(node('pre', model.text || ''));
  };
  const valueText = value => value === undefined ? 'Not returned' : typeof value === 'string' ? value : JSON.stringify(value);
  const stableValue = value => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])]));
    return value;
  };
  const httpError = async response => {
    const messages = { 401: 'Application password rejected. Check the password.', 403: 'Application password rejected. Check the password.', 404: 'OCR comparison is disabled or unavailable on this server.', 503: 'OCR comparison is not configured on this server (password or provider key missing).' };
    if (messages[response.status]) return new Error(messages[response.status]);
    let detail;
    try { detail = (await response.json()).error; } catch {}
    return new Error(`HTTP ${response.status}${typeof detail === 'string' ? ': ' + detail : ''}`);
  };
  el.document.addEventListener('change', async () => {
    const current = ++generation;
    clearResults();
    previewUrls.forEach(url => urls.revokeObjectURL(url));
    previewUrls = [];
    el.previews.replaceChildren();
    pages = [];
    preparing = false;
    updateControls();
    file = el.document.files[0];
    if (!file) { el.status.textContent = 'Choose a document.'; return; }
    const selectedFile = file;
    preparing = true;
    updateControls();
    el.status.textContent = 'Preparing page images…';
    try {
      const prepared = await prepare(selectedFile);
      if (current !== generation) return;
      pages = prepared;
      pages.forEach((page, index) => {
        const figure = node('figure');
        const image = node('img');
        const url = urls.createObjectURL(page.blob);
        previewUrls.push(url);
        image.src = url;
        image.alt = `Original document page ${index + 1}`;
        figure.append(image, node('figcaption', `Page ${index + 1} · ${page.width} × ${page.height} pixels`));
        el.previews.append(figure);
      });
      el.status.textContent = `${file.name}: ${pages.length} page image(s) ready. Compare to load effective server models.`;
    } catch (error) {
      if (current === generation) el.status.textContent = `Document preparation failed: ${error.message}`;
    } finally {
      if (current === generation) { preparing = false; updateControls(); }
    }
  });
  el['compare-form'].addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || preparing) return;
    if (!file || !pages.length || !el.password.value) { el.status.textContent = 'Choose a valid document and enter the application password.'; return; }
    clearResults();
    const current = generation;
    const selectedFile = file, selectedPages = pages;
    busy = true;
    updateControls();
    el.status.textContent = 'Loading server model settings…';
    const headers = { 'x-app-password': el.password.value };
    try {
      const metadataResponse = await request('/api/ocr-compare', { method: 'GET', headers });
      if (!metadataResponse.ok) throw await httpError(metadataResponse);
      const metadata = await metadataResponse.json();
      if (current !== generation) return;
      if (!Array.isArray(metadata.models) || metadata.models.length !== 2 || metadata.renderScale !== LIMITS.renderScale || !Number.isInteger(metadata.maxPages) || metadata.maxPages < 1 || !Number.isInteger(metadata.maxBytes) || metadata.maxBytes < 1 || metadata.models[0].maxTokens !== metadata.models[1].maxTokens) throw new Error('Unsupported server comparison configuration.');
      if (selectedPages.length > Math.min(LIMITS.maxPages, metadata.maxPages)) throw new Error('Document exceeds the server page limit.');
      const byteCount = selectedPages.reduce((total, page) => total + (page.data.length / 4 * 3 - (page.data.endsWith('==') ? 2 : page.data.endsWith('=') ? 1 : 0)), 0);
      if (byteCount > Math.min(LIMITS.maxBytes, metadata.maxBytes)) throw new Error('Document exceeds the server image byte limit.');
      el.settings.textContent = metadata.models.map(modelSettings).join('\n');
      el.status.textContent = 'Comparing the same page images with both models. No automatic retries.';
      const response = await request('/api/ocr-compare', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: selectedFile.name, pages: selectedPages.map(({ mediaType, data }) => ({ mediaType, data })) }) });
      if (!response.ok) throw await httpError(response);
      const result = await response.json();
      if (current !== generation) return;
      displayModel(el.baseline, result.models[0]);
      displayModel(el.candidate, result.models[1]);
      const [left, right] = result.models.map(model => model.fields || {});
      const failed = result.models.some(model => model.error);
      const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
      for (const key of keys) {
        const row = node('tr');
        const same = JSON.stringify(stableValue(left[key])) === JSON.stringify(stableValue(right[key]));
        if (!same && !failed) row.className = 'different';
        const heading = node('th', key);
        heading.setAttribute('scope', 'row');
        row.append(heading, node('td', result.models[0].error ? 'Unavailable (model failed)' : valueText(left[key])), node('td', result.models[1].error ? 'Unavailable (model failed)' : valueText(right[key])), node('td', failed ? 'Unavailable' : same ? 'Same' : 'Different'));
        el.differences.append(row);
      }
      report = {
        filename: result.filename, pageCount: result.pageCount, inputMode: result.inputMode,
        models: result.models.map(model => Object.fromEntries(['id', 'label', 'thinkingLevel', 'maxTokens', 'text', 'fields', 'usage', 'latencyMs', 'stopReason', 'modelVersion', 'costUsd', 'costRates', 'error'].filter(key => model[key] !== undefined).map(key => [key, model[key]])))
      };
      el.download.disabled = false;
      const failedCount = result.models.filter(model => model.error).length;
      el.status.textContent = failedCount ? `${failedCount} model${failedCount === 1 ? '' : 's'} failed. Independent results are shown; no automatic retry was made.` : 'Comparison complete. Review differences against the original page images.';
    } catch (error) {
      if (current === generation) el.status.textContent = `Comparison failed: ${error.message}. No automatic retry was made.`;
    } finally { busy = false; updateControls(); }
  });
  el.download.addEventListener('click', () => {
    if (!report) return;
    const url = urls.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const link = node('a');
    link.href = url;
    link.download = 'ocr-comparison.json';
    link.click();
    delay(() => urls.revokeObjectURL(url), 1000);
  });
}

if (typeof document !== 'undefined') createCompareUI();
