// PDF text extraction and quality gates for text-first abstraction (lower token cost).

function clampInt(raw, fallback, min, max) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

export function getPdfTextConfig() {
  return {
    enabled: process.env.ABSTRACTION_PDF_TEXT_FIRST !== 'false',
    minCharsPerPage: clampInt(process.env.ABSTRACTION_PDF_TEXT_MIN_CHARS_PER_PAGE, 80, 20, 2000),
    minPrintableRatio: clampNumber(process.env.ABSTRACTION_PDF_TEXT_MIN_PRINTABLE_RATIO, 0.82, 0.5, 1),
    maxBytesPerChar: clampNumber(process.env.ABSTRACTION_PDF_TEXT_MAX_BYTES_PER_CHAR, 800, 50, 5000),
    minSparseCharsPerPage: clampInt(process.env.ABSTRACTION_PDF_TEXT_MIN_SPARSE_CHARS_PER_PAGE, 400, 100, 5000),
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

/**
 * Extract merged plain text from a PDF buffer using unpdf (PDF.js).
 */
export async function extractPdfText(payloadBytes, options = {}) {
  const bytes = normalizeBytes(payloadBytes);
  if (!bytes.length) {
    return { text: '', totalPages: 0, error: 'empty_pdf' };
  }
  try {
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { totalPages, text } = await extractText(pdf, { mergePages: true });
    return {
      text: String(text || '').trim(),
      totalPages: Math.max(0, Number(totalPages) || 0),
    };
  } catch (err) {
    return {
      text: '',
      totalPages: 0,
      error: err?.message || String(err),
    };
  }
}

/**
 * Decide whether extracted text is dense/legible enough to skip visual PDF tokens.
 */
export function assessExtractedPdfText({ text, pageCount, fileSizeBytes }, configOverrides = {}) {
  const config = { ...getPdfTextConfig(), ...configOverrides };
  const trimmed = String(text || '').trim();
  const pages = Math.max(1, Number(pageCount) || 1);
  const sizeBytes = Math.max(0, Number(fileSizeBytes) || 0);

  if (!trimmed.length) {
    return { suitable: false, reason: 'empty_text' };
  }
  if (trimmed.length > config.maxExtractedChars) {
    return { suitable: false, reason: 'text_too_long' };
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

  const bytesPerChar = sizeBytes > 0 ? sizeBytes / trimmed.length : 0;
  if (bytesPerChar > config.maxBytesPerChar && charsPerPage < config.minSparseCharsPerPage) {
    return { suitable: false, reason: 'likely_scanned_image', bytesPerChar, charsPerPage };
  }

  return {
    suitable: true,
    charsPerPage,
    printableRatio,
    bytesPerChar,
    totalChars: trimmed.length,
  };
}

export async function resolvePdfTextDelivery(payloadBytes, options = {}) {
  const config = getPdfTextConfig();
  if (!config.enabled) {
    return { mode: 'visual', reason: 'disabled' };
  }
  const bytes = normalizeBytes(payloadBytes);
  const extracted = await extractPdfText(bytes, options);
  if (extracted.error) {
    return { mode: 'visual', reason: 'extract_failed', error: extracted.error };
  }
  const quality = assessExtractedPdfText({
    text: extracted.text,
    pageCount: extracted.totalPages || 1,
    fileSizeBytes: bytes.byteLength,
  }, config);
  if (!quality.suitable) {
    return {
      mode: 'visual',
      reason: quality.reason,
      quality,
      totalPages: extracted.totalPages,
    };
  }
  return {
    mode: 'text',
    extractedText: extracted.text,
    totalPages: extracted.totalPages,
    quality,
  };
}
