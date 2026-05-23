# PDF Document Grouping at Synthesis Time - Design Specification

**Status:** Ready for implementation
**Date:** 2026-05-23
**Related code:** [api/_lib/jobs.js](../../../api/_lib/jobs.js), [api/_lib/synthesis.js](../../../api/_lib/synthesis.js)
**Related phase docs:** [phase-5-durable-server-side-synthesis.md](../../phase-5-durable-server-side-synthesis.md)

---

## 1. Goal

Present each original source PDF to synthesis as one logical document, even when the PDF was split into multiple abstraction chunks.

The abstraction pipeline remains chunk-based. This change only groups completed chunk abstracts at synthesis-planning time.

### Goals

- Present each source PDF as one `Document N` entry in synthesis prompts.
- Preserve all chunk-level abstract content without re-abstracting or summarizing it.
- Preserve page-range provenance inside grouped abstracts.
- Store source document IDs in `synthesis_segments.document_ids`.
- Keep plan IDs stable for identical source documents and grouped abstract content.

### Non-goals

- No new database tables or migrations.
- No persisted merged-abstract artifact.
- No new worker, job phase, or state-machine transition.
- No extra LLM call to semantically merge chunk abstracts.
- No UI changes.

---

## 2. Current Problem

The current pipeline splits oversized PDFs into page-range child chunks via [`splitPdfChunk()`](../../../api/_lib/abstraction.js). Each chunk is abstracted independently and persisted as one row in `document_abstracts`.

Synthesis planning currently treats those chunk abstracts as separate documents. In [`buildAbstractInput()`](../../../api/_lib/synthesis.js), every abstract becomes its own heading:

```js
input += `### Document ${i + 1}: ${d.filename}\n\n${d.abstract}\n\n---\n\n`;
```

For a job with 380 source PDFs where 20 PDFs split into two chunks each, the synthesizer can see 400+ `Document N` entries. Split PDFs appear as duplicate filenames across separate document headings, so the model has to infer that repeated filenames are really page ranges from the same source PDF.

The schema already has the identity needed to fix this:

- `job_documents.id` is the canonical source-document ID.
- `document_chunks.document_id` points to the source document.
- Split children share the same `document_id`.
- `synthesis_segments.document_ids` is already a JSON array and should contain source document IDs after this change.

---

## 3. Proposed Design

Add a deterministic in-memory adapter between abstract loading and synthesis planning:

```text
listDocumentAbstracts(jobId)
  -> normalize chunk abstracts
  -> groupAbstractsByDocument()
  -> planSynthesisSegments()
  -> processSynthesisSegment()
  -> mergeSegmentsIntoOpinion()
```

For a single-chunk source document, the grouped abstract text is exactly the original chunk abstract.

For a multi-chunk source document, the grouped abstract is the deterministic concatenation of its chunk abstracts in chunk order. Each chunk section is prefixed with page provenance:

```markdown
**Pages 1-12:**

<chunk abstract>

**Pages 13-24:**

<chunk abstract>
```

If page ranges are unavailable, the heading falls back to `Chunk N`.

Grouped abstract objects intentionally do not expose a top-level `chunkId`. They expose `documentId`, `filename`, `abstract`, and `chunkIds`. This makes segment planning store source document IDs while retaining chunk provenance for tests and future diagnostics.

---

## 4. Implementation Details

### 4.1 Extend `listDocumentAbstracts()`

Modify [`listDocumentAbstracts(jobId)`](../../../api/_lib/jobs.js) to return the chunk metadata required for grouping.

Use `job_documents.original_filename` as the canonical source filename, with a fallback to `document_chunks.original_filename`:

```sql
SELECT
  da.*,
  dc.document_id,
  dc.chunk_order,
  dc.page_start,
  dc.page_end,
  dc.split_from,
  COALESCE(jd.original_filename, dc.original_filename) AS source_filename
