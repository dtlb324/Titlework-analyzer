# Phase 6: Durable Jobs UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single-page Titlework analyzer into a job-centric experience with hash-routed views (`#/`, `#/job/{id}`, `#/jobs`), reload-safe progress, adaptive polling, explicit retry/cancel controls, and a recent-jobs panel — without introducing any frontend framework.

**Architecture:** Stay inside `public/index.html`. Add a logical "router" + "job views" section to the existing script. Keep the existing inline `analyze()` path as a browser-only fallback; when durable storage (`getDurableStorageStatus()`) reports available, the home view creates a job and navigates to `#/job/{id}`, which becomes the source-of-truth view that hydrates from server polling and renders progress / actions / results / follow-up. Recent jobs live in `localStorage` only (no server-side history endpoint).

**Tech Stack:** Plain ES2020 in a single HTML file. No bundler. Tests use the existing custom `test()`/`assert()` flat runner via `npm test`, which already string-scans `public/index.html` and exercises API handlers with mocked `req`/`res`.

**Canonical job statuses (backend-authoritative):** `created`, `uploading`, `ready`, `queued`, `planning`, `abstracting`, `synthesizing`, `complete`, `partial_failed`, `failed`, `canceled`. The phase-6 design doc uses `creating`, but the backend emits `created`; the UI must accept the backend's names.

**API surface (already shipped in phases 1–5; do not invent new endpoints):**

- `POST /api/jobs` — create job
- `GET /api/jobs/:id` — status snapshot (no `progressPercent`/`etaSeconds`; derive on client)
- `PATCH /api/jobs/:id` — progress patches from browser
- `POST /api/jobs/:id/cancel`
- `POST /api/jobs/:id/retry-failed`
- `POST /api/jobs/:id/chunks/:chunkId/retry`
- `POST /api/jobs/:id/abstraction/start | /process`, `GET .../abstraction/status`
- `POST /api/jobs/:id/synthesis/start | /process`, `GET .../synthesis/status`
- `GET /api/jobs/:id/result`
- `POST /api/jobs/:id/followup` (single Q+A pair per call)
- existing durable upload helpers (`POST .../documents`, `.../chunks`, `.../finalize-uploads`, `/api/blob/upload`)

---

## File Structure

**Modified files:**

- `public/index.html` (2762 lines today) — primary target.
  - Inside `<div class="container">`: wrap legacy upload card into `#view-home`, add empty `#view-job` and `#view-history` siblings.
  - In the existing inline `<script>` (starts ~line 190): add four new logical sections in order: `// === Phase 6: hash router ===`, `// === Phase 6: job view rendering ===`, `// === Phase 6: adaptive job polling ===`, `// === Phase 6: recent jobs (localStorage) ===`.
  - Replace `getJobLink()` (line 897), `getRequestedJobId()` (line 902), and `startJobPolling()` (line 1404).
  - Wire DOMContentLoaded handler (line 532) to call the router.
  - Rewire `analyze()` entry to create-and-navigate when durable.
- `test/app.test.js` — add Phase 6 assertions in the existing flat-style.

**Files NOT modified:** any `api/**` files. Phase 6 is UI-only.

**Important — file size:** `public/index.html` has grown organically across phases. Do not restructure unrelated code. Keep Phase 6 additions in clearly-labeled comment blocks so a later split is mechanical.

---

## Pre-flight

- [ ] **Step P1: Create a working branch.**

Run:
```bash
git checkout -b phase-6-durable-jobs-ui
```

- [ ] **Step P2: Establish a green baseline.**

Run: `npm test`
Expected: all existing tests pass. If anything is red on `main`, stop and surface to the user before continuing.

---

## Task 1: Hash router + view shells

**Files:**
- Modify: `public/index.html:97-188` (split `<div class="container">` into three view wrappers)
- Modify: `public/index.html:190` onward (add router script section)
- Modify: `public/index.html:897-912` (rewrite `getJobLink`, `getRequestedJobId`)
- Modify: `public/index.html:532-540` (DOMContentLoaded wires router)
- Test: `test/app.test.js`

- [ ] **Step 1.1: Add Phase 6 test stubs that fail.**

Append the following block to `test/app.test.js`, just before the `let passed = 0;` loop:

```javascript
// === Phase 6 ===

test('Phase 6: HTML defines view-home, view-job, view-history shells', () => {
  assert(indexHtml.includes('id="view-home"'), 'Missing #view-home wrapper');
  assert(indexHtml.includes('id="view-job"'), 'Missing #view-job wrapper');
  assert(indexHtml.includes('id="view-history"'), 'Missing #view-history wrapper');
});

test('Phase 6: hash router exposes parseHash and navigate', () => {
  assert(script.includes('function parseRoute'), 'Missing parseRoute() helper');
  assert(script.includes('function applyRoute'), 'Missing applyRoute() helper');
  assert(script.includes("window.addEventListener('hashchange'"), 'Router must listen for hashchange');
  assert(script.includes("'#/job/'") || script.includes('`#/job/'), 'Router must emit #/job/ links');
});

test('Phase 6: getJobLink emits hash route, getRequestedJobId reads it', () => {
  assert(script.includes('`${window.location.origin}${window.location.pathname}#/job/'),
    'getJobLink must emit hash route');
  assert(script.includes("hash.startsWith('#/job/')") || script.includes("startsWith('/job/')"),
    'getRequestedJobId must parse #/job/{id}');
});
```

- [ ] **Step 1.2: Run failing tests to verify they fail.**

Run: `node test/app.test.js`
Expected: the three new tests above fail with explicit "Missing #view-home wrapper", etc. Other tests still pass.

- [ ] **Step 1.3: Wrap legacy sections inside `#view-home`.**

In `public/index.html`, edit the block beginning at line 109. Change:

```html
  <div id="mainApp" style="display:none">

    <div class="card" id="uploadSection">
```

to:

```html
  <div id="mainApp" style="display:none">

    <div id="view-home" data-view="home">

    <div class="card" id="uploadSection">
```

Close `#view-home` by inserting `</div>` before the closing `</div>` of `#mainApp` (which is around line 187). Specifically, after the closing tag of `#addDocsSection`, insert `    </div> <!-- /#view-home -->` on its own line so the structure becomes:

```html
    <!-- Add More Documents panel -->
    <div id="addDocsSection" style="display:none">
      ...existing...
    </div>

    </div> <!-- /#view-home -->

    <div id="view-job" data-view="job" style="display:none"></div>
    <div id="view-history" data-view="history" style="display:none"></div>

  </div>
```

- [ ] **Step 1.4: Replace `getJobLink` and `getRequestedJobId` (lines 897-912).**

Replace the block with:

