# Durable Jobs Master Plan

## Purpose

The current app has been hardened for request-size limits, timeouts, local checkpoints, and large-PDF handling, but it is still primarily a browser-orchestrated workflow:

1. The browser reads files into memory.
2. The browser splits large PDFs.
3. The browser sends synchronous requests to `/api/analyze`.
4. A Vercel function proxies each request to Anthropic.
5. The browser owns progress, retry orchestration, and final state.

That design is workable for smaller projects and is now safer than before, but 200-400 document title projects are better served by a durable job pipeline. This plan defines the target architecture and implementation phases.

## Goals

- Let a user start a large title-analysis job and safely leave or refresh the browser.
- Persist job state, file/chunk metadata, abstracts, synthesis segments, final results, errors, and retry counts.
- Process each document or chunk independently so one bad file does not fail the whole run.
- Keep every completed abstract and synthesis segment as a checkpoint.
- Support progress polling, resume links, failed-chunk retry, and job history.
- Preserve privacy by making storage, retention, and deletion explicit.
- Enable future model routing and cost controls.

## Non-goals for the first phase

- Do not move raw file storage server-side in phase 1.
- Do not move Anthropic/model calls server-side in phase 1.
- Do not add background workers in phase 1.
- Do not store raw PDFs, images, CSV text, base64 payloads, or full title opinions unless the implementation phase explicitly calls for it.

## Recommended stack

This project is a small Vercel app with a static frontend and API functions. The durable architecture should stay close to that deployment model.

Recommended components:

- Job metadata/result database: Neon Postgres or Vercel Postgres.
- File/chunk storage: Vercel Blob.
- Background workflow: Vercel Workflow if available for the project, otherwise Inngest or a simple DB-backed queue as a fallback.
- Progress UI: polling first; Server-Sent Events can be considered later if polling becomes insufficient.

Rationale:

- Postgres gives clear relational state for jobs, files, chunks, abstracts, segments, and results.
- Blob storage avoids putting large documents in the database and avoids routing big uploads through API functions.
- A workflow/queue makes long jobs durable across browser refreshes and function restarts.
- Polling keeps the frontend simple and fits the current single-file UI.

## Core data model

### jobs

Tracks one analysis run.

Suggested fields:

- `id`
- `status`: `created`, `uploading`, `abstracting`, `synthesizing`, `complete`, `failed`, `partial_failed`, `canceled`
- `subject_tract`
- `context_notes`
- `total_documents`
- `total_chunks`
- `completed_chunks`
- `failed_chunks`
- `completed_documents`
- `failed_documents`
- `current_phase`
- `error_message`
- `warning_count`
- `estimated_cost_cents`
- `actual_cost_cents`
- `created_at`
- `updated_at`
- `started_at`
- `completed_at`
- `canceled_at`

### job_documents

Tracks original user-visible documents.

Suggested fields:

- `id`
- `job_id`
- `original_filename`
- `media_type`
- `size_bytes`
- `document_order`
- `status`: `pending`, `uploading`, `uploaded`, `abstracting`, `complete`, `failed`, `skipped`
- `chunk_count`
- `completed_chunk_count`
- `failed_chunk_count`
- `fingerprint`
- `error_message`
- `created_at`
- `updated_at`

### document_chunks

Tracks model-processing units: PDF page ranges, images, or CSV records.

Suggested fields:

- `id`
- `job_id`
- `document_id`
- `chunk_order`
- `original_filename`
- `blob_key`
- `blob_url`
- `media_type`
- `size_bytes`
- `page_start`
- `page_end`
- `split_from`
- `fingerprint`
- `status`: `pending`, `queued`, `processing`, `complete`, `failed`, `skipped`
- `attempt_count`
- `last_error_type`
- `last_error_message`
- `payload_bytes`
- `latency_ms`
- `model_used`
- `input_tokens`
- `output_tokens`
- `created_at`
- `updated_at`
- `completed_at`

### document_abstracts

Stores completed abstracts.

