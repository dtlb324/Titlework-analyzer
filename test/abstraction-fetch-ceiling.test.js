import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';

const CONFIG_KEYS = [
  'REQUEST_ENVELOPE_SAFE_BYTES', 'ABSTRACTION_SPLITTABLE_PDF_MAX_BYTES', 'STORAGE_MAX_UPLOAD_BYTES', 'GCS_MAX_UPLOAD_BYTES',
  'GEMINI_FILE_API_ENABLED', 'GEMINI_FILE_API_MIN_BYTES', 'GEMINI_FILE_API_MAX_BYTES', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'ABSTRACT_MODEL', 'MODEL_PROVIDER', 'ABSTRACTION_BATCH_ENABLED',
];
for (const key of CONFIG_KEYS) delete process.env[key];
const defaults = await import('../api/_lib/abstraction.js?default-config');

const SMALL = {
  REQUEST_ENVELOPE_SAFE_BYTES: '1200000',
  ABSTRACTION_SPLITTABLE_PDF_MAX_BYTES: '1000000',
  STORAGE_MAX_UPLOAD_BYTES: '3000000',
  GEMINI_FILE_API_MIN_BYTES: '100000',
  GEMINI_FILE_API_MAX_BYTES: '1000000',
};
Object.assign(process.env, SMALL);
const { abstractionReadLimit, defaultBlobLoader, processChunkAbstraction } = await import('../api/_lib/abstraction.js');
const { processAbstractionBatch } = await import('../api/_lib/queue.js');

const INLINE_LIMIT = 595_000;
const WHOLE_PDF_LIMIT = 1_000_000;
const UPLOAD_LIMIT = 3_000_000;

