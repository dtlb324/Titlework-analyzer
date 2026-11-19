import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  chunkRequiresSoloBatch,
  estimateChunkPayloadBytes,
  isAbstractionBatchingEnabled,
  planAbstractionWork,
  processMultiChunkAbstraction,
} from '../api/_lib/abstraction-batch.js';
import {
  BATCH_ABSTRACT_RESPONSE_SCHEMA,
  buildAbstractMessagesForChunks,
  parseBatchAbstracts,
} from '../api/_lib/abstraction.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function makeChunk(id, sizeBytes = 50_000, overrides = {}) {
  return {
    id,
    jobId: 'job_1',
    documentId: 'doc_1',
    mediaType: 'application/pdf',
    originalFilename: `${id}.pdf`,
    sizeBytes,
    chunkOrder: Number(id.replace(/\D/g, '')) || 0,
    uploadStatus: 'uploaded',
    abstractionStatus: 'pending',
    abstractionAttempts: 0,
    abstractionReclaims: 0,
    ...overrides,
  };
}

async function makeDigitalPdfBytes(label) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const text = `STATE OF TEXAS\nCOUNTY OF REEVES\nDOCUMENT: ${label}\nGRANTOR: JOHN DOE\nGRANTEE: JANE DOE\n`.repeat(6);
  page.drawText(text, { x: 72, y: 700, size: 11, font, lineHeight: 14, maxWidth: 460 });
  return Buffer.from(await doc.save());
}

function createMemoryBatchStore(initialChunks) {
  const chunks = new Map(initialChunks.map(c => [c.id, { ...c }]));
  const abstracts = new Map();
  return {
    chunks,
    abstracts,
    async claimChunkForAbstraction(jobId, chunkId, opts = {}) {
      const chunk = chunks.get(chunkId);
      if (!chunk) return null;
      const sameWorker = chunk.abstractionStatus === 'processing' && chunk.abstractionWorkerId === opts.workerId;
      if (chunk.abstractionStatus !== 'pending' && !sameWorker) return null;
      const updated = {
        ...chunk,
        abstractionStatus: 'processing',
        abstractionWorkerId: opts.workerId,
        abstractionAttempts: sameWorker ? chunk.abstractionAttempts : (chunk.abstractionAttempts || 0) + 1,
        abstractionReclaims: sameWorker ? (chunk.abstractionReclaims || 0) + 1 : (chunk.abstractionReclaims || 0),
      };
      chunks.set(chunkId, updated);
      return updated;
    },
    async getChunk(jobId, chunkId) {
      return chunks.get(chunkId) || null;
    },
    async getDocumentAbstractByChunkId(jobId, chunkId) {
      return abstracts.get(chunkId) || null;
    },
    async saveDocumentAbstract(record) {
      const chunk = chunks.get(record.chunkId);
      if (!chunk || chunk.abstractionStatus !== 'processing') return null;
      if (chunk.abstractionWorkerId && record.workerId && chunk.abstractionWorkerId !== record.workerId) return null;
      chunks.set(record.chunkId, { ...chunk, abstractionStatus: 'completed', abstractionLeaseExpiresAt: null });
      abstracts.set(record.chunkId, { ...record });
      return record;
    },
    async markChunkAbstractionFailed(jobId, chunkId, failure) {
      const chunk = chunks.get(chunkId);
      const updated = { ...chunk, abstractionStatus: 'failed', abstractionErrorType: failure.errorType };
      chunks.set(chunkId, updated);
      return updated;
    },
    async markChunkAbstractionRetryWait(jobId, chunkId, failure) {
      const chunk = chunks.get(chunkId);
      const updated = { ...chunk, abstractionStatus: 'retry_wait', abstractionErrorType: failure.errorType };
      chunks.set(chunkId, updated);
      return updated;
    },
  };
}

