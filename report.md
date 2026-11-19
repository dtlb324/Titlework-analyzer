# Titlework-analyzer usability and functionality audit

## Verdict

The goal was to identify what makes the document-intake front page and result page hard to use or functionally broken. Keep the current visual design, but repair export integrity, file-intake correctness, and recovery before adding more animation or layout polish.

The most consequential problems are silent. PDF export drops table content and completeness warnings. The intake queue hides most of a large selection. Overlapping file reads can start a job before all selected documents are staged. Several result-loading failures show no recovery message.

Nothing in the application was changed, committed, pushed, or deployed.

## Artifact and scope

- Audited commit `ecffd7a661e9d0f91b6d7943946ccb3bb0cf1597`, the fetched `origin/Main` containing PR #135.
- The user's checkout remained at `51ea52f` during the audit. It was not pulled or reset. Its pre-existing `.DS_Store` change and untracked generator were left alone.
- All source locations below refer to `public/index.html` at the audited commit.
- Local `server.js` served the actual application HTML. Fictional fixture jobs and controlled API responses supplied the data. No real model calls, production database, or customer files were used.
- Baseline `npm ci` succeeded. `npm test` exited 0 on Node 26.8.2. It passed 812 checks, counted as 387 custom checkmark lines, 280 custom `ok -` lines, and 145 checks from node:test pass summaries. Individual node:test success lines were not added again.
- Four named teammate passes covered front-page usability, results usability, front-page break tests, and results break tests. The lead inspected the source and reran the browser probes independently.
- The lead reran the usability probes and functional matrices in visible installed Google Chrome. The lead's browser-version output was `157.0.8103.51`. These automated reruns used a temporary profile, not the user's personal profile.
- The user's own Chrome window also became accessible through the macOS desktop tool. The front-page Select Files control opened its native file picker. The systematic measurements below come from the repeatable clean-profile probes, not from that personal profile.
- Sizes are implementation estimates, not delivery promises. S means a local change. M means coordinated rendering, state, or test work. Risk means regression risk of the proposed change.
- `ordinary` means reproduced with a normal user action or valid fictional result. `fault-injected` means a controlled read, network, server, or CDN failure exposed the problem. Neither means observed in production.

## How the two pages work

The front page collects optional tract context, stages files, creates a job, and starts uploading or browser-driven analysis. The staging array, async reads, counts, and Build button share mutable state. Entry points are `handleFiles` at 4131 and `analyze` at 5008.

The job route loads metadata through `loadJobView` at 2957. `applyJobToView` at 3019 fetches the opinion for finished jobs. `parseTitleOpinion` at 2125 and `renderResultsDashboard` at 2575 turn the opinion into ownership, defect, and chain views. Unusable opinion structure falls back to a markdown card. `downloadPDF` at 5723 exports the raw opinion card rather than the dashboard notices.

## Front page findings

Rows are ranked within this area. Every row was measured in visible Chrome unless its evidence column says otherwise.

