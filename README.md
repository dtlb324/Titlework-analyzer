# Titlework Analyzer

Titlework Analyzer is a web app for oil and gas landmen. It reads courthouse PDFs and images, builds a chain of title, and drafts a mineral ownership opinion. The page heading is Mineral Ownership Builder. The browser tab title is Mineral Title Analyzer. The npm package name is `title-analyzer`.

`gemini-3.1-flash-lite` abstracts each document. On a large job it also writes the partial segment summaries. `claude-sonnet-5-5` writes the final opinion and answers follow-up questions.

The page calls the result an analytical aid, not a formal title opinion. Check it against the source documents before a drilling, leasing, or division order decision.

`package.json` accepts Node.js 26.x. There is no `.nvmrc`. CI and `Dockerfile` pin Node.js 26.13.0.

## Clone and test

```bash
git clone https://github.com/dtlb324/Titlework-analyzer.git
cd Titlework-analyzer
npm ci
npm test
```

`npm test` runs the files named in the `test` script in `package.json`, in that order, and stops at the first failure. It does not need API keys, a database, or `.env.local`. There is no coverage script and no `npm run build`.

`.github/workflows/test.yml` runs `npm ci`, `npm test`, and `docker build -t titlework-analyzer:test .` on Node.js 26.13.0. It runs for pull requests and for pushes to `Main` and `main`. `.github/workflows/secret-scan.yml` runs gitleaks on those same events.

`node test/smoke-server.js` listens on port 3456. `npm test` does not start it.

## Run locally

Copy the placeholder file and fill in real values. Do not commit `.env.local`. Git ignores `.env*` and keeps `.env.example`.

```bash
cp .env.example .env.local
```

`.env.example` names `DATABASE_URL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `GCS_BUCKET`, `APP_PASSWORD`, and `INTERNAL_DRAIN_TOKEN`. The tables below say which ones you can skip on a laptop.

```bash
npm run dev
```

Open `http://localhost:8080`. `npm run dev` is `node --env-file=.env.local server.js`. If `.env.local` is missing, Node prints `.env.local: not found` and exits before the server listens. The listen port is `PORT`, or 8080 when `PORT` is unset.

To process the queue in the background, run this in a second terminal.

```bash
npm run dev:worker
```

`npm start` and `npm run start:worker` do not load a file. Use them when the variables are already in the process environment. The container command is one of those two scripts.

`api/_lib/storage.js` calls `new Storage()` with no key file. On a laptop, sign in once so signed upload URLs work.

```bash
gcloud auth application-default login
```

If you only run the API, leave the browser tab open. `WORKFLOW_KICK_ON_START` defaults to on, and the API then runs a bounded batch of abstraction or synthesis work.

The release workflow sets `WORKER_DISABLED=true` on the worker so the loop can scale-to-zero. It does not create a Cloud Scheduler job. The optional scheduler is `docs/worker-synthesis-scheduler-runbook.md`. Set `INTERNAL_DRAIN_TOKEN` on the worker before that scheduler calls `POST /internal/drain`.

## How a job moves

`server.js` serves `public/index.html` and the `/api` routes. `worker.js` claims abstraction and synthesis rows from Neon. The browser creates a job, PUTs file bytes to a signed GCS URL, then starts abstraction and synthesis.

`api/_lib/jobs.js` creates the tables on first use. There is no migration directory. The tables are `analysis_jobs`, `job_documents`, `document_chunks`, `document_abstracts`, `synthesis_segments`, `job_results`, and `followup_messages`.

## Create the database, the keys, and the bucket

A local job on the direct providers needs `DATABASE_URL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and `GCS_BUCKET`. Server abstraction and synthesis also need `APP_PASSWORD`. The service account and the GitHub variables below are only for a hosted deploy.

### Neon Postgres

1. Create a project at [neon.tech](https://neon.tech).
2. On the connection screen, turn on **Pooled connection**. The host then contains `-pooler`.
3. Copy that string into `DATABASE_URL`.

`getDatabaseUrl` in `api/_lib/jobs.js` also accepts `POSTGRES_URL` and `POSTGRES_PRISMA_URL`.

### Model keys

1. Create a Gemini key at [Google AI Studio](https://aistudio.google.com/apikey). Put it in `GEMINI_API_KEY`. `GOOGLE_API_KEY` is the other name the Gemini client reads.
2. Create an Anthropic key in the [Anthropic console](https://console.anthropic.com). Put it in `ANTHROPIC_API_KEY`.

Direct calls use those keys. The OpenRouter section says what still has to be set when model calls go through OpenRouter.

### Google Cloud

Install the `gcloud` CLI in a project with billing. Enable the APIs the deploy uses.

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
```

