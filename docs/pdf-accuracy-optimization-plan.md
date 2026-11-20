# PDF Accuracy Optimization Plan

**Date:** 2026-11-19  
**Goal:** Maximize courthouse PDF abstraction and downstream title-opinion accuracy per dollar and per second without degrading throughput on clean digital PDFs.

## Target Architecture: Smart Two-Tier PDF Pipeline

Instead of running one heavy configuration on every upload, route each PDF according to its actual visual complexity and escalate only the specific chunks that show OCR/extraction risk:

| PDF Class | Tier 1 (Fast Pass) | Tier 2 (Selective Re-Read — Flagged Chunks Only) |
|---|---|---|
| **Clean born-digital PDF** (no full-page raster images, clean embedded text) | Local text extraction (`unpdf`), batched in small labeled groups (4–6 docs) on `gemini-3.1-flash-lite` | Triggered only if identity/stamp fields are missing, `ILLEGIBLE`, or fail deterministic checks → **solo visual re-read** |
| **Scanned / noisy-OCR / stamped / hybrid PDF** | **Solo** visual PDF call with `MEDIA_RESOLUTION_HIGH` (never batched with other scans) | Triggered only on `ILLEGIBLE`, low confidence, or validation failure → stronger visual model at `medium` effort + higher `maxOutputTokens` |

---

## Priorities in Order

### Tier 1 — High-Impact Pipeline Fixes (Highest ROI, Minimal Cost/Latency)

#### Priority 1: Isolate visual PDFs from multi-doc batches and label every attachment
- **Problem (verified):**
  - `api/_lib/abstraction-batch.js:23-25` packs up to 24 PDFs (`MAX_DOCS_PER_BATCH = 24`) into one `gemini-3.1-flash-lite` call.
  - `api/_lib/abstraction.js:265-319` (`buildAbstractMessagesForChunks`) appends all visual/hybrid `document` blocks up front with no document-boundary labels (`line 292`), then appends one single combined `text` block at the end (`line 317`) that also mixes in text-extracted PDFs. Output parsing (`BATCH_ABSTRACT_RESPONSE_SCHEMA`, `api/_lib/abstraction.js:45`) relies purely on positional array indexing, so one shifted or merged instrument misattributes subsequent documents.
  - `api/_lib/pdf-text.js:178-180` (`estimatePdfPlanningPayloadBytes`) estimates any PDF ≥ 1.5 MB at `6,000` bytes (for Gemini Files API), causing `chunkRequiresSoloBatch` (`api/_lib/abstraction-batch.js:44-52`) to pack large multi-page scanned PDFs into multi-doc batches.
- **Planned change:**
  - Keep visual/scanned PDFs solo (or restrict multi-doc batching to clean text-only chunks and lower `MAX_DOCS_PER_BATCH` from `24` to `6–8`).
  - Stop treating ≥ 1.5 MB PDFs as `6,000` bytes when deciding whether a chunk requires a solo batch.
  - Interleave explicit `--- START DOCUMENT #N (filename) ---` text blocks immediately before each `document`/`image` block in `buildAbstractMessagesForChunks`.
  - Key batch schema responses by document index (e.g., `{ docIndex, abstract }`) instead of a bare positional string array so misalignment is caught and falls back to solo processing.
- **Affected files:**
  - `api/_lib/abstraction-batch.js`
  - `api/_lib/abstraction.js`
  - `api/_lib/pdf-text.js`
- **Verification:**
  - Update and run `node test/abstraction-batch.test.js`, `node test/abstraction.test.js`, `node test/pdf-text.test.js`.
  - Add tests verifying: (a) ≥ 1.5 MB scanned PDFs are scheduled solo, (b) every visual block is preceded by its document label, and (c) misaligned batch outputs fall back cleanly to solo processing.
- **Impact:** Eliminates silent cross-document misattribution and attention dilution on scanned PDFs with minimal latency cost (solo calls run concurrently via `WORKFLOW_CONCURRENCY`).

---