test('planAbstractionWork groups small chunks up to 6 per batch by default', () => {
  const chunks = Array.from({ length: 14 }, (_, i) => makeChunk(`chk_${i}`, 60_000));
  const { batches, singles } = planAbstractionWork(chunks);
  assert(batches.length === 3, `Expected 3 batches, got ${batches.length}`);
  assert(batches[0].chunks.length === 6, `First batch should have 6 docs, got ${batches[0].chunks.length}`);
  assert(batches[1].chunks.length === 6, `Second batch should have 6 docs, got ${batches[1].chunks.length}`);
  assert(batches[2].chunks.length === 2, `Third batch should have 2 docs, got ${batches[2].chunks.length}`);
  assert(singles.length === 0, 'No solo chunks expected for small docs');
});

test('planAbstractionWork isolates wide page-range chunks', () => {
  const chunks = [
    ...Array.from({ length: 4 }, (_, i) => makeChunk(`small_${i}`, 50_000)),
    makeChunk('wide', 500_000, { pageStart: 1, pageEnd: 40 }),
  ];
  const { batches, singles } = planAbstractionWork(chunks);
  assert(singles.length === 1 && singles[0].id === 'wide', 'Expected wide page-range chunk solo');
  assert(batches.length === 1 && batches[0].chunks.length === 4, 'Expected one batch for small docs');
});

test('planAbstractionWork and chunkRequiresSoloBatch keep >= 1.5 MB PDFs and images solo', () => {
  const small = makeChunk('s', 100_000);
  const thresholdScan = makeChunk('scan_1500k', 1_500_000);
  const largeScan = makeChunk('scan_2mb', 2_000_000);
  const imageChunk = makeChunk('img_1', 80_000, { mediaType: 'image/png', originalFilename: 'scan.png' });
  const renderedChunk = makeChunk('rnd_1', 80_000, { mediaType: 'image/jpeg', originalFilename: 'deed.pdf', renderedImages: true });
  const wide = makeChunk('w', 500_000, { pageStart: 1, pageEnd: 40 });
  const csv = makeChunk('c', 3_000_000, { mediaType: 'text/csv', originalFilename: 'c.csv' });

  assert(chunkRequiresSoloBatch(small) === false, 'Small chunk should batch');
  assert(chunkRequiresSoloBatch(thresholdScan) === true, '1.5 MB PDF should stay solo');
  assert(chunkRequiresSoloBatch(largeScan) === true, '2 MB PDF should stay solo');
  assert(chunkRequiresSoloBatch(imageChunk) === true, 'Image chunk should stay solo');
  assert(chunkRequiresSoloBatch(renderedChunk) === true, 'Rendered image chunk should stay solo');
  assert(chunkRequiresSoloBatch(wide) === true, 'Wide page span should stay solo');
  assert(chunkRequiresSoloBatch(csv) === true, 'Large CSV should stay solo');

  const { batches, singles } = planAbstractionWork([
    makeChunk('small_a', 50_000),
    makeChunk('small_b', 50_000),
    thresholdScan,
    imageChunk,
    largeScan,
  ]);
  assert(singles.map(c => c.id).join(',') === 'scan_1500k,img_1,scan_2mb', `Expected solo scans/images, got ${singles.map(c => c.id)}`);
  assert(batches.length === 1 && batches[0].chunks.map(c => c.id).join(',') === 'small_a,small_b', 'Expected only small chunks batched');
});

test('parseBatchAbstracts maps keyed { docIndex, abstract } output including non-zero globalStart and out-of-order elements', () => {
  const items = [
    { chunk: makeChunk('a') },
    { chunk: makeChunk('b') },
  ];
  assert(BATCH_ABSTRACT_RESPONSE_SCHEMA.items.type === 'object', 'Batch schema should require object items');
  assert(BATCH_ABSTRACT_RESPONSE_SCHEMA.items.required.includes('docIndex'), 'Batch schema should require docIndex');

  const text = JSON.stringify([
    { docIndex: 6, abstract: 'DOCUMENT #6:\nDOC TYPE: Lease\nGRANTOR: B' },
    { docIndex: 5, abstract: 'DOCUMENT #5:\nDOC TYPE: Deed\nGRANTOR: A' },
  ]);
  const parsed = parseBatchAbstracts(text, items, 4);
  assert(parsed.length === 2, 'Expected two parsed abstracts');
  assert(parsed[0].abstractText.includes('DOC TYPE: Deed'), 'Expected docIndex 5 mapped to first item');
  assert(parsed[1].abstractText.includes('DOC TYPE: Lease'), 'Expected docIndex 6 mapped to second item');
});