Create a private bucket. The bucket name is `GCS_BUCKET`.

```bash
gcloud storage buckets create gs://my-titlework-bucket \
  --location=US \
  --uniform-bucket-level-access
```

Allow browser uploads. Save this as `cors.json`. After the API is deployed, replace the first origin with the Cloud Run API URL.

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

Create the runtime service account the Cloud Run services use.

```bash
gcloud iam service-accounts create titlework-runtime \
  --display-name="Titlework Cloud Run runtime"

gcloud storage buckets add-iam-policy-binding gs://my-titlework-bucket \
  --member="serviceAccount:titlework-runtime@my-titlework-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

If the API keys live in Secret Manager, also grant this account `roles/secretmanager.secretAccessor`.

## Deploy

A normal release is a git tag. `.github/workflows/release.yml` builds one image and deploys it. You do not run `gcloud run deploy` yourself for that release.

Do not attach Cloud Build or Cloud Run source-deploy triggers to `Main` or `main`. They can deploy a different image than the tag workflow. This repo's default branch is `Main`. CI also listens on `main`.

### Authenticate GitHub Actions

The workflow signs in with Workload Identity Federation. It does not store a long-lived Google key in GitHub. Set this up once.

1. Create a deploy service account, separate from the runtime account. Grant it Artifact Registry writer, Cloud Run admin, `roles/iam.serviceAccountTokenCreator`, and `roles/iam.serviceAccountUser` on the runtime account.
2. Create a Workload Identity pool and a provider scoped to this GitHub repository.
3. Bind the deploy service account to that repository's principal.

Google documents the pool setup in [google-github-actions/auth](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation).

### Set repository variables

Create the Artifact Registry repository once.

```bash
gcloud artifacts repositories create YOUR_GAR_REPOSITORY \
  --repository-format=docker \
  --location=YOUR_REGION
```

Add these under **Settings**, **Secrets and variables**, **Actions**, **Variables**. They are GitHub Actions variables. They are not the Cloud Run environment.

| Variable | Value |
|---|---|
| `GCP_PROJECT_ID` | Google Cloud project id. |
| `GCP_REGION` | Region for Cloud Run and Artifact Registry. |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Provider resource name from the previous step. |
| `GCP_SERVICE_ACCOUNT` | Deploy service account email. |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | Runtime service account email. Optional. The workflow omits `--service-account` when this is empty. |
| `GAR_REPOSITORY` | Artifact Registry repository name. |
| `API_SERVICE` | Cloud Run service name for the API. |
| `WORKER_SERVICE` | Cloud Run service name for the worker. |

Set `DATABASE_URL`, `GCS_BUCKET`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and `APP_PASSWORD` on both Cloud Run services before you tag a release. The workflow does not write those values. `scripts/verify-release.mjs` reads the deployed service env names after deploy and fails the release if any of those five groups is missing or blank. Accepted aliases are in the required settings table. The workflow never copies the secret values into GitHub.

Set `INTERNAL_DRAIN_TOKEN` on the worker yourself. The workflow does not set it.

### Cut a release

Set `version` in `package.json` and the same version in both root fields of `package-lock.json`. The fields are the top-level `"version"` and `packages[""].version`. Add `docs/releases/vX.Y.Z.md` for the in-repo note. The workflow does not read that file. It creates the GitHub Release with `gh release create --generate-notes`.

Push the commit to `Main`. Push a lowercase `vX.Y.Z` tag that matches `package.json`.

```bash
VERSION="v$(node -p "require('./package.json').version")"
git tag "$VERSION"
git push origin "$VERSION"
```

The workflow runs the tests on Node.js 26.13.0, builds one Docker image, and pushes it to Artifact Registry. `scripts/resolve-image-digest.mjs` selects the linux/amd64 image from the pushed manifest. The worker deploy and the API deploy use that same immutable image digest. The worker command is `npm run start:worker`. That deploy also passes `--no-allow-unauthenticated`, `--min-instances 0`, 2Gi of memory, and a 3600 second timeout. The API allows unauthenticated HTTP, uses 1Gi of memory, and has a 1800 second timeout. `scripts/verify-release.mjs` then checks both services. The last job creates or updates the GitHub Release and requires it to be Latest.

After a release, check these points.

- `GET /api/healthz` and `GET /healthz` return `release.version`. The worker's `GET /healthz` returns it too.
- The latest ready revisions of the API and the worker use the same image digest.
- Both services have the database, bucket, model, and `APP_PASSWORD` settings.
- `gh release list --limit 3` shows the new version as Latest.

### Roll back

Rollback API and worker together. Redeploy one previously verified image digest to both services, then confirm both report that digest. Take `PREVIOUS_IMAGE_DIGEST_REF` from `gcloud run revisions describe REVISION --format='value(status.imageDigest)'` or from the release log line `deploying linux/amd64 image`. Do not take it from the tag. The tag can point at an image index. Database changes only move forward.

```bash
gcloud run deploy WORKER_SERVICE \
  --image PREVIOUS_IMAGE_DIGEST_REF --region YOUR_REGION \
  --command npm --args run,start:worker --no-allow-unauthenticated

