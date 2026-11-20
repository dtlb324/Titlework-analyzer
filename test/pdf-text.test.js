import { PDFDocument, PDFNumber, PDFOperator, StandardFonts } from 'pdf-lib';
import { deflateSync } from 'zlib';
import {
  assessExtractedPdfText,
  estimatePdfPlanningPayloadBytes,
  extractPdfText,
  getPdfTextConfig,
  resolvePdfTextDelivery,
} from '../api/_lib/pdf-text.js';

function makePng(width = 4, height = 4) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  function crc32(buf) {
    let crc = 0xffffffff;
    for (const byte of buf) {
      crc ^= byte;
      for (let k = 0; k < 8; k++) {
        crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }
  function chunk(type, data) {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height, 128);
  for (let y = 0; y < height; y++) raw[y * (width * 3 + 1)] = 0;
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('assessExtractedPdfText accepts dense legible text', () => {
  const text = Array.from({ length: 12 }, (_, i) => `GRANTOR: Party ${i}\nGRANTEE: Party ${i + 1}\nLEGAL DESC: Section ${i}`).join('\n\n');
  const quality = assessExtractedPdfText({ text, pageCount: 4, fileSizeBytes: 120_000 });
  assert(quality.suitable === true, `Expected suitable text, got ${quality.reason}`);
  assert(quality.charsPerPage > 80, 'Expected reasonable chars per page');
});

test('assessExtractedPdfText rejects empty and sparse extraction', () => {
  const empty = assessExtractedPdfText({ text: '', pageCount: 3, fileSizeBytes: 500_000 });
  assert(empty.suitable === false && empty.reason === 'empty_text', 'Expected empty rejection');

  const sparse = assessExtractedPdfText({ text: 'x', pageCount: 5, fileSizeBytes: 900_000 });
  assert(sparse.suitable === false, 'Expected sparse rejection');
});

test('assessExtractedPdfText flags mixed dense and blank pages without forcing full-doc visual', () => {
  const dense = 'GRANTOR: Party A\nGRANTEE: Party B\nLEGAL DESC: Section 1\n'.repeat(20);
  const quality = assessExtractedPdfText({
    text: dense,
    pageCount: 2,
    fileSizeBytes: 80_000,
    pageTexts: [dense, ''],
  });
  assert(quality.suitable === false && quality.reason === 'blank_or_sparse_pages', 'Expected blank-page flag');
  assert(quality.densePages === 1 && quality.sparsePages === 1, 'Expected mixed dense/sparse counts');
});

test('assessExtractedPdfText rejects likely scanned image PDFs', () => {
  const text = 'GRANTOR: JOHN DOE; GRANTEE: JANE DOE; '.repeat(40);
  const scanned = assessExtractedPdfText({ text, pageCount: 4, fileSizeBytes: 1_500_000 });
  assert(scanned.suitable === false && scanned.reason === 'likely_scanned_image', 'Expected scanned-image rejection');
});

test('resolvePdfTextDelivery stays visual when disabled', async () => {
  const previous = process.env.ABSTRACTION_PDF_TEXT_FIRST;
  process.env.ABSTRACTION_PDF_TEXT_FIRST = 'false';
  const delivery = await resolvePdfTextDelivery(Buffer.from('%PDF-1.4\n'));
  if (previous === undefined) delete process.env.ABSTRACTION_PDF_TEXT_FIRST;
  else process.env.ABSTRACTION_PDF_TEXT_FIRST = previous;
  assert(delivery.mode === 'visual', 'Expected visual mode when text-first disabled');
});

test('extractPdfText reads text from a generated pdf-lib document', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const body = 'STATE OF TEXAS\nCOUNTY OF REEVES\n\nGRANTOR: JOHN DOE\nGRANTEE: JANE DOE\n';
  page.drawText(body.repeat(8), { x: 72, y: 700, size: 11, font, lineHeight: 14, maxWidth: 460 });
  const bytes = Buffer.from(await doc.save());
  const extracted = await extractPdfText(bytes);
  assert(!extracted.error, `Expected extraction without error, got ${extracted.error}`);
  assert(extracted.text.includes('GRANTOR: JOHN DOE'), 'Expected grantor line in extracted text');

  const delivery = await resolvePdfTextDelivery(bytes);
  assert(delivery.mode === 'text', `Expected text delivery for typed PDF, got ${delivery.mode} (${delivery.reason || ''})`);
  assert(delivery.extractedText.includes('GRANTEE: JANE DOE'), 'Expected grantee in delivery text');
});

test('resolvePdfTextDelivery uses hybrid mode for mixed dense and blank pages', async () => {
  const { extractPdfPageSubset } = await import('../api/_lib/pdf-text.js');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const densePage = doc.addPage([612, 792]);
  const dense = 'STATE OF TEXAS\nCOUNTY OF REEVES\nGRANTOR: JOHN DOE\nGRANTEE: JANE DOE\nLEGAL DESC: Section 1\n';
  densePage.drawText(dense.repeat(10), { x: 72, y: 700, size: 11, font, lineHeight: 14, maxWidth: 460 });
  doc.addPage([612, 792]);
  const bytes = Buffer.from(await doc.save());
  const delivery = await resolvePdfTextDelivery(bytes);
  assert(delivery.mode === 'hybrid', `Expected hybrid delivery, got ${delivery.mode} (${delivery.reason || ''})`);
  assert(delivery.extractedText.includes('GRANTOR: JOHN DOE'), 'Expected dense page text kept');
  assert(Array.isArray(delivery.sparsePages) && delivery.sparsePages.includes(2), `Expected page 2 marked sparse, got ${delivery.sparsePages}`);
  assert(Buffer.isBuffer(delivery.visualBytes) && delivery.visualBytes.length > 0, 'Expected sparse-page PDF bytes');
  const subset = await extractPdfPageSubset(bytes, [1]);
  assert(subset.length > 0, 'Subset extractor should copy the blank page');
  const { buildAbstractMessagesForChunk } = await import('../api/_lib/abstraction.js');
  const messages = buildAbstractMessagesForChunk({
    id: 'chk_hybrid',
    originalFilename: 'mixed.pdf',
    mediaType: 'application/pdf',
  }, bytes, 0, delivery);
  const content = messages[0].content;
  const documentBlocks = content.filter(block => block.type === 'document');
  assert(documentBlocks.length === 1, 'Hybrid path should attach only the sparse-page PDF');
  assert(documentBlocks[0].source.data.length < bytes.toString('base64').length, 'Sparse visual PDF must be smaller than the full document');
  assert(content.some(block => block.type === 'text' && block.text.includes('HYBRID PDF')), 'Expected hybrid prompt labeling');
});

test('buildAbstractMessagesForChunk uses extracted text without document block', async () => {
  const { buildAbstractMessagesForChunk, estimateRequestBytes, ABSTRACTION_PROMPT, getAbstractionConfig } = await import('../api/_lib/abstraction.js');
  const chunk = {
    id: 'chk_text',
    originalFilename: 'deed.pdf',
    mediaType: 'application/pdf',
  };
  const delivery = { mode: 'text', extractedText: 'GRANTOR: A\nGRANTEE: B\n' };
  const messages = buildAbstractMessagesForChunk(chunk, Buffer.from('fake'), 0, delivery);
  const content = messages[0].content;
  assert(!content.some(block => block.type === 'document'), 'Text-first path should not include PDF document block');
  assert(content.some(block => block.type === 'text' && block.text.includes('EXTRACTED PDF TEXT')), 'Expected extracted text in prompt');

  const largePdfBytes = Buffer.alloc(120_000, 0x25);
  const visualMessages = buildAbstractMessagesForChunk(chunk, largePdfBytes, 0, { mode: 'visual' });
  assert(visualMessages[0].content.some(block => block.type === 'document'), 'Visual path should include document block');

  const config = getAbstractionConfig();
  const textBytes = estimateRequestBytes(config.model, config.maxTokens, ABSTRACTION_PROMPT, messages);
  const visualBytes = estimateRequestBytes(config.model, config.maxTokens, ABSTRACTION_PROMPT, visualMessages);
  assert(textBytes < visualBytes, `Expected smaller request for text path (${textBytes} vs ${visualBytes})`);
});

test('estimatePdfPlanningPayloadBytes treats >= 1.5 MB PDFs as full visual payload while keeping smaller PDFs text-first', () => {
  const textLike = estimatePdfPlanningPayloadBytes(800_000);
  const inline = estimatePdfPlanningPayloadBytes(800_000, { textFirstEnabled: false });
  const thresholdPdf = estimatePdfPlanningPayloadBytes(1_500_000);
  const largePdf = estimatePdfPlanningPayloadBytes(2_000_000);
  assert(textLike < 200_000, `Expected small planning estimate for text-like PDF, got ${textLike}`);
  assert(inline > textLike, 'Expected larger inline estimate when text-first is off');
  assert(thresholdPdf > 2_000_000, `Expected 1.5 MB PDF planning estimate > 2 MB for solo scheduling, got ${thresholdPdf}`);
  assert(largePdf > 2_000_000, `Expected 2 MB PDF planning estimate > 2 MB for solo scheduling, got ${largePdf}`);
});

test('getPdfTextConfig defaults enable text-first and strict mode', () => {
  const prevFirst = process.env.ABSTRACTION_PDF_TEXT_FIRST;
  const prevStrict = process.env.ABSTRACTION_PDF_TEXT_STRICT;
  delete process.env.ABSTRACTION_PDF_TEXT_FIRST;
  delete process.env.ABSTRACTION_PDF_TEXT_STRICT;
  try {
    const config = getPdfTextConfig();
    assert(config.enabled === true, 'Expected text-first enabled by default');
    assert(config.strict === true, 'Expected strict mode enabled by default');

    process.env.ABSTRACTION_PDF_TEXT_STRICT = 'false';
    const relaxed = getPdfTextConfig();
    assert(relaxed.strict === false, 'Expected ABSTRACTION_PDF_TEXT_STRICT=false to disable strict mode');
  } finally {
    if (prevFirst === undefined) delete process.env.ABSTRACTION_PDF_TEXT_FIRST;
    else process.env.ABSTRACTION_PDF_TEXT_FIRST = prevFirst;
    if (prevStrict === undefined) delete process.env.ABSTRACTION_PDF_TEXT_STRICT;
    else process.env.ABSTRACTION_PDF_TEXT_STRICT = prevStrict;
  }
});

test('assessExtractedPdfText rejects high bytesPerChar even when charsPerPage >= 500', () => {
  const denseText = 'STATE OF TEXAS COUNTY OF REEVES GRANTOR: JOHN DOE GRANTEE: JANE DOE '.repeat(12);
  assert(denseText.length >= 700, 'Expected >= 700 chars per page');
  const result = assessExtractedPdfText({
    text: denseText,
    pageCount: 1,
    fileSizeBytes: 1_200_000,
  });
  assert(result.suitable === false, 'Expected dense scanned PDF with high bytesPerChar to be rejected');
  assert(result.reason === 'likely_scanned_image', `Expected likely_scanned_image, got ${result.reason}`);
});

test('assessExtractedPdfText rejects garbled OCR ASCII and replacement characters', () => {
  const garbled = 'GRANTOR: J0hn D0e; GRANTEE: Jane Doe; conveys l/8th mineral interest per Vol. lO4 Page 2O8 recorded in 195l. '.repeat(5);
  assert(garbled.length >= 450, 'Expected >= 450 chars per page of garbled OCR text');
  const noisy = assessExtractedPdfText({
    text: garbled,
    pageCount: 1,
    fileSizeBytes: 50_000,
  });
  assert(noisy.suitable === false, 'Expected garbled OCR text to be rejected');
  assert(noisy.reason === 'noisy_ocr_text', `Expected noisy_ocr_text, got ${noisy.reason}`);

  const withReplacement = assessExtractedPdfText({
    text: `${'GRANTOR: JOHN DOE\nGRANTEE: JANE DOE\n'.repeat(12)}\uFFFD`,
    pageCount: 1,
    fileSizeBytes: 20_000,
  });
  assert(withReplacement.suitable === false, 'Expected U+FFFD replacement char text to be rejected');
  assert(withReplacement.reason === 'ocr_replacement_chars', `Expected ocr_replacement_chars, got ${withReplacement.reason}`);
});

test('resolvePdfTextDelivery routes full-page scanned PDF with invisible OCR text (>= 400 chars/page) to visual', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const img = await doc.embedPng(makePng());
  const page = doc.addPage([612, 792]);
  page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
  page.pushOperators(PDFOperator.of('Tr', [PDFNumber.of(3)]));
  const ocrText = 'STATE OF TEXAS COUNTY OF REEVES GRANTOR: JOHN DOE GRANTEE: JANE DOE VOL 104 PAGE 208 '.repeat(8);
  page.drawText(ocrText, { x: 72, y: 700, size: 11, font, lineHeight: 14, maxWidth: 460 });
  const bytes = Buffer.from(await doc.save());

  const delivery = await resolvePdfTextDelivery(bytes);
  assert(delivery.mode === 'visual', `Expected visual delivery for scanned PDF with invisible OCR layer, got ${delivery.mode} (${delivery.reason || ''})`);
});