async function withEnv(vars, fn) {
  const previous = Object.fromEntries(Object.keys(vars).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function pdfOf(pageCount, bytesPerPage) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i++) {
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('ScanData'), doc.context.register(doc.context.stream(randomBytes(bytesPerPage))));
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

async function textPdfOf(lines, scanBytesPerPage, pageCount = 1) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pageCount; p++) {
    const page = doc.addPage([612, 792]);
    lines.forEach((line, i) => page.drawText(`Page ${p + 1} ${line}`, { x: 36, y: 760 - i * 14, size: 10, font }));
    page.node.set(PDFName.of('ScanData'), doc.context.register(doc.context.stream(randomBytes(scanBytesPerPage))));
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

function pdfChunk(bytes, pageStart, pageEnd, extra = {}) {
  return {
    id: 'chk_large', jobId: 'job_large', documentId: 'doc_large', chunkOrder: 0,
    originalFilename: 'deed-packet.pdf', mediaType: 'application/pdf', sizeBytes: bytes.byteLength,
    pageStart, pageEnd, fingerprint: 'deed-packet',
    blobKey: 'jobs/job_large/chunks/chk_large/source.pdf',
    blobUrl: 'gs://synthetic-bucket/jobs/job_large/chunks/chk_large/source.pdf',
    uploadStatus: 'uploaded', abstractionStatus: 'pending', abstractionAttempts: 0,
    ...extra,
  };
}

function chunkStore(initial) {
  const chunks = new Map(initial.map(chunk => [chunk.id, { ...chunk }]));
  const job = { id: initial[0].jobId, status: 'abstracting' };
  const saved = [];
  let childCount = 0;
  return {
    chunks, saved,
    async getJob() { return job; },
    async listChunks() { return [...chunks.values()]; },
    async claimChunkForAbstraction(_jobId, id, { workerId }) {
      const chunk = chunks.get(id);
      if (chunk.abstractionStatus !== 'pending' && !(chunk.abstractionStatus === 'processing' && chunk.abstractionWorkerId === workerId)) return null;
      if (chunk.abstractionStatus === 'pending') chunk.abstractionAttempts += 1;
      chunk.abstractionStatus = 'processing';
      chunk.abstractionWorkerId = workerId;
      return { ...chunk };
    },
    async getDocumentAbstractByChunkId() { return null; },
    async markChunkAbstractionFailed(_jobId, id, failure) {
      const chunk = chunks.get(id);
      chunk.abstractionStatus = 'failed';
      chunk.failure = failure;
      return chunk;
    },
    async markChunkAbstractionRetryWait(_jobId, id, failure) {
      const chunk = chunks.get(id);
      chunk.abstractionStatus = 'retry_wait';
      chunk.failure = failure;
      return chunk;
    },
    async createSplitChunk(jobId, documentId, input) {
      childCount += 1;
      const row = { ...input, id: `chk_child_${childCount}`, jobId, documentId, uploadStatus: 'uploaded', abstractionStatus: 'pending', abstractionAttempts: 0 };
      chunks.set(row.id, row);
      return row;
    },
    async markChunkAbstractionSplitSuperseded(_jobId, id) {
      chunks.get(id).abstractionStatus = 'split_superseded';
      return chunks.get(id);
    },
    async discardSplitChunk(_jobId, id) {
      const row = chunks.get(id);
      chunks.delete(id);
      return row;
    },
    async saveDocumentAbstract(record) {
      chunks.get(record.chunkId).abstractionStatus = 'completed';
      saved.push(record);
      return record;
    },
    async getAbstractionStatus() {
      const rows = [...chunks.values()];
      const count = status => rows.filter(row => row.abstractionStatus === status).length;
      return { job, total: rows.length, pending: count('pending'), processing: count('processing'), failed: count('failed'), completed: count('completed'), retry_wait: count('retry_wait') };
    },
  };
}

function objectStorage(initial) {
  const objects = new Map(initial);
  let reads = 0;
  return {
    objects,
    get reads() { return reads; },
    objectReader: async chunk => {
      reads += 1;
      const bytes = objects.get(chunk.blobUrl);
      if (!bytes) throw new Error(`fixture object missing: ${chunk.blobUrl}`);
      return { bytes, mediaType: chunk.mediaType };
    },
    blobWriter: async (parent, name, bytes) => {
      const blobUrl = `gs://synthetic-bucket/jobs/${parent.jobId}/split/${encodeURIComponent(name)}`;
      objects.set(blobUrl, bytes);
      return { blobKey: `jobs/${parent.jobId}/split/${name}`, blobUrl };
    },
  };
}

const ABSTRACT_TEXT = [
  'DOC TYPE: Warranty Deed',
  'DATE EXECUTED: January 1, 2020',
  'DATE RECORDED: January 2, 2020',
  'RECORDING REF: Vol 1, Page 2',
  'GRANTOR: John Smith',
  'GRANTEE: Mary Jones',
  'LEGAL DESC: Section 1, Block C-9',
  'MINERALS: yes',
  'FRACTION CONVEYED: 100% mineral interest',
  'ISSUES: none noted',
  'CONFIDENCE: High, all fields clearly legible.',
].join('\n');

function recordingModel() {
  const requests = [];
  return {
    requests,
    client: async request => {
      requests.push(request);
      return { text: ABSTRACT_TEXT, model: request.model, usage: { input_tokens: 1, output_tokens: 1 }, stopReason: 'end_turn' };
    },
  };
}

async function withGeminiFilesStub(fn, { uploadStatus = 200 } = {}) {
  const previousFetch = globalThis.fetch;
  const uploads = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (init.method === 'POST' && target.includes('/upload/v1beta/files')) {
      uploads.push(target);
      if (uploadStatus !== 200) return new Response(JSON.stringify({ error: { message: 'synthetic outage' } }), { status: uploadStatus });
      return new Response(JSON.stringify({ file: { uri: 'https://generativelanguage.googleapis.com/v1beta/files/scan123', name: 'files/scan123', mimeType: 'application/pdf' } }), { status: 200 });
    }
    if (target.endsWith('/files/scan123')) return new Response(JSON.stringify({ state: 'ACTIVE' }), { status: 200 });
    throw new Error(`unexpected fetch ${target}`);
  };
  try {
    return await withEnv({ GEMINI_API_KEY: 'synthetic-key', GEMINI_FILE_API_ENABLED: undefined }, () => fn(uploads));
  } finally {
    globalThis.fetch = previousFetch;
  }
}

const DEFAULT_LIMITS = { STORAGE_MAX_UPLOAD_BYTES: undefined, GEMINI_FILE_API_MIN_BYTES: undefined, GEMINI_FILE_API_MAX_BYTES: undefined };