Suggested fields:

- `id`
- `job_id`
- `document_id`
- `chunk_id`
- `abstract_text`
- `model_used`
- `payload_bytes`
- `latency_ms`
- `input_tokens`
- `output_tokens`
- `created_at`

### synthesis_segments

Stores checkpointed partial syntheses.

Suggested fields:

- `id`
- `job_id`
- `segment_order`
- `document_start`
- `document_end`
- `summary_text`
- `status`: `pending`, `processing`, `complete`, `failed`
- `attempt_count`
- `model_used`
- `payload_bytes`
- `latency_ms`
- `input_tokens`
- `output_tokens`
- `error_message`
- `created_at`
- `updated_at`
- `completed_at`

### job_results

Stores the final result.

Suggested fields:

- `id`
- `job_id`
- `final_title_opinion`
- `warnings_json`
- `failed_documents_json`
- `model_used`
- `input_tokens`
- `output_tokens`
- `generated_at`

### followup_messages

Optional durable Q&A history.

Suggested fields:

- `id`
- `job_id`
- `role`: `user`, `assistant`
- `message_text`
- `created_at`

## API contract

### Phase 1 endpoints

These add durable job/progress metadata while the browser still runs the current analysis pipeline.

#### `POST /api/jobs`

Creates a job record.

Request:

```json
{
  "subjectTract": "optional text",
  "contextNotes": "optional text",
  "totalDocuments": 123
}
```

Response:

```json
{
  "job": {
    "id": "job_...",
    "status": "created",
    "totalDocuments": 123,
    "completedDocuments": 0,
    "failedDocuments": 0,
    "currentPhase": "created",
    "createdAt": "..."
  }
}
```

#### `GET /api/jobs/:id`

Fetches current job status.

Response:

```json
{
  "job": {
    "id": "job_...",
    "status": "abstracting",
    "totalDocuments": 123,
    "completedDocuments": 48,
    "failedDocuments": 1,
    "currentPhase": "Abstracting batch 24 of 62",
    "errorMessage": null,
    "updatedAt": "..."
  }
}
```

#### `PATCH /api/jobs/:id`

Updates progress from the browser during phase 1.

Request:

```json
{
  "status": "abstracting",
  "completedDocuments": 48,
  "failedDocuments": 1,
  "currentPhase": "Abstracting batch 24 of 62",
  "errorMessage": null
}
```

#### Optional `GET /api/jobs`

Returns recent jobs for a future history screen.

#### Optional `POST /api/jobs/:id/cancel`

Marks a job canceled. Actual worker cancellation comes later.

### Later-phase endpoints

#### `POST /api/jobs/:id/uploads`

Creates signed Blob upload URLs or registers uploaded files/chunks.

#### `POST /api/jobs/:id/start`

Starts server-side processing after all files are uploaded.

#### `POST /api/jobs/:id/retry`

Retries failed chunks or synthesis segments.

#### `GET /api/jobs/:id/result`

Fetches final title opinion and warnings.

## State transitions

```text
created
  -> uploading
  -> abstracting
  -> synthesizing
  -> complete

Any active state
  -> failed
  -> partial_failed
  -> canceled
```

Rules:

- `created` means metadata exists but no processing has started.
- `uploading` means file/chunk storage is in progress.
- `abstracting` means chunks are being converted into abstracts.
- `synthesizing` means abstracts are being merged into a title opinion.
- `complete` means final title opinion exists.
- `partial_failed` means some chunks failed, but the user may retry or synthesize with warnings.
- `failed` means the job cannot continue without user action.
- `canceled` means user intentionally stopped the job.

## Phase roadmap

### Phase 1: job records and progress polling

Purpose:

Add durable job metadata without changing the current browser-driven processing path.

Implementation:

- Add job persistence.
- Add `POST /api/jobs`, `GET /api/jobs/:id`, and `PATCH /api/jobs/:id`.
- Create a job before analysis starts.
- Patch progress after each abstraction batch.
- Patch status during synthesis.
- Patch final status on success/failure.
- Add polling so a refreshed browser can show the latest job status.
- Show a job ID or resumable job link in the UI.