```javascript
function getJobLink(jobId) {
  if (!jobId || typeof window === 'undefined' || !window.location) return '';
  return `${window.location.origin}${window.location.pathname}#/job/${encodeURIComponent(jobId)}`;
}

function getRequestedJobId() {
  try {
    const hash = String(location.hash || '');
    // Preferred Phase 6 format
    if (hash.startsWith('#/job/')) {
      const id = decodeURIComponent(hash.slice('#/job/'.length).split(/[?&/]/)[0] || '');
      if (id) return id;
    }
    // Legacy ?job= and #job_* — normalize to hash route below.
    const params = new URLSearchParams(location.search || '');
    const fromQuery = params.get('job');
    if (fromQuery) return fromQuery;
    const raw = hash.replace(/^#/, '');
    return raw.startsWith('job_') ? raw : '';
  } catch {
    return '';
  }
}
```

- [ ] **Step 1.5: Add the router section after the existing storage helpers.**

Find the line `function getJobStorageKey() {` (around line 889) and insert this block **immediately above** it:

```javascript
// === Phase 6: hash router ===
function parseRoute() {
  try {
    const hash = String(location.hash || '');
    if (hash.startsWith('#/job/')) {
      const id = decodeURIComponent(hash.slice('#/job/'.length).split(/[?&/]/)[0] || '');
      return id ? { name: 'job', jobId: id } : { name: 'home' };
    }
    if (hash === '#/jobs' || hash.startsWith('#/jobs?')) return { name: 'history' };
    if (hash === '' || hash === '#' || hash === '#/') return { name: 'home' };
    // Legacy migration: ?job= or #job_* -> #/job/{id}
    const legacy = getRequestedJobId();
    if (legacy) {
      const clean = `${location.origin}${location.pathname}#/job/${encodeURIComponent(legacy)}`;
      history.replaceState({}, '', clean);
      return { name: 'job', jobId: legacy };
    }
    return { name: 'home' };
  } catch {
    return { name: 'home' };
  }
}

function navigate(route) {
  const next = route && route.startsWith('#') ? route : `#${route || '/'}`;
  if (location.hash === next) {
    applyRoute(parseRoute());
  } else {
    location.hash = next;
  }
}

function applyRoute(route) {
  const home = document.getElementById('view-home');
  const job = document.getElementById('view-job');
  const history = document.getElementById('view-history');
  if (!home || !job || !history) return;
  home.style.display = route.name === 'home' ? '' : 'none';
  job.style.display = route.name === 'job' ? '' : 'none';
  history.style.display = route.name === 'history' ? '' : 'none';
  if (route.name === 'job') {
    loadJobView(route.jobId).catch(err => console.warn('Job view load failed', err));
  } else if (route.name === 'history') {
    renderRecentJobsView();
  } else {
    stopJobPoller();
  }
}

// Placeholder until later tasks fill them in
async function loadJobView(jobId) {
  // Filled in by Task 4
  console.log('loadJobView stub', jobId);
}
function renderRecentJobsView() {
  // Filled in by Task 8
}
function stopJobPoller() {
  // Filled in by Task 3
  if (typeof activeJobPollTimer !== 'undefined' && activeJobPollTimer) {
    clearTimeout(activeJobPollTimer);
    clearInterval(activeJobPollTimer);
    activeJobPollTimer = null;
  }
}
```

- [ ] **Step 1.6: Wire router into DOMContentLoaded (line 532).**

Read lines 532-540 first, then modify the listener. After the existing setup calls (`checkPasswordRequired`, `setupDragDrop`, etc.) but before any `resumeLastAnalysisJob()` call, add:

```javascript
  window.addEventListener('hashchange', () => applyRoute(parseRoute()));
  applyRoute(parseRoute());
```

If `showMain()` (line 558) calls `resumeLastAnalysisJob()`, leave that call in place for now — it acts as a no-op when a hash route already points to a job (later tasks integrate it).

- [ ] **Step 1.7: Run tests.**

Run: `node test/app.test.js`
Expected: the three Phase 6 tests added in 1.1 now pass. All existing tests still pass.

- [ ] **Step 1.8: Commit.**

```bash
git add public/index.html test/app.test.js
git commit -m "phase 6 task 1: hash router + view shells"
```

---

## Task 2: Job status view DOM + status badge styling

**Files:**
- Modify: `public/index.html:10-82` (style block — add badge + stepper styles)
- Modify: `public/index.html:188` area (fill in `#view-job` inner DOM)
- Modify: `public/index.html` (add Phase 6 view-rendering section)
- Test: `test/app.test.js`

- [ ] **Step 2.1: Add failing tests for the job view DOM and renderers.**

Append to `test/app.test.js` (before the runner loop):

```javascript
test('Phase 6: #view-job contains required job page subsections', () => {
  assert(indexHtml.includes('id="jobHeader"'), 'Missing #jobHeader');
  assert(indexHtml.includes('id="jobProgress"'), 'Missing #jobProgress');
  assert(indexHtml.includes('id="jobStepper"'), 'Missing #jobStepper');
  assert(indexHtml.includes('id="jobDetail"'), 'Missing #jobDetail');
  assert(indexHtml.includes('id="jobActions"'), 'Missing #jobActions');
  assert(indexHtml.includes('id="jobResults"'), 'Missing #jobResults');
});

test('Phase 6: status badge CSS classes exist', () => {
  assert(indexHtml.includes('.status-badge'), 'Missing .status-badge style');
  assert(indexHtml.includes('.status-badge--complete'), 'Missing complete badge style');
  assert(indexHtml.includes('.status-badge--failed'), 'Missing failed badge style');
  assert(indexHtml.includes('.status-badge--partial'), 'Missing partial badge style');
});

test('Phase 6: job view renderers exist', () => {
  for (const fn of ['renderJobHeader', 'renderJobProgressView', 'renderJobStepper',
                    'renderJobDetail', 'renderJobActions', 'renderJobResults']) {
    assert(script.includes(`function ${fn}`), `Missing ${fn}()`);
  }
  assert(script.includes('JOB_STATUS_LABELS'), 'Missing canonical status label map');
});
```

- [ ] **Step 2.2: Run the failing tests.**

Run: `node test/app.test.js`
Expected: the three new tests fail; everything else passes.

- [ ] **Step 2.3: Add status-badge + stepper CSS.**

Find the closing `}` of the existing `<style>` block (approximately line 82) and insert these rules just before `</style>`:

```css
.status-badge { display:inline-block; padding:.18rem .65rem; border-radius:999px;
  font-size:.78rem; font-weight:600; background:#f3e7d8; color:#6b3410; }
.status-badge--active { background:#fce8d4; color:#b8631e; }
.status-badge--complete { background:#dfeadb; color:#4a7c4e; }
.status-badge--failed { background:#fce8e0; color:#d97755; }
.status-badge--partial { background:#fff1d6; color:#a06b13; }
.status-badge--canceled { background:#ece3d4; color:#8a6f4a; }

.job-stepper { display:flex; gap:.6rem; align-items:center; margin:.6rem 0 1rem; font-size:.85rem; color:#8a6f4a; }
.job-stepper .step { padding:.18rem .55rem; border-radius:6px; background:#f3e7d8; }
.job-stepper .step.active { background:#fce8d4; color:#b8631e; font-weight:600; }
.job-stepper .step.done { background:#dfeadb; color:#4a7c4e; }
.job-stepper .sep { color:#c8b291; }

.job-actions { display:flex; flex-wrap:wrap; gap:.55rem; margin-top:.8rem; }
.job-actions button[disabled] { opacity:.55; cursor:not-allowed; }
.job-leave-banner { background:#fce8d4; color:#6b3410; padding:.6rem .9rem;
  border-radius:8px; margin:.4rem 0 1rem; font-size:.88rem; }
.recent-jobs-row { display:flex; justify-content:space-between; padding:.7rem .9rem;
  border:1px solid #e5d6b8; border-radius:8px; margin-bottom:.55rem; cursor:pointer;
  background:#fbf2dc; }
.recent-jobs-row:hover { background:#f5e7c4; }
.recent-jobs-empty { color:#8a6f4a; font-style:italic; padding:.6rem 0; }
```

- [ ] **Step 2.4: Fill `#view-job` inner DOM.**

Edit the empty `<div id="view-job" ...></div>` added in Task 1 to:

```html
    <div id="view-job" data-view="job" style="display:none">
      <div class="card" id="jobHeader"></div>
      <div id="jobLeaveBanner" class="job-leave-banner" style="display:none">
        You can close this tab. Reopen this link to check progress.
      </div>
      <div id="jobProgress" style="display:none">
        <div class="progress-card">
          <div class="progress-status" id="jobProgressStatus">Loading…</div>
          <div class="progress-eta" id="jobProgressMeta"></div>
          <div class="progress-eta" id="jobProgressEta"></div>
          <div class="progress-bar"><div class="progress-fill" id="jobProgressFill" style="width:0%"></div></div>
          <div class="progress-list" id="jobProgressList"></div>
        </div>
      </div>
      <div id="jobStepper" class="job-stepper" style="display:none"></div>
      <div id="jobDetail"></div>
      <div id="jobActions" class="job-actions"></div>
      <div id="jobResults"></div>
      <div id="jobFollowup" style="display:none">
        <div class="card">
          <label class="field-label">Follow-up Question</label>
          <div class="followup-row">
            <input type="text" id="jobFollowupInput" placeholder="Ask about specific owners, fractions, gaps, curative items..." />
            <button class="btn-ask" id="jobFollowupBtn">Ask</button>
          </div>
          <div id="jobFollowupHistory" style="margin-top:1rem"></div>
        </div>
      </div>
    </div>
```

- [ ] **Step 2.5: Add the view-rendering helpers.**

Find the placeholder `async function loadJobView(jobId) {` added in step 1.5 and immediately above it insert:

```javascript
// === Phase 6: job view rendering ===

const JOB_STATUS_LABELS = {
  created:        { label: 'Preparing job…',        badge: 'status-badge--active' },
  uploading:      { label: 'Uploading documents…',  badge: 'status-badge--active' },
  ready:          { label: 'Ready to start',         badge: 'status-badge--active' },
  queued:         { label: 'Queued',                 badge: 'status-badge--active' },
  planning:       { label: 'Planning…',              badge: 'status-badge--active' },
  abstracting:    { label: 'Reading documents…',     badge: 'status-badge--active' },
  synthesizing:   { label: 'Building chain of title…', badge: 'status-badge--active' },
  complete:       { label: 'Analysis complete',      badge: 'status-badge--complete' },
  partial_failed: { label: 'Finished with errors',   badge: 'status-badge--partial' },
  failed:         { label: 'Job failed',             badge: 'status-badge--failed' },
  canceled:       { label: 'Canceled',               badge: 'status-badge--canceled' },
};

const TERMINAL_STATUSES = new Set(['complete', 'partial_failed', 'failed', 'canceled']);

function statusInfo(status) {
  return JOB_STATUS_LABELS[status] || { label: status || 'Unknown', badge: 'status-badge' };
}

function shortJobId(id) {
  if (!id) return '';
  const trimmed = id.startsWith('job_') ? id.slice(4) : id;
  return trimmed.slice(0, 8);
}

function formatRelative(iso) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const diffSec = Math.max(1, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function renderJobHeader(job) {
  const el = document.getElementById('jobHeader');
  if (!el || !job) return;
  const info = statusInfo(job.status);
  const title = job.subjectTract || job.tractDescription || `Job ${shortJobId(job.id)}`;
  const link = getJobLink(job.id);
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:.6rem">
      <div>
        <h2 style="margin:0">${esc(title)}</h2>
        <div style="color:#8a6f4a;font-size:.85rem;margin-top:.3rem">
          Job <code>${esc(shortJobId(job.id))}</code> · created ${esc(formatRelative(job.createdAt))} ·
          updated ${esc(formatRelative(job.updatedAt))}
        </div>
      </div>
      <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
        <span class="status-badge ${info.badge}">${esc(info.label)}</span>
        <button class="btn-secondary" id="jobCopyLinkBtn" type="button">Copy link</button>
      </div>
    </div>`;
  const copyBtn = document.getElementById('jobCopyLinkBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      try {
        navigator.clipboard?.writeText(link);
        copyBtn.textContent = 'Copied';
        setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1200);
      } catch { /* ignore */ }
    });
  }
}

