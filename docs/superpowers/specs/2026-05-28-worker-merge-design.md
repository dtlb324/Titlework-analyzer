# Worker-Driven Synthesis (Scale-to-Zero Merge) — Design

**Date:** 2026-05-28
**Status:** Approved (brainstorming) — pending implementation plan

## Background

Large multi-segment synthesis merges run far longer than the API's 300s Cloud Run request timeout. Because synthesis is driven by the browser calling `/synthesis/process` (which runs `processSynthesisBatch` → segments + merge synchronously), each long merge attempt is killed mid-stream at 300s, re-claimed, and restarted — observed ~10× on a single job (`job_24888896`), burning Sonnet tokens. Diagnosis confirmed the binding constraint is the **request timeout**, not lease theft.

Two stopgaps already shipped (v2.4.21 draft): the API request timeout was raised to 1800s, and the final merge got its own higher output-token cap. This design is the **durable fix**: move synthesis off the browser-held request entirely, onto a worker that has no request-timeout/tab dependency, while keeping the worker **scale-to-zero** (no always-on instance cost).

The worker service already exists (`titlework-analyzer-worker`, `min-instances 0`) and the codebase already has `runWorkerOnce` — a single drain pass over runnable jobs — and `runWorkerLoop` — the always-on variant ([api/_lib/cloud-run-worker.js](../../../api/_lib/cloud-run-worker.js)). A continuous loop would require `min-instances ≥ 1` (always-on cost); a **triggered** worker runs the same drain logic at `min-instances 0`.

## Goal

Add a scale-to-zero worker, triggered by Cloud Scheduler, that finishes synthesis (segments + final merge) for any job whose browser tab has closed — so long merges complete server-side without requiring the tab to stay open, at near-zero idle cost. The browser keeps driving while open; the worker is a **backup** driver. (Churn was already fixed by raising the API request timeout to 1800s; this work adds tab-independence.)

## Non-Goals

- Moving **abstraction** to the worker (stays browser-driven for now).
- Cloud Tasks / Pub-Sub triggering (Cloud Scheduler only).
- Removing the existing client-side terminal-failure fallback (unchanged).
- Removing `/synthesis/process` (kept; the browser simply stops calling it for synthesis).

## Architecture

The worker becomes an **HTTP service** at `min-instances 0` with a long `--timeout`, exposing one authenticated endpoint:

- `POST /internal/drain` → runs `runWorkerLoop({ maxIdleCycles: 1, signal: <deadline> })` (drain until no runnable work or a time budget under the request timeout), returns `{ synthesisJobs, errors, hasMoreWork }`.

Cloud Scheduler pings `/internal/drain` ~every minute (OIDC auth). The worker is a **backup** synthesis driver: the browser keeps driving while its tab is open, and the worker finishes any job whose tab has closed. The merge lease (`claimSynthesisMerge`) serializes the two — only one runs the merge at a time — so both-drivers is conflict-free, and no browser code needs to be removed.

## Components

### App code

1. **Worker entrypoint / HTTP server** (the `start:worker` command + `api/_lib/cloud-run-worker.js`)
   - A small HTTP server listening on `process.env.PORT`, exposing `POST /internal/drain`.
   - The handler runs `runWorkerLoop` with `maxIdleCycles: 1` and an `AbortController` signal that fires at a time budget (e.g. 25 min, < the 30-min request timeout). `runWorkerLoop` already supports `options.signal` and `maxIdleCycles`.
   - A simple in-process guard skips overlapping drains (returns 200 "busy") — concurrent drains are *safe* anyway via the existing lease/claim idempotency, this just avoids wasted work.
   - `runWorkerLoop` (continuous) is retained for local development behind a flag/separate command.

2. **Browser flow** ([public/index.html](../../../public/index.html), `runServerSynthesis`)
   - **Driving unchanged:** the browser keeps its existing synthesis kicks. The merge lease prevents conflicts with the worker, so no browser driving code is removed.
   - **Notice only:** relax the keep-tab notice during synthesis to tell users the result is saved server-side and the tab can be closed. The notice still applies to the browser-driven abstraction phase.

### Infrastructure (documented; not app code)

3. **Worker deploy** (`.github/workflows/release.yml`)
   - `--timeout 1800`, `--min-instances 0` (already), `--no-cpu-throttling` (already), `--command` → the HTTP server entrypoint.
   - No longer depends on `WORKER_DISABLED`.

4. **Cloud Scheduler + auth**
   - A scheduler job (every 1 min) issues `POST` to the worker `/internal/drain` URL with an **OIDC** token.
   - A service account granted `roles/run.invoker` on the worker; the worker stays `--no-allow-unauthenticated`.
   - High-level setup (exact commands in the plan/runbook): `gcloud scheduler jobs create http ... --oidc-service-account-email ... --oidc-token-audience <worker-url>`.

## Data Flow

1. Upload → abstraction (browser-driven, unchanged) → `POST /synthesis/start` (saves plan, status `synthesizing`) → browser polls `/synthesis/status`.
2. Cloud Scheduler (≈1 min cadence) → `POST /internal/drain` (OIDC) on the worker.
3. Worker: `runWorkerLoop(maxIdleCycles:1, signal:<deadline>)` → `runWorkerOnce` → `listRunnableSynthesisJobIds` → `processSynthesisBatch` per job (segments, then the merge when segments complete, under the long worker timeout) → result saved → worker scales to zero.
4. Browser poll observes `complete` and fetches the result. The tab may have been closed during synthesis; on return, status/result are durable.

## Error Handling & Operations

- `runWorkerOnce` already isolates per-job errors; `/internal/drain` returns 200 with a summary so one failing job doesn't abort the sweep. The next scheduler tick retries.
- The 1-min scheduler is the backstop for stalled work. Worker death mid-merge is covered by the existing merge lease logic and the crash-recovery shipped in v2.4.21 (a completed-but-unsaved preview is reused, not re-merged).
- **Operational dependency (flagged):** if the scheduler is paused or deleted, server synthesis stalls — jobs sit in `synthesizing` (visible via status), at no instance cost. Reliability rests on the scheduler being healthy; monitoring the scheduler job is recommended.

## Rollout / Sequencing

Because the browser keeps driving synthesis, there is no undriven window to worry about. Order: deploy the worker `/internal/drain` endpoint → provision the Cloud Scheduler job + worker IAM. The notice tweak can ship anytime. If the scheduler is ever absent or paused, behavior simply reverts to today's browser-only driving (tab must stay open) — no breakage.

## Testing

- **Drain endpoint (unit):** with the in-memory store + mock model client, seed a multi-segment job at `synthesizing`, invoke the drain handler directly (no browser kick), and assert the job reaches a saved result. Extend [test/worker.test.js](../../../test/worker.test.js) / [test/cloud-run.test.js](../../../test/cloud-run.test.js).
- **Browser notice:** assert (via the index.html script tests) that `runServerSynthesis` shows the relaxed server-synthesis notice (result saved server-side, tab can be closed).
- **OIDC/IAM and the scheduler job:** verified via the deploy runbook, not unit tests.

## Risks / Open Considerations

- **Scheduler as a single point of dependency** (see Operations). Acceptable given scale-to-zero cost and durable job state; revisit with Cloud Tasks if instant pickup or stronger delivery guarantees become necessary.
- **Pickup latency** up to ~1 min per phase from the poll cadence — negligible against multi-minute synthesis.
- **Cold starts** on each drain add seconds of latency — irrelevant for background synthesis.
