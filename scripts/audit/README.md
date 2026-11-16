# Browser audit probes

Three probes from the November 2026 front-page and results-page audits, ported so they test the UI the repo
ships today. Each check yields one row `{ name, observed, expected, pass, errors }`; a probe exits 1 when any row
fails, when it crashes, or when it records no rows. The runner exits 1 when any probe does.

| Probe | What it covers |
|---|---|
| `p4-actions.mjs` | Job view actions (Retry failed, Rebuild opinion without failed documents, Retry synthesis, Cancel job) for 2xx, 4xx, 5xx HTML and aborted replies: exactly one POST to the right endpoint, then a visible outcome (new status shown, or the inline `#jobActionError` with the controls usable again). Confirm dismissed, double click, Cancel from the job view keeping staged home files, and rename (Cancel, Escape, Save, Enter, empty, 500 chars, HTML, 409, 500, abort, double Save) with inline `#jobNameError` instead of `alert()`. |
| `p6-pdf-recent.mjs` | PDF with the CDN blocked (inline notice with Retry), real jsPDF exports for five fixture jobs read back with pdfjs-dist, a 2 MB opinion export under 10 s, the missing-result state (no enabled Download PDF, disabled header button with a reason, visible "result unavailable" with Retry, no download; the disabled control is never clicked), and Recent Jobs edge cases (corrupt or hostile storage, 20-row cap, escaping, stale status vs Refresh, a job the server no longer has). |
| `motion-reflow.mjs` | Reduced motion (only the busy spinner animates under `reduce`; decorative motion exists under `no-preference`), 640 px and 320 px reflow with the stage bar and Build state before, during and after a read, and 12 staged plus 300 more files (numbered 013 to 312, no duplicate names) held in a deterministic pending state and then settled at 312. |

## Run

```sh
npm ci
npx playwright-core install chromium-headless-shell   # once per machine, for the default headless engine
npm run audit:ui                                      # all three probes
npm run audit:ui -- p4-actions                        # one or more by name
AUDIT_CHROME=real npm run audit:ui                    # installed Google Chrome, headed, throwaway profile
node scripts/audit/p6-pdf-recent.mjs                  # a single probe without the runner
```

`npm test` does not start a browser; `test/audit-probes.test.js` covers only the check-row and exit-code logic and
the hygiene rules for these files.

| Variable | Default | Effect |
|---|---|---|
| `AUDIT_CHROME` | unset | `real` launches the installed Google Chrome (Playwright `channel: 'chrome'`) headed. Unset uses Playwright's headless shell. |
| `AUDIT_CHROME_PATH` | unset | Any Chromium binary, run headless. Ignored when `AUDIT_CHROME=real`. |
| `AUDIT_PORT` | a free port | Port for the `server.js` child. |
| `AUDIT_REPO` | this checkout | Tree whose `server.js` and `public/` are served, for example a copy with a deliberate mutation. |
| `AUDIT_OUT` | `<os tmpdir>/titlework-audit/<timestamp>` (runner) or `.../latest` (single probe) | Logs, `<probe>.json`, `summary.json`, screenshots, PDFs and server logs. Never inside the repo by default. |

Every run prints the engine, `browser.version()`, `navigator.userAgent` and the app version from `/api/healthz`.

## Scope: what is real and what is mocked

- Real: `node server.js` from the tree under test, started with only `PATH`, `HOME`, `PORT` and `NODE_ENV=test`
  (no `.env.local`, no keys). The harness checks that the served page is that tree's `public/index.html`. The
  browser, the page script, FileReader, jsPDF from cdnjs and the downloaded PDF files are real.
- Mocked: every `/api/*` call except `/api/healthz` is answered in the page from fixture jobs
  (`lib/harness.mjs` `JOBS`, opinions in `fixtures/`). No request reaches a model, Neon or a storage bucket.
  Requests to any other host are aborted, except `cdnjs.cloudflare.com` in the PDF export cases, which need network.
- Deterministic timing: `READ_GATE` holds FileReader reads until the probe opens it. That makes "still reading" a
  state, not a measured latency.
- Fixtures are fictional people, tracts and recording references.

## Provenance

`before/` keeps the audit originals as inert `*.before` files (not runnable, not imported). They are copied from the
fix-round copies the issue names, with one kind of edit: machine-specific local paths are replaced with
placeholders (`<SCRATCH>` for the local scratch root, `<REPO>` for the local checkout). Nothing else changed.
Details, checksums and what each port changed: `before/PROVENANCE.md`.
