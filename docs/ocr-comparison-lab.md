# OCR comparison lab

An opt-in browser page at `/ocr-compare.html` compares the configured current
Gemini abstraction model (default `gemini-3.1-flash-lite`) with
`gemini-4-hydrogen` and Anthropic's `claude-haiku-5-5`. It does not change the production abstraction model,
create durable jobs, save abstracts, or run title-opinion synthesis.

## Enable locally

Use Node **26** (the 26.x series), then `npm ci`.
In your git-ignored `.env.local`, configure:

- `OCR_COMPARE_ENABLED=true`
- `APP_PASSWORD` — optional locally. With it unset (and not running as production),
  the lab needs no password and the page hides the password field. Set it to
  require a password locally. Production (`NODE_ENV=production` or `K_SERVICE` set)
  always requires it: the lab returns 503 there when it is unset
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
If `APP_PASSWORD` is set, enter the application password on this page. It is not
persisted, and obsolete remembered credentials are not reused. Reloading requires
re-entry. If it is unset locally, the page loads the models and effort levels
straight away and sends no password.

To test without Google Cloud or a separate Anthropic key, see
[Running locally with OpenRouter](#running-locally-with-openrouter).

The lab API is **disabled unless `OCR_COMPARE_ENABLED` is exactly `true`**.
Enabling it on Cloud Run is a separate deployment/configuration decision;
adding this code alone does not enable production testing. A server running
inside a hosted Hermes container is not publicly reachable on its own port.

## Running locally with OpenRouter

One OpenRouter key can run all three columns. This is opt-in and meant for
local testing; production keeps direct Gemini and direct Anthropic.

1. In your git-ignored `.env.local`, set:

   ```sh
   OPENROUTER_API_KEY=your-openrouter-key
   OCR_COMPARE_ENABLED=true
   OCR_COMPARE_PROVIDER=openrouter
   ```

   No `APP_PASSWORD` is needed locally: leave it unset and the lab works without
   a password (the page hides the password field). If you do set it, the page asks
   for it as usual. Production still requires `APP_PASSWORD`; with it unset
   there, the lab returns 503. "Production" means `NODE_ENV=production` or a
   non-empty `K_SERVICE`.

   `GEMINI_API_KEY` and `ANTHROPIC_API_KEY` are not needed in this mode.
2. Run `npm run dev` and open `http://localhost:8080/ocr-compare.html`
   (the page is `ocr-compare.html`; `/ocr-compare` without the extension serves the main app).
3. Compare as usual. Enter the app password only if you set `APP_PASSWORD`.

Behavior with `OCR_COMPARE_PROVIDER=openrouter`:

- All three columns call `https://openrouter.ai/api/v1/chat/completions`
  (non-streaming, 290 s timeout per call, same shared output limit):

  | Column | OpenRouter slug |
  | --- | --- |
  | Current Gemini (`ABSTRACT_MODEL`, default `gemini-3.1-flash-lite`) | `google/gemini-3.1-flash-lite` (`google/<ABSTRACT_MODEL>` for an override) |
  | Gemini 4 Hydrogen | `google/gemini-4-hydrogen` |
  | Claude Haiku 5.5 | `anthropic/claude-haiku-5.5` (dot, not `-5-5`) |

- The effort you pick is sent as OpenRouter's unified `reasoning: { effort }`.
  Current Gemini at `default` sends no `reasoning` field, so the model's own
  default applies. The effort buttons offer the same levels as in direct mode.
- Rendered pages go out as `image_url` data URLs. The server does not persist them.
- A missing `OPENROUTER_API_KEY` returns 503 naming that variable. Any value of
  `OCR_COMPARE_PROVIDER` other than `openrouter`, `direct`, or unset returns 503.
- Each column shows "via OpenRouter" and the report has `provider: "openrouter"`.
  Version is the model id OpenRouter reports having served.
- Usage: OpenRouter's `completion_tokens` include reasoning tokens. For the two
  Gemini columns the lab shows output without reasoning plus the reasoning count
  as thinking, as it does for direct Gemini. For Haiku, output keeps the
  reasoning, as in direct mode, and the thinking count is display only. Nothing
  is billed twice.
- Cost: OpenRouter's reported `usage.cost` is used when present. With a BYOK key
  (`is_byok: true`) `usage.cost` is only OpenRouter's own fee, often 0, so the lab
  uses `usage.cost_details.upstream_inference_cost` instead. If that is missing,
  or `usage.cost` is absent or invalid, the cost is computed from the list rates
  in the table below. The source line says which.
- The Hydrogen and Haiku effort labels say what the lab asked for. How
  OpenRouter maps `reasoning.effort` onto each upstream model is OpenRouter's choice.
- **Privacy:** your document images go to OpenRouter and then to the upstream
  provider it routes to (Google or Anthropic). Check OpenRouter's data policy and
  your account's privacy settings before using sensitive title documents.
- Results can differ slightly from direct mode because routing, defaults and
  reasoning mapping differ. Compare models against each other within one mode.

### Choosing the three OpenRouter models

To compare other models, for example Mistral, list exactly three OpenRouter
slugs in `.env.local`. This works only with `OCR_COMPARE_PROVIDER=openrouter`:

```sh
OCR_COMPARE_OPENROUTER_MODELS=mistralai/mistral-large-4-0,mistralai/mistral-small-3.2-24b-instruct,mistralai/mistral-small-2603
```

- The three slugs become the three columns, in order. Unset (or blank) keeps the
  default Gemini, Gemini 4 Hydrogen and Haiku columns unchanged.
- Anything other than three different `vendor/model` slugs returns 503 naming
  the variable. Setting it in direct mode also returns 503 rather than being ignored.
- Known slugs get a friendly label, the effort levels OpenRouter lists for them
  (`GET /api/v1/models`, `reasoning.supported_efforts`, checked 2026-11-13) and list rates:

  | Slug | Label | Effort buttons (first load) | Rates per 1M tokens (in / out) |
  | --- | --- | --- | --- |
  | `mistralai/mistral-large-4-0` | Mistral Large 4 | `high` (selected), `none` | $0.70 / $2.10 |
  | `mistralai/mistral-small-3.2-24b-instruct` | Mistral Small 3.2 24B | `default` | $0.10 / $0.30 |
  | `mistralai/mistral-small-2603` | Mistral Small 4 | `high`, `none` (selected) | $0.15 / $0.60 |

  Small 4 does not reason unless you pick `high`. Small 3.2 has no reasoning
  control, so it sends no `reasoning` field. `none` sends `reasoning: { effort: "none" }`,
  which OpenRouter documents as disabling reasoning. Any other slug shows the slug
  as its label, a single `default` effort (no `reasoning` field) and no computed
  cost unless OpenRouter reports `usage.cost`. The Haiku and Hydrogen slugs above
  keep their usual menus and rates.
- The Gemini-style split of reasoning out of `output_tokens` applies only to
  `google/gemini-*`. For Mistral and every other family, output keeps the
  reasoning and the thinking count is display only, so nothing is billed twice.
- The page and the shared output limit are unchanged: three panels, 16000 tokens
  unless `OCR_COMPARE_MAX_TOKENS` is set.

## Compare

1. Select up to 10 PDF, PNG, JPEG, or WebP files at once (enter the app password first if the page shows the field).
   Once the models load (after the password is entered, or immediately in no-password local mode), each model column shows a row of effort buttons.
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
| Gemini 4 Hydrogen | `low`, `medium`, `high`, `xhigh` (Hydrogen has no `minimal`, `default`, or `max`) | `medium` | `thinkingLevel` |
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
  several instruments, and medium-effort thinking tokens (Gemini 4 Hydrogen and
  Haiku 5.5) count against the same limit. Above 8,192 Anthropic requires
  streaming, so the lab streams Haiku calls automatically. Output cut off by the limit is flagged in the UI as truncated.
- Each model runs at the effort selected on the page (see Effort levels). By
  default the baseline uses the configured production Gemini thinking level, or
  the provider default if none is set; Gemini 4 Hydrogen and Haiku 5.5 start at `medium`.
  Haiku 5.5 always runs with adaptive thinking. Sampling parameters are not sent
  (Haiku 5.5 rejects non-default values). Its
  `output_tokens` already include any thinking tokens; the thinking count shown
  is the portion Anthropic reports in `output_tokens_details`, not an extra charge. These settings are shown, not treated as equal.
- This compares visual **title-field extraction**, not a verbatim full-page
  transcription or the complete production workflow (text-first delivery,
  batching, fallback, and escalation are intentionally excluded).
- The lab calls the **direct Gemini API** and the **direct Anthropic API**, even
  if `MODEL_PROVIDER=openrouter` is set for production. Provider routing can therefore differ from production.
  The one exception is the opt-in `OCR_COMPARE_PROVIDER=openrouter` (next section), which is for local testing.
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
| `gemini-4-hydrogen` | $1.50 | $7.50 |
| `gemini-3.8-flash` (only as the Current Gemini baseline), through 2026-12-31 UTC | $0.75 | $3.75 |
| `gemini-3.8-flash` (only as the Current Gemini baseline), from 2027-01-01 UTC | $1.50 | $7.50 |
| `claude-haiku-5-5`, prompts up to 100K tokens | $0.10 | $0.50 |
| `claude-haiku-5-5`, prompts over 100K tokens | $0.50 | $2.50 |

Sources: https://ai.google.dev/gemini-api/docs/pricing and
https://platform.claude.com/docs/en/about-claude/pricing . Rates were checked on
2026-10-07 (Hydrogen: 2026-11-13). Haiku's prompt-length tier uses input plus cache tokens; cache
writes ($0.125 / $0.625) and reads ($0.01 / $0.05) are priced when reported.
Estimates do not represent actual invoices, free-tier eligibility,
batch discounts, or other service tiers. Claude image inputs are tokenized
differently from Gemini's, so input-token counts are not comparable across
providers. An unknown model's pricing or
missing token counts produces no estimate rather than a made-up zero.

Document images are sent to Google and to Anthropic for inference (or, with
`OCR_COMPARE_PROVIDER=openrouter`, to OpenRouter and its upstream provider). The lab does not persist
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
