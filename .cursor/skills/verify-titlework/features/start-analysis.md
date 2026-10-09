# Start an analysis

Start an analysis lets a user describe a tract, attach courthouse documents on the home page, and press **Build Chain of Title**. On an isolated server the press reaches `POST /api/jobs` and the page shows that durable storage is not configured.

## Sub-features

- `start-open` shows the home form after the password check.
- `start-ready` keeps **Build Chain of Title** disabled until a file is attached, then lists the file and enables the button.
- `start-refuse` on an isolated server shows the job-setup error and does not reveal a job id.
- `start-run` creates a durable job when a disposable database is configured. A finished opinion also needs the bucket and model keys.

## How to get to it (user POV)

- Open the site root. The heading is Mineral Ownership Builder.
- After a job page, choose **Start New Job**, which returns to `#/`.

## Driving it with verify.mjs

Preconditions:

- `doctor` reports `isolated: true`, `passwordRequired: false`, and the expected version.
- `$RUN_DIR/verification.csv` contains only these two lines:

```csv
instrument,note
verification,sample
```

- No browser profile has been reused from another run.

- **Open home.** Open the root. Run `node .cursor/skills/verify-titlework/verify.mjs browser open --run-dir "$RUN_DIR" --url "$BASE_URL/"`. Then run `node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#mainApp" --visible` and `node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#passwordGate" --hidden`. The snapshot heading is Mineral Ownership Builder, `disclaimer` is true, and `viewHome` is true.
- **Button starts disabled.** Run `node .cursor/skills/verify-titlework/verify.mjs browser prop --run-dir "$RUN_DIR" --selector "#analyzeBtn" --name disabled`. `value` is true.
- **Describe the tract.** Run `node .cursor/skills/verify-titlework/verify.mjs browser fill --run-dir "$RUN_DIR" --selector "#tractDescription" --value "Verification tract"` and `node .cursor/skills/verify-titlework/verify.mjs browser fill --run-dir "$RUN_DIR" --selector "#contextNotes" --value "Verification notes"`. The tract field reads `Verification tract`. The button stays disabled.
- **Attach a file.** Run `node .cursor/skills/verify-titlework/verify.mjs browser upload --run-dir "$RUN_DIR" --selector "#fileInput" --file "$RUN_DIR/verification.csv"`. Then run `node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#fileList" --text "verification.csv"`. The list includes `1 of 400 document loaded` and `verification.csv`.
- **Button enables.** Run `node .cursor/skills/verify-titlework/verify.mjs browser prop --run-dir "$RUN_DIR" --selector "#analyzeBtn" --name disabled`. `value` is false. The button text is `→ Build Chain of Title`.
- **Ready proof.** Run `node .cursor/skills/verify-titlework/verify.mjs browser snapshot --run-dir "$RUN_DIR" --path "$ARTIFACTS/start-analysis/ready.json"` and `node .cursor/skills/verify-titlework/verify.mjs browser screenshot --run-dir "$RUN_DIR" --selector "#analyzeBtn" --path "$ARTIFACTS/start-analysis/ready.png"`. The screenshot shows the heading, the file name, and the enabled button.
- **Press Build Chain of Title.** Run `node .cursor/skills/verify-titlework/verify.mjs browser click --run-dir "$RUN_DIR" --selector "#analyzeBtn"`. Then run `node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#errorBox" --text "Job setup failed"`. The error includes `DATABASE_URL or POSTGRES_URL is required for durable job metadata.` The upload card is visible again and the progress card is hidden.
- **Confirm no job row.** Run `node .cursor/skills/verify-titlework/verify.mjs http POST --run-dir "$RUN_DIR" /api/jobs --json "{\"subjectTract\":\"Verification tract\",\"contextNotes\":\"Verification notes\",\"totalDocuments\":1}" --expect 503 --out "$ARTIFACTS/start-analysis/jobs-post.json"`. Status is 503, the body has the same database error, and there is no `job` id.
- **Refusal proof.** Run `node .cursor/skills/verify-titlework/verify.mjs browser snapshot --run-dir "$RUN_DIR" --path "$ARTIFACTS/start-analysis/refused.json"` and `node .cursor/skills/verify-titlework/verify.mjs browser screenshot --run-dir "$RUN_DIR" --selector "#errorBox" --path "$ARTIFACTS/start-analysis/refused.png"`.
- **Full run.** Skip `start-run` unless `doctor` reports `isolated: false` and the database is a disposable branch. Do not point this click at production. A completed opinion is the progress card reaching a result and `#followupSection` becoming visible. Report the skip when that precondition is absent.

## Gotchas

- Typing a tract does not enable **Build Chain of Title**. The button follows the file list.
- One attached file renders `1 of 400 document loaded` (singular). Wait for that string, not `documents`.
- `#fileInput` is hidden. `browser upload` targets `#fileInput`. Clicking `#uploadZone` opens a native dialog the harness cannot complete.
- The isolated refusal is the real `POST /api/jobs` response. The page prefixes it with `Job setup failed:`.
- A large PDF can be split in the browser before the button enables. Use the small CSV for `start-ready`.
- **Start New Job** is rendered only inside an open job view. On a fresh profile the root URL is the entry point.
