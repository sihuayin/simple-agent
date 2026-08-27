# 01: Provider adapter layer (deepseek + claude)

**What to build:** The CLI runs one-shot conversations against both DeepSeek and Claude through a provider adapter layer. `--provider claude` switches provider; each provider requires its own key and gets its own default model; both responses normalize onto one output shape. Adding a future provider is one registry entry + one adapter.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `--provider claude` with `ANTHROPIC_API_KEY` set completes a real conversation
- [ ] `LLM_PROVIDER` env selects the default provider; `--provider` flag wins over it
- [ ] Missing key for the selected provider exits 1 with a message naming that provider's env var
- [ ] Unknown provider exits 2 listing the available providers
- [ ] `--model` precedence: flag > provider model env var > provider default
- [ ] DeepSeek (choices/`*_tokens`) and Claude (text blocks/`input+output_tokens`) raw responses normalize to the same `{content, model, usage}` result; empty Claude content → null content, no crash
- [ ] Conversation logic tested against a fake adapter — no network in tests
