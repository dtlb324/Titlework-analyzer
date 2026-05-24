# AGENTS.md

## Cursor Cloud specific instructions

### Overview

Mineral Ownership Builder ("title-analyzer") — a Node.js 22 web app for oil & gas landmen to upload courthouse documents and generate mineral title opinions using Anthropic Claude. Single `package.json`, no monorepo, no build step, ES modules (`"type": "module"`).

### Services

| Service | Command | Port | Notes |
|---------|---------|------|-------|
| Web/API | `npm start` | 8080 | Serves SPA frontend + all `/api/*` routes |
| Worker  | `npm run start:worker` | 8080 (health only) | Polls Postgres for queued abstraction/synthesis work |

Both services run from the same codebase. The worker is only needed for end-to-end job processing.

### Testing

- `npm test` — runs all 10 test files (vanilla Node.js, no test framework). Tests use in-memory mocks; no external services, API keys, or database needed.
- No linter or type checker is configured in this repo.

### Running locally

- `npm start` starts the web server on port 8080. The SPA at `public/index.html` loads with no build step.
- Full job processing requires `ANTHROPIC_API_KEY`, `DATABASE_URL` (Neon Postgres), and `GCS_BUCKET` environment variables. Without them, the UI loads and form interaction works, but API calls to create/process jobs will fail.
- No Docker or docker-compose is needed for local development.

### Gotchas

- The entire frontend is a single `public/index.html` file (~3700 lines, vanilla HTML/CSS/JS). There is no framework, no bundler, and no hot-reload — restart the server or hard-refresh the browser after changes.
- Only 3 runtime dependencies; zero dev dependencies. Tests have no external test runner.
- The `npm test` script chains all test files with `&&`, so a failure in an early file stops later files from running.
