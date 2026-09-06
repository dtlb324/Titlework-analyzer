# AGENTS.md

## Project: Mineral Ownership Builder (`title-analyzer`)

AI title-chain research tool for landmen. Node 22 ESM, zero web framework.
Full setup (Neon, API keys, GCS, Cloud Run) lives in `README.md` — follow it;
this file is a pointer, not a copy.

- Services: `server.js` (API + static `public/index.html`) and `worker.js`
  (queue loop; health server exposes `POST /internal/drain`).
- Data: Neon Postgres (`api/_lib/jobs.js` — validation + store + inline
  `CREATE TABLE IF NOT EXISTS` migrations, no manual migrations) and GCS
  signed URLs (`api/_lib/storage.js`; browser uploads direct-to-bucket).
- AI: Gemini Flash Lite abstracts each chunk (`api/_lib/abstraction.js`);
  Claude Sonnet synthesizes segments and merges the final opinion
  (`api/_lib/synthesis.js`). `MODEL_PROVIDER=openrouter`
  (`api/_lib/model-client.js`) is the alternate route.
- Frontend is one file: `public/index.html` (~4.4k lines).

### Commands

- `npm install`, then `npm test` — plain `node:test` files under `test/`,
  wired as one `&&` chain: stops at the first failing file (~2 min, no
  partial-run convention).
- Local dev (reads git-ignored `.env.local`): `npm run dev` plus
  `npm run dev:worker` in a second terminal.
- `npm start` / `npm run start:worker` read the real process environment
  (what the container uses) — don't use them locally.

### Do not break

- Chunk claims are single conditional `UPDATE ... WHERE lease-free RETURNING`
  rows — atomic, no SELECT-then-write.
- Abstract persistence only saves if the same worker still holds the lease;
  lost races return null → reported as `stale`.
- Changing an existing abstract's text invalidates cached job results and
  synthesis previews (inside `saveDocumentAbstract`).
- The final-merge gate in `processSynthesisJob` must re-check `canceled`
  before merging (both full and degraded branches) — a late cancel must never
  fire a billable Sonnet merge (fixed 2026-09).
- Status transitions are enforced by `VALID_TRANSITIONS` +
  `TERMINAL_STATUSES` in `api/_lib/jobs.js` — update both when adding a state.
- `saveSynthesisPlan` re-saving the same planId is safe in production
  (segment `ON CONFLICT DO UPDATE` touches bounds/docs only); the test memory
  mock rebuilds rows, so don't read mock duplication as a prod bug.

### Safety

- Job IDs are bearer tokens behind one shared `APP_PASSWORD` — accepted
  design (see `docs/phase-2*`); do not "fix" as IDOR without redesigning auth.
- `requireServerAbstractionPassword` (`api/jobs/[...path].js`) verifies
  `x-app-password` via `secureCompare` and fails closed when `APP_PASSWORD`
  is unset.
- Never commit secrets or local state: `.env*`, `.tmp-gcloud/`,
  `scripts/ocr-comparison-results/`, and `scripts/sample-docs/` are ignored.
- The final merge and escalation re-reads are billable Sonnet calls — don't
  add retry/fallback paths that re-fire them silently.

### Release (patch/minor bump → tag → GitHub release)

Bump `package.json` + both root spots in `package-lock.json` (top-level
`"version"` and `packages[""].version`), add `docs/releases/vX.Y.Z.md`,
push `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z` and
`gh release create`. `test/release.test.js` guards version/release
consistency — run it before committing the bump. Production deploys only via
`.github/workflows/release.yml` (worker first, then API, same digest) — no
manual `gcloud run deploy`, no Build triggers on `main`.

### Production vs local

- Production: `WORKER_DISABLED=true` (loop off); a scheduler pings
  `POST /internal/drain`, and the browser-tab API kick covers the gap.
- Local/elsewhere: run `npm run dev:worker` for background processing, or
  keep the browser tab open so the API kick processes the job.

## Cursor Cloud specific instructions

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
