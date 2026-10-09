# OCR comparison lab

An opt-in browser page at `/ocr-compare.html` compares the configured current
Gemini abstraction model (default `gemini-3.1-flash-lite`) with
`gemini-3.8-flash` and Anthropic's `claude-haiku-5-5`. It does not change the production abstraction model,
create durable jobs, save abstracts, or run title-opinion synthesis.

## Enable locally

Use Node **22.13 or newer within the 22.x series**, then `npm ci`.
In your git-ignored `.env.local`, configure:

- `OCR_COMPARE_ENABLED=true`
- `APP_PASSWORD` — your application's access password (required even locally)
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — a key with access to both Gemini models
- `ANTHROPIC_API_KEY` — for Claude Haiku 5.5. If it is missing, only the Haiku
  column reports an error; the Gemini results are still returned
- Optional `ABSTRACT_MODEL` — baseline model override, restricted to Gemini 3-series
- Optional `OCR_COMPARE_MAX_TOKENS` — shared output-token limit (default 8000)

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
2. Review the file list and the rendered source-page previews, and read the stated number of billable calls (three per file).
3. Click **Compare OCR** once. Files are compared one at a time in the order selected; within a file, the three models run in parallel.
4. Select **View** on a file in the list to review its three outputs and field differences. Download the JSON report if you want to retain the results; it contains a `files` array with one entry per finished file.

Limits: 10 files per selection, and 10 pages and 12,000,000 bytes of rendered
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

## What the comparison measures

- Every PDF is rendered into PNG pages in the browser at scale 2 before upload.
  Neither model receives the original PDF or its hidden/searchable text layer.
- All three models receive the exact same rendered images, in the same order,
  with the shared `ABSTRACTION_PROMPT` and the same output-token limit. The lab
  limit is 8,000 by default (set `OCR_COMPARE_MAX_TOKENS`, 512–8192, to change
  it) rather than production's roughly 2,000: a multi-page upload can contain
  several instruments, and Haiku 5.5's thinking tokens count against the same
  limit. Output cut off by the limit is flagged in the UI as truncated.
- The baseline uses the configured production Gemini thinking level, or the
  provider default if none is set. 3.8 Flash explicitly uses `low` because it
  does not support `minimal`. Haiku 5.5 always runs with adaptive thinking; the
  lab sets `output_config.effort` to `low`, its closest analogue. Sampling
  parameters are not sent (Haiku 5.5 rejects non-default values). Its
  `output_tokens` already include any thinking tokens; the thinking count shown
  is the portion Anthropic reports in `output_tokens_details`, not an extra charge. These settings are shown, not treated as equal.
- This compares visual **title-field extraction**, not a verbatim full-page
  transcription or the complete production workflow (text-first delivery,
  batching, fallback, and escalation are intentionally excluded).
- The lab calls the **direct Gemini API** and the **direct Anthropic API**, even
  if `MODEL_PROVIDER=openrouter` is set for production. Provider routing can therefore differ from production.
- Field differences are review cues, **not accuracy scores**. Use manually
  verified answers to decide which output is correct; agreement is not proof.
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