FROM document_abstracts da
JOIN document_chunks dc ON dc.id = da.chunk_id
LEFT JOIN job_documents jd ON jd.id = dc.document_id
WHERE da.job_id = ${jobId}
ORDER BY dc.chunk_order ASC, dc.page_start ASC NULLS LAST, da.created_at ASC
```

Update `rowToAbstract()` to include:

```js
{
  documentId: row.document_id,
  chunkOrder: row.chunk_order,
  pageStart: row.page_start,
  pageEnd: row.page_end,
  splitFrom: row.split_from,
  sourceFilename: row.source_filename,
}
```

The `LEFT JOIN` is defensive. Valid current rows should have matching `job_documents` records, but fallback behavior avoids making synthesis brittle if older data is incomplete.

### 4.2 Add `groupAbstractsByDocument()`

Add a pure helper near [`buildAbstractInput()`](../../../api/_lib/synthesis.js).

The helper should:

- Group abstracts by `documentId`, falling back to `chunkId`.
- Preserve first-seen source document order.
- Sort chunks inside each group by `chunkOrder`, then `pageStart`, then `createdAt`.
- Preserve single-chunk abstract text unchanged.
- Concatenate multi-chunk abstract text with page or chunk headings.
- Return grouped items with `documentId`, `filename`, `abstract`, and `chunkIds`.

Reference implementation:

```js
function compareNullableNumber(a, b) {
  const aMissing = a == null;
  const bMissing = b == null;
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  return a - b;
}

export function groupAbstractsByDocument(abstracts) {
  const orderedGroups = [];
  const byId = new Map();

  for (const abstract of abstracts) {
    const key = abstract.documentId || abstract.chunkId || abstract.id;
    if (!key) continue;

    let group = byId.get(key);
    if (!group) {
      group = {
        documentId: abstract.documentId || null,
        filename: abstract.sourceFilename || abstract.filename || abstract.originalFilename || abstract.chunkId || key,
        chunks: [],
      };
      byId.set(key, group);
      orderedGroups.push(group);
    }

    group.chunks.push(abstract);
  }

  return orderedGroups.map(group => {
    const chunks = [...group.chunks].sort((a, b) => {
      const byOrder = compareNullableNumber(a.chunkOrder, b.chunkOrder);
      if (byOrder !== 0) return byOrder;
      const byPage = compareNullableNumber(a.pageStart, b.pageStart);
      if (byPage !== 0) return byPage;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });

    if (chunks.length === 1) {
      return {
        documentId: group.documentId,
        filename: group.filename,
        abstract: chunks[0].abstract || chunks[0].abstractText || '',
        chunkIds: chunks.map(chunk => chunk.chunkId).filter(Boolean),
      };
    }

    const abstract = chunks
      .map(chunk => {
        const text = chunk.abstract || chunk.abstractText || '';
        const range = chunk.pageStart != null && chunk.pageEnd != null
          ? `Pages ${chunk.pageStart}-${chunk.pageEnd}`
          : `Chunk ${(chunk.chunkOrder ?? chunks.indexOf(chunk)) + 1}`;
        return `**${range}:**\n\n${text}`;
      })
      .join('\n\n');

    return {
      documentId: group.documentId,
      filename: group.filename,
      abstract,
      chunkIds: chunks.map(chunk => chunk.chunkId).filter(Boolean),
    };
  });
}
```

Implementation note: avoid using `chunks.indexOf(chunk)` if the final implementation can cheaply carry the map index. The snippet above is illustrative; the production version can use `.map((chunk, index) => ...)`.

### 4.3 Wire Grouping in `planJobSynthesis()`

The abstract loading path is [`planJobSynthesis()`](../../../api/_lib/synthesis.js), which is called by both synthesis enqueueing and processing. Grouping belongs there so all callers share the same plan identity and segment shape.

Change the current flow:

```js
const abstracts = await store.listDocumentAbstracts(jobId);
const orderedAbstracts = abstracts
  .filter(item => (item.abstractText || item.abstract || '').trim().length > 0)
  .map(item => ({
    chunkId: item.chunkId,
    documentId: item.documentId,
    filename: item.originalFilename || item.filename || item.chunkId,
    abstract: item.abstractText || item.abstract || '',
  }));
