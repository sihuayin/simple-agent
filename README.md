# simple-agent

Conversation CLI backed by pluggable LLM providers, with tools. Give it a prompt, get a response — the model decides whether it needs to read/write/edit files or run commands to answer you.

Providers: **deepseek** (default) and **claude** (Anthropic). Adding more providers = one registry entry + one adapter.

## Setup

```bash
pnpm install
cp .env.example .env   # then add the API key(s) you need
```

Each provider needs its own key: `DEEPSEEK_API_KEY` for `deepseek`, `ANTHROPIC_API_KEY` for `claude`. The CLI also reads per-provider model and base-URL env vars (`DEEPSEEK_MODEL`, `ANTHROPIC_MODEL`, `DEEPSEEK_BASE_URL`, `ANTHROPIC_BASE_URL`) and `LLM_PROVIDER` as the default provider.

## Usage

```bash
# positional prompt (default provider: deepseek)
pnpm dev "Explain monads in one sentence"

# piped prompt
printf 'Write a haiku about TypeScript' | pnpm dev

# interactive prompt (no arg, TTY)
pnpm dev

# choose a provider and model
pnpm dev --provider claude "What is a monad?"
pnpm dev --provider deepseek --model deepseek-v4-pro "…"

# agent mode (default — tools always available)
pnpm dev "List the files in this repo and summarize them"
pnpm dev --verbose "Fix the TODO in src/app.ts"
pnpm dev "README.md 中的主要内容是什么"

# options
pnpm dev --verbose "…"        # prints provider, model, iterations + tool-call count to stderr

# built CLI
pnpm build
./dist/index.js --provider claude "hello"
# or install it: pnpm link && simple-agent "hello"
```

Precedence: `--provider` flag > `LLM_PROVIDER` env > default (`deepseek`). `--model` flag > that provider's model env var > that provider's default model.

## Tools (default on)

Tools are always available and the model decides whether to call them; when it doesn't, you get a plain answer. Seven tools: `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `bash`, `list_files` — executed against the current directory, results fed back until the model gives a final answer (capped at 10 tool rounds).

- `read_file` paginates: pass `maxLines` to cap each read; a `[TRUNCATED …]` marker in the result tells the model the next `offset` to continue from.
- Tool errors are fed back to the model as results (it can recover), not crashes.
- File tools are confined to the workspace; paths escaping it are rejected. `bash` is **not** sandboxed (a safety policy is a later requirement).
- `--verbose` prints provider, model, iteration count, and tool-call count to stderr.
- **Streaming is on by default**: the answer appears token by token as the model generates it, with a spinner while waiting (initial connect, tool rounds, compaction). The spinner is ANSI, TTY-only, and writes to stderr so piped output stays clean. `--no-stream` restores one-shot behavior (final answer printed once). Both providers stream over their native formats — DeepSeek over OpenAI-compatible SSE, Claude over Anthropic SSE — unified behind one adapter primitive (`chatStream`), so streaming and non-streaming responses share a single code path.
- **Session memory**: three types — `user` (preferences, global, load in every project), `project` (conventions, load only in that project), `feedback` (corrections of agent behavior, project-level). The agent stores them itself via the `remember` tool (auto, no confirmation), guided by the rule *"would this still be useful in a new session?"* — transient debug info and one-off task details are never stored. Same topic + same type overwrite (versioned, history kept); on load, project-level beats global on a topic conflict and the newest wins within a level (the loser is suppressed but visible). No expiry: memories change only via overwrite or `--memory-forget <id>`. Storage: `~/.simple-agent/memory.json` (global) and `.simple-agent/memory.json` in the workspace (project, gitignored). `--memory` lists them. Every session injects the memory layer into the system prompt — see `docs/adr/0003-session-memory.md`.
- **Hooks**: attach your own logic at four execution points via a `.hooks` file (JSON, see `.hooks.example`). `PreToolUse` runs before each tool call — return `{blocked}` to intercept or `{modifiedParams}` to rewrite arguments (request-level middleware); `PostToolUse` runs after (lint/log); `SessionStart` at session start; `Stop` at the end (notify/summary). Handlers are `command` (context JSON on stdin, JSON on stdout) or `http` (POST, response JSON). PreToolUse hooks chain in order — blocked short-circuits, modified params flow to the next hook; a failing PreToolUse hook fails closed (blocks the call), other events fail open (skip). The built-in security policy always evaluates before hooks, so hooks can never bypass it. The model sees `[hook blocked]` / `[hook modified input]` so it knows what happened — see `docs/adr/0004-hook-system.md`.
- **MCP**: connect external tool servers (Model Context Protocol) via a workspace `.mcp.json` (see `.mcp.json.example`) — local stdio servers (`command`/`args`/`env`, e.g. `npx @modelcontextprotocol/server-filesystem`) or remote streamable HTTP (`url`). Their tools are discovered at session start and appear as `mcp_<server>_<tool>` (e.g. `mcp_files_read`) alongside the built-ins; calls route back to the server. MCP tools are black boxes, so they default to the policy fallback **ask** (human confirmation) — trust a server with `.rules`: `{ "tool": "mcp_files_*", "action": "allow" }` (the `tool` field matches as a glob). A server that fails to connect is skipped with a warning; the session continues. Connections close automatically at the end — see `docs/adr/0005-mcp-support.md`.
- The system prompt is layered (role → rules → project `AGENTS.md` → memory), stable-first so providers' prefix caches hit — see `docs/adr/0001-layered-system-prompt.md`.

