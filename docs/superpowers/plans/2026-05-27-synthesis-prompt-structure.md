# Synthesis Prompt Structure Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the chain-of-title and final-ownership instructions in `SYNTHESIS_PROMPT` with explicit formatting rules that produce numbered entries with inline flags and a Reconciled Interest column.

**Architecture:** Two targeted string edits inside the `SYNTHESIS_PROMPT` template literal in `api/_lib/synthesis.js`. One new test assertion added to `test/synthesis.test.js` to lock in the new format requirements. No other files change.

**Tech Stack:** Node.js ESM, plain string editing

---

## Files Changed

| File | Change |
|---|---|
| `api/_lib/synthesis.js` | Edit `SYNTHESIS_PROMPT` — 2 targeted replacements |
| `test/synthesis.test.js` | Add 3 assertions verifying new format requirements |

---

## Task 1: Edit SYNTHESIS_PROMPT and add format-lock tests

**Files:**
- Modify: `api/_lib/synthesis.js` (lines 214–226)
- Modify: `test/synthesis.test.js`

- [ ] **Step 1: Add failing format-lock test to `test/synthesis.test.js`**

Find the block of existing `SYNTHESIS_PROMPT` tests near the bottom of the file (search for `'Single-pass should use SYNTHESIS_PROMPT'`) and add a new `test(...)` block immediately after it:

```js
test('SYNTHESIS_PROMPT uses numbered entry format for chain of title', () => {
  assert(
    SYNTHESIS_PROMPT.includes('Number each document'),
    'SYNTHESIS_PROMPT must instruct numbered document entries',
  );
  assert(
    SYNTHESIS_PROMPT.includes('**Flags:**'),
    'SYNTHESIS_PROMPT must include Flags bullet format',
  );
  assert(
    SYNTHESIS_PROMPT.includes('Reconciled Interest'),
    'SYNTHESIS_PROMPT must include Reconciled Interest column',
  );
});
```

- [ ] **Step 2: Run the new test to verify it fails**

```bash
node test/synthesis.test.js 2>&1 | grep -A3 "numbered entry format"
```

Expected output:
```
FAIL - SYNTHESIS_PROMPT uses numbered entry format for chain of title
```

- [ ] **Step 3: Edit `SYNTHESIS_PROMPT` — Change 1 (Chain of Title)**

In `api/_lib/synthesis.js`, find and replace exactly this text inside the `SYNTHESIS_PROMPT` template literal:

**Find:**
```
## CHAIN OF TITLE
Chronological flow. At each link: Date · Document type · Recording ref · Grantor → Grantee · Interest conveyed · Running fractional balance with math shown · Any flags.
```

**Replace with:**
```
## CHAIN OF TITLE
Chronological flow. Number each document. For each entry use this format:

**[N]. [Date] · [Document Type] · [Recording Ref]**
- **Grantor:** name
- **Grantee:** name
- **Interest Conveyed:** fraction
- **Running Balance:** math shown step by step
- **Flags:** ⚠️ LABEL: description — or "None"
```

- [ ] **Step 4: Edit `SYNTHESIS_PROMPT` — Change 2 (Final Ownership Determination)**

In `api/_lib/synthesis.js`, find and replace exactly this text inside the `SYNTHESIS_PROMPT` template literal:

**Find:**
```
## FINAL OWNERSHIP DETERMINATION
| Owner | Mineral Interest | Royalty/NPRI | Subject To | Notes |

If ownership cannot be definitively determined, state so and list what additional records are needed.
```

**Replace with:**
```
## FINAL OWNERSHIP DETERMINATION
| Owner | Claimed Interest | Reconciled Interest | Royalty/NPRI | Subject To |

In the Reconciled Interest column: apply Texas law to determine what each party actually holds. Where a chain traces to a void root (sovereign double grant, stranger to title) enter 0. Where gaps or partial abstracts prevent quantification, enter the range or "unknown". Make a definitive call wherever the law is clear — don't hedge when the answer is knowable. If ownership cannot be determined at all, state so and list what additional records are needed.
```

- [ ] **Step 5: Run the full test suite**

```bash
node test/synthesis.test.js 2>&1 | tail -5
```

Expected output includes:
```
ok - SYNTHESIS_PROMPT uses numbered entry format for chain of title
```

Then run the full suite:

```bash
npm test 2>&1 | tail -5
```

Expected:
```
N passed, 0 failed
```

(N will be one more than before — the new test.)

- [ ] **Step 6: Verify `PARTIAL_SYNTHESIS_PROMPT` and `FOLLOWUP_PROMPT` are unchanged**

```bash
node --input-type=module <<'EOF'
import { PARTIAL_SYNTHESIS_PROMPT, FOLLOWUP_PROMPT, SYNTHESIS_PROMPT } from './api/_lib/synthesis.js';
console.assert(PARTIAL_SYNTHESIS_PROMPT.includes('## CHAIN ROWS'), 'PARTIAL_SYNTHESIS_PROMPT intact');
console.assert(FOLLOWUP_PROMPT === SYNTHESIS_PROMPT, 'FOLLOWUP_PROMPT still aliases SYNTHESIS_PROMPT');
console.log('Unchanged prompts verified.');
EOF
```

Expected:
```
Unchanged prompts verified.
```

- [ ] **Step 7: Commit**

```bash
git add api/_lib/synthesis.js test/synthesis.test.js
git commit -m "feat: improve SYNTHESIS_PROMPT structure for clearer title opinions

Switch chain of title from dense table to numbered entries with
inline flags. Add Reconciled Interest column to final ownership
table with explicit instructions to apply Texas law definitively."
```