gcloud run deploy API_SERVICE \
  --image PREVIOUS_IMAGE_DIGEST_REF --region YOUR_REGION \
  --allow-unauthenticated
```

## Route models through OpenRouter

Set these on the API and the worker when you want one key for the model calls.

```bash
OPENROUTER_API_KEY=your-openrouter-key
MODEL_PROVIDER=openrouter
```

`shouldUseOpenRouter` in `api/_lib/openrouter-request.js` sends a call through OpenRouter when `MODEL_PROVIDER` is `openrouter`, or when the model id contains `/`. Any other value of `MODEL_PROVIDER`, or none, keeps direct Gemini and Anthropic routing. A missing `OPENROUTER_API_KEY` on an OpenRouter call fails with `OPENROUTER_API_KEY is required when the selected provider is OpenRouter.`

`claude-sonnet-5-5` maps to `anthropic/claude-sonnet-5.5`. Other `claude-*` ids map to `anthropic/` plus the id. `gemini-*` ids map to `google/` plus the id. An id that already contains `/` is sent unchanged.

Server abstraction uses that routing. `serverAbstractionSetupError` asks `abstractionApiKeyError` for the abstract model, so an OpenRouter setup can start abstraction without `GEMINI_API_KEY`.

Synthesis start does not use that shortcut. `synthesisSetupError` still requires `GEMINI_API_KEY` or `GOOGLE_API_KEY`, and it still requires `ANTHROPIC_API_KEY`. If either check fails, `POST /api/jobs/:id/synthesis/start` returns 503 and `fallback` is `browser_synthesis`. Release verification also still requires the Gemini and Anthropic names on both services. It does not look for `OPENROUTER_API_KEY`.

`OPENROUTER_REFERER` is sent as `HTTP-Referer` when set. `OPENROUTER_TITLE` is sent as `X-Title`. If unset, the title is `Titlework Analyzer`.

## Environment variables

Set runtime variables on both Cloud Run services unless the row says API only or worker only. Numeric settings below use the default when the value is missing or not a finite number. A finite number outside the listed range is clamped into that range.

Production means `NODE_ENV` is `production`, or `K_SERVICE` is non-empty. `Dockerfile` sets `NODE_ENV=production`. Cloud Run sets `K_SERVICE`.

### Required settings

| Name | Required | If unset |
|---|---|---|
| `DATABASE_URL` | Yes, for durable jobs | `getDatabaseUrl` also reads `POSTGRES_URL` and `POSTGRES_PRISMA_URL`. If all three are empty, job and upload routes fail with `DATABASE_URL or POSTGRES_URL is required`. |
| `GCS_BUCKET` | Yes, for uploads and server abstraction | `GOOGLE_CLOUD_STORAGE_BUCKET` and `STORAGE_BUCKET` are aliases. Storage errors start with `Google Cloud Storage is not configured`. |
| `GEMINI_API_KEY` | Yes, for direct Gemini calls | `GOOGLE_API_KEY` is the alias. A direct Gemini call fails with `GEMINI_API_KEY is required for Gemini models.` |
| `ANTHROPIC_API_KEY` | Yes, for direct Claude calls and for synthesis start | A direct Claude call fails with `ANTHROPIC_API_KEY is required for Claude models.` Synthesis start also fails when this is empty. See the OpenRouter section. |
| `APP_PASSWORD` | Yes for production | Outside production, job routes and `POST /api/analyze` allow the request. Server abstraction, synthesis, follow-up, retry, and the abstract list still return 401 with `APP_PASSWORD is required for server-side abstraction endpoints.` Production returns 401 from the job gate and from `/api/analyze` until it is set. The browser sends it as `x-app-password`. |
| `INTERNAL_DRAIN_TOKEN` | Yes for production, worker only | `POST /internal/drain` compares header `x-internal-drain-token` with `secureCompare`. Production returns 401 `INTERNAL_DRAIN_TOKEN is required.` Outside production, an unset token allows the request with no header. `/healthz` on the worker stays unauthenticated. |

### Model settings

| Name | If unset |
|---|---|
| `SYNTHESIS_MODEL` | `claude-sonnet-5-5`. A Gemini id or a Haiku id is ignored and the default is used. Other ids are kept. |
| `SYNTHESIS_PARTIAL_MODEL` | `gemini-3.1-flash-lite`. Any id that does not start with `gemini-` is ignored, including Claude and Haiku. |
| `ABSTRACT_MODEL` | `gemini-3.1-flash-lite`. A Haiku id is replaced with that default. Other ids are kept. |
| `ABSTRACT_ESCALATION_MODEL` | `claude-sonnet-5-5`. Used when a low-confidence abstract is re-read. |
| `GEMINI_THINKING_LEVEL` | Omitted. Accepted values are `minimal`, `low`, `medium`, and `high`, and only for a `gemini-3` model. Any other value is ignored. |
| `GEMINI_THINKING_BUDGET` | `0` for a Gemini model that is not a `gemini-3` model. Gemini 3 uses the level above instead. |
| `GEMINI_INCLUDE_THOUGHTS` | Off. `true` asks Gemini 3 for thought summaries. |

### Abstraction settings

| Name | If unset |
|---|---|
| `ABSTRACT_MAX_TOKENS` | `2000`, range 512 to 4096. |
| `ABSTRACT_ESCALATION_MAX_TOKENS` | `4096`, range 512 to 8192. |
| `ABSTRACTION_ESCALATION_ENABLED` | On, unless the value is `false`. The release workflow sets `false` on the API. |
| `ABSTRACTION_PDF_TEXT_FIRST` | On, unless the value is `false`. A text PDF can be sent as extracted text. |
| `ABSTRACTION_PDF_TEXT_STRICT` | Off. `true` uses the stricter text-quality floors. |
| `ABSTRACTION_PDF_TEXT_MIN_CHARS_PER_PAGE` | `80`, or `100` when strict. Range 20 to 2000. |
| `ABSTRACTION_PDF_TEXT_MIN_PRINTABLE_RATIO` | `0.82`, or `0.88` when strict. Range 0.5 to 1. |
| `ABSTRACTION_PDF_TEXT_MAX_BYTES_PER_CHAR` | `800`, or `600` when strict. Range 50 to 5000. |
| `ABSTRACTION_PDF_TEXT_MIN_SPARSE_CHARS_PER_PAGE` | `400`, or `500` when strict. Range 100 to 5000. |
| `ABSTRACTION_PDF_TEXT_MAX_CHARS` | `500000`, range 10000 to 2000000. |
| `ABSTRACTION_BATCH_ENABLED` | On, unless the value is `false`. |
| `ABSTRACTION_BATCH_MAX_DOCS` | `24`, range 1 to 48. |
| `ABSTRACTION_BATCH_MAX_PAGE_SPAN` | `32`, range 4 to 120. A wider chunk runs alone. |
| `ABSTRACTION_BATCH_LARGE_BYTES` | `2000000`, range 100000 to 8000000. |
| `ABSTRACTION_BATCH_FETCH_MULTIPLIER` | `4`, range 1 to 16. |
| `ABSTRACTION_MAX_ATTEMPTS` | `5`, capped at 12. |
| `ABSTRACTION_SPLITTABLE_PDF_MAX_BYTES` | `25000000`, range 1000000 to 100000000. |
| `GEMINI_FILE_API_ENABLED` | On, unless the value is `false`. |
| `GEMINI_FILE_API_MIN_BYTES` | `1500000`, range 100000 to 50000000. |
| `GEMINI_FILE_API_MAX_BYTES` | `48000000`, range 1000000 to 50000000. |
| `GEMINI_FILE_API_POLL_MS` | `500`, range 100 to 5000. |
| `GEMINI_FILE_API_POLL_MAX_MS` | `60000`, range 1000 to 120000. |
| `ABSTRACTION_UPSTREAM_TIMEOUT_MS` | `240000`, range 10000 to 300000. `CLOUD_RUN_UPSTREAM_TIMEOUT_MS` is the fallback. |

### Synthesis settings

| Name | If unset |
|---|---|
| `SYNTHESIS_MAX_TOKENS` | `8000`, range 256 to 32000. Caps the final merge. |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | `5000`, range 512 to 32000. Caps one partial segment. |
| `SYNTHESIS_MERGE_MAX_TOKENS` | `16000`, range 1024 to 32000. |
| `SYNTHESIS_CHUNK_SIZE` | The planner does not use 120 unless this variable is set. With it unset, `effectiveSynthesisChunkSize` uses `floor(SYNTHESIS_MAX_TOKENS / 1000)`. At the 8000 token default, that is 8. A job with at least `BULK_JOB_MIN_ABSTRACTS` abstracts then uses at least `BULK_SYNTHESIS_CHUNK_SIZE`. When this variable is set, the value is clamped from 1 to 250, and a bulk job still raises it to the bulk size when that size is larger. |
| `BULK_SYNTHESIS_CHUNK_SIZE` | `200`, range 10 to 250. |
| `BULK_JOB_MIN_ABSTRACTS` | `100`, range 2 to 400. |
| `SYNTHESIS_BATCH_LIMIT` | `4`, and never above `WORKFLOW_BATCH_LIMIT`. Range 1 to 16. |
| `SYNTHESIS_CONCURRENCY` | `WORKFLOW_CONCURRENCY` when that is set, otherwise `4`. Range 1 to 16. |
| `SYNTHESIS_MERGE_CONCURRENCY` | `WORKFLOW_CONCURRENCY` when that is set, otherwise `4`. Range 1 to 8. |
| `SYNTHESIS_MAX_ATTEMPTS` | `3`, range 1 to 10. |
| `SYNTHESIS_FOLLOWUP_HISTORY_TURNS` | `4`, range 0 to 20. |
| `SYNTHESIS_STREAM_ENABLED` | Off. `true` streams the final merge to `GET /api/jobs/:id/synthesis/preview`. The opinion is saved after the stream ends. |
| `SYNTHESIS_COMPACTION_ENABLED` | On, unless the value is `false`. Large merge input is compacted with Gemini before the Sonnet merge. |
| `SYNTHESIS_COMPACTION_MIN_SEGMENTS` | `6`, range 2 to 64. |
| `SYNTHESIS_COMPACTION_MIN_MERGE_TOKENS` | `40000`, range 1024 to 500000. |
| `SYNTHESIS_LARGE_JOB_MULTI_SEGMENT` | Off. `true` forces multi-segment Gemini synthesis at or above `BULK_JOB_MIN_ABSTRACTS`. |
| `SYNTHESIS_FORCE_SINGLE_PASS` | Off. `true` turns that forcing off. |
| `SYNTHESIS_REPAIR_ENABLED` | On, unless the value is `false`. |
| `SYNTHESIS_UPSTREAM_TIMEOUT_MS` | `240000`, range 10000 to 300000. `CLOUD_RUN_UPSTREAM_TIMEOUT_MS` is the fallback. |
| `SYNTHESIS_MERGE_LEASE_MS` | Falls back to `WORKFLOW_LEASE_MS` when that is set. Otherwise the synthesis upstream timeout plus 60 seconds, clamped from 5000 to 600000. |
| `SYNTHESIS_STALE_LEASE_MS` | Falls back to `WORKFLOW_STALE_LEASE_MS` when that is set. Otherwise the merge lease plus 60 seconds, clamped from 5000 to 600000. |
| `ANTHROPIC_PROMPT_CACHE` | On, unless the value is `false`. |
| `SYNTHESIS_MERGE_CACHE_MIN_TOKENS` | `1024`, and at least 256. |

### Worker and limits

| Name | If unset |
|---|---|
| `PORT` | `8080` for `server.js` and for `worker.js`. |
| `WORKER_DISABLED` | Off. Worker only. `true`, `1`, and `yes` leave the health server up and skip the queue loop. The release workflow sets `true`. |
| `WORKER_POLL_IDLE_MS` | `2000`, range 100 to 60000. If this is unset, `WORKER_POLL_INTERVAL_MS` is the idle wait. |
| `WORKER_POLL_ACTIVE_MS` | `0`, range 0 to 5000. |
| `WORKER_DRAIN_BUDGET_MS` | `1500000`, range 10000 to 3300000. |
| `WORKER_STAGE_LOGS` | Off. `true` logs abstraction stages. |
| `WORKFLOW_DRIVER` | `inprocess`. That is the only driver that runs. `inngest` returns 503 and says it is not implemented, even when `INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` are set. Any other value is rejected. |
| `WORKFLOW_KICK_ON_START` | On, unless the value is `false`. API only. |
| `WORKFLOW_KICK_BUDGET_MS` | `50000`, range 5000 to 55000. API only. |
| `WORKFLOW_BATCH_LIMIT` | `12`, range 1 to 64. |
| `WORKFLOW_CONCURRENCY` | `4`, range 1 to 16. |
| `WORKFLOW_BUDGET_MS` | `1200000`, range 1000 to 3300000. |
| `WORKFLOW_LEASE_MS` | The queue upstream timeout plus 60 seconds, clamped from 5000 to 600000. The queue timeout reads `ABSTRACTION_UPSTREAM_TIMEOUT_MS`, then `SYNTHESIS_UPSTREAM_TIMEOUT_MS`, then `CLOUD_RUN_UPSTREAM_TIMEOUT_MS`, and otherwise uses 240000. |
| `WORKFLOW_STALE_LEASE_MS` | The workflow lease plus 60 seconds, clamped from 5000 to 600000. |
| `ANALYZE_MAX_REQUEST_BYTES` | `20000000`, range 1 to 32000000. `CLOUD_RUN_MAX_REQUEST_BYTES` is the fallback. API only. |
| `ANALYZE_UPSTREAM_TIMEOUT_MS` | `240000`, range 10000 to 300000. API only. |
| `CLOUD_RUN_MAX_BODY_BYTES` | `26214400`. A non-positive value uses that same default. This caps request bodies read by the HTTP adapter. |
| `STORAGE_MAX_UPLOAD_BYTES` | `104857600`. `GCS_MAX_UPLOAD_BYTES` is the alias. Range 1 to 1073741824. |
| `GCS_SIGNED_URL_TTL_MS` | `900000`, range 60000 to 3600000. |
| `ANALYZE_RATE_LIMIT_MAX` | `300` requests each minute for `POST /api/analyze`, then forced into 10 to 600. `0` is treated as unset. |
| `REQUEST_ENVELOPE_SAFE_BYTES` | Abstraction and abstraction batching use `18000000`. Synthesis uses `12000000`. Both clamp from 100000 to 20000000. |
| `REQUEST_OVERHEAD_BYTES` | `350000` for synthesis, range 0 to 1000000. |
| `VERIFY_GCS_OBJECTS` | Off. `true` makes chunk finalization check that the object exists. |
| `OCR_COMPARE_ENABLED` | Off. `POST /api/ocr-compare` returns 404 unless this is `true`. It also returns 503 when `APP_PASSWORD` is unset. |
| `OCR_COMPARE_MAX_TOKENS` | `16000` unless the value is an integer from 512 to 32000. |
| `GEMINI_API_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta`. |
| `GEMINI_UPLOAD_BASE_URL` | `https://generativelanguage.googleapis.com/upload`. |

