import {
  chunkRequiresSoloBatch,
  estimateChunkPayloadBytes,
  isAbstractionBatchingEnabled,
  planAbstractionWork,
} from '../api/_lib/abstraction-batch.js';
import {
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

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
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
