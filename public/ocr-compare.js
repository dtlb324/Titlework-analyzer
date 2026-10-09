import { assessAccuracy, scoreModel } from './ocr-accuracy.js';

const LIMITS = { maxPages: 10, maxBytes: 12000000, renderScale: 2 };
const MODEL_COUNT = 3;
const MAX_FILES = 10;

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

export async function readDocumentText(file, deps = {}) {
  if (file?.type !== 'application/pdf') return '';
  const pdfjs = await (deps.loadPdfjs || (() => import('/vendor/pdfjs/pdf.mjs')))();
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false, wasmUrl: '/vendor/pdfjs/wasm/', standardFontDataUrl: '/vendor/pdfjs/standard_fonts/', iccUrl: '/vendor/pdfjs/iccs/' });
  try {
    const pdf = await task.promise;
    const pages = [];
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      try {
        const content = await page.getTextContent();
        pages.push((content.items || []).map(item => item?.str ?? '').join(' '));
      } finally { page.cleanup(); }
    }
    return pages.join('\n').trim();
  } finally { await task.destroy(); }
}


export function createCompareUI(deps = {}) {
  const doc = deps.document || document;
  const request = deps.fetch || globalThis.fetch.bind(globalThis);
  const prepare = deps.prepareDocument || (file => prepareDocument(file));
  const urls = deps.URL || URL;
  const delay = deps.setTimeout || setTimeout;
  const el = Object.fromEntries(['password', 'document', 'compare-form', 'compare', 'status', 'settings', 'previews', 'baseline', 'candidate', 'challenger', 'differences', 'download', 'batch', 'accuracy-rank', 'accuracy-note'].map(id => [id, doc.getElementById(id)]));
  // One entry per selected file: { file, pages, status, message, result }.
  // status: preparing | ready | error | running | done | failed | skipped
  let entries = [], selected = 0, report, previewUrls = [];
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
  const waiting = () => node('p', 'Waiting for comparison.', 'muted');
  const modelSettings = model => `${model.label}: ${model.id} · thinking ${model.thinkingLevel} · max output ${model.maxTokens} tokens`;
  const accuracyText = accuracy => {
    if (accuracy.status === 'scored') return `Document accuracy: ${accuracy.percent}% (${accuracy.matched} of ${accuracy.scored} fields found in the document).`;
    if (accuracy.reason === 'no-document-text') return 'Document accuracy: no embedded text in this document.';
    if (accuracy.reason === 'model-failed') return 'Document accuracy: not scored (model failed).';
    return 'Document accuracy: no transcribed fields to score.';
  };
  const displayModel = (target, model, documentText) => {
    target.replaceChildren(node('h3', model.label), node('p', modelSettings(model), 'metrics'));
    target.append(node('p', `Version ${model.modelVersion ?? 'not reported'} · stop ${model.stopReason ?? 'not reported'}`, 'metrics'));
    const usage = model.usage || {};
    target.append(node('p', `${model.latencyMs ?? '—'} ms · input ${usage.input_tokens ?? '—'} · output ${usage.output_tokens ?? '—'} · thinking ${usage.thinking_tokens ?? '—'} tokens`, 'metrics'));
    target.append(node('p', `Estimated cost: ${typeof model.costUsd === 'number' ? '$' + model.costUsd.toFixed(6) : 'unavailable'}`, 'metrics'));
    target.append(node('p', accuracyText(scoreModel(documentText, model)), 'metrics'));
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
  const totalCost = result => {
    const costs = result.models.map(model => model.costUsd);
    return costs.every(cost => typeof cost === 'number') ? costs.reduce((sum, cost) => sum + cost, 0) : null;
  };
  const statusText = entry => ({
    preparing: 'Preparing…', ready: 'Ready', running: 'Running…', done: 'Done', skipped: 'Not run',
    error: `Cannot compare: ${entry.message}`, failed: `Failed: ${entry.message}`,
  })[entry.status];

  const renderBatch = () => {
    el.batch.replaceChildren();
    entries.forEach((entry, index) => {
      const row = node('tr');
      if (index === selected) row.className = 'selected';
      const name = node('th', entry.file.name);
      name.setAttribute('scope', 'row');
      const failures = entry.result ? entry.result.models.filter(model => model.error).length : null;
      const cost = entry.result ? totalCost(entry.result) : null;
      const view = node('button', 'View');
      view.setAttribute('type', 'button');
      view.disabled = busy && !entry.result;
      view.addEventListener('click', () => showFile(index));
      row.append(name, node('td', entry.pages ? String(entry.pages.length) : '—'), node('td', statusText(entry)), node('td', failures === null ? '—' : String(failures)), node('td', cost === null ? (entry.result ? 'unavailable' : '—') : '$' + cost.toFixed(6)), node('td'));
      row.children[5].append(view);
      el.batch.append(row);
    });
    renderAccuracy();
  };
  const renderAccuracy = () => {
    const { ranking } = assessAccuracy(entries.map(entry => ({ filename: entry.file.name, documentText: entry.documentText, models: entry.result?.models })));
    el['accuracy-rank'].replaceChildren();
    if (!ranking.rows.length) {
      el['accuracy-note'].textContent = 'Accuracy is the share of transcribed fields found in the document\'s own text. Scans without embedded text have no score. Field differences below are still not accuracy.';
      return;
    }
    const count = ranking.documentCount;
    el['accuracy-note'].textContent = `Ranked on ${count} document${count === 1 ? '' : 's'}. The percent is transcribed fields found in the document text.`;
    for (const row of ranking.rows) {
      const tr = node('tr');
      tr.append(node('td', String(row.rank)), node('td', row.label), node('td', `${row.percent}% (${row.matched} of ${row.scored} fields)`));
      el['accuracy-rank'].append(tr);
    }
  };
  const clearPreviews = () => {
    previewUrls.forEach(url => urls.revokeObjectURL(url));
    previewUrls = [];
    el.previews.replaceChildren();
  };
  const renderPreviews = () => {
    clearPreviews();
    (entries[selected]?.pages || []).forEach((page, index) => {
      const figure = node('figure');
      const image = node('img');
      const url = urls.createObjectURL(page.blob);
      previewUrls.push(url);
      image.src = url;
      image.alt = `Original document page ${index + 1}`;
      figure.append(image, node('figcaption', `Page ${index + 1} · ${page.width} × ${page.height} pixels`));
      el.previews.append(figure);
    });
  };
  const renderResult = () => {
    const result = entries[selected]?.result;
    el.differences.replaceChildren();
    if (!result) {
      for (const target of [el.baseline, el.candidate, el.challenger]) target.replaceChildren(waiting());
      return;
    }
    [el.baseline, el.candidate, el.challenger].forEach((target, index) => displayModel(target, result.models[index], entries[selected]?.documentText));
    const fieldSets = result.models.map(model => model.fields || {});
    const failed = result.models.some(model => model.error);
    const keys = [...new Set(fieldSets.flatMap(fields => Object.keys(fields)))].sort();
    for (const key of keys) {
      const row = node('tr');
      const serialized = fieldSets.map(fields => JSON.stringify(stableValue(fields[key])));
      const same = serialized.every(value => value === serialized[0]);
      if (!same && !failed) row.className = 'different';
      const heading = node('th', key);
      heading.setAttribute('scope', 'row');
      row.append(heading, ...result.models.map((model, index) => node('td', model.error ? 'Unavailable (model failed)' : valueText(fieldSets[index][key]))), node('td', failed ? 'Unavailable' : same ? 'Same' : 'Different'));
      el.differences.append(row);
    }
  };
  function showFile(index) {
    if (!entries[index]) return;
    selected = index;
    renderBatch();
    renderPreviews();
    renderResult();
  }
  const clearResults = () => {
    report = undefined;
    el.download.disabled = true;
    el.settings.textContent = '';
    entries.forEach(entry => { delete entry.result; if (entry.status !== 'error' && entry.status !== 'preparing') { entry.status = 'ready'; delete entry.message; } });
    renderBatch();
    renderResult();
  };

  el.document.addEventListener('change', async () => {
    const current = ++generation;
    report = undefined;
    el.download.disabled = true;
    el.settings.textContent = '';
    clearPreviews();
    entries = [];
    selected = 0;
    renderBatch();
    renderResult();
    preparing = false;
    updateControls();
    const files = Array.from(el.document.files || []);
    if (!files.length) { el.status.textContent = 'Choose a document.'; return; }
    if (files.length > MAX_FILES) { el.status.textContent = `Choose at most ${MAX_FILES} files (you selected ${files.length}).`; return; }
    entries = files.map(file => ({ file, status: 'preparing' }));
    renderBatch();
    preparing = true;
    updateControls();
    try {
      for (let index = 0; index < entries.length; index++) {
        el.status.textContent = files.length === 1 ? 'Preparing page images…' : `Preparing page images… file ${index + 1} of ${files.length}`;
        const entry = entries[index];
        try {
          const pages = await prepare(entry.file);
          if (current !== generation) return;
          let documentText = '';
          try { documentText = await readDocumentText(entry.file, deps); }
          catch { documentText = ''; }
          if (current !== generation) return;
          entry.pages = pages;
          entry.documentText = documentText;
          entry.status = 'ready';
        } catch (error) {
          if (current !== generation) return;
          entry.status = 'error';
          entry.message = error.message;
        }
        if (index === 0) renderPreviews();
        renderBatch();
      }
      const ready = entries.filter(entry => entry.status === 'ready');
      const unusable = entries.length - ready.length;
      if (entries.length === 1) {
        el.status.textContent = unusable ? `Document preparation failed: ${entries[0].message}` : `${entries[0].file.name}: ${ready[0].pages.length} page image(s) ready. Compare to load effective server models.`;
      } else if (!ready.length) {
        el.status.textContent = 'None of the selected files could be prepared. See the file list for details.';
      } else {
        const pageTotal = ready.reduce((sum, entry) => sum + entry.pages.length, 0);
        el.status.textContent = `${ready.length} of ${entries.length} files ready (${pageTotal} page images)${unusable ? `; ${unusable} cannot be compared` : ''}. Each file is compared separately and makes 3 billable model calls (${ready.length * 3} in total). Compare to load effective server models.`;
      }
    } finally {
      if (current === generation) { preparing = false; updateControls(); }
    }
  });

  el['compare-form'].addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || preparing) return;
    if (!entries.some(entry => entry.status === 'ready') || !el.password.value) { el.status.textContent = 'Choose a valid document and enter the application password.'; return; }
    clearResults();
    const current = generation;
    const runnable = entries.filter(entry => entry.status === 'ready');
    busy = true;
    updateControls();
    el.status.textContent = 'Loading server model settings…';
    const headers = { 'x-app-password': el.password.value };
    try {
      const metadataResponse = await request('/api/ocr-compare', { method: 'GET', headers });
      if (!metadataResponse.ok) throw await httpError(metadataResponse);
      const metadata = await metadataResponse.json();
      if (current !== generation) return;
      if (!Array.isArray(metadata.models) || metadata.models.length !== MODEL_COUNT || metadata.renderScale !== LIMITS.renderScale || !Number.isInteger(metadata.maxPages) || metadata.maxPages < 1 || !Number.isInteger(metadata.maxBytes) || metadata.maxBytes < 1 || metadata.models.some(model => model.maxTokens !== metadata.models[0].maxTokens)) throw new Error('Unsupported server comparison configuration.');
      for (const entry of runnable) {
        if (entry.pages.length > Math.min(LIMITS.maxPages, metadata.maxPages)) throw new Error(`${entry.file.name}: document exceeds the server page limit.`);
        const byteCount = entry.pages.reduce((total, page) => total + (page.data.length / 4 * 3 - (page.data.endsWith('==') ? 2 : page.data.endsWith('=') ? 1 : 0)), 0);
        if (byteCount > Math.min(LIMITS.maxBytes, metadata.maxBytes)) throw new Error(`${entry.file.name}: document exceeds the server image byte limit.`);
      }
      el.settings.textContent = metadata.models.map(modelSettings).join('\n');
      let halted = null;
      for (const entry of runnable) {
        if (halted) { entry.status = 'skipped'; continue; }
        entry.status = 'running';
        const position = entries.indexOf(entry);
        const changed = position !== selected;
        selected = position;
        renderBatch();
        if (changed) renderPreviews();
        renderResult();
        el.status.textContent = runnable.length === 1
          ? 'Comparing the same page images with all three models. No automatic retries.'
          : `Comparing ${entry.file.name} (${runnable.indexOf(entry) + 1} of ${runnable.length}) with all three models. No automatic retries.`;
        try {
          const response = await request('/api/ocr-compare', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: entry.file.name, pages: entry.pages.map(({ mediaType, data }) => ({ mediaType, data })) }) });
          if (!response.ok) throw await httpError(response);
          const result = await response.json();
          if (current !== generation) return;
          if (!Array.isArray(result.models) || result.models.length !== MODEL_COUNT) throw new Error('Unexpected number of model results.');
          entry.result = result;
          entry.status = 'done';
        } catch (error) {
          if (current !== generation) return;
          entry.status = 'failed';
          entry.message = error.message;
          halted = entry;
        }
        renderBatch();
        renderResult();
      }
      if (current !== generation) return;
      const done = entries.filter(entry => entry.status === 'done');
      const modelRecord = (model, documentText) => {
        const record = Object.fromEntries(['id', 'label', 'thinkingLevel', 'maxTokens', 'text', 'fields', 'usage', 'latencyMs', 'stopReason', 'modelVersion', 'costUsd', 'costRates', 'error'].filter(key => model[key] !== undefined).map(key => [key, model[key]]));
        const accuracy = scoreModel(documentText, model);
        if (accuracy.status === 'scored') record.accuracy = { matched: accuracy.matched, scored: accuracy.scored, percent: accuracy.percent };
        return record;
      };
      report = { files: done.map(entry => ({
        filename: entry.result.filename, pageCount: entry.result.pageCount, inputMode: entry.result.inputMode,
        models: entry.result.models.map(model => modelRecord(model, entry.documentText)),
      })) };
      el.download.disabled = !done.length;
      renderBatch();
      if (halted) {
        const skipped = entries.filter(entry => entry.status === 'skipped').length;
        el.status.textContent = `Comparison failed: ${halted.message}. No automatic retry was made. ${done.length} of ${runnable.length} file${runnable.length === 1 ? '' : 's'} completed${skipped ? `; ${skipped} not run` : ''}.`;
        return;
      }
      const failedCount = done.reduce((sum, { result }) => sum + result.models.filter(model => model.error).length, 0);
      const costs = done.map(({ result }) => totalCost(result));
      const costNote = done.length > 1 && costs.every(cost => cost !== null) ? ` Estimated total cost $${costs.reduce((sum, cost) => sum + cost, 0).toFixed(6)}.` : '';
      el.status.textContent = failedCount
        ? `${failedCount} model${failedCount === 1 ? '' : 's'} failed. Independent results are shown; no automatic retry was made.${costNote}`
        : done.length > 1 ? `Comparison complete for ${done.length} files. Select a file to review its differences against the original page images.${costNote}` : 'Comparison complete. Review differences against the original page images.';
    } catch (error) {
      if (current === generation) el.status.textContent = `Comparison failed: ${error.message}. No automatic retry was made.`;
    } finally { busy = false; updateControls(); if (current === generation) renderBatch(); }
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
