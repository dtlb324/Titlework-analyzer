---
name: verify-synthesis-merge-cancel
description: >-
  Formally check the synthesis final-merge vs cancel protocol (mergeCanceled
  gate, claimSynthesisMerge lease, saveJobResult insert/CAS). Use when changing
  processSynthesisJob, claimSynthesisMerge, saveJobResult, cancelJob, merge
  preview ownership, or any path that can start the billable Sonnet merge after
  a late cancel.
---

# Verify synthesis merge vs cancel

## Property

A late cancel must not leave a canceled job looking complete, and must not start
the final merge after the merge gate has already seen `canceled`.

Harm when this breaks: the job stays canceled in `analysis_jobs` while
`job_results` still holds a title opinion, or a canceled job still pays for a
Sonnet merge that the gate was meant to skip.

## Tool

TLA+ model check via pstack `/statechart` (TLC). Chosen because the bug is an
interleaving of cancel, lease claim, billable merge, and two SQL statements in
`saveJobResult`, not a single-input functional property.

Pinned checker: `tla2tools.jar` v1.7.4
(`sha256:936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`).
`verify.mjs` downloads it to `~/.cache/tla/` when `TLA2TOOLS` is unset. Java 11+
is required (`java` on PATH, or set `JAVA`).

## Coverage

| Check | Code |
| --- | --- |
| `mergeCanceled` gate before both merge branches | `processSynthesisJob` in `api/_lib/synthesis.js` |
| Lease claim refuses canceled | `claimSynthesisMerge` in `api/_lib/jobs.js` |
| Result insert refuses canceled; status CAS | `saveJobResult` in `api/_lib/jobs.js` |
| Cancel clears merge lease | `cancelJob` in `api/_lib/jobs.js` |

Model files: `.cursor/skills/verify-synthesis-merge-cancel/model/SynthesisMergeCancel.tla`
(and `.cfg`, `SynthesisMergeCancelView.mjs`).

Out of scope: segment loops, plan replacement, preview recovery
(`tryRecoverMergePreview`), abstraction leases, multi-job queues.

Sync commit (model last confirmed against the code above):
`2ec0649377ef115763b0fb2be9cd2bfa3f612a88`.
Move this forward only after you re-confirm the model still describes those
functions at the new commit.

## Run

From the repository root:

```bash
node .cursor/skills/verify-synthesis-merge-cancel/verify.mjs check
```

Ready when stdout is one JSON object with `"ok": true`. That means:

- the structural anchors in `synthesis.js` / `jobs.js` are still present
- TLC must-hold invariants hold: `TypeOK`, `CanceledNeverLeaves`,
  `SingleMergeOwner`, `BillOnlyAfterLiveGate`
- known finding still fails: `NoResultWhileCanceled`

Read every TLC result with `/statechart`. Do not copy statechart CLI flags from
memory; use that skill. `verify.mjs` already invokes it. Optional: set
`PSTACK_STATECHART` to the `scripts/statechart` launcher if discovery fails.

## Must-hold vs known finding

Must hold (regression if TLC breaks them):

- `CanceledNeverLeaves` — once `canceled`, status does not become `complete`
- `SingleMergeOwner` — at most one merge lease owner
- `BillOnlyAfterLiveGate` — a billable merge runs only for a worker that passed
  the live-job gate

Known finding (expected fail until product code changes):

- `NoResultWhileCanceled` — cancel can land after `saveJobResult` inserts
  `job_results` and before the status CAS, so a canceled job can keep a result
  row. Shortest path from `/statechart`: gate → claim → bill → save read →
  insert → user cancel.

If `NoResultWhileCanceled` starts holding, the insert/cancel race was closed:
update `KNOWN_FINDINGS` in `verify.mjs` and this section. Do not weaken the
model to hide it. Do not change product code unless the user asks.

Residual race not encoded as a must-hold: cancel after `ClaimMerge` and before
`BillableMerge` can still bill Sonnet while the lease was cleared by `cancelJob`.
The gate closes the pre-claim window only.

## Modeling error vs real bug

- TLC breaks a must-hold while the anchors still match → treat as a real protocol
  bug; replay the `/statechart` path against the code one action at a time.
- Structural check fails → the code lost the gate or CAS; restore it or update
  the model only when the change is intentional.
- Only `NoResultWhileCanceled` breaks → known finding; do not “fix” the model.
- Chart labels disagree with SQL names but the path still maps to
  `getJob` / `claimSynthesisMerge` / merge / `saveJobResult` / `cancelJob` →
  modeling wording issue, not a product pass.

## After intentional changes

When you change the covered functions on purpose, update the `.tla` model to
match, re-run `verify.mjs check`, re-read the report with `/statechart`, then
move the sync commit in this file to the confirming commit. For drift after the
sync commit without a recheck, use `/maintain-formal-verification-skill`.
