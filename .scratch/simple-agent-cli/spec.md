Status: ready-for-agent

# Spec: one-shot DeepSeek conversation CLI

## Problem Statement

The user wants a minimal TypeScript command-line tool that talks to the DeepSeek API to complete a single conversation. Give it a prompt, get one response, done — no session state, no chat history, no streaming. It must be easy to configure (API key, model choice) without leaking secrets, and trivially testable without touching the network.

## Solution

`simple-agent` is an installable CLI (`bin: simple-agent`) that sends exactly one user message to DeepSeek and prints the response to stdout as plain text. The prompt comes from a positional argument, a piped stdin stream, or an interactive terminal prompt. Configuration comes from the environment or a `.env` file: the API key is required; the model and base URL are overridable. A `--verbose` flag reports model and token usage on stderr without polluting stdout. Exit codes follow the 0/1/2 convention so scripts can react to success, runtime/API failure, and usage errors.

## User Stories

1. As a user, I want to pass a prompt as a command-line argument, so that I can ask DeepSeek a question with a single command.
2. As a user, I want to pipe a prompt through stdin, so that I can feed prompts from scripts and other commands.
3. As a user, I want an interactive prompt when I run the CLI with no argument on a terminal, so that I don't have to remember quoting rules.
4. As a user, I want the model's response printed to stdout as plain text, so that I can read it or pipe it onward.
5. As a user, I want the CLI to fail fast with a friendly, actionable message when the API key is missing, so that I immediately know what to configure.
6. As a user, I want to provide the API key via a `DEEPSEEK_API_KEY` environment variable, so that the key never appears in my shell history or command arguments.
7. As a user, I want to put configuration in a `.env` file (gitignored, with a committed `.env.example`), so that I can keep secrets out of version control.
8. As a user, I want a `--model` flag to choose the model per invocation, so that I can try different DeepSeek models without changing configuration.
9. As a user, I want a `DEEPSEEK_MODEL` environment variable as the default model, so that I don't repeat the flag every time.
10. As a user, I want the `--model` flag to win over the environment default, so that per-invocation choice is predictable.
11. As a user, I want to point the CLI at an alternate base URL via `DEEPSEEK_BASE_URL`, so that I can route through a proxy or OpenAI-compatible gateway.
12. As a user, I want a sensible built-in default model (`deepseek-v4-flash`), so that the CLI works out of the box once the key is set.
13. As a user, I want `--verbose` to print the model and token usage to stderr, so that I can monitor cost without mixing metadata into stdout.
14. As a user, I want `--help` to show usage, options, and environment variables, so that I can discover the CLI without reading docs.
15. As a user, I want `--version` to print the installed version, so that I can report and compare versions.
16. As a user, I want a non-zero exit code on failure (1 for runtime/API errors, 2 for usage errors, 0 on success), so that scripts can react to outcomes.
17. As a user, I want an error (exit 2) when the prompt is empty, so that I don't waste an API call on nothing.
18. As a user, I want an unknown flag to be rejected with usage output (exit 2), so that typos are caught instead of silently ignored.
19. As a user, I want a non-streaming (text) response by default, so that I get a simple, complete response to read or capture (streaming is deferred).
20. As a user, I want a built, executable binary with a proper shebang, so that I can install and run it from anywhere.
21. As a user, I want no system prompt and no session state, so that each invocation is a single, self-contained exchange.
22. As a developer, I want the conversation logic to be testable without any network access, so that tests are fast, deterministic, and CI-safe.

## Implementation Decisions

- **Conversation core** — a module exposing `runConversation({ client, model, prompt })` as an async function returning a result shape of `{ content, model, usage? }`. This is the single test seam of the feature.
- **Injected client** — `runConversation` accepts a minimal structural `ChatClient` interface (`chat.completions.create` with non-streaming params) rather than constructing the SDK client itself. The real OpenAI-compatible client satisfies it structurally; tests pass a fake. This keeps the network boundary at exactly one point.
- **API access** — the `openai` SDK pointed at `https://api.deepseek.com` (DeepSeek's API is OpenAI-compatible). The base URL is overridable via `DEEPSEEK_BASE_URL`.
- **Model default and precedence** — default `deepseek-v4-flash`; precedence is `--model` flag > `DEEPSEEK_MODEL` env > built-in default.
- **Non-streaming** — `stream: false`; the full response is buffered and printed once. Streaming is intentionally deferred.
- **Key handling** — `DEEPSEEK_API_KEY` read from the environment (with dotenv loading `.env`); client construction throws a `MissingApiKeyError` with a friendly message when absent, producing exit code 1. `.env` is gitignored; `.env.example` is committed.
- **Prompt resolution** — positional argument first; else piped stdin when stdin is not a TTY; else an interactive readline prompt on a terminal. An empty prompt after resolution is a usage error (exit 2).
- **Output contract** — response content (or empty string) plus newline to stdout; `--verbose` additionally writes a single `[model=… prompt=… completion=… total=…]` line to stderr. Formatting is a pure function so it can be asserted directly.
- **CLI shell** — the entry point parses a small fixed option set (`--model`, `--verbose`, `--help`, `--version`), maps errors to exit codes (0 success / 1 runtime+API / 2 usage), and prints help text on usage errors.
- **Toolchain** — ESM (`"type": "module"`), Node >= 20, pnpm, tsup bundling to a single executable `dist` output with a shebang, `tsx` for dev, vitest for tests. Package and bin name: `simple-agent`.

## Testing Decisions

- **What makes a good test here** — assert external behavior through the seams: the conversation core's API contract (what payload goes out, what result comes back) and the output contract (what lands on stdout/stderr). Never assert implementation details like internal helper calls, and never hit the network.
- **Seams used** — exactly one mocking seam: the injected `ChatClient` passed to `runConversation`, where a fake substitutes for the API. Everything else is asserted directly as pure functions (`formatResult`, `parseArgs`/`resolveModel`, and `createClient` with an injected env object).
- **Modules tested** — the conversation core (payload correctness: single user message with the given model and `stream: false`; result content and usage surfaced), the output formatter (plain vs verbose stdout/stderr), and client construction (missing key throws the friendly error, present key constructs successfully).
- **Prior art** — none in this repo; this is the first suite. Exit-code behavior is additionally smoke-checked manually against the built binary (0/1/2 verified).

## Out of Scope

- Streaming responses (SSE) — user wants the text mode first
- Multi-turn conversations, session state, history, or persistence
- System prompt configuration
- Tool/function calling or any agent loop
- `--json` output mode
- Authentication flows beyond the API key (OAuth, per-request signing)
- CI pipeline, linting, or coverage tooling

## Further Notes

- The model name `deepseek-v4-flash` was verified against DeepSeek's published docs (DeepSeek-V4-Flash-0731); `deepseek-v4-pro` exists as an alternative and is reachable via the override knobs.
- The glossary in `CONTEXT.md` defines the vocabulary used here: conversation (single exchange), message (role + content), prompt, response, model, client.
- The scaffold implementing this spec is already committed; this spec records the agreed design so implementation work can be triaged and tracked from a known baseline.
