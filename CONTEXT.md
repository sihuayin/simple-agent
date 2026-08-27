# Context

## Glossary

- **conversation**: a single exchange — one prompt in, one model response out. Tools are always available and the model decides whether to call them; when it doesn't, a conversation is exactly one round.
- **message**: one `role` + `content` pair sent to the model. This CLI always sends exactly one user message per conversation.
- **prompt**: the user-supplied input text that becomes the user message.
- **response**: the model's reply to the prompt.
- **model**: the model identifier used for the conversation — per-provider default (`deepseek-v4-flash` / `claude-sonnet-4-5`), overridable via `--model` or that provider's model env var. Model IDs pass through unvalidated: catalogs go stale, so refusing unknown IDs would reject valid models.
- **provider**: the service that supplies the model — currently `deepseek` and `claude`. Selected by the `--provider` flag, the `LLM_PROVIDER` environment variable, or the default.
- **adapter**: the per-provider wrapper that turns one provider's API call into the raw response shape the CLI normalizes. The conversation logic depends on an adapter, never on a specific provider's SDK; adding a provider means adding a registry entry and an adapter.
- **client**: the SDK client an adapter wraps (OpenAI-compatible SDK for `deepseek`, Anthropic SDK for `claude`), constructed from that provider's env vars. Adapters, not clients, are injected into the conversation logic.
- **tool**: a capability the agent can call in agent mode — `read_file`, `write_file`, `edit_file`, `grep`, `glob`, `bash`, `list_files`. Each tool carries a name, a description (what the model sees), JSON-schema parameters, and an implementation that runs against the workspace.
- **tool call**: a request from the model to execute a tool (OpenAI wire: `tool_calls`; Anthropic wire: `tool_use` blocks). The loop executes it and feeds the result back as a **tool result**.
- **agent loop**: the cycle of model output → tool execution → result feedback → next model output, terminating on a final text answer or the iteration cap (default 10 tool rounds). Errors from tools are fed back to the model as results, not crashes.
- **system prompt**: the layered instruction sent to the model — role definition → general rules → project settings. Stable layers come first because both providers' caches are prefix-matched (see ADR-0001).
- **prompt caching**: the provider mechanism for reusing a request prefix across calls — DeepSeek's automatic KV cache and Anthropic's `cache_control` breakpoints. This CLI relies on stable-first ordering rather than explicit breakpoints.
- **layer**: one of the three system-prompt sections (role / rules / project), ordered by stability. The project layer is loaded from the workspace's `AGENTS.md` and is empty when the file is missing.