## Security policy

Every tool call is evaluated before execution, in three passes: **deny → ask → allow**; anything unmatched falls back to **ask**. Deny covers irreversible commands (`rm -rf /`, `dd`, `curl … | bash`); allow covers daily operations (`npm run`, `git status/log/diff/branch`, file reads); ask covers risky-but-recoverable actions (`git push --force`, `rm -r`) and **all writes** (`write_file`, `edit_file` always confirm). On `ask`, the CLI prompts on a TTY (`readline`, y/N); in non-interactive runs the call is blocked and the reason is fed back to the model, which must explain in its final answer.

Protected paths are a separate list (`.git/**`, `.env*`, `.claude/**`, `.vscode/**`, `node_modules/**`, `**/*.key`, `**/*.pem`, `**/credentials*`, `**/secret*`): even when an allow rule hits, a file tool targeting a protected path triggers ask. Bash deliberately has no read commands (`cat`, …) in its allow list — otherwise it would bypass the path check; the model should use `read_file` instead.

Custom rules: add a `.rules` file (JSON array, see `.rules.example`). User rules append after the defaults, so the safety floor stays; malformed `.rules` fails loudly rather than silently weakening policy.

## Token budget

Before each model call the CLI estimates context usage (CJK ≈ 1.5 chars/token, other ≈ 4 chars/token, plus per-message overhead) and auto-compacts when it crosses 80% of the provider's context window (deepseek 384K / claude 200K): older tool rounds are folded into a rolling `[对话摘要]` (one extra summary call) or truncated. Real API usage is checked too — if it crossed the threshold, the loop compacts even when the estimate looks small. A user message starting with `/compact` forces a compaction (the marker is stripped and never sent to the model). `--verbose` shows `compacted=N`.

Exit codes: `0` success, `1` runtime/API error or aborted agent loop, `2` usage error.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest (loop + tools tested against a fake adapter — no network)
pnpm build       # tsup → dist/index.js
```

## Architecture

- `src/adapters/` — the provider layer: registry (`providers.ts`), selection/resolution (`resolve.ts`), per-provider response normalization incl. tool calls (`normalize.ts`), normalized↔wire message translation (`wire.ts`), SDK-backed adapters (`client.ts`)
- `src/agent/` — the tool-using loop (`loop.ts`) and agent system prompt
- `src/tools/` — the seven tool implementations (`registry.ts` declares them for the model)
- `src/cli.ts` — arg parsing, prompt resolution (positional → stdin → TTY), output formatting
- `src/index.ts` — entry point (always runs the agent loop; the model decides whether tools are needed)
