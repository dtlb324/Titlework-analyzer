# Titlework Analyzer

Titlework Analyzer is a web app that helps oil and gas landmen read courthouse documents, build a chain of title, and draft a mineral ownership opinion. Gemini 3.1 Flash Lite abstracts each document, and Claude Sonnet 5 writes the final opinion and answers follow-up questions. The app runs on Google Cloud Run with Neon Postgres and Google Cloud Storage.

The output is a research aid, not a legal opinion. Check it against the source documents, and consult a licensed attorney before any drilling, leasing, or division order action.

## Quick start

You need Node.js 22, git, a Neon database, a Gemini API key, an Anthropic API key, and a Google Cloud Storage bucket. The sections below explain how to get each one.

```bash
git clone <your-repo-url>
cd Titlework-analyzer
npm install
npm test
```

Create `.env.local` in the project root with one variable per line.

```ini
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
GCS_BUCKET=your-bucket-name
APP_PASSWORD=pick-a-password
# Worker only. Required in production for POST /internal/drain.
INTERNAL_DRAIN_TOKEN=pick-a-long-random-token
```

Sign in to Google Cloud once so the app can reach the bucket, then start the server.

```bash
gcloud auth application-default login
npm run dev
```

Open `http://localhost:8080`. To process jobs in the background, run `npm run dev:worker` in a second terminal.

`npm run dev` and `npm run dev:worker` load `.env.local` through `node --env-file`, so the same commands work on Windows PowerShell and macOS. `.env*` is git-ignored. Use `npm start` and `npm run start:worker` only where the variables are already in the process environment, as in the Cloud Run container.

## How it works

- `server.js` is the web and API service. It serves `public/index.html` and the `/api/*` routes.
- `worker.js` is the worker service. It processes abstraction and synthesis work from a queue in the database.
- Neon Postgres stores jobs, documents, abstracts, synthesis segments, final results, and follow-up messages. The app creates its tables on first run.
- Google Cloud Storage (GCS) stores the uploaded PDFs and images. The browser uploads straight to GCS with signed URLs, so document bytes do not pass through the API.

The browser creates a job, uploads files to GCS, starts abstraction and synthesis, polls for status, and renders the result.

## Set up services

### Neon Postgres

