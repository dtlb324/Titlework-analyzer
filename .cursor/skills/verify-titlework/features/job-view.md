# Job view

The job view shows one analysis: its name, status, progress, actions, opinion, and follow-up box. The URL is `#/job/<id>`.

## Sub-features

- `job-missing` shows an error when the id cannot be loaded.
- `job-status` shows the status label, the stepper, and the progress card for a real job.
- `job-actions` shows **Cancel job** while the job is running, and retry actions when documents failed.
- `job-done` shows **Download PDF** and **Start New Job** when a result exists.

## How to get to it (user POV)

- Open a `#/job/<id>` link.
- Choose a row on the Recent jobs page.
- After a durable upload starts, the home flow navigates to `#/job/<id>` on its own.

## Driving it with verify.mjs

Preconditions:

- `doctor` reports `passwordRequired: false` for the missing-id check on the default isolated launch.
- A status, stepper, cancel, download, or follow-up proof needs a disposable database and a real job id. Skip those when `isolated` is true.

- **Open an unknown id.** Run `node .cursor/skills/verify-titlework/verify.mjs browser goto --run-dir "$RUN_DIR" --url "$BASE_URL/#/job/job_00000000-0000-4000-8000-000000000001"`. Wait until `#mainApp` is visible. Then run `node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#jobHeader" --text "Could not load job"`. On an isolated server the detail includes `DATABASE_URL or POSTGRES_URL is required for durable job metadata.`
- **Confirm the route.** Run `node .cursor/skills/verify-titlework/verify.mjs browser snapshot --run-dir "$RUN_DIR" --path "$ARTIFACTS/job-view/missing.json"`. `hash` is `#/job/job_00000000-0000-4000-8000-000000000001`, `viewJob` is true, and `jobHeader` contains `Could not load job`.
- **Missing proof.** Run `node .cursor/skills/verify-titlework/verify.mjs browser screenshot --run-dir "$RUN_DIR" --selector "#jobHeader" --path "$ARTIFACTS/job-view/missing.png"`.
- **Second view of the refusal.** Run `node .cursor/skills/verify-titlework/verify.mjs http GET --run-dir "$RUN_DIR" /api/jobs/job_00000000-0000-4000-8000-000000000001 --expect 503 --out "$ARTIFACTS/job-view/get-job.json"`. The body has no `job` object.
- **Live job.** Skip `job-status`, `job-actions`, and `job-done` when `isolated` is true. With a disposable job, the header shows the tract or a short id, `#jobActions` shows `Cancel job` before a terminal status, and a finished result shows `#jobDownloadPdfBtn` and `#jobStartNewBtn`.

## Gotchas

- **Cancel job** and **Synthesize with warnings** call `confirm()`. The harness does not accept that dialog. Do not click those buttons.
- An isolated server returns 503 for every job id, including a well-formed one. The page says **Could not load job**, not **Job not found.** **Job not found.** is the HTTP 404 copy, and it needs a database that can answer.
- The id in the hash is the full `job_` id. The header shortens it only after a job payload loads.
- Polling continues for a non-terminal job. Do not leave a live production job open in this profile.
