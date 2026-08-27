# 03: Model and endpoint overrides

**What to build:** The model defaults to `deepseek-v4-flash` but can be overridden per invocation via a `--model` flag or via a `DEEPSEEK_MODEL` environment variable, with the flag winning. The API base URL is overridable via `DEEPSEEK_BASE_URL` to support proxies and OpenAI-compatible gateways.

**Blocked by:** 01 (core conversation).

**Status:** ready-for-agent

- [ ] `--model` selects a different model for that invocation
- [ ] `DEEPSEEK_MODEL` is used when no flag is given; the flag wins over the env value
- [ ] `DEEPSEEK_BASE_URL` redirects the API call to the given endpoint
- [ ] With neither override, `deepseek-v4-flash` is used
