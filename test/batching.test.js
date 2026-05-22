function estimateFilePayload(file) {
  if (file.csvText) return file.csvText.length + 500;
  if (typeof file.data === 'string' && file.data.length) return file.data.length;
  return Math.ceil((file.size || 0) * 1.37);
}

function buildAdaptiveBatches(fileList) {
  const MAX_PAYLOAD_BYTES = 4_100_000;
  const MAX_DOCS_PER_BATCH = 2;
  const LARGE_FILE_BYTES = 1_000_000;
  const TIMEOUT_SAFE_FILE_BYTES = 500_000;
  const batches = [];
  let current = [];
  let currentPayload = 0;
  let globalStart = 0;

  for (const file of fileList) {
    const filePayload = estimateFilePayload(file);
    const oversized = filePayload > LARGE_FILE_BYTES;

    if (oversized && !current.length) {
      batches.push({ files: [file], globalStart });
      globalStart += 1;
      continue;
    }

    if (current.length && (current.length >= MAX_DOCS_PER_BATCH || currentPayload + filePayload > MAX_PAYLOAD_BYTES)) {
      batches.push({ files: [...current], globalStart });
      globalStart += current.length;
      current = [];
      currentPayload = 0;
    }

    if (oversized) {
      batches.push({ files: [file], globalStart });
      globalStart += 1;
      continue;
    }

    current.push(file);
    currentPayload += filePayload;
  }

  if (current.length) batches.push({ files: [...current], globalStart });
  return batches;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const small = (n, size = 100000) => ({ name: `doc-${n}.pdf`, size, data: 'x'.repeat(size) });

const smallBatch = buildAdaptiveBatches(Array.from({ length: 10 }, (_, i) => small(i)));
assert(smallBatch.length === 5, `10 small docs should pack into 5 batches (max 2 docs each), got ${smallBatch.length}`);
assert(smallBatch[0].files.length === 2, 'First batch should pack up to 2 small docs');

const large = buildAdaptiveBatches([{ name: 'big.pdf', size: 3_000_000, data: 'x'.repeat(3_000_000) }]);
assert(large.length === 1 && large[0].files.length === 1, 'Large file should batch alone');

const mixed = buildAdaptiveBatches([
  ...Array.from({ length: 6 }, (_, i) => small(i, 50000)),
  { name: 'huge.pdf', size: 3_000_000, data: 'x'.repeat(3_000_000) },
]);
assert(mixed.some(b => b.files.length === 1 && b.files[0].name === 'huge.pdf'), 'Oversized file gets its own batch');


function estimateBatchTimeMs(batch) {
  const files = batch.files || batch;
  let payload = 0;
  for (const f of files) payload += estimateFilePayload(f);
  const docs = files.length;
  const payloadMs = Math.min(payload / 80, 45_000);
  return 8000 + docs * 6000 + payloadMs;
}

function batchExceedsTimeoutLimit(files) {
  return files.length > 0 && estimateBatchTimeMs({ files }) > 55_000;
}

function splitFilesForTimeout(files) {
  if (!files.length) return [];
  if (files.length === 1 || !batchExceedsTimeoutLimit(files)) return [files];
  const mid = Math.ceil(files.length / 2);
  return [...splitFilesForTimeout(files.slice(0, mid)), ...splitFilesForTimeout(files.slice(mid))];
}

const heavy = (n, size = 2000000) => ({ name: `heavy-${n}.pdf`, size, data: 'x'.repeat(size) });
const heavyPair = splitFilesForTimeout([heavy(1), heavy(2)]);
assert(heavyPair.length >= 2, 'Heavy pair should split proactively for timeout');

console.log('✓ batching tests passed');
