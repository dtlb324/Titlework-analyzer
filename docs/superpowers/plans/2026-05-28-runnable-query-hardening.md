# Runnable-Query Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the scale-to-zero worker from churning indefinitely on synthesis jobs whose abstraction never finished, by excluding those jobs from the runnable-synthesis set (aligning it with the synthesis-start guard).

**Architecture:** `listRunnableSynthesisJobIds` returns `status='synthesizing'` jobs that have no segments yet — including abandoned jobs whose abstraction is incomplete. `planJobSynthesis` then rejects them (`getAbstractionStatus` shows `pending/processing/retry_wait` blockers), but they stay runnable, so the worker drain never goes idle and exceeds the scheduler's attempt deadline. Add one SQL condition so a job is only "runnable for synthesis" when its abstraction chunks are all complete/failed.

**Tech Stack:** Node 22 ESM; Neon Postgres (`api/_lib/jobs.js`); Cloud Scheduler + Cloud Run worker. Tests run via `npm test`.

---

## Background (read first)

The worker `/internal/drain` (shipped in v2.4.21, currently behind a **paused** Cloud Scheduler job) drains all runnable synthesis. On activation it churned on **7 zombie jobs** all failing with *"Synthesis cannot start until all abstraction chunks are completed or failed."* Root cause: the runnable query and the start guard disagree.

- Runnable query: [api/_lib/jobs.js:1977-2009](../../../api/_lib/jobs.js) — returns `status='synthesizing'` + no result + (`s.id IS NULL` OR pending/stale segments OR mergeable). The `s.id IS NULL` branch matches jobs that never got segments because synthesis was never planned (abstraction incomplete).
- Start guard: [api/_lib/synthesis.js:1250-1257](../../../api/_lib/synthesis.js) — `getAbstractionStatus(jobId)`; if `pending + processing + retry_wait > 0`, throw and refuse to start.

So the query offers jobs the guard then refuses → infinite churn. The fix makes the query require what the guard requires.

