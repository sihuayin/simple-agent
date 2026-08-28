# ADR-0005: MCP support (Model Context Protocol, tools only)

- Status: Accepted
- Date: 2026-08-28
- Context: `.scratch/mcp/spec.md`; prototype on `prototype/mcp`

## Decision

External tool servers are declared in a workspace `.mcp.json` (Claude Desktop format: `command/args/env` for local stdio servers, `url` for remote streamable HTTP). At session start a manager connects to every server in parallel, discovers tools via `tools/list`, and merges them into the model-visible set; calls route back to the owning server; connections close in the session `finally`. The client is the official `@modelcontextprotocol/sdk` (Client + StdioClientTransport + StreamableHTTPClientTransport) — the SDK owns MCP's evolving wire compatibility; we stay a thin wrapper (`src/mcp/`).

**Tool naming**: `mcp_<server>_<tool>` (underscore separator). The provider wire layer (OpenAI-format DeepSeek, Anthropic) only accepts `^[a-zA-Z0-9_-]+$` tool names — a colon gets a 400, discovered live in the first E2E. Descriptions are prefixed `[MCP 服务器 "<server>"]`.

**Security**: MCP tools are black boxes, so the policy **fallback is ask** (non-TTY auto-blocks). Trusted servers are allow-listed in `.rules`; the rule `tool` field now matches as a glob (`mcp_files_*` → that server's tools; literal names behave exactly as before). MCP calls run the full pipeline: policy → PreToolUse hooks → execute → PostToolUse hooks.

**Failure semantics**: a server that fails to connect/handshake is skipped with a loud stderr warning, the session continues; a corrupt `.mcp.json` fails loudly (like `.rules`/`.hooks`); runtime call failures (crash/timeout/`isError`) become `[mcp error] …` tool results and the loop continues. `--verbose` prints `[mcp=N/M servers, K tools, F failed]`.

## Consequences

- Loop tool lookup = built-in registry first, then the MCP table (`input.mcpTools`).
- `tools/call` content is normalized to text (text parts joined, image/resource placeholders); `isError` prefixes `[mcp error]`; the existing result cap/truncation applies.
- New runtime dependency: `@modelcontextprotocol/sdk`.
- Trade-offs accepted: MCP resources/prompts, sampling, and OAuth/remote auth are out of scope for v1 (tools only; bearer-token flows can come later via env/config).
- One deviation from the prototype verdict: the separator is `_` not `:` (wire constraint above). All six design points otherwise stand as approved.