```

To:

```js
const abstracts = await store.listDocumentAbstracts(jobId);
const normalizedAbstracts = abstracts
  .filter(item => (item.abstractText || item.abstract || '').trim().length > 0)
  .map(item => ({
    id: item.id,
    chunkId: item.chunkId,
    documentId: item.documentId,
    chunkOrder: item.chunkOrder,
    pageStart: item.pageStart,
    pageEnd: item.pageEnd,
    createdAt: item.createdAt,
    filename: item.sourceFilename || item.originalFilename || item.filename || item.chunkId,
    sourceFilename: item.sourceFilename,
    abstract: item.abstractText || item.abstract || '',
  }));
const orderedAbstracts = groupAbstractsByDocument(normalizedAbstracts);
```

Keep the existing empty-abstract guard after grouping.

### 4.4 Make Plan IDs Document-Based

Plan IDs are computed in [`planJobSynthesis()`](../../../api/_lib/synthesis.js). After grouping, the `documentIds` input must be based on grouped source documents:

```js
documentIds: orderedAbstracts.map(item => item.documentId || item.id),
```

Update `computeAbstractDigest()` to prefer source document identity:

```js
hash.update(String(item.documentId || item.chunkId || item.id || ''));
```

The digest should still include the grouped abstract text:

```js
hash.update(String(item.abstract || item.abstractText || ''));
```

This makes the plan ID stable for identical grouped source-document content while still changing when chunk abstract text changes.

### 4.5 Store Source Document IDs in Segments

Keep the segmentation algorithm in [`planSynthesisSegments()`](../../../api/_lib/synthesis.js) unchanged, but change ID precedence:

```js
documentIds: chunk.map(item => item.documentId || item.chunkId || item.id),
```

After grouping, segment `documentIds` should contain source document IDs. The `config.chunkSize` cap now limits documents per segment instead of chunks per segment. The byte-envelope check in `buildSynthesisChunks()` remains the main safety control for large grouped abstracts.

### 4.6 Resolve Segments by Document ID During Execution

[`processSynthesisSegment()`](../../../api/_lib/synthesis.js) currently builds a lookup by `chunkId`:

```js
const byChunkId = new Map(abstracts.map(item => [item.chunkId, item]));
```

That will fail after segment planning stores source document IDs. Update segment execution to resolve by `documentId` first, with `chunkId` as a compatibility fallback:

```js
const byDocumentId = new Map(
  abstracts
    .filter(item => item.documentId)
    .map(item => [item.documentId, item]),
);
const byChunkId = new Map(
  abstracts
    .filter(item => item.chunkId)
    .map(item => [item.chunkId, item]),
);

const segmentAbstracts = (segment.documentIds || [])
  .map(id => byDocumentId.get(id) || byChunkId.get(id))
  .filter(Boolean)
  .map(record => ({
    filename: record.filename || record.originalFilename || record.documentId || record.chunkId,
    abstract: record.abstract || record.abstractText || '',
    documentId: record.documentId,
    chunkIds: record.chunkIds || (record.chunkId ? [record.chunkId] : []),
  }))
  .filter(item => item.abstract.trim().length > 0);