function derivedProgressPercent(job) {
  if (!job) return 0;
  if (job.status === 'complete') return 100;
  if (job.status === 'failed' || job.status === 'canceled') return 0;
  const totalChunks = job.totalChunks || job.abstractChunkTotal || 0;
  const doneChunks = (job.completedChunks || job.abstractChunkCompleted || 0)
                   + (job.failedChunks || job.abstractChunkFailed || 0);
  if (totalChunks > 0) {
    const abstractPct = Math.min(70, (doneChunks / totalChunks) * 70);
    if (job.status === 'synthesizing' || job.status === 'partial_failed') {
      // Best-effort: bump to 70% baseline plus a small synthesis share if visible.
      return Math.min(99, Math.round(70 + (job.synthesisCompletedSegments || 0) /
        Math.max(1, job.synthesisTotalSegments || 1) * 30));
    }
    return Math.round(abstractPct);
  }
  if (!job.totalDocuments) return 0;
  const finished = (job.completedDocuments || 0) + (job.failedDocuments || 0);
  if (job.status === 'synthesizing') return Math.max(85, Math.round((finished / job.totalDocuments) * 85));
  return Math.round(Math.min(85, (finished / job.totalDocuments) * 85));
}

function renderJobProgressView(job) {
  const wrap = document.getElementById('jobProgress');
  const banner = document.getElementById('jobLeaveBanner');
  if (!wrap || !job) return;
  if (TERMINAL_STATUSES.has(job.status)) {
    wrap.style.display = 'none';
    if (banner) banner.style.display = 'none';
    return;
  }
  wrap.style.display = '';
  if (banner) banner.style.display = '';
  const info = statusInfo(job.status);
  const pct = derivedProgressPercent(job);
  const statusEl = document.getElementById('jobProgressStatus');
  const fillEl = document.getElementById('jobProgressFill');
  const metaEl = document.getElementById('jobProgressMeta');
  const listEl = document.getElementById('jobProgressList');
  if (statusEl) statusEl.textContent = job.currentPhase || info.label;
  if (fillEl) fillEl.style.width = `${Math.min(99, pct)}%`;
  if (metaEl) {
    const docs = `${job.completedDocuments || 0} / ${job.totalDocuments || 0} documents`;
    const failed = job.failedDocuments ? ` · ${job.failedDocuments} failed` : '';
    metaEl.textContent = `${docs}${failed}`;
  }
  if (listEl) listEl.innerHTML = '';
}

