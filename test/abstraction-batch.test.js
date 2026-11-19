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
  getAbstractionConfig,
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

// In-memory store with the real lease rules: a claim by another worker is admitted only after the lease expired,
// renew and save are owner-checked, and a save by anyone but the current owner is rejected.
function createLeasedBatchStore(initialChunks, hooks = {}) {
  const chunks = new Map(initialChunks.map(c => [c.id, { ...c }]));
  const abstracts = new Map();
  const marks = [];
  const renewCalls = [];
  const claims = [];
  const store = {
    chunks,
    abstracts,
    marks,
    renewCalls,
    claims,
    async claimChunkForAbstraction(jobId, chunkId, opts = {}) {
      const chunk = chunks.get(chunkId);
      if (!chunk) return null;
      const expired = !chunk.abstractionLeaseExpiresAt || chunk.abstractionLeaseExpiresAt <= Date.now();
      const sameWorker = chunk.abstractionStatus === 'processing' && chunk.abstractionWorkerId === opts.workerId;
      const claimable = chunk.abstractionStatus === 'pending' || sameWorker
        || (chunk.abstractionStatus === 'processing' && expired);
      if (!claimable) return null;
      const updated = {
        ...chunk,
        abstractionStatus: 'processing',
        abstractionWorkerId: opts.workerId,
        abstractionLeaseExpiresAt: Date.now() + (opts.leaseMs || 90_000),
        abstractionAttempts: sameWorker ? chunk.abstractionAttempts : (chunk.abstractionAttempts || 0) + 1,
      };
      chunks.set(chunkId, updated);
      claims.push({ chunkId, workerId: opts.workerId });
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
      if (!chunk || chunk.abstractionStatus !== 'processing' || chunk.abstractionWorkerId !== record.workerId) return null;
      chunks.set(record.chunkId, { ...chunk, abstractionStatus: 'completed', abstractionLeaseExpiresAt: null });
      abstracts.set(record.chunkId, { ...record });
      return record;
    },
    async markChunkAbstractionFailed(jobId, chunkId, failure) {
      marks.push({ chunkId, to: 'failed' });
      const chunk = chunks.get(chunkId);
      const updated = { ...chunk, abstractionStatus: 'failed', abstractionErrorType: failure.errorType };
      chunks.set(chunkId, updated);
      return updated;
    },
    async markChunkAbstractionRetryWait(jobId, chunkId, failure) {
      marks.push({ chunkId, to: 'retry_wait' });
      const chunk = chunks.get(chunkId);
      const updated = { ...chunk, abstractionStatus: 'retry_wait', abstractionErrorType: failure.errorType };
      chunks.set(chunkId, updated);
      return updated;
    },
    async renewChunkAbstractionLease(jobId, chunkId, opts = {}) {
      renewCalls.push(chunkId);
      if (hooks.onRenew) {
        const outcome = await hooks.onRenew(chunkId, renewCalls.filter(id => id === chunkId).length, store);
        if (outcome === 'stolen') return null;
      }
      const chunk = chunks.get(chunkId);
      if (!chunk || chunk.abstractionStatus !== 'processing' || !opts.workerId || chunk.abstractionWorkerId !== opts.workerId) return null;
      const updated = { ...chunk, abstractionLeaseExpiresAt: Date.now() + (opts.leaseMs || 90_000) };
      chunks.set(chunkId, updated);
      return updated;
    },
  };
  return store;
}

