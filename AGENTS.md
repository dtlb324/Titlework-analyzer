# AGENTS.md

## Cursor Cloud specific instructions

### Project overview

Mineral Ownership Builder — a serverless Vercel app (vanilla JS frontend + Node.js API handler) for AI-powered title analysis. No build step, no framework, no database.

### Running tests

```bash
npm test
```

All tests are self-contained (mocked fetch, no API key needed). They use plain Node.js assertions — no test framework.

### Running the dev server

```bash
node test/smoke-server.js
# → http://127.0.0.1:3456
```

Requires `ANTHROPIC_API_KEY` env var to call the AI. Without it the app still serves the UI and responds to ping/validation requests, but actual document analysis returns "API key not configured on server."

### Lint

There is no dedicated lint tool configured. The test suite validates JavaScript syntax (parses `index.html` script content) and constant consistency between frontend, backend, and README.

### Key caveats

- Node.js 20 is used in CI (see `.github/workflows/test.yml`). Use `nvm use 20` if the default version differs.
- The project has only one npm dependency (`@vercel/speed-insights`, optional analytics). `npm install` is effectively a no-op but ensures `node_modules` exists.
- `package.json` uses `"type": "module"` — all files are ESM.
- The smoke server (`test/smoke-server.js`) uses `import.meta.dirname` which requires Node 20.11+.
- No `APP_PASSWORD` env var means the password gate is skipped in the UI.