function renderJobStepper(job) {
  const el = document.getElementById('jobStepper');
  if (!el || !job) return;
  el.style.display = '';
  const phases = ['Upload', 'Abstract', 'Synthesize'];
  const order = { uploading: 0, ready: 1, queued: 1, planning: 1, abstracting: 1, synthesizing: 2 };
  let activeIdx = order[job.status];
  if (job.status === 'complete' || job.status === 'partial_failed') activeIdx = 2;
  if (job.status === 'created') activeIdx = 0;
  el.innerHTML = phases.map((p, i) => {
    const cls = i === activeIdx ? 'step active' :
                (typeof activeIdx === 'number' && i < activeIdx) ? 'step done' : 'step';
    return `<span class="${cls}">${esc(p)}</span>` + (i < phases.length - 1 ? '<span class="sep">→</span>' : '');
  }).join('');
}

function renderJobDetail(job) {
  const el = document.getElementById('jobDetail');
  if (!el || !job) return;
  const failed = Array.isArray(job.failedDocuments) ? job.failedDocuments : [];
  if (!failed.length) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="verify-note" style="margin-top:.8rem">
      <strong>${failed.length} document${failed.length === 1 ? '' : 's'} failed to read.</strong>
      <ul style="margin:.4rem 0 0 1.2rem">
        ${failed.map(d => `<li>${esc(d.originalFilename || d.name || d.id)}${d.lastError ? ` — ${esc(d.lastError)}` : ''}</li>`).join('')}
      </ul>
    </div>`;
}

function renderJobActions(job) {
  // Filled in by Task 5
  const el = document.getElementById('jobActions');
  if (el) el.innerHTML = '';
}

function renderJobResults(job, result) {
  // Filled in by Task 7
  const el = document.getElementById('jobResults');
  if (el) el.innerHTML = '';
}
```

- [ ] **Step 2.6: Run tests.**

Run: `node test/app.test.js`
Expected: the new Task 2 tests pass; older tests still pass.

- [ ] **Step 2.7: Commit.**

```bash
git add public/index.html test/app.test.js
git commit -m "phase 6 task 2: job status view DOM, status badges, stub renderers"
```

---

## Task 3: Adaptive job polling

**Files:**
- Modify: `public/index.html:1404-1415` (replace `startJobPolling` / `stopJobPolling`)
- Modify: `public/index.html` (add adaptive polling section)
- Test: `test/app.test.js`

- [ ] **Step 3.1: Failing test for adaptive timing constants and visibility handler.**

Append to `test/app.test.js`:

```javascript
test('Phase 6: adaptive polling helper exists with documented intervals', () => {
  assert(script.includes('JOB_POLL_INTERVALS'), 'Missing JOB_POLL_INTERVALS table');
  assert(script.includes('function scheduleJobPoll'), 'Missing scheduleJobPoll()');
  assert(script.includes("document.addEventListener('visibilitychange'"),
    'Adaptive poller must respond to visibilitychange');
  assert(script.includes('429') && script.includes('503'),
    'Adaptive poller must back off on 429/503');
});

test('Phase 6: stopJobPoller cancels any pending poll', () => {
  assert(script.includes('function stopJobPoller'), 'Missing stopJobPoller()');
});
```

- [ ] **Step 3.2: Run failing tests.**

Run: `node test/app.test.js`
Expected: the two new tests fail.

- [ ] **Step 3.3: Add the adaptive poller section.**

Find the placeholder `function stopJobPoller() {` from Task 1 (step 1.5) and **replace the entire placeholder block** with this real implementation. Insert it as a clearly-labeled section just below the JOB_STATUS_LABELS block:

```javascript
// === Phase 6: adaptive job polling ===

const JOB_POLL_INTERVALS = {
  initial: 2000,
  unchanged: 5000,
  cool: 10_000,
  cold: 30_000,
  backoffMin: 5000,
  backoffMax: 60_000,
  hiddenMultiplier: 3,
};

let activeJobPollState = null;

function pollerKey(job) {
  if (!job) return '';
  return `${job.status || ''}:${job.updatedAt || ''}:${job.completedDocuments || 0}:${job.failedDocuments || 0}:${job.completedChunks || 0}:${job.failedChunks || 0}`;
}

function visibilityMultiplier() {
  return (typeof document !== 'undefined' && document.hidden)
    ? JOB_POLL_INTERVALS.hiddenMultiplier : 1;
}

function nextPollDelay(state) {
  if (state.errorBackoffMs) return state.errorBackoffMs * visibilityMultiplier();
  const idleMs = Date.now() - state.lastChangeAt;
  let base = JOB_POLL_INTERVALS.initial;
  if (state.consecutiveUnchanged >= 3) base = JOB_POLL_INTERVALS.unchanged;
  if (idleMs > 2 * 60_000) base = JOB_POLL_INTERVALS.cool;
  if (idleMs > 10 * 60_000) base = JOB_POLL_INTERVALS.cold;
  return Math.max(JOB_POLL_INTERVALS.initial, base * visibilityMultiplier());
}

function scheduleJobPoll(state, delayMs) {
  if (state.cancelled) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => runJobPollTick(state), delayMs);
}

async function runJobPollTick(state) {
  if (state.cancelled) return;
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(state.jobId)}`, {
      method: 'GET',
      headers: getJobHeaders(),
    });
    if (res.status === 429 || res.status === 503) {
      state.errorBackoffMs = Math.min(
        JOB_POLL_INTERVALS.backoffMax,
        Math.max(JOB_POLL_INTERVALS.backoffMin, (state.errorBackoffMs || JOB_POLL_INTERVALS.backoffMin) * 2)
      );
      renderPollerBanner('Connection issue — retrying…');
      scheduleJobPoll(state, state.errorBackoffMs);
      return;
    }
    state.errorBackoffMs = 0;
    renderPollerBanner('');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    const job = data.job;
    const key = pollerKey(job);
    if (key !== state.lastKey) {
      state.lastKey = key;
      state.lastChangeAt = Date.now();
      state.consecutiveUnchanged = 0;
    } else {
      state.consecutiveUnchanged += 1;
    }
    state.lastJob = job;
    if (typeof state.onUpdate === 'function') {
      try { state.onUpdate(job); } catch (err) { console.warn('poller onUpdate failed', err); }
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      state.cancelled = true;
      if (typeof state.onTerminal === 'function') {
        try { await state.onTerminal(job); } catch (err) { console.warn('poller onTerminal failed', err); }
      }
      return;
    }
    scheduleJobPoll(state, nextPollDelay(state));
  } catch (err) {
    console.warn('Job poll failed', err);
    state.errorBackoffMs = Math.min(
      JOB_POLL_INTERVALS.backoffMax,
      Math.max(JOB_POLL_INTERVALS.backoffMin, (state.errorBackoffMs || JOB_POLL_INTERVALS.backoffMin) * 2)
    );
    renderPollerBanner('Connection issue — retrying…');
    scheduleJobPoll(state, state.errorBackoffMs);
  }
}

