# OCR comparison lab

An opt-in browser page at `/ocr-compare.html` compares the configured current
Gemini abstraction model (default `gemini-3.1-flash-lite`) with
`gemini-3.8-flash` and Anthropic's `claude-haiku-5-5`. It does not change the production abstraction model,
create durable jobs, save abstracts, or run title-opinion synthesis.

## Enable locally

Use Node **26** (the 26.x series), then `npm ci`.
In your git-ignored `.env.local`, configure:

- `OCR_COMPARE_ENABLED=true`
- `APP_PASSWORD` — your application's access password (required even locally)
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — a key with access to both Gemini models
- `ANTHROPIC_API_KEY` — for Claude Haiku 5.5. If it is missing, only the Haiku
  column reports an error; the Gemini results are still returned
- Optional `ABSTRACT_MODEL` — baseline model override, restricted to Gemini 3-series
- Optional `OCR_COMPARE_MAX_TOKENS` — shared output-token limit, including thinking tokens (default 16000)

The isolated lab rejects other baseline models (including Gemini 2.5) with
HTTP 503 for both metadata and comparisons, before starting either provider.
Budget-based Gemini 2.5 thinking is outside the lab's supported scope; this
restriction does not change production `ABSTRACT_MODEL` behavior.

Do not paste API keys into the browser or commit `.env.local`.
Run `npm run dev` and open `http://localhost:8080/ocr-compare.html`.
Enter the application password on this page. It is not persisted, and obsolete
remembered credentials are not reused. Reloading requires re-entry.

The lab API is **disabled unless `OCR_COMPARE_ENABLED` is exactly `true`**.
Enabling it on Cloud Run is a separate deployment/configuration decision;
adding this code alone does not enable production testing. A server running
inside a hosted Hermes container is not publicly reachable on its own port.

## Compare

1. Enter the app password, then select up to 10 PDF, PNG, JPEG, or WebP files at once.
   Once the password is entered, each model column shows a row of effort buttons.
   Click one to change that model's effort for the next comparison (see Effort levels).
2. Review the file list and the rendered source-page previews, and read the stated number of billable calls (three per file).
3. Click **Compare OCR** once. Files are compared one at a time in the order selected; within a file, the three models run in parallel.
4. Select **View** on a file in the list to review its three outputs and field differences. Download the JSON report if you want to retain the results; it contains a `files` array with one entry per finished file.
5. To intentionally compare again, change the effort buttons and click **Compare OCR** again.
   Prepared files are reused without rendering or selecting them again, including
   files that finished, failed, or were not run. Each rerun refreshes server
   settings and makes three new billable model calls per usable file. It replaces
   the previous results. Changing effort alone never starts a comparison, and
   overlapping comparisons are blocked.

Limits: 10 files per selection, and 60 pages and 12,000,000 bytes of rendered
image data per file. The page limit applies to each file separately, not to the
whole selection. Use one recorded instrument per file; the models abstract only
the first instrument they find in a file.

A file that cannot be rendered or validated is listed as unusable and skipped.
If a request fails (wrong password, lab disabled, provider not configured, or
another comparison already running on the server), the remaining files are not
run and nothing is retried. Results for files that already finished stay
available. A single model failing inside a finished comparison does not stop the
batch.

If rendering exceeds a file's limit, prepare a smaller page range as a separate
file. There is no automatic retry, PDF splitting, Claude escalation, or
synthesis. Only one comparison can run per server instance at a time (the batch
runs files sequentially for this reason); this is not a cross-instance quota.

## Effort levels

The server lists the levels each model accepts; the browser sends one level per
model with each comparison, and the server rejects any level a model does not
accept before calling a provider. A column you have not clicked follows the
server's level; a level you picked is kept until the page reloads, or reset (with
a note under the buttons) if the server changes the model or stops offering it.
Metadata errors stay visible through file selection and control updates until
current credentials successfully load valid settings. Editing or clearing the
password invalidates pending loads; stale responses cannot restore the buttons.
Supported picks for the same model survive a successful refresh.

| Column | Levels | Starts at | Sent as |
| --- | --- | --- | --- |
| Current Gemini | `minimal`, `low`, `medium`, `high` (only `minimal`/`high` for `gemini-3.1-flash-lite-image`; no `minimal` for 3.7/3.8 Flash or Pro baselines; plus `default` when `GEMINI_THINKING_LEVEL` is unset) | the configured level, or `default` | `thinkingLevel`; `default` sends none |
| Gemini 3.8 Flash | `low`, `medium`, `high` (3.8 Flash rejects `minimal`) | `medium` | `thinkingLevel` |
| Claude Haiku 5.5 | `low`, `medium`, `high`, `xhigh`, `max` | `medium` | `output_config.effort` |

Higher levels spend more thinking tokens, which count against the shared output
limit and are billed as output. The chosen level is shown in each result and
saved as `effort` in the JSON report.