#### Priority 2: Harden `pdf-text.js` against dirty OCR layers and dropped raster stamps
- **Problem (verified):**
  - `api/_lib/pdf-text.js:126-129` (`assessExtractedPdfText`) only flags `likely_scanned_image` when `bytesPerChar > config.maxBytesPerChar && charsPerPage < config.minSparseCharsPerPage`. Any scanned courthouse PDF carrying a pre-existing, low-quality OCR layer (≥ 400 chars/page of garbled ASCII such as `l/8th`, `Vol. lO4`, `195l`) bypasses the check completely and is sent as `mode: 'text'`, discarding the visual scan.
  - Born-digital PDFs with raster County Clerk recording stamps, handwritten marginalia, signatures, or strikethroughs also pass text heuristics and lose those visual elements entirely.
- **Planned change:**
  - Inspect page XObjects/image coverage (via `pdf-lib` or `unpdf`) to detect image-backed pages and raster overlays; route image-backed pages to `visual` (or `hybrid`, sending visual pages alongside extracted text as context rather than discarding visuals).
  - Tighten `assessExtractedPdfText` so high `bytesPerChar` is not bypassed solely because `charsPerPage >= minSparseCharsPerPage`.
  - Add lightweight OCR-noise heuristics (`\uFFFD` replacement characters, abnormal symbol/digit-in-word noise, or missing core recording fields) and evaluate enabling `ABSTRACTION_PDF_TEXT_STRICT=true` by default.
- **Affected files:**
  - `api/_lib/pdf-text.js`
  - `api/_lib/abstraction.js`
- **Verification:**
  - Add unit tests in `test/pdf-text.test.js` covering: (a) scanned PDF with a noisy ≥ 400 chars/page OCR text layer routes to `visual`, (b) clean born-digital PDF stays `text`, and (c) mixed text + scanned/stamped page routes to `hybrid`/`visual`.
- **Impact:** Recovers missing recording stamps, handwritten dates/fractions, and badly OCR'd county scans that are currently invisible to the model.

---

#### Priority 3: Enable `MEDIA_RESOLUTION_HIGH` on Gemini visual PDF and image calls
- **Problem (verified):**
  - `api/_lib/gemini-request.js:103-139` (`buildGeminiGenerateContentBody`) never sets `generationConfig.mediaResolution`.
  - Default resolution downsamples dense scans, hurting small legal descriptions, mineral fractions (`1/64` vs `1/640`), handwritten dates, and faint clerk stamps.
- **Planned change:**
  - Accept an optional `mediaResolution` parameter in `buildGeminiGenerateContentBody` and `invokeGeminiGenerateContent` (`api/_lib/gemini-request.js`), configurable via env (e.g., `GEMINI_PDF_MEDIA_RESOLUTION`, default `MEDIA_RESOLUTION_HIGH` for visual/hybrid/image chunks).
  - Apply `MEDIA_RESOLUTION_HIGH` only when a request actually contains visual PDF or image blocks (never on `text`-mode chunks).
- **Affected files:**
  - `api/_lib/gemini-request.js`
  - `api/_lib/abstraction.js`
- **Verification:**
  - Add unit tests in `test/gemini-request.test.js` and `test/abstraction.test.js` confirming `generationConfig.mediaResolution` is included on visual/hybrid/image requests and omitted on text-only requests.
- **Impact:** Significant OCR lift on fine print, fractions, and stamps (~1,120 visual tokens/page on visual chunks only) with zero impact on text-extracted PDFs.

---

### Tier 2 — Selective, Visual-First Escalation (Major Accuracy Lift, Bounded Cost)

#### Priority 4: Repair and re-enable per-chunk, visual-first escalation with a cost-efficient visual model
- **Problem (verified):**
  - `.github/workflows/release.yml:150` currently sets `ABSTRACTION_ESCALATION_ENABLED=false` (disabled for speed/cost when escalation targeted `claude-sonnet-5-5`).
  - `api/_lib/abstraction.js:582` disables escalation whenever `responseSchema` is set, which excludes all batched chunks in `api/_lib/abstraction-batch.js`.
  - `api/_lib/abstraction.js:588-603` re-sends the identical `messages` payload on escalation:
    - If Tier 1 ran in `mode: 'text'`, escalation never attaches the visual PDF bytes.
    - If Tier 1 ran in `mode: 'gemini_file'`, escalation sends a Google `file_uri` to Anthropic/OpenRouter, which rejects `file_uri` (`api/_lib/openrouter-request.js:101-109`), and `catch (_) {}` (`api/_lib/abstraction.js:601`) silently swallows the failure.
