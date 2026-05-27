# Mineral Ownership Builder — Title Research Tool

An AI-powered web application for oil and gas landmen to analyze courthouse documents, build chain of title, and determine mineral ownership. Document abstraction uses Google Gemini 2.5 Flash; title synthesis and follow-ups use Anthropic Claude. Deployed on Google Cloud Run.

> **Important:** This tool is an AI-assisted research aid, not a legal opinion. Always verify output against source documents and consult a licensed attorney before any drilling, leasing, or division order action.

## Architecture

The Cloud Run deployment uses two Cloud Run services, Google Cloud Storage, and Neon Postgres:

- **Web/API service:** serves `public/index.html`, `/healthz`, `/api/healthz`, and the `/api/*` routes from `server.js`.
- **Worker service:** runs `worker.js` and drains durable abstraction/synthesis work from Postgres.
- **Google Cloud Storage:** stores uploaded PDFs, images, CSVs, and split PDF chunks through signed browser uploads.
- **Neon Postgres:** stores jobs, documents, chunks, abstracts, synthesis segments, final results, and follow-up messages.

The browser creates a job, uploads files directly to GCS, polls job status, and renders results. With the background worker disabled (current production default), processing is driven by API kicks while the browser tab is open. Enable the worker (`WORKER_DISABLED=false`) when jobs should continue after the tab closes.

## Required Services

1. Create or select a Google Cloud project.
2. Enable Cloud Run, Artifact Registry, Cloud Storage, IAM Credentials, and Security Token Service APIs.
3. Create a Neon project and copy the pooled Postgres connection string.
4. Create a private GCS bucket for durable document storage.
5. Create a Cloud Run service account with:
   - `roles/storage.objectAdmin` on the document bucket
   - permission to read any Secret Manager secrets you use

## Environment Variables

Set these on both Cloud Run services unless noted otherwise:

| Name | Required | Notes |
|------|----------|-------|
| `GEMINI_API_KEY` | Yes | Google AI Studio API key for abstraction and partial synthesis segments (`gemini-2.5-flash`). Also accepts `GOOGLE_API_KEY`. |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for the final title opinion (Sonnet), follow-ups, and optional abstraction escalation. |
| `SYNTHESIS_MODEL` | Optional | Default `claude-sonnet-4-6` for the final title opinion, merge, and follow-ups. Set to e.g. `gemini-3.5-flash` to use Gemini for the final opinion (requires `GEMINI_API_KEY`). Haiku is not allowed for final synthesis. |
| `SYNTHESIS_PARTIAL_MODEL` | Optional | Default `gemini-2.5-flash` for large-job segment synthesis only (not the final opinion). Haiku/Claude values are ignored. |
| `SYNTHESIS_CHUNK_SIZE` | Optional | Default `120` (max `250`). Max grouped documents per partial synthesis segment before byte envelope split. |
| `BULK_SYNTHESIS_CHUNK_SIZE` | Optional | Default `200` for jobs with ≥100 abstracts. |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | Optional | Default `5000` for Gemini partial segment output. |
| `ABSTRACT_MODEL` | Optional | Default `gemini-2.5-flash`. Claude Haiku is not supported for abstraction. |
| `GEMINI_THINKING_BUDGET` | Optional | **Gemini 2.5 only.** Default `0` (thinking off). Set to `-1` for dynamic thinking, or a token count (e.g. `1024`). Ignored for Gemini 3.x models. |
| `GEMINI_THINKING_LEVEL` | Optional | **Gemini 3.x only** (e.g. `gemini-3.5-flash`). One of `minimal`, `low`, `medium`, `high`. Use `high` for hardest title/fraction work. If unset, the API default applies (`medium` on 3.5 Flash). |
| `GEMINI_INCLUDE_THOUGHTS` | Optional | When `true`, Gemini may return thought summaries; they are exposed on the model response as `thoughtSummaries` and are **not** mixed into abstracts/opinions. For debugging/eval. |
| `APP_PASSWORD` | Yes for production | Password gate for users; release verification expects it on both services. |
| `DATABASE_URL` | Yes | Neon pooled Postgres URL, usually ending in `?sslmode=require`. |
| `GCS_BUCKET` | Yes | Private bucket for uploaded source chunks and split PDFs. |
| `ANALYZE_MAX_REQUEST_BYTES` | Optional | Default `20000000`. |
| `ANALYZE_UPSTREAM_TIMEOUT_MS` | API only | Default `240000`. |
| `ABSTRACTION_UPSTREAM_TIMEOUT_MS` | Worker only | Default `240000`; used to size abstraction leases. |
| `SYNTHESIS_UPSTREAM_TIMEOUT_MS` | Worker only | Default `240000`; used to size synthesis leases. |
| `CLOUD_RUN_UPSTREAM_TIMEOUT_MS` | Optional | Shared fallback for abstraction and synthesis upstream timeouts. |
| `STORAGE_MAX_UPLOAD_BYTES` | Optional | Default `104857600` (100 MB). |
| `WORKFLOW_BATCH_LIMIT` | Optional | Default `12`. |
| `SYNTHESIS_BATCH_LIMIT` | Optional | Default `4` (max `16`). Ready synthesis segments claimed per `/synthesis/process` batch. Production releases set `8`. |
| `SYNTHESIS_STREAM_ENABLED` | Optional | Default off. When `true`, streams the final merge (Claude Sonnet or Gemini, per `SYNTHESIS_MODEL`) to `GET /api/jobs/:id/synthesis/preview` while merge is in progress; validated opinion is saved only after the stream completes. |
| `SYNTHESIS_COMPACTION_ENABLED` | Optional | Default on. When enabled, compacts ≥6 segments (or large merge input) via Gemini Flash before the final Sonnet merge. |
| `SYNTHESIS_COMPACTION_MIN_SEGMENTS` | Optional | Default `6`. Minimum segment count before compaction runs. |
| `SYNTHESIS_COMPACTION_MIN_MERGE_TOKENS` | Optional | Default `40000`. Estimated merge input token threshold for compaction. |
| `SYNTHESIS_LARGE_JOB_MULTI_SEGMENT` | Optional | Default off. When `true`, forces multi-segment Gemini partial synthesis for jobs above `BULK_JOB_MIN_ABSTRACTS` instead of a single Sonnet pass. |
| `SYNTHESIS_FORCE_SINGLE_PASS` | Optional | When `true`, opts out of `SYNTHESIS_LARGE_JOB_MULTI_SEGMENT` forcing. |
| `WORKFLOW_CONCURRENCY` | Optional | Default `4`. |
| `WORKFLOW_BUDGET_MS` | Optional | Default `1200000` (20 min). |
| `WORKFLOW_LEASE_MS` | Optional | Default is longer than the model upstream timeout. |
| `WORKFLOW_STALE_LEASE_MS` | Optional | Default is longer than `WORKFLOW_LEASE_MS`. |
| `SYNTHESIS_MERGE_LEASE_MS` | Optional | Defaults longer than synthesis upstream timeout. |
| `SYNTHESIS_STALE_LEASE_MS` | Optional | Defaults longer than synthesis merge lease. |
| `WORKER_POLL_INTERVAL_MS` | Worker only | Legacy idle poll fallback. Default `5000`; prefer `WORKER_POLL_IDLE_MS`. |
| `WORKER_POLL_IDLE_MS` | Worker only | Default `2000` when a worker instance is running and idle. Production releases scale the worker to zero by default. |
| `WORKER_POLL_ACTIVE_MS` | Worker only | Default `0` (no sleep between busy worker passes). |
| `WORKER_DISABLED` | Worker only | Production default `true` (loop disabled, scale-to-zero). **Current ops: keep disabled.** Set `false` only when you intentionally want unattended background processing. |
| `WORKFLOW_KICK_ON_START` | API | Default `true`. Runs a bounded background batch when abstraction/synthesis start is called. |
| `WORKFLOW_KICK_BUDGET_MS` | API kick | Default `50000` per start kick (under the 60s API limit). |
| `ABSTRACTION_PDF_TEXT_FIRST` | Optional | Default `true`. Use extracted PDF text when quality checks pass (lower token cost). |
| `ABSTRACTION_BATCH_ENABLED` | Optional | Default `true`. Batch up to 24 small chunks per abstraction API call on the worker. |
| `ABSTRACTION_BATCH_MAX_DOCS` | Optional | Default `24` (max `48`). Max documents per server abstraction batch. |
| `ABSTRACTION_BATCH_MAX_PAGE_SPAN` | Optional | Default `32`. Page-range chunks above this span stay solo. |
| `ABSTRACTION_PDF_TEXT_STRICT` | Optional | Default `false`. When `true`, tightens text-first quality gates so borderline scans use native visual PDF on Gemini. |
| `GEMINI_FILE_API_ENABLED` | Optional | Default `true`. Upload large visual PDFs/images via Gemini Files API instead of base64 in JSON. |
| `GEMINI_FILE_API_MIN_BYTES` | Optional | Default `1500000`. Minimum blob size to use Files API (visual delivery). |
| `GEMINI_FILE_API_MAX_BYTES` | Optional | Default `48000000`. Maximum upload size for Files API. |
| `ABSTRACT_MAX_TOKENS` | Optional | Default `2000` (was 3000). |
| `SYNTHESIS_MAX_TOKENS` | Optional | Default `6000` (was 8000). |
| `ABSTRACTION_ESCALATION_ENABLED` | Optional | Default `true`. Set `false` to skip Sonnet re-reads on low-confidence abstracts. |
| `OPUS_AUDIT_ENABLED` | Optional | Default off. **Production: keep `false`.** Do not enable unless explicitly re-requested; not part of synthesis speed work. |
| `RELEASE_VERSION` | Release workflow | Set automatically from the release tag. |
| `GIT_SHA` | Release workflow | Set automatically from the deployed commit. |
| `IMAGE_DIGEST` | Release workflow | Set automatically from the immutable container digest. |