`INNGEST_EVENT_KEY` and `INNGEST_SIGNING_KEY` do not turn on a second queue. Leave `WORKFLOW_DRIVER` unset.

### Values the release workflow sets

These are `--update-env-vars` on the API deploy, except `WORKER_DISABLED`. That one is set on the worker. They override the code defaults on that service.

| Name | Value |
|---|---|
| `RELEASE_VERSION` | The release tag. Health uses `v` plus the `package.json` version when this is empty. |
| `GIT_SHA` | The deployed commit. `COMMIT_SHA` is an alias `getRuntimeInfo` also reads. |
| `IMAGE_DIGEST` | The container image digest. |
| `WORKER_DISABLED` | `true` on the worker. |
| `SYNTHESIS_CONCURRENCY` | `8` on the API. |
| `SYNTHESIS_BATCH_LIMIT` | `8` on the API. |
| `BULK_JOB_MIN_ABSTRACTS` | `50` on the API. |
| `SYNTHESIS_CHUNK_SIZE` | `50` on the API. |
| `BULK_SYNTHESIS_CHUNK_SIZE` | `50` on the API. |
| `SYNTHESIS_MAX_TOKENS` | `5000` on the API. |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | `4000` on the API. |
| `SYNTHESIS_STREAM_ENABLED` | `true` on the API. |
| `SYNTHESIS_COMPACTION_ENABLED` | `true` on the API. |
| `SYNTHESIS_LARGE_JOB_MULTI_SEGMENT` | `true` on the API. |
| `ABSTRACTION_ESCALATION_ENABLED` | `false` on the API. |

