Status: ready-for-agent

# Spec: agent mode with tools

## Problem Statement

The CLI is one-shot chat. The user wants it to actually do things: the model should be able to read, write, edit, search, and list files, and run shell commands — an agent loop that executes tools and feeds results back until it answers.

## Solution

Tools are always available and the model decides whether to call them: the model is advertised seven tools (`read_file`, `write_file`, `edit_file`, `grep`, `glob`, `bash`, `list_files`), each with a name, description, and JSON-schema parameters. The agent loop sends the conversation (with tool schemas) to the model; while the model requests tools, the CLI executes them against the current directory and feeds the results back; it stops on a final text answer or after 10 tool rounds. When the model calls no tools, the run is exactly a one-shot conversation. `read_file` controls response length via `offset`/`maxLines` and tells the model how to continue via a `[TRUNCATED]` marker.

## Verdict (from prototype)

A throwaway HTML prototype (`prototype/tools` branch, `src/prototype-tools.html`) validated the loop and the seven tool contracts against a virtual filesystem. Settled decisions: tool errors feed back as tool results (the model recovers, nothing crashes); the iteration cap aborts without executing the exceeding round; tool results are capped at 8000 chars; normalized tool calls/results hide provider wire differences (OpenAI `tool_calls` vs Anthropic `tool_use`/`tool_result`). **Deferred by the user:** the bash sandbox policy — a later requirement will define it; bash currently executes commands unsandboxed.

## User Stories

1. As a user, I want tools available by default, so that the model can inspect and modify the workspace without any extra flag.
2. As a user, I want the model's tool requests executed against the real current directory, so that results reflect actual files.
3. As a user, I want tool results fed back to the model automatically, so that it can iterate until it has the answer.
4. As a user, I want the loop to stop on a final text answer, so that I get a normal reply when no more tools are needed.
5. As a user, I want a `read_file` that paginates via `offset`/`maxLines` and signals remaining content with a `[TRUNCATED]` marker, so that long files are read across multiple bounded calls.
6. As a user, I want tool failures (missing file, unmatched oldText) to come back to the model as results, so that it can adapt instead of the CLI crashing.
7. As a user, I want an iteration cap so a model that keeps requesting tools doesn't run forever.
8. As a user, I want file tools confined to the workspace (path escapes rejected), so that a confused model can't touch files outside it.
9. As a user, I want `--verbose` to report provider, model, iterations, and tool-call count, so that agent runs are observable.
10. As a developer, I want the loop testable against a fake adapter, so that tests stay network-free.

## Implementation Decisions

- **Seam stays one**: `ProviderAdapter.chat({ model, messages, tools })` replaces `send`; it returns the provider-specific raw response (now including tool calls). `runConversation` and the agent loop both go through it.
- **Normalized message model**: `system`/`user`/`assistant`/`tool` with tool calls and tool results; the wire module translates to each provider's format (OpenAI `role:"tool"` + `tool_call_id`; Anthropic tool results folded into a user turn with `tool_result` blocks). Unit-tested without any SDK.
- **Agent loop** (`src/agent/loop.ts`): tool rounds capped (default 10); a round past the cap aborts without executing; tool errors become result content; results capped at 8000 chars with a truncation marker; unknown tool names feed back an error listing available tools.
- **Tools** (`src/tools/`): one file per tool + registry. `read_file` pagination matches the prototype exactly (offset/maxLines, `[TRUNCATED — N lines total; continue with offset=M]`). `edit_file` replaces the first exact occurrence per edit, fails the whole call on a miss. File tools resolve paths against the workspace root and reject escapes; grep/glob skip `node_modules`, `.git`, `dist`, etc. `bash` runs unsandboxed (policy deferred), output capped.
- **CLI**: no flag — tools are always advertised; the agent system prompt describes the workspace, read_file pagination, and tool-preferences. Aborted loops print the partial answer, a stderr warning, and exit 1.

## Testing Decisions

- **Seam**: fake `ProviderAdapter.chat` scripts a sequence of raw responses (tool_use → final) — no network. Wire translation, normalization (both providers' tool-call shapes), and each tool's filesystem behavior are tested directly; tools run against a temp workspace fixture.
- **Key cases**: pagination + continuation offset; edit oldText miss; path escape rejection; grep skipping node_modules; multi-tool rounds; unknown tool; iteration-cap abort without executing the extra round; system prompt as first message.
- **Live E2E**: agent mode against the real API (DeepSeek's Anthropic-compatible endpoint) called `list_files` against the actual repo and answered from real results — the full Anthropic wire path validated live.

## Out of Scope

- ~~Bash sandboxing / confirmation / allowlists~~ → implemented by the security policy (see `.scratch/security/spec.md`)
- A `--no-tools` opt-out (not requested; advertising tools costs tokens, revisit if needed)
- Streaming responses
- Multi-turn interactive agent sessions / session persistence
- Tool-call concurrency limits, retries, rate limiting
- A system-prompt configuration flag

## Further Notes

- Prototype (primary source): branch `prototype/tools`, file `src/prototype-tools.html`.
- DeepSeek confirmed to support OpenAI-style tool calls (V3.2+ incl. thinking mode); it also serves an Anthropic-compatible endpoint (`/anthropic`), which the live E2E exercised through the claude provider path.
- Glossary updated in `CONTEXT.md`: tool, tool call, agent loop.
