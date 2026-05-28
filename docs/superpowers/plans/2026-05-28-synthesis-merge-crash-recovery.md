# Synthesis Merge Crash-Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the synthesis pipeline from re-running (and re-billing) the full Sonnet final merge when a worker dies after streaming the opinion but before the result row commits.

**Architecture:** When a multi-segment merge streams, it writes the final opinion into `analysis_jobs.synthesis_preview_*` and sets `synthesis_preview_complete=true` *before* `saveJobResult` runs. If the worker dies in that window, the next worker re-claims the merge lease and re-streams the whole thing. This plan adds a recovery check: before running the Sonnet merge, if a *completed, valid* preview for the current plan already exists, reuse its text and skip the model call entirely. The preview is already cleared on every plan change, so a complete preview always belongs to the current plan.

**Tech Stack:** Node.js (ESM); custom `assert`-based test files run via `npm test`; in-memory test store (`createMemoryPhase5Store`) + mock model client (`globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__`); Neon Postgres store in `api/_lib/jobs.js`; Anthropic Sonnet (final merge) + Gemini (segment summaries).

---

## Background & Root Cause (read before starting)

The failure mode (call it **M1**):

1. A worker runs the multi-segment merge. Inside `mergeSegmentsIntoOpinion` → the streaming model call, `previewWriter.complete()` writes the full opinion text and sets `synthesis_preview_complete=true` ([api/_lib/synthesis.js:687](../../../api/_lib/synthesis.js)).
2. Control returns up the stack to `await store.saveJobResult(...)`. The worker dies *between* these two awaits (Cloud Run request timeout / scale-in / cold-start replacement).
3. No `job_results` row exists, so `listRunnableSynthesisJobIds` still treats the job as runnable once the merge lease expires ([api/_lib/jobs.js:1999-2003](../../../api/_lib/jobs.js)).
4. The next worker re-claims and calls `mergeSegmentsIntoOpinion` again, whose `previewWriter.begin()` **wipes the preview and re-streams the entire merge** ([api/_lib/synthesis.js:172-177](../../../api/_lib/synthesis.js)). This repeats, burning Sonnet tokens every cycle until one attempt happens to finish *and* commit in a single process lifetime.

What already protects us (so this fix can stay small):

- `saveJobResult` is an idempotent `ON CONFLICT (job_id) DO UPDATE` upsert, gated on `mergeWorkerId`, and clears the preview on success ([api/_lib/jobs.js:2248-2332](../../../api/_lib/jobs.js)). So saving a recovered result is safe and concurrency-correct with no new locking.
- The preview is cleared on every plan transition: `saveSynthesisPlan` nulls it atomically with the plan-id change ([api/_lib/jobs.js:1837-1848](../../../api/_lib/jobs.js)). So a `complete` preview always belongs to the current plan — **no per-preview plan-id column is needed.** (Task 3 closes the one reset path that currently forgets to clear it.)
- The Opus audit that used to sit *inside* the M1 window was removed on 2026-05-28, so the recovered preview text *is* the final opinion — recovery is a zero-LLM "save the preview verbatim," with no second-model pass to reproduce.