**Testing note:** `listRunnableSynthesisJobIds` exists **only** in the Postgres store and is *mocked* in every test (`test/worker.test.js`); there is no DB-backed test harness. So the SQL change is verified by full-suite regression (it's imported widely), code inspection, and live validation against the production DB / post-deploy logs — not a unit test. This matches how other SQL-store changes in this repo are verified.

## File Structure

- **`api/_lib/jobs.js`** — add one `NOT EXISTS` condition to `listRunnableSynthesisJobIds`. No new files; no interface change.
- **`docs/worker-synthesis-scheduler-runbook.md`** — finalize to match what actually works (API-enable step, `us-central1` location, raised attempt deadline). Already created in v2.4.21.

---

## Task 1: Exclude abstraction-incomplete jobs from the runnable-synthesis query

**Files:**
- Modify: `api/_lib/jobs.js` (`listRunnableSynthesisJobIds`, ~line 1988)

- [ ] **Step 1: Make the edit**

In `api/_lib/jobs.js`, in `listRunnableSynthesisJobIds`, change:

```js
        WHERE j.status = 'synthesizing'
          AND r.job_id IS NULL
          AND (
            s.id IS NULL
```

to:

```js
        WHERE j.status = 'synthesizing'
          AND r.job_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM document_chunks c
            WHERE c.job_id = j.id
              AND c.abstraction_status IN ('pending', 'processing', 'retry_wait')
          )
          AND (
            s.id IS NULL
```

This adds a top-level requirement that the job has no abstraction chunk still pending/processing/retry_wait — exactly the blocker set the start guard checks. There is an index `idx_document_chunks_abstraction_status ON document_chunks(job_id, abstraction_status)`, so the subquery is cheap.

- [ ] **Step 2: Syntax + import check**

Run: `node --check api/_lib/jobs.js`
Expected: no output (valid). (`jobs.js` is a template-literal SQL string, so this confirms no JS breakage.)

- [ ] **Step 3: Full-suite regression**

Run: `npm test`
Expected: exit 0, all files pass. (`jobs.js` is imported by many tests; this confirms the edit didn't break the module. The SQL query itself is not exercised by tests — see the Testing note.)

- [ ] **Step 4: Commit**

```bash
git add api/_lib/jobs.js
git commit -m "fix: exclude abstraction-incomplete jobs from runnable synthesis set"
```

- [ ] **Step 5: Live validation (after deploy, before un-pausing the scheduler)**

This is the real verification, since there is no unit test. After a release that includes this change is deployed:

1. Resume the scheduler: `gcloud scheduler jobs resume synthesis-drain --location us-central1 --project titlework-analyzer`
2. Wait ~2 minutes, then confirm the churn is gone — no new `worker_synthesis_error` for the abstraction-incomplete jobs:
   ```bash
   gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="titlework-analyzer-worker" AND jsonPayload.event="worker_synthesis_error" AND jsonPayload.reason:"abstraction chunks"' --project titlework-analyzer --freshness=5m --limit 5
   ```
   Expected: empty (the 7 zombies no longer enter the drain).
3. Confirm scheduler attempts now succeed:
   ```bash
   gcloud logging read 'resource.type="cloud_scheduler_job" AND resource.labels.job_id="synthesis-drain"' --project titlework-analyzer --freshness=5m --limit 3 --format="value(jsonPayload.status)"
   ```
   Expected: idle drains return quickly (no DEADLINE_EXCEEDED on an idle system).

---

## Task 2: Finalize scheduler config + runbook for safe re-activation

**Why:** Even with Task 1, a *legitimate* long merge run by the worker can exceed Cloud Scheduler's **default 180s attempt deadline**, causing a 504 and a mid-merge connection cut. Raise the deadline so the scheduler waits for a real drain. Also correct the runbook to what actually works.

**Files:**
- Modify: `docs/worker-synthesis-scheduler-runbook.md`

- [ ] **Step 1: Raise the scheduler attempt deadline (one-time infra command)**

```bash
gcloud scheduler jobs update http synthesis-drain \
  --location us-central1 --project titlework-analyzer \
  --attempt-deadline 1800s
```
(1800s = the Cloud Scheduler HTTP maximum, comfortably above the worker's ~25-min drain budget. While a long merge holds the merge lease, concurrent per-minute scheduled drains find the lease held and return fast/idle, so there is no pile-up.)

- [ ] **Step 2: Update the runbook to match reality**

In `docs/worker-synthesis-scheduler-runbook.md`, make these corrections (the original was written before activation):
- Add a first step: `gcloud services enable cloudscheduler.googleapis.com --project titlework-analyzer` (the API was not enabled).
- Change the scheduler `--location` from `us-south1` to **`us-central1`** (us-south1 is not a Cloud Scheduler region).
- Add `--attempt-deadline 1800s` to the `jobs create http` command (and document why).
- Note that the live validation is "resume the job + confirm no `worker_synthesis_error` churn + idle drains return fast," per Task 1 Step 5.

- [ ] **Step 3: Commit**

```bash
git add docs/worker-synthesis-scheduler-runbook.md
git commit -m "docs: finalize scheduler runbook (api enable, us-central1, attempt deadline)"
```

---

## Out of scope (noted, not in this plan)

- **Cleaning the 7 stuck jobs.** Task 1 stops them churning, but they remain `status='synthesizing'` and inert. Marking them failed/canceled is a data operation done via the app/DB (not from here). A future "expire stale synthesizing jobs → failed" sweep could automate this.
- **Root cause of the inconsistency** (how a job reaches `status='synthesizing'` with incomplete abstraction). Worth a separate investigation; this plan only stops the symptom (churn).
- **Fail-after-N-errors safety net** for *other* perpetual synthesis errors. The abstraction case is the one observed; generalize later if another perpetual-error class appears.

## Self-Review

**1. Spec coverage:** The approved design was "add one SQL condition to exclude abstraction-incomplete jobs from the runnable set." → Task 1. The discovered prerequisite (scheduler attempt deadline) + runbook accuracy → Task 2. Stuck-job cleanup + root cause + fail-after-N → explicitly out of scope (matches the approved "query fix only").

**2. Placeholder scan:** No TBD/vague steps. The one code change shows exact before/after SQL; commands are concrete with expected output. The absence of a unit test is stated honestly (no DB harness) with a concrete live-validation procedure instead.

**3. Consistency:** The `NOT EXISTS` blocker set (`pending`, `processing`, `retry_wait`) matches the start guard's `getAbstractionStatus` blocker sum exactly. `document_chunks.abstraction_status` is the real column (indexed). The scheduler job name (`synthesis-drain`), location (`us-central1`), and worker service match what was provisioned.