| ID | Priority and reach | Source | What the user experiences | Evidence | Recommended change | Size / risk |
|---|---|---|---|---|---|---|
| F01 | High, ordinary | 644, 4210-4233 | The queue supports 400 files but displays only the first 8. At 400 staged, 392 are hidden. There is no expansion, search, filter, or direct removal control for those hidden files. Removing earlier rows eventually exposes them, which is not a practical review workflow. | Measured. `probes/lead-chrome-real.out`, `stage400-desktop` and `stage400-phone`. | Make every staged file reachable through a searchable, filterable, scrollable queue. Keep selection order and per-file removal. | M / low |
| F02 | High, fault-injected slow reads | 1279-1293, 4131-4149, 4237-4240 | Two overlapping file selections let the first completion re-enable Build while the second is still reading. In the lead's repro, a real Build click submitted `totalDocuments: 3`; the queue then grew to 12. The files and the submitted count no longer describe the same selection. | Measured. `probes/lead-final-checks.real.out`, `overlappingSelections`. Each FileReader read was delayed 400 ms. No programmatic Remove was used. | Serialize intake or track all pending reads. Enable Build only when intake is finished, then use one frozen selection for the run. | M / medium |
| F03 | High, ordinary | 1282-1291, 4132 | Extra files beyond the remaining slots disappear without a message. Choosing 395 files with 388 slots free staged 388 and silently dropped 7. A later drop into a full queue is silently ignored. | Measured. `probes/lead-baseline.out` and `probes/lead-chrome-real.out`, staging 12 followed by 395. | State how many files were accepted and rejected. List omitted filenames and explain the cap before starting. | S / low |
| F04 | Medium, invalid input | 1119-1129, 1258-1276, 4228 | The picker advertises supported types, but dropping unsupported files bypasses that restriction. DOCX, TIFF, EXE, extensionless, empty, and corrupt-PDF inputs can appear as Staged with Build enabled. The Status column is not validation. Repeated selection also stages duplicates without a warning. | Measured. `out/lead-rerun/buggy-front/p1-intake.real.out`, I1-I3. Downstream rejection of unsupported types at 4896 was read, not run end to end. | Validate type and nonzero size on intake. Flag unreadable PDFs. Warn about duplicates rather than silently deleting intentional repeat selections. Give each rejection its filename. | M / medium |
| F05 | Medium, fault-injected read failure | 1279-1293, 4145-4147 | One file-read failure aborts the remainder of the selection. A four-file test staged the first good file, failed on the second, and never staged the remaining two. The message only said Read failed. | Measured. `out/lead-rerun/buggy-front/p1-intake.real.out`, I7. FileReader failure was simulated. A real folder drop was not tested. | Handle errors per file, continue with the remaining files, and show a named failure list. | S / low |
| F06 | Medium, server failure | 534, 4261-4266, 5026-5031 | Build errors appear below the queue without a focus or scroll change. At 390px width the error began at y=1410 while Build was at about y=228. The user can tap Build and see no explanation. Invalid server bodies can expose JSON parser or undefined-property text. | Measured. `out/lead-rerun/pixel-front/states.real.out`, `error-w390`; `out/lead-rerun/buggy-front/p3-analyze.real.out`, A3-A5. | Put an accessible error summary next to the action. Move focus or scroll it into view. Translate transport and parse failures into a recovery message. | S / low |
| F07 | Medium, ordinary reload | 1007-1010, 4119-4129; no leave guard | Reload clears staged files without warning. Reloading a browser-driven run can leave a stored abstracting status with none of that browser work still running. The resumed display does not explain that interruption. | Measured. `out/lead-rerun/buggy-front/p6-unload.real.out`, U1-U3. The browser-only run used held mock responses. | Warn before leaving with unsent files or a browser-driven run. On resume, distinguish a durable server job from interrupted browser-only work. | M / medium |
| F08 | Medium, ordinary mobile use | 489-523, CSS 418-432 | The only Build control sits above the inputs and queue. At 390x600 the initial file-selection button is below the first screen. After reviewing staged files the user must return to the top to start. End-truncated phone filenames hide date and split-page suffixes. | Measured. `out/lead-rerun/pixel-front/states.real.out`, `empty-w390s` and `twelve-w390s`. | Put the next action after the queue or in a compact staged-state bar. Reduce initial vertical space. Preserve distinguishing filename suffixes with wrapping or middle truncation. | M / low |
| F09 | Medium, keyboard and assistive technology | 482, 527, 534, 539, 574-581, 4237-4240 | Counts, progress, and errors have no live region. Removing a row drops focus to BODY. The secondary Add Documents dropzone has no keyboard role or tab stop while its hidden file input cannot be reached. Its remove buttons are unlabeled multiplication symbols about 20px square. | Measured. `out/lead-rerun/pixel-front/a11y.real.out`; `states.real.out`, `adddocs-w390s`. Live-region absence is verified; VoiceOver speech was not tested. | Reuse the main dropzone and row accessibility pattern. Add status and alert regions. Return focus to a neighboring row after removal. | M / low |
| F10 | Low, stored-job recovery | 3413-3425, 3444-3453, 4119-4129 | A saved finished job resumes as a progress display with a small resume link rather than opening its result. Status strings such as `partial_failed` leak into it. Unknown saved IDs remain stored and retry on the next reload. Non-string IDs are not rejected. | Measured. `out/lead-rerun/buggy-front/p4-gate-resume.real.out`, R1-R9. | Use the normal job route or a clear Open results card. Validate stored IDs and clear a confirmed missing job. | S / low |
| F11 | Low, ordinary | 4176-4202, 4233, 572 | The copy exposes adaptive batching, synthesis, batch-size limits, and the model name. The amber badge's `full` class is applied to any nonempty selection rather than only at the limit. | Measured. `out/lead-rerun/pixel-front/states.real.out` and `a11y.real.out`, `badgeClassWith3`. | Say documents ready and describe what the researcher can do next. Keep technical details in a secondary disclosure. Reserve full-state styling for the cap. | S / low |