1. Sign up at [neon.tech](https://neon.tech) and create a project.
2. On the connection screen, turn on **Pooled connection**. The host in the string then contains `-pooler`.
3. Copy the string. It is your `DATABASE_URL`.

Cloud Run starts many short-lived instances, and the pooled string keeps the number of database connections low.

### Model API keys

1. Create a Gemini key at [Google AI Studio](https://aistudio.google.com/apikey). It is your `GEMINI_API_KEY`. Gemini reads every document and writes a structured abstract. It also does partial synthesis on large jobs.
2. Create an Anthropic key in the [Anthropic console](https://console.anthropic.com), after you add billing. It is your `ANTHROPIC_API_KEY`. Claude Sonnet writes the final opinion, answers follow-ups, and can re-read low-confidence documents.

You need both keys unless you use OpenRouter (see below).

### Google Cloud

You need a project with billing enabled and the `gcloud` CLI. You need the bucket even for local runs. You need the rest only for a hosted deployment.

Enable the APIs.

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
```

Create a private bucket. The bucket name is your `GCS_BUCKET`.

```bash
gcloud storage buckets create gs://my-titlework-bucket \
  --location=US \
  --uniform-bucket-level-access
```

Allow browser uploads. Save the following as `cors.json`, and replace the first origin with your Cloud Run API URL after you deploy.

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

Create the runtime service account that the Cloud Run services use.

```bash
gcloud iam service-accounts create titlework-runtime \
  --display-name="Titlework Cloud Run runtime"

gcloud storage buckets add-iam-policy-binding gs://my-titlework-bucket \
  --member="serviceAccount:titlework-runtime@my-titlework-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

If you keep API keys in Secret Manager, also grant this account `roles/secretmanager.secretAccessor`.

## Deploy to Cloud Run

Pushing a version tag starts `.github/workflows/release.yml`. You do not run `gcloud run deploy` for a normal release.

### Authenticate GitHub Actions

The workflow signs in with Workload Identity Federation, so no long-lived key is stored in GitHub. Set it up once.

1. Create a deploy service account, separate from the runtime one. Grant it Artifact Registry writer, Cloud Run admin, `roles/iam.serviceAccountTokenCreator`, and `roles/iam.serviceAccountUser` on the runtime account.
2. Create a Workload Identity pool and a provider scoped to your GitHub repository.
3. Bind the deploy service account to that repository's principal.

Google documents these steps in [google-github-actions/auth](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation).

### Configure the repository

Create the Artifact Registry repository once.

```bash
gcloud artifacts repositories create YOUR_GAR_REPOSITORY \
  --repository-format=docker \
  --location=YOUR_REGION
```

Add these under **Settings**, **Secrets and variables**, **Actions**, **Variables**.

| Variable | Value |
|---|---|
| `GCP_PROJECT_ID` | Your Google Cloud project ID. |
| `GCP_REGION` | Region for Cloud Run and Artifact Registry. |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | The provider resource name from the previous step. |
| `GCP_SERVICE_ACCOUNT` | The deploy service account email. |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | The runtime service account email. Optional. |
| `GAR_REPOSITORY` | The Artifact Registry repository name. |
| `API_SERVICE` | The Cloud Run service name for the API. |
| `WORKER_SERVICE` | The Cloud Run service name for the worker. |

Set `DATABASE_URL`, `GCS_BUCKET`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and `APP_PASSWORD` on both Cloud Run services, either under **Variables & Secrets** in the console or through Secret Manager. The workflow checks that these names exist but never stores their values in GitHub.

### Cut a release

Push a lowercase `vX.Y.Z` tag that matches the `version` in `package.json`.

```bash
VERSION="v$(node -p "require('./package.json').version")"
git tag "$VERSION"
git push origin "$VERSION"
```

The workflow runs the tests on Node 22, builds one Docker image, and pushes it to Artifact Registry. It then resolves the image digest, deploys the worker, deploys the API from the same immutable image digest, verifies both services with `scripts/verify-release.mjs`, and creates the GitHub Release.

Do not leave Cloud Build or Cloud Run source-deploy triggers on `main`. They can race the tag workflow and overwrite the verified image.

After a release, check these points.

- `/api/healthz` on the API reports `release.version`.
- The latest ready revisions of the API and the worker use the same image digest.
- Both services have the database, bucket, model, and `APP_PASSWORD` settings.
- `gh release list --limit 3` marks the new version as Latest.

### Roll back

Rollback API and worker together. Redeploy a previously verified image digest to both services, then confirm both report the same digest. Database changes only move forward.

```bash
gcloud run deploy WORKER_SERVICE \
  --image PREVIOUS_IMAGE_DIGEST_REF --region YOUR_REGION \
  --command npm --args run,start:worker --no-allow-unauthenticated

gcloud run deploy API_SERVICE \
  --image PREVIOUS_IMAGE_DIGEST_REF --region YOUR_REGION \
  --allow-unauthenticated
```

## Use OpenRouter instead of direct keys

If you want one key and one bill for both models, set these in `.env.local` or on both Cloud Run services.

```bash
OPENROUTER_API_KEY=your-openrouter-key
MODEL_PROVIDER=openrouter
```

Model calls then go through [OpenRouter](https://openrouter.ai) instead of Anthropic and Gemini. Any other value of `MODEL_PROVIDER`, or none, uses direct routing. To label your usage on the OpenRouter dashboard, set `OPENROUTER_REFERER` and `OPENROUTER_TITLE`.

## Environment variables

`DATABASE_URL`, `GCS_BUCKET`, and a model provider are required. Everything else has a default in the code. Set variables on both Cloud Run services unless the notes say API only or worker only. The release workflow overrides some defaults, as the last table shows.

### Core

| Name | Notes |
|---|---|
| `DATABASE_URL` | Neon pooled Postgres URL. `POSTGRES_URL` is also read. |
| `GCS_BUCKET` | Private bucket for uploaded chunks and split PDFs. |
| `GEMINI_API_KEY` | Gemini key. `GOOGLE_API_KEY` is also read. |
| `ANTHROPIC_API_KEY` | Required unless you use OpenRouter. |
| `APP_PASSWORD` | Yes for production. Password gate for users. Release verification expects it on both services. |
| `INTERNAL_DRAIN_TOKEN` | Yes for production, worker only. Shared secret for `POST /internal/drain`. Callers send it as `X-Internal-Drain-Token`. Compared in constant time. The production image fails closed with 401 when this is unset. Cloud Scheduler must send the same value; see `docs/worker-synthesis-scheduler-runbook.md`. |

### OpenRouter

| Name | Notes |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter key. |
| `MODEL_PROVIDER` | `openrouter` turns the gateway on. |
| `OPENROUTER_REFERER` | Sent as `HTTP-Referer` when set. |
| `OPENROUTER_TITLE` | Sent as `X-Title`. Defaults to `Titlework Analyzer`. |

### Models

| Name | Default | Notes |
|---|---|---|
| `SYNTHESIS_MODEL` | `claude-sonnet-5` | Final opinion and merge. Gemini and Haiku values are ignored. |
| `SYNTHESIS_PARTIAL_MODEL` | `gemini-3.1-flash-lite` | Segment synthesis on large jobs. Haiku and Claude values are ignored. |
| `ABSTRACT_MODEL` | `gemini-3.1-flash-lite` | Claude Haiku is not supported here. |
| `ABSTRACT_ESCALATION_MODEL` | `claude-sonnet-5` | Re-reads low-confidence abstracts. Needs Anthropic. |
| `GEMINI_THINKING_LEVEL` | unset | Gemini 3.x only. Accepts `minimal`, `low`, `medium`, or `high`. When unset, the API default applies. |
| `GEMINI_THINKING_BUDGET` | `0` | Gemini 2.5 only. `-1` is dynamic, or give a token count. |
| `GEMINI_INCLUDE_THOUGHTS` | off | When `true`, Gemini returns thought summaries as `thoughtSummaries`. For debugging. |

### Abstraction

| Name | Default | Notes |
|---|---|---|
| `ABSTRACT_MAX_TOKENS` | `2000` | Output cap per abstract. |
| `ABSTRACTION_PDF_TEXT_FIRST` | `true` | Sends extracted PDF text when quality checks pass. This costs fewer tokens than visual input. |
| `ABSTRACTION_PDF_TEXT_STRICT` | `false` | Tightens those checks so borderline scans use the visual PDF. |
| `ABSTRACTION_BATCH_ENABLED` | `true` | Worker batches small chunks into one call. |
| `ABSTRACTION_BATCH_MAX_DOCS` | `24` | Maximum `48`. |
| `ABSTRACTION_BATCH_MAX_PAGE_SPAN` | `32` | Chunks with a larger page range run alone. |
| `ABSTRACTION_ESCALATION_ENABLED` | `true` | Set `false` to skip Sonnet re-reads. |
| `GEMINI_FILE_API_ENABLED` | `true` | Uploads large visual files through the Gemini Files API instead of base64. |
| `GEMINI_FILE_API_MIN_BYTES` | `1500000` | Smallest file that uses the Files API. |
| `GEMINI_FILE_API_MAX_BYTES` | `48000000` | Largest file that uses the Files API. |

### Synthesis

| Name | Default | Notes |
|---|---|---|
| `SYNTHESIS_CHUNK_SIZE` | `120` | Maximum `250`. Documents per partial segment. |
| `BULK_SYNTHESIS_CHUNK_SIZE` | `200` | Used for jobs with at least `BULK_JOB_MIN_ABSTRACTS` abstracts. |
| `BULK_JOB_MIN_ABSTRACTS` | `100` | Threshold for a bulk job. |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | `5000` | Output cap for a partial segment. |
| `SYNTHESIS_MAX_TOKENS` | `8000` | Output cap for the final merge. |
| `SYNTHESIS_BATCH_LIMIT` | `4` | Maximum `16`. Segments claimed per batch. |
| `SYNTHESIS_STREAM_ENABLED` | off | Streams the final merge to `GET /api/jobs/:id/synthesis/preview`. The opinion is saved after the stream ends. |
| `SYNTHESIS_COMPACTION_ENABLED` | on | Compacts large merge input with Gemini before the Sonnet merge. |
| `SYNTHESIS_COMPACTION_MIN_SEGMENTS` | `6` | Segment count that triggers compaction. |
| `SYNTHESIS_COMPACTION_MIN_MERGE_TOKENS` | `40000` | Merge size that triggers compaction. |
| `SYNTHESIS_LARGE_JOB_MULTI_SEGMENT` | off | Forces multi-segment Gemini synthesis above `BULK_JOB_MIN_ABSTRACTS`. |
| `SYNTHESIS_FORCE_SINGLE_PASS` | unset | When `true`, opts out of that forcing. |

### Worker, queue, and limits

| Name | Default | Notes |
|---|---|---|
| `WORKER_DISABLED` | off | Worker only. `true` turns the loop off so the worker can scale-to-zero. The release workflow sets it to `true`. |
| `INTERNAL_DRAIN_TOKEN` | unset | Worker only. When set, `POST /internal/drain` requires header `X-Internal-Drain-Token`. Production (`NODE_ENV=production`, which the image sets, or Cloud Run `K_SERVICE`) rejects the request when this is unset. Outside production an unset token leaves the route open for local use. |
| `WORKER_POLL_IDLE_MS` | `2000` | Worker only. Wait between polls when idle. |
| `WORKER_POLL_ACTIVE_MS` | `0` | Worker only. Wait between busy passes. |
| `WORKER_POLL_INTERVAL_MS` | `5000` | Worker only. Legacy fallback for the idle wait. |
| `WORKFLOW_KICK_ON_START` | `true` | API only. Runs a bounded batch when abstraction or synthesis starts. |
| `WORKFLOW_KICK_BUDGET_MS` | `50000` | API only. Time limit for that batch. |
| `WORKFLOW_BATCH_LIMIT` | `12` | Items claimed per batch. |
| `WORKFLOW_CONCURRENCY` | `4` | Parallel model calls. |
| `WORKFLOW_BUDGET_MS` | `1200000` | 20 minutes. |
| `WORKFLOW_LEASE_MS` | upstream timeout plus 60 seconds | `WORKFLOW_STALE_LEASE_MS` sets the stale limit. |
| `SYNTHESIS_MERGE_LEASE_MS` | upstream timeout plus 60 seconds | `SYNTHESIS_STALE_LEASE_MS` sets the stale limit. |
| `ANALYZE_MAX_REQUEST_BYTES` | `20000000` | Request size cap for `/api/analyze`. |
| `ANALYZE_UPSTREAM_TIMEOUT_MS` | `240000` | API only. |
| `ABSTRACTION_UPSTREAM_TIMEOUT_MS` | `240000` | Worker only. Sets abstraction lease length. |
| `SYNTHESIS_UPSTREAM_TIMEOUT_MS` | `240000` | Worker only. Sets synthesis lease length. |
| `CLOUD_RUN_UPSTREAM_TIMEOUT_MS` | none | Fallback for the three timeouts above. |
| `STORAGE_MAX_UPLOAD_BYTES` | `104857600` | 100 MB upload cap. |
| `ANALYZE_RATE_LIMIT_MAX` | `300` | Requests per minute per IP. |

### Set by the release workflow

| Name | Value |
|---|---|
| `RELEASE_VERSION` | The release tag. |
| `GIT_SHA` | The deployed commit. |
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

## Troubleshooting

`Google Cloud Storage is not configured`: set `GCS_BUCKET` on both services, and give the runtime service account object permissions on the bucket.

`DATABASE_URL or POSTGRES_URL is required`: set `DATABASE_URL` to your Neon pooled connection string.

Uploads fail with CORS errors. Check the GCS CORS policy. It must allow `PUT` from the API origin with the `content-type` header.

Jobs stay queued or abstracting: confirm the worker is deployed, has the five required variables, and can reach Neon. If `WORKER_DISABLED=true`, keep the browser tab open so the API processes the job. Set `WORKER_DISABLED=false` for unattended runs.

Model timeouts or rate limits: lower `WORKFLOW_CONCURRENCY` or `WORKFLOW_BATCH_LIMIT`, or raise your provider rate limits. The app stores retryable errors as `retry_wait` rows and resumes them.

## Cost

Cloud Run and GCS bill by usage, and Neon has a free tier. Gemini and Anthropic bill separately. Cost grows with document count, page count, scan resolution, and title complexity.

A 300-document job with no PDF splits makes about 305 model calls. That is 300 abstraction calls, about 4 partial synthesis calls, and 1 final Sonnet merge. Worker batching reduces the abstraction count. An earlier estimate put the token cost of such a job at $1.50 to $3, mostly the Sonnet merge. Measure your own jobs, because prices and prompts change.

These settings lower cost.

- `ABSTRACTION_PDF_TEXT_FIRST=true` sends extracted text for text-based PDFs.
- `ABSTRACTION_BATCH_ENABLED=true` cuts the number of abstraction calls.
- `GEMINI_FILE_API_ENABLED=true` keeps large scanned PDFs whole.
- `ABSTRACT_MAX_TOKENS` and `SYNTHESIS_MAX_TOKENS` cap output.
- `ABSTRACTION_ESCALATION_ENABLED=false` skips Sonnet re-reads.

The app does not use the Anthropic or Gemini batch APIs. Progress runs through the worker and the Neon job queue.

## Features

- Upload up to 400 documents per job.
- Upload directly from the browser to GCS.
- Abstract documents server-side with Gemini 3.1 Flash Lite. The worker batches small chunks. The browser fallback groups up to 24 small documents per call and still splits oversized single PDFs.
- Write the final opinion and answer follow-ups with Claude Sonnet 5.
- Reopen a job by URL after a refresh or a closed tab.
- Retry, cancel, and recover failed chunks.
- Download the final result as a PDF.

## Security

Report vulnerabilities as described in `SECURITY.md`.

- Password gate. When `APP_PASSWORD` is set, the browser sends it as a header and keeps it in memory for the tab. It does not store it in cookies, `localStorage`, or `sessionStorage`.
- Worker drain. `POST /internal/drain` checks `X-Internal-Drain-Token` against `INTERNAL_DRAIN_TOKEN` with the same constant-time compare as the password gate. Cloud Run IAM still requires the scheduler's OIDC token. The in-app check is a second gate, and it fails closed in production when the secret is missing. `/healthz` stays unauthenticated.
- Rate limits. `/api/analyze` allows `ANALYZE_RATE_LIMIT_MAX` requests per minute per IP. Job and blob routes allow 1500 per minute per IP, including GET. Both lock an IP after 5 failed passwords. The client IP is the rightmost `X-Forwarded-For` hop. When GCS is configured, limiter state lives in the bucket, so instances share it. Otherwise it stays in memory.
- Uploads. Browsers upload to signed GCS URLs. Signed PUT requests bind `Content-Length` when the size is known.
- Storage. Source files stay in a private bucket. Allow `PUT` only from your app origin.
- Database. Postgres holds metadata, references, abstracts, results, and sanitized errors. Job metadata routes reject base64 and raw document fields.
- Content Security Policy. `public/index.html` sets `script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com` for the inline script, jsPDF, and pdf-lib.

## Project layout

```text
api/
  _lib/          shared modules (queue, jobs, storage, model clients)
  analyze.js
  blob/upload.js
  jobs.js
  jobs/[...path].js
public/index.html
scripts/         release verification and model comparison scripts
test/
docs/            design notes and release notes
server.js        web and API service
worker.js        background worker service
Dockerfile
```

`npm test` runs the test files listed in the `test` script in `package.json`.

## License

MIT. See `LICENSE`.
