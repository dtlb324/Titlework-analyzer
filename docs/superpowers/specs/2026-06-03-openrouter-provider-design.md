# OpenRouter Provider Support — Design

## Goal

To allow an operator to run this app’s model calls through OpenRouter instead of (or alongside) the direct Anthropic and Gemini APIs.

## Architecture

A custom API will translate requests between the app and OpenRouter.

## Implementation Plan

1. Create a new provider module pair (`openrouter-request.js`, `openrouter-stream.js`) following the existing pattern.
2. Update `model-client.js` to dispatch requests to the new provider based on the `MODEL_PROVIDER` environment variable.
3. Implement the translation layer in `openrouter-request.js`.
4. Test the integration using mock fetch.
5. Deploy and monitor performance.