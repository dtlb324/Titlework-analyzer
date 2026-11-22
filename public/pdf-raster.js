export const PDF_RASTER_LIMITS = { maxPages: 60, maxBytes: 12000000, renderScale: 2 };

async function encodePage(blob, width, height) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  return { mediaType: blob.type, data: btoa(binary), blob, width, height };
}

const JPEG_QUALITIES = [0.92, 0.85, 0.75, 0.65, 0.55, 0.45];

async function encodeRenderedPage(canvas, index, png, deficit) {
  const toBlob = (type, quality) => new Promise(resolve => canvas.toBlob(resolve, type, quality));
  if (!png) {
    const blob = await toBlob('image/png');
    if (!blob) throw new Error(`Could not encode PDF page ${index}.`);
    return blob;
  }
  let smallest = png;
  for (const quality of JPEG_QUALITIES) {
    const jpeg = await toBlob('image/jpeg', quality);
    if (jpeg && jpeg.size < smallest.size) smallest = jpeg;
    if (png.size - smallest.size >= deficit) return smallest;
  }
  return smallest;
}

export async function prepareDocument(file, deps = {}) {
  const allowed = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
  if (!allowed.includes(file.type)) throw new Error('Choose a PDF, PNG, JPEG or WebP file.');
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const starts = signature => signature.every((value, index) => head[index] === value);
  const ascii = (offset, value) => [...value].every((char, index) => head[offset + index] === char.charCodeAt(0));
  // PDF readers tolerate leading bytes before the header, and intake accepts %PDF- anywhere in the first 1 KB.
  const valid = file.type === 'application/pdf' ? new TextDecoder('latin1').decode(head).includes('%PDF-')
    : file.type === 'image/png' ? starts([137, 80, 78, 71, 13, 10, 26, 10])
    : file.type === 'image/jpeg' ? starts([255, 216, 255])
    : ascii(0, 'RIFF') && ascii(8, 'WEBP');
  if (!valid) throw new Error('File signature does not match the selected document type.');
  if (file.type !== 'application/pdf') {
    if (file.size > PDF_RASTER_LIMITS.maxBytes) throw new Error('Image exceeds the 12 MB limit.');
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
    if (pdf.numPages > PDF_RASTER_LIMITS.maxPages) throw new Error(`PDF exceeds the ${PDF_RASTER_LIMITS.maxPages} pages limit.`);
    const renderPage = async (index, png, deficit) => {
      const page = await pdf.getPage(index);
      let canvas;
      try {
        const viewport = page.getViewport({ scale: PDF_RASTER_LIMITS.renderScale });
        canvas = deps.createCanvas ? deps.createCanvas() : document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvasContext: canvas.getContext('2d'), viewport, background: '#ffffff' }).promise;
        const blob = await encodeRenderedPage(canvas, index, png, deficit);
        return { blob, width: canvas.width, height: canvas.height };
      } finally { if (canvas) { canvas.width = 0; canvas.height = 0; } page.cleanup(); }
    };
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await renderPage(index);
      pages.push(page);
      totalBytes += page.blob.size;
    }
    if (totalBytes > PDF_RASTER_LIMITS.maxBytes) {
      const largestFirst = pages.map((page, index) => index).sort((a, b) => pages[b].blob.size - pages[a].blob.size || a - b);
      for (const index of largestFirst) {
        const png = pages[index].blob;
        const page = await renderPage(index + 1, png, totalBytes - PDF_RASTER_LIMITS.maxBytes);
        totalBytes += page.blob.size - png.size;
        pages[index] = page;
        if (totalBytes <= PDF_RASTER_LIMITS.maxBytes) break;
      }
      if (totalBytes > PDF_RASTER_LIMITS.maxBytes) throw new Error('Rendered PDF page images exceed the total 12 MB limit.');
    }
    const encoded = [];
    for (const page of pages) encoded.push(await encodePage(page.blob, page.width, page.height));
    return encoded;
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
