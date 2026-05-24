# Mineral Ownership Builder — Title Research Tool

An AI-powered web application for oil and gas landmen to analyze courthouse documents, build chain of title, and determine mineral ownership. Powered by Anthropic's Claude API and deployed on Google Cloud Run.

> **Important:** This tool is an AI-assisted research aid, not a legal opinion. Always verify output against source documents and consult a licensed attorney before any drilling, leasing, or division order action.

## Architecture

The Cloud Run deployment uses two Cloud Run services, Google Cloud Storage, and Neon Postgres:

- **Web/API service:** serves `public/index.html`, `/healthz`, and the `/api/*` routes from `server.js`.
- **Worker service:** runs `worker.js` and drains durable abstraction/synthesis work from Postgres.
- **Google Cloud Storage:** stores uploaded PDFs, images, CSVs, and split PDF chunks through signed browser uploads.
- **Neon Postgres:** stores jobs, documents, chunks, abstracts, synthesis segments, final results, and follow-up messages.

The browser creates a job, uploads files directly to GCS, polls job status, and renders results. The worker owns long-running processing, so large jobs can continue after the browser tab closes.

## Required Services

1. Create or select a Google Cloud project.
2. Enable Cloud Run, Artifact Registry, Cloud Build, and Cloud Storage APIs.
3. Create a Neon project and copy the pooled Postgres connection string.
4. Create a private GCS bucket for durable document storage.
5. Create a Cloud Run service account with:
   - `roles/storage.objectAdmin` on the document bucket
   - permission to read any Secret Manager secrets you use

## Environment Variables

Set these on both Cloud Run services unless noted otherwise:

| Name | Required | Notes |
|------|----------|-------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for abstraction, synthesis, and follow-ups. |
| `APP_PASSWORD` | Yes for production | Password gate for users; release verification expects it on both services. |
| `DATABASE_URL` | Yes | Neon pooled Postgres URL, usually ending in `?sslmode=require`. |
| `GCS_BUCKET` | Yes | Private bucket for uploaded source chunks and split PDFs. |
| `ANALYZE_MAX_REQUEST_BYTES` | Optional | Default `20000000`. |
| `ANALYZE_UPSTREAM_TIMEOUT_MS` | Optional | Default `240000`. |
| `STORAGE_MAX_UPLOAD_BYTES` | Optional | Default `104857600` (100 MB). |
| `WORKFLOW_BATCH_LIMIT` | Optional | Default `12`. |
| `WORKFLOW_CONCURRENCY` | Optional | Default `4`. |
| `WORKFLOW_BUDGET_MS` | Optional | Default `1200000` (20 min). |
| `WORKFLOW_LEASE_MS` | Optional | Default is longer than the model upstream timeout. |
| `WORKFLOW_STALE_LEASE_MS` | Optional | Default is longer than `WORKFLOW_LEASE_MS`. |
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
git tag v2.3.1
git push origin v2.3.1
```

The release workflow runs tests on Node 22, builds one Docker image, pushes it to Artifact Registry, resolves the immutable image digest, deploys the worker first, then deploys the API from that same immutable image digest. The worker deploy uses `--min-instances=1`, `--concurrency=1`, `--no-cpu-throttling`, and a 3600 second timeout so long-running batch work is not starved while idle. The workflow creates or updates the GitHub Release only after production verification passes.

Configure these GitHub repository variables before the first release:

| Name | Purpose |
|------|---------|
| `GCP_PROJECT_ID` | Google Cloud project ID. |
| `GCP_REGION` | Cloud Run and Artifact Registry region, usually `us-central1`. |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Workload Identity Federation provider for GitHub OIDC. |
| `GCP_SERVICE_ACCOUNT` | Deploy service account used by GitHub Actions. |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | Optional runtime service account assigned to Cloud Run services. |
| `GAR_REPOSITORY` | Artifact Registry Docker repository. |
| `API_SERVICE` | API Cloud Run service name, usually `titlework-analyzer-api`. |
| `WORKER_SERVICE` | Worker Cloud Run service name, usually `titlework-analyzer-worker`. |

Secrets such as `ANTHROPIC_API_KEY`, `APP_PASSWORD`, and `DATABASE_URL` must be configured on both Cloud Run services through Cloud Run environment variables or Secret Manager. The release workflow verifies required variable names are present, but it does not store secret values in GitHub.

### Release Verification

After each release, verify:

- API `/healthz` reports the expected `release.version`, `release.gitSha`, `release.imageDigest`, and Cloud Run revision.
- API and worker latest ready revisions use the same immutable image digest.
- Both services still have database, GCS, Anthropic, and app password configuration.
- GCS CORS allows `PUT` uploads from the API service origin with the `content-type` header.
- `gh release list --limit 3` marks the new version as `Latest`.

### Rollback

Rollback API and worker together. Either redeploy both services from the same previously verified image digest:

```bash
gcloud run deploy titlework-analyzer-worker \
  --image PREVIOUS_IMAGE_DIGEST_REF \
  --region us-central1 \
  --command npm \
  --args run,start:worker \
  --no-allow-unauthenticated

gcloud run deploy titlework-analyzer-api \
  --image PREVIOUS_IMAGE_DIGEST_REF \
  --region us-central1 \
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

Abstraction still groups up to 2 documents per call when payload and timeout estimates allow it; large files are processed alone or split into smaller PDF page ranges before model calls.

## Features

- Bulk upload up to 400 documents per job.
- Direct browser-to-GCS durable uploads.
- Server-side abstraction with Claude Haiku 4.5.
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
Confirm the worker service is deployed, has `ANTHROPIC_API_KEY`, `DATABASE_URL`, and `GCS_BUCKET`, and can connect to Neon.

**Anthropic timeouts or rate limits**  
Lower `WORKFLOW_CONCURRENCY`, lower `WORKFLOW_BATCH_LIMIT`, or raise Anthropic limits. Retryable errors are saved as durable `retry_wait` rows.

## Cost Notes

Cloud Run and GCS are billed by Google Cloud usage, while Neon can start on its free tier. Anthropic API usage is billed separately through Anthropic. API cost scales with document count, page count, scan resolution, and title complexity.
