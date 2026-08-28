# ADR-0002: Streaming is the single adapter primitive

- Status: Accepted
- Date: 2026-08-28
- Context: `.scratch/streaming/spec.md`

## Decision

`ProviderAdapter.chatStream` (an async iterable of `{type:"text"}` deltas plus a final `{type:"done", raw}`) is the one wire path per provider. `chat` is implemented as the accumulation of `chatStream` and kept only for non-streaming call sites (the summarizer). The provider-specific SSE formats live in pure accumulators — `accumulateDeepseekChunks` (OpenAI chunks: concatenated `delta.content`, indexed `tool_calls` partials, usage on the final chunk) and `accumulateClaudeEvents` (Anthropic: `text_delta` joins per block, `input_json_delta` partials assembled per tool_use block and parsed at the end) — both producing the same raw shapes a non-streaming call returns, so `normalizeResponse` is unchanged.

## Consequences

- Streaming and non-streaming responses can never diverge: one code path, one normalization.
- The format differences the user cares about ("不同大模型的不同格式") are contained in two small pure functions, fully unit-testable without SDK or network; the SDK-stream glue in `client.ts` is thin and validated live.
- `chatStream` becomes the test seam alongside `chat`; fakes implement one method.
- Trade-off accepted: every model call now uses the streaming transport (slightly more overhead than a one-shot call), including the summarizer — acceptable, since usage data still arrives on the final chunk.
- Trade-off accepted: `chat` internally streams even when the caller wanted a one-shot response; the CLI's `--no-stream` disables live printing, not the transport.
