# Worker-Driven Synthesis (Scale-to-Zero Backup) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a scale-to-zero worker that finishes synthesis (segments + merge) for any job whose browser tab has closed, so long merges complete server-side without the tab staying open — at near-zero idle cost. The browser keeps driving while open; the worker is a **backup** (the merge lease serializes the two).

**Architecture:** The worker service already runs an HTTP server (`worker.js` → `createWorkerHealthServer`) at `--min-instances 0` with `--timeout 3600`. Add a `POST /internal/drain` endpoint that runs the existing `runWorkerLoop` bounded by `maxIdleCycles: 1` (drain until idle) and a time budget. Cloud Scheduler pings it every minute (OIDC). No browser driving code changes; only the keep-tab notice is relaxed.

**Tech Stack:** Node 22 ESM; custom `assert`/`test()` harnesses run via `npm test`; `node:http` server in `worker.js`; Neon Postgres store; Cloud Run + Cloud Scheduler.

---

## Background (read first)

Synthesis is driven by the browser repeatedly calling `/synthesis/process` (runs `processSynthesisBatch` → `processSynthesisJob`). The shipped 1800s API request timeout already lets the browser's own merge complete (churn fixed). The remaining gap: if the user closes the tab, nothing finishes the job. This plan adds a worker that drains runnable synthesis on a schedule, as a backup.

Why backup (not sole driver): `claimSynthesisMerge` ([api/_lib/jobs.js:2223](../../../api/_lib/jobs.js)) grants the merge lease to only one caller; the other's `claimFinalWriter()` returns null and skips. Segment claims are likewise leased. So browser + worker running concurrently is conflict-free — no browser code needs removal.

Key existing pieces:
- `runWorkerOnce` / `runWorkerLoop` ([api/_lib/cloud-run-worker.js:62,103](../../../api/_lib/cloud-run-worker.js)). `runWorkerLoop` already supports `options.signal` and `maxIdleCycles` and stops on the first idle pass when `maxIdleCycles: 1`.
- `runWorkerOnce` defaults `store = options.store || getJobStore()`, so a drain needs no explicit store in production.
- `createWorkerHealthServer()` ([worker.js:27](../../../worker.js)) — the HTTP server (currently only `/healthz`). `startWorker()` calls it with no args; the server runs even when `WORKER_DISABLED=true`.
- The worker deploy already sets `--timeout 3600 --min-instances 0 --no-cpu-throttling` and runs `worker.js`, so **no `release.yml` change is needed**.

## File Structure

- **`api/_lib/cloud-run-worker.js`** — add `runWorkerDrain(options)`: a thin, time-bounded wrapper over `runWorkerLoop({ ...options, maxIdleCycles: 1 })`. One responsibility: "drain all runnable work once, then return."
- **`worker.js`** — extend `createWorkerHealthServer` to accept an injectable `{ drain }` and serve `POST /internal/drain`. Keeps the server as the worker's single HTTP surface.
- **`public/index.html`** — relax the keep-tab notice during synthesis (notice text only; no driving change).
- **`test/worker.test.js`** — tests for `runWorkerDrain` and the `/internal/drain` route.
- **`test/app.test.js`** — assertion for the relaxed synthesis notice.
- **`docs/worker-synthesis-scheduler-runbook.md`** (new) — exact gcloud commands for the Cloud Scheduler job + IAM, plus a smoke test.

---

## Task 1: Worker bounded-drain + `/internal/drain` endpoint

**Files:**
- Modify: `api/_lib/cloud-run-worker.js` (add `runWorkerDrain`)
- Modify: `worker.js` (`createWorkerHealthServer` route + import)
- Test: `test/worker.test.js`

- [ ] **Step 1: Write the failing tests**

In `test/worker.test.js`, add `runWorkerDrain` to the existing import from `../api/_lib/cloud-run-worker.js` (currently `import { runWorkerLoop, runWorkerOnce } from '../api/_lib/cloud-run-worker.js';`), then add:

```js
test('runWorkerDrain processes runnable synthesis once then stops on idle', async () => {
  let synthCalls = 0;
  let listCalls = 0;
  const store = {
    async listRunnableAbstractionJobIds() { return []; },
    async listRunnableSynthesisJobIds() { listCalls += 1; return listCalls === 1 ? ['job_syn_1'] : []; },
  };
  const controller = new AbortController(); // pass a signal so no internal deadline timer is used
  const result = await runWorkerDrain({
    store,
    signal: controller.signal,
    idlePollIntervalMs: 1,
    processSynthesis: async () => { synthCalls += 1; },
  });
  assert(synthCalls === 1, `Expected exactly one synthesis pass, got ${synthCalls}`);
  assert(result.iterations >= 2, `Expected the drain to loop until an idle pass, got ${result.iterations}`);
});

test('worker /internal/drain endpoint runs a drain and returns its summary', async () => {
  const server = createWorkerHealthServer({ drain: async () => ({ synthesisJobs: 2, errors: [], hasWork: true }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const response = await new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/internal/drain', method: 'POST' }, res => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, data }));
    });
    req.on('error', reject);
    req.end();
  });
  server.close();
  assert(response.status === 200, `Expected 200, got ${response.status}`);
  const parsed = JSON.parse(response.data);
  assert(parsed.ok === true && parsed.synthesisJobs === 2, `Expected drain summary, got ${response.data}`);
});
```

