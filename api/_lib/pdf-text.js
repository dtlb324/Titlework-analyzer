
function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function getPdfTextConfig() {
  const strict = process.env.ABSTRACTION_PDF_TEXT_STRICT !== 'false';
  return {
    enabled: process.env.ABSTRACTION_PDF_TEXT_FIRST !== 'false',
    strict,
    minCharsPerPage: clampInt(
      process.env.ABSTRACTION_PDF_TEXT_MIN_CHARS_PER_PAGE,
      strict ? 100 : 80,
      20,
      2000,
    ),
    minPrintableRatio: clampNumber(
      process.env.ABSTRACTION_PDF_TEXT_MIN_PRINTABLE_RATIO,
      strict ? 0.88 : 0.82,
      0.5,
      1,
    ),
    maxBytesPerChar: clampNumber(
      process.env.ABSTRACTION_PDF_TEXT_MAX_BYTES_PER_CHAR,
      strict ? 600 : 800,
      50,
      5000,
    ),
    minSparseCharsPerPage: clampInt(
      process.env.ABSTRACTION_PDF_TEXT_MIN_SPARSE_CHARS_PER_PAGE,
      strict ? 500 : 400,
      100,
      5000,
    ),
    minImagePageCoverage: clampNumber(
      process.env.ABSTRACTION_PDF_MIN_IMAGE_COVERAGE,
      0.01,
      0.001,
      1,
    ),
    minInvisibleOcrRatio: clampNumber(
      process.env.ABSTRACTION_PDF_MIN_INVISIBLE_OCR_RATIO,
      0.35,
      0.05,
      1,
    ),
    maxExtractedChars: clampInt(process.env.ABSTRACTION_PDF_TEXT_MAX_CHARS, 500_000, 10_000, 2_000_000),
  };
}

