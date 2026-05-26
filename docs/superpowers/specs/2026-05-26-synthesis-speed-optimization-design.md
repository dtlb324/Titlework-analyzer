# Synthesis Speed & Latency Optimization — Design Specification

**Status:** Draft for review  
**Date:** 2026-05-26  
**Product decision (2026-05-26):** `OPUS_AUDIT_ENABLED` stays **off** in production. Opus audit is out of scope for this optimization plan; do not enable it or schedule async Opus work unless explicitly re-requested.
**Related code:** [`api/_lib/synthesis.js`](../../../api/_lib/synthesis.js), [`api/_lib/queue.js`](../../../api/_lib/queue.js), [`api/_lib/model-client.js`](../../../api/_lib/model-client.js), [`api/_lib/cloud-run-worker.js`](../../../api/_lib/cloud-run-worker.js), [`worker.js`](../../../worker.js), [`public/index.html`](../../../public/index.html), [`.github/workflows/release.yml`](../../../.github/workflows/release.yml)  
**Related docs:** [phase-5-durable-server-side-synthesis.md](../../phase-5-durable-server-side-synthesis.md), [README.md](../../../README.md)

---

## 1. Executive summary

Large jobs spend most wall-clock time in **one sequential Claude Sonnet call** that merges partial segment summaries into the final title opinion. The pipeline already parallelizes partial synthesis with Gemini 2.5 Flash (default concurrency 4). Further speed gains require a mix of **deployment fixes**, **orchestration hardening**, and **targeted code changes** — not another concurrency dial on the merge itself.

This spec consolidates the highest-impact recommendations from three independent analyses (Models A, B, C) and a codebase cross-examination. Work is split into **four active phases** ordered by **impact-to-risk** (Opus audit deferred — see §5 note):

| Phase | Focus | Code changes | Primary win |
|-------|--------|--------------|-------------|
| **0** | Production deployment & env tuning | None | Remove orchestration gaps; tune existing knobs |
| **1** | Orchestration hardening | Small | Faster segment waves; reliable server path |
| **2** | Streaming final opinion | Medium | Perceived latency (~100s → ~2s time-to-first-text) |
| **3** | Merge input/output optimization | Medium–large | Shorter Sonnet generation; fewer retries |

**Recommended first ship:** Phase 0 immediately, Phase 1 in the next release, Phase 2 as the highest-ROI code change.

**Opus audit:** Keep `OPUS_AUDIT_ENABLED=false` on all Cloud Run services. The code path remains for tests and future opt-in, but this plan does **not** include enabling Opus or building async Opus infrastructure.

---

## 2. Problem statement (verified)

### 2.1 Pipeline today

```text
Abstraction (Gemini Flash, parallel)
  → Partial synthesis segments (Gemini Flash, up to SYNTHESIS_CONCURRENCY=4)
  → Final merge (Claude Sonnet 4.6, one blocking call, max 6000 output tokens)
  → saveJobResult → UI poll sees result
  (Opus audit exists in code but is disabled in production — not on the hot path)
```

For a typical 300-document bulk job: ~4 Gemini segment calls + **1 Sonnet merge**. Sonnet is a small fraction of API call count but often a **large fraction of wall-clock** because output generation is sequential and the merge input can be 30k–80k tokens.

### 2.2 Structural bottlenecks

| Bottleneck | Location | Why it matters |
|------------|----------|----------------|
| Serial final merge | `mergeSegmentsIntoOpinion` → `invokeAnthropicModel` | Cannot parallelize without quality/architecture tradeoffs |
| No streaming | `model-client.js` awaits full JSON response | Perceived latency = full generation time |
| Synthesis batch cap | `processSynthesisBatch` hard-caps `batchLimit` at 4 | Segment waves stall at `ceil(N/4)` even if `WORKFLOW_BATCH_LIMIT=12` |
| Worker disabled in prod | `release.yml`: `WORKER_DISABLED=true`, `min-instances=0` | Jobs depend on browser poll kicks unless worker is intentionally enabled |
| Browser fallback | `hierarchicalSynthesis` serial `for` loop | Partial segments run one-at-a-time if server synthesis fails |

### 2.3 What will not help much

- Raising `SYNTHESIS_UPSTREAM_TIMEOUT_MS` (already 240s) — avoids timeouts, does not speed generation.
- Using Haiku or Gemini for the final opinion — explicitly blocked by `resolveFinalSynthesisModel()`.
- Anthropic Batch API — 24h window, no completion notification; wrong fit for interactive jobs.
- Raising `SYNTHESIS_MERGE_CONCURRENCY` when only one merge runs per job — irrelevant outside tree-merge overflow.

