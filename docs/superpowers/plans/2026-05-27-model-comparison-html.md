# Model Comparison HTML Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `scripts/compare-final-opinion.mjs` so that every comparison run produces a `comparison.html` file showing both model outputs side by side in a browser.

**Architecture:** Add three pure helper functions (`escHtml`, `mdToHtml`, `buildComparisonHtml`) to the existing script, capture the raw opinion text for each arm during the loop, then write the HTML file immediately after `meta.json`. No new dependencies, no new files.

**Tech Stack:** Node.js ESM, vanilla HTML/CSS (no framework, no CDN)

---

## Files Changed

| File | Change |
|---|---|
| `scripts/compare-final-opinion.mjs` | Add 3 helper functions + 3 targeted edits to `main()` |

---

## Task 1: Add helper functions to `compare-final-opinion.mjs`

**Files:**
- Modify: `scripts/compare-final-opinion.mjs`

These three functions are pure (no I/O) and go just above the existing `main()` function.

- [ ] **Step 1: Add `escHtml`, `mdToHtml`, and `buildComparisonHtml` above `main()`**

Insert the following block immediately before the line `async function main() {` in `scripts/compare-final-opinion.mjs`:

```js
function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mdToHtml(md) {
  // Escape HTML first, then convert markdown patterns to tags.
  const escaped = String(md || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .split(/\n{2,}/)
    .map(block => {
      const t = block.trim();
      if (!t) return '';
      if (t.startsWith('### ')) return `<h3>${t.slice(4)}</h3>`;
      if (t.startsWith('## ')) return `<h2>${t.slice(3)}</h2>`;
      if (t === '---') return '<hr>';
      return `<p>${t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
    })
    .filter(Boolean)
    .join('\n');
}

