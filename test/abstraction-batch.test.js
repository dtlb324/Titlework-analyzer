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