function clampNumber(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function normalizeBytes(payload) {
  if (Buffer.isBuffer(payload)) return payload;
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  if (payload instanceof ArrayBuffer) return Buffer.from(payload);
  return Buffer.from(String(payload || ''), 'utf8');
}

export async function extractPdfText(payloadBytes) {
  const bytes = normalizeBytes(payloadBytes);
  if (!bytes.length) {
    return { text: '', totalPages: 0, error: 'empty_pdf' };
  }
  try {
    const { extractText, getDocumentProxy, inspectPages } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    try {
      const [extracted, inspected] = await Promise.all([
        extractText(pdf, { mergePages: false }),
        inspectPages(pdf).catch(err => ({ error: err?.message || String(err) })),
      ]);
      const pageTexts = (Array.isArray(extracted.text) ? extracted.text : [extracted.text]).map(page => String(page || '').trim());
      return {
        text: pageTexts.filter(Boolean).join('\n\n'),
        pageTexts,
        pageInspections: Array.isArray(inspected?.pages) ? inspected.pages : null,
        ...(inspected?.error ? { inspectionError: inspected.error } : {}),
        totalPages: Math.max(0, Number(extracted.totalPages) || pageTexts.length || 0),
      };
    } finally {
      await pdf.loadingTask.destroy().catch(() => {});
    }
  } catch (err) {
    return {
      text: '',
      totalPages: 0,
      error: err?.message || String(err),
    };
  }
}

export function analyzeOcrNoise(text, configOverrides = {}) {
  const config = { ...getPdfTextConfig(), ...configOverrides };
  const trimmed = String(text || '').trim();
  const replacementCount = (trimmed.match(/\uFFFD/g) || []).length;
  if (replacementCount >= 1) {
    return { noisy: true, reason: 'ocr_replacement_chars', replacementCount };
  }
  const rawTokens = trimmed ? trimmed.split(/\s+/).filter(Boolean) : [];
  if (!rawTokens.length) {
    return { noisy: false, garbledTokens: 0, garbledRatio: 0, fragmentedTokens: 0, weirdSymbolRatio: 0 };
  }

  let fragmentedTokens = 0;
  let garbledTokens = 0;
  for (const rawToken of rawTokens) {
    if (/^[b-z]$/.test(rawToken) || /^[~`^|\\]$/.test(rawToken)) {
      fragmentedTokens += 1;
    }
    const clean = rawToken.replace(/^[\s"'`“”‘’()\[\]{}<>.,;:!?—–\-]+|[\s"'`“”‘’()\[\]{}<>.,;:!?—–\-]+$/g, '');
    if (!clean) continue;
    if (
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)
      || /^https?:\/\//i.test(clean)
      || /^[TR]\d{1,2}[NSEW]$/i.test(clean)
      || /^(?:H2S|CO2|W2|B2B|2D|3D|4G|5G)$/i.test(clean)
    ) {
      continue;
    }
    if (
      /^[lIoO]\/\d+(?:st|nd|rd|th|ths)?$/.test(clean)
      || /^\d+\/[lIoO]\d*(?:st|nd|rd|th|ths)?$/.test(clean)
      || /^l\d+(?:st|nd|rd|th|ths)?$/.test(clean)
      || /^\d+l\d*$/.test(clean)
      || /^\d+I\d*$/.test(clean)
      || /^I\d{3,}$/.test(clean)
      || /^\d+[Oo]\d+$/.test(clean)
      || /^[lI][Oo]\d+$/.test(clean)
      || /^[Oo]\d{2,}$/.test(clean)
      || /^\d{2,}[Oo]$/.test(clean)
      || (clean.length >= 3 && /^[A-Za-z]+[013456789][A-Za-z]+$/.test(clean))
      || /[A-Za-z][~`^|@*\\][A-Za-z]/.test(clean)
    ) {
      garbledTokens += 1;
    }
  }

  const nonWs = trimmed.replace(/\s+/g, '');
  const weirdSymbols = (nonWs.match(/[~`^|\\{}<>]/g) || []).length;
  const weirdSymbolRatio = nonWs.length ? weirdSymbols / nonWs.length : 0;

  const totalTokens = rawTokens.length;
  const garbledRatio = garbledTokens / totalTokens;
  const fragmentedRatio = fragmentedTokens / totalTokens;
  const minGarbledTokens = config.strict ? 2 : 3;
  const minGarbledRatio = config.strict ? 0.005 : 0.01;

  if (
    (garbledTokens >= minGarbledTokens && garbledRatio >= minGarbledRatio)
    || garbledTokens >= 5
    || (fragmentedTokens >= 12 && fragmentedRatio >= 0.12)
    || weirdSymbolRatio > (config.strict ? 0.03 : 0.05)
  ) {
    return {
      noisy: true,
      reason: 'noisy_ocr_text',
      garbledTokens,
      garbledRatio,
      fragmentedTokens,
      weirdSymbolRatio,
    };
  }

  return {
    noisy: false,
    garbledTokens,
    garbledRatio,
    fragmentedTokens,
    weirdSymbolRatio,
  };
}

export function assessExtractedPdfText({ text, pageCount, fileSizeBytes, pageTexts, pageInspections }, configOverrides = {}) {
  const config = { ...getPdfTextConfig(), ...configOverrides };
  const pagesFromExtract = Array.isArray(pageTexts)
    ? pageTexts.map(page => String(page || '').trim())
    : null;
  const inspections = Array.isArray(pageInspections) ? pageInspections : null;
  const trimmed = String(text || '').trim();
  const pages = Math.max(1, pagesFromExtract?.length || inspections?.length || Number(pageCount) || 1);
  const sizeBytes = Math.max(0, Number(fileSizeBytes) || 0);

  if (!trimmed.length) {
    return { suitable: false, reason: 'empty_text' };
  }
  if (trimmed.length > config.maxExtractedChars) {
    return { suitable: false, reason: 'text_too_long' };
  }

  const densePageIndexes = [];
  const sparsePageIndexes = [];
  const imageBackedPageIndexes = [];
  const invisibleOcrPageIndexes = [];
  const noisyOcrPageIndexes = [];
  const lowPrintablePageIndexes = [];
  const visualPageIndexes = [];
  let firstNoisyReason = null;

  const totalInspectPages = Math.max(pagesFromExtract?.length || 0, inspections?.length || 0);
  if (totalInspectPages > 0) {
    for (let index = 0; index < totalInspectPages; index++) {
      const page = pagesFromExtract ? (pagesFromExtract[index] ?? '') : null;
      const insp = inspections ? inspections[index] : null;
      const isSparse = page !== null && page.length < config.minCharsPerPage;
      const invisibleLength = Number(insp?.invisibleTextLength) || 0;
      const inspTextLength = Number(insp?.textLength) || 0;
      const invisibleRatio = inspTextLength > 0 ? Math.min(1, invisibleLength / inspTextLength) : 0;
      const hasInvisibleOcr = Boolean(insp && invisibleLength >= 20 && invisibleRatio >= config.minInvisibleOcrRatio);
      const hasVisualImage = Boolean(insp && (Number(insp.imageCount) || 0) > 0 && (Number(insp.imageCoverage) || 0) >= config.minImagePageCoverage);
      const pagePrintableRatio = page && page.length
        ? ((page.match(/[\x09\x0a\x0d\x20-\x7e]/g) || []).length / page.length)
        : 1;
      const hasLowPrintable = page !== null && page.length > 0 && pagePrintableRatio < config.minPrintableRatio;
      const pageNoise = page && page.length >= config.minCharsPerPage ? analyzeOcrNoise(page, config) : null;
      const hasNoisyOcr = Boolean(pageNoise?.noisy);

      if (isSparse) {
        sparsePageIndexes.push(index);
        visualPageIndexes.push(index);
      } else if (hasInvisibleOcr || hasVisualImage) {
        if (hasInvisibleOcr) invisibleOcrPageIndexes.push(index);
        if (hasVisualImage) imageBackedPageIndexes.push(index);
        visualPageIndexes.push(index);
      } else if (hasLowPrintable) {
        lowPrintablePageIndexes.push(index);
        visualPageIndexes.push(index);
      } else if (hasNoisyOcr) {
        if (!firstNoisyReason) firstNoisyReason = pageNoise.reason;
        noisyOcrPageIndexes.push(index);
        visualPageIndexes.push(index);
      } else {
        densePageIndexes.push(index);
      }
    }

    if (visualPageIndexes.length > 0) {
      let reason = firstNoisyReason || 'noisy_ocr_text';
      if (imageBackedPageIndexes.length > 0) reason = 'image_backed_pages';
      else if (invisibleOcrPageIndexes.length > 0) reason = 'invisible_ocr_layer';
      else if (sparsePageIndexes.length > 0) reason = 'blank_or_sparse_pages';
      else if (lowPrintablePageIndexes.length > 0) reason = 'low_printable_ratio';
      return {
        suitable: false,
        reason,
        sparsePages: sparsePageIndexes.length,
        densePages: densePageIndexes.length,
        visualPages: visualPageIndexes.length,
        sparsePageIndexes,
        densePageIndexes,
        imageBackedPageIndexes,
        invisibleOcrPageIndexes,
        noisyOcrPageIndexes,
        visualPageIndexes,
        pageCount: totalInspectPages,
        coverage: densePageIndexes.length / totalInspectPages,
      };
    }
  }

  const charsPerPage = trimmed.length / pages;
  if (charsPerPage < config.minCharsPerPage) {
    return { suitable: false, reason: 'sparse_text', charsPerPage };
  }

  const printable = (trimmed.match(/[\x09\x0a\x0d\x20-\x7e]/g) || []).length;
  const printableRatio = printable / trimmed.length;
  if (printableRatio < config.minPrintableRatio) {
    return { suitable: false, reason: 'low_printable_ratio', printableRatio };
  }

  const ocrNoise = analyzeOcrNoise(trimmed, config);
  if (ocrNoise.noisy) {
    return { suitable: false, ...ocrNoise };
  }

  const bytesPerChar = sizeBytes > 0 ? sizeBytes / trimmed.length : 0;
  if (bytesPerChar > config.maxBytesPerChar) {
    return { suitable: false, reason: 'likely_scanned_image', bytesPerChar, charsPerPage };
  }

  if (config.strict && bytesPerChar > config.maxBytesPerChar * 0.75 && charsPerPage < config.minSparseCharsPerPage) {
    return { suitable: false, reason: 'strict_likely_scanned', bytesPerChar, charsPerPage };
  }

  return {
    suitable: true,
    charsPerPage,
    printableRatio,
    bytesPerChar,
    totalChars: trimmed.length,
    densePageIndexes: densePageIndexes.length ? densePageIndexes : null,
    sparsePageIndexes: sparsePageIndexes.length ? sparsePageIndexes : null,
  };
}

export async function extractPdfPageSubset(payloadBytes, pageIndexesZeroBased) {
  const indexes = [...new Set((pageIndexesZeroBased || []).map(index => Number(index)).filter(index => Number.isInteger(index) && index >= 0))];
  if (!indexes.length) {
    throw new Error('No PDF pages requested.');
  }
  const { PDFDocument } = await import('pdf-lib');
  const source = await PDFDocument.load(normalizeBytes(payloadBytes), { ignoreEncryption: true });
  // pdf-lib cannot decrypt: copied pages would keep encrypted streams without the key and render blank.
  if (source.isEncrypted) throw new Error('Encrypted PDF pages cannot be copied into a subset.');
  const pageCount = source.getPageCount();
  const valid = indexes.filter(index => index < pageCount);
  if (!valid.length) {
    throw new Error('Requested PDF pages are out of range.');
  }
  const child = await PDFDocument.create();
  const pages = await child.copyPages(source, valid);
  for (const page of pages) child.addPage(page);
  return Buffer.from(await child.save());
}

function labeledExtractedPages(pageTexts, densePageIndexes, pageStart) {
  const start = Math.max(1, Number(pageStart) || 1);
  return densePageIndexes.map(index => {
    const pageNo = start + index;
    return `----- PAGE ${pageNo} (extracted text) -----\n${pageTexts[index]}`;
  }).join('\n\n');
}

export function estimatePdfPlanningPayloadBytes(sizeBytes, options = {}) {
  const size = Math.max(0, Number(sizeBytes) || 0);
  if (!size) return 500;
  const textFirstEnabled = options.textFirstEnabled !== false
    && (options.textFirstEnabled === true || getPdfTextConfig().enabled);
  const largePdfMin = options.largePdfMinBytes ?? options.geminiFileMinBytes ?? 1_500_000;
  if (!textFirstEnabled || size >= largePdfMin) {
    return Math.ceil(size * 1.37);
  }
  return Math.min(Math.floor(size * 0.12) + 8_000, 400_000);
}

export async function resolvePdfTextDelivery(payloadBytes, options = {}) {
  const config = getPdfTextConfig();
  if (!config.enabled) {
    return { mode: 'visual', reason: 'disabled' };
  }
  const bytes = normalizeBytes(payloadBytes);
  const extracted = await extractPdfText(bytes);
  if (extracted.error) {
    return { mode: 'visual', reason: 'extract_failed', error: extracted.error };
  }
  if (extracted.inspectionError) {
    return {
      mode: 'visual',
      reason: 'page_inspection_failed',
      error: extracted.inspectionError,
      totalPages: extracted.totalPages,
    };
  }
  const quality = assessExtractedPdfText({
    text: extracted.text,
    pageCount: extracted.totalPages || 1,
    fileSizeBytes: bytes.byteLength,
    pageTexts: extracted.pageTexts,
    pageInspections: extracted.pageInspections,
  }, config);
  if (quality.suitable) {
    return {
      mode: 'text',
      extractedText: extracted.text,
      totalPages: extracted.totalPages,
      quality,
    };
  }

  const densePageIndexes = quality.densePageIndexes || [];
  const visualPageIndexes = quality.visualPageIndexes || quality.sparsePageIndexes || [];
  if (densePageIndexes.length > 0 && visualPageIndexes.length > 0 && Array.isArray(extracted.pageTexts) && extracted.pageTexts.length) {
    try {
      const visualBytes = await extractPdfPageSubset(bytes, visualPageIndexes);
      const pageStart = Math.max(1, Number(options.pageStart) || 1);
      const visualPages = visualPageIndexes.map(index => pageStart + index);
      return {
        mode: 'hybrid',
        reason: quality.reason,
        extractedText: labeledExtractedPages(extracted.pageTexts, densePageIndexes, pageStart),
        visualBytes,
        visualPages,
        sparsePages: visualPages,
        densePages: densePageIndexes.map(index => pageStart + index),
        totalPages: extracted.totalPages,
        quality,
      };
    } catch (err) {
      return {
        mode: 'visual',
        reason: 'hybrid_subset_failed',
        error: err?.message || String(err),
        quality,
        totalPages: extracted.totalPages,
      };
    }
  }

  return {
    mode: 'visual',
    reason: quality.reason,
    quality,
    totalPages: extracted.totalPages,
  };
}