Keep unchanged:

- Files still live in browser memory.
- Existing `/api/analyze` proxy remains the model call path.
- Local PDF splitting remains in the browser.

Benefits:

- Establishes the shared job contract for every later phase.
- Gives users a durable job ID.
- Makes progress and failures inspectable.
- Adds a foundation for resume/history UI.

### Phase 2: durable file/chunk storage

Purpose:

Move uploaded file/chunk persistence out of browser memory.

Implementation:

- Add Vercel Blob upload flow.
- Store file/chunk metadata in Postgres.
- Prefer direct browser-to-Blob uploads with signed URLs.
- Keep PDF splitting in the browser initially unless server-side splitting becomes necessary.
- Store fingerprints/checksums to prevent stale chunk reuse.
- Add retention/deletion policy.

Benefits:

- Browser refreshes no longer lose uploaded files.
- Large jobs no longer depend on browser memory.
- Server-side processing can fetch chunks from storage in phase 3.

### Phase 3: server-side abstraction processing

Purpose:

Move document abstraction out of the browser into durable server-side chunk processing.

Implementation:

- Process each `document_chunks` row as a unit of work.
- Fetch chunk from Blob.
- Build model request with request-envelope guard.
- Call model.
- Save abstract immediately.
- Mark chunk complete or failed.
- Retry 413/504 failures.
- Split PDF chunks further when possible.

Benefits:

- Completed abstracts survive browser close/refresh.
- One failed chunk does not erase prior work.
- Model calls become observable and retryable per chunk.

### Phase 4: workflow/queue

Purpose:

Make long jobs durable and independently retryable.

Implementation:

- Add workflow/queue processor.
- Claim pending chunks with concurrency limits.
- Use retry/backoff policies.
- Update chunk/job status after every attempt.
- Support cancellation.
- Record latency, tokens, payload size, retry count, and error type.

Benefits:

- Jobs continue after browser disconnect.
- Function timeouts no longer kill whole jobs.
- Backpressure and rate limits are easier to control.

### Phase 5: durable synthesis

Purpose:

Move final synthesis into the job pipeline using saved abstracts.

Implementation:

- Order abstracts by original document/chunk order.
- Build dynamic synthesis segments under request-size budget.
- Save every segment summary.
- Retry failed segments.
- Merge segment summaries into final title opinion.
- Save final result and warnings.

Benefits:

- Late synthesis failure does not waste completed abstraction work.
- Segment checkpoints make 200-400 document jobs safer.
- Follow-ups can use durable final results and relevant abstracts instead of full conversation history.

### Phase 6: resume/history UI

Purpose:

Give users a durable job experience.

Implementation:

- Add job status page or route-like view.
- Show status, progress, failed files, retry counts, and current phase.
- Poll `GET /api/jobs/:id`.
- Allow retry failed chunks.
- Allow synthesize-with-warnings if some chunks fail.
- Add job history if authentication/privacy model supports it.

Benefits:

- Users can leave and come back.
- Failed documents are visible and actionable.
- Prior results can be downloaded or reviewed later.

## Retry policy

Recommended defaults:

- Abstraction chunk attempts: 3 automatic attempts.
- 429/rate limit: respect `Retry-After`; otherwise exponential backoff.
- 413/payload too large: split PDF chunks smaller when possible; otherwise fail chunk with user guidance.
- 504/timeout: retry with smaller PDF chunks when possible; otherwise retry after backoff.
- Synthesis segment attempts: 2 automatic attempts, then split segment smaller.
- Final merge attempts: 2 automatic attempts, then merge fewer/lower-volume segment summaries if possible.

## Privacy and retention

The project handles courthouse/title documents that may include sensitive ownership information. Durable storage must be explicit.

Recommendations:

