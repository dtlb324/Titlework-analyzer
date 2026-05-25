# Mineral Ownership Builder — Title Research Tool

An AI-powered web application for oil and gas landmen to analyze courthouse documents, build chain of title, and determine mineral ownership. Document abstraction uses Google Gemini 2.5 Flash; title synthesis and follow-ups use Anthropic Claude. Deployed on Google Cloud Run.

> **Important:** This tool is an AI-assisted research aid, not a legal opinion. Always verify output against source documents and consult a licensed attorney before any drilling, leasing, or division order action.

## Architecture

The Cloud Run deployment uses two Cloud Run services, Google Cloud Storage, and Neon Postgres:

- **Web/API service:** serves `public/index.html`, `/healthz`, `/api/healthz`, and the `/api/*` routes from `server.js`.
- **Worker service:** runs `worker.js` and drains durable abstraction/synthesis work from Postgres.
- **Google Cloud Storage:** stores uploaded PDFs, images, CSVs, and split PDF chunks through signed browser uploads.
- **Neon Postgres:** stores jobs, documents, chunks, abstracts, synthesis segments, final results, and follow-up messages.

The browser creates a job, uploads files directly to GCS, polls job status, and renders results. The worker owns long-running processing, so large jobs can continue after the browser tab closes.

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
| `GEMINI_API_KEY` | Yes | Google AI Studio API key for document abstraction (`gemini-2.5-flash` by default). Also accepts `GOOGLE_API_KEY`. |
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for synthesis, follow-ups, and optional abstraction escalation. |
| `ABSTRACT_MODEL` | Optional | Default `gemini-2.5-flash`. Claude Haiku is not supported for abstraction. |
| `GEMINI_THINKING_BUDGET` | Optional | Default `0` (fastest/cheapest). Set to `-1` for Gemini dynamic thinking on abstraction. |
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
| `WORKFLOW_CONCURRENCY` | Optional | Default `4`. |
| `WORKFLOW_BUDGET_MS` | Optional | Default `1200000` (20 min). |
| `WORKFLOW_LEASE_MS` | Optional | Default is longer than the model upstream timeout. |
| `WORKFLOW_STALE_LEASE_MS` | Optional | Default is longer than `WORKFLOW_LEASE_MS`. |
| `SYNTHESIS_MERGE_LEASE_MS` | Optional | Defaults longer than synthesis upstream timeout. |
| `SYNTHESIS_STALE_LEASE_MS` | Optional | Defaults longer than synthesis merge lease. |
| `WORKER_POLL_INTERVAL_MS` | Worker only | Default `5000`. |
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

The release workflow runs tests on Node 22, builds one Docker image, pushes it to Artifact Registry, resolves the immutable image digest, deploys the worker first, then deploys the API from that same immutable image digest. The worker deploy uses `--min-instances=1`, `--concurrency=1`, `--no-cpu-throttling`, and a 3600 second timeout so long-running batch work is not starved while idle. The workflow creates or updates the GitHub Release only after production verification passes.

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
3. Keep `ANTHROPIC_API_KEY` configured — synthesis and follow-ups still use Claude Sonnet.
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
  -> calls Anthropic
  -> stores abstracts, synthesis segments, and final result in Postgres
```

Anthropic calls still use document/chunk/segment work units. Cloud Run removes the Vercel request and function ceilings, but the app still preserves safe model request budgets, retries, cancellation, leases, and checkpoints.

The durable Cloud Run worker processes uploaded chunks directly from GCS. PDFs are uploaded as whole documents when possible so legal instruments keep their full context. If a PDF still exceeds model request limits or times out, the worker can degrade to page-range split recovery and the final result warns that clause continuity, legal descriptions, and exhibits need manual verification. Browser-only fallback can group up to 8 small documents per browser fallback call and still page-splits oversized single PDFs as an escape hatch.

## Features

- Bulk upload up to 400 documents per job.
- Direct browser-to-GCS durable uploads.
- Server-side abstraction with Gemini 2.5 Flash.
- Server-side synthesis and follow-ups with Claude Sonnet 4.6.
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

Cloud Run and GCS are billed by Google Cloud usage, while Neon can start on its free tier. Anthropic API usage is billed separately through Anthropic. API cost scales with document count, page count, scan resolution, and title complexity.