- **Planned change:**
  - In `processMultiChunkAbstraction` (`api/_lib/abstraction-batch.js:238-274`), run `shouldEscalateAbstract` on each parsed abstract and re-run **only flagged chunks** through the solo escalation path (preserving lease guards in `persistCompletedAbstract`).
  - Always build escalation messages from **visual PDF bytes** (base64 for Anthropic/OpenRouter, or high-resolution visual/File API for Gemini)—never text-only and never cross-provider `file_uri`.
  - Log escalation failures cleanly (structured warning) instead of silently swallowing them, without adding any automatic retry loop on billable calls.
  - Benchmark cost-efficient visual escalation targets on real deeds in `/ocr-compare.html` (e.g., `claude-haiku-5-5` at `medium` effort vs. `gemini-3.8-flash` / `gemini-4-hydrogen` with `thinkingLevel: 'medium'` and `ABSTRACT_ESCALATION_MAX_TOKENS` = `6000–8000` so thinking tokens do not truncate output) before re-enabling `ABSTRACTION_ESCALATION_ENABLED=true` in `.github/workflows/release.yml`.
- **Affected files:**
  - `api/_lib/abstraction.js`
  - `api/_lib/abstraction-batch.js`
  - `.github/workflows/release.yml` (once benchmarked and approved)
- **Verification:**
  - Add tests in `test/abstraction.test.js` and `test/abstraction-batch.test.js` proving: (a) a `text`-mode flagged abstract escalates with visual PDF bytes attached, (b) a `gemini_file` chunk escalates to an Anthropic/OpenRouter model using base64 rather than `file_uri`, (c) only flagged items in a batch escalate, and (d) escalation never loops or fires more than once per chunk.
- **Impact:** Recovers hard/illegible courthouse instruments while paying escalation cost only on the minority of flagged chunks.

---

#### Priority 5: Add zero-cost deterministic quality checks to `shouldEscalateAbstract`
- **Problem (verified):**
  - `api/_lib/abstraction.js:693-700` (`shouldEscalateAbstract`) only checks for empty output, `ILLEGIBLE - VERIFY MANUALLY`, `CONFIDENCE: low|limited|poor|unclear|uncertain`, and ≥ 90% token usage.
  - Silent extraction errors—omitted required fields, `"not visible"`/`"unclear"` in key fields, inverted execution/recording dates, or hallucinated names/refs that do not appear in a PDF's own embedded text—pass without escalation.
- **Planned change:**
  - Extract a shared, dependency-free field matcher/validator (reusing the normalization logic from `public/ocr-accuracy.js:1-102`).
  - Trigger escalation (once, bounded) when an abstract has:
    - Missing/blank/abstained required identity fields (`GRANTOR`, `GRANTEE` when applicable, `DATE EXECUTED`, `RECORDING REF`, `LEGAL DESC`).
    - Logical impossibilities (e.g., `DATE RECORDED` earlier than `DATE EXECUTED`, or `MINERALS: yes` with no `FRACTION CONVEYED`).
    - Low field-match score against embedded PDF text when embedded text is available.
- **Affected files:**
  - `api/_lib/abstraction.js`
  - `public/ocr-accuracy.js` (or a shared pure helper imported by both)
- **Verification:**
  - Unit tests in `test/abstraction.test.js` and `test/ocr-accuracy.test.js` covering each deterministic trigger and confirming clean abstracts do not false-positive escalate.
- **Impact:** Catches silent hallucinations and omissions at zero extra LLM cost before they propagate into the title chain.

---

### Tier 3 — Edge-Case & Downstream Accuracy Polish

#### Priority 6: Sync browser fallback prompt and add 1-page overlap on PDF splits
- **Problem (verified):**
  - `public/index.html:1123-1146` (`ABSTRACT_PROMPT`) instructs `[date or "not visible"]` instead of `ILLEGIBLE - VERIFY MANUALLY`, bypassing `shouldEscalateAbstractText` (`public/index.html:5963-5968`).
  - `api/_lib/abstraction.js:728-732` (`splitPdfChunk`) splits multi-page PDFs strictly at `Math.ceil(pageCount / 2)` with zero overlap, risking bisecting a deed's granting clause from its reservations, signatures, or acknowledgment.
