# Provenance of the archived audit probes

The audit probes lived in local scratch, which is pruned. These are the originals the active probes were ported
from, kept inert (`.before`, never imported or run). `<SCRATCH>` stands for the local scratch root and `<REPO>` for
the local checkout path; those placeholders are the only edits.

| Archived file | Source | sha256 of the unredacted source |
|---|---|---|
| `p4-actions.mjs.before` | `<SCRATCH>/tw-results-fix/pixel-probes/buggy-results/p4-actions.mjs` | `3b32a4478972da9838f57af84fd3b6bec41cd99e2d99e997f93e9bdc3919d642` |
| `p6-pdf-recent.mjs.before` | `<SCRATCH>/tw-results-fix/pixel-probes/buggy-results/p6-pdf-recent.mjs` | `d1df09b593df9e6b6b37fe906e6c76eb14511c1c0f5c76f3e5263a8de6a4e725` |
| `lib.mjs.before` | `<SCRATCH>/tw-results-fix/pixel-probes/buggy-results/lib.mjs` | `d2a2e160a3728c3d8d56dfd0f7126a08232371ed0d0a1035fd2fa02ae6c6cd87` |
| `motion-reflow.mjs.before` | `<SCRATCH>/tw-results-fix/pixel-probes/motion-reflow.mjs` | `38e38fcd59ee103ebe5080eb65f67a1db859e4221d29fca6e9352fc3a28fe609` |
| `harness.mjs.before` | `<SCRATCH>/tw-results-fix/pixel-probes/harness.mjs` | `8f5aafbc4be2a042a930c2d2893c690f765639fa6ec953502b5364da6ebb5e7e` |

Redacted lines: `lib.mjs.before` lines 3 and 6 to 8 (harness import, ROOT, COPY, OUT), `motion-reflow.mjs.before`
lines 3, 5 and 6 (harness import, COPY, SHOTS), `harness.mjs.before` line 9 (playwright-core import). The p4 and p6
files held no local paths and are byte-identical to their sources.

The fixtures in `../fixtures/` (`opinion.md`, `defect-625.md`, `over-alloc.md`) are the audit fixtures unchanged
(sha256 `d761162b…2d0de`, `945277a9…3593a`, `e4a25d6b…d30` respectively).

## Earlier copies

The audit itself ran these from `<SCRATCH>/tw-audit/copy-buggy-results/_probes` and
`<SCRATCH>/tw-audit/copy-pixel-front/_probes` with `<SCRATCH>/tw-audit/harness.mjs`. Compared with the files above,
`p4-actions.mjs` and `p6-pdf-recent.mjs` are identical; `lib.mjs`, `motion-reflow.mjs` and `harness.mjs` differ only
in the tree path, output path, port and playwright-core import path (see the fix round's `probe-copy-changes.txt`).

## Why the originals fail on the current UI

- p4 waits for a "Synthesize with warnings" button. With an opinion on screen that action is now "Rebuild opinion
  without failed documents" (R07), so the run times out. Its rename and action checks also expected `alert()`; the
  page now shows errors inline (`#jobActionError`, `#jobNameError`). Its Cancel case staged `keep.txt`, which the
  intake no longer accepts, so it compared 0 staged files with 0.
- p6 clicks `#jobDownloadPdfBtn` while the result is missing. The button is now disabled with a reason (R04), so a
  normal click waits forever; its row also hard-coded FAIL. Two Recent Jobs rows expected behavior the app never
  had on purpose: entries without `lastViewedAt` are dropped by `loadRecentJobs`, and the home toolbar stays locked
  until a completed job exists (`test/jobs.test.js`). The ports assert that intended behavior.
- motion-reflow waits for "Reading" inside `#fileList`. Since the front-page fixes (#136) the read progress lives in
  `#intakeProgress` and the stage bar, and the queue keeps the already staged rows, so the wait times out. Its
  second selection reused names 001 to 012 from the first, so the queue held two files with each of those names.

## What the ports keep and change

The ports do not cover everything the originals did. Pass/fail is decided by observed state (status shown,
inline error visible, controls enabled, rows, counts, overflow), not by whole-sentence copy. Coverage that changed:

- motion-reflow no longer records the detailed geometry fields (header, Build button, upload zone and first remove
  button rects, file-name widths, CTA fold offset). It keeps the overflow measurements and screenshots.
- The 300-file batch is no longer padded to about 150 KB per PDF, so it no longer measures read time under that byte
  workload (`readMs300x150KB`). The ported batch uses small files and asserts pending and settled state.
- p4 no longer has the separate "Retry failed 200: any visible acknowledgement?" case
  (`p4-actions.mjs.before` lines 52 to 61), where the job GET stayed unchanged after the POST. The ported success
  case mocks the job advancing to its next status, so an acknowledgement while the server still reports the old
  status (eventual consistency) is not covered.

The active probes use `../lib/harness.mjs`, which starts this repo's `server.js` on a free port, checks it serves
this tree's page, mocks every `/api` call and closes the exact server and browser it started in `finally`.
