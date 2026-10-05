# AGENTS.md

## Project: Mineral Ownership Builder (`title-analyzer`)

AI title-chain research tool for landmen. Node 22 ESM, zero web framework
(`node:http` in `server.js`). The page heading is Mineral Ownership Builder,
the document `<title>` is Mineral Title Analyzer, and `README.md` calls the
product Titlework Analyzer. Full setup (Neon, API keys, GCS, Cloud Run) lives
in `README.md` — follow it; this file is a pointer, not a copy.

- Services: `server.js` (API + static `public/index.html`, default port 8080)
  and `worker.js` (queue loop). The worker health server stays up when the
  loop is off and exposes `GET /healthz` and `POST /internal/drain`.
  Drain requires `INTERNAL_DRAIN_TOKEN` via `X-Internal-Drain-Token`
  (`secureCompare`). Production (`NODE_ENV=production` or Cloud Run
  `K_SERVICE`) fails closed when the token is unset. The production caller
  is Cloud Scheduler; it must send the header (see
  `docs/worker-synthesis-scheduler-runbook.md`).
- Data: Neon Postgres. `api/_lib/jobs.js` validates, stores, and migrates
  inline in `ensureSchema` (`CREATE TABLE IF NOT EXISTS` and
  `ADD COLUMN IF NOT EXISTS`). No migration files. GCS signed URLs live in
  `api/_lib/storage.js`; the browser uploads straight to the bucket.
- AI: `gemini-3.1-flash-lite` abstracts each chunk (`api/_lib/abstraction.js`)
  and writes partial synthesis on large jobs. `claude-sonnet-5-5` writes the
  final opinion, answers follow-ups, and re-reads low-confidence abstracts
  (`api/_lib/synthesis.js`, `ABSTRACT_ESCALATION_MODEL`).
  `MODEL_PROVIDER=openrouter` sends calls through OpenRouter
  (`shouldUseOpenRouter` in `api/_lib/openrouter-request.js`, used by
  `api/_lib/model-client.js`). A model id that already contains `/` takes
  that route too. `claude-sonnet-5-5` maps to OpenRouter `anthropic/claude-sonnet-5.5`.
- Frontend is one file: `public/index.html` (~4.4k lines).

### Commands

- `npm install`, then `npm test`. The `test` script is the explicit `&&`
  chain in `package.json` and stops at the first failing file. Each file is
  a small script with its own `assert` / `test()` helper. A new file runs in
  CI only after it is added to that script.
- Outside the chain: `node test/openrouter-request.test.js` and
  `node test/openrouter-stream.test.js`. `test/smoke-server.js` is a manual
  server on port 3456.
- CI (`.github/workflows/test.yml`, pull requests and pushes to `main`) runs
  `npm ci`, `npm test`, and `docker build` on Node 22. There is no lint script.
- Local dev loads git-ignored `.env.local`: `npm run dev`, plus
  `npm run dev:worker` in a second terminal. Open `http://localhost:8080`.
  With no `.env.local`, `npm run dev` exits before listen (`node --env-file`
  requires the file).
- `npm start` / `npm run start:worker` read the process environment (the
  container command). Use them when the variables are already set.

### Do not break

- Chunk claims are one conditional `UPDATE ... RETURNING`
  (`claimChunkForAbstraction`). The `WHERE` admits `pending`, a due
  `retry_wait`, an expired lease, or the same worker's current lease.
- Abstract persistence saves only while that worker still holds the
  processing lease (`saveDocumentAbstract`). A lost race returns null and
  the caller reports `stale`.
- Changing an existing abstract's text deletes cached `job_results` and
  clears the synthesis plan and preview inside `saveDocumentAbstract`,
  unless `preserveSynthesisPlan` is set.
- `processSynthesisJob` re-reads the job and skips the final merge when
  status is `canceled`, on both the all-segments-complete path and the
  degraded failed-segment path (fixed 2026-09). A late cancel must not
  start a billable Sonnet merge.