test('default fetch ceilings match what each delivery route can carry', () => withEnv(DEFAULT_LIMITS, async () => {
  const multiPage = { mediaType: 'application/pdf', pageStart: 1, pageEnd: 40, sizeBytes: 0 };
  const noRange = { mediaType: 'application/pdf', sizeBytes: 0 };
  const singlePage = { mediaType: 'application/pdf', pageStart: 1, pageEnd: 1, sizeBytes: 0 };
  const image = { mediaType: 'image/jpeg', originalFilename: 'plat.jpg', sizeBytes: 0 };
  const csv = { mediaType: 'text/csv', originalFilename: 'runsheet.csv', sizeBytes: 0 };
  assert.equal(defaults.abstractionReadLimit(multiPage), 100 * 1024 * 1024, 'multi-page PDFs up to the upload limit are fetched so they can be split');
  assert.equal(defaults.abstractionReadLimit(noRange), 100 * 1024 * 1024);
  assert.equal(defaults.abstractionReadLimit(singlePage), 48_000_000, 'single pages up to the Files API maximum are fetched');
  assert.equal(defaults.abstractionReadLimit(image), 48_000_000);
  assert.equal(defaults.abstractionReadLimit(csv), 17_650_000, 'CSV admission is unchanged');
  await withEnv({ GEMINI_FILE_API_ENABLED: 'false' }, () => {
    assert.equal(defaults.abstractionReadLimit(singlePage), 12_355_000, 'without the Files API a single page must fit inline');
    assert.equal(defaults.abstractionReadLimit(image), 12_355_000);
  });
  await withEnv({ MODEL_PROVIDER: 'openrouter' }, () => {
    assert.equal(defaults.abstractionReadLimit(singlePage), 12_355_000, 'OpenRouter abstraction never uses the Files API');
  });
}));

test('a multi-page fetch ceiling never exceeds one queue wave, whatever the upload limit', async () => {
  await withEnv({ ...DEFAULT_LIMITS, STORAGE_MAX_UPLOAD_BYTES: String(1024 * 1024 * 1024) }, () => {
    assert.equal(defaults.abstractionReadLimit({ mediaType: 'application/pdf', pageStart: 1, pageEnd: 2, sizeBytes: 0 }), defaults.ABSTRACTION_WAVE_RAW_BYTES);
  });
});

test('a multi-page PDF too large to send inline is read once and split by page range before any model call', async () => {
  const bytes = await pdfOf(4, 450_000);
  assert(bytes.byteLength > WHOLE_PDF_LIMIT && bytes.byteLength < UPLOAD_LIMIT, `fixture size ${bytes.byteLength}`);
  const chunk = pdfChunk(bytes, 1, 4);
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  assert.equal(abstractionReadLimit(chunk), bytes.byteLength);
  const result = await processChunkAbstraction(chunk, {
    store, workerId: 'wkr_fixture', maxAttempts: 1,
    blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
    blobWriter: storage.blobWriter,
    modelClient: model.client,
  });
  assert.equal(result.status, 'split_superseded', JSON.stringify(result));
  assert.equal(storage.reads, 1);
  assert.equal(model.requests.length, 0, 'the oversized whole document is never sent to a model');
  const children = [...store.chunks.values()].filter(row => row.splitParentChunkId === chunk.id);
  assert.deepEqual(children.map(row => [row.pageStart, row.pageEnd]), [[1, 2], [2, 4]]);
  assert(children.every(row => row.splitReason === 'payload_too_large'));
});

