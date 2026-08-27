# 04: Verbose output contract

**What to build:** stdout carries only the response text, so it stays clean for piping. With `--verbose`, a single metadata line reporting the model and token usage goes to stderr.

**Blocked by:** 01 (core conversation).

**Status:** ready-for-agent

- [ ] Default output is the response text and nothing else on stdout
- [ ] `--verbose` prints the model and token usage to stderr without touching stdout
- [ ] The output formatting is a pure function, asserted directly in tests