Use Neon's pooled connection string for Cloud Run. It keeps database cost low while the app still uses standard Postgres tables and SQL.

## Local Development

Install dependencies and run tests:

```bash
npm install
npm test
```

Run the web/API service locally:

```bash
npm start
```

Run the worker locally in a second terminal:

```bash
npm run start:worker
```

## Release To Cloud Run

Production releases are automated by `.github/workflows/release.yml`. Push a lowercase `vX.Y.Z` tag that exactly matches the `package.json` version:

```bash
VERSION="v$(node -p "require('./package.json').version")"
git tag "$VERSION"
git push origin "$VERSION"
```

The release workflow runs tests on Node 22, builds one Docker image, pushes it to Artifact Registry, resolves the immutable image digest, deploys the worker first, then deploys the API from that same immutable image digest. The worker deploy uses `--min-instances=0`, `WORKER_DISABLED=true`, `--concurrency=1`, `--no-cpu-throttling`, and a 3600 second timeout. This keeps the worker scale-to-zero by default so it does not spend database network quota while idle. The workflow creates or updates the GitHub Release only after production verification passes.

GitHub Actions `Release` is the only production deploy path. Do not leave Cloud Build or Cloud Run source-deploy triggers on `main`; they can race the tag workflow and overwrite the verified release image.

Configure these GitHub repository variables before the first release:

| Name | Purpose |
|------|---------|
| `GCP_PROJECT_ID` | Google Cloud project ID. |
| `GCP_REGION` | Cloud Run and Artifact Registry region, currently `us-south1` for this project. |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Federation provider for GitHub OIDC. |
| `GCP_SERVICE_ACCOUNT` | Deploy service account used by GitHub Actions. |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | Optional runtime service account assigned to Cloud Run services. |
| `GAR_REPOSITORY` | Artifact Registry Docker repository. |
| `API_SERVICE` | API Cloud Run service name, usually `titlework-analyzer-api`. |
| `WORKER_SERVICE` | Worker Cloud Run service name, usually `titlework-analyzer-worker`. |

The GitHub deploy service account must be configured for Workload Identity Federation from this repository. Grant it enough IAM to push images and deploy Cloud Run, typically Artifact Registry writer on the image repository, Cloud Run service deployment permissions, `roles/iam.serviceAccountTokenCreator` for the repo-scoped WIF principal, and `roles/iam.serviceAccountUser` on `GCP_RUNTIME_SERVICE_ACCOUNT` when that variable is set. The runtime service account still needs the bucket, Secret Manager, and database/network access required by the app.

