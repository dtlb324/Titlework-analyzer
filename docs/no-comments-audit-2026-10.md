# Titlework-analyzer no-comments audit and pruning plan (2026-10-14)

Read-only `no-comments` audit of `/opt/data/repos/Titlework-analyzer` at `origin/Main` (`764f580`). No application code was changed in this commit.

## Summary counts

The census scanned 62 tracked JavaScript and Python files and classified 317 non-docstring comment blocks plus 4 Python docstrings:

| Category | Count | Action |
| :--- | :--- | :--- |
| Straight-up delete (section banners, what-narration, test phase narration) | 265 | Delete comment only |
| `MUST KILL` workarounds and constraint comments | 9 | Refactor or deduplicate, then delete comment |
| Kept external protocol or vendor comments | 43 | Keep |

## Part 1: Straight-up delete (265 blocks)

1. **Section banners and dividers (38 blocks).**
   * `scripts/compare-ocr-models.mjs` lines 27, 69, 128, 182, 307, 394, 457, and 477.
   * `scripts/generate_chain_pdf.py` lines 37, 47, 68, 129, 1556, and 1616.
   * `scripts/generate_test_titles.py` lines 26, 35, 41, 46, 130, 338, 858, 1191, 1211, and 1343.
   * `test/openrouter-request.test.js` (6 banners), `test/openrouter-stream.test.js` (1 banner), `test/synthesis.test.js` (3 banners), `test/abstraction.test.js` (1 banner), and `test/app.test.js` (1 banner).
2. **Inline what-narration (153 blocks).**
   * `scripts/generate_chain_pdf.py` lines 139 through 1514: 41 numbered instrument comments (`# 1 - Patent` through `# 41 - Assignment...`) where the next line's `inst(...)` call already contains the instrument title.
   * `scripts/generate_test_titles.py` repeated `# degraded` and `# degraded stamp` inline comments (lines 84, 220, 403, 668, 669, 782, 1093, 1140, and 1141) next to `RECORDING_REF=None` or `deg_stamp=True`.
   * `api/_lib/openrouter-request.js` lines 24, 58, 70, 111, 119, and 141, and `api/_lib/openrouter-stream.js` lines 31 and 90.
   * `api/_lib/model-client.js` lines 195, 198, and 201 (`// OpenRouter routing`, `// Gemini routing`, `// Anthropic routing` immediately above `if (shouldUseOpenRouter(model))`, `if (isGeminiModel(model))`, and `if (isAnthropicModel(model))`).
3. **Phase-narrating test comments (74 blocks).**
   * Step narration in `test/synthesis.test.js` (37 blocks), `test/abstraction.test.js` (8 blocks), `test/ocr-compare-ui.test.js` (5 blocks), and `test/jobs.test.js` (3 blocks) where the test name and assertion message already state the condition.

## Part 2: Workarounds best solved by refactoring (`MUST KILL`)

### A. Trivial direct fixes

1. **Redundant `thinkingBudget` fallback in `api/_lib/gemini-request.js` (lines 118 through 125).**
   * `buildGeminiRequestBody` calls `resolveGeminiThinkingConfig(model, { thinkingBudget, thinkingLevel })` and then has an `else if (Number.isFinite(Number(thinkingBudget)))` branch with `// Explicit legacy call sites may still pass thinkingBudget directly.`
   * `resolveGeminiThinkingConfig` already resolves `overrides.thinkingBudget` for Gemini 2.5 models and intentionally omits `thinkingBudget` on Gemini 3.x models.
   * **Action:** Keep all thinking-config resolution inside `resolveGeminiThinkingConfig` and delete the `else if` fallback and comment in `buildGeminiRequestBody`.
2. **Duplicated chunk upload-skip predicate in `api/_lib/jobs.js` (lines 2831 through 2833) and `api/jobs/[...path].js` (lines 73 through 75).**
   * Both files duplicate `if (chunk.splitParentChunkId)` and `if (chunk.abstractionStatus === 'completed')` along with identical comments (`// Server-created split children use a parent-based key path; skip them.` and `// Continuation imports arrive already abstracted and point at the source job's object.`).
   * **Action:** Extract `chunkRequiresDirectUpload(chunk)` in `api/_lib/jobs.js` and call it from both modules.

### B. Architectural and structural refactors

1. **Deduplicate `scheduleBackgroundProcessing` and `scheduleBackgroundSynthesis` in `api/_lib/queue.js` (lines 334 through 362 and 482 through 510).**
   * Both functions carry the identical comment (`// Legacy in-process fallback for local/manual use. Cloud Run deployments should use worker.js so route handlers only enqueue durable work.`) and identical promise-map deduplication, `waitUntil` invocation, and error logging.
   * **Action:** Collapse both into one internal helper `scheduleInProcessBatch(promiseMap, jobId, eventName, runBatch, options)` in `api/_lib/queue.js`.
2. **Encode shared incomplete-abstraction statuses across `api/_lib/jobs.js` and `api/_lib/synthesis.js` (`test/worker.test.js` lines 160 through 162).**
   * `test/worker.test.js` uses a source-regex drift guard comment warning that the SQL runnable filter in `jobs.js` and `planJobSynthesis` in `synthesis.js` must agree on the three incomplete abstraction statuses (`pending`, `processing`, `retry_wait`).
   * **Action:** Export `INCOMPLETE_ABSTRACTION_STATUSES = Object.freeze(['pending', 'processing', 'retry_wait'])` from `api/_lib/jobs.js` and import it in `api/_lib/synthesis.js`.
3. **Trim unimplemented `WORKFLOW_DRIVER=inngest` setup prose in `api/_lib/queue.js` (lines 1 through 15 and 45 through 65).**
   * `api/_lib/queue.js` carries a 15-line header explaining how to configure `WORKFLOW_DRIVER=inngest`, while the implementation only returns a 503 setup error and production runs on Cloud Run `worker.js`.
   * **Action:** Delete the speculative Inngest setup prose from the header comment while preserving the 503 guard tested by `test/abstraction.test.js`.

## Part 3: Kept external protocol and vendor exceptions (43 blocks)

1. `api/_lib/client-ip.js` lines 1 through 5: Google Cloud Run appends the connecting client IP to the rightmost `X-Forwarded-For` hop without stripping client-supplied leftmost entries.
2. `api/_lib/gemini-request.js` lines 17 and 27 through 31, `api/ocr-compare.js` lines 27 through 28 and 153 through 154, and `scripts/compare-final-opinion.mjs` lines 128 through 131: Gemini 3.x uses `thinkingLevel` (`gemini-3.1-flash-lite-image` allows only `minimal` and `high`), Gemini 2.5 uses `thinkingBudget` (2.5 Pro rejects `0`), and `thoughtsTokenCount` is omitted when zero.
3. `api/ocr-compare.js` lines 7 through 11, 120 through 122, and 135: Anthropic requires streaming above `NON_STREAMING_MAX_TOKENS` (8192), includes `thinking_tokens` inside `output_tokens` for billing, and prices the full request at the long-prompt tier above 200k input tokens.
4. `api/_lib/openrouter-request.js` lines 29 through 35 and 141 through 149, `api/_lib/model-client.js` lines 211 through 213, and `test/abstraction.test.js` lines 435 through 438: OpenRouter uses dot-versioned Claude slugs (`anthropic/claude-sonnet-5.5`), rejects Gemini `file_uri` parts, passes `cache_control` only to `anthropic/*` models, and requires leaving `response.body` unconsumed on HTTP 200 SSE streams.
5. `server.js` lines 18 through 19: scanned PDFs require PDF.js JBIG2 and JPEG2000 WASM decoders.
