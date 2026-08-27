# Context

## Glossary

- **conversation**: a single exchange — one prompt in, one model response out. This CLI is one-shot: no session state, no history, nothing carried between runs.
- **message**: one `role` + `content` pair sent to the model. This CLI always sends exactly one user message per conversation.
- **prompt**: the user-supplied input text that becomes the user message.
- **response**: the model's reply to the prompt.
- **model**: the DeepSeek model identifier used for the conversation (default `deepseek-v4-flash`, overridable via `--model` or `DEEPSEEK_MODEL`).
- **client**: the OpenAI-compatible API client used to reach DeepSeek. Injected into the conversation logic rather than constructed there, so the logic stays testable.