function renderPollerBanner(msg) {
  const banner = document.getElementById('jobLeaveBanner');
  if (!banner) return;
  if (msg) {
    banner.textContent = msg;
    banner.style.background = '#fce8e0';
    banner.style.color = '#d97755';
  } else {
    banner.textContent = 'You can close this tab. Reopen this link to check progress.';
    banner.style.background = '';
    banner.style.color = '';
  }
}

function startJobPoller(jobId, onUpdate, onTerminal) {
  stopJobPoller();
  activeJobPollState = {
    jobId,
    timer: null,
    cancelled: false,
    consecutiveUnchanged: 0,
    lastKey: '',
    lastChangeAt: Date.now(),
    errorBackoffMs: 0,
    onUpdate,
    onTerminal,
  };
  scheduleJobPoll(activeJobPollState, JOB_POLL_INTERVALS.initial);
}

function stopJobPoller() {
  if (activeJobPollState) {
    activeJobPollState.cancelled = true;
    if (activeJobPollState.timer) clearTimeout(activeJobPollState.timer);
    activeJobPollState = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    const state = activeJobPollState;
    if (!state || state.cancelled) return;
    if (!document.hidden) {
      // Visible again — poll immediately and reset cadence.
      state.consecutiveUnchanged = 0;
      state.lastChangeAt = Date.now();
      scheduleJobPoll(state, 0);
    }
  });
}

// startJobPolling/stopJobPolling kept for legacy resume path (deprecated).
function startJobPolling(jobId) {
  startJobPoller(jobId, job => renderPolledJobStatus(job), null);
}
function stopJobPolling() { stopJobPoller(); }
```

Then **delete** the old `function startJobPolling(jobId) {…} function stopJobPolling() {…}` block at lines 1404-1415 (it's been replaced inline above; leave only the new versions).

- [ ] **Step 3.4: Run tests.**

Run: `node test/app.test.js`
Expected: Task 3 tests pass. Existing tests still pass.

- [ ] **Step 3.5: Commit.**

```bash
git add public/index.html test/app.test.js
git commit -m "phase 6 task 3: adaptive polling with visibility + backoff"
```

---

## Task 4: Hash route hydrates job view

**Files:**
- Modify: `public/index.html` (replace `loadJobView` placeholder from Task 1)
- Test: `test/app.test.js`

- [ ] **Step 4.1: Failing tests for `loadJobView` behavior.**

Append to `test/app.test.js`:

```javascript
test('Phase 6: loadJobView fetches the job and hydrates the view', () => {
  assert(script.includes('async function loadJobView'), 'Missing loadJobView()');
  assert(script.includes("/api/jobs/${encodeURIComponent(jobId)}`"),
    'loadJobView must call GET /api/jobs/:id');
  assert(script.includes('renderJobHeader(job)') &&
         script.includes('renderJobProgressView(job)') &&
         script.includes('renderJobStepper(job)'),
    'loadJobView must invoke header/progress/stepper renderers');
  assert(script.includes('Job not found'), 'loadJobView must handle 404 with friendly copy');
});

test('Phase 6: terminal job hydrates result via /result', () => {
  assert(script.includes('/api/jobs/${encodeURIComponent(jobId)}/result'),
    'Job view must fetch /result on terminal status');
});
```

- [ ] **Step 4.2: Run failing tests.**

Run: `node test/app.test.js`
Expected: two new tests fail.

- [ ] **Step 4.3: Replace the `loadJobView` placeholder added in Step 1.5 with a real implementation.**

Find `async function loadJobView(jobId) {` and replace its body with:

```javascript
async function loadJobView(jobId) {
  const headerEl = document.getElementById('jobHeader');
  if (!jobId) {
    if (headerEl) headerEl.innerHTML = '<div class="error-msg"><strong>No job specified.</strong></div>';
    return;
  }
  if (headerEl) headerEl.innerHTML = '<div style="color:#8a6f4a">Loading job…</div>';
  let res;
  try {
    res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers: getJobHeaders(),
    });
  } catch (err) {
    headerEl.innerHTML = `<div class="error-msg"><strong>Network error</strong><br>${esc(err.message || 'Could not reach server.')}</div>`;
    return;
  }
  if (res.status === 401) {
    document.getElementById('mainApp').style.display = 'none';
    document.getElementById('passwordGate').style.display = 'block';
    return;
  }
  if (res.status === 404) {
    headerEl.innerHTML = '<div class="error-msg"><strong>Job not found.</strong> It may have expired or the link is wrong.</div>';
    return;
  }
  const data = await res.json();
  if (!res.ok) {
    headerEl.innerHTML = `<div class="error-msg"><strong>Could not load job</strong><br>${esc(data.error || `HTTP ${res.status}`)}</div>`;
    return;
  }
  const job = data.job;
  rememberRecentJob(job);
  await applyJobToView(job);
  if (!TERMINAL_STATUSES.has(job.status)) {
    startJobPoller(jobId, applyJobToView, async terminalJob => {
      rememberRecentJob(terminalJob);
      await applyJobToView(terminalJob);
    });
  }
}

