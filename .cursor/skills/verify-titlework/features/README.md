# Titlework Analyzer verification map

This directory is the maintained source for verifying the user-facing behavior of Titlework Analyzer (the page heading is Mineral Ownership Builder). Read this index before driving the app, then use the matching feature file.

## Baseline preconditions

- Launch with `node .cursor/skills/verify-titlework/verify.mjs launch --port 4173 --run-dir "$RUN_DIR"` from the repository root.
- `RUN_DIR` is `/tmp/titlework-verify-$RUN_ID` and belongs to this run only.
- `BASE_URL` is `http://127.0.0.1:4173` unless launch had to use another free port. It is never `http://localhost:8080`.
- `ARTIFACTS` is `/opt/cursor/artifacts/verify-titlework`.
- The default launch is isolated: no database, bucket, or model keys. `doctor` reports `"isolated": true` and `"passwordRequired": false`.
- Run `node .cursor/skills/verify-titlework/verify.mjs doctor --run-dir "$RUN_DIR"` and require the expected base URL, pid, and version before any browser command.
- Never drive a server this run did not launch.

## Driving conventions

- Start every recipe from a fresh Chrome profile (the run directory's `chrome-profile`, created on the first browser command).
- Prefer the element ids and hash routes in each feature file. The visible field labels are not associated with the inputs.
- Treat every command as literal. Keep quoted values and flags unchanged.
- Run browser and HTTP actions through `node .cursor/skills/verify-titlework/verify.mjs`.
- On an isolated server, a completed chain of title, a stored job, and a follow-up answer are unreachable. Report those entry points as skipped with the unmet precondition. Do not mark them verified because the home page loaded.
- Leave proof files in `ARTIFACTS`. Cleanup deletes only `RUN_DIR`.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes a `browser snapshot` JSON file and a screenshot that shows **Mineral Ownership Builder**.
- HTTP proof includes the method, path, status, and body written with `--out`.
- The isolated job-create refusal is proved twice: the error text on the page, and `POST /api/jobs` returning 503 with no `job.id`.
- Record the feature id and the entry point with the artifacts.
- Report an unreachable path with the command you would have run and the unmet precondition (`isolated`, missing disposable database, or password lockout).

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then four H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.mjs`, and `Gotchas`.

## Features

- [Start an analysis](./start-analysis.md) covers the home upload form, the enabled **Build Chain of Title** button, and the isolated server's refusal to create a job.
- [Password gate](./password-gate.md) covers the access prompt when `APP_PASSWORD` is set.
- [Recent jobs](./recent-jobs.md) covers the empty history list and the disabled toolbar link on a fresh browser.
- [Job view](./job-view.md) covers opening `#/job/<id>` and the error shown when the job cannot be loaded.
- [Follow-up questions](./follow-up.md) covers the question box that appears only after an opinion exists.