test('parseBatchAbstracts rejects mismatched lengths, bare arrays, duplicate/shifted indices, and contradictory headers', () => {
  const items = [{ chunk: makeChunk('a') }, { chunk: makeChunk('b') }, { chunk: makeChunk('c') }];
  const invalidPayloads = [
    '["DOC TYPE: Lease","DOC TYPE: Assignment","DOC TYPE: Deed"]',
    JSON.stringify([{ docIndex: 1, abstract: 'A' }, { docIndex: 2, abstract: 'B' }]),
    JSON.stringify([{ docIndex: 1, abstract: 'A' }, { docIndex: 1, abstract: 'B' }, { docIndex: 3, abstract: 'C' }]),
    JSON.stringify([{ docIndex: 2, abstract: 'A' }, { docIndex: 3, abstract: 'B' }, { docIndex: 4, abstract: 'C' }]),
    JSON.stringify([
      { docIndex: 1, abstract: 'DOCUMENT #2:\nDOC TYPE: Deed' },
      { docIndex: 2, abstract: 'DOCUMENT #2:\nDOC TYPE: Lease' },
      { docIndex: 3, abstract: 'DOCUMENT #3:\nDOC TYPE: Release' },
    ]),
  ];
  for (const payload of invalidPayloads) {
    const parsed = parseBatchAbstracts(payload, items, 0);
    assert(parsed.length === 3, 'Expected one entry per batch item');
    assert(parsed.every(item => item.abstractText === ''), `Misaligned payload must fail closed for all items: ${payload}`);
  }
});

test('buildAbstractMessagesForChunks packs multiple text-first PDFs in one text block with boundary markers', () => {
  const items = [
    {
      chunk: makeChunk('t1'),
      payloadBytes: Buffer.from('pdf'),
      delivery: { mode: 'text', extractedText: 'GRANTOR: One' },
    },
    {
      chunk: makeChunk('t2'),
      payloadBytes: Buffer.from('pdf'),
      delivery: { mode: 'text', extractedText: 'GRANTOR: Two' },
    },
  ];
  const messages = buildAbstractMessagesForChunks(items, 0);
  const blocks = messages[0].content;
  assert(!blocks.some(block => block.type === 'document'), 'Batch text-first should avoid document blocks');
  assert(blocks.length === 1, `Expected single text block for text-only batch, got ${blocks.length}`);
  const prompt = blocks[0]?.text || '';
  assert(prompt.includes('--- START DOCUMENT #1 (t1.pdf) ---'), 'Expected start boundary for doc 1');
  assert(prompt.includes('--- END DOCUMENT #1 (t1.pdf) ---'), 'Expected end boundary for doc 1');
  assert(prompt.includes('--- START DOCUMENT #2 (t2.pdf) ---'), 'Expected start boundary for doc 2');
  assert(prompt.includes('GRANTOR: One') && prompt.includes('GRANTOR: Two'), 'Expected both extracted bodies in prompt');
});