`K_REVISION` and `CLOUD_RUN_REVISION` are read for the revision field in runtime info. Cloud Run sets `K_REVISION`. The app does not require you to set them.

`scripts/verify-release.mjs` also reads `GCP_PROJECT_ID`, `GCP_REGION`, `API_SERVICE`, `WORKER_SERVICE`, `RELEASE_VERSION`, `GITHUB_REF_NAME`, `GITHUB_SHA`, `IMAGE_DIGEST`, and `API_URL` when the matching CLI flag is omitted. The release workflow passes the flags.

`scripts/compare-final-opinion.mjs` reads `DATABASE_URL` or `POSTGRES_URL`, plus `GEMINI_THINKING_LEVEL` and `GEMINI_THINKING_BUDGET`. `scripts/compare-ocr-models.mjs` reads `GEMINI_API_KEY` or `GOOGLE_API_KEY`. Neither script is part of `npm test` or the release workflow. `.cursor/skills/verify-titlework/verify.mjs` reads `CHROME_PATH` when it launches a browser.

## When a job fails

`Google Cloud Storage is not configured` means `GCS_BUCKET` is empty on that service, or the runtime service account cannot use the bucket.

`DATABASE_URL or POSTGRES_URL is required` means none of `DATABASE_URL`, `POSTGRES_URL`, and `POSTGRES_PRISMA_URL` is set.

