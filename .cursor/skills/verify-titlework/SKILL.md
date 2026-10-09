---
name: verify-titlework
description: >-
  Drive the Titlework Analyzer web UI (page heading Mineral Ownership Builder,
  document title Mineral Title Analyzer) in an isolated local server and capture
  proof. Use when changing public/index.html, server.js page routes, the password
  gate, document upload, job creation, recent jobs, the job view, or follow-up
  questions, and when a change needs evidence from the running app.
---

# Verify Titlework Analyzer

The primary surface is the web UI in `public/index.html`, served by `server.js`. A job id plus one shared `APP_PASSWORD` is the access check. Durable jobs, uploads, abstracts, and the final opinion need Neon (`DATABASE_URL`), Google Cloud Storage (`GCS_BUCKET`), and model keys. Those calls are billable. This skill drives a real browser against a real server. It does not click through a mock page.

Secondary surfaces, not the default drive:

- `worker.js` serves `GET /healthz` and `POST /internal/drain` on its own port. The default API port and the worker port are both 8080. Do not start the worker for a UI proof.
- `/ocr-compare.html` is the OCR lab. Submitting **Compare OCR** sends page images to model providers and is billable. Do not submit it from this skill.

`npm test` does not start the server and is not a substitute for this drive.

## Launch

From the repository root, with Node 22. Install dependencies once if `node_modules` is missing (`npm install`). Do not use `npm run dev` for this instance: that command requires `.env.local` and loads whatever secrets are in it. Do not use port 8080.

```bash
RUN_ID="verify-$$"
RUN_DIR="/tmp/titlework-verify-$RUN_ID"
mkdir -p "$RUN_DIR"
node .cursor/skills/verify-titlework/verify.mjs launch --port 4173 --run-dir "$RUN_DIR"
```

Ready when launch prints `"ok": true` and `"baseUrl": "http://127.0.0.1:4173"`. The server log line is `{"event":"server_listening","port":4173}` in `$RUN_DIR/server.log`. Export the printed base URL:

```bash
BASE_URL="http://127.0.0.1:4173"
```

Launch strips `NODE_ENV`, `K_SERVICE`, database URLs, `APP_PASSWORD`, `GCS_BUCKET`, and model keys from the child process. The printed `"isolated": true` means this instance will refuse job creation with HTTP 503 and will not call a model. That is the safe default.

If port 4173 is taken, stop. Do not attach to the existing process. Clean up if this launch created state, pick a free port other than 8080, and start a new `--run-dir`. Two instances can run together only with different ports and different run directories. They must not share a Chrome profile or a database.

A password-gate launch is a different instance. Use a throwaway password and a different run directory and port:

```bash
node .cursor/skills/verify-titlework/verify.mjs launch --port 4174 --run-dir "$RUN_DIR" --password verify-local
```

`--keep-env` keeps the parent environment, including a real database and keys. Do not pass it against production data or production keys. A click on **Build Chain of Title** would create a job and can spend model calls.

Teardown is `cleanup` below. Run it after a failed launch too.

## Doctor

Run this before driving, and again whenever the page looks wrong:

```bash
node .cursor/skills/verify-titlework/verify.mjs doctor --run-dir "$RUN_DIR"
```

Doctor is the instance worth driving only when every line below is true:

- `"ok": true`
- `pid` is running and its command line includes `server.js`
- `listenerPids` includes that `pid` on `port`
- `service` is `title-analyzer`
- `version` equals `expectedVersion` (`v` plus `package.json` `version`)
- `baseUrl` is the URL this run launched, not `http://localhost:8080`

Read `isolated` and `passwordRequired` before choosing a feature. An isolated server has no durable jobs. A server with `passwordRequired: true` shows **Access Required** until the password is entered. Doctor does not send the password. When launch used `--password`, doctor does not ping `/api/analyze`, because a wrong or missing password counts toward the five-failure lockout.

## Drive

The harness is `.cursor/skills/verify-titlework/verify.mjs`. Chrome runs headless with its own user-data directory inside the run directory. There is no Playwright suite in this repo. Stable handles are element ids and the hash routes. Visible labels are not wired with `for` attributes, so role-and-name lookups are the wrong handle here.

Every browser or http command takes `--run-dir "$RUN_DIR"`. Commands print one JSON object on stdout. A missing selector, a disabled click, or a doctor problem exits non-zero and prints JSON on stderr.