---

## 3. Influential fixes retained (by source)

### 3.1 From Model A — deployment & orchestration

| Fix | Retained? | Phase |
|-----|-----------|-------|
| Enable worker loop (`WORKER_DISABLED=false`, warm instance) | **Yes** | 0 |
| Confirm server synthesis path (not browser fallback) | **Yes** | 0, 1 |
| Job log diagnostics (segments, retries, merge duration) | **Yes** | 0, 1 |
| Raise synthesis `batchLimit` above 4 | **Yes** | 1 |
| Careful chunk-size tuning | **Yes** | 0 (env), 3 (prompt compaction) |

### 3.2 From Model B — merge mechanics & UX architecture

| Fix | Retained? | Phase |
|-----|-----------|-------|
| Stream Sonnet response to client | **Yes** — top code ROI | 2 |
| Defer Opus audit (save Sonnet draft first) | **Deferred** — Opus stays off per product decision | — |
| Reduce Sonnet output tokens (prompt + cap) | **Yes** | 0 (env), 3 (prompt) |
| Compress partial summaries / intermediate compaction | **Yes** | 3 |
| Prompt caching on merge user content | **Yes** — retries & follow-ups | 3 |
| Speculative merge before all segments done | **No** — quality risk, complex rollback | — |
| Always-on tree-merge | **No** — deliberate quality choice today | — |

### 3.3 From Model C — upstream & env surface

| Fix | Retained? | Phase |
|-----|-----------|-------|
| Keep `OPUS_AUDIT_ENABLED=false` in production | **Yes — permanent for this initiative** | 0 |
| `ABSTRACTION_ESCALATION_ENABLED=false` when speed > escalation quality | **Yes** | 0 |
| Upstream token reduction (text-first PDF, batch abstraction, File API) | **Yes** — already defaults on | 0 |
| Single-segment Sonnet path awareness (≤~120 docs, no Gemini partials) | **Yes** | 0, 4 |
| `SYNTHESIS_MAX_TOKENS` / `SYNTHESIS_PARTIAL_MAX_TOKENS` tuning | **Yes** | 0 |

---

## 4. Goals and non-goals

### Goals

- Reduce **time-to-first-visible-opinion** from ~60–120s to a few seconds on large jobs.
- Reduce **total job wall-clock** on retry-heavy jobs by ≥30% (orchestration + merge tuning).
- Eliminate orchestration stalls between segment waves in production.
- Preserve final opinion quality bar (Sonnet for merge; no silent model downgrade).
- Keep durable job semantics: checkpointing, leases, cancellation, validation.

### Non-goals

- Enabling Opus audit or building async Opus infrastructure.
- Replacing Sonnet with Haiku/Gemini for the final legal opinion.
- Removing validation, repair, or tree-merge overflow behavior.
- Introducing a frontend framework or build step.
- Using provider Batch APIs for interactive jobs.
- Speculative/partial merge before all segments complete (deferred; revisit only with strong quality guardrails).

---

## 5. Phased implementation plan

---

### Phase 0 — Deployment & configuration (no code)

**Impact:** High for orchestration reliability; moderate indirect effect on Sonnet merge time via smaller inputs.  
**Risk:** Low.  
**Owner:** Ops / release config.

#### 0.1 Enable background worker

| Setting | Current (release) | Target |
|---------|-------------------|--------|
| `WORKER_DISABLED` | `true` | `false` |
| Worker `--min-instances` | `0` | `1` (recommended for production) or `0` (cost-sensitive) |
| `WORKER_POLL_ACTIVE_MS` | `0` | Keep `0` (no sleep between busy passes) |

**Change:** Update [`.github/workflows/release.yml`](../../../.github/workflows/release.yml) worker deploy env vars and optionally `min-instances`. Document in [README.md](../../../README.md).

**Acceptance criteria:**
- Worker logs show `worker_starting` without `worker_disabled`.
- Synthesis jobs complete with browser tab closed after abstraction finishes.
- No increase in Neon idle connection quota incidents (monitor after enablement).

#### 0.2 Production env defaults (document + set on Cloud Run)

