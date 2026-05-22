function estimateFilePayload(file) {
  if (file.csvText) return file.csvText.length + 500;
  if (file.data) return Math.ceil(file.data.length * 0.75);
  return file.size || 0;
}

function buildAdaptiveBatches(fileList) {
  const MAX_PAYLOAD_BYTES = 3_000_000;
  const MAX_DOCS_PER_BATCH = 8;
  const LARGE_FILE_BYTES = 2_000_000;
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
assert(smallBatch.length <= 2, `10 small docs should pack into <=2 batches, got ${smallBatch.length}`);
assert(smallBatch[0].files.length >= 8, 'First batch should pack up to 8 small docs');

const large = buildAdaptiveBatches([{ name: 'big.pdf', size: 3_000_000, data: 'x'.repeat(3_000_000) }]);
assert(large.length === 1 && large[0].files.length === 1, 'Large file should batch alone');

const mixed = buildAdaptiveBatches([
  ...Array.from({ length: 6 }, (_, i) => small(i, 50000)),
  { name: 'huge.pdf', size: 3_000_000, data: 'x'.repeat(3_000_000) },
]);
assert(mixed.some(b => b.files.length === 1 && b.files[0].name === 'huge.pdf'), 'Oversized file gets its own batch');

console.log('✓ batching tests passed');
