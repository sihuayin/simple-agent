Status: needs-triage

# Spec: MCP support (Model Context Protocol)

## Problem Statement

simple-agent ships 8 built-in tools. MCP (Model Context Protocol) lets an agent connect external tool servers — a local stdio child process (`npx …`) or a remote HTTP endpoint — discover their tools dynamically, and call them like any other tool. The question is the client/lifecycle model: connection state, tool naming and conflicts, how the security policy covers black-box external tools, and failure semantics. The prototype settles it.

## Solution

A workspace `.mcp.json` (Claude Desktop–style format) declares servers:

```json
{ "mcpServers": {
  "files":  { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] },
  "remote": { "url": "https://mcp.example.com/mcp" }
} }
```

At session start the client connects to every server, discovers tools via `tools/list`, and merges them into the model-visible tool set. Calls are routed back to the owning server. Connections close in the session `finally`.

**Tool naming**: every MCP tool is advertised as `mcp:<server>:<tool>` (e.g. `mcp:files:read`) — names can never collide with built-ins or other servers, and the prefix gives policy/hook matchers a precise handle. The description is prefixed `[MCP 服务器 "files"]`.

**Security**: MCP tools are black boxes (a shell server can execute arbitrary commands). The policy **fallback is ask** — by default an MCP call needs human confirmation (non-TTY auto-blocks, same as today). Users can allow trusted servers via `.rules`: `{ "tool": "mcp:files:*", "action": "allow" }` (the pattern is the existing glob matcher). MCP calls run through the same pipeline as built-ins: policy → PreToolUse hooks → execute → PostToolUse hooks. Hooks match MCP tools the same way (matcher `mcp:files:*`).

**Failure semantics**: a server that fails to connect/handshake is **skipped with a loud stderr warning, the session continues** with the rest — one broken server must not take down the session. A corrupt `.mcp.json` fails loudly (like `.rules`/`.hooks`). A failed call at runtime (server crash / timeout / `isError`) returns an error tool result, the loop continues.

**Result handling**: `tools/call` content is normalized to text (all text parts joined); `isError` prefixes `[mcp error]`. Existing result cap/truncation applies.

## User Stories

1. As a user, I want to declare stdio servers (`command`+`args`+`env`) and remote HTTP servers (`url`) in `.mcp.json`, and have the agent discover and call their tools.
2. As a user, I want MCP tool names that can't collide with built-ins or other servers.
3. As a user, I want MCP calls to default to human confirmation (black box), with a `.rules` allow-list for servers I trust.
4. As a user, I want one broken server to be skipped (loudly) without killing the rest of the session.
5. As a user, I want the model to see MCP tool text results and clear error messages.
6. As a user, I want all connections closed automatically when the session ends.

## Implementation Decisions

（原型已裁决，用户逐项确认）

- **Client**: official `@modelcontextprotocol/sdk` — Client + StdioClientTransport (local) + StreamableHTTPClientTransport (remote). The SDK owns MCP's wire compatibility (JSON-RPC 2.0, initialize handshake, capability negotiation); we stay a thin wrapper.
- **Module**: `src/mcp/` — `config.ts` (`loadMcpConfig`: missing → empty, corrupt → loud throw, per-server validation: `command` or `url` required), `client.ts` (`McpManager`: connectAll → listTools → `ToolEntry[]`, callTool, closeAll; parallel connect with per-server failure isolation), `tools.ts` (naming, description prefix, schema passthrough, result text serialization).
- **Tool naming**: `mcp_<server>_<tool>` (e.g. `mcp_files_read`) — the separator is an underscore, not a colon: the provider wire layer (OpenAI-format DeepSeek, Anthropic) only accepts tool names matching `^[a-zA-Z0-9_-]+$` and a colon gets a 400. The verdict's intent (prefixed combination that can never collide, precise policy/hook handles) is preserved. Description is prefixed `[MCP 服务器 "files"]`.
- **Security**: MCP calls default to the policy **fallback ask** (non-TTY auto-blocks). Trusted servers allow-listed in `.rules`; the `tool` field of a rule now matches as a **glob** (so `mcp_files_*` matches every tool of that server — literal tool names behave exactly as before).
- **Failure semantics**: server connect/handshake failure → stderr warning + skip that server, session continues; corrupt `.mcp.json` → loud failure (like .rules/.hooks); runtime call failure (crash/timeout/isError) → error tool result, loop continues. `--verbose` prints `[mcp=2 servers, 5 tools]`.
- **Loop integration**: `input.mcpTools?: ToolEntry[]`; tool lookup = built-in TOOLS first, then MCP table; MCP calls take the exact same policy → hooks → execute pipeline.
- **Result handling**: `tools/call` content normalized to text (text parts joined); `isError` prefixes `[mcp error]`; existing result cap/truncation applies.
- **Lifecycle**: connections open before the agent run, close in the run's `finally`.

## Testing Decisions

- Config: missing / valid (stdio + http) / corrupt / invalid entries (neither command nor url).
- Client: **real SDK + a real child-process fixture server** (a minimal MCP server as a `node -e`-style script speaking the stdio protocol) — handshake, tools/list, tools/call, isError, server crash mid-session, closeAll; failure isolation (one bad + one good server).
- Tools adapter: naming, description prefix, schema passthrough, text joining, isError prefix.
- Policy: `tool`-field glob matching (`mcp:files:*` allows that server's tools, `mcp:*` all MCP tools; literal built-in names unchanged).
- Loop integration: fake adapter + injected mcpTools → model calls `mcp:server:tool` → routed to MCP client, policy (fallback ask) + hooks applied.
- Live E2E: real `.mcp.json` + a real fixture server for a full session.
- Regression: full suite green.

## Out of Scope

- MCP resources and prompts (v1: tools only)
- Sampling (agent → server callback)
- OAuth / remote auth flows
- Config hot-reload
- Per-provider native tool schema formats (unified JSON schema via the existing ToolSpec)

## Further Notes

- Prototype: `src/prototype-mcp.html`, captured on branch `prototype/mcp`. Verdict (user, all approved): ① official SDK; ② security fallback ask; ③ connect failure → warn + skip server, session continues; ④ prefixed tool naming `mcp_<server>_<tool>` (wire-layer constraint: colon rejected by OpenAI/Anthropic tool-name patterns, changed from the prototype's `mcp:server:tool`); ⑤ `.mcp.json` Claude Desktop format; ⑥ stdio + streamable HTTP both, no OAuth in v1.