## What the comparison measures

Accuracy is scored in the browser against the document's embedded text. Images and text-free scans have no score. The text is not uploaded.

- Every PDF is rendered in the browser at scale 2 before upload. All pages stay
  lossless PNG when their combined size fits 12,000,000 bytes, regardless of
  page order. Only an oversized aggregate triggers JPEG encoding of the largest
  pages, at the same scale. The browser tries quality 0.92 through 0.45, using
  the highest quality that resolves the remaining deficit or the smallest
  beneficial encoding when more pages must contribute savings. PNG is retained
  when it is smaller. A file is rejected if the aggregate still exceeds the cap
  after every page's available savings. Rendering canvases are released after
  each page; only page blobs are retained until the final encodings are chosen.
  Neither model receives the original PDF or its hidden/searchable text layer.
- All three models receive the exact same rendered images, in the same order,
  with the shared `ABSTRACTION_PROMPT` and the same output-token limit. The lab
  limit is 16,000 by default (set `OCR_COMPARE_MAX_TOKENS`, 512–32000, to change
  it) rather than production's roughly 2,000: a multi-page upload can contain
  several instruments, and medium-effort thinking tokens (Gemini 3.8 Flash and
  Haiku 5.5) count against the same limit. Above 8,192 Anthropic requires
  streaming, so the lab streams Haiku calls automatically. Output cut off by the limit is flagged in the UI as truncated.
- Each model runs at the effort selected on the page (see Effort levels). By
  default the baseline uses the configured production Gemini thinking level, or
  the provider default if none is set; 3.8 Flash and Haiku 5.5 start at `medium`.
  Haiku 5.5 always runs with adaptive thinking. Sampling parameters are not sent
  (Haiku 5.5 rejects non-default values). Its
  `output_tokens` already include any thinking tokens; the thinking count shown
  is the portion Anthropic reports in `output_tokens_details`, not an extra charge. These settings are shown, not treated as equal.
- This compares visual **title-field extraction**, not a verbatim full-page
  transcription or the complete production workflow (text-first delivery,
  batching, fallback, and escalation are intentionally excluded).
- The lab calls the **direct Gemini API** and the **direct Anthropic API**, even
  if `MODEL_PROVIDER=openrouter` is set for production. Provider routing can therefore differ from production.
- Field differences are review cues, **not accuracy scores**. Agreement is not
  proof. When a PDF has embedded text, the page scores transcribed fields against
  that text. A scan with no text layer still needs a manual check.
- A failure in either model does not hide the other model's successful output.
  Empty or token-limited outputs need review rather than a guessed success.

## Usage, cost, and privacy

Each comparison makes three billable model calls when using a paid API tier.
Timing is server-side model-call wall time, not browser rendering/upload time.
Token usage includes input, output, and thinking tokens when reported.

Cost is an **estimate** using standard paid direct API rates in USD per
million tokens, including thinking in output cost. A Gemini response that omits
its thinking-token count is treated as zero thinking tokens; a response missing
input or output counts gets no estimate:

| Model | Input | Output + thinking |
| --- | ---: | ---: |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 |
| `gemini-3.8-flash`, through 2026-12-31 UTC | $0.75 | $3.75 |
| `gemini-3.8-flash`, from 2027-01-01 UTC | $1.50 | $7.50 |
| `claude-haiku-5-5`, prompts up to 100K tokens | $0.10 | $0.50 |
| `claude-haiku-5-5`, prompts over 100K tokens | $0.50 | $2.50 |

Sources: https://ai.google.dev/gemini-api/docs/pricing and
https://platform.claude.com/docs/en/about-claude/pricing . Rates were checked on
2026-10-07. Haiku's prompt-length tier uses input plus cache tokens; cache
writes ($0.125 / $0.625) and reads ($0.01 / $0.05) are priced when reported.
Estimates do not represent actual invoices, free-tier eligibility,
batch discounts, or other service tiers. Claude image inputs are tokenized
differently from Gemini's, so input-token counts are not comparable across
providers. An unknown model's pricing or
missing token counts produces no estimate rather than a made-up zero.

Document images are sent to Google and to Anthropic for inference. The lab does not persist
source images or outputs to the job database or document bucket; downloaded
reports remain on your device. Existing application authentication may use
its shared rate-limiter store for auth bookkeeping, but no lab document or
abstract is written there. Reports contain extracted text, not image bytes,
access passwords, or API keys. Follow your provider account's data-use policy
before uploading sensitive title documents.

## Verification

Focused tests:

```sh
node test/ocr-compare.test.js
node test/ocr-compare-ui.test.js
```

Both are included in `npm test`. Provider fixtures in automated tests verify
request concurrency, visual input, auth, error isolation, and report rendering;
they are **not live OCR results**. A real quality comparison requires your API
key and representative title documents.