test('a multi-page PDF declared over the upload limit is still refused before any read', async () => {
  const chunk = pdfChunk(Buffer.alloc(0), 1, 40, { sizeBytes: UPLOAD_LIMIT + 1 });
  const store = chunkStore([chunk]);
  const storage = objectStorage([]);
  const model = recordingModel();
  const result = await processChunkAbstraction(chunk, {
    store, workerId: 'wkr_fixture', maxAttempts: 1,
    blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
    modelClient: model.client,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.errorType, 'payload_too_large');
  assert.equal(storage.reads, 0);
  assert.equal(model.requests.length, 0);
});

test('the queue abstracts every page range of an oversized multi-page PDF', async () => {
  const bytes = await pdfOf(4, 300_000);
  assert(bytes.byteLength > WHOLE_PDF_LIMIT, `fixture size ${bytes.byteLength}`);
  const chunk = pdfChunk(bytes, 1, 4);
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  await withEnv({ GEMINI_FILE_API_ENABLED: 'false', ABSTRACTION_BATCH_ENABLED: 'false' }, () => processAbstractionBatch(chunk.jobId, {
    store, budgetMs: 10_000, maxAttempts: 1,
    objectReader: storage.objectReader, blobWriter: storage.blobWriter, modelClient: model.client,
  }));
  const rows = [...store.chunks.values()];
  assert.equal(store.chunks.get(chunk.id).abstractionStatus, 'split_superseded', JSON.stringify(rows.map(row => [row.id, row.abstractionStatus, row.failure?.errorMessage])));
  assert.deepEqual(store.saved.map(record => record.chunkId).sort(), ['chk_child_1', 'chk_child_3', 'chk_child_4']);
  assert.deepEqual(
    rows.filter(row => row.splitParentChunkId && row.abstractionStatus !== 'split_superseded').map(row => [row.pageStart, row.pageEnd, row.abstractionStatus]),
    [[1, 2, 'completed'], [2, 3, 'completed'], [4, 4, 'completed']],
  );
  assert.equal(model.requests.length, 3);
});

test('a single page over the inline limit is delivered through the Gemini Files API', async () => {
  const bytes = await pdfOf(1, 800_000);
  assert(bytes.byteLength > INLINE_LIMIT && bytes.byteLength < 1_000_000, `fixture size ${bytes.byteLength}`);
  const chunk = pdfChunk(bytes, 1, 1);
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  await withGeminiFilesStub(async uploads => {
    const result = await processChunkAbstraction(chunk, {
      store, workerId: 'wkr_fixture', maxAttempts: 1,
      blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
      modelClient: model.client,
    });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(uploads.length, 1);
  });
  assert.equal(storage.reads, 1);
  assert.equal(model.requests.length, 1);
  assert(JSON.stringify(model.requests[0].messages).includes('files/scan123'), 'the model receives the uploaded file reference');
});

test('a single page over the inline limit is refused before any read when the Files API is off', async () => {
  const chunk = pdfChunk(Buffer.alloc(0), 1, 1, { sizeBytes: 800_000 });
  const store = chunkStore([chunk]);
  const storage = objectStorage([]);
  const model = recordingModel();
  const result = await withEnv({ GEMINI_FILE_API_ENABLED: 'false' }, () => processChunkAbstraction(chunk, {
    store, workerId: 'wkr_fixture', maxAttempts: 1,
    blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
    modelClient: model.client,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.errorType, 'payload_too_large');
  assert.equal(storage.reads, 0);
  assert.equal(model.requests.length, 0);
});

test('a single page too large to send inline fails without building the request when the Files API upload fails', async () => {
  const bytes = await pdfOf(1, 940_000);
  assert(Math.ceil(bytes.byteLength / 3) * 4 > 1_200_000 && bytes.byteLength < 1_000_000, `fixture size ${bytes.byteLength}`);
  const chunk = pdfChunk(bytes, 1, 1);
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  const previousWarn = console.warn;
  console.warn = () => {};
  try {
    await withGeminiFilesStub(async uploads => {
      const result = await processChunkAbstraction(chunk, {
        store, workerId: 'wkr_fixture', maxAttempts: 1,
        blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
        modelClient: model.client,
      });
      assert.equal(uploads.length, 1);
      assert.equal(result.status, 'failed');
      assert.equal(result.failure.errorType, 'payload_too_large');
      assert.match(result.failure.errorMessage, /too large to send inline/);
    }, { uploadStatus: 503 });
  } finally {
    console.warn = previousWarn;
  }
  assert.equal(model.requests.length, 0);
});

test('a multi-page PDF that fits one inline request is still abstracted whole', async () => {
  const bytes = await pdfOf(2, 300_000);
  assert(bytes.byteLength > INLINE_LIMIT && bytes.byteLength < WHOLE_PDF_LIMIT, `fixture size ${bytes.byteLength}`);
  const chunk = pdfChunk(bytes, 1, 2);
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  const result = await withEnv({ GEMINI_FILE_API_ENABLED: 'false' }, () => processChunkAbstraction(chunk, {
    store, workerId: 'wkr_fixture', maxAttempts: 1,
    blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
    blobWriter: storage.blobWriter,
    modelClient: model.client,
  }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(model.requests.length, 1);
  assert.equal([...store.chunks.values()].filter(row => row.splitParentChunkId).length, 0);
});

test('a single page with a text layer over the inline limit is abstracted from its text', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}: Grantor John Smith conveys to Grantee Mary Jones on January 1, 2020, recorded January 2, 2020 in Vol 1 Page 2, all of Section ${i + 1}, Block C-9.`);
  const bytes = await textPdfOf(lines, 700_000);
  assert(bytes.byteLength > INLINE_LIMIT && bytes.byteLength < 1_000_000, `fixture size ${bytes.byteLength}`);
  const chunk = pdfChunk(bytes, 1, 1);
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  await withGeminiFilesStub(async uploads => {
    const result = await processChunkAbstraction(chunk, {
      store, workerId: 'wkr_fixture', maxAttempts: 1,
      blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
      modelClient: model.client,
    });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(uploads.length, 0, 'text delivery needs no file upload');
  });
  assert.equal(model.requests.length, 1);
  assert.match(JSON.stringify(model.requests[0].messages), /EXTRACTED PDF TEXT[\s\S]*Mary Jones/);
});

test('a multi-page PDF with a text layer over the whole-document floor is abstracted from its text in one call', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}: Grantor John Smith conveys to Grantee Mary Jones on January 1, 2020, recorded January 2, 2020 in Vol 1 Page 2, all of Section ${i + 1}, Block C-9.`);
  const bytes = await textPdfOf(lines, 600_000, 2);
  assert(bytes.byteLength > WHOLE_PDF_LIMIT && bytes.byteLength < UPLOAD_LIMIT, `fixture size ${bytes.byteLength}`);
  const chunk = pdfChunk(bytes, 1, 2);
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  const result = await withEnv({ GEMINI_FILE_API_ENABLED: 'false' }, () => processChunkAbstraction(chunk, {
    store, workerId: 'wkr_fixture', maxAttempts: 1,
    blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
    blobWriter: storage.blobWriter,
    modelClient: model.client,
  }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(model.requests.length, 1);
  assert.match(JSON.stringify(model.requests[0].messages), /EXTRACTED PDF TEXT[\s\S]*Page 2 line 50/);
});

async function hybridPdfOf({ denseJunk, sparseJunk }) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const dense = doc.addPage([612, 792]);
  for (let i = 0; i < 20; i++) dense.drawText(`Line ${i + 1}: Grantor John Smith conveys to Grantee Mary Jones all of Section ${i + 1}.`, { x: 36, y: 760 - i * 14, size: 10, font });
  dense.node.set(PDFName.of('ScanData'), doc.context.register(doc.context.stream(randomBytes(denseJunk))));
  const sparse = doc.addPage([612, 792]);
  sparse.node.set(PDFName.of('ScanData'), doc.context.register(doc.context.stream(randomBytes(sparseJunk))));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('a hybrid PDF sends only its sparse pages inline, however large the text pages are', async () => {
  const bytes = await hybridPdfOf({ denseJunk: 950_000, sparseJunk: 10_000 });
  assert(Math.ceil(bytes.byteLength / 3) * 4 > 1_200_000, `fixture size ${bytes.byteLength}`);
  const chunk = pdfChunk(bytes, 1, 2);
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  const result = await withEnv({ GEMINI_FILE_API_ENABLED: 'false' }, () => processChunkAbstraction(chunk, {
    store, workerId: 'wkr_fixture', maxAttempts: 1,
    blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
    blobWriter: storage.blobWriter,
    modelClient: model.client,
  }));
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(model.requests.length, 1);
  assert.match(JSON.stringify(model.requests[0].messages), /HYBRID PDF/);
});

test('a hybrid PDF whose sparse pages went through the Files API is not held to the inline limit', async () => {
  const bytes = await hybridPdfOf({ denseJunk: 10_000, sparseJunk: 950_000 });
  const chunk = pdfChunk(bytes, 1, 2);
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  await withGeminiFilesStub(async uploads => {
    const result = await processChunkAbstraction(chunk, {
      store, workerId: 'wkr_fixture', maxAttempts: 1,
      blobLoader: value => defaultBlobLoader(value, { objectReader: storage.objectReader }),
      blobWriter: storage.blobWriter,
      modelClient: model.client,
    });
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(uploads.length, 1);
  });
  assert.equal(model.requests.length, 1);
  assert.match(JSON.stringify(model.requests[0].messages), /HYBRID PDF[\s\S]*files\/scan123|files\/scan123[\s\S]*HYBRID PDF/);
});

test('a large CSV is still sent as text at the default limits', () => withEnv(DEFAULT_LIMITS, async () => {
  const row = 'Owner,Interest,Tract\nJohn Smith,0.125,Section 22 Block C-9\n';
  const bytes = Buffer.from(row.repeat(Math.ceil(14_000_000 / row.length)));
  const chunk = { ...pdfChunk(bytes, null, null), originalFilename: 'runsheet.csv', mediaType: 'text/csv', blobUrl: 'gs://synthetic-bucket/jobs/job_large/chunks/chk_large/source.csv' };
  const store = chunkStore([chunk]);
  const storage = objectStorage([[chunk.blobUrl, bytes]]);
  const model = recordingModel();
  const result = await defaults.processChunkAbstraction(chunk, {
    store, workerId: 'wkr_fixture', maxAttempts: 1,
    blobLoader: value => defaults.defaultBlobLoader(value, { objectReader: storage.objectReader }),
    modelClient: model.client,
  });
  assert.equal(result.status, 'completed', JSON.stringify(result.failure));
  assert.equal(model.requests.length, 1);
}));