```bash
node .cursor/skills/verify-titlework/verify.mjs browser open --run-dir "$RUN_DIR" --url "$BASE_URL/"
node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#mainApp" --visible
node .cursor/skills/verify-titlework/verify.mjs browser fill --run-dir "$RUN_DIR" --selector "#tractDescription" --value "Verification tract"
node .cursor/skills/verify-titlework/verify.mjs browser upload --run-dir "$RUN_DIR" --selector "#fileInput" --file "$RUN_DIR/verification.csv"
node .cursor/skills/verify-titlework/verify.mjs browser click --run-dir "$RUN_DIR" --selector "#analyzeBtn"
node .cursor/skills/verify-titlework/verify.mjs browser text --run-dir "$RUN_DIR" --selector "#fileList"
node .cursor/skills/verify-titlework/verify.mjs browser prop --run-dir "$RUN_DIR" --selector "#analyzeBtn" --name disabled
node .cursor/skills/verify-titlework/verify.mjs browser attr --run-dir "$RUN_DIR" --selector "#recentJobsButton" --name aria-disabled
node .cursor/skills/verify-titlework/verify.mjs browser snapshot --run-dir "$RUN_DIR" --path "$ARTIFACTS/start-analysis/page.json"
node .cursor/skills/verify-titlework/verify.mjs browser screenshot --run-dir "$RUN_DIR" --path "$ARTIFACTS/start-analysis/page.png" --selector "#uploadSection"
node .cursor/skills/verify-titlework/verify.mjs http POST --run-dir "$RUN_DIR" /api/jobs --json '{"subjectTract":"Verification tract","contextNotes":"Verification notes","totalDocuments":1}' --expect 503
```

`browser snapshot` records the document title, the `h1`, the hash, which views are visible, the tract and notes values, whether **Build Chain of Title** is disabled, the file list, the error text, and whether follow-up is visible. `browser wait` accepts `--visible`, `--hidden`, `--text`, and `--timeout` (milliseconds). `browser upload` sets `#fileInput` (the control is `display: none`). Do not click `#uploadZone`; that opens a native file dialog.

Hash routes, after the main app is visible:

- `#/` home upload
- `#/jobs` recent jobs
- `#/job/<id>` one job

The feature map is the source of which path to drive. A proof that only opens the home page is incomplete when the change sits on another file in that map. Read [features/README.md](features/README.md) first.

On an isolated server, drive the upload-ready state and the job-create refusal. Do not claim a finished ownership opinion. Building a real chain of title requires a disposable database, bucket, and model keys, and it spends money. Skip that path and say which precondition was missing.

## Evidence

Write proof under `/opt/cursor/artifacts/verify-titlework/<feature>/`. Create the directory before the snapshot. Cleanup must not delete it.

```bash
ARTIFACTS="/opt/cursor/artifacts/verify-titlework"
mkdir -p "$ARTIFACTS/start-analysis"
```

Proof standards:

- Drive the page the way a user does: open the URL, type, choose a file, click the button. Do not set `files` or job state from the console.
- Capture the action and the state it produced. For upload, save a snapshot and a screenshot while the file list is on screen and `#analyzeBtn` is enabled, then save another pair after the click.
- Check the side effect. On an isolated server the click and a direct `POST /api/jobs` both return the database-not-configured error and no `job.id`. Save the `http` JSON with `--out`.
- Keep the app identity in the shot: the heading **Mineral Ownership Builder** or the title **Mineral Title Analyzer**.
- Do not mock `/api/jobs`, `/api/analyze`, or model calls. The isolated server is the real server with those backends unset.
- There is no dry-run switch. Isolation is "those environment variables are unset," which you can see because job creation returns 503 and the server log has no model request.

## Cleanup

Kill only the server and Chrome pids recorded in the run directory, and only when `/proc/<pid>/cmdline` still contains `server.js` or `chrome`. Then delete the run directory. Proof files under `/opt/cursor/artifacts/verify-titlework/` stay.

```bash
node .cursor/skills/verify-titlework/verify.mjs cleanup --run-dir "$RUN_DIR"
```

Run cleanup after a failed attempt so the port and Chrome profile are not left behind. Do not kill processes by name.

## Helpers

`verify.mjs` is the only helper. It is executable. From the repository root:

```bash
node .cursor/skills/verify-titlework/verify.mjs launch --port 4173 --run-dir "$RUN_DIR"
node .cursor/skills/verify-titlework/verify.mjs doctor --run-dir "$RUN_DIR"
node .cursor/skills/verify-titlework/verify.mjs browser snapshot --run-dir "$RUN_DIR"
node .cursor/skills/verify-titlework/verify.mjs http GET --run-dir "$RUN_DIR" /api/healthz
node .cursor/skills/verify-titlework/verify.mjs cleanup --run-dir "$RUN_DIR"
```

`launch` accepts `--port`, `--run-dir`, `--password`, and `--keep-env`. `browser` accepts `open`, `goto`, `wait`, `fill`, `upload`, `click`, `text`, `prop`, `attr`, `screenshot`, and `snapshot`. `http` accepts a method and a path starting with `/`, plus `--json`, `--header Name:value`, `--expect`, and `--out`.

Keep the map current with `/maintain-verification-skill` when routes or controls change.
