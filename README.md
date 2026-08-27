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
- The system prompt is layered (role → rules → project `AGENTS.md`), stable-first so providers' prefix caches hit — see `docs/adr/0001-layered-system-prompt.md`.

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