Uploads fail with CORS errors. Check the GCS CORS policy. It must allow `PUT` from the page origin and from the API origin.

Jobs stay queued or abstracting. Confirm the worker is deployed and can reach Neon. If `WORKER_DISABLED=true`, keep the browser tab open so the API kick runs, or set `WORKER_DISABLED=false` for an unattended worker loop. The worker still needs the database, the bucket, the model keys, and `APP_PASSWORD`.

Model timeouts or rate limits. Lower `WORKFLOW_CONCURRENCY` or `WORKFLOW_BATCH_LIMIT`, or raise the provider limit. Retryable failures are stored as `retry_wait` and picked up again.

Server abstraction and synthesis routes return 401 until `APP_PASSWORD` is set, including on a laptop.

## Spend

Each kept chunk becomes an abstraction call, unless worker batching packs several small chunks into one call. Partial synthesis then runs one call per segment from `effectiveSynthesisChunkSize`. The final merge is one Sonnet call. This repository does not record a dollar price for a job. Provider prices change, and the prompts live in `public/index.html` and `api/_lib/synthesis.js`.

These settings cut calls or output tokens.

- Leave `ABSTRACTION_PDF_TEXT_FIRST` unset so text PDFs can skip visual input.
- Leave `ABSTRACTION_BATCH_ENABLED` unset so small chunks share a call.
- Leave `GEMINI_FILE_API_ENABLED` unset so a large visual file is uploaded through the Files API instead of inline base64.
- `ABSTRACT_MAX_TOKENS` and `SYNTHESIS_MAX_TOKENS` cap output.
- `ABSTRACTION_ESCALATION_ENABLED=false` skips the Sonnet re-read. The release workflow sets that on the API.

