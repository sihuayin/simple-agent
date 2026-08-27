# 01: Token budget with auto-compact and /compact

**What to build:** The agent loop estimates context usage before each model call (CJK 1.5 chars/token, else 4 chars/token, + per-message overhead and fixed system+tools cost) and auto-compacts when the estimate — or the API's reported usage — crosses 80% of the provider's context window (deepseek 384K / claude 200K). Compaction folds rounds older than the last 2 into a `[对话摘要]` message via one extra summary call (or truncates). A user message starting with `/compact` forces a compaction; the marker never reaches the model.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Auto-compact triggers mid-run when the estimate crosses the threshold; the summary message is sent to the model and dropped content is gone
- [ ] System prompt and the original user task are never dropped
- [ ] Drift: real usage crossing the threshold triggers compaction even when the estimate is low, sticky until a compaction succeeds
- [ ] `/compact` (standalone or line-start) forces a compaction below the threshold; mid-sentence mentions do not trigger
- [ ] Summary-call failure skips compaction instead of losing text; truncate strategy drops oldest tool results until under the threshold
- [ ] `--verbose` reports `compacted=N`
- [ ] Budget logic is pure and tested without network or models
