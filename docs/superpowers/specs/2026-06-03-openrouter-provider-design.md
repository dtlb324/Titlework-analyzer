# OpenRouter Provider Support — Design

**Date:** 2026-06-03
**Status:** Approved (design); implementation plan pending

## Goal

Let an operator route model calls through [OpenRouter](https://openrouter.ai) instead of (or alongside) the direct Anthropic and Gemini APIs. OpenRouter is a gateway exposing an OpenAI-compatible chat-completions API that can serve Claude, Gemini, GPT, and other models. The operator should be able to run the entire app — abstraction, synthesis, and follow-ups — through OpenRouter if they choose.

This is operator-level configuration (env vars), consistent with the current single-tenant, `APP_PASSWORD`-gated deployment model. There is no per-end-user key entry.

## Context

Today `api/_lib/model-client.js` is the single dispatch point (`invokeModel`). It routes by model-name prefix:

- `gemini-*` → `invokeGeminiGenerateContent` (`gemini-request.js`)
- `claude-*` → `invokeAnthropicModel` / `invokeAnthropicModelStream` (`anthropic-request.js`, `anthropic-stream.js`)

The canonical internal request format is **Anthropic-shaped**: `{ model, maxTokens, system, messages }`, where `messages` is `[{ role, content }]` and `content` is a string or an array of blocks:

- `{ type:'text', text }`
- `{ type:'image'|'document', source: { type:'file_uri'|'base64', ... , media_type } }`

`gemini-request.js` already translates this canonical shape into Gemini's `contents` format. OpenRouter will translate it into OpenAI chat-completions format.

The `file_uri` source type is produced only by `enrichVisualDeliveryForModel`, which is gated by `isGeminiModel(model)`. It therefore never appears on a non-Gemini call path; OpenRouter calls carry `base64` sources, which translate cleanly.

## Architecture

A new provider module pair, mirroring the existing Anthropic/Gemini structure (one focused module per concern):

- **`api/_lib/openrouter-request.js`** — translate the canonical Anthropic-shaped request into an OpenAI chat-completions body, POST to `https://openrouter.ai/api/v1/chat/completions`, and normalize the response/usage back to the shared shape (`{ text, model, usage:{ input_tokens, output_tokens }, stopReason }`).
- **`api/_lib/openrouter-stream.js`** — consume OpenAI-format SSE (`data:` lines, `choices[].delta.content`, terminal `[DONE]`), returning the same shape as `consumeAnthropicMessageStream` (`{ text, model, usage, stopReason, firstDeltaAt }`).
- **`api/_lib/model-client.js`** — gains dispatch logic and key-error handling; remains the single entry point.

## Routing / Dispatch

`invokeModel` resolves the provider in this order:

1. **Slash-name detection** — if the model contains a provider slash (e.g. `anthropic/claude-sonnet-4-6`, `openai/gpt-4o`, `google/gemini-2.5-flash`), route to OpenRouter regardless of the global toggle.
2. **Global toggle** — if `MODEL_PROVIDER=openrouter`, route everything through OpenRouter, applying auto name-mapping (see below).
3. **Otherwise** — existing behavior: `gemini-*` → Gemini, `claude-*` → Anthropic.

A helper `shouldUseOpenRouter(model)` encapsulates rules 1+2 so it is unit-testable in isolation.

### Auto model-name mapping (global toggle only)

When `MODEL_PROVIDER=openrouter` and the model has no slash:

- `claude-*` → `anthropic/claude-*`
- `gemini-*` → `google/gemini-*`
- a name already containing `/` passes through unchanged

Slash-names supplied directly (rule 1) are never remapped.

## Message Translation (Anthropic-shaped → OpenAI)

- `system` (string or `[{ text }]`) → a leading `{ role:'system', content }` message.
- Text blocks → `{ type:'text', text }`.
- `image` blocks, `source.type==='base64'` → `{ type:'image_url', image_url:{ url:'data:<media_type>;base64,<data>' } }`.
- `document` (PDF) blocks, `source.type==='base64'` → OpenAI `{ type:'file', file:{ filename, file_data:'data:application/pdf;base64,<data>' } }`.
- `source.type==='file_uri'` → **not supported**; throw a clear error (statusCode 400). This path is Gemini-only and should never reach OpenRouter; we fail loudly rather than silently drop content.

### Prompt caching

Preserve caching where sensible:

- When the resolved target is an `anthropic/*` model, preserve `cache_control` on content parts — OpenRouter passes Anthropic cache hints through.
- For non-Anthropic targets, strip `cache_control` (the underlying provider has no equivalent).

## Request Specifics

- Headers: `Authorization: Bearer <OPENROUTER_API_KEY>`, `Content-Type: application/json`, plus `HTTP-Referer` and `X-Title` for OpenRouter attribution.
- `max_tokens` mapped from `maxTokens`.
- Stream when `maxTokens > 8192`, mirroring the Anthropic path. The existing `ANTHROPIC_NON_STREAMING_MAX_TOKENS` constant is promoted to a shared threshold reused by both providers.
- Reuse the existing timeout plumbing (`options.createTimeoutSignal` / `createDefaultTimeoutSignal`) unchanged.

## Errors & Key Handling

- `openRouterApiKeyError()` returns a clear message when `OPENROUTER_API_KEY` is missing but OpenRouter is the selected provider. Wired into `modelApiKeyError(model)` so existing callers (`abstraction.js`, `synthesis.js`, `analyze.js`) surface a 503 exactly as they do today for Anthropic/Gemini.
- Extend `sanitizeProviderErrorMessage` to redact OpenRouter keys (`sk-or-...`) in addition to the existing Anthropic/Gemini key patterns.
- Non-OK HTTP responses raise an `Error` with `.status`, matching the Anthropic path so retry/backoff classification in `abstraction.js` is unchanged.

## Configuration (new env vars)

| Name | Required | Notes |
|------|----------|-------|
| `OPENROUTER_API_KEY` | When OpenRouter is used | OpenRouter API key (`sk-or-...`). |
| `MODEL_PROVIDER` | Optional | `openrouter` flips the global toggle. Unset / any other value = today's behavior. |
| `OPENROUTER_REFERER` | Optional | Overrides the `HTTP-Referer` attribution header (sensible default). |
| `OPENROUTER_TITLE` | Optional | Overrides the `X-Title` attribution header (sensible default). |

README environment-variable table and `AGENTS.md` updated to document these.

## Testing

New test files, following the existing per-provider, fetch-mocked pattern (no live network):

- **`test/openrouter-request.test.js`** — translation of text/image/PDF blocks; system handling; slash-name + global-toggle dispatch via `shouldUseOpenRouter`; auto name-mapping; `cache_control` preservation for `anthropic/*` and stripping otherwise; `file_uri` rejection; usage normalization; missing-key error.
- **`test/openrouter-stream.test.js`** — OpenAI SSE parsing, delta accumulation, usage/stop-reason extraction, `[DONE]` termination.

## Scope (YAGNI — explicitly out)

- No UI for end-users to enter their own keys (operator env config only).
- No per-request provider selection from the browser.
- No OpenRouter-specific routing preferences (provider fallbacks, provider pinning, model fallback lists).