test('resolvePdfTextDelivery keeps clean born-digital PDF with legal fractions and references on text mode', async () => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const deedBody = [
    'WARRANTY DEED - STATE OF TEXAS, COUNTY OF REEVES.',
    'GRANTOR: J. R. Smith, et ux. GRANTEE: Permian Basin Minerals LLC (attorney@lawfirm.com).',
    'CONVEYANCE: An undivided 1/8th and 3/16ths mineral interest in the NW/4 of Section 12, Block C-8, T2S, R4W, Abstract A-1234.',
    'RECORDING REF: Vol. 104, Page 208, Deed Records, recorded May 14, 1951.',
    'RESERVATIONS: (a) Prior royalty reservation; (b) Existing oil and gas lease.',
  ].join('\n');
  page.drawText(`${deedBody}\n${deedBody}`, { x: 72, y: 700, size: 10, font, lineHeight: 13, maxWidth: 460 });
  const bytes = Buffer.from(await doc.save());

  const delivery = await resolvePdfTextDelivery(bytes);
  assert(delivery.mode === 'text', `Expected clean born-digital deed to stay text mode, got ${delivery.mode} (${delivery.reason || ''})`);
  assert(delivery.extractedText.includes('1/8th') && delivery.extractedText.includes('Vol. 104'), 'Expected extracted legal terms preserved');
});