test('buildAbstractMessagesForChunks precedes every visual block immediately with its document label', () => {
  const items = [
    {
      chunk: makeChunk('scan_a'),
      payloadBytes: Buffer.from('%PDF-A'),
      delivery: { mode: 'visual' },
    },
    {
      chunk: makeChunk('img_b', 1000, { mediaType: 'image/png', originalFilename: 'img_b.png' }),
      payloadBytes: Buffer.from('PNG'),
      delivery: { mode: 'visual' },
    },
    {
      chunk: makeChunk('text_c'),
      payloadBytes: Buffer.from('%PDF-C'),
      delivery: { mode: 'text', extractedText: 'GRANTOR: Text C' },
    },
    {
      chunk: makeChunk('scan_d'),
      payloadBytes: Buffer.from('%PDF-D'),
      delivery: { mode: 'visual' },
    },
  ];
  const messages = buildAbstractMessagesForChunks(items, 2);
  const blocks = messages[0].content;

  const docAIdx = blocks.findIndex(b => b.type === 'document' && b.source.data === Buffer.from('%PDF-A').toString('base64'));
  const imgBIdx = blocks.findIndex(b => b.type === 'image');
  const docDIdx = blocks.findIndex(b => b.type === 'document' && b.source.data === Buffer.from('%PDF-D').toString('base64'));

  assert(docAIdx > 0 && blocks[docAIdx - 1].type === 'text' && blocks[docAIdx - 1].text.includes('--- START DOCUMENT #3 (scan_a.pdf) ---'), 'Doc #3 must be immediately preceded by its label');
  assert(blocks[docAIdx + 1]?.type === 'text' && blocks[docAIdx + 1].text.includes('--- END DOCUMENT #3 (scan_a.pdf) ---'), 'Doc #3 must be followed by its end marker');
  assert(imgBIdx > docAIdx && blocks[imgBIdx - 1].type === 'text' && blocks[imgBIdx - 1].text.includes('--- START DOCUMENT #4 (img_b.png) ---'), 'Image #4 must be immediately preceded by its label');
  assert(docDIdx > imgBIdx && blocks[docDIdx - 1].type === 'text' && blocks[docDIdx - 1].text.includes('--- START DOCUMENT #6 (scan_d.pdf) ---'), 'Doc #6 must be immediately preceded by its label');
  assert(blocks.some(b => b.type === 'text' && b.text.includes('--- START DOCUMENT #5 (text_c.pdf) ---')), 'Text item #5 must remain labeled in order');
});

