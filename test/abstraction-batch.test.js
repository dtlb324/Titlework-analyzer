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
import { applyAbstractionClaim } from '../api/_lib/jobs.js';

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

function createMemoryBatchStore(initialChunks, { enforceWorkerLease = true } = {}) {
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
      const updated = applyAbstractionClaim(chunk, opts);
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
      if (enforceWorkerLease && chunk.abstractionWorkerId && record.workerId && chunk.abstractionWorkerId !== record.workerId) return null;
      chunks.set(record.chunkId, { ...chunk, abstractionStatus: 'completed', abstractionWorkerId: null, abstractionLeaseExpiresAt: null });
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

function withBulkLeaseStore(store, bulkCalls = []) {
  store.renewChunkAbstractionLeases = async (jobId, chunkIds, opts = {}) => {
    bulkCalls.push({ jobId, chunkIds: [...chunkIds], leaseMs: opts.leaseMs });
    const renewed = [];
    for (const id of chunkIds) {
      const chunk = store.chunks.get(id);
      if (!chunk || chunk.abstractionStatus !== 'processing' || !opts.workerId || chunk.abstractionWorkerId !== opts.workerId) continue;
      const updated = { ...chunk, abstractionLeaseExpiresAt: Date.now() + (opts.leaseMs || 90_000) };
      store.chunks.set(id, updated);
      renewed.push(updated);
    }
    return renewed;
  };
  store.renewChunkAbstractionLease = async () => {
    throw new Error('singular renewChunkAbstractionLease must not be called when bulk renewal exists');
  };
  return store;
}

test('lease: bulk renewal keeps 6 visual solos linear (12 bulk DB calls, 0 singular) and stops steals', async () => {
  const bulkCalls = [];
  const fx = await makeLeaseFixture({
    visualCount: 6,
    textCount: 0,
    callMs: 5,
    leaseMs: 150,
    storeWrap: store => withBulkLeaseStore(store, bulkCalls),
    onCall: async (_n, store) => { await workerBSweep(store, fx.allIds); },
  });
  const results = await fx.run();
  const stolen = fx.store.claims.filter(c => c.workerId === 'wkr_B');
  assert(stolen.length === 0, `Worker B must never steal a live chunk, got ${JSON.stringify(stolen)}`);
  assert(results.length === 6 && results.every(r => r.status === 'completed'), `Expected 6 completed, got ${JSON.stringify(statusById(results))}`);
  assert(bulkCalls.length === 12, `Expected 12 bulk renewals for 6 visual solos (2 per solo), got ${bulkCalls.length}`);
  assert(fx.store.renewCalls.length === 0, `Expected 0 singular renewals, got ${fx.store.renewCalls.length}`);
});

test('lease: bulk renewal marks a stolen waiting text chunk stale and omits it from the batch call', async () => {
  const bulkCalls = [];
  const fx = await makeLeaseFixture({
    visualCount: 1,
    textCount: 3,
    callMs: 5,
    storeWrap: store => withBulkLeaseStore(store, bulkCalls),
    onCall: async (n, store) => {
      if (n === 1) await stealChunk(store, 'chk_3');
    },
  });
  const results = await fx.run();
  const byId = statusById(results);
  assert(byId.chk_3 === 'stale', `Stolen waiting chunk must be stale, got ${byId.chk_3}`);
  assert(['chk_1', 'chk_2', 'chk_4'].every(id => byId[id] === 'completed'), `Remaining chunks must complete, got ${JSON.stringify(byId)}`);
  assert(fx.calls.every(call => !call.includes('chk_3')), 'Stolen chunk must not be sent to the model');
  assert(bulkCalls.length > 0 && fx.store.renewCalls.length === 0, 'Only bulk renewal should be used');
});

test('lease: partial-parse fallback drops already-persisted batch chunks before renewing fallback singles', async () => {
  const bulkCalls = [];
  let batchFinished = false;
  const fx = await makeLeaseFixture({
    visualCount: 0,
    textCount: 3,
    callMs: 5,
    storeWrap: store => {
      withBulkLeaseStore(store, bulkCalls);
      const save = store.saveDocumentAbstract;
      store.saveDocumentAbstract = async record => {
        const res = await save(record);
        if (record.chunkId === 'chk_2') batchFinished = true;
        return res;
      };
      return store;
    },
  });
  // Fail chk_3 persistence once so only chk_3 enters partial fallback after chk_1 and chk_2 save.
  let chk3PersistFailures = 0;
  const realSave = fx.store.saveDocumentAbstract;
  fx.store.saveDocumentAbstract = async record => {
    if (record.chunkId === 'chk_3' && chk3PersistFailures === 0) {
      chk3PersistFailures += 1;
      throw new Error('transient save failure');
    }
    return await realSave(record);
  };
  const { result: results } = await withWarnings(() => fx.run());
  assert(results.length === 3 && results.every(r => r.status === 'completed'), `Expected 3 completed, got ${JSON.stringify(statusById(results))}`);
  assert(chk3PersistFailures === 1 && batchFinished, 'Test setup must fail chk_3 persist after chk_1 and chk_2 saved');
  const fallbackBulkCalls = bulkCalls.slice(-1);
  assert(fallbackBulkCalls.length === 1 && JSON.stringify(fallbackBulkCalls[0].chunkIds) === JSON.stringify(['chk_3']), `Only chk_3 should be renewed during fallback, got ${JSON.stringify(fallbackBulkCalls)}`);
});

test('isAbstractionBatchingEnabled defaults to true', () => {
  const previous = process.env.ABSTRACTION_BATCH_ENABLED;
  delete process.env.ABSTRACTION_BATCH_ENABLED;
  assert(isAbstractionBatchingEnabled() === true, 'Expected batching on by default');
  if (previous === undefined) delete process.env.ABSTRACTION_BATCH_ENABLED;
  else process.env.ABSTRACTION_BATCH_ENABLED = previous;
});

function cleanBatchAbstract(grantor = 'John Smith', note = 'Clear batch abstract.') {
  return [
    'DOC TYPE: Warranty Deed',
    'DATE EXECUTED: January 1, 2020',
    'DATE RECORDED: January 2, 2020',
    'RECORDING REF: Vol 1, Page 2',
    `GRANTOR: ${grantor}`,
    'GRANTEE: Mary Jones',
    'LEGAL DESC: Section 1, Block C-9',
    'MINERALS: yes - 1/2',
    'FRACTION CONVEYED: 1/2 mineral interest',
    'ISSUES: none noted',
    `CONFIDENCE: ${note}`,
  ].join('\n');
}

async function makeBatchTextPdf(textLine) {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText(textLine, { x: 36, y: 740, size: 10, font });
  page.drawText('Executed January 1, 2020 and recorded January 2, 2020 in Vol 1, Page 2, Section 1, Block C-9.', { x: 36, y: 720, size: 10, font });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function makeBatchScannedPdf(bytesSize = 120_000) {
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('ScanData'), doc.context.register(doc.context.stream(Buffer.alloc(bytesSize, 67))));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function withEnv(vars, fn) {
  const prev = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('processMultiChunkAbstraction escalates only flagged text-mode item via visual PDF bytes', async () => {
  const pdf0 = await makeBatchTextPdf('WARRANTY DEED: Grantor Alice One conveys to Grantee Mary Jones.');
  const pdf1 = await makeBatchTextPdf('WARRANTY DEED: Grantor Bob Two conveys to Grantee Mary Jones.');
  const pdf2 = await makeBatchTextPdf('WARRANTY DEED: Grantor Carol Three conveys to Grantee Mary Jones.');
  const bytesById = new Map([['chk_0', pdf0], ['chk_1', pdf1], ['chk_2', pdf2]]);

  const chunks = [
    makeChunk('chk_0', pdf0.byteLength, { chunkOrder: 0 }),
    makeChunk('chk_1', pdf1.byteLength, { chunkOrder: 1 }),
    makeChunk('chk_2', pdf2.byteLength, { chunkOrder: 2 }),
  ];
  const store = createMemoryBatchStore(chunks);
  const calls = [];

  const results = await processMultiChunkAbstraction(chunks, {
    store,
    workerId: 'wkr_batch_esc',
    blobLoader: async chunk => ({ bytes: bytesById.get(chunk.id), mediaType: 'application/pdf' }),
    modelClient: async req => {
      calls.push(req);
      if (!req.escalation) {
        return {
          text: JSON.stringify([
            { docIndex: 1, abstract: cleanBatchAbstract('Alice One') },
            { docIndex: 2, abstract: cleanBatchAbstract('Bob Two').replace('RECORDING REF: Vol 1, Page 2', 'RECORDING REF: ILLEGIBLE - VERIFY MANUALLY') },
            { docIndex: 3, abstract: cleanBatchAbstract('Carol Three') },
          ]),
          model: 'gemini-3.1-flash-lite',
          usage: { input_tokens: 300, output_tokens: 90 },
        };
      }
      return {
        text: cleanBatchAbstract('Bob Two', 'Visual solo batch escalation verified.'),
        model: 'claude-sonnet-5-5',
        usage: { input_tokens: 50, output_tokens: 40 },
      };
    },
  });

  assert(results.every(r => r.status === 'completed'), 'Expected all 3 chunks completed');
  assert(calls.length === 2, `Expected 1 batch call + 1 solo escalation call, got ${calls.length}`);
  assert(calls[1].escalation === true, 'Second call should be solo escalation');
  const escContent = calls[1].messages[0].content;
  const docBlock = escContent.find(b => b.type === 'document');
  assert(docBlock?.source?.type === 'base64' && docBlock.source.data === pdf1.toString('base64'), 'Escalation must send flagged item visual PDF bytes');
  assert(!escContent.at(-1).text.includes('EXTRACTED PDF TEXT'), 'Escalation must not send text-only prompt');

  assert(store.abstracts.get('chk_0').modelUsed === 'gemini-3.1-flash-lite');
  assert(store.abstracts.get('chk_0').inputTokens === 100 && store.abstracts.get('chk_0').outputTokens === 30);
  assert(store.abstracts.get('chk_2').modelUsed === 'gemini-3.1-flash-lite');

  const abs1 = store.abstracts.get('chk_1');
  assert(abs1.modelUsed === 'claude-sonnet-5-5', 'Flagged chunk must save escalated model');
  assert(abs1.abstractText.includes('Visual solo batch escalation verified.'), 'Flagged chunk must save escalated text');
  assert(abs1.inputTokens === 150 && abs1.outputTokens === 70, 'Flagged chunk must sum batch share + escalation tokens');
});

test('processMultiChunkAbstraction escalates gemini_file batch item with base64 PDF bytes instead of file_uri', async () => {
  const scannedPdf = await makeBatchScannedPdf(120_000);
  const cleanTextPdf = await makeBatchTextPdf('WARRANTY DEED: Grantor Clean Owner conveys to Grantee Mary Jones.');
  const bytesById = new Map([['chk_scan', scannedPdf], ['chk_clean', cleanTextPdf]]);
  const chunks = [
    makeChunk('chk_scan', scannedPdf.byteLength, { chunkOrder: 0 }),
    makeChunk('chk_clean', cleanTextPdf.byteLength, { chunkOrder: 1 }),
  ];

  const prevFetch = globalThis.fetch;
  let uploads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (init.method === 'POST' && target.includes('/upload/v1beta/files')) {
      uploads += 1;
      return new Response(JSON.stringify({
        file: {
          uri: `https://generativelanguage.googleapis.com/v1beta/files/batch_${uploads}`,
          name: `files/batch_${uploads}`,
          mimeType: 'application/pdf',
        },
      }), { status: 200 });
    }
    if (target.includes('/files/batch_')) {
      return new Response(JSON.stringify({ state: 'ACTIVE' }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${target}`);
  };

  try {
    await withEnv({
      GEMINI_API_KEY: 'synthetic-key',
      GEMINI_FILE_API_ENABLED: 'true',
      GEMINI_FILE_API_MIN_BYTES: '100000',
    }, async () => {
      for (const targetModel of ['claude-sonnet-5-5', 'anthropic/claude-haiku-5.5']) {
        const store = createMemoryBatchStore(chunks);
        const calls = [];
        await processMultiChunkAbstraction(chunks, {
          store,
          workerId: 'wkr_gf_batch',
          escalationModel: targetModel,
          blobLoader: async chunk => ({ bytes: bytesById.get(chunk.id), mediaType: 'application/pdf' }),
          modelClient: async req => {
            calls.push(req);
            if (req.escalation) {
              return { text: cleanBatchAbstract('Scan Owner', 'Verified via base64.'), model: targetModel, usage: {} };
            }
            if (req.messages[0].content.some(b => b.type === 'document')) {
              return {
                text: cleanBatchAbstract('Scan Owner').replace('CONFIDENCE: Clear batch abstract.', 'CONFIDENCE: low'),
                model: 'gemini-3.1-flash-lite',
                usage: {},
              };
            }
            return {
              text: cleanBatchAbstract('Clean Owner'),
              model: 'gemini-3.1-flash-lite',
              usage: {},
            };
          },
        });
        assert(calls.length === 3, `Expected solo scan + escalation + solo clean, got ${calls.length}`);
        assert(calls[0].messages[0].content.some(b => b.type === 'document' && b.source.type === 'file_uri'), 'Visual solo Tier 1 should use file_uri for scanned PDF');
        const escDoc = calls[1].messages[0].content.find(b => b.type === 'document');
        assert(escDoc.source.type === 'base64' && escDoc.source.data === scannedPdf.toString('base64'), `${targetModel} escalation must send base64, never file_uri`);
      }
    });
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('processMultiChunkAbstraction enforces worker lease before and during per-chunk escalation', async () => {
  const pdf0 = await makeBatchTextPdf('WARRANTY DEED: Grantor Alice One conveys to Grantee Mary Jones.');
  const pdf1 = await makeBatchTextPdf('WARRANTY DEED: Grantor Bob Two conveys to Grantee Mary Jones.');
  const chunks = [
    makeChunk('chk_0', pdf0.byteLength, { chunkOrder: 0 }),
    makeChunk('chk_1', pdf1.byteLength, { chunkOrder: 1 }),
  ];

  // Case A: Lease lost BEFORE escalation -> escalation model call is skipped.
  const storeBefore = createMemoryBatchStore(chunks);
  let escCallsBefore = 0;
  const resBefore = await processMultiChunkAbstraction(chunks, {
    store: storeBefore,
    workerId: 'wkr_old',
    blobLoader: async c => ({ bytes: c.id === 'chk_0' ? pdf0 : pdf1, mediaType: 'application/pdf' }),
    modelClient: async req => {
      if (req.escalation) {
        escCallsBefore += 1;
        return { text: cleanBatchAbstract('Bob Two'), model: req.model, usage: {} };
      }
      storeBefore.chunks.set('chk_1', { ...storeBefore.chunks.get('chk_1'), abstractionWorkerId: 'wkr_new' });
      return {
        text: JSON.stringify([
          { docIndex: 1, abstract: cleanBatchAbstract('Alice One') },
          { docIndex: 2, abstract: cleanBatchAbstract('Bob Two').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY') },
        ]),
        model: 'gemini-3.1-flash-lite',
        usage: {},
      };
    },
  });
  assert(escCallsBefore === 0, 'Lost lease before escalation must skip billable escalation call');
  assert(resBefore.find(r => r.chunkId === 'chk_1')?.status === 'stale');

  // Case B: Lease lost DURING escalation -> returns stale without overwriting.
  const storeDuring = createMemoryBatchStore(chunks);
  const resDuring = await processMultiChunkAbstraction(chunks, {
    store: storeDuring,
    workerId: 'wkr_old',
    blobLoader: async c => ({ bytes: c.id === 'chk_0' ? pdf0 : pdf1, mediaType: 'application/pdf' }),
    modelClient: async req => {
      if (req.escalation) {
        storeDuring.chunks.set('chk_1', { ...storeDuring.chunks.get('chk_1'), abstractionStatus: 'completed', abstractionWorkerId: 'wkr_new' });
        storeDuring.abstracts.set('chk_1', { chunkId: 'chk_1', abstractText: 'Newer worker won.' });
        return { text: cleanBatchAbstract('Bob Two', 'Stale escalation'), model: req.model, usage: {} };
      }
      return {
        text: JSON.stringify([
          { docIndex: 1, abstract: cleanBatchAbstract('Alice One') },
          { docIndex: 2, abstract: cleanBatchAbstract('Bob Two').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY') },
        ]),
        model: 'gemini-3.1-flash-lite',
        usage: {},
      };
    },
  });
  assert(resDuring.find(r => r.chunkId === 'chk_1')?.status === 'stale');
  assert(storeDuring.abstracts.get('chk_1').abstractText === 'Newer worker won.');
});

test('processMultiChunkAbstraction bounds escalation to once, handles escalation errors cleanly, and respects disable flags', async () => {
  const pdf0 = await makeBatchTextPdf('WARRANTY DEED: Grantor Alice One conveys to Grantee Mary Jones.');
  const pdf1 = await makeBatchTextPdf('WARRANTY DEED: Grantor Bob Two conveys to Grantee Mary Jones.');
  const chunks = [
    makeChunk('chk_0', pdf0.byteLength, { chunkOrder: 0 }),
    makeChunk('chk_1', pdf1.byteLength, { chunkOrder: 1 }),
  ];

  // Bounded once even when escalated output still has ILLEGIBLE, plus escalation error keeps Tier 1 without fallbackToSingles.
  const warnings = [];
  const prevWarn = console.warn;
  console.warn = msg => warnings.push(msg);
  try {
    const storeErr = createMemoryBatchStore(chunks);
    let calls = 0;
    const resErr = await processMultiChunkAbstraction(chunks, {
      store: storeErr,
      workerId: 'wkr_err',
      blobLoader: async c => ({ bytes: c.id === 'chk_0' ? pdf0 : pdf1, mediaType: 'application/pdf' }),
      modelClient: async req => {
        calls += 1;
        if (!req.escalation) {
          return {
            text: JSON.stringify([
              { docIndex: 1, abstract: cleanBatchAbstract('Alice One').replace('GRANTOR: Alice One', 'GRANTOR: ILLEGIBLE - VERIFY MANUALLY') },
              { docIndex: 2, abstract: cleanBatchAbstract('Bob Two').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY') },
            ]),
            model: 'gemini-3.1-flash-lite',
            usage: {},
          };
        }
        if (calls === 2) {
          return {
            text: cleanBatchAbstract('Alice One').replace('GRANTOR: Alice One', 'GRANTOR: ILLEGIBLE - VERIFY MANUALLY'),
            model: 'claude-sonnet-5-5',
            usage: {},
          };
        }
        throw new Error('escalation outage');
      },
    });
    assert(resErr.every(r => r.status === 'completed'));
    assert(calls === 3, `Expected 1 batch + 2 bounded single escalations (no loops or fallbackToSingles), got ${calls}`);
    assert(storeErr.abstracts.get('chk_0').modelUsed === 'claude-sonnet-5-5');
    assert(storeErr.abstracts.get('chk_1').modelUsed === 'gemini-3.1-flash-lite', 'Failed escalation must preserve Tier 1 model');
    const parsedWarn = warnings.map(w => { try { return JSON.parse(w); } catch { return null; } }).find(e => e?.event === 'abstraction_escalation_failed');
    assert(parsedWarn && parsedWarn.chunkId === 'chk_1');
    assert(!warnings.some(w => String(w).includes('abstraction_batch_fallback')), 'Failed escalation must not trigger batch fallbackToSingles');

    // Post-escalation DB error uses noEscalateFallbackChunks so escalation never runs twice.
    warnings.length = 0;
    const storeDbErr = createMemoryBatchStore(chunks);
    const origSave = storeDbErr.saveDocumentAbstract.bind(storeDbErr);
    let failFirstSaveForChk1 = true;
    storeDbErr.saveDocumentAbstract = async record => {
      if (record.chunkId === 'chk_1' && failFirstSaveForChk1) {
        failFirstSaveForChk1 = false;
        throw new Error('transient DB write failure');
      }
      return origSave(record);
    };
    let escCount = 0;
    await processMultiChunkAbstraction(chunks, {
      store: storeDbErr,
      workerId: 'wkr_db_err',
      blobLoader: async c => ({ bytes: c.id === 'chk_0' ? pdf0 : pdf1, mediaType: 'application/pdf' }),
      modelClient: async req => {
        if (req.escalation) {
          escCount += 1;
          return { text: cleanBatchAbstract('Bob Two', 'Escalated once.'), model: 'claude-sonnet-5-5', usage: {} };
        }
        return {
          text: JSON.stringify([
            { docIndex: 1, abstract: cleanBatchAbstract('Alice One') },
            { docIndex: 2, abstract: cleanBatchAbstract('Bob Two').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY') },
          ]),
          model: 'gemini-3.1-flash-lite',
          usage: {},
        };
      },
    });
    assert(escCount === 1, `Post-escalation DB fallback must not re-fire billable escalation, got ${escCount}`);
  } finally {
    console.warn = prevWarn;
  }

  // escalationEnabled: false and ABSTRACTION_ESCALATION_ENABLED=false disable batch escalation.
  const storeOffOpt = createMemoryBatchStore(chunks);
  let offOptCalls = 0;
  await processMultiChunkAbstraction(chunks, {
    store: storeOffOpt,
    workerId: 'wkr_off_opt',
    escalationEnabled: false,
    blobLoader: async c => ({ bytes: c.id === 'chk_0' ? pdf0 : pdf1, mediaType: 'application/pdf' }),
    modelClient: async () => {
      offOptCalls += 1;
      return {
        text: JSON.stringify([
          { docIndex: 1, abstract: cleanBatchAbstract('Alice One').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY') },
          { docIndex: 2, abstract: cleanBatchAbstract('Bob Two') },
        ]),
        model: 'gemini-3.1-flash-lite',
        usage: {},
      };
    },
  });
  assert(offOptCalls === 1, 'escalationEnabled: false must prevent batch per-item escalation');

  await withEnv({ ABSTRACTION_ESCALATION_ENABLED: 'false' }, async () => {
    const storeOffEnv = createMemoryBatchStore(chunks);
    let offEnvCalls = 0;
    await processMultiChunkAbstraction(chunks, {
      store: storeOffEnv,
      workerId: 'wkr_off_env',
      blobLoader: async c => ({ bytes: c.id === 'chk_0' ? pdf0 : pdf1, mediaType: 'application/pdf' }),
      modelClient: async () => {
        offEnvCalls += 1;
        return {
          text: JSON.stringify([
            { docIndex: 1, abstract: cleanBatchAbstract('Alice One').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY') },
            { docIndex: 2, abstract: cleanBatchAbstract('Bob Two') },
          ]),
          model: 'gemini-3.1-flash-lite',
          usage: {},
        };
      },
    });
    assert(offEnvCalls === 1, 'ABSTRACTION_ESCALATION_ENABLED=false must prevent batch per-item escalation');
  });
});

// ---- lease expiry / renewal (fake clock, owner-checked store) ----
const LEASE_UPSTREAM_MS = 240_000;

function createLeaseStore(chunksInput, clock, { renew = true, renewThrows = null } = {}) {
  const chunks = new Map(chunksInput.map(c => [c.id, { ...c }]));
  const abstracts = new Map();
  const log = [];
  const store = {
    chunks,
    abstracts,
    log,
    async getChunk(_jobId, id) { return chunks.get(id) || null; },
    async claimChunkForAbstraction(_jobId, id, opts = {}) {
      const c = chunks.get(id);
      if (!c) return null;
      const mine = c.abstractionStatus === 'processing' && c.abstractionWorkerId === opts.workerId;
      const expired = c.abstractionStatus === 'processing' && c.abstractionLeaseExpiresAt <= clock.t;
      if (c.abstractionStatus !== 'pending' && !mine && !expired) return null;
      const updated = {
        ...c,
        abstractionStatus: 'processing',
        abstractionWorkerId: opts.workerId,
        abstractionAttempts: mine ? c.abstractionAttempts : (c.abstractionAttempts || 0) + 1,
        abstractionLeaseExpiresAt: clock.t + (opts.leaseMs || 90_000),
      };
      chunks.set(id, updated);
      log.push(`claim ${id} ${opts.workerId}`);
      return updated;
    },
    async getDocumentAbstractByChunkId() { return null; },
    async saveDocumentAbstract(record) {
      const c = chunks.get(record.chunkId);
      if (!c || c.abstractionStatus !== 'processing' || c.abstractionWorkerId !== record.workerId) return null;
      abstracts.set(record.chunkId, { ...record });
      chunks.set(record.chunkId, { ...c, abstractionStatus: 'completed', abstractionWorkerId: null });
      return record;
    },
    async markChunkAbstractionFailed(_jobId, id, failure) {
      const c = chunks.get(id);
      if (!c || c.abstractionWorkerId !== failure.workerId) return null;
      chunks.set(id, { ...c, abstractionStatus: 'failed' });
      return chunks.get(id);
    },
    async markChunkAbstractionRetryWait(_jobId, id, failure) {
      const c = chunks.get(id);
      if (!c || c.abstractionWorkerId !== failure.workerId) return null;
      chunks.set(id, { ...c, abstractionStatus: 'retry_wait' });
      return chunks.get(id);
    },
  };
  if (renew) {
    store.renewChunkAbstractionLease = async (_jobId, id, opts = {}) => {
      if (renewThrows) throw new Error(renewThrows);
      const c = chunks.get(id);
      if (!c || c.abstractionStatus !== 'processing' || c.abstractionWorkerId !== opts.workerId) return null;
      const updated = { ...c, abstractionLeaseExpiresAt: clock.t + opts.leaseMs };
      chunks.set(id, updated);
      return updated;
    };
  }
  return store;
}

const LEASE_FLAG = 'RECORDING REF: ILLEGIBLE - VERIFY MANUALLY';
function leaseTier1(req, flaggedIdx) {
  const prompt = JSON.stringify(req.messages);
  const matches = [...prompt.matchAll(/START DOCUMENT #(\d+) \(chk_(\d+)\.pdf\)/g)];
  return JSON.stringify(matches.map(m => {
    const docIndex = Number(m[1]);
    const idx = Number(m[2]);
    const text = cleanBatchAbstract(`Owner ${idx}`);
    return {
      docIndex,
      abstract: flaggedIdx.has(idx) ? text.replace('RECORDING REF: Vol 1, Page 2', LEASE_FLAG) : text,
    };
  }));
}

async function runLeaseScenario({ count = 12, flagged = [1, 3, 5, 7, 8, 9, 10], renew = true, tier1Ms = 200, sonnetMs = 45_000, firstLeaseMs = 150, hook = null, storeOpts = {} } = {}) {
  const pdf = await makeBatchTextPdf('WARRANTY DEED: Grantor Alice One conveys to Grantee Mary Jones.');
  const flaggedIdx = new Set(flagged);
  const chunks = Array.from({ length: count }, (_, i) => makeChunk(`chk_${i}`, pdf.byteLength, { chunkOrder: i, abstractionAttempts: 0 }));
  const clock = { t: 1_000_000 };
  const store = createLeaseStore(chunks, clock, { renew, ...storeOpts });
  const sonnetCalls = [];
  const bClaims = new Set();
  // Worker B polls after every paid call and takes the first expired chunk it can.
  const workerBPoll = async () => {
    for (const c of chunks) {
      if (bClaims.has(c.id)) continue;
      const got = await store.claimChunkForAbstraction('job_1', c.id, { workerId: 'wkr_B', leaseMs: 90_000 });
      if (got) { bClaims.add(c.id); return; }
    }
  };
  const results = await processMultiChunkAbstraction(chunks, {
    store,
    workerId: 'wkr_A',
    leaseMs: firstLeaseMs,
    blobLoader: async () => ({ bytes: pdf, mediaType: 'application/pdf' }),
    modelClient: async req => {
      if (!req.escalation) {
        clock.t += tier1Ms;
        if (hook) await hook({ phase: 'tier1', store, clock });
        await workerBPoll();
        return { text: leaseTier1(req, flaggedIdx), model: 'gemini-3.1-flash-lite', usage: {} };
      }
      const chunkId = currentEscChunk(req, chunks);
      const live = store.chunks.get(chunkId);
      sonnetCalls.push({ chunkId, leaseRemainingMs: live?.abstractionLeaseExpiresAt - clock.t, owner: live?.abstractionWorkerId });
      if (hook) await hook({ phase: 'sonnet', store, clock, chunkId });
      clock.t += sonnetMs;
      await workerBPoll();
      return { text: cleanBatchAbstract('Sonnet Owner', 'Sonnet verified.'), model: 'claude-sonnet-5-5', usage: {} };
    },
  });
  return { results, store, sonnetCalls, bClaims, chunks, clock };
}

function currentEscChunk(req, chunks) {
  // Escalation requests carry the flagged chunk's PDF via its filename and/or "DOCUMENT #n".
  const text = JSON.stringify(req.messages);
  const byName = text.match(/DOCUMENT #\d+ \((chk_\d+)\.pdf\)/);
  if (byName) return byName[1];
  const m = text.match(/DOCUMENT #(\d+)/);
  return m ? chunks[Number(m[1]) - 1]?.id : null;
}

test('lease: slow sequential escalations never let another worker reclaim or double-bill a chunk', async () => {
  const { results, sonnetCalls, bClaims, store } = await runLeaseScenario();
  const perChunk = new Map();
  for (const call of sonnetCalls) perChunk.set(call.chunkId, (perChunk.get(call.chunkId) || 0) + 1);
  const billedTwice = [...bClaims].filter(id => perChunk.get(id));
  const stale = results.filter(r => r.status === 'stale');
  const summary = `sonnetCalls=${sonnetCalls.length} chunksBilledTwice=${billedTwice.length} (${billedTwice.join(',')}) reclaimedByB=${bClaims.size} (${[...bClaims].join(',')}) stale=${results.filter(r => r.status === 'stale').length}`;
  assert(billedTwice.length === 0 && bClaims.size === 0 && stale.length === 0, summary);
  assert(sonnetCalls.length === 7, `Expected 7 Sonnet calls (one per flagged chunk), got ${sonnetCalls.length}`);
  assert([...perChunk.values()].every(n => n === 1), 'No chunk may get two Sonnet calls');
  assert(bClaims.size === 0, `Worker B must never reclaim a live chunk, reclaimed: ${[...bClaims].join(',')}`);
  assert(billedTwice.length === 0, `Chunks billed by A and then reclaimed by B: ${billedTwice.join(',')}`);
  assert(stale.length === 0, `No stale results expected, got ${stale.map(r => r.chunkId).join(',')}`);
  assert(results.length === 12 && results.every(r => r.status === 'completed'), 'Expected all 12 chunks completed');
  assert(store.abstracts.size === 12 && [...store.abstracts.values()].every(a => a.workerId === 'wkr_A'), 'All abstracts saved by worker A');
});

test('lease: an expired but unclaimed lease is renewed before the escalation call', async () => {
  const { results, sonnetCalls } = await runLeaseScenario({
    count: 2, flagged: [1], tier1Ms: 10_000, firstLeaseMs: 1000, storeOpts: {},
  });
  // Poll by B is disabled implicitly: the tier-1 poll claims chunk 0 (expired). Only chunk 1 escalates.
  assert(sonnetCalls.length <= 1, 'At most one Sonnet call');
  for (const call of sonnetCalls) {
    assert(call.leaseRemainingMs >= LEASE_UPSTREAM_MS + 60_000 - 5_000, `Lease at Sonnet call must cover upstream timeout + 60s, got ${call.leaseRemainingMs}ms`);
  }
  assert(results.length === 2, 'Expected 2 results');
});

test('lease: lease stolen before an escalation => stale, no Sonnet call for it, Tier-1 abstract not persisted by A', async () => {
  const { results, sonnetCalls, store } = await runLeaseScenario({
    count: 3, flagged: [1], tier1Ms: 0, firstLeaseMs: 90_000,
    hook: async ({ phase, store: st, clock }) => {
      if (phase !== 'tier1') return;
      // B takes chunk 1 outright during the Tier-1 call (A's lease on it has lapsed).
      const c = st.chunks.get('chk_1');
      st.chunks.set('chk_1', { ...c, abstractionWorkerId: 'wkr_B', abstractionLeaseExpiresAt: clock.t + 90_000 });
    },
  });
  assert(sonnetCalls.length === 0, `No Sonnet call may be paid for a stolen chunk, got ${sonnetCalls.length}`);
  const r1 = results.find(r => r.chunkId === 'chk_1');
  assert(r1?.status === 'stale', `Expected chk_1 stale, got ${r1?.status}`);
  assert(!store.abstracts.has('chk_1'), 'A must not persist the Tier-1 abstract for a chunk it lost');
  assert(store.chunks.get('chk_1').abstractionWorkerId === 'wkr_B', 'B keeps its claim');
  assert(results.filter(r => r.status === 'completed').length === 2, 'The other two chunks complete');
});

test('lease: a renewal that throws is logged and the batch proceeds', async () => {
  const warnings = [];
  const prevWarn = console.warn;
  console.warn = msg => warnings.push(msg);
  try {
    const { results, sonnetCalls } = await runLeaseScenario({
      count: 3, flagged: [1], tier1Ms: 0, firstLeaseMs: 90_000, storeOpts: { renewThrows: 'db blip' },
    });
    assert(sonnetCalls.length === 1, `Expected the escalation to proceed, got ${sonnetCalls.length} calls`);
    assert(results.every(r => r.status === 'completed'), `Expected all completed, got ${results.map(r => r.status)}`);
    assert(warnings.some(w => String(w).includes('abstraction_chunk_lease_renew_failed')), 'Expected a renew-failed warning');
  } finally {
    console.warn = prevWarn;
  }
});

test('lease: a store without renewChunkAbstractionLease keeps the status/worker guard', async () => {
  const plain = await runLeaseScenario({ count: 3, flagged: [1], tier1Ms: 0, firstLeaseMs: 90_000, renew: false });
  assert(plain.sonnetCalls.length === 1 && plain.results.every(r => r.status === 'completed'), 'Unchanged happy path without renew');
  const stolen = await runLeaseScenario({
    count: 3, flagged: [1], tier1Ms: 0, firstLeaseMs: 90_000, renew: false,
    hook: async ({ phase, store: st, clock }) => {
      if (phase !== 'tier1') return;
      st.chunks.set('chk_1', { ...st.chunks.get('chk_1'), abstractionWorkerId: 'wkr_B', abstractionLeaseExpiresAt: clock.t + 90_000 });
    },
  });
  assert(stolen.sonnetCalls.length === 0, 'Fallback guard must still stop the Sonnet call');
  assert(stolen.results.find(r => r.chunkId === 'chk_1')?.status === 'stale', 'Fallback guard must still report stale');
});

// ---- lease coverage: loss before Tier-1, getChunk failures, fallbackToSingles renewals, held bookkeeping ----
const LEASE_COUNTED = ['tier1', 'solo:', 'sonnet:'];

function stealLeaseChunk(store, clock, id, leaseMs = 3_600_000) {
  store.chunks.set(id, { ...store.chunks.get(id), abstractionWorkerId: 'wkr_B', abstractionLeaseExpiresAt: clock.t + leaseMs });
}

// Records every claim, renewal, save and paid model call of one processMultiChunkAbstraction run in `events`.
async function runLeaseBatch({
  count = 3, flagged = [], renew = true, firstLeaseMs = 150, tier1Throws = false, tier1Ms = 200, soloMs = 0, sonnetMs = 0,
  soloFlagged = false, storeOpts = {}, prepareStore = null, onLoad = null, onModelCall = null, workerBPolls = false,
} = {}) {
  const pdf = await makeBatchTextPdf('WARRANTY DEED: Grantor Alice One conveys to Grantee Mary Jones.');
  const flaggedIdx = new Set(flagged);
  const chunks = Array.from({ length: count }, (_, i) => makeChunk(`chk_${i}`, pdf.byteLength, { chunkOrder: i, abstractionAttempts: 0 }));
  const clock = { t: 1_000_000 };
  const store = createLeaseStore(chunks, clock, { renew, ...storeOpts });
  const events = [];
  const claim = store.claimChunkForAbstraction;
  store.claimChunkForAbstraction = async (jobId, id, opts = {}) => {
    const got = await claim(jobId, id, opts);
    events.push(`claim:${id}:${opts.workerId}:${got ? 'ok' : 'null'}`);
    return got;
  };
  const save = store.saveDocumentAbstract;
  store.saveDocumentAbstract = async record => {
    const got = await save(record);
    events.push(`save:${record.chunkId}:${got ? 'ok' : 'null'}`);
    return got;
  };
  const renewFn = store.renewChunkAbstractionLease;
  if (renewFn) {
    store.renewChunkAbstractionLease = async (jobId, id, opts) => {
      events.push(`renew:${id}`);
      return renewFn(jobId, id, opts);
    };
  }
  prepareStore?.(store, events, clock);
  const bClaims = new Set();
  const workerBPoll = async () => {
    if (!workerBPolls) return;
    for (const c of chunks) {
      if (bClaims.has(c.id)) continue;
      const got = await store.claimChunkForAbstraction('job_1', c.id, { workerId: 'wkr_B', leaseMs: 90_000 });
      if (got) { bClaims.add(c.id); return; }
    }
  };
  let tier1Calls = 0;
  const results = await processMultiChunkAbstraction(chunks, {
    store,
    workerId: 'wkr_A',
    leaseMs: firstLeaseMs,
    blobLoader: async chunk => {
      await onLoad?.({ chunk, store, clock });
      return { bytes: pdf, mediaType: 'application/pdf' };
    },
    modelClient: async req => {
      if (req.escalation) {
        const id = currentEscChunk(req, chunks);
        events.push(`sonnet:${id}`);
        await onModelCall?.({ phase: 'sonnet', id, store, clock });
        clock.t += sonnetMs;
        await workerBPoll();
        return { text: cleanBatchAbstract('Sonnet Owner', 'Sonnet verified.'), model: 'claude-sonnet-5-5', usage: {} };
      }
      tier1Calls += 1;
      if (tier1Calls === 1) {
        events.push('tier1');
        clock.t += tier1Ms;
        await onModelCall?.({ phase: 'tier1', store, clock });
        await workerBPoll();
        if (tier1Throws) throw new Error('batch upstream failed');
        return { text: leaseTier1(req, flaggedIdx), model: 'gemini-3.1-flash-lite', usage: {} };
      }
      const id = currentEscChunk(req, chunks);
      assert(id, 'Solo request must carry its DOCUMENT #n label');
      events.push(`solo:${id}`);
      await onModelCall?.({ phase: 'solo', id, store, clock });
      clock.t += soloMs;
      await workerBPoll();
      const soloText = cleanBatchAbstract(`Solo ${id}`);
      return {
        text: soloFlagged ? soloText.replace('RECORDING REF: Vol 1, Page 2', LEASE_FLAG) : soloText,
        model: 'gemini-3.1-flash-lite',
        usage: {},
      };
    },
  });
  const paidCalls = events.filter(e => LEASE_COUNTED.some(prefix => e.startsWith(prefix)));
  return { results, store, events, paidCalls, bClaims, chunks, clock };
}

function countEvents(events, name) {
  return events.filter(e => e === name).length;
}

async function quietWarnings(fn) {
  const prevWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = prevWarn;
  }
}

function assertOneResultPerChunk(results, chunks) {
  const ids = results.map(r => r.chunkId).sort();
  assert(JSON.stringify(ids) === JSON.stringify(chunks.map(c => c.id).sort()), `Expected exactly one terminal result per chunk, got ${ids.join(',')}`);
}

test('lease: every chunk lost before the Tier-1 call => all stale, zero model calls', async () => {
  const { results, store, paidCalls, events, chunks } = await runLeaseBatch({
    count: 3, flagged: [1], firstLeaseMs: 90_000,
    onLoad: ({ chunk, store: st, clock }) => stealLeaseChunk(st, clock, chunk.id),
  });
  assert(paidCalls.length === 0, `No model call may be paid when no chunk is held, got ${paidCalls.join(',')}`);
  assertOneResultPerChunk(results, chunks);
  assert(results.every(r => r.status === 'stale'), `Expected every chunk stale, got ${results.map(r => `${r.chunkId}:${r.status}`).join(',')}`);
  assert(store.abstracts.size === 0, 'A must not persist anything for chunks it lost');
  assert(chunks.every(c => store.chunks.get(c.id).abstractionWorkerId === 'wkr_B'), 'B keeps every claim');
  assert(!events.some(e => e.startsWith('save:')), `No save attempt expected, got ${events.filter(e => e.startsWith('save:')).join(',')}`);
});

test('lease: some chunks lost before Tier-1 => batch paid once, lost chunks stale without Sonnet, others complete', async () => {
  const { results, store, events, paidCalls, chunks } = await runLeaseBatch({
    count: 4, flagged: [1, 2], firstLeaseMs: 90_000,
    onLoad: ({ chunk, store: st, clock }) => {
      if (chunk.id === 'chk_1' || chunk.id === 'chk_3') stealLeaseChunk(st, clock, chunk.id);
    },
  });
  assert(countEvents(events, 'tier1') === 1, `The batch must be paid exactly once, got ${countEvents(events, 'tier1')}`);
  assert(paidCalls.join(',') === 'tier1,sonnet:chk_2', `Only the held flagged chunk may be escalated, got ${paidCalls.join(',')}`);
  assertOneResultPerChunk(results, chunks);
  const status = Object.fromEntries(results.map(r => [r.chunkId, r.status]));
  assert(status.chk_0 === 'completed' && status.chk_2 === 'completed', `Held chunks must complete, got ${JSON.stringify(status)}`);
  assert(status.chk_1 === 'stale' && status.chk_3 === 'stale', `Lost chunks must be stale, got ${JSON.stringify(status)}`);
  assert([...store.abstracts.keys()].sort().join(',') === 'chk_0,chk_2', `Only held chunks may be persisted, got ${[...store.abstracts.keys()]}`);
  assert(store.abstracts.get('chk_2').modelUsed === 'claude-sonnet-5-5', 'Held flagged chunk must save the Sonnet abstract');
  assert(store.abstracts.get('chk_0').workerId === 'wkr_A' && store.abstracts.get('chk_2').workerId === 'wkr_A', 'Held chunks saved by A');
  assert(store.chunks.get('chk_1').abstractionWorkerId === 'wkr_B' && store.chunks.get('chk_3').abstractionWorkerId === 'wkr_B', 'B keeps the lost chunks');
});

function assertEscalationSurvivedGetChunkFailure({ results, store, events, paidCalls, getChunkFailures }) {
  assert(getChunkFailures() === 1, `The test must actually fail getChunk once at the escalation guard, failed ${getChunkFailures()} times`);
  assert(paidCalls.filter(e => e.startsWith('sonnet:')).join(',') === 'sonnet:chk_1', `Sonnet must still be called once for the flagged chunk, got ${paidCalls.join(',')}`);
  assert(events.indexOf('getChunkFail:chk_1') < events.indexOf('sonnet:chk_1'), 'getChunk must fail at the guard, before the Sonnet call is paid');
  assert(!paidCalls.some(e => e.startsWith('solo:')), `A getChunk failure must not push the chunk into a solo re-run, got ${paidCalls.join(',')}`);
  assert(results.length === 3 && results.every(r => r.status === 'completed'), `Expected all completed, got ${results.map(r => `${r.chunkId}:${r.status}`).join(',')}`);
  const saved = store.abstracts.get('chk_1');
  assert(saved.modelUsed === 'claude-sonnet-5-5' && saved.abstractText.includes('Sonnet Owner'), `Saved abstract must be the Sonnet text, got ${saved.modelUsed}`);
}

function failGetChunkOnceFor(id) {
  let failures = 0;
  return {
    failures: () => failures,
    prepare: (store, events) => {
      const real = store.getChunk;
      store.getChunk = async (jobId, chunkId) => {
        if (chunkId === id && failures === 0) {
          failures += 1;
          events.push(`getChunkFail:${id}`);
          throw new Error('db blip on getChunk');
        }
        return real(jobId, chunkId);
      };
    },
  };
}

test('lease: a getChunk failure at the escalation guard does not cost the Sonnet call (renewal unavailable)', async () => {
  const flaky = failGetChunkOnceFor('chk_1');
  const run = await quietWarnings(() => runLeaseBatch({
    count: 3, flagged: [1], firstLeaseMs: 90_000, storeOpts: { renewThrows: 'db blip' }, prepareStore: flaky.prepare,
  }));
  assertEscalationSurvivedGetChunkFailure({ ...run, getChunkFailures: flaky.failures });
});

test('lease: a getChunk failure at the escalation guard does not cost the Sonnet call (store without renew)', async () => {
  const flaky = failGetChunkOnceFor('chk_1');
  const run = await runLeaseBatch({
    count: 3, flagged: [1], firstLeaseMs: 90_000, renew: false, prepareStore: flaky.prepare,
  });
  assertEscalationSurvivedGetChunkFailure({ ...run, getChunkFailures: flaky.failures });
});

test('lease: held shrinks, so a chunk persisted in the batch loop is not renewed for later escalations', async () => {
  const { results, events, paidCalls } = await runLeaseBatch({ count: 4, flagged: [1, 3], firstLeaseMs: 90_000 });
  assert(results.length === 4 && results.every(r => r.status === 'completed'), `Expected all completed, got ${results.map(r => `${r.chunkId}:${r.status}`).join(',')}`);
  assert(paidCalls.join(',') === 'tier1,sonnet:chk_1,sonnet:chk_3', `Unexpected paid calls ${paidCalls.join(',')}`);
  for (const id of ['chk_0', 'chk_1', 'chk_2', 'chk_3']) {
    const savedAt = events.indexOf(`save:${id}:ok`);
    assert(savedAt !== -1, `${id} must be saved`);
    assert(!events.slice(savedAt + 1).includes(`renew:${id}`), `${id} was renewed after it was persisted`);
  }
  // Pre-batch renewal + every paid call renews the chunks still held.
  const counts = Object.fromEntries(['chk_0', 'chk_1', 'chk_2', 'chk_3'].map(id => [id, countEvents(events, `renew:${id}`)]));
  assert(JSON.stringify(counts) === JSON.stringify({ chk_0: 2, chk_1: 3, chk_2: 3, chk_3: 4 }), `Unexpected renewal counts ${JSON.stringify(counts)}`);
});

test('lease: whole-batch fallback keeps pending chunks from lapsing while slow earlier solos are paid', async () => {
  const { results, store, events, bClaims, chunks } = await quietWarnings(() => runLeaseBatch({
    count: 3, firstLeaseMs: 150, tier1Throws: true, soloMs: 200_000, workerBPolls: true,
  }));
  assert(bClaims.size === 0, `Worker B must never find an expired pending chunk, it reclaimed ${[...bClaims].join(',')}`);
  assertOneResultPerChunk(results, chunks);
  assert(results.every(r => r.status === 'completed'), `Expected all completed, got ${results.map(r => `${r.chunkId}:${r.status}`).join(',')}`);
  assert(store.abstracts.size === 3 && [...store.abstracts.values()].every(a => a.workerId === 'wkr_A'), 'All abstracts saved by worker A');
  assert(events.filter(e => e.startsWith('solo:')).join(',') === 'solo:chk_0,solo:chk_1,solo:chk_2', 'Each chunk is paid for once, as a solo');
});

test('lease: whole-batch fallback renews its own chunk and every chunk still pending before each solo, never a saved one', async () => {
  const { results, events, chunks } = await quietWarnings(() => runLeaseBatch({
    count: 3, firstLeaseMs: 150, tier1Throws: true, soloMs: 1_000,
  }));
  assert(results.length === 3 && results.every(r => r.status === 'completed'), `Expected all completed, got ${results.map(r => `${r.chunkId}:${r.status}`).join(',')}`);
  const fallbackStart = events.indexOf('tier1') + 1;
  for (let k = 0; k < 3; k++) {
    const from = events.indexOf(`claim:chk_${k}:wkr_A:ok`, fallbackStart);
    const to = events.indexOf(`solo:chk_${k}`);
    assert(from !== -1 && to > from, `Expected claim then solo for chk_${k}`);
    const renewed = [...new Set(events.slice(from + 1, to).filter(e => e.startsWith('renew:')))].sort();
    const expected = chunks.filter(c => Number(c.id.slice(4)) >= k).map(c => `renew:${c.id}`).sort();
    assert(JSON.stringify(renewed) === JSON.stringify(expected), `Before solo chk_${k} expected renewals ${expected.join(',')}, got ${renewed.join(',')}`);
  }
});

test('lease: a pending chunk stolen during whole-batch fallback is skipped, not paid, and does not abort earlier solos', async () => {
  const { results, store, events, chunks } = await quietWarnings(() => runLeaseBatch({
    count: 3, firstLeaseMs: 90_000, tier1Throws: true, soloMs: 1_000,
    onModelCall: ({ phase, id, store: st, clock }) => {
      if (phase === 'solo' && id === 'chk_0') stealLeaseChunk(st, clock, 'chk_2');
    },
  }));
  assertOneResultPerChunk(results, chunks);
  const status = Object.fromEntries(results.map(r => [r.chunkId, r.status]));
  assert(status.chk_0 === 'completed' && status.chk_1 === 'completed', `Earlier solos must still complete, got ${JSON.stringify(status)}`);
  assert(status.chk_2 === 'stale', `The stolen chunk must be stale, got ${status.chk_2}`);
  assert(!events.includes('solo:chk_2') && !events.includes('sonnet:chk_2'), 'No paid call may be made for the stolen chunk');
  assert(!store.abstracts.has('chk_2') && store.chunks.get('chk_2').abstractionWorkerId === 'wkr_B', 'B keeps the stolen chunk and nothing is persisted for it');
  assert(events.indexOf('renew:chk_2') !== -1 && events.indexOf('renew:chk_2') < events.indexOf('solo:chk_1'), 'The pending chunk was still renewed before the next solo');
});

function attachBulkLeaseRenewal(store, clock, bulkCalls = [], events = null) {
  store.renewChunkAbstractionLeases = async (_jobId, chunkIds, opts = {}) => {
    bulkCalls.push({ chunkIds: [...chunkIds], leaseMs: opts.leaseMs });
    events?.push(`bulkRenew:${chunkIds.join(',')}`);
    const renewed = [];
    for (const id of chunkIds) {
      const c = store.chunks.get(id);
      if (!c || c.abstractionStatus !== 'processing' || c.abstractionWorkerId !== opts.workerId) continue;
      const updated = { ...c, abstractionLeaseExpiresAt: clock.t + opts.leaseMs };
      store.chunks.set(id, updated);
      renewed.push(updated);
    }
    return renewed;
  };
  store.renewChunkAbstractionLease = async () => {
    throw new Error('singular renewChunkAbstractionLease must not be called when bulk renewal exists');
  };
}

test('lease (#150 double-bill edge): persist-failed escalated chunk stays renewed during first fallback list and never double-bills Sonnet', async () => {
  const pdf = await makeBatchTextPdf('WARRANTY DEED: Grantor Alice One conveys to Grantee Mary Jones.');
  const chunks = Array.from({ length: 4 }, (_, i) => makeChunk(`chk_${i}`, pdf.byteLength, { chunkOrder: i, abstractionAttempts: 0 }));
  const clock = { t: 1_000_000 };
  const store = createLeaseStore(chunks, clock, { renew: false });
  const bulkCalls = [];
  const events = [];
  attachBulkLeaseRenewal(store, clock, bulkCalls, events);

  let chk1PersistThrows = 0;
  const realSave = store.saveDocumentAbstract;
  store.saveDocumentAbstract = async record => {
    if (record.chunkId === 'chk_1' && chk1PersistThrows === 0) {
      chk1PersistThrows += 1;
      events.push('saveFail:chk_1');
      throw new Error('transient persist error');
    }
    const saved = await realSave(record);
    events.push(`save:${record.chunkId}:${saved ? 'ok' : 'null'}`);
    return saved;
  };

  const bClaims = new Set();
  const workerBPoll = async () => {
    for (const c of chunks) {
      if (bClaims.has(c.id)) continue;
      const got = await store.claimChunkForAbstraction('job_1', c.id, { workerId: 'wkr_B', leaseMs: 90_000 });
      if (got) bClaims.add(c.id);
    }
  };

  let tier1Calls = 0;
  const sonnetCalls = [];
  const results = await quietWarnings(() => processMultiChunkAbstraction(chunks, {
    store,
    workerId: 'wkr_A',
    leaseMs: 150,
    blobLoader: async () => ({ bytes: pdf, mediaType: 'application/pdf' }),
    modelClient: async req => {
      if (req.escalation) {
        const id = currentEscChunk(req, chunks);
        sonnetCalls.push(id);
        events.push(`sonnet:${id}`);
        clock.t += 45_000;
        await workerBPoll();
        return { text: cleanBatchAbstract('Sonnet Owner', 'Sonnet verified.'), model: 'claude-sonnet-5-5', usage: {} };
      }
      tier1Calls += 1;
      if (tier1Calls === 1) {
        events.push('tier1');
        clock.t += 200;
        await workerBPoll();
        // chk_0 and chk_3 fail parse (fallbackChunks); chk_1 escalates then fails persist once (noEscalateFallbackChunks); chk_2 persists.
        return {
          text: JSON.stringify([
            { docIndex: 1, abstract: '' },
            { docIndex: 2, abstract: cleanBatchAbstract('Owner 1').replace('RECORDING REF: Vol 1, Page 2', LEASE_FLAG) },
            { docIndex: 3, abstract: cleanBatchAbstract('Owner 2') },
            { docIndex: 4, abstract: '' },
          ]),
          model: 'gemini-3.1-flash-lite',
          usage: {},
        };
      }
      const id = currentEscChunk(req, chunks);
      events.push(`solo:${id}`);
      // Two slow 200s solos total 400s (> 300s callLeaseMs), so chk_1 in the second fallback list would expire without renewal.
      clock.t += 200_000;
      await workerBPoll();
      return { text: cleanBatchAbstract(`Solo ${id}`), model: 'gemini-3.1-flash-lite', usage: {} };
    },
  }));

  assert(chk1PersistThrows === 1, 'Expected chk_1 persist failure to push it into noEscalateFallbackChunks');
  assert(bClaims.size === 0, `Worker B must never reclaim waiting noEscalateFallbackChunks, stole: ${[...bClaims].join(',')}`);
  assertOneResultPerChunk(results, chunks);
  assert(results.every(r => r.status === 'completed'), `Expected all completed, got ${JSON.stringify(results.map(r => [r.chunkId, r.status]))}`);
  assert(sonnetCalls.filter(id => id === 'chk_1').length === 1, `Expected Sonnet billed exactly once for chk_1, got ${JSON.stringify(sonnetCalls)}`);
  const idxSolo0 = events.indexOf('solo:chk_0');
  const idxSolo3 = events.indexOf('solo:chk_3');
  const renewsDuringFirstList = bulkCalls.slice(3, 5).filter(c => c.chunkIds.includes('chk_1'));
  assert(idxSolo0 !== -1 && idxSolo3 > idxSolo0 && renewsDuringFirstList.length === 2, `Expected chk_1 renewed during both fallbackChunks solos, got ${JSON.stringify(bulkCalls)}`);
  assert(store.abstracts.size === 4 && [...store.abstracts.values()].every(a => a.workerId === 'wkr_A'), 'All abstracts saved by wkr_A');
});

test('lease: bulk renewal keeps 24-chunk flagged batch linear (25 DB calls, 0 singular) and prevents steals', async () => {
  const bulkCalls = [];
  const { results, store, events, bClaims, chunks } = await runLeaseBatch({
    count: 24,
    flagged: Array.from({ length: 24 }, (_, i) => i),
    firstLeaseMs: 150,
    sonnetMs: 45_000,
    workerBPolls: true,
    renew: false,
    prepareStore: (st, ev, clock) => attachBulkLeaseRenewal(st, clock, bulkCalls, ev),
  });
  assert(bClaims.size === 0, `Worker B must never steal a chunk, reclaimed: ${[...bClaims].join(',')}`);
  assertOneResultPerChunk(results, chunks);
  assert(results.every(r => r.status === 'completed'), 'Expected all 24 chunks completed');
  assert(bulkCalls.length === 26, `Expected 26 bulk renewals (1 pre-batch + 1 Tier-1 + 24 escalations), got ${bulkCalls.length}`);
  assert(events.filter(e => e.startsWith('sonnet:')).length === 24, 'Expected 24 Sonnet escalations');
  assert(store.abstracts.size === 24, 'All 24 abstracts persisted');
});

test('lease: bulk renewal keeps 48-chunk fallback with escalations linear (97 DB calls, 0 steals)', async () => {
  const bulkCalls = [];
  const { results, store, events, bClaims, chunks } = await quietWarnings(() => runLeaseBatch({
    count: 48,
    firstLeaseMs: 150,
    tier1Throws: true,
    soloFlagged: true,
    soloMs: 45_000,
    sonnetMs: 45_000,
    workerBPolls: true,
    renew: false,
    prepareStore: (st, ev, clock) => attachBulkLeaseRenewal(st, clock, bulkCalls, ev),
  }));
  assert(bClaims.size === 0, `Worker B must never steal a chunk, reclaimed: ${[...bClaims].join(',')}`);
  assertOneResultPerChunk(results, chunks);
  assert(results.every(r => r.status === 'completed'), 'Expected all 48 chunks completed');
  assert(bulkCalls.length === 98, `Expected 98 bulk renewals (1 pre-batch + 1 batch + 48*2 solo/escalation), got ${bulkCalls.length}`);
  assert(events.filter(e => e.startsWith('sonnet:')).length === 48, 'Expected 48 Sonnet escalations');
  assert(store.abstracts.size === 48, 'All 48 abstracts persisted');
});

test('lease: bulk renewal detects a stolen chunk and returns stale without a Sonnet call', async () => {
  const bulkCalls = [];
  const { results, store, events, chunks } = await runLeaseBatch({
    count: 3,
    flagged: [1],
    firstLeaseMs: 90_000,
    renew: false,
    prepareStore: (st, ev, clock) => attachBulkLeaseRenewal(st, clock, bulkCalls, ev),
    onModelCall: ({ phase, store: st, clock }) => {
      if (phase === 'tier1') stealLeaseChunk(st, clock, 'chk_1');
    },
  });
  assertOneResultPerChunk(results, chunks);
  const status = Object.fromEntries(results.map(r => [r.chunkId, r.status]));
  assert(status.chk_1 === 'stale', `Stolen chunk must be stale, got ${status.chk_1}`);
  assert(status.chk_0 === 'completed' && status.chk_2 === 'completed', `Other chunks must complete, got ${JSON.stringify(status)}`);
  assert(!events.includes('sonnet:chk_1'), 'Stolen chunk must not be escalated to Sonnet');
  assert(!store.abstracts.has('chk_1') && store.chunks.get('chk_1').abstractionWorkerId === 'wkr_B', 'wkr_B keeps chk_1');
  assert(bulkCalls.length > 0, 'Expected bulk renewal calls');
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
