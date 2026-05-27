# Model Comparison HTML Viewer

**Date:** 2026-05-27
**Status:** Approved

## Goal

Extend `scripts/compare-final-opinion.mjs` to emit a `comparison.html` file alongside the existing markdown outputs. Opening the file in any browser shows both final title opinions side by side with latency and token stats, making it easy to judge which model — Claude Sonnet 4.6 or Gemini 3.5 Flash — produces a better result for a given job.

## Scope

Single file change: `scripts/compare-final-opinion.mjs`. No new dependencies, no new files, no changes to any other script or library.

## Architecture

### New function: `buildComparisonHtml(meta, sonnetText, geminiText)`

Added at the bottom of the existing script. Returns a self-contained HTML string (no external CDN or network requests — works offline).

**Markdown rendering:** A lightweight inline converter handles the subset of markdown used in title opinions:
- `## Heading` → `<h2>`
- `### Heading` → `<h3>`
- `**bold**` → `<strong>`
- Blank lines → paragraph breaks
- `---` → `<hr>`

No third-party library needed.

### Invocation

Called once, after both model arms complete and `meta.json` is written:

```js
const html = buildComparisonHtml(meta, opinionTexts['sonnet'], opinionTexts['gemini-35-flash']);
await writeFile(join(outDir, 'comparison.html'), html, 'utf8');
console.log(`  Wrote ${join(outDir, 'comparison.html')}`);
```

The loop that runs each arm must also capture the raw text alongside writing the markdown file:

```js
const opinionTexts = {};
// inside the for loop, after writeFile(opinionPath, result.text):
opinionTexts[arm.id] = result.text;
```

## Layout

```
┌─────────────────────────────────────────────────────┐
│  Job: job_abc123 · Tract: NE/4 Sec 5 · 12 abstracts │
├──────────────────────────┬──────────────────────────┤
│  Claude Sonnet 4.6       │  Gemini 3.5 Flash        │
│  4.2s · 1,840 tok out    │  6.1s · 2,103 tok out    │
├──────────────────────────┼──────────────────────────┤
│                          │                          │
│  (opinion text,          │  (opinion text,          │
│   scrolls independently) │   scrolls independently) │
│                          │                          │
└──────────────────────────┴──────────────────────────┘
```

- Sticky top bar: job ID, tract, mode, abstract count
- Each column has a sub-header with model name, latency (seconds), output token count
- Columns scroll independently via `overflow-y: auto` on each panel
- Plain HTML/CSS only — no JavaScript, no framework

## Data Flow

```
main()
  └─ for each arm: generateFinalOpinion() → result.text captured in-memory
  └─ writeFile(sonnet-opinion.md)          ← unchanged
  └─ writeFile(gemini-35-flash-opinion.md) ← unchanged
  └─ writeFile(meta.json)                  ← unchanged
  └─ buildComparisonHtml(meta, texts)      ← NEW
  └─ writeFile(comparison.html)            ← NEW
  └─ console.log final paths
```

## What Does Not Change

- CLI interface (all flags unchanged)
- `sonnet-opinion.md`, `gemini-35-flash-opinion.md`, `meta.json`, `production-baseline-opinion.md`
- All imports and shared library code
- Test files

## Success Criteria

1. Running the script with a valid `--job-id` produces `comparison.html` in the output directory.
2. Opening `comparison.html` in a browser shows both opinions in two scrollable columns.
3. The header shows job ID, tract, mode, and abstract count.
4. Each column header shows the model name, latency in seconds, and output token count.
5. The file works offline (no external resources).
6. All existing outputs (markdown files, meta.json) are still written exactly as before.