The server code does not call the Anthropic message-batches endpoint or a Gemini batch-job endpoint. Queue progress is the worker and the Neon rows.

## What the page can do

- A job accepts at most 400 files. `MAX_TOTAL_DOCUMENTS` in `api/_lib/jobs.js` and `MAX_FILES` in `public/index.html` both say 400.
- Accepted types are PDF, CSV, JPEG, PNG, GIF, and WEBP.
- The browser uploads with a signed PUT. The signature always sets `Content-Type` and `Content-Length`. A missing size returns 400, `sizeBytes is required for signed uploads.`
- The worker abstracts with `gemini-3.1-flash-lite` and can batch up to `ABSTRACTION_BATCH_MAX_DOCS` small chunks.
- If server abstraction is unavailable, the page groups up to 24 files per call and splits an oversized single PDF.
- The final opinion and follow-up answers use `claude-sonnet-5-5`.
- A job reopens at `#/job/<id>`. Recent jobs are `#/jobs`.
- The page can cancel a job, retry one chunk, and retry failed chunks.
- **Download PDF** builds a PDF in the browser with jsPDF.

## Security

Report vulnerabilities as `SECURITY.md` describes.

- The password stays in the page's `appPassword` variable for the tab. On load, the page deletes any saved `localStorage` or `sessionStorage` copy. It does not write a cookie.
- `POST /internal/drain` checks `x-internal-drain-token` with the same `secureCompare` helper as the password. Cloud Run IAM still requires the caller's identity. The in-app check is a second gate, and it fails closed in production when the token is missing. Worker `/healthz` does not check it.
- `POST /api/analyze` allows `ANALYZE_RATE_LIMIT_MAX` requests per minute per IP. Job routes and `POST /api/blob/upload` allow 1500 per minute per IP, including GET. Each of those two limiters locks the IP after 5 failed passwords and then returns 429 for 60 seconds. The client IP is the rightmost `X-Forwarded-For` hop, or the socket address when that header is absent. When a bucket is configured, limiter state is stored in the bucket. Otherwise it stays in memory. A store error returns 503, `Rate limiter unavailable. Try again.`
- Source files stay in a private bucket. Allow `PUT` only from your app origins.
- Job metadata routes reject base64 and raw document fields. The update check rejects raw documents, abstracts, CSV text, base64 payloads, and title opinions.
- `public/index.html` sets `script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com` for the inline script, jsPDF, and pdf-lib. `connect-src` allows this origin plus `https://storage.googleapis.com` and `https://*.storage.googleapis.com`.

## Repository layout

```text
api/
  _lib/                 queue, jobs, storage, model clients
  analyze.js
  blob/upload.js
  jobs.js
  jobs/[...path].js
  ocr-compare.js
public/index.html
scripts/                release checks and model comparison scripts
test/
docs/                   design notes and release notes
.github/workflows/      test.yml, release.yml, secret-scan.yml
server.js               web and API service
worker.js               background worker
Dockerfile
package.json
.env.example
SECURITY.md
LICENSE
```

## License

MIT. See `LICENSE`.