async function applyJobToView(job) {
  renderJobHeader(job);
  renderJobProgressView(job);
  renderJobStepper(job);
  renderJobDetail(job);
  renderJobActions(job);
  if (job.status === 'complete' || job.status === 'partial_failed') {
    let result = null;
    try {
      const r = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/result`, {
        method: 'GET',
        headers: getJobHeaders(),
      });
      if (r.ok) {
        const payload = await r.json();
        result = payload.result || null;
      }
    } catch (err) {
      console.warn('Could not fetch durable job result', err);
    }
    renderJobResults(job, result);
  } else {
    renderJobResults(job, null);
  }
}
```

`rememberRecentJob` is a stub for Task 8 — add this placeholder near the recent-jobs section seed:

Find the `function renderRecentJobsView() {` placeholder and just above it insert:

```javascript
function rememberRecentJob(job) {
  // Filled in by Task 8
}
```

- [ ] **Step 4.4: Run tests.**

Run: `node test/app.test.js`
Expected: Task 4 tests pass.

- [ ] **Step 4.5: Manually smoke-test the deep link.**

Run: `node test/smoke-server.js &` (or whatever the smoke server is), then open `http://localhost:<port>/#/job/job_nonexistent` in a browser. You should see "Job not found." If unable to run smoke server, skip and rely on tests.

- [ ] **Step 4.6: Commit.**

```bash
git add public/index.html test/app.test.js
git commit -m "phase 6 task 4: hash-route hydrates job view with result fetch + 404"
```

---

## Task 5: Retry / cancel actions

**Files:**
- Modify: `public/index.html` (replace `renderJobActions` stub from Task 2)
- Test: `test/app.test.js`

- [ ] **Step 5.1: Failing tests for action wiring.**

Append to `test/app.test.js`:

```javascript
test('Phase 6: job actions wire to existing API endpoints', () => {
  assert(script.includes('/api/jobs/${encodeURIComponent(job.id)}/cancel'),
    'Cancel button must POST /cancel');
  assert(script.includes('/api/jobs/${encodeURIComponent(job.id)}/retry-failed'),
    'Retry-failed button must POST /retry-failed');
  assert(script.includes('/api/jobs/${encodeURIComponent(job.id)}/abstraction/process'),
    'Kick abstraction must POST /abstraction/process');
  assert(script.includes('/api/jobs/${encodeURIComponent(job.id)}/synthesis/process'),
    'Kick synthesis must POST /synthesis/process');
  assert(script.includes('actionInFlight'), 'Must guard against concurrent actions');
  assert(script.includes("confirm('Cancel this job"),
    'Cancel action must confirm');
});
```

- [ ] **Step 5.2: Run failing tests.**

Run: `node test/app.test.js`
Expected: new test fails.

- [ ] **Step 5.3: Replace the `renderJobActions` stub.**

Find `function renderJobActions(job) {` and replace its body with:

```javascript
let actionInFlight = false;

async function runJobAction(job, endpointPath, opts = {}) {
  if (actionInFlight) return;
  actionInFlight = true;
  const buttons = document.querySelectorAll('#jobActions button');
  buttons.forEach(b => { b.disabled = true; });
  try {
    const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}${endpointPath}`, {
      method: 'POST',
      headers: getJobHeaders(),
      body: opts.body ? JSON.stringify(opts.body) : '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data.error || `Action failed (HTTP ${res.status}).`);
      return;
    }
    // Force an immediate poll if we have an active poller
    if (activeJobPollState) {
      activeJobPollState.consecutiveUnchanged = 0;
      activeJobPollState.lastChangeAt = Date.now();
      scheduleJobPoll(activeJobPollState, 0);
    } else {
      await loadJobView(job.id);
    }
  } catch (err) {
    alert(err.message || 'Action failed.');
  } finally {
    actionInFlight = false;
    buttons.forEach(b => { b.disabled = false; });
  }
}

function renderJobActions(job) {
  const el = document.getElementById('jobActions');
  if (!el || !job) return;
  const isTerminal = TERMINAL_STATUSES.has(job.status);
  const failedDocs = Array.isArray(job.failedDocuments) ? job.failedDocuments.length : 0;
  const buttons = [];

  if (!isTerminal) {
    buttons.push({
      label: 'Cancel job',
      class: 'btn-secondary',
      onClick: () => {
        if (confirm('Cancel this job? Work in progress will be stopped.')) {
          runJobAction(job, '/cancel');
        }
      },
    });
  }
  if (job.status === 'abstracting' || job.status === 'queued' || job.status === 'planning') {
    buttons.push({
      label: 'Kick abstraction',
      class: 'btn-secondary',
      onClick: () => runJobAction(job, '/abstraction/process'),
    });
  }
  if (failedDocs > 0 && (job.status === 'abstracting' || job.status === 'partial_failed' || job.status === 'failed')) {
    buttons.push({
      label: `Retry ${failedDocs} failed`,
      class: 'btn-primary',
      onClick: () => runJobAction(job, '/retry-failed'),
    });
  }
  if (job.status === 'partial_failed') {
    buttons.push({
      label: 'Synthesize with warnings',
      class: 'btn-primary',
      onClick: () => {
        if (confirm('Synthesize without retrying the failed documents? The opinion may be incomplete.')) {
          runJobAction(job, '/synthesis/start');
        }
      },
    });
  }
  if (job.status === 'synthesizing') {
    buttons.push({
      label: 'Kick synthesis',
      class: 'btn-secondary',
      onClick: () => runJobAction(job, '/synthesis/process'),
    });
  }
  if (job.status === 'failed') {
    buttons.push({
      label: 'Retry synthesis',
      class: 'btn-secondary',
      onClick: () => runJobAction(job, '/synthesis/start'),
    });
  }

  el.innerHTML = buttons.map((b, i) =>
    `<button class="${b.class}" data-action-idx="${i}" type="button">${esc(b.label)}</button>`
  ).join('');
  el.querySelectorAll('button[data-action-idx]').forEach(btn => {
    const i = Number(btn.getAttribute('data-action-idx'));
    btn.addEventListener('click', () => buttons[i].onClick());
  });
}
```

- [ ] **Step 5.4: Run tests.**

Run: `node test/app.test.js`
Expected: Task 5 tests pass.

- [ ] **Step 5.5: Commit.**

```bash
git add public/index.html test/app.test.js
git commit -m "phase 6 task 5: cancel/retry/synthesis actions wired to existing APIs"
```

---

## Task 6: Create-job flow + home view integration

**Files:**
- Modify: `public/index.html` — adjust the existing `analyze()` entry point to navigate to the job hash route when durable, leaving inline analyze() as the browser-only fallback.
- Test: `test/app.test.js`

- [ ] **Step 6.1: Failing test.**

Append to `test/app.test.js`:

```javascript
test('Phase 6: home view exposes a recent-jobs link', () => {
  assert(indexHtml.includes('href="#/jobs"'), 'Home view must link to #/jobs');
});

test('Phase 6: analyze() navigates to #/job/{id} when durable storage is available', () => {
  assert(script.includes("navigate(`#/job/"), 'analyze() must navigate to #/job/{id} when durable');
});
```

- [ ] **Step 6.2: Run failing tests.**

Run: `node test/app.test.js`
Expected: new tests fail.

- [ ] **Step 6.3: Add the recent-jobs link to the home view.**

In `public/index.html`, inside `#view-home` just above the closing `</div>` of `#view-home`, add:

```html
    <div style="margin-top:1rem;text-align:right">
      <a href="#/jobs" class="btn-secondary" style="text-decoration:none;display:inline-block;padding:.45rem .9rem">Recent jobs</a>
    </div>
```

- [ ] **Step 6.4: Adjust the existing `analyze()` flow to navigate on durable.**

Read `public/index.html` around line 2087 (the start of `async function analyze()`). After the durable job is created (i.e. right after the existing `await createAnalysisJob(...)` call returns `activeJobId`), insert immediately:

```javascript
    if (typeof getDurableStorageStatus === 'function') {
      try {
        const status = await getDurableStorageStatus();
        if (status && status.durable && activeJobId) {
          navigate(`#/job/${encodeURIComponent(activeJobId)}`);
        }
      } catch (err) {
        console.warn('Could not detect durable storage availability', err);
      }
    }
