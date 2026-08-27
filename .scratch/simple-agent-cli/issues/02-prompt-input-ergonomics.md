# 02: Prompt input ergonomics

**What to build:** The prompt can come from a piped stdin stream (`echo hi | simple-agent`) or, when run interactively with no argument, from a terminal prompt. An empty prompt is a usage error, as is an unknown flag — both print usage and exit 2.

**Blocked by:** 01 (core conversation).

**Status:** ready-for-agent

- [ ] Piped stdin is used as the prompt when no positional argument is given
- [ ] On a TTY with no argument, an interactive prompt is shown
- [ ] An empty prompt exits 2 with usage output and makes no API call
- [ ] An unknown flag exits 2 and prints usage