- Do not store raw files until phase 2 explicitly adds storage and retention rules.
- Store only metadata in phase 1.
- For Blob files, define a default retention period such as 7, 14, or 30 days.
- Add a delete-job operation that removes job metadata, stored files, abstracts, synthesis segments, and final results.
- Do not log document contents, base64 data, full abstracts, or full title opinions.
- Logs should include IDs, statuses, payload sizes, latency, retry counts, model names, token usage, and error types only.

## Cost controls

Durable jobs make cost tracking easier.

Recommended metrics:

- Input tokens per chunk.
- Output tokens per chunk.
- Input/output tokens per synthesis segment.
- Model used.
- Estimated cost.
- Actual cost where available.
- Retry cost.

Future policies:

- Max documents per job.
- Max pages/chunks per job.
- Max estimated job cost.
- Per-password or per-user quota once authentication is improved.
- Cheaper model for abstraction and stronger model for final synthesis.

## Model routing direction

Initial server-side implementation can keep the current model choices:

- Abstraction: Claude Haiku 4.5.
- Synthesis/follow-ups: Claude Sonnet 4.6.

Future cost optimization:

- Evaluate Gemini Flash or GPT-4.1 mini for abstraction.
- Keep Sonnet for final mineral/title reasoning until evals prove a cheaper model is reliable.
- Retry low-confidence or failed cheap-model abstractions with a stronger model.

## Testing plan

Phase 1 tests:

- Create job.
- Fetch job.
- Patch job status/progress.
- Reject invalid status transitions.
- Frontend creates job before analysis.
- Frontend patches progress after abstraction batches.
- Frontend patches failed status on errors.
- Existing tests still pass.

Later tests:

- Blob upload registration.
- Chunk metadata persistence.
- Worker claims and completes chunks.
- Worker retries 413/504 failures.
- Failed chunk does not fail completed chunks.
- Synthesis segments are saved and retried independently.
- Job resume UI renders correct state after refresh.

## Implementation order

Recommended order:

1. Phase 1 job metadata and polling.
2. Phase 2 file/chunk storage.
3. Phase 3 server-side abstraction.
4. Phase 4 workflow/queue durability.
5. Phase 5 durable synthesis.
6. Phase 6 resume/history UI.

Some tasks can run in parallel after phase 1 establishes the schema:

- Blob upload UI and file metadata endpoints.
- Worker design against the agreed chunk schema.
- Resume/status UI against the agreed job API.
- Tests/docs for job/chunk states.

Avoid parallel implementation before phase 1 because agents may invent incompatible schemas and endpoint contracts.

## Open questions

- Which durable database should be provisioned for this deployment?
- Is Vercel Blob available for the project/team?
- Should users authenticate individually, or is the shared `APP_PASSWORD` still acceptable?
- What retention period is acceptable for uploaded title documents?
- Should final title opinions be stored durably by default?
- Should users be able to synthesize with failed documents omitted and warnings included?
- What is the maximum acceptable cost per job?
- Should model-provider choice be configurable per deployment?

## First implementation prompt

Use this prompt for the first coding agent:

```text
Implement phase 1 of docs/architecture/durable-jobs-master-plan.md.

Scope:
- Add durable job metadata and progress polling.
- Add POST /api/jobs, GET /api/jobs/:id, and PATCH /api/jobs/:id.
- Create a job before analysis starts.
- Patch progress during abstraction and synthesis.
- Patch complete/failed status.
- Show a job ID or resumable job link in the UI.
- Keep the current browser-driven file processing and /api/analyze model calls intact.

Do not implement:
- Blob storage.
- Server-side document processing.
- Background workers.
- Durable raw document storage.
- Durable final title opinion storage unless needed for minimal metadata.

Before coding:
- Inspect the current repo and this master plan.
- If adding durable storage requires a third-party service not already configured, stop and explain the options instead of choosing silently.

Tests:
- Add tests for job create/fetch/update.
- Add tests that frontend code creates jobs, polls status, and reports failures.
- Run npm test.
```