## Result page findings

| ID | Priority and reach | Source | What the user experiences | Evidence | Recommended change | Size / risk |
|---|---|---|---|---|---|---|
| R01 | High, ordinary export | 5836-5875 | PDF table cells contain only their first wrapped line. Recording reference `Vol. 41 p. 207` becomes `Vol. 41 p.`. Running balances lose fractions. A defect stops at `Wendell Ashby died 1988; no`, dropping the probate and heirship explanation. Some long-owner decimals in the large fixture are also lost. The file downloads successfully despite missing facts. | Measured. `out/lead-rerun/pixel-results/actions.real.out`; `out/pdf-complete-lead.txt`; compared against `fixtures/opinion.md`. The lead viewed the exported page. Source calls `doc.text(lines[0])`. | Draw every wrapped line. Compute row height from the tallest cell. Use sensible column widths or landscape pages. Keep headers with rows and repeat them on page breaks. | M / medium |
| R02 | High, ordinary export of partial result | 2832-2860, 5760-5768, 5797-5813 | Export leaves out the page's warnings about omitted documents, browser fallback, and a truncated opinion. The partial fixture displays four failed documents and an incomplete last section, but none of those warnings survives in the PDF. The generic AI disclaimer is present and does not replace these job-specific warnings. | Measured. `probes/lead-final-checks.real.out`, `partialPdf`; `out/lead-partial-warning.pdf` and `.txt`. | Include completeness, excluded-document count, and truncation warnings at the beginning of every export. Export the same result metadata the page relies on. | M / low |
| R03 | Medium, ordinary rename | 1505, 1566, 1572, 1589 | Cancel and Escape do not close the name editor. A successful Save updates the mocked server and Recent Jobs but leaves the editor open with Save disabled. The header renderer returns whenever the editor exists, including when the editor asks it to close. | Measured. `out/lead-rerun/buggy-results/p4-actions.real.out`, rename cases. | Separate preserving an active editor during polling from explicitly closing it. Close on Save, Cancel, and Escape and restore focus. | S / low |
| R04 | Medium, faulty response or unavailable result | 2994-3002, 3030-3053, 2819-2826 | HTML error bodies and malformed job responses can leave Loading job indefinitely. A complete job with an unavailable or empty result shows a blank results area and no retry message. Its header still offers Download PDF, which reports no analysis. | Measured. `out/lead-rerun/buggy-results/p1-load.real.out`; `p6-pdf-recent.real.out`. Existing results are preserved on a failed re-fetch; the blank state is the first-load case. | Validate response status, JSON, and job/result shape at the boundary. Show Result unavailable with Retry. Base export availability on actual result data, not only job status. | M / low |
| R05 | Medium, polling/network failure | 3281-3324, 1434-1451 | Poll failures leave stale Reading documents progress with no connection warning. A polling 401 does not reopen the gate. A polling 404 keeps retrying a missing job. Navigating to Recent Jobs does not stop the old poller; the lead observed GET count rise from 2 to 5 there, then stop on Home. | Measured. `out/lead-rerun/buggy-results/p3-poller.real.out` and `p2-routing.real.out`. Potential workflow POSTs after unchanged polls were read only and are not claimed as reproduced. | Add reconnect status. Handle 401 and 404 explicitly. Stop the route-specific poller when leaving its job. Preserve deliberate browser-driven work with an explicit lifecycle, rather than accidentally through history navigation. | M / medium |
| R06 | Medium, ordinary and faulty follow-up | 2881-2945, 5267-5330 | Follow-up can finish below the visible viewport without scrolling or an announcement. On a short phone the answer began near y=1532 in a 600px viewport. Empty or non-JSON successful replies become blank A cards. Job-view errors use alerts. The in-tab path keeps Ask enabled without a pending label. | Measured. `out/lead-rerun/pixel-results/actions.real.out`; `out/lead-rerun/buggy-results/p5-followup.real.out`. In-tab state was seeded in-page, not reached through a real model run. | Show a pending question immediately. Announce and reveal the completed answer without stealing typed text. Reject empty answers. Use one inline recovery pattern for both paths. Prevent accidental duplicate submission while preserving distinct queued questions. | M / low |
| R07 | Medium, valid failed or partial job | 1755-1792, 1849-1873, 2832-2860 | A failed job does not display its job-level error. Failed and canceled steppers label every phase NEXT. Partial results show repeated warning blocks and raw codes. The desktop partial fixture's headline metrics begin at y=823 of an 860px viewport. It still offers Synthesize with warnings despite already displaying a result. | Measured. `out/lead-rerun/pixel-results/states.real.out`; `out/lead-rerun/buggy-results/p3-poller.real.out`. | Display a safe plain-language failure reason and stopped phase. Consolidate completeness warnings and put the primary recovery action first. Make rerunning an existing opinion explicit. | M / medium |
| R08 | Medium, ordinary mobile use | CSS 293, 357, 390-395; 2661-2665, 2713 | At 390px the owners table has a 326px viewport for 600px content; the chain needs 860px. Decimals and other fields sit partly or wholly beyond the right edge. The tables can be scrolled, but there is no clear scroll cue. On a 390x600 screen the job header and 118px action bar leave no ownership figures or defect details visible initially. | Measured. `out/lead-rerun/pixel-results/states.real.out`, `job_complete@390` and `job_complete@390x600`. | Compact the phone header and bar. Keep key share values visible or use responsive rows. Add an explicit horizontal-scroll cue if tables remain. | M / low |
| R09 | Medium, large synthetic result | 2674-2717 | A fixture with 120 chain rows, 30 owners, and 20 defects makes a page 15,503px tall on desktop and 20,585px on phone. It has no flagged-row filter, compact defect mode, or section jump controls. This is a reading and navigation cost, not evidence that rendering is slow. | Measured. `out/lead-rerun/pixel-results/states.real.out`, `job_big@1280` and `job_big@390`. Synthetic fixture only, not a real 400-document model output. | Add section navigation and filterable tables. Let readers collapse defect details. Keep all source content reachable and make filtered states explicit. | M / low |
| R10 | Medium, ordinary cancel with another selection staged | 1679-1682, 1629-1677, 1796-1828 | Canceling an existing job resets the unrelated home workspace. The lead reproduced one staged home file becoming zero, with no canceled confirmation and a stale recent-job status. | Measured. `out/lead-rerun/buggy-results/p4-actions.real.out`, Cancel job from job view. | Reload the canceled job and show its state. Do not call the new-job reset as a side effect of canceling another job. | S / medium |
| R11 | Medium, CDN failure | 448, 5724 | If jsPDF fails to load, Download PDF throws an undefined-library exception and gives no visible explanation. | Measured. `out/lead-rerun/pixel-results/actions.real.out`, `pdf-cdn-blocked`; `out/lead-rerun/buggy-results/p6-pdf-recent.real.out`. | Show an export-unavailable message and a retry path. Consider serving the pinned dependency locally to reduce the external failure point. | S / low for a guard, M for vendoring |
| R12 | Low, cached history | 3063-3076, 3134-3166 | Recent Jobs uses the last visited status rather than fetching current status. A now-complete fixture can still say Reading documents. A missing job remains in the list. Q&A history disappears on reload because this view's history is an in-memory Map. | Measured. `out/lead-rerun/buggy-results/p6-pdf-recent.real.out` and `p5-followup.real.out`; local list rendering confirmed by source. Server-side history retrieval was not investigated. | Label cached status or refresh it on demand. Offer removal of dead entries. Decide whether follow-ups should persist, and inspect the server contract before promising that feature. | M / low |

