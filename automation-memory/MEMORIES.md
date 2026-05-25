# Titlework Automation Memory

Use this as the `MEMORIES.md` entry for Cursor Automations that review this repo.

## Automation Posture

This automation is read-only by default.

- Do not edit files.
- Do not commit changes.
- Do not push branches.
- Do not open pull requests.
- Do not modify configuration, secrets, rules, workflow files, or memory.
- Do not run auto-fix, format, migration, install, or generation commands.
- Do not attempt to fix issues in the same run that discovers them.

Allowed work is limited to reading project files, reviewing code, summarizing risks,
and preparing a fix request for a separate human-approved PR workflow.

## Fix Request Protocol

When a fix is needed, send a PR request only. The request should include:

- Problem: the bug, risk, failure, or missing guard.
- Evidence: exact files, behavior, logs, or test output that support the finding.
- Impact: why the issue matters.
- Recommended change: what a future PR should change, without applying it.
- Suggested tests: focused checks the future PR should add or run.
- Risk notes: rollout, data, release, or backward-compatibility concerns.

Do not include secrets, private customer details, raw uploaded title documents, or
legal conclusions in the request.

## Project Context

- This repo is a Node 22 ESM app for AI-assisted mineral title research.
- Cloud Run runs separate API and worker services.
- Neon Postgres stores durable job, document, chunk, abstract, synthesis, and follow-up state.
- Google Cloud Storage stores uploaded source documents and generated split chunks.
- Anthropic powers abstraction, synthesis, and follow-up responses.
- The tool is a research aid, not a legal opinion.

## Operating Preferences

- Read `README.md` before release, deploy, Cloud Run, storage, database, or worker review.
- Honor `.cursor/rules/github-release-workflow.mdc` for release work.
- Treat user and unrelated git changes as out of scope; do not revert them.
- For review findings, lead with concrete bugs, regressions, risks, and missing tests.
- For release-readiness claims, request that a future PR or human run `npm test`.

## Memory Maintenance

Normal automations must not update this memory directly. If a memory change seems useful,
propose it in the run summary using this format:

```markdown
Memory update request:
- Add:
- Remove:
- Reason:
```

Only update memory during an explicitly requested memory-maintenance run.
