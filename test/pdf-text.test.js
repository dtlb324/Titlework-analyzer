import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  assessExtractedPdfText,
  extractPdfText,
  getPdfTextConfig,
  resolvePdfTextDelivery,
} from '../api/_lib/pdf-text.js';

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

test('getPdfTextConfig defaults enable text-first', () => {
  const previous = process.env.ABSTRACTION_PDF_TEXT_FIRST;
  delete process.env.ABSTRACTION_PDF_TEXT_FIRST;
  const config = getPdfTextConfig();
  if (previous === undefined) delete process.env.ABSTRACTION_PDF_TEXT_FIRST;
  else process.env.ABSTRACTION_PDF_TEXT_FIRST = previous;
  assert(config.enabled === true, 'Expected text-first enabled by default');
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