## Cross-page findings

| ID | Priority and reach | Source | What the user experiences | Evidence | Recommended change | Size / risk |
|---|---|---|---|---|---|---|
| C01 | Medium, auth or network failure | 1041-1055, 1066-1084, 2895-2928, 3281-3324 | The client treats any non-401 password ping as acceptance, including a server 500. A rejected fetch during password submission has no visible catch. Later 401s during Build, polling, or follow-up do not consistently restore the gate. This is a misleading client state, not proof of a server authentication bypass. | Measured. `out/lead-rerun/buggy-front/p4-gate-resume.real.out`, G4-G7; `p3-analyze.real.out`, A12; result polling and follow-up matrices. | Accept a validated successful ping only. Show a connection error otherwise. Centralize unauthorized handling, preserve unsent work, and retain the deliberate policy of not persisting the password. | M / medium |
| C02 | Low, narrow reflow and semantics | CSS 47-48, 416; 2615, 2661, 2713, 1553 | At a 320px CSS viewport an invisible tooltip adds 34px horizontal overflow. The rename input lacks a programmatic label. Ownership and chain tables lack captions and explicit header scope. The executive-summary label is not a heading. | Measured. `out/lead-rerun/pixel-front/motion-reflow.real.out`, `reflow-320`; `out/lead-rerun/pixel-results/a11y.real.out` and `actions.real.out`. | Remove closed tooltips from layout overflow. Add the input label and table semantics. Use a real summary heading. Check the changes with VoiceOver. | S / low |

