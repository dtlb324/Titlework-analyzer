<p align="center">
  <img src="docs/assets/titlework-banner.jpg" alt="Titlework Analyzer — Mineral Ownership Builder" width="100%">
</p>

<p align="center">
  <img src="docs/assets/badge-macos.svg" alt="macOS">
  <img src="docs/assets/badge-windows.svg" alt="Windows">
</p>

# Titlework Analyzer

Titlework Analyzer is a self-hosted web app for oil and gas landmen. Upload courthouse PDFs, CSVs, and scanned document images to extract structured abstracts, assemble a chain of title, and draft a mineral ownership opinion with follow-up Q&A.

- **Naming:** The page heading is **Mineral Ownership Builder**, the browser tab title is **Mineral Title Analyzer**, and the npm package name is `title-analyzer`.
- **Self-hosted only:** There is no public hosted instance. Clone the repo to run locally or deploy your own copy to Google Cloud Run.
- **Analytical aid only:** Output is an analytical aid, not a formal title opinion. Verify all conclusions against the source instruments before drilling, leasing, or division order decisions.
- **Runtime:** Node.js 26.x (`package.json` engines; CI and `Dockerfile` pin Node.js 26.13.0; no `.nvmrc`).

## Contents

- [Architecture & how it works](#architecture--how-it-works)
- [Quick start: clone and run tests](#quick-start-clone-and-run-tests)
- [Run locally (full app)](#run-locally-full-app)
- [Route models through OpenRouter](#route-models-through-openrouter)
- [Deploy to Google Cloud Run (optional)](#deploy-to-google-cloud-run-optional)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [Cost and spend controls](#cost-and-spend-controls)
- [Security](#security)
- [Repository layout](#repository-layout)
- [License](#license)

---

## Architecture & how it works

Titlework Analyzer is built with **Node.js 26 ESM and zero web framework** (`node:http`). Two services share one container image and coordinate through Neon Postgres and a private Google Cloud Storage (GCS) bucket:

```mermaid
flowchart LR
  Browser["Browser UI (public/index.html)"]
  API["API & Static Server (server.js)"]
  Worker["Background Worker (worker.js)"]
  GCS["Private GCS Bucket"]
  Neon["Neon Postgres"]
  Gemini["Gemini 3.1 Flash-Lite"]
  Claude["Claude Sonnet 5.5"]

  Browser -->|"1. Create job & request signed PUT"| API
  Browser -->|"2. Upload raw PDFs / images / CSVs"| GCS
  API <-->|"Job state, chunks, abstracts, results"| Neon
  Worker <-->|"Lease-guarded chunk & segment claims"| Neon
  Worker -->|"Read source bytes"| GCS
  API -.->|"Optional bounded kick when tab is open"| Neon
  Worker -->|"Abstracts & partial synthesis"| Gemini
  Worker -->|"Escalation re-reads, final merge & follow-ups"| Claude
```

### Services and storage

- **`server.js` (API & frontend):** Serves the single-page app (`public/index.html`), locally vendored browser libraries (`jsPDF`, `pdf-lib`, `pdfjs-dist`), `/api/*` endpoints, and `/healthz`.
- **`worker.js` (Queue processor):** Claims pending abstraction chunks and synthesis segments from Postgres. Exposes `GET /healthz` and `POST /internal/drain` (for scale-to-zero Cloud Scheduler triggers).
- **Neon Postgres (`api/_lib/jobs.js`):** Stores all durable state across seven tables: `analysis_jobs`, `job_documents`, `document_chunks`, `document_abstracts`, `synthesis_segments`, `job_results`, and `followup_messages`. Tables and columns are created and migrated automatically on first use via `ensureSchema` — there is no separate migration CLI or migration directory.
- **Google Cloud Storage (`api/_lib/storage.js`):** Holds uploaded source files in a private bucket. Browsers upload directly via short-lived signed `PUT` URLs so raw file bytes do not pass through the API server.

### End-to-end job pipeline

1. **Direct-to-GCS upload:** The browser creates a job record in Neon, requests a signed `PUT` URL (signing `Content-Type` and `Content-Length`), and uploads each file directly to GCS. Up to 400 files are accepted per job (`PDF`, `CSV`, `JPEG`, `PNG`, `GIF`, `WEBP`). Intake warns when a PDF has 15+ pages and may bundle multiple instruments.
2. **Document abstraction (`gemini-3.1-flash-lite`):**
   - Workers claim chunks with an atomic, lease-guarded `UPDATE ... RETURNING` query and renew leases before each paid model call. If no worker is running, leaving the browser tab open lets the API run bounded batches (`WORKFLOW_KICK_ON_START`, on by default).
   - **Text vs. visual routing:** Clean text-extracted PDFs and CSVs can be packed into multi-document batches (default up to 6 docs, keyed by document index). Scanned, stamped, image-backed, or large PDFs and images run solo with Gemini `MEDIA_RESOLUTION_HIGH`. Oversized visual PDFs upload through the Gemini Files API or split by page range with one-page overlap.
   - **Quality checks & escalation:** Deterministic quality checks (`validateAbstractQuality`) inspect abstracts for missing key fields or defects. When `ABSTRACTION_ESCALATION_ENABLED` is on, flagged chunks get a single visual re-read on `claude-sonnet-5-5`. If unreadable values remain marked `ILLEGIBLE - VERIFY MANUALLY`, the UI offers a **Re-read as high-DPI page images** action that renders pages locally in the browser (`public/pdf-raster.js` via `pdfjs-dist`).
   - If server-side abstraction is unavailable, the browser can fall back to client-driven batching (up to 24 small documents per call) and client-side PDF splitting.
3. **Synthesis & follow-ups (`claude-sonnet-5-5` + `gemini-3.1-flash-lite`):**
   - Small jobs synthesize in a single `claude-sonnet-5-5` pass.
   - Large jobs split abstracts into parallel segments summarized by `gemini-3.1-flash-lite`, optionally compact large merge inputs, and merge into a final ownership opinion with `claude-sonnet-5-5` (optionally streamed to `GET /api/jobs/:id/synthesis/preview`).
   - Follow-up questions run against `claude-sonnet-5-5` with conversation history stored in `followup_messages`.
4. **Resumability & export:** Every job is bookmarkable at `#/job/<id>` (recent jobs at `#/jobs`). Users can cancel jobs, retry single or failed chunks, and export the final opinion to PDF in the browser with `jsPDF`.

---

## Quick start: clone and run tests

You can clone the repo and run the entire automated test suite without API keys, a database, a GCS bucket, or `.env.local`.

```bash
git clone https://github.com/dtlb324/Titlework-analyzer.git
cd Titlework-analyzer
npm ci
npm test
```

- `npm test` runs the explicit chain of test scripts in `package.json` in order and stops at the first failure. There is no `npm run build` step and no coverage script.
- `node test/smoke-server.js` starts a manual local server on `127.0.0.1:3456` (`npm test` does not start it).
- `npm run audit:ui` runs the Playwright UI audit harness (`scripts/audit/run.mjs`).
- CI (`.github/workflows/test.yml`) runs `npm ci`, `npm test`, and `docker build -t titlework-analyzer:test .` on Node.js 26.13.0 for pull requests and pushes to `Main` and `main`. `.github/workflows/secret-scan.yml` runs gitleaks on the same events.

---

## Run locally (full app)

Running real jobs locally requires **four external resources** (a Neon database, Gemini and Anthropic API keys, and a GCS bucket) plus a local password in `.env.local`. You do **not** need Cloud Run, Artifact Registry, or IAM service accounts to run on your laptop.

### 1. Create a Neon Postgres database

1. Create a project at [neon.tech](https://neon.tech).
2. On the connection screen, enable **Pooled connection** (the hostname will include `-pooler`).
3. Copy the connection string for `DATABASE_URL` (`api/_lib/jobs.js` also accepts `POSTGRES_URL` or `POSTGRES_PRISMA_URL`).

### 2. Create model API keys

1. Create a Gemini API key at [Google AI Studio](https://aistudio.google.com/apikey) for `GEMINI_API_KEY` (`GOOGLE_API_KEY` is also accepted).
2. Create an Anthropic API key in the [Anthropic console](https://console.anthropic.com) for `ANTHROPIC_API_KEY`.

*(Want to route model calls through OpenRouter instead? See [Route models through OpenRouter](#route-models-through-openrouter) — note that synthesis start still checks for both direct key names.)*

### 3. Create a private GCS bucket for local uploads

Install the [`gcloud` CLI](https://cloud.google.com/sdk/docs/install) in a Google Cloud project with billing enabled, then enable Cloud Storage and create a private bucket:

```bash
gcloud services enable storage.googleapis.com

gcloud storage buckets create gs://my-titlework-bucket \
  --location=US \
  --uniform-bucket-level-access
```

Allow direct browser `PUT` uploads from `http://localhost:8080`. Save this as `cors.json`:

```json
[
  {
    "origin": ["http://localhost:8080"],
    "method": ["PUT"],
    "responseHeader": ["content-type"],
    "maxAgeSeconds": 3600
  }
]
```

Apply the CORS policy and authenticate Application Default Credentials so `api/_lib/storage.js` (`new Storage()`) can mint signed URLs without a key file:

```bash
gcloud storage buckets update gs://my-titlework-bucket --cors-file=cors.json
gcloud auth application-default login
```

### 4. Configure `.env.local`

Copy the placeholder template and fill in your values. Git ignores `.env*` and tracks only `.env.example` — never commit `.env.local`.

```bash
cp .env.example .env.local
```

Minimal `.env.local` for local development:

```bash
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
GCS_BUCKET=my-titlework-bucket
GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
APP_PASSWORD=pick-a-local-password
```

- **Why `APP_PASSWORD` is needed locally:** Server-side abstraction, synthesis, retry, follow-up, and abstract-list endpoints return `401` until `APP_PASSWORD` is set, even outside production. Enter the same password in the browser UI.
- **`INTERNAL_DRAIN_TOKEN` is optional locally:** Only needed in production on the worker service.

### 5. Start the app

```bash
npm run dev
```

Open `http://localhost:8080`.

- `npm run dev` runs `node --env-file=.env.local server.js`. If `.env.local` is missing, Node prints `.env.local: not found` and exits before listening. Override the port with `PORT` (default `8080`).
- **Processing jobs locally — two options:**
  - **Single terminal (browser-driven):** Leave the browser tab open. `WORKFLOW_KICK_ON_START` defaults to on, so the API processes bounded batches of abstraction and synthesis work as the page polls.
  - **Two terminals (background worker):** Run `npm run dev:worker` in a second terminal to drain the queue continuously in the background.
- `npm start` and `npm run start:worker` do not read `.env.local`; use them when environment variables are already injected (such as in Docker or Cloud Run).

---

## Route models through OpenRouter

To route model calls through OpenRouter, set these on both the API and the worker:

```bash
OPENROUTER_API_KEY=your-openrouter-key
MODEL_PROVIDER=openrouter
```

- `shouldUseOpenRouter` in `api/_lib/openrouter-request.js` routes a call through OpenRouter when `MODEL_PROVIDER=openrouter` or when a configured model ID contains `/`. Any other value (or unset) uses direct Gemini and Anthropic routing.
- Model ID mapping: `claude-sonnet-5-5` maps to `anthropic/claude-sonnet-5.5`; other `claude-*` IDs map to `anthropic/<id>`; `gemini-*` IDs map to `google/<id>`; IDs already containing `/` are sent unchanged.
- A missing `OPENROUTER_API_KEY` on an OpenRouter call fails with `OPENROUTER_API_KEY is required when the selected provider is OpenRouter.`
- **Important caveats:**
  - Server abstraction checks `abstractionApiKeyError`, so abstraction can start on OpenRouter without `GEMINI_API_KEY`.
  - **Synthesis start (`synthesisSetupError`) still requires `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and `ANTHROPIC_API_KEY`.** If either is missing, `POST /api/jobs/:id/synthesis/start` returns `503` with `fallback: "browser_synthesis"`.
  - **Release verification (`scripts/verify-release.mjs`)** also checks for the Gemini and Anthropic env var names on both services and does not check `OPENROUTER_API_KEY`.
- Optional headers: `OPENROUTER_REFERER` is sent as `HTTP-Referer` when set; `OPENROUTER_TITLE` is sent as `X-Title` (defaults to `Titlework Analyzer`).

---

## Deploy to Google Cloud Run (optional)

Cloud Run deployment is **optional and off by default**. Pushing a `vX.Y.Z` tag always runs `.github/workflows/release.yml` to validate the tag, run `npm test`, and publish a GitHub Release. The Docker build, Cloud Run deploy, and post-deploy verification steps run **only** when the repository variable `DEPLOY_TO_CLOUD_RUN` is set to `true`. A fork or clone without that variable never touches Google Cloud.

Do not attach Cloud Build or Cloud Run source-deploy triggers to `Main` or `main` — they can deploy a different image than the tag workflow. This repo's default branch is `Main`; CI also listens on `main`.

### 1. Provision Google Cloud resources

Enable the remaining APIs needed for Cloud Run and Workload Identity Federation:

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
```

Create an Artifact Registry Docker repository once:

```bash
gcloud artifacts repositories create YOUR_GAR_REPOSITORY \
  --repository-format=docker \
  --location=YOUR_REGION
```

Create the runtime service account that both Cloud Run services use, and grant it access to your GCS bucket:

```bash
gcloud iam service-accounts create titlework-runtime \
  --display-name="Titlework Cloud Run runtime"

gcloud storage buckets add-iam-policy-binding gs://my-titlework-bucket \
  --member="serviceAccount:titlework-runtime@my-titlework-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

If your API keys live in Secret Manager, also grant this runtime account `roles/secretmanager.secretAccessor`.

Update your GCS CORS policy (`cors.json`) to include your deployed Cloud Run API URL alongside `http://localhost:8080`:

```json
[
  {
    "origin": ["https://YOUR-API-SERVICE-URL", "http://localhost:8080"],
    "method": ["PUT"],
    "responseHeader": ["content-type"],
    "maxAgeSeconds": 3600
  }
]
```

```bash
gcloud storage buckets update gs://my-titlework-bucket --cors-file=cors.json
```

### 2. Authenticate GitHub Actions (Workload Identity Federation)

The release workflow authenticates with Workload Identity Federation (OIDC) instead of storing long-lived Google keys in GitHub:

1. Create a separate **deploy** service account. Grant it Artifact Registry Writer, Cloud Run Admin, `roles/iam.serviceAccountTokenCreator`, and `roles/iam.serviceAccountUser` on the runtime account.
2. Create a Workload Identity Pool and Provider scoped to your GitHub repository.
3. Bind the deploy service account to that repository's principal.

See [google-github-actions/auth](https://github.com/google-github-actions/auth#indirect-wif) for the full Google setup guide.

### 3. Configure GitHub Actions repository variables

Add these under **Settings → Secrets and variables → Actions → Variables** (these are GitHub Actions variables, not Cloud Run runtime secrets):

| Variable | Value |
|---|---|
| `GCP_PROJECT_ID` | Google Cloud project ID. |
| `GCP_REGION` | Region for Cloud Run and Artifact Registry. |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Provider resource name from step 2. |
| `GCP_SERVICE_ACCOUNT` | Deploy service account email. |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | Runtime service account email (optional; omits `--service-account` when empty). |
| `GAR_REPOSITORY` | Artifact Registry repository name. |
| `API_SERVICE` | Cloud Run service name for the API. |
| `WORKER_SERVICE` | Cloud Run service name for the worker. |
| `DEPLOY_TO_CLOUD_RUN` | Set to `true` to enable build, deploy, and verify. Any other value (or unset) publishes the GitHub Release only. |

### 4. Set runtime secrets on both Cloud Run services

Before tagging a release, configure `DATABASE_URL`, `GCS_BUCKET`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and `APP_PASSWORD` directly on **both** Cloud Run services (or mount them from Secret Manager). The workflow never writes or copies secret values into GitHub. `scripts/verify-release.mjs` inspects both services after deploy and fails the release if any of those five groups is missing or blank.

Also set `INTERNAL_DRAIN_TOKEN` on the **worker** service. The release workflow sets `WORKER_DISABLED=true` so the worker can scale-to-zero (`--min-instances 0`) and does not create a Cloud Scheduler job. To trigger scheduled drains against `POST /internal/drain`, see `docs/worker-synthesis-scheduler-runbook.md` and send `INTERNAL_DRAIN_TOKEN` in the `X-Internal-Drain-Token` header.

### 5. Cut a release

1. Bump `"version"` in `package.json` and both root version fields in `package-lock.json` (top-level `"version"` and `packages[""].version`).
2. Add release notes at `docs/releases/vX.Y.Z.md` (in-repo record; the workflow generates GitHub Release notes via `gh release create --generate-notes`).
3. Push the commit to `Main`. Push a lowercase `vX.Y.Z` tag matching `package.json`:

```bash
VERSION="v$(node -p "require('./package.json').version")"
git tag "$VERSION"
git push origin "$VERSION"
```

What `.github/workflows/release.yml` does:

- **Without `DEPLOY_TO_CLOUD_RUN=true`:** Validates the tag, runs `npm test` on Node.js 26.13.0, and creates or updates the GitHub Release. A failed test blocks the release.
- **With `DEPLOY_TO_CLOUD_RUN=true`:** Builds one Docker image, pushes it to Artifact Registry, and runs `scripts/resolve-image-digest.mjs` to resolve the `linux/amd64` digest. Both the worker and API deploy from that same immutable image digest:
  - **Worker:** `npm run start:worker`, `--no-allow-unauthenticated`, `--min-instances 0`, `2Gi` memory, `3600s` timeout, `WORKER_DISABLED=true`.
  - **API:** `--allow-unauthenticated`, `1Gi` memory, `1800s` timeout.
  - `scripts/verify-release.mjs` verifies image digest parity, required env vars, and API `/api/healthz` version before creating or updating the GitHub Release as Latest. A failed deploy or verification blocks the release.

Post-release checks:

- `GET /api/healthz` and `GET /healthz` (and worker `GET /healthz`) return `release.version`.
- The latest ready revisions of API and worker run the same image digest.
- Both services have the database, bucket, model, and `APP_PASSWORD` settings.
- `gh release list --limit 3` shows the new version as Latest.

### 6. Roll back

Rollback API and worker together. Redeploy a previously verified image digest to both services, then confirm both report that digest. Get `PREVIOUS_IMAGE_DIGEST_REF` from `gcloud run revisions describe REVISION --format='value(status.imageDigest)'` or from the release log line `deploying linux/amd64 image` — do not use a mutable tag, which can point to a multi-platform index. Database schema changes only move forward.

```bash
gcloud run deploy WORKER_SERVICE \
  --image PREVIOUS_IMAGE_DIGEST_REF --region YOUR_REGION \
  --command npm --args run,start:worker --no-allow-unauthenticated

gcloud run deploy API_SERVICE \
  --image PREVIOUS_IMAGE_DIGEST_REF --region YOUR_REGION \
  --allow-unauthenticated
```

---

## Environment variables

Set runtime variables on both Cloud Run services unless a row says API only or worker only. Numeric settings fall back to their default when missing or non-finite, and clamp finite out-of-range values into the listed bounds.

**Production** means `NODE_ENV=production` (`Dockerfile` sets this) or a non-empty `K_SERVICE` (Cloud Run sets this).

### Required settings

| Name | Required | If unset |
|---|---|---|
| `DATABASE_URL` | Yes, for durable jobs | `getDatabaseUrl` also reads `POSTGRES_URL` and `POSTGRES_PRISMA_URL`. If all three are empty, job and upload routes fail with `DATABASE_URL or POSTGRES_URL is required`. |
| `GCS_BUCKET` | Yes, for uploads and server abstraction | `GOOGLE_CLOUD_STORAGE_BUCKET` and `STORAGE_BUCKET` are aliases. Storage errors start with `Google Cloud Storage is not configured`. |
| `GEMINI_API_KEY` | Yes, for direct Gemini calls | `GOOGLE_API_KEY` is the alias. A direct Gemini call fails with `GEMINI_API_KEY is required for Gemini models.` |
| `ANTHROPIC_API_KEY` | Yes, for direct Claude calls and for synthesis start | A direct Claude call fails with `ANTHROPIC_API_KEY is required for Claude models.` Synthesis start also fails when this is empty. See [Route models through OpenRouter](#route-models-through-openrouter). |
| `APP_PASSWORD` | Yes for production | Outside production, job routes and `POST /api/analyze` allow the request, but server abstraction, synthesis, follow-up, retry, and the abstract list still return 401 with `APP_PASSWORD is required for server-side abstraction endpoints.` Production returns 401 from the job gate and `/api/analyze` until set. The browser sends it as `x-app-password`. |
| `INTERNAL_DRAIN_TOKEN` | Yes for production, worker only | `POST /internal/drain` compares header `x-internal-drain-token` with `secureCompare`. Production returns 401 `INTERNAL_DRAIN_TOKEN is required.` Outside production, an unset token allows the request with no header. Worker `/healthz` stays unauthenticated. |

### Model settings

| Name | Default / behavior if unset |
|---|---|
| `SYNTHESIS_MODEL` | `claude-sonnet-5-5`. A Gemini ID or Haiku ID is ignored and replaced with the default. |
| `SYNTHESIS_PARTIAL_MODEL` | `gemini-3.1-flash-lite`. Any ID not starting with `gemini-` is ignored (including Claude and Haiku). |
| `ABSTRACT_MODEL` | `gemini-3.1-flash-lite`. A Haiku ID is replaced with the default. |
| `ABSTRACT_ESCALATION_MODEL` | `claude-sonnet-5-5`. Used when a low-confidence or defective abstract is re-read. |
| `GEMINI_THINKING_LEVEL` | Omitted. Accepts `minimal`, `low`, `medium`, `high` for `gemini-3` models, and `low`, `medium`, `high`, `xhigh` for `gemini-4` models. Other values are ignored. |
| `GEMINI_THINKING_BUDGET` | `0` for Gemini models other than `gemini-3` / `gemini-4` (which use `GEMINI_THINKING_LEVEL`). |
| `GEMINI_INCLUDE_THOUGHTS` | Off. `true` adds thought summaries only for `gemini-3` / `gemini-4` models with an accepted `GEMINI_THINKING_LEVEL`. |

### Abstraction settings

| Name | Default / behavior if unset |
|---|---|
| `ABSTRACT_MAX_TOKENS` | `2000`, range 512 to 4096. |
| `ABSTRACT_ESCALATION_MAX_TOKENS` | `4096`, range 512 to 8192. |
| `ABSTRACTION_ESCALATION_ENABLED` | On, unless `false`. The release workflow sets `false` on the API. |
| `ABSTRACTION_PDF_TEXT_FIRST` | On, unless `false`. Allows clean text PDFs to be sent as extracted text. |
| `ABSTRACTION_PDF_TEXT_STRICT` | On, unless `false`. Uses the stricter text-quality floors below. |
| `ABSTRACTION_PDF_TEXT_MIN_CHARS_PER_PAGE` | `80`, or `100` when strict. Range 20 to 2000. |
| `ABSTRACTION_PDF_TEXT_MIN_PRINTABLE_RATIO` | `0.82`, or `0.88` when strict. Range 0.5 to 1. |
| `ABSTRACTION_PDF_TEXT_MAX_BYTES_PER_CHAR` | `800`, or `600` when strict. Range 50 to 5000. |
| `ABSTRACTION_PDF_TEXT_MIN_SPARSE_CHARS_PER_PAGE` | `400`, or `500` when strict. Range 100 to 5000. |
| `ABSTRACTION_PDF_MIN_IMAGE_COVERAGE` | `0.01`, range 0.001 to 1. Minimum embedded-image coverage that marks a PDF page as visual. |
| `ABSTRACTION_PDF_MIN_INVISIBLE_OCR_RATIO` | `0.35`, range 0.05 to 1. Ratio of invisible OCR text above which a PDF routes visually. |
| `ABSTRACTION_PDF_TEXT_MAX_CHARS` | `500000`, range 10000 to 2000000. |
| `ABSTRACTION_BATCH_ENABLED` | On, unless `false`. |
| `ABSTRACTION_BATCH_MAX_DOCS` | `6`, range 1 to 48 (visual PDFs and images always run solo). |
| `ABSTRACTION_BATCH_MAX_PAGE_SPAN` | `32`, range 4 to 120. Wider chunks run alone. |
| `ABSTRACTION_BATCH_LARGE_BYTES` | `2000000`, range 100000 to 8000000. |
| `ABSTRACTION_BATCH_FETCH_MULTIPLIER` | `4`, range 1 to 16. |
| `ABSTRACTION_MAX_ATTEMPTS` | `5`, capped at 12. |
| `ABSTRACTION_SPLITTABLE_PDF_MAX_BYTES` | `25000000`, range 1000000 to 100000000. Floor for the fetch cap of a multi-page (or unranged) PDF chunk. The cap is the max of this value, 70% of (`REQUEST_ENVELOPE_SAFE_BYTES` − 350000), and `STORAGE_MAX_UPLOAD_BYTES` capped at 128000000. Chunks too large for inline delivery split by page range unless sent as extracted text or via Gemini Files API. Single-page PDFs/images fetch up to `GEMINI_FILE_API_MAX_BYTES` when Files API is used, otherwise the 70% inline cap. |
| `GEMINI_FILE_API_ENABLED` | On, unless `false`. |
| `GEMINI_FILE_API_MIN_BYTES` | `1500000`. Files API clamps set values to 100000–50000000; abstraction size estimation uses the raw number (or `1500000` when missing/0). |
| `GEMINI_FILE_API_MAX_BYTES` | `48000000`, range 1000000 to 50000000. |
| `GEMINI_FILE_API_POLL_MS` | `500`, range 100 to 5000. |
| `GEMINI_FILE_API_POLL_MAX_MS` | `60000`, range 1000 to 120000. |
| `GEMINI_PDF_MEDIA_RESOLUTION` | `MEDIA_RESOLUTION_HIGH` on direct Gemini visual, hybrid, and image abstraction calls (omitted on text-only calls). Accepts `low`, `medium`, `high`, full `MEDIA_RESOLUTION_*` names, or `off`/`false` to omit. |
| `ABSTRACTION_UPSTREAM_TIMEOUT_MS` | `240000`, range 10000 to 300000. Falls back to `CLOUD_RUN_UPSTREAM_TIMEOUT_MS`. |

### Synthesis settings

| Name | Default / behavior if unset |
|---|---|
| `SYNTHESIS_MAX_TOKENS` | `8000`, range 256 to 32000. Caps single-pass opinions and follow-ups. Multi-segment merges use `SYNTHESIS_MERGE_MAX_TOKENS`. |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | `5000`, range 512 to 32000. Caps one partial segment. |
| `SYNTHESIS_MERGE_MAX_TOKENS` | `16000`, range 1024 to 32000. Caps multi-segment merges and the larger retry after a truncated single-pass opinion. |
| `SYNTHESIS_CHUNK_SIZE` | Unset uses `floor(SYNTHESIS_MAX_TOKENS / 1000)` (`8` at the 8000-token default); jobs with at least `BULK_JOB_MIN_ABSTRACTS` abstracts use at least `BULK_SYNTHESIS_CHUNK_SIZE`. When set, clamped to 1–250 (bulk jobs still raise to bulk size if larger). |
| `BULK_SYNTHESIS_CHUNK_SIZE` | `200`, range 10 to 250. |
| `BULK_JOB_MIN_ABSTRACTS` | `100`, range 2 to 400. |
| `SYNTHESIS_BATCH_LIMIT` | `4` (never above `WORKFLOW_BATCH_LIMIT`), range 1 to 16. |
| `SYNTHESIS_CONCURRENCY` | `WORKFLOW_CONCURRENCY` if set, else `4`. Range 1 to 16. |
| `SYNTHESIS_MERGE_CONCURRENCY` | `WORKFLOW_CONCURRENCY` if set, else `4`. Range 1 to 8. |
| `SYNTHESIS_MAX_ATTEMPTS` | `3`, range 1 to 10. |
| `SYNTHESIS_FOLLOWUP_HISTORY_TURNS` | `4`, range 0 to 20. |
| `SYNTHESIS_STREAM_ENABLED` | Off. `true` streams the final merge to `GET /api/jobs/:id/synthesis/preview`; the opinion is persisted after the stream ends. |
| `SYNTHESIS_COMPACTION_ENABLED` | On, unless `false`. Compacts large merge inputs with Gemini before the Sonnet merge. |
| `SYNTHESIS_COMPACTION_MIN_SEGMENTS` | `6`, range 2 to 64. |
| `SYNTHESIS_COMPACTION_MIN_MERGE_TOKENS` | `40000`, range 1024 to 500000. |
| `SYNTHESIS_LARGE_JOB_MULTI_SEGMENT` | Off. `true` forces multi-segment Gemini synthesis at or above `BULK_JOB_MIN_ABSTRACTS`. |
| `SYNTHESIS_FORCE_SINGLE_PASS` | Off. `true` disables forced multi-segment synthesis. |
| `SYNTHESIS_REPAIR_ENABLED` | On, unless `false`. |
| `SYNTHESIS_UPSTREAM_TIMEOUT_MS` | `240000`, range 10000 to 300000. Falls back to `CLOUD_RUN_UPSTREAM_TIMEOUT_MS`. Segment lease renewals use the greater of the claim lease and this timeout + 60s. |
| `SYNTHESIS_MERGE_LEASE_MS` | Used only if `processSynthesisJob` omits `mergeLeaseMs` (worker and API kick pass `WORKFLOW_LEASE_MS`). Fallback: `WORKFLOW_LEASE_MS` or synthesis timeout + 60s, clamped 5000–600000. |
| `SYNTHESIS_STALE_LEASE_MS` | Used only if caller omits `staleLeaseMs` (worker and API kick pass `WORKFLOW_STALE_LEASE_MS`). Fallback: `WORKFLOW_STALE_LEASE_MS` or merge-lease default + 60s, clamped 5000–600000. |
| `ANTHROPIC_PROMPT_CACHE` | On, unless `false`. |
| `SYNTHESIS_MERGE_CACHE_MIN_TOKENS` | `1024` (minimum 256). |

### Worker, limits, and OCR lab settings

| Name | Default / behavior if unset |
|---|---|
| `PORT` | `8080` for both `server.js` and `worker.js`. |
| `WORKER_DISABLED` | Off. Worker only. `true`, `1`, or `yes` keeps the health server up and skips the queue loop. Release workflow sets `true`. |
| `WORKER_POLL_IDLE_MS` | `2000`, range 100 to 60000. Falls back to `WORKER_POLL_INTERVAL_MS` if set. |
| `WORKER_POLL_ACTIVE_MS` | `0`, range 0 to 5000. |
| `WORKER_DRAIN_BUDGET_MS` | `1500000`, range 10000 to 3300000. |
| `WORKER_STAGE_LOGS` | Off. `true` logs abstraction stages. |
| `WORKFLOW_DRIVER` | `inprocess` (the only active driver; `inngest` returns 503 even if `INNGEST_*` keys are set; any other value is rejected). |
| `WORKFLOW_KICK_ON_START` | On, unless `false`. API only. |
| `WORKFLOW_KICK_BUDGET_MS` | `50000`, range 5000 to 55000. API only. |
| `WORKFLOW_BATCH_LIMIT` | `12`, range 1 to 64. |
| `WORKFLOW_CONCURRENCY` | `4`, range 1 to 16. |
| `WORKFLOW_BUDGET_MS` | `1200000`, range 1000 to 3300000. |
| `WORKFLOW_LEASE_MS` | Queue upstream timeout (`ABSTRACTION_UPSTREAM_TIMEOUT_MS` → `SYNTHESIS_UPSTREAM_TIMEOUT_MS` → `CLOUD_RUN_UPSTREAM_TIMEOUT_MS` → `240000`) + 60s, clamped 5000–600000. |
| `WORKFLOW_STALE_LEASE_MS` | `WORKFLOW_LEASE_MS` + 60s, clamped 5000–600000. |
| `ANALYZE_MAX_REQUEST_BYTES` | `20000000`, range 1 to 32000000. Falls back to `CLOUD_RUN_MAX_REQUEST_BYTES`. API only. |
| `ANALYZE_UPSTREAM_TIMEOUT_MS` | `240000`, range 10000 to 300000. API only. |
| `CLOUD_RUN_MAX_BODY_BYTES` | `26214400` (caps HTTP adapter request bodies; non-positive uses default). |
| `STORAGE_MAX_UPLOAD_BYTES` | `104857600` (`GCS_MAX_UPLOAD_BYTES` alias), range 1 to 1073741824. |
| `GCS_SIGNED_URL_TTL_MS` | `900000`, range 60000 to 3600000. |
| `ANALYZE_RATE_LIMIT_MAX` | `300` req/min for `POST /api/analyze`, clamped 10 to 600 (`0` treated as unset). |
| `REQUEST_ENVELOPE_SAFE_BYTES` | `18000000` for abstraction/batching; `12000000` for synthesis. Both clamp 100000–20000000. |
| `REQUEST_OVERHEAD_BYTES` | `350000`, range 0 to 1000000. Copied onto synthesis config (unused); abstraction subtracts a fixed `350000`. |
| `VERIFY_GCS_OBJECTS` | Off. `true` verifies the GCS object exists during chunk finalization. |
| `OCR_COMPARE_ENABLED` | Off. `POST /api/ocr-compare` returns 404 unless `true`. In production, also returns 503 if `APP_PASSWORD` is unset; locally with `APP_PASSWORD` unset, no password is required. |
| `OCR_COMPARE_MAX_TOKENS` | `16000`, integer range 512 to 32000. |
| `OCR_COMPARE_PROVIDER` | Unset or `direct` calls Gemini and Anthropic directly; `openrouter` routes all three lab models through OpenRouter with `OPENROUTER_API_KEY` (see `docs/ocr-comparison-lab.md`). Other values return 503. |
| `OCR_COMPARE_OPENROUTER_MODELS` | Optional (openrouter mode only): comma-separated list of 3 OpenRouter model slugs to override the default lab columns. |
| `GEMINI_API_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta`. |
| `GEMINI_UPLOAD_BASE_URL` | `https://generativelanguage.googleapis.com/upload`. |

### Values set by the release workflow

When `DEPLOY_TO_CLOUD_RUN=true`, `.github/workflows/release.yml` passes these via `--update-env-vars` (on the API unless noted), overriding code defaults:

| Name | Value |
|---|---|
| `RELEASE_VERSION` | Release tag (health falls back to `v` + `package.json` version). |
| `GIT_SHA` | Deployed commit (`COMMIT_SHA` alias also read by `getRuntimeInfo`). |
| `IMAGE_DIGEST` | Container image digest. |
| `WORKER_DISABLED` | `true` on the worker. |
| `SYNTHESIS_CONCURRENCY` | `8` on the API. |
| `SYNTHESIS_BATCH_LIMIT` | `8` on the API. |
| `BULK_JOB_MIN_ABSTRACTS` | `50` on the API. |
| `SYNTHESIS_CHUNK_SIZE` | `50` on the API. |
| `BULK_SYNTHESIS_CHUNK_SIZE` | `50` on the API. |
| `SYNTHESIS_MAX_TOKENS` | `8000` on the API (caps single-pass opinions and follow-ups; `SYNTHESIS_MERGE_MAX_TOKENS` stays at `16000`). |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | `5000` on the API. |
| `SYNTHESIS_STREAM_ENABLED` | `true` on the API. |
| `SYNTHESIS_COMPACTION_ENABLED` | `true` on the API. |
| `SYNTHESIS_LARGE_JOB_MULTI_SEGMENT` | `true` on the API. |
| `ABSTRACTION_ESCALATION_ENABLED` | `false` on the API. |

*Other script-only variables:* Cloud Run automatically sets `K_REVISION` (alias `CLOUD_RUN_REVISION`). `scripts/verify-release.mjs` accepts env fallbacks (`GCP_PROJECT_ID`, `GCP_REGION`, `API_SERVICE`, `WORKER_SERVICE`, `RELEASE_VERSION`, `GITHUB_REF_NAME`, `GITHUB_SHA`, `IMAGE_DIGEST`, `API_URL`) when CLI flags are omitted. Offline comparison scripts (`scripts/compare-final-opinion.mjs`, `scripts/compare-ocr-models.mjs`) read `DATABASE_URL`/`POSTGRES_URL`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`, `GEMINI_THINKING_LEVEL`, and `GEMINI_THINKING_BUDGET`.

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `.env.local: not found` on `npm run dev` | Run `cp .env.example .env.local` and fill in your credentials, or use `npm start` if variables are already in your shell environment. |
| `401` on abstraction or synthesis routes | `APP_PASSWORD` is unset or does not match what you entered in the UI. It is required for server-side abstraction and synthesis even locally. |
| `Google Cloud Storage is not configured` | `GCS_BUCKET` is empty on that service, ADC is not logged in locally (`gcloud auth application-default login`), or the Cloud Run runtime service account lacks `roles/storage.objectAdmin`. |
| `DATABASE_URL or POSTGRES_URL is required` | None of `DATABASE_URL`, `POSTGRES_URL`, or `POSTGRES_PRISMA_URL` is set. |
| Browser uploads fail with CORS errors | Check your GCS CORS policy (`cors.json`). It must allow `PUT` and `content-type` from both your page origin (`http://localhost:8080` or your Cloud Run URL). |
| Jobs stay `queued` or `abstracting` | Confirm the worker is running and can reach Neon, or if `WORKER_DISABLED=true` (or running only `npm run dev`), keep the browser tab open so the API kick drives batches. |
| Model timeouts or rate limits | Lower `WORKFLOW_CONCURRENCY` or `WORKFLOW_BATCH_LIMIT`, or raise your provider quota. Retryable failures move to `retry_wait` and resume automatically. |

---

## Cost and spend controls

Each document chunk becomes an abstraction call unless worker batching packs multiple text-extracted chunks into one request. Partial synthesis runs one Gemini call per segment, and the final merge is a single Claude Sonnet 5.5 call. The server does not use Anthropic or Gemini async batch-job APIs; queue progress is tracked directly in Neon.

Defaults and flags that reduce token spend:

- Keep `ABSTRACTION_PDF_TEXT_FIRST` on (default) so clean text PDFs skip visual input.
- Keep `ABSTRACTION_BATCH_ENABLED` on (default) so small text chunks share a request.
- Keep `GEMINI_FILE_API_ENABLED` on (default) so large visual files upload via the Files API instead of inline base64.
- Tune output caps: `ABSTRACT_MAX_TOKENS`, `SYNTHESIS_PARTIAL_MAX_TOKENS`, `SYNTHESIS_MAX_TOKENS`, and `SYNTHESIS_MERGE_MAX_TOKENS`.
- Set `ABSTRACTION_ESCALATION_ENABLED=false` to skip Sonnet escalation re-reads (the release workflow sets this on the API).

---

## Security

Report vulnerabilities as described in `SECURITY.md`.

- **Password handling:** `APP_PASSWORD` is held only in the page's in-memory `appPassword` variable for the active tab. On load, the page clears any saved `localStorage` or `sessionStorage` copy and writes no cookies.
- **Worker drain gate:** `POST /internal/drain` verifies `x-internal-drain-token` using `secureCompare` (failing closed in production when unset) on top of Cloud Run IAM (`--no-allow-unauthenticated`). Worker `/healthz` stays unauthenticated.
- **Rate limiting & lockout:** `POST /api/analyze` allows `ANALYZE_RATE_LIMIT_MAX` requests/min/IP; job routes and `POST /api/blob/upload` allow 1,500/min/IP. Both lock an IP for 60 seconds (`429`) after 5 failed passwords. Client IP uses the rightmost `X-Forwarded-For` hop only on Cloud Run (non-blank `K_SERVICE`); elsewhere it uses the socket address. Limiter state is stored in GCS when configured (failing with `503` on store error) or in memory otherwise.
- **Private files & raw-byte budget:** Source files remain in a private GCS bucket. Abstraction admits at most 128 MB (`128,000,000` bytes) of raw source reservations per processing wave; reads stop at their admitted ceiling and the read cache clears at wave end. (This is not a process-wide memory ceiling — leave headroom for parsing and concurrency.)
- **Metadata validation:** Job metadata routes reject base64 payloads, raw documents, abstracts, CSV text, and title opinions.
- **Browser CSP:** `public/index.html` enforces `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'` and `worker-src 'self' blob:` for the inline app and locally served `jsPDF`, `pdf-lib`, and `pdfjs-dist` builds. `connect-src` allows only `'self'`, `https://storage.googleapis.com`, and `https://*.storage.googleapis.com`.
- **Smoke server:** `node test/smoke-server.js` reuses the main server's path-containment, password, and body-size guards and binds only `127.0.0.1:3456`.

---

## Repository layout

```text
api/
  _lib/                 queue, jobs/schema, storage, abstraction, synthesis, model clients
  analyze.js            direct browser-fallback analysis route
  blob/upload.js        signed GCS upload URL minting
  jobs.js               job creation & listing
  jobs/[...path].js     chunk, abstraction, synthesis, preview, retry & follow-up routes
  ocr-compare.js        optional OCR comparison lab endpoint
public/
  index.html            single-page Mineral Ownership Builder UI
  ocr-accuracy.js       client-side abstract quality checks
  pdf-raster.js         high-DPI browser PDF page renderer (pdfjs-dist)
  ocr-compare.*         optional OCR comparison lab UI
scripts/                release verification, digest resolution, UI audit, model & PDF test scripts
test/                   unit, integration, security, and release tests
docs/                   architecture notes, runbooks, and release notes
.github/workflows/      test.yml, release.yml, secret-scan.yml
server.js               web & API HTTP server
worker.js               background queue worker
Dockerfile              production container image (Node 26.13.0)
package.json
.env.example
SECURITY.md
LICENSE
```

---

## License

MIT. See `LICENSE`.