- Status transitions go through `VALID_TRANSITIONS` and `TERMINAL_STATUSES`
  in `api/_lib/jobs.js`. Update both when adding a state.
- Re-saving the same `planId` in `saveSynthesisPlan` is safe in production:
  the segment `ON CONFLICT DO UPDATE` writes bounds, document ids, filenames,
  and estimated bytes. `createMemoryPhase5Store` in `test/synthesis.test.js`
  is a Map mock, not that SQL.
- Claude request bodies are `model`, `max_tokens`, `system`, and `messages`
  (`buildMessagesRequestBody` in `api/_lib/anthropic-request.js`). Sonnet 5
  and Sonnet 5.5 reject `thinking`, `temperature`, `top_p`, and `top_k`.

### Safety

- A job id (`job_` + UUID) plus one shared `APP_PASSWORD` is the access
  check. There is no per-user ACL; leave that design in place.
  `docs/phase-2-durable-storage.md` still describes session-scoped rows and
  Vercel Blob. The code is the contract.
- `requireJobPassword` (`api/_lib/jobs.js`) allows the request when
  `APP_PASSWORD` is unset. `requireServerAbstractionPassword`
  (`api/jobs/[...path].js`) is the extra gate on abstraction and synthesis
  start/status/process/preview, retry, follow-up, and the abstract list. It
  checks `x-app-password` with `secureCompare` and returns 401 when
  `APP_PASSWORD` is unset.
- The rate-limit IP is the rightmost `X-Forwarded-For` hop (`getClientIp`
  in `api/_lib/client-ip.js`), the hop Cloud Run appends.
- `POST /internal/drain` (`worker.js`) verifies `x-internal-drain-token`
  against `INTERNAL_DRAIN_TOKEN` via `secureCompare`. Production fails closed
  when that token is unset. Set it on the worker before a release that
  includes the check, and send the same value from Cloud Scheduler.
  `/healthz` stays unauthenticated. The worker is still deployed
  `--no-allow-unauthenticated`; Cloud Run IAM is the outer gate.
- Ignored local state: `.env*` (except placeholder `.env.example`),
  `.tmp-gcloud/`, `scripts/ocr-comparison-results/`, and
  `scripts/sample-docs/`.
- The final merge and escalation re-reads are billable Sonnet calls. Do not
  add a retry or fallback that fires them again on its own.

### Release

Bump `package.json` and both root version fields in `package-lock.json`
(top-level `"version"` and `packages[""].version`). Add
`docs/releases/vX.Y.Z.md`. Push `main`, then push a lowercase `vX.Y.Z` tag
that matches `package.json`. Follow README "Cut a release".

`.github/workflows/release.yml` runs the tests, deploys the worker and then
the API from the same image digest, runs `scripts/verify-release.mjs`, and
creates the GitHub Release. A normal release does not use `gcloud run deploy`.
Leave Cloud Build and Cloud Run source-deploy triggers off `main`.

`node test/release.test.js` checks tag shape, the release workflow, and
exact phrases in `README.md` and `SECURITY.md`. Run it before editing those
files. Lockfile versions and `docs/releases/` are manual; that test does not
read them.

### Production vs local

- Production sets `WORKER_DISABLED=true` (loop off, `--min-instances 0`).
  The release workflow does not create a Cloud Scheduler job. An open
  browser tab drives work: `/abstraction/process` and `/synthesis/process`
  kick a bounded batch (`WORKFLOW_KICK_ON_START`). Optional scheduler setup
  is `docs/worker-synthesis-scheduler-runbook.md`. The worker service needs
  `INTERNAL_DRAIN_TOKEN` before that scheduler can call `POST /internal/drain`.
- Elsewhere, run `npm run dev:worker`, or leave the tab open so the same
  API kick processes the job.

## Cursor Cloud specific instructions

`npm test` needs no API keys, database, or `.env.local`. `npm run dev`
needs that file or it exits before listen.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