## Fix sequence and tradeoffs

1. **Export integrity.** Fix R01 and R02 together. A downloaded report must retain the information and caveats that the reader saw. Keep the existing design rather than reimplementing the dashboard in PDF first.
2. **Intake correctness.** Fix F01-F05 and F07 as an intake-state change. A searchable queue alone does not fix late file reads or silent omissions. Freezing the run selection also makes counts testable.
3. **Recovery.** Fix R03-R07 and C01. Prefer explicit loading, unavailable, reconnecting, and unauthorized states over separate hidden catches. Preserve an already displayed result during a failed refresh.
4. **Reading and access.** Fix F06, F08-F09, R08-R09, and C02. A compact bar retains the useful sticky action pattern. A second full redesign is not necessary.
5. **Lower-risk polish.** Fix F10-F11, R10-R12, and the small metadata issues below. Cancel's unrelated-state reset should move earlier if users routinely stage a new selection while an older job runs.

An interactive chain table is useful, but it should follow correctness repairs. Extra exports, new animations, or more dashboard tiles do not address the demonstrated failures.

## What was ruled out or corrected

- **Dropping outside the zone did not destroy the staged list in the tested Chrome.** The reviewer's original claim extrapolated from synthetic DOM events. The lead used browser-level drag dispatch with a real file. Chrome opened the PDF in a new tab and retained all 12 staged files in the original app tab. Dropping on the zone correctly increased the count to 13. Missing document-level drop suppression is therefore a navigation annoyance here, not demonstrated data loss. Evidence is `probes/lead-real-drop.real.out`.
- **Do not link Doc N to chronological chain row N.** One usability reviewer suggested this. Upload order and chain order differ. Keep an ambiguous source reference as plain text until it can be matched unambiguously. A visually button-like noninteractive pill can be restyled without inventing a citation.
- **Do not treat every printed PASS or FAIL as a verdict.** Some probes use loose checks. The lead read the actual values. For example, the stale Recent Jobs badge printed PASS despite showing Reading documents against a complete server fixture. A running-to-complete poll test changed the job id in its fixture and is not used as evidence of a real transition bug.
- **The original mid-read Remove repro was insufficient.** It invoked `removeFile` programmatically when the real list could be replaced by Reading text. F02 instead uses two file selections and an actual click on Build. Only the read timing is injected.
- **No mobile Recent Jobs tap failure is accepted.** The real-Chrome rerun showed its helper hint at opacity 1 after the tap. A prior headless result did not. Disabled text contrast is not treated as a normal-text contrast violation because inactive controls have an exemption.
- **No persistent enabled-CTA contrast failure is claimed.** A style sample was taken during the disabled-to-enabled transition. The original measured ratio is not a stable-state contrast verdict.
- **No broad intake-speed or memory defect is established.** Synthetic files staged quickly, but heap metrics did not account reliably for external strings. The large-PDF probe later hit Playwright's 50MB in-memory input limit and exited 1. That is an audit-tool limit, not the website's upload cap. Its earlier 40MB cases ran, but they are not used as a headline defect.
- **No numerical latency verdict is based on the 2MB repeated opinion.** Its shape and the arbitrary three-second threshold make it unsuitable as a production performance claim.
- **No failure is inferred from a blank model fallback under `{ok:true}`.** That response was the mock, not an actual model output. Storage-fallback cases A6-A7 and the first navigation A11 case are excluded; the held-run navigation control superseded them.
- **No new security breach was demonstrated.** Escaping passed the filename, job-name, question, answer, hash, and local-history payloads exercised here. These checks are not a full security audit.

