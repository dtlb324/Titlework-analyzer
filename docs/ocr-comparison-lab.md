# OCR comparison lab

An opt-in browser page at `/ocr-compare.html` compares the configured current
Gemini abstraction model (default `gemini-3.1-flash-lite`) with
`gemini-3.8-flash`. It does not change the production abstraction model,
create durable jobs, save abstracts, or run title-opinion synthesis.

## Enable locally

Use Node **22.13 or newer within the 22.x series**, then `npm ci`.
In your git-ignored `.env.local`, configure:

- `OCR_COMPARE_ENABLED=true`
- `APP_PASSWORD` — your application's access password (required even locally)
- `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) — a key with access to both models
- Optional `ABSTRACT_MODEL` — baseline model override, restricted to Gemini 3-series

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

1. Enter the app password, then select one PDF, PNG, JPEG, or WebP.
2. Review the rendered source-page previews and the two model settings.
3. Click **Compare OCR** once. This starts one request per model in parallel.
4. Review both outputs and the field differences. Download the JSON report if
   you want to retain the results.

Limits: 10 pages and 12,000,000 bytes of rendered image data per comparison.
Use one recorded instrument per file. If rendering exceeds the limit, prepare
a smaller page range as a separate file. There is no automatic retry, PDF
splitting, Claude escalation, or synthesis. Only one comparison can run per
server instance at a time; this is not a cross-instance quota.

## What the comparison measures

- Every PDF is rendered into PNG pages in the browser at scale 2 before upload.
  Neither model receives the original PDF or its hidden/searchable text layer.
- Both models receive the exact same rendered images, in the same order,
  with the shared `ABSTRACTION_PROMPT` and the same output-token limit from
  `getAbstractionConfig()` (normally 2,000).
- The baseline uses the configured production Gemini thinking level, or the
  provider default if none is set. 3.8 Flash explicitly uses `low` because it
  does not support `minimal`. These settings are shown, not treated as equal.
- This compares visual **title-field extraction**, not a verbatim full-page
  transcription or the complete production workflow (text-first delivery,
  batching, fallback, and escalation are intentionally excluded).
- The lab calls the **direct Gemini API**, even if `MODEL_PROVIDER=openrouter`
  is set for production. Provider routing can therefore differ from production.
- Field differences are review cues, **not accuracy scores**. Use manually
  verified answers to decide which output is correct; agreement is not proof.
- A failure in either model does not hide the other model's successful output.
  Empty or token-limited outputs need review rather than a guessed success.

## Usage, cost, and privacy

Each comparison makes two billable model calls when using a paid API tier.
Timing is server-side model-call wall time, not browser rendering/upload time.
Token usage includes input, output, and thinking tokens when reported.

Cost is an **estimate** using standard paid direct Gemini rates in USD per
million tokens, including thinking in output cost:

| Model | Input | Output + thinking |
| --- | ---: | ---: |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 |
| `gemini-3.8-flash`, through 2026-12-31 UTC | $0.75 | $3.75 |
| `gemini-3.8-flash`, from 2027-01-01 UTC | $1.50 | $7.50 |

Source: https://ai.google.dev/gemini-api/docs/pricing . Rates were checked on
2026-10-07. Estimates do not represent actual invoices, free-tier eligibility,
caching discounts, or other service tiers. An unknown model's pricing or
missing token counts produces no estimate rather than a made-up zero.

Document images are sent to Google for inference. The lab does not persist
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