| Variable | Recommendation | Rationale |
|----------|----------------|-----------|
| `OPUS_AUDIT_ENABLED` | **`false` (required)** | Do not enable in production; Opus is out of scope for this plan |
| `ABSTRACTION_ESCALATION_ENABLED` | `false` if speed-critical | Cuts pre-synthesis Sonnet re-reads |
| `SYNTHESIS_CONCURRENCY` | `8` (if Gemini rate limits allow) | Speeds partial segment phase only; max 16 |
| `SYNTHESIS_MAX_TOKENS` | `5000` (trial) | Slightly shorter generation; monitor truncation |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | `4000` (trial) | Smaller merge input |
| `ABSTRACTION_PDF_TEXT_FIRST` | `true` | Already default; verify not overridden |
| `ABSTRACTION_BATCH_ENABLED` | `true` | Already default |
| `GEMINI_FILE_API_ENABLED` | `true` | Already default |

**Chunk tuning (job-size dependent, start from logs):**

- **Bulk (≥100 docs):** try `BULK_SYNTHESIS_CHUNK_SIZE=180` if merge input is huge; try `200` if segment wave count dominates.
- **Avoid single-segment Sonnet-on-raw-abstracts** for 80–120 doc jobs where segment+merge may beat one giant pass — tune `SYNTHESIS_CHUNK_SIZE` downward (e.g. 80–100) based on measured merge duration.

#### 0.3 Operational checklist

- [ ] Confirm jobs use server synthesis (`usedServerSynthesis=true` path); investigate any browser fallback errors.
- [ ] Dashboard or log query for: `segment count`, `retry_wait`, `repair_retry`, `merge_tree_applied`, `final_validation_failed`, merge `latencyMs`.
- [ ] Verify Anthropic rate-limit headroom (429 → `retry_wait` adds up to 5 min backoff).

**Phase 0 success metrics:**
- Segment idle gaps between waves < 5s (worker enabled).
- Zero browser-fallback synthesis on durable jobs.
- P50 merge duration baseline recorded for 100-doc and 300-doc canonical test jobs.

---

### Phase 1 — Orchestration hardening (small code)

**Impact:** Medium on segment phase; low on merge itself.  
**Risk:** Low–medium (rate limits if concurrency+batch both raised aggressively).

#### 1.1 Un-cap synthesis batch limit

**Problem:** [`processSynthesisBatch`](../../../api/_lib/queue.js) forces `batchLimit: Math.min(4, DEFAULT_BATCH_LIMIT)` while abstraction allows up to 12 (or 64 fetch multiplier).

**Change:**
- Add `SYNTHESIS_BATCH_LIMIT` env var (default: match `WORKFLOW_BATCH_LIMIT`, clamp 1–16).
- Replace hard-coded `Math.min(4, …)` with `Math.min(SYNTHESIS_BATCH_LIMIT, DEFAULT_BATCH_LIMIT)`.
- Pass through in worker and API `/synthesis/process` kicks.

**Files:**
- `api/_lib/queue.js`
- `api/_lib/synthesis.js` (if `options.batchLimit || 4` fallback should use config default)
- `README.md`
- `test/synthesis.test.js`, `test/abstraction.test.js`

**Acceptance criteria:**
- With `SYNTHESIS_BATCH_LIMIT=8`, a 16-segment job processes 8 ready segments per batch (concurrency permitting).
- Existing tests pass with default still effectively 4 unless env set.

#### 1.2 Harden server-synthesis path visibility

**Change:**
- Log structured event when browser fallback triggers (`server_synthesis_fallback`).
- Expose `synthesisDriver: 'server' | 'browser'` on job result metadata when browser saves via `POST /result`.
- Job detail UI: show warning banner if result was browser-synthesized.

**Files:**
- `public/index.html`
- `api/jobs/[...path].js` (result save validation)
- `test/app.test.js`

#### 1.3 Release workflow defaults

**Change:** After Phase 0 validation, flip release worker deploy to `WORKER_DISABLED=false` and document `min-instances` recommendation.

**Acceptance criteria:**
- Fresh release deploys an active worker by default (or documents explicit opt-in with migration note).

---

### Phase 2 — Stream final opinion (medium code, highest perceived ROI)

**Impact:** Very high perceived; **zero** change to total generation wall-clock unless validation short-circuits early.  
**Risk:** Low for quality if stream is buffered server-side until validation passes.

#### 2.1 Design

```text
merge claim acquired
  → start Anthropic streaming Messages API
  → forward text deltas to job-scoped SSE or chunked poll buffer
  → UI renders opinion incrementally
  → on stream complete: validateFinalOpinion(buffer)
  → if valid: saveJobResult; if invalid: existing repair/retry path (non-streaming fallback OK)
```

#### 2.2 API surface

**Option A (recommended): SSE on existing job route**

- `GET /api/jobs/:id/synthesis/stream` — `text/event-stream`
- Events: `delta`, `done`, `error`
- Auth: same as other job routes.

**Option B: Poll buffer**

