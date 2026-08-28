Status: ready-for-agent

# Spec: streaming responses + spinner

## Problem Statement

The CLI is one-shot non-streaming: it waits for the full response, then prints. Users want to see tokens arrive as the model generates, and a spinner while waiting. The two providers use different streaming wire formats — DeepSeek speaks OpenAI-compatible SSE (`choices[].delta`), Claude speaks Anthropic SSE (`content_block_delta` / `input_json_delta`) — and the adapter layer must translate both onto one surface.

## Solution

Streaming becomes the adapter layer's **single primitive**: `ProviderAdapter.chatStream` returns an async iterable of `StreamEvent` (`{type:"text"}` deltas + a final `{type:"done", raw}`). `chat` stays for the summarizer and is implemented as the accumulation of `chatStream` — one wire path per provider, so the non-streaming and streaming responses can never diverge. The format-specific logic lives in pure, testable accumulators: `accumulateDeepseekChunks` (OpenAI chunks → `DeepseekRaw`) and `accumulateClaudeEvents` (Anthropic events → `ClaudeRaw`). Each format's quirks are handled there: OpenAI tool_calls arrive as indexed deltas (id/name on the first chunk, `arguments` partials across chunks, `[DONE]`-terminated); Anthropic delivers text via `content_block_delta.text_delta` and tool args via `input_json_delta` partial JSON, assembled per content block and parsed at the end.

The agent loop always consumes `chatStream` and forwards text deltas through an optional `onText` callback and lifecycle through `onPhase` ("waiting" before each model call / "streaming" on first text / "done" at the end). The CLI owns the UI: a dependency-free ANSI spinner (`src/spinner.ts`, TTY-only, stderr) spins during "waiting" and stops when text flows. Streaming output is default; `--no-stream` keeps the old behavior (print the final answer once). Streamed text is printed live and not re-printed at the end.

## User Stories

1. As a user, I want the model's answer to appear as it is generated, so that long answers don't feel like a hang.
2. As a user, I want a spinner while waiting (initial connect, tool rounds, compaction), so that the CLI always signals it's working.
3. As a user, I want both providers to stream: DeepSeek's OpenAI wire and Claude's Anthropic wire (including tool calls over streaming), so that tool-using sessions work for either provider.
4. As a user, I want `--no-stream` to restore one-shot behavior, so that scripts/pipes get the plain final answer.
5. As a user, I want the spinner to respect TTY: no spinner noise when output is piped.

## Implementation Decisions

- **Seam**: `chatStream` on `ProviderAdapter` is the test seam; the pure accumulators (`src/adapters/stream.ts`) are unit-tested against both wire formats; the SDK-stream glue in `client.ts` is thin (validated live).
- **`chat` = `collectStream(chatStream)`**: one wire path. The summarizer keeps using `chat`.
- **Unified events**: `{type:"text", text}` per content delta; `{type:"done", raw}` with the fully accumulated provider raw response (reuses `normalizeResponse`). No `error` event — stream errors propagate as exceptions.
- **OpenAI accumulation**: concatenate `delta.content`; tool_calls keyed by `delta.tool_calls[].index`, `arguments` partials appended; `stream_options.include_usage` so the final chunk carries usage.
- **Anthropic accumulation**: text blocks joined from `text_delta`; tool_use blocks assembled from `content_block_start` + `input_json_delta` partials, parsed at the end (reusing `safeParseJson`); usage from `message_start` (input) + `message_delta` (output).
- **Loop**: consumes `chatStream` + `collectStream`; `onText` forwards text deltas; `onPhase` emits waiting/streaming/done (done in a `finally`, so every exit path stops the spinner).
- **Spinner**: `src/spinner.ts`, hand-rolled (frames ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏, 80ms), writes to stderr with `\r` + ANSI erase; no-op when stderr is not a TTY.
- **CLI**: `--no-stream` flag; default streams. Stream mode prints live text + one trailing newline; no-stream mode prints `result.text` once at the end. Spinner runs in both modes.
- **ADR-0002** records the single-stream-primitive decision.

## Testing Decisions

- **Seam**: pure accumulators (text split across chunks; tool-call index deltas; usage capture; missing content → null; both formats), `collectStream` (onText order, done, missing-done error), loop streaming (onText receives deltas in order; onPhase sequence waiting→streaming→done), spinner (non-TTY no-op; TTY writes frames and stops cleanly with fake timers), CLI `--no-stream` parsing.
- **Live E2E**: stream a real DeepSeek run over both the OpenAI wire (provider=deepseek) and the Anthropic wire (provider=claude with the /anthropic base URL), including a tool-using question, verifying live text and correct final answers.
- **Regression**: all existing adapter/loop tests keep passing (fake adapter gains `chatStream`).

## Out of Scope

- Streaming token counts mid-generation (`usage` arrives on the final chunk only)
- A remote/queue transport (the CLI is local; streaming is direct SSE)
- Selecting a different spinner frame set per platform

## Further Notes

- The tools spec's bash sandbox item and the security spec are untouched by this change (policy evaluation is orthogonal to transport).
