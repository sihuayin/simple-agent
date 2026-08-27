# 01: Core conversation: prompt in, response out

**What to build:** A single invocation `simple-agent "prompt"` sends exactly one user message to the configured DeepSeek model and prints the plain-text response to stdout, exiting 0 on success. When the API key is not configured, the CLI exits 1 with a friendly, actionable message instead of an opaque crash. The conversation logic takes an injected client so the network boundary stays a single mockable seam.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Running with a positional prompt and a configured key prints the model's response to stdout and exits 0
- [ ] Exactly one user message carrying the prompt text is sent, with streaming disabled
- [ ] Running without a configured API key prints a clear "set DEEPSEEK_API_KEY" message and exits 1
- [ ] The conversation logic is unit-testable with a fake client — tests never hit the network