## Cleared behavior

- The main upload control opens the native file picker by click, Enter, and Space. It supports multiple selection.
- Normal file removal, re-adding a removed file, and unusual filename escaping work.
- A double Build activation submits one create-job request in the tested case.
- Job-creation failures restore the form and retain the selection. Their placement and copy still need F06.
- Valid complete, partial, over-allocated, qualified-percentage, and unstructured-opinion fixtures render. The unstructured fixture uses the markdown fallback.
- Back, Forward, legacy links, malformed hashes, late job responses, and late answers across different jobs passed the exercised routing checks.
- On an initially loaded job, 401, 404, JSON 500, and a network abort produce the expected gate or message. R04 concerns malformed bodies and missing result data.
- The job-view follow-up button disables while pending. Rapid resubmission sends one request. A different draft question survives the pending answer.
- Action errors restore buttons. Repeated action activation sends one request in the tested cases.
- The sticky bar remained visible, and the keyboard walk did not find a focused control hidden behind it. An entire table wrapper overlapping the bar is not the same as a hidden focused child.
- At the main tested widths of 1280, 768, and 390px, the tested states had no horizontal page overflow. Horizontally scrollable tables and the separate 320px tooltip defect remain.
- Reduced-motion preference suppresses the decorative transitions. A slower processing spinner remains.
- The recent-list parser tolerates corrupt JSON and disabled storage without crashing. It caps its list at 20.
- PDF files download when the library is available. File creation alone is not proof of export completeness, as R01-R02 show.

## Other low-priority observations

