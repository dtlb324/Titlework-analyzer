# Recent jobs

Recent jobs lists analyses this browser has already opened. The list is stored in the browser profile, not in the server. A fresh profile has an empty list and a disabled toolbar link.

## Sub-features

- `recent-disabled` shows the toolbar link as unavailable before any completed job.
- `recent-empty` shows the empty history card at `#/jobs`.
- `recent-row` shows a row that links to `#/job/<id>` after a job has been opened in this profile.

## How to get to it (user POV)

- Choose **Recent jobs** in the home toolbar after at least one completed job is remembered. The link target is `#/jobs`.
- Open `#/jobs` directly. This works even when the toolbar link is disabled.

## Driving it with verify.mjs

Preconditions:

- `doctor` reports `passwordRequired: false` so the main app can load. Use the default isolated launch.
- The Chrome profile is the fresh one inside this `RUN_DIR`.

- **Toolbar on a fresh profile.** Open `$BASE_URL/` and wait until `#mainApp` is visible. Run `node .cursor/skills/verify-titlework/verify.mjs browser attr --run-dir "$RUN_DIR" --selector "#recentJobsButton" --name aria-disabled`. `value` is `true`. Run `node .cursor/skills/verify-titlework/verify.mjs browser text --run-dir "$RUN_DIR" --selector "#recentJobsToolbarHint"`. The text is `Recent jobs available after your first completed analysis.` The link has no `href`.
- **Open history directly.** Run `node .cursor/skills/verify-titlework/verify.mjs browser goto --run-dir "$RUN_DIR" --url "$BASE_URL/#/jobs"`. Then run `node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#view-history" --visible --text "No jobs on this device yet."`. The card heading is Recent jobs. A **Back home** link points at `#/`.
- **Empty proof.** Run `node .cursor/skills/verify-titlework/verify.mjs browser snapshot --run-dir "$RUN_DIR" --path "$ARTIFACTS/recent-jobs/empty.json"` and `node .cursor/skills/verify-titlework/verify.mjs browser screenshot --run-dir "$RUN_DIR" --selector "#view-history" --path "$ARTIFACTS/recent-jobs/empty.png"`. `viewHistory` is true and `historyText` contains `No jobs on this device yet. Start a new job from the home view.`
- **Populated row.** Skip `recent-row` on an isolated server. A row appears only after the job view successfully loads a job and the profile stores it. That needs a disposable database. Report the skip.

## Gotchas

- The toolbar control is an anchor, `#recentJobsButton`, not a button. When it is disabled it has no `href` and `aria-disabled="true"`.
- `#/jobs` still renders the empty state when the toolbar link is disabled. That is the entry point to prove on a fresh profile.
- Recent jobs survive inside one Chrome profile. Cleanup removes the profile with the run directory. Do not reuse `chrome-profile` across runs and then expect the empty state.
- Completing an analysis is what enables the toolbar. Merely visiting `#/jobs` does not.