test('resolvePdfTextDelivery routes stamped digital PDF to visual and mixed clean+stamped PDF to hybrid', async () => {
  const single = await PDFDocument.create();
  const singleFont = await single.embedFont(StandardFonts.Helvetica);
  const stampImg1 = await single.embedPng(makePng());
  const singlePage = single.addPage([612, 792]);
  const body = 'STATE OF TEXAS\nCOUNTY OF REEVES\nGRANTOR: JOHN DOE\nGRANTEE: JANE DOE\nLEGAL DESC: Section 1\n'.repeat(6);
  singlePage.drawText(body, { x: 72, y: 700, size: 11, font: singleFont, lineHeight: 14, maxWidth: 460 });
  singlePage.drawImage(stampImg1, { x: 400, y: 650, width: 140, height: 80 });
  const stampedBytes = Buffer.from(await single.save());

  const singleDelivery = await resolvePdfTextDelivery(stampedBytes);
  assert(singleDelivery.mode === 'visual', `Expected stamped single-page PDF to route to visual, got ${singleDelivery.mode} (${singleDelivery.reason || ''})`);

  const mixed = await PDFDocument.create();
  const mixedFont = await mixed.embedFont(StandardFonts.Helvetica);
  const stampImg2 = await mixed.embedPng(makePng());
  const p1 = mixed.addPage([612, 792]);
  p1.drawText(body, { x: 72, y: 700, size: 11, font: mixedFont, lineHeight: 14, maxWidth: 460 });
  const p2 = mixed.addPage([612, 792]);
  p2.drawText(body, { x: 72, y: 700, size: 11, font: mixedFont, lineHeight: 14, maxWidth: 460 });
  p2.drawImage(stampImg2, { x: 400, y: 650, width: 140, height: 80 });
  const mixedBytes = Buffer.from(await mixed.save());

  const mixedDelivery = await resolvePdfTextDelivery(mixedBytes);
  assert(mixedDelivery.mode === 'hybrid', `Expected mixed clean+stamped PDF to route to hybrid, got ${mixedDelivery.mode} (${mixedDelivery.reason || ''})`);
  assert(Array.isArray(mixedDelivery.densePages) && mixedDelivery.densePages.join(',') === '1', `Expected page 1 dense, got ${mixedDelivery.densePages}`);
  assert(Array.isArray(mixedDelivery.visualPages) && mixedDelivery.visualPages.join(',') === '2', `Expected page 2 visual, got ${mixedDelivery.visualPages}`);
  assert(Array.isArray(mixedDelivery.sparsePages) && mixedDelivery.sparsePages.join(',') === '2', `Expected sparsePages backward-compat [2], got ${mixedDelivery.sparsePages}`);
  assert(Buffer.isBuffer(mixedDelivery.visualBytes) && mixedDelivery.visualBytes.length > 0, 'Expected visual subset PDF bytes');
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`✗ ${name}`);
    console.error(`  ${err.message}`);
    failed++;
  }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
