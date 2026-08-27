# simple-agent

One-shot conversation CLI backed by the DeepSeek API. Give it a prompt, get one response, done — no session state.

## Setup

```bash
pnpm install
cp .env.example .env   # then add your DEEPSEEK_API_KEY
```

`DEEPSEEK_API_KEY` is required; the CLI also reads `DEEPSEEK_MODEL` (default `deepseek-v4-flash`) and `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com`) from the environment or `.env`.

## Usage

```bash
# positional prompt
pnpm dev "Explain monads in one sentence"

# piped prompt
echo "Write a haiku about TypeScript" | pnpm dev

# interactive prompt (no arg, TTY)
pnpm dev

# options
pnpm dev --model deepseek-v4-pro "…"
pnpm dev --verbose "…"        # prints model + token usage to stderr

# built CLI
pnpm build
./dist/index.js "hello"
# or install it: pnpm link && simple-agent "hello"
```

Exit codes: `0` success, `1` runtime/API error, `2` usage error.

## Development

```bash
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest (conversation logic tested against a fake client)
pnpm build       # tsup → dist/index.js
```

## Architecture

- `src/conversation.ts` — pure conversation logic (`runConversation`), takes an injected client so tests never touch the network
- `src/client.ts` — builds the OpenAI-compatible client from env (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`)
- `src/cli.ts` — arg parsing, prompt resolution (positional → stdin → TTY), output formatting
- `src/index.ts` — entry point