- **Planned change:**
  - Align `ABSTRACT_PROMPT` in `public/index.html` with `ABSTRACTION_PROMPT` in `api/_lib/abstraction.js:53-76`.
  - Add a 1-page overlap when `pageCount >= 4` in `splitPdfChunk` (while keeping `pageStart`/`pageEnd` metadata accurate for `groupAbstractsByDocument` in `api/_lib/synthesis.js:359-419`).
  - Optionally add a clear UI hint or multi-instrument note when a single uploaded PDF exceeds typical single-instrument page length.
- **Affected files:**
  - `public/index.html`
  - `api/_lib/abstraction.js`
- **Verification:**
  - Run `node test/abstraction.test.js`, `node test/split-cleanup.test.js`, `node test/browser-bughunt.test.js`.
  - Add a test confirming 1-page overlap on split ranges for `pageCount >= 4` and no infinite recursion on 2-page PDFs.
- **Impact:** Prevents dropped clauses on split PDFs and closes the browser-fallback escalation gap.

---

#### Priority 7: Selective high-DPI page rasterization fallback for pathological scans
- **Problem (verified):**
  - Courthouse scans occasionally use exotic PDF encodings (JBIG2, CCITT Group 4, JPEG2000, rotated/layered pages) where provider-side PDF ingestion downsamples or drops content.
  - The repo already vendors `pdfjs-dist` with JBIG2/OpenJPEG WASM (`server.js:17-31`) and adaptive 2× PNG→JPEG rendering (`public/ocr-compare.js:32-90`), but only uses it in `/ocr-compare.html`.
- **Planned change:**
  - Keep raw PDF upload as the fast default path.
  - Add an opt-in or failure-triggered browser/retry option ("Re-read as high-DPI page images") that renders problematic PDFs at `scale: 2` (reusing `prepareDocument` from `public/ocr-compare.js`) and submits the rendered images when raw PDF abstraction still leaves `ILLEGIBLE` fields or fails to parse.
- **Affected files:**
  - `public/index.html`
  - `public/ocr-compare.js` (extract shared PDF rasterizer helper if reused)
  - `api/_lib/abstraction.js`
- **Verification:**
  - Add focused tests in `test/browser-bughunt.test.js` and `test/ocr-compare-ui.test.js`.
- **Impact:** Solves the hardest 5% of legacy courthouse scans without slowing down normal PDF uploads.

---

#### Priority 8: Review production synthesis output cap so upstream accuracy is not truncated
- **Problem (verified):**
  - `.github/workflows/release.yml:150` pins `SYNTHESIS_MAX_TOKENS=5000` and `SYNTHESIS_PARTIAL_MAX_TOKENS=4000` with `SYNTHESIS_CHUNK_SIZE=50`, while `api/_lib/synthesis.js:49-50` defaults to `8000` / `5000` and `effectiveSynthesisChunkSize` (`api/_lib/synthesis.js:309`) budgets ~1,000 output tokens per document.
- **Planned change:**
  - Monitor `synthesis_merge_complete` logs for truncation or `repair_retry` warnings on 30–50+ document jobs; if seen, raise `SYNTHESIS_MAX_TOKENS` in `.github/workflows/release.yml` to `8000` (or `10000`) and keep `SYNTHESIS_PARTIAL_MAX_TOKENS` at `5000`.
- **Affected files:**
  - `.github/workflows/release.yml`
- **Verification:**
  - Run `node test/release.test.js` and `node test/synthesis.test.js`, plus inspect `synthesis_merge_complete` metrics on a representative 50-doc test job.
- **Impact:** Prevents dense Chain of Title / Defects / Ownership tables from being compressed or cut short after accurate PDF abstraction.

---

## Guardrails (Do Not Break)

- Never add automatic retry or fallback loops that re-fire billable Sonnet calls on their own (`AGENTS.md`).
- Keep all abstract persistence lease-guarded via `saveDocumentAbstract` (`api/_lib/abstraction.js:617-664`).
- Keep Claude request bodies strictly within `model`, `max_tokens`, `system`, `messages` (plus `output_config.effort` only where supported); never send `thinking`, `temperature`, `top_p`, or `top_k` to Sonnet 5 / 5.5 (`api/_lib/anthropic-request.js`).
- Run `npm test` after every phase; if any doc change touches `README.md` or `SECURITY.md`, verify `node test/release.test.js`.