// A second worker takes over any chunk whose lease has expired (or that we force-expire).
async function workerBSweep(store, ids, leaseMs = 300_000) {
  for (const id of ids) {
    await store.claimChunkForAbstraction('job_1', id, { workerId: 'wkr_B', leaseMs });
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// csvBytes: make the text chunks CSVs of about that size (to push a batch over a small request envelope).
// batchReply(count): override the batch model reply text.
async function makeLeaseFixture({ visualCount = 2, textCount = 3, callMs = 120, leaseMs = 150, storeHooks = {}, storeWrap = null, onCall = null, csvBytes = 0, batchReply = null } = {}) {
  const chunks = [];
  const blobs = new Map();
  const scan = await makeScannedPdfBytes();
  for (let i = 1; i <= visualCount; i++) {
    const id = `chk_${i}`;
    chunks.push(makeChunk(id, scan.byteLength, { chunkOrder: i - 1, originalFilename: `scan_${i}.pdf` }));
    blobs.set(id, { bytes: scan, mediaType: 'application/pdf' });
  }
  for (let j = 1; j <= textCount; j++) {
    const id = `chk_${visualCount + j}`;
    if (csvBytes) {
      const bytes = Buffer.from(`owner,Digital ${visualCount + j}\n${'grantor,grantee,acres\n'.repeat(Math.ceil(csvBytes / 22))}`);
      chunks.push(makeChunk(id, bytes.byteLength, { chunkOrder: visualCount + j - 1, mediaType: 'text/csv', originalFilename: `t_${j}.csv` }));
      blobs.set(id, { bytes, mediaType: 'text/csv' });
      continue;
    }
    const bytes = await makeDigitalPdfBytes(`Digital ${visualCount + j}`);
    chunks.push(makeChunk(id, bytes.byteLength, { chunkOrder: visualCount + j - 1, originalFilename: `t_${j}.pdf` }));
    blobs.set(id, { bytes, mediaType: 'application/pdf' });
  }
  const textIds = chunks.slice(visualCount).map(c => c.id);
  const allIds = chunks.map(c => c.id);
  let store = createLeasedBatchStore(chunks, storeHooks);
  if (storeWrap) store = storeWrap(store);
  const calls = [];
  const modelClient = async req => {
    const prompt = JSON.stringify(req.messages);
    const call = { schema: Boolean(req.responseSchema), prompt, includes: id => prompt.includes(`Digital ${id.replace('chk_', '')}`) };
    calls.push(call);
    await sleep(callMs);
    if (onCall) await onCall(calls.length, store, call);
    if (req.responseSchema) {
      const count = (prompt.match(/START DOCUMENT #/g) || []).length;
      return {
        text: batchReply ? batchReply(count) : JSON.stringify(Array.from({ length: count }, (_, i) => ({ docIndex: i + 1, abstract: `DOC TYPE: Deed\nGRANTOR: Batch ${i + 1}` }))),
        model: 'gemini-3.1-flash-lite',
        usage: { input_tokens: 90, output_tokens: 30 },
      };
    }
    return { text: 'DOC TYPE: Deed\nGRANTOR: Solo', model: 'gemini-3.1-flash-lite', usage: { input_tokens: 40, output_tokens: 12 } };
  };
  const run = (processFn = processMultiChunkAbstraction) => processFn(chunks, {
    store,
    workerId: 'wkr_A',
    leaseMs,
    escalationEnabled: false,
    blobLoader: async chunk => blobs.get(chunk.id),
    modelClient,
  });
  return { chunks, store, calls, run, textIds, allIds };
}

test('lease: slow visual solos do not let the held text chunks expire before the batch call (renewal per paid call)', async () => {
  const fx = await makeLeaseFixture({
    onCall: async (_n, store) => { await workerBSweep(store, fx.allIds); },
  });
  const results = await fx.run();
  const stolen = fx.store.claims.filter(c => c.workerId === 'wkr_B');
  assert(stolen.length === 0, `Worker B must never claim a chunk A still holds, got ${JSON.stringify(stolen)}`);
  assert(results.length === 5 && results.every(r => r.status === 'completed'), `Expected 5 completed, got ${JSON.stringify(results.map(r => [r.chunkId, r.status]))}`);
  assert(fx.calls.length === 3, `Expected 2 solo + 1 batch call, got ${fx.calls.length}`);
  assert(fx.textIds.every(id => fx.store.abstracts.has(id)), 'Batched text chunks must be saved');
});

test('lease: a held text chunk taken by another worker mid-flight is stale and never sent to the model', async () => {
  const fx = await makeLeaseFixture({
    callMs: 5,
    onCall: async (n, store) => {
      if (n !== 1) return;
      store.chunks.set('chk_4', { ...store.chunks.get('chk_4'), abstractionLeaseExpiresAt: Date.now() - 1 });
      await workerBSweep(store, ['chk_4']);
    },
  });
  const results = await fx.run();
  const byId = Object.fromEntries(results.map(r => [r.chunkId, r.status]));
  assert(results.length === 5, `Expected one result per chunk, got ${results.length}`);
  assert(byId.chk_4 === 'stale', `Stolen chunk must be stale, got ${byId.chk_4}`);
  assert(['chk_1', 'chk_2', 'chk_3', 'chk_5'].every(id => byId[id] === 'completed'), `Others must complete, got ${JSON.stringify(byId)}`);
  assert(fx.calls.every(call => !call.includes('chk_4')), 'No model call may include the stolen chunk');
  assert(fx.calls.filter(call => call.schema).length === 1, 'The remaining two text chunks still batch once');
  assert(fx.store.marks.length === 0, `Nothing may be marked failed/retry_wait, got ${JSON.stringify(fx.store.marks)}`);
  assert(fx.store.chunks.get('chk_4').abstractionWorkerId === 'wkr_B', 'The new owner keeps its claim');
});

test('lease: a chunk lost between the last renewal and the batch call stops the batch before it is paid', async () => {
  const fx = await makeLeaseFixture({
    visualCount: 0,
    textCount: 3,
    callMs: 5,
    // renewal round 1 runs before the messages are built, round 2 is the guard right before the paid call
    storeHooks: { onRenew: async (id, n) => (id === 'chk_2' && n === 2 ? 'stolen' : null) },
  });
  const results = await fx.run();
  const byId = Object.fromEntries(results.map(r => [r.chunkId, r.status]));
  assert(results.length === 3, `Expected one result per chunk, got ${results.length}`);
  assert(byId.chk_2 === 'stale', `Lost chunk must be stale, got ${byId.chk_2}`);
  assert(byId.chk_1 === 'completed' && byId.chk_3 === 'completed', `Others complete as singles, got ${JSON.stringify(byId)}`);
  assert(fx.calls.every(call => !call.schema), 'The batch call must not be paid once a member is lost');
  assert(fx.calls.every(call => !call.includes('chk_2')), 'No call may include the lost chunk');
});

test('lease: a renewal that throws is logged and the work proceeds', async () => {
  const fx = await makeLeaseFixture({
    callMs: 5,
    storeHooks: { onRenew: async () => { throw new Error('neon blip'); } },
  });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = line => warnings.push(String(line));
  let results;
  try {
    results = await fx.run();
  } finally {
    console.warn = originalWarn;
  }
  assert(results.length === 5 && results.every(r => r.status === 'completed'), `Expected 5 completed, got ${JSON.stringify(results.map(r => [r.chunkId, r.status]))}`);
  assert(fx.calls.length === 3, `Expected 3 model calls, got ${fx.calls.length}`);
  assert(warnings.some(line => line.includes('abstraction_chunk_lease_renew_failed')), 'Expected a renew-failed warning');
  assert(!warnings.some(line => line.includes('neon blip')), 'The store error message must not be logged');
});

test('lease: a store without renewChunkAbstractionLease behaves as before', async () => {
  const fx = await makeLeaseFixture({
    callMs: 5,
    storeWrap: store => {
      const { renewChunkAbstractionLease, ...rest } = store;
      return Object.assign(rest, { chunks: store.chunks, abstracts: store.abstracts, marks: store.marks, renewCalls: store.renewCalls, claims: store.claims });
    },
  });
  assert(typeof fx.store.renewChunkAbstractionLease === 'undefined', 'Fixture store must lack the method');
  const results = await fx.run();
  assert(results.length === 5 && results.every(r => r.status === 'completed'), `Expected 5 completed, got ${JSON.stringify(results.map(r => [r.chunkId, r.status]))}`);
  assert(fx.calls.length === 3, `Expected 3 model calls, got ${fx.calls.length}`);
});

// Logs every renewal the store receives: the chunk, the lease length asked for, and how many paid calls had started.
function recordRenewals(log, paidCalls) {
  return store => {
    const renew = store.renewChunkAbstractionLease;
    store.renewChunkAbstractionLease = async (jobId, chunkId, opts = {}) => {
      log.push({ chunkId, leaseMs: opts.leaseMs, paidCalls: paidCalls() });
      return renew(jobId, chunkId, opts);
    };
    return store;
  };
}

// Worker B takes the chunk: its lease is expired, then B claims it (the same steal the other lease tests use).
async function stealChunk(store, chunkId) {
  store.chunks.set(chunkId, { ...store.chunks.get(chunkId), abstractionLeaseExpiresAt: Date.now() - 1 });
  await workerBSweep(store, [chunkId]);
}

async function withWarnings(fn) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = line => warnings.push(String(line));
  try {
    return { result: await fn(), warnings };
  } finally {
    console.warn = originalWarn;
  }
}

const statusById = results => Object.fromEntries(results.map(r => [r.chunkId, r.status]));

test('lease: batch-level renewals ask for upstream timeout + 60s, not the bare queue lease', async () => {
  const leaseMs = 150;
  const needed = getAbstractionConfig().upstreamTimeoutMs + 60_000;
  assert(needed > leaseMs, 'The per-call lease must be longer than the queue lease for this test to mean anything');
  const log = [];
  const fx = await makeLeaseFixture({ callMs: 5, leaseMs, storeWrap: recordRenewals(log, () => fx.calls.length) });
  const results = await fx.run();
  assert(results.length === 5 && results.every(r => r.status === 'completed'), `Expected 5 completed, got ${JSON.stringify(statusById(results))}`);
  // The waiting second visual and the text chunks are only ever renewed by the batch-level renewal, so their
  // lease length is the batch's renewMs. paidCalls 0 = before the first visual solo, 2 = before the text batch call.
  const beforeVisualSolo = log.filter(r => r.paidCalls === 0 && (r.chunkId === 'chk_2' || fx.textIds.includes(r.chunkId)));
  const beforeTextBatch = log.filter(r => r.paidCalls === 2 && fx.textIds.includes(r.chunkId));
  assert(beforeVisualSolo.length > 0 && beforeTextBatch.length > 0, `Expected renewals in both phases, got ${beforeVisualSolo.length} and ${beforeTextBatch.length}`);
  const short = [...beforeVisualSolo, ...beforeTextBatch].filter(r => !(r.leaseMs >= needed));
  assert(short.length === 0, `Every batch-level renewal must ask for >= ${needed}ms, got ${JSON.stringify(short.slice(0, 3))}`);
});

test('lease: a fallback to singles skips a chunk another worker took and returns stale without a model call', async () => {
  const fx = await makeLeaseFixture({
    visualCount: 0,
    textCount: 3,
    callMs: 5,
    // The reply is missing one doc, so parseBatchAbstracts fails closed and every text chunk falls back to singles.
    batchReply: count => JSON.stringify(Array.from({ length: count - 1 }, (_, i) => ({ docIndex: i + 1, abstract: 'DOC TYPE: Deed\nGRANTOR: Short' }))),
    // B takes chk_2 while the batch call is in flight. The first single's renewal is what tells A.
    onCall: async (n, store) => { if (n === 1) await stealChunk(store, 'chk_2'); },
  });
  const { result: results, warnings } = await withWarnings(() => fx.run());
  const byId = statusById(results);
  assert(warnings.some(line => line.includes('abstraction_batch_fallback') && line.includes('batch_parse_partial:3/3')), 'The fallback must come from the short batch reply');
  assert(results.length === 3, `Expected one result per chunk, got ${results.length}`);
  assert(byId.chk_2 === 'stale', `The taken chunk must be stale, got ${byId.chk_2}`);
  assert(byId.chk_1 === 'completed' && byId.chk_3 === 'completed', `The others must complete as singles, got ${JSON.stringify(byId)}`);
  const singles = fx.calls.filter(call => !call.schema);
  assert(fx.calls.length === 3 && singles.length === 2, `Expected 1 batch + 2 singles, got ${fx.calls.length} calls`);
  assert(singles.every(call => !call.includes('chk_2')), 'No single call may include the taken chunk');
  assert(singles.some(call => call.includes('chk_1')) && singles.some(call => call.includes('chk_3')), 'The singles must be chk_1 and chk_3');
  assert(fx.store.marks.length === 0, `Nothing may be marked failed/retry_wait, got ${JSON.stringify(fx.store.marks)}`);
  assert(fx.store.chunks.get('chk_2').abstractionWorkerId === 'wkr_B', 'The new owner keeps its claim');
});

// REQUEST_ENVELOPE_SAFE_BYTES is read once when abstraction-batch.js loads. A distinct URL gives this test its own
// copy of the module with the small envelope; abstraction.js and the rest stay shared. The env var is restored after.
async function importBatchWithEnvelope(bytes) {
  const previous = process.env.REQUEST_ENVELOPE_SAFE_BYTES;
  process.env.REQUEST_ENVELOPE_SAFE_BYTES = String(bytes);
  try {
    return await import(`../api/_lib/abstraction-batch.js?envelope=${bytes}`);
  } finally {
    if (previous === undefined) delete process.env.REQUEST_ENVELOPE_SAFE_BYTES;
    else process.env.REQUEST_ENVELOPE_SAFE_BYTES = previous;
  }
}

test('lease: a payload-too-large split reports a right-half chunk taken during the left half once, as stale, and never re-sends it', async () => {
  const { processMultiChunkAbstraction: splitting } = await importBatchWithEnvelope(100_000);
  const fx = await makeLeaseFixture({
    visualCount: 0,
    textCount: 4,
    csvBytes: 30_000,
    callMs: 5,
    // call 1 is the left half's batch; B takes chk_4 (right half) while it runs
    onCall: async (n, store) => { if (n === 1) await stealChunk(store, 'chk_4'); },
  });
  const { result: results } = await withWarnings(() => fx.run(splitting));
  const ids = results.map(r => r.chunkId).sort();
  const byId = statusById(results);
  assert(results.length === 4 && ids.join(',') === 'chk_1,chk_2,chk_3,chk_4', `Expected exactly one result per chunk, got ${JSON.stringify(results.map(r => [r.chunkId, r.status]))}`);
  assert(byId.chk_4 === 'stale', `The taken right-half chunk must be stale, got ${byId.chk_4}`);
  assert(['chk_1', 'chk_2', 'chk_3'].every(id => byId[id] === 'completed'), `The others must complete, got ${JSON.stringify(byId)}`);
  const batches = fx.calls.filter(call => call.schema);
  const singles = fx.calls.filter(call => !call.schema);
  assert(fx.calls.length === 2 && batches.length === 1 && singles.length === 1, `Expected the left batch + one right single, got ${fx.calls.length} calls`);
  assert(batches[0].includes('chk_1') && batches[0].includes('chk_2') && !batches[0].includes('chk_3'), 'The first call must be the left half only');
  assert(singles[0].includes('chk_3'), 'The right half single must be chk_3');
  assert(fx.calls.every(call => !call.includes('chk_4')), 'No model call may include the taken chunk');
  assert(fx.store.marks.length === 0, `Nothing may be marked failed/retry_wait, got ${JSON.stringify(fx.store.marks)}`);
  assert(fx.store.chunks.get('chk_4').abstractionWorkerId === 'wkr_B', 'The new owner keeps its claim');
});

test('lease: a chunk taken at the batch guard is stale and left out of the fallback; the rest finish as singles', async () => {
  const fx = await makeLeaseFixture({
    visualCount: 0,
    textCount: 3,
    callMs: 5,
    // renewal 1 of chk_2 is before the messages are built, renewal 2 is the guard right before the paid batch call
    storeHooks: { onRenew: async (id, n, store) => { if (id === 'chk_2' && n === 2) await stealChunk(store, 'chk_2'); } },
  });
  const { result: results, warnings } = await withWarnings(() => fx.run());
  const byId = statusById(results);
  assert(results.length === 3, `Expected one result per chunk, got ${results.length}`);
  assert(byId.chk_2 === 'stale', `The taken chunk must be stale, got ${byId.chk_2}`);
  assert(byId.chk_1 === 'completed' && byId.chk_3 === 'completed', `The others must complete as singles, got ${JSON.stringify(byId)}`);
  assert(fx.calls.length === 2 && fx.calls.every(call => !call.schema), `The batch must not be paid; expected 2 singles, got ${fx.calls.length} calls`);
  assert(fx.calls.every(call => !call.includes('chk_2')), 'No call may include the taken chunk');
  assert(fx.store.marks.length === 0, `Nothing may be marked failed/retry_wait, got ${JSON.stringify(fx.store.marks)}`);
  assert(fx.store.chunks.get('chk_2').abstractionWorkerId === 'wkr_B', 'The new owner keeps its claim');
  // The batch catch sorts the taken chunk out before the fallback. The fallback's own skip would also return stale,
  // so the fallback log (which chunks it was handed, and why) is what shows the catch did its job.
  const fallbacks = warnings.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(entry => entry?.event === 'abstraction_batch_fallback');
  assert(fallbacks.length === 1, `Expected one fallback, got ${fallbacks.length}`);
  assert(fallbacks[0].chunkIds.join(',') === 'chk_1,chk_3', `The fallback must only get the chunks still ours, got ${fallbacks[0].chunkIds}`);
  assert(/lease was taken/.test(fallbacks[0].reason), `The fallback reason must be the lost lease, got ${fallbacks[0].reason}`);
});

test('lease: a visual solo that finished leaves the held set and is not renewed on later paid calls', async () => {
  const atCall = {};
  const fx = await makeLeaseFixture({
    callMs: 5,
    // When paid call n starts, chk_n has been renewed for it and not saved yet. Anything after that is a late renewal.
    onCall: async (n, store) => {
      const count = id => store.renewCalls.filter(x => x === id).length;
      if (n <= 2) atCall[`chk_${n}`] = count(`chk_${n}`);
      if (n === 2) atCall.chk_3 = count('chk_3');
    },
  });
  const results = await fx.run();
  assert(results.length === 5 && results.every(r => r.status === 'completed'), `Expected 5 completed, got ${JSON.stringify(statusById(results))}`);
  const renewals = id => fx.store.renewCalls.filter(x => x === id).length;
  for (const id of ['chk_1', 'chk_2']) {
    assert(atCall[id] > 0, `${id} must be renewed before its own paid call`);
    assert(renewals(id) === atCall[id], `${id} finished its solo and must not be renewed again: ${atCall[id]} renewals at its call, ${renewals(id)} at the end`);
  }
  assert(renewals('chk_3') > atCall.chk_3, 'Control: a text chunk still held keeps being renewed through the later paid calls');
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
