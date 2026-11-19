import {
  chunkRequiresSoloBatch,
  estimateChunkPayloadBytes,
  isAbstractionBatchingEnabled,
  planAbstractionWork,
  processMultiChunkAbstraction,
} from '../api/_lib/abstraction-batch.js';
import {
  buildAbstractMessagesForChunks,
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
    ...overrides,
  };
}

test('planAbstractionWork groups small chunks up to 24 per batch', () => {
  const chunks = Array.from({ length: 26 }, (_, i) => makeChunk(`chk_${i}`, 60_000));
  const { batches, singles } = planAbstractionWork(chunks);
  assert(batches.length === 2, `Expected 2 batches, got ${batches.length}`);
  assert(batches[0].chunks.length === 24, 'First batch should have 24 docs');
  assert(batches[1].chunks.length === 2, 'Second batch should have 2 docs');
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

test('chunkRequiresSoloBatch respects page span and CSV payload', () => {
  const small = makeChunk('s', 100_000);
  const wide = makeChunk('w', 500_000, { pageStart: 1, pageEnd: 40 });
  const csv = makeChunk('c', 3_000_000, { mediaType: 'text/csv', originalFilename: 'c.csv' });
  assert(chunkRequiresSoloBatch(small) === false, 'Small chunk should batch');
  assert(chunkRequiresSoloBatch(wide) === true, 'Wide page span should stay solo');
  assert(chunkRequiresSoloBatch(csv) === true, 'Large CSV should stay solo');
});

test('parseBatchAbstracts splits multi-doc model output', () => {
  const items = [
    { chunk: makeChunk('a') },
    { chunk: makeChunk('b') },
  ];
  const text = '["DOC TYPE: Deed\\nGRANTOR: A","DOC TYPE: Lease\\nGRANTOR: B"]';
  const parsed = parseBatchAbstracts(text, items, 0);
  assert(parsed.length === 2, 'Expected two parsed abstracts');
  assert(parsed[0].abstractText.includes('DOC TYPE: Deed'), 'Expected first abstract body');
  assert(parsed[1].abstractText.includes('DOC TYPE: Lease'), 'Expected second abstract body');
});

test('parseBatchAbstracts assigns nothing when the array length does not match the batch', () => {
  const items = [{ chunk: makeChunk('a') }, { chunk: makeChunk('b') }, { chunk: makeChunk('c') }];
  for (const text of ['["DOC TYPE: Lease","DOC TYPE: Assignment"]', '["A","B","C","D"]']) {
    const parsed = parseBatchAbstracts(text, items, 0);
    assert(parsed.length === 3, 'Expected one entry per batch item');
    assert(parsed.every(item => item.abstractText === ''), `A ${JSON.parse(text).length}-element answer for 3 files must not be mapped by position`);
  }
});

test('buildAbstractMessagesForChunks packs multiple text-first PDFs in one text block', () => {
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
  const prompt = blocks.find(block => block.type === 'text')?.text || '';
  assert(prompt.includes('GRANTOR: One') && prompt.includes('GRANTOR: Two'), 'Expected both extracted bodies in prompt');
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

function createMemoryBatchStore(chunksInput, { enforceWorkerLease = true } = {}) {
  const chunks = new Map(chunksInput.map(c => [c.id, { ...c }]));
  const abstracts = new Map();
  return {
    chunks,
    abstracts,
    async getChunk(_jobId, id) {
      return chunks.get(id) || null;
    },
    async claimChunkForAbstraction(_jobId, id, opts = {}) {
      const c = chunks.get(id);
      if (!c) return null;
      const sameWorker = c.abstractionStatus === 'processing' && c.abstractionWorkerId === opts.workerId;
      if (c.abstractionStatus !== 'pending' && !sameWorker) return null;
      const updated = applyAbstractionClaim(c, opts);
      chunks.set(id, updated);
      return updated;
    },
    async getDocumentAbstractByChunkId() { return null; },
    async saveDocumentAbstract(record) {
      const c = chunks.get(record.chunkId);
      if (enforceWorkerLease && (!c || c.abstractionStatus !== 'processing' || (c.abstractionWorkerId && c.abstractionWorkerId !== record.workerId))) {
        return null;
      }
      abstracts.set(record.chunkId, { ...record });
      chunks.set(record.chunkId, { ...c, abstractionStatus: 'completed', abstractionWorkerId: null });
      return record;
    },
    async markChunkAbstractionFailed(_jobId, id, failure) {
      const c = chunks.get(id);
      chunks.set(id, { ...c, abstractionStatus: 'failed', abstractionErrorType: failure.errorType });
      return chunks.get(id);
    },
    async markChunkAbstractionRetryWait(_jobId, id, failure) {
      const c = chunks.get(id);
      chunks.set(id, { ...c, abstractionStatus: 'retry_wait', abstractionErrorType: failure.errorType });
      return chunks.get(id);
    },
  };
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
            cleanBatchAbstract('Alice One'),
            cleanBatchAbstract('Bob Two').replace('RECORDING REF: Vol 1, Page 2', 'RECORDING REF: ILLEGIBLE - VERIFY MANUALLY'),
            cleanBatchAbstract('Carol Three'),
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
            if (!req.escalation) {
              return {
                text: JSON.stringify([
                  cleanBatchAbstract('Scan Owner').replace('CONFIDENCE: Clear batch abstract.', 'CONFIDENCE: low'),
                  cleanBatchAbstract('Clean Owner'),
                ]),
                model: 'gemini-3.1-flash-lite',
                usage: {},
              };
            }
            return { text: cleanBatchAbstract('Scan Owner', 'Verified via base64.'), model: targetModel, usage: {} };
          },
        });
        assert(calls.length === 2);
        assert(calls[0].messages[0].content.some(b => b.type === 'document' && b.source.type === 'file_uri'), 'Batch call should use file_uri for scanned PDF');
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
          cleanBatchAbstract('Alice One'),
          cleanBatchAbstract('Bob Two').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY'),
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
          cleanBatchAbstract('Alice One'),
          cleanBatchAbstract('Bob Two').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY'),
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
              cleanBatchAbstract('Alice One').replace('GRANTOR: Alice One', 'GRANTOR: ILLEGIBLE - VERIFY MANUALLY'),
              cleanBatchAbstract('Bob Two').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY'),
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
            cleanBatchAbstract('Alice One'),
            cleanBatchAbstract('Bob Two').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY'),
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
          cleanBatchAbstract('Alice One').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY'),
          cleanBatchAbstract('Bob Two'),
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
            cleanBatchAbstract('Alice One').replace('GRANTEE: Mary Jones', 'GRANTEE: ILLEGIBLE - VERIFY MANUALLY'),
            cleanBatchAbstract('Bob Two'),
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
function leaseTier1(count, flaggedIdx) {
  return JSON.stringify(Array.from({ length: count }, (_, i) => {
    const text = cleanBatchAbstract(`Owner ${i}`);
    return flaggedIdx.has(i) ? text.replace('RECORDING REF: Vol 1, Page 2', LEASE_FLAG) : text;
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
        return { text: leaseTier1(count, flaggedIdx), model: 'gemini-3.1-flash-lite', usage: {} };
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
  // Escalation requests carry the flagged chunk's PDF via the document label "DOCUMENT #n"; recover n from the prompt text.
  const text = JSON.stringify(req.messages);
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

function stealChunk(store, clock, id, leaseMs = 3_600_000) {
  store.chunks.set(id, { ...store.chunks.get(id), abstractionWorkerId: 'wkr_B', abstractionLeaseExpiresAt: clock.t + leaseMs });
}

// Records every claim, renewal, save and paid model call of one processMultiChunkAbstraction run in `events`.
async function runLeaseBatch({
  count = 3, flagged = [], renew = true, firstLeaseMs = 150, tier1Throws = false, tier1Ms = 200, soloMs = 0, sonnetMs = 0,
  storeOpts = {}, prepareStore = null, onLoad = null, onModelCall = null, workerBPolls = false,
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
  prepareStore?.(store, events);
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
        return { text: leaseTier1(count, flaggedIdx), model: 'gemini-3.1-flash-lite', usage: {} };
      }
      const id = currentEscChunk(req, chunks);
      assert(id, 'Solo request must carry its DOCUMENT #n label');
      events.push(`solo:${id}`);
      await onModelCall?.({ phase: 'solo', id, store, clock });
      clock.t += soloMs;
      await workerBPoll();
      return { text: cleanBatchAbstract(`Solo ${id}`), model: 'gemini-3.1-flash-lite', usage: {} };
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
    onLoad: ({ chunk, store: st, clock }) => stealChunk(st, clock, chunk.id),
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
      if (chunk.id === 'chk_1' || chunk.id === 'chk_3') stealChunk(st, clock, chunk.id);
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
  // Every paid call renews the chunks still held: tier1 renews all four, chk_1's Sonnet call renews 1-3, chk_3's renews 3.
  const counts = Object.fromEntries(['chk_0', 'chk_1', 'chk_2', 'chk_3'].map(id => [id, countEvents(events, `renew:${id}`)]));
  assert(JSON.stringify(counts) === JSON.stringify({ chk_0: 1, chk_1: 2, chk_2: 2, chk_3: 3 }), `Unexpected renewal counts ${JSON.stringify(counts)}`);
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
      if (phase === 'solo' && id === 'chk_0') stealChunk(st, clock, 'chk_2');
    },
  }));
  assertOneResultPerChunk(results, chunks);
  const status = Object.fromEntries(results.map(r => [r.chunkId, r.status]));
  assert(status.chk_0 === 'completed' && status.chk_1 === 'completed', `Earlier solos must still complete, got ${JSON.stringify(status)}`);
  assert(status.chk_2 === 'skipped', `The stolen chunk must be skipped, got ${status.chk_2}`);
  assert(!events.includes('solo:chk_2') && !events.includes('sonnet:chk_2'), 'No paid call may be made for the stolen chunk');
  assert(!store.abstracts.has('chk_2') && store.chunks.get('chk_2').abstractionWorkerId === 'wkr_B', 'B keeps the stolen chunk and nothing is persisted for it');
  assert(events.indexOf('renew:chk_2') !== -1 && events.indexOf('renew:chk_2') < events.indexOf('solo:chk_1'), 'The pending chunk was still renewed before the next solo');
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