async function makeScannedPdfBytes() {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

test('processMultiChunkAbstraction isolates visual PDFs into solo calls while batching clean text PDFs', async () => {
  const digitalA = await makeDigitalPdfBytes('Digital A');
  const digitalB = await makeDigitalPdfBytes('Digital B');
  const scannedC = await makeScannedPdfBytes();
  const chunks = [
    makeChunk('chk_1', digitalA.byteLength, { chunkOrder: 0, originalFilename: 'a.pdf' }),
    makeChunk('chk_2', scannedC.byteLength, { chunkOrder: 1, originalFilename: 'scan.pdf' }),
    makeChunk('chk_3', digitalB.byteLength, { chunkOrder: 2, originalFilename: 'b.pdf' }),
  ];
  const store = createMemoryBatchStore(chunks);
  const blobs = new Map([
    ['chk_1', { bytes: digitalA, mediaType: 'application/pdf' }],
    ['chk_2', { bytes: scannedC, mediaType: 'application/pdf' }],
    ['chk_3', { bytes: digitalB, mediaType: 'application/pdf' }],
  ]);

  const calls = [];
  const results = await processMultiChunkAbstraction(chunks, {
    store,
    workerId: 'wkr_iso',
    escalationEnabled: false,
    blobLoader: async chunk => blobs.get(chunk.id),
    modelClient: async req => {
      calls.push({ hasSchema: Boolean(req.responseSchema), contentTypes: req.messages[0].content.map(b => b.type) });
      if (req.responseSchema) {
        return {
          text: JSON.stringify([
            { docIndex: 1, abstract: 'DOC TYPE: Deed\nGRANTOR: Digital A' },
            { docIndex: 2, abstract: 'DOC TYPE: Deed\nGRANTOR: Digital B' },
          ]),
          model: 'gemini-3.1-flash-lite',
          usage: { input_tokens: 100, output_tokens: 40 },
        };
      }
      return {
        text: 'DOC TYPE: Deed\nGRANTOR: Scanned C',
        model: 'gemini-3.1-flash-lite',
        usage: { input_tokens: 80, output_tokens: 25 },
      };
    },
  });

  assert(results.every(r => r.status === 'completed'), `Expected all 3 completed, got ${JSON.stringify(results)}`);
  assert(calls.length === 2, `Expected 1 solo visual call + 1 text batch call, got ${calls.length}`);
  const soloCall = calls.find(c => !c.hasSchema);
  const batchCall = calls.find(c => c.hasSchema);
  assert(soloCall && soloCall.contentTypes.includes('document'), 'Visual scan should run solo with document block');
  assert(batchCall && !batchCall.contentTypes.includes('document'), 'Text batch should contain no document blocks');
  assert(store.abstracts.get('chk_2').abstractText.includes('Scanned C'), 'Solo scan abstract saved');
  assert(store.abstracts.get('chk_1').abstractText.includes('Digital A'), 'Batched digital A saved');
  assert(store.abstracts.get('chk_3').abstractText.includes('Digital B'), 'Batched digital B saved');
});

test('processMultiChunkAbstraction falls back cleanly to solo processing when batch output is misaligned', async () => {
  const digitalA = await makeDigitalPdfBytes('Fallback A');
  const digitalB = await makeDigitalPdfBytes('Fallback B');
  const chunks = [
    makeChunk('chk_10', digitalA.byteLength, { chunkOrder: 0, originalFilename: 'fa.pdf' }),
    makeChunk('chk_11', digitalB.byteLength, { chunkOrder: 1, originalFilename: 'fb.pdf' }),
  ];
  const store = createMemoryBatchStore(chunks);
  const blobs = new Map([
    ['chk_10', { bytes: digitalA, mediaType: 'application/pdf' }],
    ['chk_11', { bytes: digitalB, mediaType: 'application/pdf' }],
  ]);

  let batchCount = 0;
  let soloCount = 0;
  const results = await processMultiChunkAbstraction(chunks, {
    store,
    workerId: 'wkr_misaligned',
    escalationEnabled: false,
    blobLoader: async chunk => blobs.get(chunk.id),
    modelClient: async req => {
      if (req.responseSchema) {
        batchCount += 1;
        // Misaligned docIndex (shifted 2, 3 instead of 1, 2)
        return {
          text: JSON.stringify([
            { docIndex: 2, abstract: 'Wrong A' },
            { docIndex: 3, abstract: 'Wrong B' },
          ]),
          model: 'gemini-3.1-flash-lite',
          usage: {},
        };
      }
      soloCount += 1;
      const textPrompt = req.messages[0].content.at(-1).text;
      const who = textPrompt.includes('Fallback A') ? 'Solo A' : 'Solo B';
      return { text: `DOC TYPE: Deed\nGRANTOR: ${who}`, model: 'gemini-3.1-flash-lite', usage: {} };
    },
  });

  assert(batchCount === 1, `Expected 1 batch call, got ${batchCount}`);
  assert(soloCount === 2, `Expected 2 solo fallback calls, got ${soloCount}`);
  assert(results.every(r => r.status === 'completed'), `Expected clean solo fallback completions, got ${JSON.stringify(results)}`);
  assert(store.abstracts.get('chk_10').abstractText.includes('Solo A'), 'Expected chk_10 recovered via solo fallback');
  assert(store.abstracts.get('chk_11').abstractText.includes('Solo B'), 'Expected chk_11 recovered via solo fallback');
});

test('isAbstractionBatchingEnabled defaults to true', () => {
  const previous = process.env.ABSTRACTION_BATCH_ENABLED;
  delete process.env.ABSTRACTION_BATCH_ENABLED;
  assert(isAbstractionBatchingEnabled() === true, 'Expected batching on by default');
  if (previous === undefined) delete process.env.ABSTRACTION_BATCH_ENABLED;
  else process.env.ABSTRACTION_BATCH_ENABLED = previous;
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
