# Password gate

The password gate asks for the shared application password before showing the upload form. It appears when the server answers the home page's password probe with HTTP 401.

## Sub-features

- `gate-show` shows **Access Required** and hides the upload form.
- `gate-reject` shows **Incorrect password.** and stays on the gate.
- `gate-accept` hides the gate and shows the home form after the right password.

## How to get to it (user POV)

- Open the site root while the server has `APP_PASSWORD` set.
- Open any page after a job request returns 401. The gate replaces the main app.

## Driving it with verify.mjs

Preconditions:

- This run was launched with `--password verify-local` on its own `--run-dir` and its own port. `BASE_URL` matches that port.
- `doctor` reports `passwordRequired: true` and `passwordConfigured: true`.
- Do not run this recipe against the isolated no-password server. That server skips the gate.

- **Show the gate.** Run `node .cursor/skills/verify-titlework/verify.mjs browser open --run-dir "$RUN_DIR" --url "$BASE_URL/"`. Then run `node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#passwordGate" --visible --text "Access Required"`. `#mainApp` is hidden. The password field is `#passwordInput`. The **Enter** control is `#passwordGate button`.
- **Reject a wrong password.** Run `node .cursor/skills/verify-titlework/verify.mjs browser fill --run-dir "$RUN_DIR" --selector "#passwordInput" --value "wrong-password"` and `node .cursor/skills/verify-titlework/verify.mjs browser click --run-dir "$RUN_DIR" --selector "#passwordGate button"`. Then run `node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#passwordError" --text "Incorrect password."`. The gate stays visible.
- **Accept the throwaway password.** Run `node .cursor/skills/verify-titlework/verify.mjs browser fill --run-dir "$RUN_DIR" --selector "#passwordInput" --value "verify-local"` and `node .cursor/skills/verify-titlework/verify.mjs browser click --run-dir "$RUN_DIR" --selector "#passwordGate button"`. Then run `node .cursor/skills/verify-titlework/verify.mjs browser wait --run-dir "$RUN_DIR" --selector "#mainApp" --visible`. The gate is hidden and the home form is visible.
- **Proof.** Run `node .cursor/skills/verify-titlework/verify.mjs browser snapshot --run-dir "$RUN_DIR" --path "$ARTIFACTS/password-gate/accepted.json"` and `node .cursor/skills/verify-titlework/verify.mjs browser screenshot --run-dir "$RUN_DIR" --selector "#uploadSection" --path "$ARTIFACTS/password-gate/accepted.png"`. Take the rejection screenshot before the successful password, at `$ARTIFACTS/password-gate/rejected.png`, while **Incorrect password.** is on screen.

## Gotchas

- The home page probes `POST /api/analyze` with `{ "ping": true }` on load. A wrong or empty password counts as a failed attempt. The limit is five failures, then HTTP 429 for 60 seconds. One page load plus one wrong password uses two of the five. Do not reload the gate in a loop.
- `doctor` on a `--password` launch does not send that probe. Extra unauthenticated probes still count if something else sends them.
- `verify-local` is a throwaway for this harness. Do not copy a real `APP_PASSWORD` into the feature file, the proof JSON, or a commit.
- With no `APP_PASSWORD`, and with `NODE_ENV` and `K_SERVICE` unset, the probe returns 200 and the gate never appears. The default `launch` is that case.
- A production-mode server (`NODE_ENV=production` or `K_SERVICE` set) with no password returns 401 forever. The default launch strips those variables so the gate is not stuck.
