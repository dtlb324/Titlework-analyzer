# Mineral Ownership Builder — Title Research Tool

An AI-powered web application for oil and gas landmen to analyze courthouse documents, build chain of title, and determine mineral ownership. Document abstraction uses Google Gemini 3.1 Flash Lite; final title synthesis and follow-ups use Anthropic Claude Sonnet. It runs on Google Cloud Run with Neon Postgres and Google Cloud Storage.

> **Important:** This tool is an AI-assisted research aid, not a legal opinion. Always verify output against source documents and consult a licensed attorney before any drilling, leasing, or division order action.

---

## What this guide covers

This README is a **step-by-step setup guide**. Follow the parts in order:

1. [How it works (2-minute overview)](#how-it-works)
2. [Part 1 — Get the code](#part-1--get-the-code)
3. [Part 2 — Set up Neon Postgres](#part-2--set-up-neon-postgres)
4. [Part 3 — Get your AI API keys (Gemini + Anthropic)](#part-3--get-your-ai-api-keys)
5. [Part 4 — Set up Google Cloud](#part-4--set-up-google-cloud)
6. [Part 5 — Run it locally](#part-5--run-it-locally)
7. [Part 6 — Deploy to Cloud Run](#part-6--deploy-to-cloud-run)
8. [Optional — Using OpenRouter instead of direct API keys](#optional--using-openrouter)
9. [Environment variable reference](#environment-variable-reference)
10. [Troubleshooting](#troubleshooting)
11. [Cost notes](#cost-notes)

If you just want to run it on your own laptop, you only need **Part 1, Part 2, Part 3, and Part 5**. Google Cloud (Part 4 and Part 6) is only required for the hosted production deployment.

---

## How it works

The app is made of two services plus two managed data stores:

- **Web/API service** (`server.js`) — serves the web page (`public/index.html`) and the `/api/*` routes. The browser talks to this.
- **Worker service** (`worker.js`) — processes abstraction and synthesis work in the background from the database queue.
- **Neon Postgres** — stores jobs, documents, abstracts, synthesis segments, final results, and follow-up messages.
- **Google Cloud Storage (GCS)** — stores the uploaded PDFs/images. The browser uploads files **directly** to GCS using signed URLs, so document bytes never pass through the API.

The flow: the browser creates a job → uploads files straight to GCS → starts abstraction/synthesis → polls for status → renders the result. Gemini reads each document; Claude Sonnet writes the final title opinion.

---

## Part 1 — Get the code

This project runs on both **Windows** and **macOS**. You need **Node.js 22** and **git**. Pick your OS below; after the install step, the `git` / `npm` commands are identical on both.

### Windows

1. Install **Node.js 22 (LTS)** from [nodejs.org](https://nodejs.org/en/download) — run the `.msi` installer and accept the defaults.
2. Install **Git for Windows** from [git-scm.com/download/win](https://git-scm.com/download/win).
3. Open **PowerShell** (or Git Bash) and run:
   ```powershell
   git clone <your-repo-url>
   cd Titlework-analyzer
   npm install
   npm test
   ```

> Use PowerShell or Git Bash, not the legacy `cmd.exe`. All commands in this guide work in PowerShell.

### macOS

1. Install **Node.js 22** — either the `.pkg` from [nodejs.org](https://nodejs.org/en/download), or with Homebrew: `brew install node@22`.
2. Git ships with the Xcode Command Line Tools. If you don't have it, run `xcode-select --install` (or `brew install git`).
3. Open **Terminal** and run:
   ```bash
   git clone <your-repo-url>
   cd Titlework-analyzer
   npm install
   npm test
   ```

All tests should pass on either OS. If they do, the code is healthy and you can move on to wiring up services.

---

## Part 2 — Set up Neon Postgres

Neon is a serverless Postgres database. It has a free tier that is plenty to get started.

1. Go to **[neon.tech](https://neon.tech)** and sign up (you can use your Google or GitHub account).
2. Click **Create Project**. Give it a name (e.g. `titlework`), pick a region close to where you'll deploy, and leave the Postgres version at the default. Click **Create**.
3. After the project is created, Neon shows a **Connection string**. On that screen:
   - Make sure the **"Pooled connection"** toggle is **ON**. The app needs the *pooled* string for Cloud Run.
   - Copy the full string. It looks like:
     ```
     postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
     ```
     Notice the host contains **`-pooler`** — that confirms it's the pooled string.
4. Save this string. This is your **`DATABASE_URL`**.

> **Why pooled?** Cloud Run can spin up many short-lived instances. The pooled connection keeps database connection count (and cost) low while the app uses ordinary Postgres tables and SQL.

The app creates its own tables on first run — you do **not** need to run any migration scripts by hand.

---

## Part 3 — Get your AI API keys

The app uses two AI providers by default. (You can route both through OpenRouter instead — see [the OpenRouter section](#optional--using-openrouter). But the simplest path is direct keys.)

### 3a. Gemini API key (document abstraction)

1. Go to **[Google AI Studio → API keys](https://aistudio.google.com/apikey)**.
2. Sign in with your Google account.
3. Click **Create API key** (you can create it in a new or existing Google Cloud project).
4. Copy the key. This is your **`GEMINI_API_KEY`**.

Gemini 3.1 Flash Lite reads every uploaded document and produces a structured abstract. It also handles partial synthesis on large jobs.

### 3b. Anthropic API key (final title opinion + follow-ups)

1. Go to **[console.anthropic.com](https://console.anthropic.com)** and sign up / sign in.
2. Add a payment method under **Billing** (the final-merge model is a paid model).
3. Open **API Keys → Create Key**, name it, and copy the value (starts with `sk-ant-...`).
4. This is your **`ANTHROPIC_API_KEY`**.

Claude Sonnet 4.6 writes the **final title opinion**, answers follow-up questions, and can optionally re-read low-confidence documents ("escalation").

> Keep **both** keys configured. Gemini does the bulk reading; Claude does the final reasoning. Neither one replaces the other in the default setup.

---

## Part 4 — Set up Google Cloud

> Skip this entire part if you only want to run the app locally. You still need a **GCS bucket** for file storage even locally, but you can defer Cloud Run hosting until you're ready.

You'll use the **`gcloud`** command-line tool for most of this. Install it for your OS, then run `gcloud auth login`:

- **Windows:** download and run the [Google Cloud CLI installer](https://cloud.google.com/sdk/docs/install#windows) (`.exe`), then use the commands below in PowerShell.
- **macOS:** install with `brew install --cask google-cloud-sdk`, or follow the [macOS instructions](https://cloud.google.com/sdk/docs/install#mac).

The `gcloud` commands themselves are identical on both platforms.

### 4a. Create or select a project

```bash
gcloud projects create my-titlework-project   # or skip if you already have one
gcloud config set project my-titlework-project
```

Make sure **billing is enabled** for the project in the [Cloud Console → Billing](https://console.cloud.google.com/billing) page (Cloud Run, Storage, and Artifact Registry require it).

### 4b. Enable the required APIs

```bash
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  storage.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
```

These cover Cloud Run, the Docker image registry, Cloud Storage, and the IAM/token services used for secure deploys.

### 4c. Create a private storage bucket

This bucket holds uploaded PDFs and split chunks. Keep it **private**.

```bash
gcloud storage buckets create gs://my-titlework-bucket \
  --location=US \
  --uniform-bucket-level-access
```

The bucket name (`my-titlework-bucket`) is your **`GCS_BUCKET`** value.

### 4d. Allow browser uploads (CORS)

Browsers upload directly to GCS, so the bucket must allow `PUT` requests from your app's origin. Create a file called `cors.json`:

```json
[
  {
    "origin": ["https://YOUR-API-SERVICE-URL", "http://localhost:8080"],
    "method": ["PUT", "GET", "HEAD"],
    "responseHeader": ["content-type"],
    "maxAgeSeconds": 3600
  }
]
```

Replace `YOUR-API-SERVICE-URL` with your deployed Cloud Run URL (you'll get it in Part 6 — you can come back and update this later). Apply it:

```bash
gcloud storage buckets update gs://my-titlework-bucket --cors-file=cors.json
```

### 4e. Create a runtime service account

This is the identity the running Cloud Run services use. It needs read/write on the bucket and read on any secrets you store.

```bash
gcloud iam service-accounts create titlework-runtime \
  --display-name="Titlework Cloud Run runtime"

# Give it object read/write on the bucket
gcloud storage buckets add-iam-policy-binding gs://my-titlework-bucket \
  --member="serviceAccount:titlework-runtime@my-titlework-project.iam.gserviceaccount.com" \
  --role="roles/storage.objectAdmin"
```

If you store API keys in **Secret Manager** (recommended for production), also grant `roles/secretmanager.secretAccessor` to this account.

### 4f. (For automated deploys) Workload Identity Federation

The included GitHub Actions workflow deploys without long-lived keys, using Workload Identity Federation (WIF) so GitHub can authenticate to Google Cloud via OIDC. This is the most involved one-time setup. The high-level steps:

1. Create a **deploy** service account (separate from the runtime one above) and grant it: Artifact Registry writer, Cloud Run admin/deployer, `roles/iam.serviceAccountTokenCreator`, and `roles/iam.serviceAccountUser` on the runtime account.
2. Create a Workload Identity **pool** and **provider** scoped to your GitHub repository.
3. Bind the deploy service account to the repo-scoped WIF principal.

Google's official walkthrough is the most reliable reference: **[Deploying to Cloud Run from GitHub using WIF](https://github.com/google-github-actions/auth#setting-up-workload-identity-federation)**. Once done, you'll have a provider resource name and the deploy service account email — both go into GitHub variables in [Part 6](#part-6--deploy-to-cloud-run).

---

## Part 5 — Run it locally

Once you have `DATABASE_URL`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, and `GCS_BUCKET`, create a file named **`.env.local`** in the project root with one variable per line:

```ini
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=sk-ant-your-key
GCS_BUCKET=my-titlework-bucket
APP_PASSWORD=pick-a-password
```

`.env.local` is already git-ignored, so your keys never get committed. Both `KEY=value` and `export KEY='value'` lines are accepted — Node reads this file directly via the `npm run dev` scripts below, so the **same command works on Windows and Mac** (no `source` step needed).

> For local GCS access you also need Google application-default credentials. Run this once (same on both OSes — see [Part 4](#part-4--set-up-google-cloud) for installing `gcloud`):
> ```bash
> gcloud auth application-default login
> ```

### Windows

In **PowerShell**, from the project folder:

```powershell
npm run dev
```

Open the URL it prints (default `http://localhost:8080`). To also run the background worker, open a **second** PowerShell window in the same folder:

```powershell
npm run dev:worker
```

### macOS

In **Terminal**, from the project folder:

```bash
npm run dev
```

Open the URL it prints (default `http://localhost:8080`). To also run the background worker, open a **second** Terminal tab in the same folder:

```bash
npm run dev:worker
```

You can now upload documents and build a title chain locally.

> **`npm run dev` vs `npm start`:** `dev` loads `.env.local` for you and is what you use on your laptop. Plain `npm start` / `npm run start:worker` read configuration from the real process environment instead and are what the Cloud Run container uses in production — don't use them locally unless you've exported the variables yourself.

---

## Part 6 — Deploy to Cloud Run

Production deploys are fully automated by GitHub Actions (`.github/workflows/release.yml`). You don't run `gcloud run deploy` by hand for normal releases — you push a version tag.

### 6a. Configure GitHub repository variables

In your GitHub repo, go to **Settings → Secrets and variables → Actions → Variables** and add:

| Name | Value |
|------|-------|
| `GCP_PROJECT_ID` | Your Google Cloud project ID. |
| `GCP_REGION` | Cloud Run + Artifact Registry region (this project uses `us-south1`). |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | The WIF provider resource name from [Part 4f](#4f-for-automated-deploys-workload-identity-federation). |
| `GCP_SERVICE_ACCOUNT` | The **deploy** service account email. |
| `GCP_RUNTIME_SERVICE_ACCOUNT` | The **runtime** service account email (optional but recommended). |
| `GAR_REPOSITORY` | Your Artifact Registry Docker repository name. |
| `API_SERVICE` | API Cloud Run service name, e.g. `titlework-analyzer-api`. |
| `WORKER_SERVICE` | Worker Cloud Run service name, e.g. `titlework-analyzer-worker`. |

Create the Artifact Registry repo once if you haven't:

```bash
gcloud artifacts repositories create YOUR_GAR_REPOSITORY \
  --repository-format=docker \
  --location=us-south1
```

### 6b. Set the app's environment variables on both Cloud Run services

`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `APP_PASSWORD`, `DATABASE_URL`, and `GCS_BUCKET` must be set on **both** the API and worker Cloud Run services — through the Cloud Run console (Edit & deploy → Variables & Secrets) or Secret Manager. The release workflow checks that the required variable **names** are present, but it does not store secret **values** in GitHub.

### 6c. Cut a release

Push a lowercase `vX.Y.Z` tag that exactly matches the version in `package.json`:

```bash
VERSION="v$(node -p "require('./package.json').version")"
git tag "$VERSION"
git push origin "$VERSION"
```

The workflow then: runs tests on Node 22 → builds one Docker image → pushes it to Artifact Registry → resolves the immutable image digest → deploys the **worker first**, then the **API** from that same digest → verifies the deployment → creates/updates the GitHub Release.

> **Do not** leave Cloud Build or Cloud Run source-deploy triggers on `main`. They can race the tag workflow and overwrite the verified release image. GitHub Actions `Release` is the only production deploy path.

### 6d. Verify the release

After a release, confirm:

- API `/api/healthz` reports the expected `release.version`, `release.gitSha`, and `release.imageDigest`.
- API and worker latest-ready revisions use the **same immutable image digest**.
- Both services have database, GCS, Gemini, Anthropic, and app-password config.
- GCS CORS allows `PUT` uploads from the API origin with the `content-type` header.
- `gh release list --limit 3` marks the new version as `Latest`.

### Rollback

Rollback API and worker together to a previously verified image digest:

```bash
gcloud run deploy titlework-analyzer-worker \
  --image PREVIOUS_IMAGE_DIGEST_REF --region us-south1 \
  --command npm --args run,start:worker --no-allow-unauthenticated

gcloud run deploy titlework-analyzer-api \
  --image PREVIOUS_IMAGE_DIGEST_REF --region us-south1 \
  --allow-unauthenticated
```

Then confirm both latest-ready revisions report the same digest. Database changes are forward-only.

---

## Optional — Using OpenRouter

[OpenRouter](https://openrouter.ai) is a single gateway that proxies many model providers behind one API key. Use it if you'd rather manage **one** key and one bill instead of separate Gemini and Anthropic accounts, or if you want OpenRouter's routing/fallback features.

### When to use it

- **Use direct keys (default)** for the lowest latency and direct provider billing.
- **Use OpenRouter** to consolidate billing or experiment with routing through one provider.

### Step by step

1. Go to **[openrouter.ai](https://openrouter.ai)** and sign up.
2. Add credit under **[Credits](https://openrouter.ai/credits)** (OpenRouter is prepaid).
3. Open **[Keys → Create Key](https://openrouter.ai/keys)** and copy the value. It starts with `sk-or-...`. This is your **`OPENROUTER_API_KEY`**.
4. Turn the gateway on by setting **both**:
   ```bash
   OPENROUTER_API_KEY=sk-or-your-key
   MODEL_PROVIDER=openrouter
   ```
   Set these in `.env.local` for local use, or on both Cloud Run services for production.
5. (Optional) Set attribution headers so your usage shows up nicely on the OpenRouter dashboard:
   ```bash
   OPENROUTER_REFERER=https://your-app-url
   OPENROUTER_TITLE=Titlework Analyzer
   ```

When `MODEL_PROVIDER=openrouter` is set, model calls route through OpenRouter instead of hitting Anthropic/Gemini directly. Leave `MODEL_PROVIDER` unset (or any other value) to use direct routing. You can keep your direct `GEMINI_API_KEY` / `ANTHROPIC_API_KEY` configured as a fallback.

---

## Environment variable reference

`DATABASE_URL`, `GCS_BUCKET`, and at least one model provider are required; everything else has a sensible default. Set variables on **both** Cloud Run services unless the **Notes** column says otherwise.

### Core (you almost always set these)

| Name | Required | Notes |
|------|----------|-------|
| `DATABASE_URL` | Yes | Neon **pooled** Postgres URL, usually ending in `?sslmode=require`. |
| `GCS_BUCKET` | Yes | Private bucket for uploaded source chunks and split PDFs. |
| `GEMINI_API_KEY` | Yes | Google AI Studio key for abstraction + partial synthesis (`gemini-3.1-flash-lite`). Also accepts `GOOGLE_API_KEY`. |
| `ANTHROPIC_API_KEY` | Yes (unless using OpenRouter) | Anthropic key for the final opinion (Sonnet), follow-ups, and optional escalation. |
| `APP_PASSWORD` | Yes for production | Password gate for users; release verification expects it on both services. |

### OpenRouter (only if you use the gateway)

| Name | Required | Notes |
|------|----------|-------|
| `OPENROUTER_API_KEY` | When OpenRouter is used | OpenRouter API key (`sk-or-...`). |
| `MODEL_PROVIDER` | Optional | `openrouter` flips the global toggle. Unset / any other value = direct routing. |
| `OPENROUTER_REFERER` | Optional | Overrides the `HTTP-Referer` attribution header. |
| `OPENROUTER_TITLE` | Optional | Overrides the `X-Title` attribution header. |

### Model selection & tuning

| Name | Notes |
|------|-------|
| `SYNTHESIS_MODEL` | Default `claude-sonnet-4-6` for the final opinion and merge. Gemini/Haiku values are ignored. |
| `SYNTHESIS_PARTIAL_MODEL` | Default `gemini-3.1-flash-lite` for large-job segment synthesis only. Haiku/Claude values are ignored. |
| `ABSTRACT_MODEL` | Default `gemini-3.1-flash-lite`. Claude Haiku is not supported for abstraction. |
| `ABSTRACT_ESCALATION_MODEL` | Default `claude-sonnet-4-6`. Used for re-reads of low-confidence abstracts (requires Anthropic). |
| `GEMINI_THINKING_BUDGET` | **Gemini 2.5 only.** Default `0` (off). `-1` = dynamic, or a token count. Ignored on Gemini 3.x. |
| `GEMINI_THINKING_LEVEL` | **Gemini 3.x only.** `minimal`/`low`/`medium`/`high`. Production default `minimal` (best OCR accuracy on scans). |
| `GEMINI_INCLUDE_THOUGHTS` | When `true`, Gemini may return thought summaries (exposed as `thoughtSummaries`, never mixed into abstracts). Debug only. |

### Synthesis sizing & speed

| Name | Notes |
|------|-------|
| `SYNTHESIS_CHUNK_SIZE` | Default `120` (max `250`). Max grouped docs per partial synthesis segment. |
| `BULK_SYNTHESIS_CHUNK_SIZE` | Default `200` for jobs with ≥100 abstracts. |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | Default `5000` for Gemini partial segment output. |
| `SYNTHESIS_MAX_TOKENS` | Default `6000`. |
| `SYNTHESIS_BATCH_LIMIT` | Default `4` (max `16`). Segments claimed per `/synthesis/process` batch. Production sets `8`. |
| `SYNTHESIS_STREAM_ENABLED` | Default off. Streams the final Sonnet merge to `GET /api/jobs/:id/synthesis/preview`; opinion saved after stream completes. |
| `SYNTHESIS_COMPACTION_ENABLED` | Default on. Compacts ≥6 segments (or large merge input) via Gemini before the final Sonnet merge. |
| `SYNTHESIS_COMPACTION_MIN_SEGMENTS` | Default `6`. |
| `SYNTHESIS_COMPACTION_MIN_MERGE_TOKENS` | Default `40000`. |
| `SYNTHESIS_LARGE_JOB_MULTI_SEGMENT` | Default off. Forces multi-segment Gemini partial synthesis above `BULK_JOB_MIN_ABSTRACTS`. |
| `SYNTHESIS_FORCE_SINGLE_PASS` | When `true`, opts out of multi-segment forcing. |

### Abstraction

| Name | Notes |
|------|-------|
| `ABSTRACT_MAX_TOKENS` | Default `2000`. |
| `ABSTRACTION_PDF_TEXT_FIRST` | Default `true`. Use extracted PDF text when quality checks pass (lower token cost). |
| `ABSTRACTION_PDF_TEXT_STRICT` | Default `false`. Tightens text-first gates so borderline scans use visual PDF. |
| `ABSTRACTION_BATCH_ENABLED` | Default `true`. Batch up to 24 small chunks per abstraction call on the worker. |
| `ABSTRACTION_BATCH_MAX_DOCS` | Default `24` (max `48`). |
| `ABSTRACTION_BATCH_MAX_PAGE_SPAN` | Default `32`. Larger page-range chunks stay solo. |
| `ABSTRACTION_ESCALATION_ENABLED` | Default `true`. Set `false` to skip Sonnet re-reads on low-confidence abstracts. |
| `GEMINI_FILE_API_ENABLED` | Default `true`. Upload large visual PDFs/images via Gemini Files API instead of base64. |
| `GEMINI_FILE_API_MIN_BYTES` | Default `1500000`. Minimum blob size to use Files API. |
| `GEMINI_FILE_API_MAX_BYTES` | Default `48000000`. Maximum Files API upload size. |

### Worker, queue & limits

| Name | Notes |
|------|-------|
| `WORKER_DISABLED` | Worker only. Production default `true` (loop off, scale-to-zero). Set `false` for unattended background processing. |
| `WORKER_POLL_IDLE_MS` | Worker only. Default `2000` when running and idle. |
| `WORKER_POLL_ACTIVE_MS` | Worker only. Default `0` (no sleep between busy passes). |
| `WORKER_POLL_INTERVAL_MS` | Worker only. Legacy idle fallback. Default `5000`; prefer `WORKER_POLL_IDLE_MS`. |
| `WORKFLOW_KICK_ON_START` | API. Default `true`. Runs a bounded background batch when abstraction/synthesis start is called. |
| `WORKFLOW_KICK_BUDGET_MS` | API. Default `50000` per start kick (under the 60s API limit). |
| `WORKFLOW_BATCH_LIMIT` | Default `12`. |
| `WORKFLOW_CONCURRENCY` | Default `4`. |
| `WORKFLOW_BUDGET_MS` | Default `1200000` (20 min). |
| `WORKFLOW_LEASE_MS` / `WORKFLOW_STALE_LEASE_MS` | Defaults sized above the model upstream timeout. |
| `SYNTHESIS_MERGE_LEASE_MS` / `SYNTHESIS_STALE_LEASE_MS` | Defaults sized above the synthesis upstream timeout. |
| `ANALYZE_MAX_REQUEST_BYTES` | Default `20000000`. |
| `ANALYZE_UPSTREAM_TIMEOUT_MS` | API only. Default `240000`. |
| `ABSTRACTION_UPSTREAM_TIMEOUT_MS` | Worker only. Default `240000`; sizes abstraction leases. |
| `SYNTHESIS_UPSTREAM_TIMEOUT_MS` | Worker only. Default `240000`; sizes synthesis leases. |
| `CLOUD_RUN_UPSTREAM_TIMEOUT_MS` | Shared fallback for abstraction/synthesis upstream timeouts. |
| `STORAGE_MAX_UPLOAD_BYTES` | Default `104857600` (100 MB). |
| `ANALYZE_RATE_LIMIT_MAX` | Default `300` requests/minute/IP. |

### Set automatically by the release workflow

| Name | Notes |
|------|-------|
| `RELEASE_VERSION` | From the release tag. |
| `GIT_SHA` | From the deployed commit. |
| `IMAGE_DIGEST` | From the immutable container digest. |

---

## Troubleshooting

**`Google Cloud Storage is not configured`**
Set `GCS_BUCKET` on both Cloud Run services and grant the runtime service account object permissions on the bucket.

**`DATABASE_URL or POSTGRES_URL is required`**
Set `DATABASE_URL` to your Neon **pooled** connection string.

**Uploads fail with CORS errors**
Configure the GCS bucket CORS policy to allow `PUT` from the web/API origin with the `content-type` header (see [Part 4d](#4d-allow-browser-uploads-cors)).

**Jobs stay queued or abstracting**
Confirm the worker is deployed and has `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `DATABASE_URL`, and `GCS_BUCKET`, and can reach Neon. If `WORKER_DISABLED=true` (production default), keep the browser tab open so the API kicks process the job.

**Model timeouts or rate limits**
Lower `WORKFLOW_CONCURRENCY` or `WORKFLOW_BATCH_LIMIT`, or raise your Gemini/Anthropic rate limits. Retryable errors are saved as durable `retry_wait` rows and resume automatically.

---

## Cost notes

Cloud Run and GCS are billed by Google Cloud usage; Neon can start on its **free tier**. **Gemini** (abstraction + partial synthesis) and **Anthropic** (final opinion, follow-ups, optional escalation) are billed separately by each provider. Cost scales with document count, page count, scan resolution, and title complexity.

### Typical 300-document job (no PDF splits)

Roughly **~305 model calls**: 300 abstraction + ~4 partial synthesis segments + 1 final Sonnet merge.

| Stage | Model | Role |
|-------|--------|------|
| Abstraction | `gemini-3.1-flash-lite` | One call per chunk (fewer with worker batching) |
| Partial synthesis | `gemini-3.1-flash-lite` | Segment summaries before merge |
| Final opinion | `claude-sonnet-4-6` | Single merge + follow-ups |

A full 300-doc run is typically on the order of **~$1.50–3** in model tokens on the Gemini + Sonnet stack, dominated by the final Sonnet merge. App `/api/*` polling and GCS uploads are separate from token cost.

### Cost knobs

| Knob | Effect |
|------|--------|
| `ABSTRACTION_PDF_TEXT_FIRST=true` (default) | Biggest savings on text-native PDFs: sends extracted text instead of visual blocks. |
| `ABSTRACTION_BATCH_ENABLED=true` | Fewer abstraction **calls** (up to 24 small chunks per request). |
| `GEMINI_FILE_API_ENABLED=true` | Keeps large scanned PDFs whole instead of page-splitting for envelope limits. |
| `ABSTRACT_MAX_TOKENS=2000`, `SYNTHESIS_MAX_TOKENS=6000` | Caps output spend without changing prompts. |
| `GEMINI_THINKING_LEVEL=minimal` (production default) | Best OCR accuracy on scans; higher levels cost more without improving transcription. |
| `ABSTRACTION_ESCALATION_ENABLED=false` | Avoids relatively expensive Sonnet re-runs on low-confidence abstracts. |

The app does **not** use Anthropic/Gemini Batch APIs (24h window, no completion notification). Reliability and progress polling stay on the durable worker + Neon job model.

---

## Features

- Bulk upload up to 400 documents per job.
- Direct browser-to-GCS durable uploads (bytes never pass through the API).
- Server-side abstraction with Gemini 3.1 Flash Lite. The worker batches small chunks, and the browser-only fallback can group up to 24 small documents per call while still page-splitting oversized single PDFs.
- Final title synthesis and follow-ups with Claude Sonnet 4.6.
- Durable job URLs that survive refreshes and closed tabs.
- Retry, cancellation, partial-failure, and failed-chunk recovery.
- PDF download of final results.
- Optional OpenRouter gateway support.

## Security

| Protection | Detail |
|-----------|--------|
| Password gate | Optional `APP_PASSWORD` header/session gate. |
| Rate limiting | Configurable `ANALYZE_RATE_LIMIT_MAX`, default 300 req/min/IP. |
| Direct uploads | Browser uploads go to signed GCS URLs; document bytes do not pass through `/api/analyze`. |
| Private storage | Source files live in a private GCS bucket. |
| Durable metadata | Postgres stores metadata, refs, abstracts, results, and sanitized errors. |
| No raw payload persistence | API validators reject base64/raw document fields in job metadata routes. |
| CSP | Allows app origin plus Google Cloud Storage upload endpoints. |

## Project structure

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
├── server.js          # web/API service
├── worker.js          # background worker service
├── Dockerfile
├── package.json
└── test/
```