```

Notes:
- This keeps the rest of `analyze()` executing exactly as today (browser fallback path remains intact).
- `navigate()` triggers `applyRoute()` which calls `loadJobView()`, so the user lands on the durable job view immediately while in-page processing continues to drive uploads through the existing helpers.
- Do not delete or rewire the legacy `analyze()` body. The job page polls and observes the same state from the server side.

- [ ] **Step 6.5: Run tests.**

Run: `node test/app.test.js`
Expected: Task 6 tests pass.

- [ ] **Step 6.6: Commit.**

```bash
git add public/index.html test/app.test.js
git commit -m "phase 6 task 6: durable analyze() navigates to job view + recent-jobs link"
```

---

## Task 7: Job-page follow-up + results hydration

**Files:**
- Modify: `public/index.html` — fill in `renderJobResults`, wire `#jobFollowupBtn`
- Test: `test/app.test.js`

- [ ] **Step 7.1: Failing tests.**

Append to `test/app.test.js`:

```javascript
test('Phase 6: job results render title opinion when complete', () => {
  assert(script.includes('function renderJobResults'),
    'renderJobResults must exist');
  assert(script.includes('finalTitleOpinion'),
    'renderJobResults must render finalTitleOpinion');
});

test('Phase 6: job follow-up posts to /followup endpoint', () => {
  assert(script.includes('/api/jobs/${encodeURIComponent(currentJobId)}/followup') ||
         script.includes('/api/jobs/${encodeURIComponent(job.id)}/followup'),
    'Follow-up must POST /api/jobs/:id/followup');
  assert(script.includes('jobFollowupHistory'),
    'Follow-up must render Q&A history');
});
```

- [ ] **Step 7.2: Run failing tests.**

Run: `node test/app.test.js`
Expected: new tests fail.

- [ ] **Step 7.3: Replace `renderJobResults` and wire the follow-up form.**

Find `function renderJobResults(job, result) {` and replace its body with:

```javascript
const jobFollowupHistoryByJob = new Map();

function renderJobResults(job, result) {
  const el = document.getElementById('jobResults');
  const followupWrap = document.getElementById('jobFollowup');
  if (!el || !job) return;
  if (!result || !result.finalTitleOpinion) {
    el.innerHTML = '';
    if (followupWrap) followupWrap.style.display = 'none';
    return;
  }
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const failedDocs = Array.isArray(result.failedDocuments) ? result.failedDocuments : [];
  el.innerHTML = `
    ${warnings.length ? `<div class="verify-note"><strong>Warnings:</strong><ul style="margin:.4rem 0 0 1.2rem">${warnings.map(w => `<li>${esc(typeof w === 'string' ? w : (w.message || ''))}</li>`).join('')}</ul></div>` : ''}
    ${failedDocs.length ? `<div class="verify-note"><strong>Excluded ${failedDocs.length} failed document${failedDocs.length === 1 ? '' : 's'}.</strong></div>` : ''}
    <div class="analysis-card"><div class="ac">${md(String(result.finalTitleOpinion))}</div></div>`;
  if (followupWrap) {
    followupWrap.style.display = '';
    const input = document.getElementById('jobFollowupInput');
    const btn = document.getElementById('jobFollowupBtn');
    const historyEl = document.getElementById('jobFollowupHistory');
    if (historyEl) {
      const list = jobFollowupHistoryByJob.get(job.id) || [];
      historyEl.innerHTML = list.map(pair => `
        <div class="analysis-card" style="margin-top:.7rem">
          <div class="ac"><strong>Q:</strong> ${esc(pair.question)}<br><br><strong>A:</strong> ${md(String(pair.answer || ''))}</div>
        </div>`).join('');
    }
    const submit = async () => {
      const q = (input?.value || '').trim();
      if (!q || !btn) return;
      btn.disabled = true;
      const prevLabel = btn.textContent;
      btn.textContent = 'Asking…';
      try {
        const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/followup`, {
          method: 'POST',
          headers: getJobHeaders(),
          body: JSON.stringify({ question: q }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        const list = jobFollowupHistoryByJob.get(job.id) || [];
        list.push({ question: q, answer: data.followup?.answer || '' });
        jobFollowupHistoryByJob.set(job.id, list);
        if (input) input.value = '';
        renderJobResults(job, result);
      } catch (err) {
        alert(err.message || 'Follow-up failed.');
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = prevLabel;
        }
      }
    };
    if (btn) {
      btn.onclick = submit;
    }
    if (input) {
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
    }
  }
}
```

- [ ] **Step 7.4: Run tests.**

Run: `node test/app.test.js`
Expected: Task 7 tests pass.

- [ ] **Step 7.5: Commit.**

```bash
git add public/index.html test/app.test.js
git commit -m "phase 6 task 7: job-page results + follow-up wired to /result and /followup"
```

---

## Task 8: Recent-jobs panel (localStorage)

**Files:**
- Modify: `public/index.html` — fill `rememberRecentJob`, `renderRecentJobsView`
- Test: `test/app.test.js`

- [ ] **Step 8.1: Failing tests.**

Append to `test/app.test.js`:

```javascript
test('Phase 6: recent jobs store caps at 20 entries', () => {
  assert(script.includes('title-analyzer:recent-jobs:v1'),
    'Must use a versioned localStorage key for recent jobs');
  assert(script.includes('RECENT_JOBS_LIMIT = 20') || script.includes('RECENT_JOBS_LIMIT=20'),
    'Must cap recent jobs at 20');
  assert(script.includes('function rememberRecentJob'), 'Missing rememberRecentJob()');
  assert(script.includes('function renderRecentJobsView'), 'Missing renderRecentJobsView()');
});
```

- [ ] **Step 8.2: Run failing test.**

Run: `node test/app.test.js`
Expected: new test fails.

- [ ] **Step 8.3: Replace the recent-jobs stubs.**

Find the placeholder `function rememberRecentJob(job) {` and replace both `rememberRecentJob` and `renderRecentJobsView` with:

```javascript
// === Phase 6: recent jobs (localStorage) ===
const RECENT_JOBS_KEY = 'title-analyzer:recent-jobs:v1';
const RECENT_JOBS_LIMIT = 20;

function loadRecentJobs() {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(RECENT_JOBS_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveRecentJobs(list) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(RECENT_JOBS_KEY, JSON.stringify(list.slice(0, RECENT_JOBS_LIMIT)));
  } catch {
    /* localStorage quota — ignore */
  }
}

function rememberRecentJob(job) {
  if (!job || !job.id) return;
  const list = loadRecentJobs().filter(entry => entry.id !== job.id);
  list.unshift({
    id: job.id,
    tractDescription: job.subjectTract || job.tractDescription || '',
    status: job.status || '',
    documentCount: job.totalDocuments || 0,
    lastViewedAt: Date.now(),
  });
  saveRecentJobs(list);
}

function renderRecentJobsView() {
  const el = document.getElementById('view-history');
  if (!el) return;
  const list = loadRecentJobs();
  if (!list.length) {
    el.innerHTML = `
      <div class="card">
        <h2 style="margin-top:0">Recent jobs</h2>
        <div class="recent-jobs-empty">No jobs on this device yet. Start a new job from the home view.</div>
        <div style="margin-top:.8rem"><a href="#/" class="btn-secondary" style="text-decoration:none;display:inline-block;padding:.45rem .9rem">Back home</a></div>
      </div>`;
    return;
  }
  el.innerHTML = `
    <div class="card">
      <h2 style="margin-top:0">Recent jobs</h2>
      ${list.map(entry => {
        const info = statusInfo(entry.status);
        const title = entry.tractDescription || `Job ${shortJobId(entry.id)}`;
        return `
          <a class="recent-jobs-row" href="#/job/${encodeURIComponent(entry.id)}" style="text-decoration:none;color:inherit">
            <div>
              <div style="font-weight:600">${esc(title)}</div>
              <div style="color:#8a6f4a;font-size:.82rem">${esc(shortJobId(entry.id))} · ${esc(formatRelative(new Date(entry.lastViewedAt).toISOString()))} · ${entry.documentCount} document${entry.documentCount === 1 ? '' : 's'}</div>
            </div>
            <span class="status-badge ${info.badge}">${esc(info.label)}</span>
          </a>`;
      }).join('')}
      <div style="margin-top:.8rem"><a href="#/" class="btn-secondary" style="text-decoration:none;display:inline-block;padding:.45rem .9rem">Back home</a></div>
    </div>`;
}
```

- [ ] **Step 8.4: Run tests.**

Run: `node test/app.test.js`
Expected: Task 8 tests pass.

- [ ] **Step 8.5: Commit.**

```bash
git add public/index.html test/app.test.js
git commit -m "phase 6 task 8: recent-jobs panel with localStorage cap at 20"
```

---

## Task 9: Full verification + cleanup

**Files:**
- Run: `npm test`

- [ ] **Step 9.1: Run the full test suite.**

Run: `npm test`
Expected: every test passes. If anything fails, do NOT mark complete — diagnose, fix, re-run.

- [ ] **Step 9.2: Manual sanity sweep.**

In the rendered HTML (via local smoke server or a fresh `git diff public/index.html`), confirm:

- `#view-home`, `#view-job`, `#view-history` shells exist.
- Visiting `#/` shows the home upload card and the "Recent jobs" link.
- Visiting `#/job/job_nonexistent` (with auth) shows "Job not found."
- Visiting `#/jobs` with no localStorage entries shows "No jobs on this device yet."
- The legacy `?job=abc` URL on first load auto-rewrites to `#/job/abc`.

If any of these is broken, fix in a follow-up task; do not skip.

- [ ] **Step 9.3: Final commit if anything was tweaked during 9.2.**

```bash
git add public/index.html test/app.test.js
git commit -m "phase 6 task 9: verification sweep"
```

- [ ] **Step 9.4: Summary message back to the user.**

Report:
- Branch name (`phase-6-durable-jobs-ui`)
- All commits added
- `npm test` exit code
- Any manually verified routes
- Outstanding follow-ups (IndexedDB upload resume, server `progressPercent`, follow-up history persistence)

---

## Out-of-scope follow-ups (do NOT do in Phase 6)

These were called out in the spec but explicitly deferred to "v1-lite" or later:

1. **IndexedDB upload queue.** Today the in-memory `files` array is the upload queue; closing the tab during `uploading` drops it. Flagging as a follow-up keeps Phase 6 focused.
2. **Server-side `progressPercent` / `etaSeconds`.** Backend doesn't emit these; the UI derives. Adding server fields is a backend change.
3. **Follow-up history persistence on the server.** `POST /api/jobs/:id/followup` returns a single Q+A; we hold history in `Map<jobId, [...]>` only for the current session.
4. **Per-document retry buttons in the failed-doc list.** Per-doc chunk retry is wired via `POST .../chunks/:chunkId/retry`, but the failed-doc list today doesn't surface chunk IDs. Surface them in a follow-up when the backend exposes `failedDocuments[].chunkIds`.
5. **SSE / WebSocket progress.** Polling is sufficient for v1.
6. **Server-side job listing.** No `GET /api/jobs` aggregation — recent jobs are localStorage-only by design (shared-password ACL).

---

## Self-Review Checklist (the planner has already run these; the executor should re-verify nothing has regressed):

- Every task creates a discrete, testable, commit-worthy increment.
- Tests precede implementation in every task.
- Canonical statuses match the master plan (`created`, not `creating`).
- No new backend endpoints required.
- `getJobLink`, `getRequestedJobId`, `startJobPolling`, `stopJobPolling` are all replaced consistently; the legacy `?job=` and `#job_*` URLs auto-migrate.
- The legacy inline `analyze()` path keeps working when durable storage is unavailable.
- Recent jobs use a versioned localStorage key.