- `GET /api/jobs/:id/synthesis/preview` returns `{ text, complete, bytesReceived }`
- Simpler behind corporate proxies; slightly higher poll overhead.

#### 2.3 Implementation tasks

| Task | Files |
|------|-------|
| Add `invokeAnthropicModelStream()` | `api/_lib/model-client.js`, `api/_lib/anthropic-request.js` |
| Stream merge in `mergeSegmentsIntoOpinion` / `callSynthesisModel` when `options.stream=true` | `api/_lib/synthesis.js` |
| Buffer + validate before persist | `api/_lib/synthesis.js` |
| Job store: optional `synthesis_preview_text` column or ephemeral in-memory with Redis-like TTL — **prefer Postgres `jobs.metadata` JSON patch** to avoid migration | `api/_lib/jobs.js` |
| UI: subscribe during `pollServerSynthesis` when `mergeInProgress` | `public/index.html` |
| Follow-up path: optional streaming for `answerFollowupQuestion` | `api/_lib/synthesis.js` |

#### 2.4 Edge cases

- **Validation failure after full stream:** discard preview; run repair non-streaming; do not save invalid preview as final.
- **Merge claim lost mid-stream:** stop stream; another worker may retry.
- **Browser fallback:** out of scope for Phase 2 v1 (server path only).

**Acceptance criteria:**
- Time-to-first paragraph < 5s on 300-doc canonical job.
- Final saved result identical to non-streaming path on golden test fixtures.
- No partial opinion persisted in `job_results` until validation passes.

---

### Phase 3 — Merge input/output optimization (medium–large code)

**Impact:** Moderate direct reduction in Sonnet wall-clock (shorter input → faster TTFT; shorter output → faster completion).  
**Risk:** Medium — quality regression if prompts over-compressed.

#### 3.1 Tighter partial synthesis prompt

**Change:** Revise `PARTIAL_SYNTHESIS_PROMPT` to require table-shaped output (chain rows, defects list, running balance row) and explicitly forbid preamble/prose between links.

**Measure:** Compare merge input token count and final opinion quality on golden jobs before/after.

#### 3.2 Optional Gemini compaction pass

**When:** Segment count ≥ 6 OR estimated merge input > 40k tokens.

**Flow:**
```text
N partial summaries → single Gemini Flash compaction → compact scaffold → Sonnet merge prose
```

Reuse tree-merge pairing infrastructure but default to Flash, not Sonnet, for compaction.

#### 3.3 Prompt caching on merge user content

**Change:** Wrap segment summary block in Anthropic `cache_control: { type: 'ephemeral' }` when content ≥ 1024 tokens.

**Benefit:** Retries and follow-ups see cache hits on repeated prefix.

**Files:** `api/_lib/anthropic-request.js`, `callSynthesisModel` message builder.

#### 3.4 Single-segment path optimization

**Problem:** Jobs with one segment send all raw abstracts to Sonnet (no Gemini compression).

**Change:** When `plan.segments.length === 1` AND `abstracts.length >= BULK_JOB_MIN_ABSTRACTS`, force multi-segment planning unless user opts out (`SYNTHESIS_FORCE_SINGLE_PASS=true`).

**Risk:** Changes behavior for medium jobs — gate behind env default off initially.

**Acceptance criteria:**
- ≥20% reduction in P50 merge input tokens on 200-doc golden job (Phase 3.1 + 3.2).
- No increase in `final_validation_failed` rate on regression suite.
- Cache hit metrics visible in structured logs when retry occurs.

---

## 6. Architecture after all phases

```text
                    ┌─────────────────────────────────────┐
                    │           Cloud Run Worker           │
                    │  WORKER_DISABLED=false, min≥1       │
                    │  SYNTHESIS_BATCH_LIMIT=8            │
                    └──────────────┬──────────────────────┘
                                   │
     Abstraction (Gemini)         │         Partial synthesis (Gemini, concurrent)
           ──────────────────────┼──────────────────────────────
                                   │
                                   ▼
                    ┌─────────────────────────────────────┐
                    │  Final merge (Sonnet, streaming)     │
                    │  → preview SSE/poll → UI live text   │
                    │  → validate → saveJobResult              │
                    └─────────────────────────────────────────┘
```

---

### Deferred — Async Opus audit (not planned)

Opus audit (`OPUS_AUDIT_ENABLED=true`) adds a second full Claude Opus pass after Sonnet merge. It is **opt-in in code** but **disabled in production** and excluded from this initiative.

If Opus is ever revisited, the likely approach is async audit (save Sonnet draft first, audit in background). That work is **not scheduled** unless explicitly requested. Do not enable `OPUS_AUDIT_ENABLED` on Cloud Run as part of synthesis speed work.