function buildComparisonHtml(meta, sonnetText, geminiText) {
  const sonnetArm = meta.arms?.sonnet || {};
  const geminiArm = meta.arms?.['gemini-35-flash'] || {};

  function fmtStats(arm) {
    const latency = arm.latencyMs != null ? `${(arm.latencyMs / 1000).toFixed(1)}s` : '—';
    const tokens = arm.usage?.output_tokens != null
      ? `${Number(arm.usage.output_tokens).toLocaleString()} tok out`
      : '—';
    return `${latency} · ${tokens}`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Model Comparison — ${escHtml(meta.jobId)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Georgia, serif; background: #f5f5f0; color: #1a1a1a; }
  .top-bar {
    position: sticky; top: 0; z-index: 10;
    background: #1a1a1a; color: #f5f5f0;
    padding: 10px 20px; font-family: monospace; font-size: 13px;
    display: flex; gap: 24px; align-items: center; flex-wrap: wrap;
  }
  .top-bar strong { color: #f0c040; }
  .columns {
    display: grid; grid-template-columns: 1fr 1fr;
    height: calc(100vh - 40px);
  }
  .col { display: flex; flex-direction: column; border-right: 1px solid #ccc; }
  .col:last-child { border-right: none; }
  .col-header {
    background: #2d2d2d; color: #fff;
    padding: 10px 16px; font-family: monospace; font-size: 13px;
    border-bottom: 3px solid;
    flex-shrink: 0;
  }
  .col:first-child .col-header { border-color: #4a9eff; }
  .col:last-child  .col-header { border-color: #34c97e; }
  .col-name  { font-weight: bold; font-size: 14px; }
  .col-stats { color: #aaa; font-size: 12px; margin-top: 3px; }
  .col-body  { padding: 24px; overflow-y: auto; flex: 1; line-height: 1.75; }
  h2 { font-size: 1.05em; margin: 1.5em 0 0.4em; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  h3 { font-size: 1em; margin: 1.2em 0 0.3em; color: #444; }
  p  { margin: 0.65em 0; }
  hr { border: none; border-top: 1px solid #ddd; margin: 1.2em 0; }
  strong { font-weight: bold; }
</style>
</head>
<body>
<div class="top-bar">
  <span><strong>Job:</strong> ${escHtml(meta.jobId)}</span>
  ${meta.tract ? `<span><strong>Tract:</strong> ${escHtml(meta.tract)}</span>` : ''}
  <span><strong>Mode:</strong> ${escHtml(meta.mode)}</span>
  <span><strong>Abstracts:</strong> ${meta.abstractCount ?? '—'}</span>
</div>
<div class="columns">
  <div class="col">
    <div class="col-header">
      <div class="col-name">Claude Sonnet 4.6</div>
      <div class="col-stats">${escHtml(fmtStats(sonnetArm))}</div>
    </div>
    <div class="col-body">${mdToHtml(sonnetText)}</div>
  </div>
  <div class="col">
    <div class="col-header">
      <div class="col-name">Gemini 3.5 Flash</div>
      <div class="col-stats">${escHtml(fmtStats(geminiArm))}</div>
    </div>
    <div class="col-body">${mdToHtml(geminiText)}</div>
  </div>
</div>
</body>
</html>`;
}
```

- [ ] **Step 2: Sanity-check the functions with node**

Run this one-liner to verify the helpers work in isolation before wiring them into `main()`:

```bash
node --input-type=module <<'EOF'
import { readFileSync } from 'fs';

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function mdToHtml(md) {
  const escaped = String(md || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped.split(/\n{2,}/).map(block => {
    const t = block.trim();
    if (!t) return '';
    if (t.startsWith('### ')) return `<h3>${t.slice(4)}</h3>`;
    if (t.startsWith('## ')) return `<h2>${t.slice(3)}</h2>`;
    if (t === '---') return '<hr>';
    return `<p>${t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>')}</p>`;
  }).filter(Boolean).join('\n');
}

const result = mdToHtml('## Chain of Title\n\nFirst entry.\n\n**Grantor:** Smith\n\n---\n\n### Mineral Interest');
console.assert(result.includes('<h2>Chain of Title</h2>'), 'h2 missing');
console.assert(result.includes('<strong>Grantor:</strong>'), 'bold missing');
console.assert(result.includes('<hr>'), 'hr missing');
console.assert(result.includes('<h3>Mineral Interest</h3>'), 'h3 missing');
console.assert(!result.includes('<script'), 'XSS present');
console.assert(escHtml('<script>') === '&lt;script&gt;', 'escHtml broken');
console.log('All assertions passed.');
EOF
```

Expected output:
```
All assertions passed.
```

---

## Task 2: Wire `buildComparisonHtml` into `main()`

**Files:**
- Modify: `scripts/compare-final-opinion.mjs`

Three targeted edits to `main()`. Do them in order.

- [ ] **Step 1: Declare `opinionTexts` before the arms loop**

Find this line in `main()`:

```js
  const results = {};
  for (const arm of arms) {
```

Change it to:

```js
  const results = {};
  const opinionTexts = {};
  for (const arm of arms) {
```

- [ ] **Step 2: Capture the opinion text inside the loop**

Find this block inside the `for` loop:

```js
    const opinionPath = join(outDir, `${arm.id}-opinion.md`);
    await writeFile(opinionPath, result.text, 'utf8');
```

Change it to:

```js
    const opinionPath = join(outDir, `${arm.id}-opinion.md`);
    await writeFile(opinionPath, result.text, 'utf8');
    opinionTexts[arm.id] = result.text;
```

- [ ] **Step 3: Write `comparison.html` after `meta.json`**

Find this line at the end of `main()`:

```js
  await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
```

Add the HTML write immediately after it:

```js
  await writeFile(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  const html = buildComparisonHtml(meta, opinionTexts['sonnet'] || '', opinionTexts['gemini-35-flash'] || '');
  const htmlPath = join(outDir, 'comparison.html');
  await writeFile(htmlPath, html, 'utf8');
```

- [ ] **Step 4: Update the final console.log to mention `comparison.html`**

Find:

```js
  console.log('Done. Compare sonnet-opinion.md vs gemini-35-flash-opinion.md (production baseline saved if present).');
```

Replace with:

```js
  console.log(`Done. Open ${htmlPath} in a browser to compare side by side.`);
```

- [ ] **Step 5: Commit what we have so far**

```bash
git add scripts/compare-final-opinion.mjs
git commit -m "feat: emit comparison.html with side-by-side model view"
```

---

## Task 3: End-to-end verification

**Files:**
- Read: output of `eval/compare/<jobId>-<ts>/comparison.html`

- [ ] **Step 1: Run the script against a real job**

```bash
DATABASE_URL="$DATABASE_URL" \
GEMINI_API_KEY="$GEMINI_API_KEY" \
ANTHROPIC_API_KEY="$ANTHROPIC_API_KEY" \
  node scripts/compare-final-opinion.mjs --job-id <a-real-job-id>
```

Expected console output ends with something like:
```
Done. Open eval/compare/job_abc123-2026-05-27T.../comparison.html in a browser to compare side by side.
```

- [ ] **Step 2: Open the HTML file**

```bash
open eval/compare/$(ls -t eval/compare | head -1)/comparison.html
```

- [ ] **Step 3: Verify the checklist in the browser**

- [ ] Top bar shows the correct job ID
- [ ] Top bar shows the tract (if the job has one)
- [ ] Top bar shows mode (`single-pass` or `merge`) and abstract count
- [ ] Left column header reads "Claude Sonnet 4.6" with latency and token count
- [ ] Right column header reads "Gemini 3.5 Flash" with latency and token count
- [ ] Both columns contain the actual title opinion text (not empty, not raw markdown symbols)
- [ ] `##` headings render as `<h2>` (larger text), `###` as `<h3>` (smaller)
- [ ] `**bold text**` renders bold, not as raw asterisks
- [ ] `---` separators render as horizontal rules
- [ ] Both columns scroll independently (scroll one while the other stays put)
- [ ] File works with no internet connection (no external requests in DevTools Network tab)
- [ ] The existing `sonnet-opinion.md`, `gemini-35-flash-opinion.md`, and `meta.json` are all still present in the output folder

- [ ] **Step 4: Commit if any last tweaks were made**

```bash
git add scripts/compare-final-opinion.mjs
git commit -m "fix: adjust comparison.html layout based on verification"
```

(Skip this step if no changes were needed.)
