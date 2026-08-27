Status: ready-for-agent

# Spec: multi-provider support with an adapter layer

## Problem Statement

The CLI only talks to DeepSeek. The user wants to also use Claude (Anthropic) models — "Claude Code's models" — and, more importantly, an abstraction so future providers (and future DeepSeek/Claude models) plug in without touching the CLI surface.

## Solution

A provider adapter layer sits between the CLI and the SDKs. Each provider is one registry entry plus one adapter; the conversation logic depends on an adapter, never on a specific SDK. Provider selection follows `--provider` flag > `LLM_PROVIDER` env > default (`deepseek`); each provider requires its own API key; both providers' responses normalize onto one `{content, model, usage}` result.

## Verdict (from prototype)

A throwaway HTML prototype (`prototype/provider-adapters` branch, `src/prototype-provider-adapters.html`) validated the selection/normalization logic and six edge cases. **Open decision settled:** model IDs pass through **unvalidated** — model catalogs go stale (DeepSeek's docs gained `deepseek-v4-flash`; Anthropic shipped `claude-opus-4-8` mid-project), so a hardcoded catalog would reject valid models and need constant maintenance. The resolved model is always visible via `--verbose`. Reversible if it bites.

## User Stories

1. As a user, I want to run the CLI against Claude by passing `--provider claude`, so that I can use Anthropic models.
2. As a user, I want `LLM_PROVIDER` to set a default provider, so that I don't repeat the flag.
3. As a user, I want each provider to require its own key (`DEEPSEEK_API_KEY` / `ANTHROPIC_API_KEY`), so that one provider's key never silently substitutes for another's.
4. As a user, I want a friendly error naming the exact env var when a provider's key is missing, so that I know what to set.
5. As a user, I want an unknown provider to be rejected listing the available ones, so that typos are caught.
6. As a user, I want per-provider default models (`deepseek-v4-flash` / `claude-sonnet-4-5`) and per-provider model env vars, so that each provider's model choice is independent.
7. As a user, I want both providers' responses normalized into the same output shape (content + usage), so that scripts don't care which provider answered.
8. As a developer, I want to add a new provider by adding one registry entry and one adapter, so that extension is cheap and localized.
9. As a developer, I want the conversation logic tested against a fake adapter, so that tests stay network-free and deterministic.

## Implementation Decisions

- **Adapter seam**: `ProviderAdapter` (`send({model, prompt}) → provider-specific raw response`), injected into `runConversation`. This replaces the old `ChatClient` seam; it is the single test seam.
- **Registry**: `PROVIDERS` in the adapters module — per provider: name, defaultModel, keyEnvVar, modelEnvVar, baseUrlEnvVar, defaultBaseUrl, optional maxTokens. Anthropic requires `max_tokens` (4096 default).
- **Selection precedence**: `--provider` > `LLM_PROVIDER` > `deepseek`. Model: `--model` > provider model env var (trimmed; empty treated as unset) > provider default.
- **Keys**: adapter construction throws `MissingApiKeyError` naming the provider's key env var; exit 1.
- **Normalization**: OpenAI-compatible shape (choices/`*_tokens`) for DeepSeek; Anthropic shape (text blocks joined, `input/output_tokens` summed) for Claude; both → `ConversationResult`.
- **Errors**: unknown provider → `UnknownProviderError` listing available providers, exit 2.
- **CLI surface**: `--provider` flag added; help text documents both providers and all env vars.

## Testing Decisions

- **Seam**: one mocking seam — `ProviderAdapter.send` (fake adapter in `runConversation` tests). Pure functions asserted directly: provider/model resolution precedence, per-provider key errors, both normalization shapes (including empty Anthropic content array → null, non-text blocks skipped).
- **Regression found by E2E**: piped stdin never worked (`parseArgs` produced `""` instead of `undefined` when no positional was given, so `readPrompt` skipped stdin). Fixed at the source; regression test added (no positional → prompt `undefined`). E2E verified against the real DeepSeek API; Claude path verified up to the missing-key error (no Anthropic key configured).

## Out of Scope

- Streaming responses
- Multi-turn / session state / system prompts
- Model-per-provider validation catalogs (passthrough decision above)
- Additional providers beyond deepseek and claude
- Retry/rate-limit handling

## Further Notes

- Prototype (primary source): branch `prototype/provider-adapters`, file `src/prototype-provider-adapters.html` — re-runnable by double-click.
- Default Claude model taken from the user's own Claude Code usage data (`claude-sonnet-4-5` dominant; 4-6/4-7/4-8 and haiku 4-5/4-7 also observed).
- Glossary updated in `CONTEXT.md`: provider, adapter, revised model/client entries.
