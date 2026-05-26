# Synthesis Speed — Phase 0 Runbook

**Status:** Active (browser-driven mode, no background worker)  
**Canonical spec:** [2026-05-26-synthesis-speed-optimization-design.md](./superpowers/specs/2026-05-26-synthesis-speed-optimization-design.md)

Phase 0 configures production for speed tuning and reliable **server-side synthesis** while the background worker stays disabled. Users must **keep the browser tab open** until the job completes.

---

## Operating mode

```text
Browser tab open
  → POST /api/jobs/:id/synthesis/start
  → API kick: POST .../synthesis/process (50s budget on start)
  → Browser polls GET .../synthesis/status (~750ms)
  → Re-kick .../process after ~4s stall (pending/processing/retry_wait or merge)
  → Gemini partial segments (parallel, SYNTHESIS_CONCURRENCY)
  → Final Sonnet merge (sequential)
  → GET .../result
```

The worker service is deployed with `WORKER_DISABLED=true` and scale-to-zero. It does **not** drain queues until explicitly enabled later.

---

## Required production env (Cloud Run)

Set on **both API and worker** services unless noted.

| Variable | Value | Notes |
|----------|-------|-------|
| `WORKER_DISABLED` | `true` | Worker service only; keep loop off for now |
| `OPUS_AUDIT_ENABLED` | `false` | **Required** — do not enable |
| `WORKFLOW_KICK_ON_START` | `true` | Default; start endpoints kick first batch |
| `SYNTHESIS_CONCURRENCY` | `8` | Trial: partial segments only (max 16); lower if Gemini 429s |
| `SYNTHESIS_MAX_TOKENS` | `5000` | Trial: final Sonnet output cap |
| `SYNTHESIS_PARTIAL_MAX_TOKENS` | `4000` | Trial: smaller merge input |
| `ABSTRACTION_ESCALATION_ENABLED` | `false` | Skips extra Sonnet re-reads on low-confidence abstracts |
| `ABSTRACTION_PDF_TEXT_FIRST` | `true` | Default |
| `ABSTRACTION_BATCH_ENABLED` | `true` | Default |
| `GEMINI_FILE_API_ENABLED` | `true` | Default |

Releases from `main` apply the speed-related API env vars via `.github/workflows/release.yml`. Adjust in Cloud Run console if a trial value needs rollback.

### Example: manual API env update

```bash
gcloud run services update titlework-analyzer-api \
  --project YOUR_PROJECT \
  --region us-south1 \
  --update-env-vars "OPUS_AUDIT_ENABLED=false,SYNTHESIS_CONCURRENCY=8,SYNTHESIS_MAX_TOKENS=5000,SYNTHESIS_PARTIAL_MAX_TOKENS=4000,ABSTRACTION_ESCALATION_ENABLED=false"
```

---

## Chunk tuning (after baseline metrics)

Start from structured logs (`synthesis_merge_complete`, `synthesis_batch_complete`). Tune only when you see a clear bottleneck.

| Symptom | Knob |
|---------|------|
| Many segment waves, slow partial phase | Raise `SYNTHESIS_CONCURRENCY` (≤16) or `SYNTHESIS_CHUNK_SIZE` / `BULK_SYNTHESIS_CHUNK_SIZE` |
| Long Sonnet merge, huge input tokens | Lower `SYNTHESIS_PARTIAL_MAX_TOKENS` or chunk size |
| Single-segment job (all raw abstracts to Sonnet) | Lower `SYNTHESIS_CHUNK_SIZE` (e.g. 80–100) to force Gemini partials + smaller merge |

---

## Structured log events (Cloud Logging)

Filter on JSON `event` field:

| Event | When |
|-------|------|
| `synthesis_batch_complete` | Each `/synthesis/process` batch finishes |
| `synthesis_merge_complete` | Final opinion saved after merge |
| `synthesis_driver_browser_fallback` | Browser saved result via POST `/result` (avoid on durable jobs) |

**Merge event fields:** `jobId`, `segmentCount`, `singlePass`, `synthesisDurationMs`, `inputTokens`, `outputTokens`, `payloadBytes`, `status`, `warningFlags` (e.g. `repair_retry`, `merge_tree_applied`, `final_validation_failed`).

---

## Operational checklist

- [ ] API deploy includes Phase 0 env vars (`OPUS_AUDIT_ENABLED=false`, trial token/concurrency caps).
- [ ] Worker deploy keeps `WORKER_DISABLED=true`.
- [ ] Durable jobs complete with tab open; no `synthesis_driver_browser_fallback` in logs.
- [ ] Baseline P50 merge duration captured for representative 100-doc and 300-doc jobs.
- [ ] Gemini/Anthropic rate limits monitored (`retry_wait` in synthesis status).

---

## Success criteria (Phase 0)

1. Zero browser-fallback synthesis on durable server-abstraction jobs.
2. P50 merge duration baseline recorded.
3. Jobs finish end-to-end with tab open through final Sonnet merge.

Phase 1 (batch limit, fallback UI banner) and Phase 2 (streaming) follow after Phase 0 baseline is stable.