Secrets such as `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `APP_PASSWORD`, and `DATABASE_URL` must be configured on both Cloud Run services through Cloud Run environment variables or Secret Manager. The release workflow verifies required variable names are present, but it does not store secret values in GitHub.

### Gemini API setup (abstraction)

1. Open [Google AI Studio](https://aistudio.google.com/apikey) and create an API key for your Google account or Cloud project.
2. In Cloud Run (both API and worker services), add `GEMINI_API_KEY` with that value.
3. Configure `ANTHROPIC_API_KEY` when using Claude for the final opinion (default `SYNTHESIS_MODEL=claude-sonnet-4-6`). For `SYNTHESIS_MODEL=gemini-3.5-flash`, the final opinion and follow-ups use Gemini instead. Abstraction and partial segments use Gemini Flash by default.
4. Optional: set `ABSTRACT_ESCALATION_MODEL=claude-sonnet-4-6` (default) for harder documents; escalation requires Anthropic even when abstraction uses Gemini.

### Release Verification

After each release, verify:

- API `/api/healthz` reports the expected `release.version`, `release.gitSha`, `release.imageDigest`, and Cloud Run revision.
- API and worker latest ready revisions use the same immutable image digest.
- Both services still have database, GCS, Gemini, Anthropic, and app password configuration.
- GCS CORS allows `PUT` uploads from the API service origin with the `content-type` header.
- `gh release list --limit 3` marks the new version as `Latest`.

### Rollback

Rollback API and worker together. Either redeploy both services from the same previously verified image digest:

```bash
gcloud run deploy titlework-analyzer-worker \
  --image PREVIOUS_IMAGE_DIGEST_REF \
  --region us-south1 \
  --command npm \
  --args run,start:worker \
  --no-allow-unauthenticated

gcloud run deploy titlework-analyzer-api \
  --image PREVIOUS_IMAGE_DIGEST_REF \
  --region us-south1 \
  --allow-unauthenticated
```

Or shift both services to matching prior Cloud Run revisions. After rollback, confirm both latest ready revisions report the same image digest and release metadata. Database changes are forward-only unless a future migration system adds explicit reversible migrations.

## How Bulk Processing Works

```text
Browser
  -> creates job metadata through /api/jobs
  -> uploads chunks directly to GCS with signed URLs
  -> starts abstraction and synthesis
  -> polls status/result endpoints

Cloud Run worker
  -> claims ready chunk/segment rows from Neon Postgres
  -> reads source bytes from GCS
  -> calls Gemini 2.5 Flash (abstraction + partial synthesis segments)
  -> calls Claude Sonnet (final title opinion, follow-ups, optional escalation/audit)
  -> stores abstracts, synthesis segments, and final result in Postgres
```

Model calls still use document/chunk/segment work units. Cloud Run removes the Vercel request and function ceilings, but the app still preserves safe model request budgets, retries, cancellation, leases, and checkpoints.

Production releases keep the worker scale-to-zero and set `WORKER_DISABLED=true` by default. While the browser session is open, the API start/process endpoints kick bounded abstraction and synthesis batches and the browser polls progress. Jobs are not guaranteed to continue unattended after the browser is closed unless you intentionally run background worker capacity or add a future event-driven worker.

**Synthesis speed Phase 0:** See [docs/synthesis-speed-phase-0-runbook.md](docs/synthesis-speed-phase-0-runbook.md) for production env defaults, structured log events, and the browser-driven ops checklist. Design spec: [docs/superpowers/specs/2026-05-26-synthesis-speed-optimization-design.md](docs/superpowers/specs/2026-05-26-synthesis-speed-optimization-design.md).

The durable Cloud Run worker processes uploaded chunks directly from GCS. PDFs are uploaded as whole documents when possible so legal instruments keep their full context. When extracted text passes quality checks, the worker sends **text-first** prompts (lower token cost than full visual PDF blocks). Up to **24 small chunks** can share one abstraction API call on the worker (same batching idea as the browser fallback). Large visual PDFs (≥1.5 MB) are uploaded via the **Gemini Files API** so whole instruments stay unsplit when possible. Text-first extraction is used only when quality checks pass; set `ABSTRACTION_PDF_TEXT_STRICT=true` for stricter scan detection. If a PDF still exceeds model request limits or times out, the worker can degrade to page-range split recovery and the final result warns that clause continuity, legal descriptions, and exhibits need manual verification. Browser-only fallback can group up to 24 small documents per call and still page-splits oversized single PDFs as an escape hatch.

## Features

- Bulk upload up to 400 documents per job.
- Direct browser-to-GCS durable uploads.
- Server-side abstraction with Gemini 2.5 Flash.
- Server-side final title synthesis and follow-ups with Claude Sonnet 4.6; partial segment passes use Gemini 2.5 Flash.
- Durable job URLs that survive refreshes and closed tabs.
- Retry, cancellation, partial failure, and failed-chunk recovery.
- PDF download of final results.

## Security

| Protection | Detail |
|-----------|--------|
| Password gate | Optional `APP_PASSWORD` header/session gate. |
| Rate limiting | Configurable `ANALYZE_RATE_LIMIT_MAX`, default 300 requests/minute/IP. |
| Direct uploads | Browser uploads go to signed GCS URLs; document bytes do not pass through `/api/analyze`. |
| Private storage | Source files live in a private GCS bucket. |
| Durable metadata | Postgres stores metadata, refs, abstracts, results, and sanitized errors. |
| No raw payload persistence | API validators reject base64/raw document fields in job metadata routes. |
| CSP | Allows app origin plus Google Cloud Storage upload endpoints. |

## Project Structure

```text
Titlework-analyzer/
├── api/
│   ├── _lib/
│   │   ├── cloud-run-worker.js
│   │   ├── jobs.js
│   │   ├── node-http-adapter.js
│   │   ├── queue.js
│   │   └── storage.js
│   ├── analyze.js
│   ├── blob/upload.js
│   └── jobs/
├── public/index.html
├── server.js
├── worker.js
├── Dockerfile
├── package.json
└── test/
```

## Troubleshooting

**`Google Cloud Storage is not configured`**  
Set `GCS_BUCKET` on both Cloud Run services and grant the service account object permissions on the bucket.

**`DATABASE_URL or POSTGRES_URL is required`**  
Set `DATABASE_URL` to your Neon pooled Postgres connection string.

**Uploads fail with CORS errors**  
Configure the GCS bucket CORS policy to allow `PUT` requests from the web/API Cloud Run origin with the `content-type` header.

**Jobs stay queued or abstracting**  
Confirm the worker service is deployed, has `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, and `GCS_BUCKET`, and can connect to Neon.