```

This is required. Without it, grouped segments can be planned successfully and then fail at execution with `missing_abstracts`.

When building the `chunkId` compatibility map, index both `record.chunkId` and every value in `record.chunkIds`. This preserves compatibility with persisted legacy segments whose `documentIds` array contains chunk IDs, even though newly grouped abstracts do not expose a top-level `chunkId`.

---

## 5. Edge Cases

### 5.1 Single-Chunk Documents

Single-chunk documents pass through unchanged. No page heading is added, preserving current prompt text as closely as possible.

### 5.2 Multi-Chunk Documents with Missing Page Ranges

If `pageStart` or `pageEnd` is missing, use `Chunk N` headings. This preserves ordering and provenance without inventing page numbers.

### 5.3 Missing `documentId`

If a row lacks `documentId`, group by `chunkId`. This preserves current behavior for malformed or legacy rows and avoids accidental merging.

### 5.4 In-Flight Jobs

Jobs with an already-persisted synthesis plan continue using that plan. Jobs that plan synthesis after deploy use grouped document IDs.

If an existing plan ID no longer matches after deployment, the current re-planning behavior can create a new plan. No data migration is required.

### 5.5 Segment Size

Grouping can produce larger individual abstract entries. A PDF split into five chunks becomes one grouped abstract with all five chunk abstracts.

The count cap (`SYNTHESIS_CHUNK_SIZE`, default 50) becomes a document-count cap. The byte-envelope check in `buildSynthesisChunks()` remains the binding constraint for oversized requests and should keep segment payloads similar to today's chunk-based segmentation.

---

## 6. Failure Handling

Grouping is pure and in-memory. It should not introduce new retry behavior.

Defensive behaviors:

- Empty input produces empty grouped output, after which existing no-abstract handling applies.
- Rows without abstract text are filtered before grouping, as they are today.
- Missing source filenames fall back to chunk filenames or IDs.
- Missing `documentId` falls back to `chunkId`.

If one chunk of a split document has no successful abstract, the grouped document will contain only the completed chunk abstracts. This is the same information-loss profile as today, but presented under one source document heading.

---

## 7. Testing

Add focused coverage in [`test/synthesis.test.js`](../../../test/synthesis.test.js).

### Unit Tests

- `groupAbstractsByDocument()` preserves a single-chunk abstract unchanged.
- `groupAbstractsByDocument()` groups a three-chunk document into one item with `Pages Y-Z` headings.
- Mixed single-chunk and multi-chunk inputs preserve first-seen document order.
- Chunks inside a grouped document sort by `chunkOrder`, then `pageStart`, then `createdAt`.
- Missing page ranges fall back to `Chunk N`.
- Missing `documentId` falls back to chunk-level grouping.
- Empty input returns an empty array.

### Planning Tests

- `planJobSynthesis()` produces segments whose `documentIds` are source document IDs, not chunk IDs.
- `computeAbstractDigest()` changes when grouped abstract text changes.
- Identical grouped inputs produce identical plan IDs.

### Segment Execution Tests

- `processSynthesisSegment()` resolves grouped segment IDs by `documentId`.
- `processSynthesisSegment()` still resolves legacy segment IDs by `chunkId`.
- A grouped segment with document IDs does not fail with `missing_abstracts`.

### Manual Smoke Test

Run a real job with about 10 source PDFs, including at least two PDFs large enough to split. Inspect the synthesis prompt and confirm:

- The prompt has one `Document N` heading per source PDF.
- Split PDFs show page-range headings inside a single document section.
- `synthesis_segments.document_ids` contains source document IDs.
- The final opinion refers to source filenames rather than chunk-suffixed filenames.

---

## 8. Deployment and Rollback

### Deployment

No migration is required. Deploy as a forward-only code change.

Expected file changes:

- [`api/_lib/jobs.js`](../../../api/_lib/jobs.js): select and map grouping metadata.
- [`api/_lib/synthesis.js`](../../../api/_lib/synthesis.js): add grouping helper, wire it into `planJobSynthesis()`, update ID precedence, and update segment lookup.
- [`test/synthesis.test.js`](../../../test/synthesis.test.js): add unit and integration coverage.

A feature flag is optional but not necessary. If staged rollout is desired, gate only the `planJobSynthesis()` grouping call behind an environment variable such as `ENABLE_DOCUMENT_GROUPING`.

### Rollback

Revert the code changes. No database cleanup is needed.

Jobs with grouped plans may re-plan under the old chunk-based plan ID after rollback. That can cost one additional planning pass, but it should not lose data.

---

## 9. Future Considerations

- Persisted per-document merged abstracts could be added later if grouped concatenation is not enough for synthesis quality on heavily split PDFs.
- A token-aware segment cap could eventually replace the current count-based `SYNTHESIS_CHUNK_SIZE`.
- The UI or follow-up Q&A flow could expose grouped per-document abstracts later, using the same helper or a persisted equivalent.