Why this stays cheap: recovery only ever fires for the multi-segment merge branches. The single-pass branch ([api/_lib/synthesis.js:1416-1445](../../../api/_lib/synthesis.js)) makes no merge model call (it reuses the one segment's own text), so there is nothing expensive to recover there.

Token note: on recovery we reconstruct segment tokens from the DB (already re-summed each batch) but cannot know the dead merge's own token usage. The recovered result therefore reports segment tokens only, flagged with a `merge_recovered` warning. This is an accepted, documented imprecision on a rare path — not worth new columns.

---

## File Structure

- **`api/_lib/synthesis.js`** — add two module-scope functions immediately above `processSynthesisJob` (currently line ~1311): `tryRecoverMergePreview` (exported, the recovery decision) and `runOrRecoverMerge` (internal, the merge-or-recover wrapper). Repoint both multi-segment merge call sites at the wrapper. `validateFinalOpinion` (596), `mergeSegmentsIntoOpinion` (1059), and `logSynthesisMetrics` (198) are hoisted module-scope declarations, so they're in scope.
- **`test/synthesis.test.js`** — add `tryRecoverMergePreview` to the existing import block, three unit tests for the helper, and one integration test that simulates the crash and asserts no second Sonnet merge.
- **`api/_lib/jobs.js`** — add the preview-clear columns to the abstract-changed reset `UPDATE` (~line 1692) so it matches `saveSynthesisPlan`. (Hardening; see Task 3.)

---

## Task 1: Recovery decision helper (`tryRecoverMergePreview`)

**Files:**
- Modify: `api/_lib/synthesis.js` (add function just above `processSynthesisJob`, ~line 1311; export it)
- Test: `test/synthesis.test.js` (add import + 3 unit tests, e.g. after the existing preview test ~line 1786)

- [ ] **Step 1: Write the failing tests**

Add `tryRecoverMergePreview` to the import block at the top of `test/synthesis.test.js` (the `from '../api/_lib/synthesis.js'` import, ~lines 5-29), then add these tests:

```js
test('tryRecoverMergePreview reuses a completed, valid preview', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1) });
  const opinion = goodFinalOpinion('Recovered from preview.');
  await store.setSynthesisPreview('job_test_1', { text: opinion, complete: true });
  const recovered = await tryRecoverMergePreview(store, 'job_test_1', getSynthesisConfig());
  assert(recovered, 'Expected recovery from a completed valid preview');
  assert(recovered.text === opinion, 'Expected the preview text returned verbatim');
  assert(recovered.streamed === false && recovered.recovered === true, 'Expected recovered metadata flags');
});

test('tryRecoverMergePreview returns null when the preview is incomplete', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1) });
  await store.setSynthesisPreview('job_test_1', { text: goodFinalOpinion('partial'), complete: false });
  const recovered = await tryRecoverMergePreview(store, 'job_test_1', getSynthesisConfig());
  assert(recovered === null, 'Expected null for an incomplete preview');
});

test('tryRecoverMergePreview returns null when completed preview text is not a valid opinion', async () => {
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(1) });
  await store.setSynthesisPreview('job_test_1', { text: 'too short / garbage', complete: true });
  const recovered = await tryRecoverMergePreview(store, 'job_test_1', getSynthesisConfig());
  assert(recovered === null, 'Expected null when completed preview fails opinion validation');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node test/synthesis.test.js`
Expected: FAIL — `tryRecoverMergePreview is not a function` (or an import/reference error), because the helper does not exist yet.

- [ ] **Step 3: Implement the helper**

In `api/_lib/synthesis.js`, immediately above `export async function processSynthesisJob(` (~line 1311), add:

```js
// Recover a completed-but-unsaved merge: if a prior worker streamed the full
// final opinion into the preview row and died before saveJobResult committed,
// reuse that text instead of re-running the expensive Sonnet merge. The preview
// is cleared on every plan change, so a complete preview belongs to the current
// plan. Returns a merge-shaped object, or null to fall through to a fresh merge.
export async function tryRecoverMergePreview(store, jobId, config) {
  if (!store?.getSynthesisPreview || !jobId) return null;
  const preview = await store.getSynthesisPreview(jobId);
  if (!preview?.complete) return null;
  const text = preview.text || '';
  if (!validateFinalOpinion(text).ok) return null;
  return {
    text,
    model: config.model,
    payloadBytes: Buffer.byteLength(text, 'utf8'),
    streamed: false,
    recovered: true,
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node test/synthesis.test.js`
Expected: PASS — the three new tests pass and the file's existing count increases by 3 (e.g. `61 passed, 0 failed`).

- [ ] **Step 5: Commit**

```bash
git add api/_lib/synthesis.js test/synthesis.test.js
git commit -m "feat: add tryRecoverMergePreview for crash-recoverable synthesis merge"
```

---

## Task 2: Wire recovery into both merge branches (`runOrRecoverMerge`)

**Files:**
- Modify: `api/_lib/synthesis.js` (add `runOrRecoverMerge` next to `tryRecoverMergePreview`; repoint the two `mergeSegmentsIntoOpinion(` call sites in `processSynthesisJob` — currently ~line 1455 multi-segment branch and ~line 1534 failed-segments branch)
- Test: `test/synthesis.test.js` (add the crash-simulation integration test)

- [ ] **Step 1: Write the failing test**

Add to `test/synthesis.test.js` (near the other `processSynthesisJob` streaming test, ~line 1759):

```js
test('merge recovers a completed preview after a lost save without re-running Sonnet', async () => {
  const prevStream = process.env.SYNTHESIS_STREAM_ENABLED;
  const prevBulk = process.env.BULK_JOB_MIN_ABSTRACTS;
  const prevCompact = process.env.SYNTHESIS_COMPACTION_ENABLED;
  process.env.SYNTHESIS_STREAM_ENABLED = 'true';
  process.env.BULK_JOB_MIN_ABSTRACTS = '999';
  process.env.SYNTHESIS_COMPACTION_ENABLED = 'false';
  const store = createMemoryPhase5Store({ abstracts: manyAbstracts(250) });

  let mergeCalls = 0;
  const opinion = goodFinalOpinion('Recovered merge output.');
  globalThis.__TITLE_ANALYZER_SYNTHESIS_MODEL_CLIENT__ = async request => {
    if (request.system === PARTIAL_SYNTHESIS_PROMPT) {
      return { text: goodSegmentSummary(0), model: 'gemini-2.5-flash', usage: {} };
    }
    mergeCalls += 1; // final Sonnet merge
    if (request.onDelta) await request.onDelta(opinion, opinion);
    return { text: opinion, model: 'claude-sonnet-4-6', usage: { input_tokens: 10, output_tokens: 20 }, timeToFirstDeltaMs: 5 };
  };

  // First pass: simulate the worker dying after the preview is marked complete
  // but before the result row commits (drop the first saveJobResult write).
  const realSave = store.saveJobResult.bind(store);
  let saveAttempts = 0;
  store.saveJobResult = async (...args) => {
    saveAttempts += 1;
    if (saveAttempts === 1) return null; // lost write == crash before commit
    return realSave(...args);
  };
  await processSynthesisJob('job_test_1', { store, budgetMs: 60_000, batchLimit: 8 });
  assert(mergeCalls === 1, `Expected exactly one Sonnet merge on the first pass, got ${mergeCalls}`);
  assert((await store.getSynthesisPreview('job_test_1')).complete === true, 'Expected a completed preview after the crashed first pass');
  assert((await store.getJobResult('job_test_1')) === null, 'Expected no saved result after the crashed first pass');

  // Second pass: must recover from the completed preview and NOT call Sonnet again.
  const mergeCallsBefore = mergeCalls;
  await processSynthesisJob('job_test_1', { store, budgetMs: 60_000, batchLimit: 8 });
  assert(mergeCalls === mergeCallsBefore, `Expected NO additional Sonnet merge on recovery, got ${mergeCalls - mergeCallsBefore}`);
  const saved = await store.getJobResult('job_test_1');
  assert(saved && saved.finalTitleOpinion.includes('Recovered merge output.'), 'Expected the recovered preview text saved as the result');
  assert(saved.warnings.some(w => /merge_recovered/.test(w)), `Expected a merge_recovered warning, got ${JSON.stringify(saved?.warnings)}`);

  if (prevStream === undefined) delete process.env.SYNTHESIS_STREAM_ENABLED; else process.env.SYNTHESIS_STREAM_ENABLED = prevStream;
  if (prevBulk === undefined) delete process.env.BULK_JOB_MIN_ABSTRACTS; else process.env.BULK_JOB_MIN_ABSTRACTS = prevBulk;
  if (prevCompact === undefined) delete process.env.SYNTHESIS_COMPACTION_ENABLED; else process.env.SYNTHESIS_COMPACTION_ENABLED = prevCompact;
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node test/synthesis.test.js`
Expected: FAIL — on the second pass `mergeCalls` increments again (the merge re-runs) and there is no `merge_recovered` warning, because recovery is not wired in yet.

- [ ] **Step 3: Implement the wrapper and repoint both call sites**

In `api/_lib/synthesis.js`, directly below `tryRecoverMergePreview`, add:

```js
// Single funnel for the final merge so both merge branches recover identically.
async function runOrRecoverMerge(mergeArgs) {
  const store = mergeArgs.options?.store;
  const jobId = mergeArgs.options?.jobId;
  const recovered = await tryRecoverMergePreview(store, jobId, mergeArgs.config);
  if (recovered) {
    if (Array.isArray(mergeArgs.warningsAccum)) {
      mergeArgs.warningsAccum.push('merge_recovered: reused completed merge preview from an interrupted attempt');
    }
    logSynthesisMetrics({ event: 'synthesis_merge_recovered', jobId, payloadBytes: recovered.payloadBytes });
    return recovered;
  }
  return mergeSegmentsIntoOpinion(mergeArgs);
}
```

Then, in `processSynthesisJob`, change **both** multi-segment merge call sites. The call object is identical at each site; only the function name changes.

Multi-segment branch (~line 1455):

```js
        const merged = await mergeSegmentsIntoOpinion({
```

becomes:

```js
        const merged = await runOrRecoverMerge({
```

Failed-segments branch (~line 1534):

```js
          const merged = await mergeSegmentsIntoOpinion({
```

becomes:

```js
          const merged = await runOrRecoverMerge({
```

Leave the argument object, and every line after it (validation, `failedDocs`, `appendResultWarnings`, `saveJobResult`), exactly as-is.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node test/synthesis.test.js`
Expected: PASS — first pass does one merge; second pass adds zero merges, saves the recovered opinion, and includes a `merge_recovered` warning.

- [ ] **Step 5: Verify both call sites were repointed**

Run: `grep -n "mergeSegmentsIntoOpinion(" api/_lib/synthesis.js`
Expected: the only remaining call is **inside `runOrRecoverMerge`** (the fall-through). The two `processSynthesisJob` branches now call `runOrRecoverMerge(`. (The `async function mergeSegmentsIntoOpinion({` definition line will also match — that's expected.)

- [ ] **Step 6: Commit**

```bash
git add api/_lib/synthesis.js test/synthesis.test.js
git commit -m "feat: skip Sonnet re-merge by recovering completed preview after a lost save"
```

---

## Task 3 (hardening): Clear the preview in the abstract-changed reset

**Why:** `saveSynthesisPlan` already clears the preview when the plan changes, but the abstract-changed reset path (`saveAbstract`, when `abstractChanged && !preserveSynthesisPlan`) nulls the plan id and deletes results without clearing the preview ([api/_lib/jobs.js:1690-1700](../../../api/_lib/jobs.js)). Recovery can't be tricked today (a NULL plan id blocks the merge claim, and the next `saveSynthesisPlan` clears the preview before any merge runs), but leaving a stale `complete` preview around is a latent foot-gun. This makes both reset paths behave identically.

**Files:**
- Modify: `api/_lib/jobs.js` (the `UPDATE analysis_jobs ... SET synthesis_plan_id = NULL ...` at ~line 1692)

**Note on testing:** `test/jobs.test.js` runs against an in-memory store, not Postgres, so this SQL path has no DB-backed unit test in the suite. Verify by inspection + the grep in Step 3, and rely on the full suite (Step 2) to confirm no syntax/import regressions. This change is a pure additive `SET` clause that mirrors the proven `saveSynthesisPlan` clear.

- [ ] **Step 1: Make the edit**

In `api/_lib/jobs.js`, change:

```js
        await sql`
          UPDATE analysis_jobs
          SET synthesis_plan_id = NULL,
              synthesis_merge_worker_id = NULL,
              synthesis_merge_lease_expires_at = NULL,
              updated_at = now()
          WHERE id = ${record.jobId}
        `;
```

to:

```js
        await sql`
          UPDATE analysis_jobs
          SET synthesis_plan_id = NULL,
              synthesis_merge_worker_id = NULL,
              synthesis_merge_lease_expires_at = NULL,
              synthesis_preview_text = NULL,
              synthesis_preview_complete = false,
              synthesis_preview_bytes = 0,
              synthesis_preview_updated_at = NULL,
              updated_at = now()
          WHERE id = ${record.jobId}
        `;
```

- [ ] **Step 2: Run the full suite (regression check)**

Run: `npm test`
Expected: all files pass, exit 0 (no `jobs.test.js` or other regression from the edit).

- [ ] **Step 3: Verify both reset paths now clear the preview**

Run: `grep -n "synthesis_preview_complete = false" api/_lib/jobs.js`
Expected: two matches — one in `saveSynthesisPlan` (~line 1843) and one in the abstract-changed reset (the line just added).

- [ ] **Step 4: Commit**

```bash
git add api/_lib/jobs.js
git commit -m "fix: clear synthesis preview on abstract-changed plan reset"
```

---

## Out of Scope (separate future plan)

These were analyzed and intentionally deferred — do **not** add them here:

- **Lease heartbeat (failure mode M2):** a healthy but slow merge can have its lease expire and be re-claimed mid-stream, wasting one duplicate stream (the `mergeWorkerId` gate still prevents a double *save*). The fix is a timer-based lease renewal during the merge plus an `AbortController` on lost ownership. It's independent of this plan and belongs in its own plan. Note the delta-on-flush approach is insufficient (a stalled-but-alive stream emits no deltas).
- **Lease duration tuning:** `DEFAULT_MERGE_LEASE_MS` is already coupled to the upstream timeout (`UPSTREAM_TIMEOUT + 60s`, [api/_lib/synthesis.js:84](../../../api/_lib/synthesis.js)). With recovery in place, lease length is only a detection-latency knob, not a correctness one. Don't hardcode a new number.
- **Cloud Run request timeout:** the API deploy uses `--timeout 300` ([.github/workflows/release.yml:131](../../../.github/workflows/release.yml)). With the Opus audit gone, the merge stream (≤240s upstream) fits inside it, so the restart cycle is already less likely. Revisit only if the `synthesis_merge_recovered` metric fires frequently.

---

## Self-Review

**1. Spec coverage**
- M1 (re-merge after lost save) → closed by Tasks 1+2 (recover the completed preview, skip Sonnet).
- Plan-scoping correctness (M6) → already handled by `saveSynthesisPlan`; the one gap is closed by Task 3.
- Token accounting on recovery → handled by design decision (segment tokens only + `merge_recovered` warning); documented in Background.
- Single-pass branch → correctly excluded (no merge model call to recover).
- M2 / lease tuning / Cloud Run timeout → explicitly out of scope.

**2. Placeholder scan** — no `TBD`/`handle edge cases`/"similar to Task N"; every code step shows complete code; every command shows expected output.

**3. Type/name consistency** — `tryRecoverMergePreview(store, jobId, config)` defined in Task 1 is called with that exact signature in Task 2's `runOrRecoverMerge`. The returned shape (`{ text, model, payloadBytes, streamed, recovered }`) matches what downstream merge code reads (`merged.text`, `merged.model`, `merged.payloadBytes`, `merged.streamed`). The `merge_recovered` warning string is asserted in Task 2's test with the regex `/merge_recovered/`. Test helpers used (`createMemoryPhase5Store`, `manyAbstracts`, `goodFinalOpinion`, `goodSegmentSummary`, `getSynthesisConfig`, `PARTIAL_SYNTHESIS_PROMPT`) all exist in `test/synthesis.test.js` today.
