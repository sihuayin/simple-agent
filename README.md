# simple-agent

One-shot conversation CLI backed by pluggable LLM providers. Give it a prompt, get one response, done — no session state.

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

# options
pnpm dev --verbose "…"        # prints provider, model + token usage to stderr

# built CLI
pnpm build
./dist/index.js --provider claude "hello"
# or install it: pnpm link && simple-agent "hello"
```

Precedence: `--provider` flag > `LLM_PROVIDER` env > default (`deepseek`). `--model` flag > that provider's model env var > that provider's default model.

Exit codes: `0` success, `1` runtime/API error, `2` usage error.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest (conversation logic tested against a fake adapter — no network)
pnpm build       # tsup → dist/index.js
```

## Architecture

- `src/adapters/` — the provider layer: registry (`providers.ts`), selection/resolution (`resolve.ts`), per-provider response normalization (`normalize.ts`), SDK-backed adapters (`client.ts`)
- `src/conversation.ts` — `runConversation({ adapter, model, prompt })`: pure orchestration over the adapter (the single test seam)
- `src/cli.ts` — arg parsing, prompt resolution (positional → stdin → TTY), output formatting
- `src/index.ts` — entry point