- The PDF filename uses a UTC date while its generated date uses local time. In the evening test, the filename said November 15 while the document said November 14. Source is 5748 and 5896. Use one deliberate date convention.
- The page contains an ignored X-Frame-Options meta directive, which generates a console warning. The local server also supplied the actual X-Frame-Options HTTP header, so this warning alone is not evidence that frame protection is missing.
- Some desktop controls are smaller than 44px. The phone main-queue Remove controls measured 60x44px with 17px row gaps. A blanket claim that phone Remove is 24px is incorrect. The secondary Add Documents buttons remain about 20px.
- The password gate lacks form semantics and explicit password autocomplete. Requiring password re-entry after reload is an existing deliberate non-persistence policy, not automatically a bug.
- The large-PDF auto-split notice in `handleFiles` appears unreachable on that staging path. This is a source-read observation, not proof that all PDF splitting is broken.

## Verification limits

Production deployment, Neon, durable signed-URL upload, worker execution, actual billable models, real encrypted PDFs, a real folder drop, Safari, Firefox, physical phones, and VoiceOver were not exercised. Mobile screenshots and layouts were emulated in desktop Chrome.

The audit establishes client behavior under specified data and faults. It does not establish how often malformed responses occur in production or the quality of a live title opinion. Prior accepted percentage-parser uncertainty remains. No new universal parser-correctness claim is made.

## Evidence and reruns

All paths below are relative to `/Users/loganbrown/.hermes/cache/scratch/tw-audit/` unless absolute.

- `RULES.md` holds the scope, privacy fences, baseline, and evidence contract.
- `BRIEFS.md` holds the four named teammate assignments.
- `baseline-node26.log` and `baseline-node26.exit` hold the full test baseline.
- `probes/lead-baseline.mjs` and `.out` hold the initial headless baseline.
- `probes/lead-chrome-real.mjs` and `.out` hold the visible-Chrome baseline, native chooser activation, and real PDF downloads.
- `probes/lead-real-drop.mjs` and `.real.out` hold the browser-level drag verification and correction.
- `probes/lead-final-checks.mjs` and `.real.out` hold the replacement overlap repro and partial-PDF warning comparison.
- `copy-pixel-front/_probes/` and `copy-pixel-results/_probes/` hold the usability scripts. `out/lead-rerun/pixel-front/` and `out/lead-rerun/pixel-results/` hold their lead reruns in visible Chrome.
- `copy-buggy-front/_probes/` and `copy-buggy-results/_probes/` hold the functional matrices. `out/lead-rerun/buggy-front/` and `out/lead-rerun/buggy-results/` hold their lead reruns in visible Chrome.
- `out/pixel-front/shots/`, `out/pixel-results/shots/`, and `shots/real-*.png` hold the screenshots. Usability reruns refreshed the reviewers' screenshot paths.
- `out/pdf-complete-lead.txt` contains the independently extracted complete PDF. `out/lead-partial-warning.pdf` and `.txt` contain the independently downloaded partial report.

Run one original matrix with the installed visible Chrome:

```sh
AUDIT_CHROME=real node /Users/loganbrown/.hermes/cache/scratch/tw-audit/copy-buggy-results/_probes/p4-actions.mjs
```

Run the two final lead checks:

```sh
AUDIT_CHROME=real node /Users/loganbrown/.hermes/cache/scratch/tw-audit/probes/lead-final-checks.mjs
```

The probes own their test servers and browsers. They use designated local ports. Do not run two copies of the same probe simultaneously. Every model endpoint remains mocked.

## Principles used

- **Prove It Works.** Downloaded and inspected the actual PDF rather than treating a successful click as complete export verification.
- **Build the Lever.** Saved rerunnable browser and fault-matrix scripts with their outputs, including a new real-drag probe and a replacement overlap repro.
- **Separate Before Serializing Shared State.** Each explorer used its own tree copy and server port. No reviewer wrote application code in another reviewer’s checkout.
- **Experience First.** Ranked lost title facts, silent omissions, and inability to recover above animations and visual polish.