(`createWorkerHealthServer` and `request` are already imported in `test/worker.test.js`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/worker.test.js`
Expected: FAIL — `runWorkerDrain is not a function`, and the `/internal/drain` request returns 404 (route not implemented).

- [ ] **Step 3: Implement `runWorkerDrain`**

In `api/_lib/cloud-run-worker.js`, add after `runWorkerLoop` (end of file):

```js
export async function runWorkerDrain(options = {}) {
  // Drain all runnable jobs once (stop on the first idle pass). When no caller
  // signal is supplied, bound the drain with a time budget under the worker's
  // request timeout so the HTTP response always returns.
  if (options.signal) {
    return runWorkerLoop({ ...options, maxIdleCycles: 1 });
  }
  const controller = new AbortController();
  const budgetMs = clampPollMs(options.drainBudgetMs ?? process.env.WORKER_DRAIN_BUDGET_MS, 1_500_000, 10_000, 3_300_000);
  const timer = setTimeout(() => controller.abort(), budgetMs);
  try {
    return await runWorkerLoop({ ...options, signal: controller.signal, maxIdleCycles: 1 });
  } finally {
    clearTimeout(timer);
  }
}
```

(`clampPollMs` is already defined in this file.)

- [ ] **Step 4: Implement the `/internal/drain` route**

In `worker.js`, add `runWorkerDrain` to the cloud-run-worker import:

```js
import { runWorkerLoop, runWorkerDrain } from './api/_lib/cloud-run-worker.js';
```

Then replace `createWorkerHealthServer` with:

```js
export function createWorkerHealthServer({ drain } = {}) {
  const runDrain = drain || (() => runWorkerDrain());
  let draining = false;
  return createServer((req, res) => {
    if (req.url === '/healthz') {
      const body = JSON.stringify({ ok: true, service: 'title-analyzer-worker', release: getRuntimeInfo() });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }
    if (req.method === 'POST' && req.url === '/internal/drain') {
      if (draining) {
        const body = JSON.stringify({ ok: true, busy: true });
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      draining = true;
      runDrain()
        .then(result => {
          const body = JSON.stringify({ ok: true, ...result });
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
          res.end(body);
        })
        .catch(err => {
          const body = JSON.stringify({ ok: false, error: err?.message || String(err) });
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
          res.end(body);
        })
        .finally(() => { draining = false; });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not found.' }));
  });
}
```

(`startWorker` already calls `createWorkerHealthServer()` with no args — the default `runDrain` applies, no change needed there.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `node test/worker.test.js`
Expected: PASS — both new tests pass; existing worker tests still pass.

- [ ] **Step 6: Commit**

```bash
git add api/_lib/cloud-run-worker.js worker.js test/worker.test.js
git commit -m "feat: add worker /internal/drain endpoint for scheduler-triggered synthesis"
```

---

## Task 2: Relax the keep-tab notice during synthesis

**Files:**
- Modify: `public/index.html` (notice constant + helper; one call site in `runServerSynthesis`)
- Test: `test/app.test.js`

- [ ] **Step 1: Write the failing test**

In `test/app.test.js`, add:

```js
test('server synthesis tells the user the tab can be closed', () => {
  assert(script.includes('SERVER_SYNTHESIS_NOTICE'), 'Expected a server-synthesis notice constant');
  assert(/close this tab/i.test(script), 'Expected the synthesis notice to say the tab can be closed');
  assert(script.includes('showServerSynthesisNotice()'), 'Expected runServerSynthesis to show the server-synthesis notice');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/app.test.js`
Expected: FAIL — `SERVER_SYNTHESIS_NOTICE` / `showServerSynthesisNotice` not present.

- [ ] **Step 3: Add the notice and use it in `runServerSynthesis`**

In `public/index.html`, immediately after the `KEEP_OPEN_NOTICE` block (the `showKeepOpenNotice` / `clearKeepOpenNotice` functions), add:

```js
const SERVER_SYNTHESIS_NOTICE = 'Synthesis is running on the server. You can safely close this tab — the result is saved and will be here when you return.';

function showServerSynthesisNotice() {
  document.getElementById('infoBox').innerHTML = `<div class="info-msg">${esc(SERVER_SYNTHESIS_NOTICE)}</div>`;
}
```

Then, in `runServerSynthesis`, change its first line from `showKeepOpenNotice();` to `showServerSynthesisNotice();`. Match the function signature to keep the edit unique:

```js
async function runServerSynthesis(jobId, totalDocs, items, onProgress) {
  showServerSynthesisNotice();
```

Leave `runServerDocumentAbstraction`'s `showKeepOpenNotice()` call unchanged (abstraction still needs the tab).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/app.test.js`
Expected: PASS — the new assertion passes and `index.html JavaScript parses` still passes.

- [ ] **Step 5: Commit**

```bash
git add public/index.html test/app.test.js
git commit -m "feat: tell users the tab can be closed once server synthesis starts"
```

---

## Task 3: Cloud Scheduler + IAM runbook (manual infra)

**Files:**
- Create: `docs/worker-synthesis-scheduler-runbook.md`

There is no automated test — this documents one-time infrastructure the operator runs. Verification is the smoke test in the runbook after the worker is deployed.

- [ ] **Step 1: Write the runbook**

Create `docs/worker-synthesis-scheduler-runbook.md` with:

````markdown
# Worker Synthesis Scheduler — Setup Runbook

One-time setup so the scale-to-zero worker finishes synthesis for jobs whose
browser tab has closed. Run **after** a release that includes the worker
`POST /internal/drain` endpoint.

```bash
PROJECT=titlework-analyzer
REGION=us-south1
WORKER=titlework-analyzer-worker
WORKER_URL=https://titlework-analyzer-worker-rqpu63u5tq-vp.a.run.app
SA=synthesis-scheduler@${PROJECT}.iam.gserviceaccount.com

# 1. Service account that Cloud Scheduler uses to invoke the worker
gcloud iam service-accounts create synthesis-scheduler \
  --project "$PROJECT" --display-name "Synthesis worker scheduler"

# 2. Allow it to invoke the (private) worker service
gcloud run services add-iam-policy-binding "$WORKER" \
  --project "$PROJECT" --region "$REGION" \
  --member "serviceAccount:${SA}" --role roles/run.invoker

# 3. Cloud Scheduler job: POST /internal/drain every minute with an OIDC token.
#    NOTE: --location must be a Cloud Scheduler-supported region. If us-south1
#    is unsupported, run `gcloud scheduler locations list` and pick the nearest.
gcloud scheduler jobs create http synthesis-drain \
  --project "$PROJECT" --location "$REGION" \
  --schedule "* * * * *" \
  --uri "${WORKER_URL}/internal/drain" --http-method POST \
  --oidc-service-account-email "$SA" \
  --oidc-token-audience "$WORKER_URL"
```

## Smoke test (after deploy)

```bash
curl -s -X POST \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${WORKER_URL}/internal/drain"
# Expect: {"ok":true,...}  (your account needs roles/run.invoker on the worker)
```

## Rollout order

1. Deploy a release that includes the worker `/internal/drain` endpoint.
2. Run steps 1–3 above.
3. Confirm with the smoke test.

If the scheduler is paused/deleted, synthesis simply reverts to today's
browser-driven behavior (tab must stay open) — no breakage.
````

- [ ] **Step 2: Commit**

```bash
git add docs/worker-synthesis-scheduler-runbook.md
git commit -m "docs: add worker synthesis scheduler setup runbook"
```

---

## Final verification

- [ ] **Run the full suite**

Run: `npm test`
Expected: exit 0, all files pass (worker.test.js and app.test.js include the new tests).

---

## Self-Review

**1. Spec coverage:**
- Worker HTTP `/internal/drain` running a bounded `runWorkerLoop` → Task 1.
- Browser unchanged except notice → Task 2 (notice only; no driving removed, matching backup-driver).
- Cloud Scheduler + OIDC/IAM + rollout → Task 3 (runbook).
- "No `release.yml` change" — confirmed (worker already has `--timeout 3600 --min-instances 0`); no task needed.
- Error isolation / backstop / scheduler dependency — covered by reusing `runWorkerOnce` (per-job error isolation) and the runbook's "no breakage if scheduler absent" note.

**2. Placeholder scan:** none — every code/step is concrete; the runbook uses the real project/region/worker URL with a documented caveat for the scheduler location.

**3. Type/name consistency:** `runWorkerDrain(options)` defined in Task 1 is imported and used as the default `drain` in `worker.js`; the endpoint returns `{ ok, ...result }` where `result` is the `runWorkerLoop` summary (`{ iterations, idleCycles, aborted }`) — the route test asserts on an *injected* stub summary (`synthesisJobs`), and the `runWorkerDrain` unit test asserts on the real loop summary (`iterations`). `showServerSynthesisNotice` / `SERVER_SYNTHESIS_NOTICE` are defined and referenced consistently in Task 2.