---

## 7. Testing strategy

| Layer | Coverage |
|-------|----------|
| Unit | `batchLimit` config, stream parser, validation gate |
| Integration | Golden 100-doc and 300-doc fixtures; compare opinion structure pre/post prompt changes |
| Regression | Existing `npm test` (10 files) must stay green after each phase |
| Manual | Record screen: job with browser tab closed (Phase 0), streaming opinion (Phase 2) |

**Canonical benchmark jobs (create once, reuse):**
- 100 abstracts, bulk chunking, no failures
- 300 abstracts, bulk chunking, no failures

**Metrics to capture per run:**
- Segment count, segment phase duration, merge duration, output tokens, validation/repair count, time-to-first-token (Phase 2+).

---

## 8. Rollout & rollback

| Phase | Rollout | Rollback |
|-------|---------|----------|
| 0 | Set env on Cloud Run; no deploy required | Revert env vars |
| 1 | Normal release | Revert commit; defaults restore cap=4 |
| 2 | Feature flag `SYNTHESIS_STREAM_ENABLED=true` on API | Disable flag; non-streaming path remains |
| 3 | Prompt changes behind `SYNTHESIS_COMPACT_PARTIALS=true` | Disable flag; old prompt |

---

## 9. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| Gemini rate limits when batch+concurrency raised | Raise gradually; monitor 429/retry_wait; cap `SYNTHESIS_BATCH_LIMIT` at 8 initially |
| Stream shows invalid partial text | Label as "Draft preview"; validate before save; clear on failure |
| Shorter prompts lose curative detail | Golden job regression; landman review on 3 real jobs before prompt flip |
| Worker always-on cost | Start with `min-instances=1`; scale to 0 off-hours if needed |
| Single-segment forced split changes behavior | Env-gated; default off |

---

## 10. Success criteria (overall)

| Metric | Baseline (measure in Phase 0) | Target |
|--------|-------------------------------|--------|
| Time-to-first opinion text | ~60–120s | < 5s (Phase 2) |
| Total job time (300 doc) | TBD | ≥10% reduction via orchestration (Phase 0–1) |
| Browser-fallback synthesis rate | TBD | 0% on durable jobs |
| Segment wave idle gap | ~4s+ without worker | < 2s with worker |
| `final_validation_failed` rate | TBD | No regression > 1% absolute |

---

## 11. Open questions for review

1. **Worker cost vs reliability:** Is `min-instances=1` acceptable for production, or should we use min=0 with faster poll only?
2. **Streaming transport:** SSE (`/synthesis/stream`) vs poll buffer — any proxy constraints on the deployed API?
3. **Phase 3 prompt tightening:** Who signs off on quality regression testing (legal/landman review)?
4. **Single-segment forced split:** Worth doing, or rely on chunk env tuning only?

---

## 12. Recommended execution order

```text
Week 0 (immediate):  Phase 0 — deploy worker + env tuning + baseline metrics
Week 1:              Phase 1 — batch limit + fallback visibility + release defaults
Week 2–3:            Phase 2 — streaming merge (feature-flagged)
Week 4+:             Phase 3 — prompt/compaction/cache (flagged, quality-gated)
```

*Timeline expressed as sequencing dependency, not calendar commitment.*

---

## 13. Appendix: env var reference (quick)

| Variable | Default | Phase | Notes |
|----------|---------|-------|-------|
| `WORKER_DISABLED` | `true` (release) | 0, 1 | Set `false` for background processing |
| `SYNTHESIS_CONCURRENCY` | 4 | 0 | Partial segments only; max 16 |
| `SYNTHESIS_BATCH_LIMIT` | *new* 4→8 | 1 | Segments claimed per batch |
| `SYNTHESIS_MAX_TOKENS` | 6000 | 0, 3 | Final opinion cap |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | 5000 | 0, 3 | Partial summary cap |
| `SYNTHESIS_CHUNK_SIZE` | 120 | 0 | Docs per segment |
| `BULK_SYNTHESIS_CHUNK_SIZE` | 200 | 0 | Bulk jobs ≥100 abstracts |
| `OPUS_AUDIT_ENABLED` | **off (required in prod)** | — | Do not enable; out of scope |
| `SYNTHESIS_STREAM_ENABLED` | *new* off | 2 | Feature flag |
| `SYNTHESIS_COMPACT_PARTIALS` | *new* off | 3 | Feature flag |
| `ABSTRACTION_ESCALATION_ENABLED` | on | 0 | Set `false` for speed |