**Model timeouts or rate limits**  
Lower `WORKFLOW_CONCURRENCY`, lower `WORKFLOW_BATCH_LIMIT`, or raise provider rate limits (Gemini or Anthropic). Retryable errors are saved as durable `retry_wait` rows.

## Cost Notes

Cloud Run and GCS are billed by Google Cloud usage, while Neon can start on its free tier. **Gemini** (abstraction and partial synthesis) and **Anthropic** (final opinion, follow-ups, optional escalation) are billed separately by each provider. API cost scales with document count, page count, scan resolution, and title complexity.

### Typical 300-document job (no PDF splits)

Rough model-inference count: **~305 calls** (300 abstraction + ~4 partial synthesis segments for bulk chunking + 1 final Sonnet merge). App `/api/*` polling and GCS uploads are separate from token cost.

| Stage | Model | Role |
|-------|--------|------|
| Abstraction | `gemini-2.5-flash` | One call per chunk (or fewer with worker batching) |
| Partial synthesis | `gemini-2.5-flash` | Segment summaries before merge |
| Final opinion | `claude-sonnet-4-6` | Single merge (and follow-ups) |

**Paid Gemini 2.5 Flash** (indicative): ~$0.30/MTok input, ~$2.50/MTok output. **Sonnet 4.6** remains the dominant cost for the final merge on large runs. A full 300-doc run is typically on the order of **~$2–4** in model tokens on the Gemini + Sonnet stack (varies with page count, scans vs text PDFs, and output length)—well below the old Haiku-heavy estimate (~$6–7) before the Gemini migration.

### Optimizations in this branch

| Knob | Effect |
|------|--------|
| `ABSTRACTION_PDF_TEXT_FIRST=true` (default) | Largest savings on text-native PDFs: sends extracted text instead of visual PDF blocks |
| `ABSTRACTION_BATCH_ENABLED=true` | Fewer abstraction **calls** (up to 24 small chunks per request); modest token savings |
| `GEMINI_FILE_API_ENABLED=true` | Keeps large scanned PDFs whole via Files API instead of page-splitting for envelope limits |
| `ABSTRACT_MAX_TOKENS=2000`, `SYNTHESIS_MAX_TOKENS=6000` | Caps output spend without changing prompts |
| `ABSTRACTION_ESCALATION_ENABLED=false` | Avoids Sonnet re-runs on low-confidence abstracts (escalation is relatively expensive vs Gemini Flash) |
| `OPUS_AUDIT_ENABLED` off (required in production) | Keeps Opus off the hot path; no second full-model pass after merge |

We do **not** use Anthropic or Gemini Batch API (24h window, no completion notification). Reliability and progress polling stay on the durable worker + Neon job model.
