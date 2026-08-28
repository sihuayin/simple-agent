# 01: Streaming responses over both wire formats + spinner

**What to build:** `chatStream` becomes the single adapter primitive (`{type:"text"}` deltas + `{type:"done", raw}`); `chat` = its accumulation. Pure accumulators translate each provider's SSE format — OpenAI chunks (`delta.content`, indexed `tool_calls` partials, usage on final chunk) and Anthropic events (`content_block_delta.text_delta`, `input_json_delta` partials assembled per block, usage from message_start/message_delta). The loop consumes the stream, forwarding text via `onText` and lifecycle via `onPhase` (waiting/streaming/done). A dependency-free TTY-only spinner (`src/spinner.ts`) runs while waiting. CLI defaults to streaming; `--no-stream` prints the final answer once.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `accumulateDeepseekChunks`: text across chunks joins; tool_calls keyed by index with partial arguments; usage from the final chunk; missing content → null
- [ ] `accumulateClaudeEvents`: text_delta joins per block; tool_use assembled from content_block_start + input_json_delta, parsed at the end; usage from message_start/message_delta; multiple blocks in order
- [ ] `collectStream`: forwards text deltas in order, resolves the done raw, errors without done
- [ ] Adapters stream via the SDK (`stream: true`), `chat` = accumulation of `chatStream` — one wire path
- [ ] Loop consumes `chatStream`; `onText` receives deltas in order; `onPhase` fires waiting → streaming → done (done on every exit path)
- [ ] Spinner: TTY-only, frames animate, stop clears the line and the timer; no output when not a TTY
- [ ] CLI: streaming default with live text + trailing newline; `--no-stream` restores one-shot print; spinner runs in both modes
- [ ] Live E2E: real streaming over the OpenAI wire (deepseek) and the Anthropic wire (claude /anthropic), including a tool-using question
- [ ] Full suite green (119 existing + new), typecheck, build
