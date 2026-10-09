# Follow-up questions

Follow-up questions lets a user ask about the opinion that was just written. The box is hidden until a final opinion is on the page. Sending a question calls the synthesis model and is billable.

## Sub-features

- `followup-hidden` keeps both question forms hidden before an opinion exists.
- `followup-home` shows the home question box, **Ask**, **+ Add More Documents**, and **Download PDF** after the home result renders.
- `followup-job` shows the job-view question box after a stored opinion loads.
- `followup-ask` appends the question and the answer in the history on that page.

## How to get to it (user POV)

- Finish **Build Chain of Title** on the home page. The question box is the card labeled Follow-up Question under the result.
- Open a completed job at `#/job/<id>`. The question box is under the opinion.

## Driving it with verify.mjs

Preconditions:

- `doctor` has been run for this `RUN_DIR`.
- `followup-hidden` can be checked on the default isolated server.
- `followup-home`, `followup-job`, and `followup-ask` need a completed opinion. Skip them when `isolated` is true. Do not send a question against production keys.

- **Hidden on a fresh home page.** Open `$BASE_URL/` and wait until `#mainApp` is visible. Run `node .cursor/skills/verify-titlework/verify.mjs browser snapshot --run-dir "$RUN_DIR" --path "$ARTIFACTS/follow-up/hidden.json"`. `followupVisible` is false and `jobFollowupVisible` is false. `#followupSection` and `#jobFollowup` stay in the page with `display: none`.
- **Hidden proof.** Run `node .cursor/skills/verify-titlework/verify.mjs browser screenshot --run-dir "$RUN_DIR" --selector "#uploadSection" --path "$ARTIFACTS/follow-up/hidden.png"`. The shot shows the upload card and does not show Follow-up Question.
- **Home box after an opinion.** Skip unless an opinion is actually on the page. The input is `#followupInput`. **Ask** is the button in `#followupSection`. **+ Add More Documents** opens `#addDocsSection`. **Download PDF** downloads from the result text.
- **Job box after an opinion.** Skip unless `#jobResults` contains the opinion. The input is `#jobFollowupInput` and the button is `#jobFollowupBtn`. History is `#jobFollowupHistory`.
- **Ask.** Skip on an isolated server. Asking is a billable model call. When it is authorized on a disposable job, type into the visible input, click **Ask**, and wait until the history contains the question text and a reply. Capture that history in `$ARTIFACTS/follow-up/answer.json` and a screenshot. Do not retry a failed ask automatically.

## Gotchas

- The hidden check does not prove that Ask works. Say that `followup-ask` was skipped when no opinion was produced.
- Home and job follow-up are different nodes. Proving one does not prove the other.
- **+ Add More Documents** is on the home result card, not in the job view.
- The placeholder text is `Ask about specific owners, fractions, gaps, curative items...` on both inputs.
- Do not invent an opinion in the page to make the box appear. The box follows a real result payload.
