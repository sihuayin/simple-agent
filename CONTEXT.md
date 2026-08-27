# Context

## Glossary

- **conversation**: a single exchange — one prompt in, one model response out. This CLI is one-shot: no session state, no history, nothing carried between runs.
- **message**: one `role` + `content` pair sent to the model. This CLI always sends exactly one user message per conversation.
- **prompt**: the user-supplied input text that becomes the user message.
- **response**: the model's reply to the prompt.
- **model**: the model identifier used for the conversation — per-provider default (`deepseek-v4-flash` / `claude-sonnet-4-5`), overridable via `--model` or that provider's model env var. Model IDs pass through unvalidated: catalogs go stale, so refusing unknown IDs would reject valid models.
- **provider**: the service that supplies the model — currently `deepseek` and `claude`. Selected by the `--provider` flag, the `LLM_PROVIDER` environment variable, or the default.
- **adapter**: the per-provider wrapper that turns one provider's API call into the raw response shape the CLI normalizes. The conversation logic depends on an adapter, never on a specific provider's SDK; adding a provider means adding a registry entry and an adapter.
- **client**: the SDK client an adapter wraps (OpenAI-compatible SDK for `deepseek`, Anthropic SDK for `claude`), constructed from that provider's env vars. Adapters, not clients, are injected into the conversation logic.
