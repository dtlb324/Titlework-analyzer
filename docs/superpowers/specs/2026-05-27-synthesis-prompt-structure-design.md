# Synthesis Prompt Structure Improvements

**Date:** 2026-05-27
**Status:** Approved

## Goal

Improve the clarity of Sonnet's title opinion output for all production jobs by adding explicit formatting instructions to `SYNTHESIS_PROMPT` in `api/_lib/synthesis.js`. The legal reasoning and curative analysis stay unchanged — only the structure guidance is updated.

## Background

A side-by-side comparison of Claude Sonnet 4.6 vs Gemini 3.5 Flash on the same job abstracts revealed that Gemini's output was easier to read:
- Numbered entries per document made the chain of title scannable
- Inline flags per document (with ⚠️ labels) made issues easy to spot
- A "Reconciled Interest" column in the final ownership table made definitive legal conclusions clear (e.g., void chains = 0)

Sonnet's dense markdown table format packed in more detail but was harder to scan and didn't make definitive reconciled conclusions in the ownership table.

## Scope

One file, two targeted edits: `api/_lib/synthesis.js`, `SYNTHESIS_PROMPT` constant only.

- No changes to `PARTIAL_SYNTHESIS_PROMPT`, `COMPACTION_SYNTHESIS_PROMPT`, or `FOLLOWUP_PROMPT`
- No changes to any calling code, model config, or token limits
- No new files or dependencies

## Changes

### Change 1: Chain of Title formatting instruction

**Current text (in `SYNTHESIS_PROMPT`):**
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

### Change 2: Final Ownership Determination table and instructions

**Current text (in `SYNTHESIS_PROMPT`):**
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

## What Does Not Change

- `SYNTHESIS_PROMPT` preamble (attorney persona, 30+ years experience)
- CRITICAL RULES (1–4)
- `## MINERAL INTEREST CALCULATION` section instruction
- `## TITLE DEFECTS & CURATIVE REQUIREMENTS` section instruction
- `## OPINION QUALIFICATIONS` section instruction
- `PARTIAL_SYNTHESIS_PROMPT`
- `COMPACTION_SYNTHESIS_PROMPT`
- `FOLLOWUP_PROMPT`
- All calling code

## Success Criteria

1. Running `compare-final-opinion.mjs` on any job produces a Sonnet opinion where the chain of title uses numbered entries with bullet points (not a markdown table).
2. Each entry has a `**Flags:**` line with either `⚠️ LABEL: description` or `None`.
3. The final ownership table has a `Reconciled Interest` column.
4. Where a chain is void (e.g., sovereign double grant), the Reconciled Interest shows `0` — not a hedged range.
5. All existing sections (Mineral Interest Calculation, Title Defects, Opinion Qualifications) are still present and unaffected.
6. No test failures introduced.
