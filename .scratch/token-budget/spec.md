Status: ready-for-agent

# Spec: token budget management

## Problem Statement

Long agent runs accumulate context: every tool round appends the assistant message and (often large) tool results. Without a budget, a run can exceed the provider's context window and fail. The CLI needs to estimate usage before sending, auto-compact when it crosses a threshold, and honor a user `/compact` command.

## Solution

A token budget tracks the conversation: fixed overhead (layered system prompt + tool schemas) plus per-message estimates (CJK ≈ 1.5 chars/token, everything else ≈ 4 chars/token, +3/message). Before each model call, if the estimate — or the API's last reported `usage.prompt_tokens` — crosses the threshold (default 80% of the provider's context window: deepseek 384K, claude 200K), the loop compacts: older rounds beyond the last `keepRounds` (default 2) are folded into a `[对话摘要]` user message via one extra summary call (rolling summary), or dropped wholesale (truncate). A user message starting with `/compact` forces a compaction; the marker is stripped and never sent to the model.

## Verdict (from prototype)

A throwaway HTML prototype (`prototype/token-budget` branch, `src/prototype-token-budget.html`) validated the estimate/decide/compact state machine and six scenarios (normal, climbing, `/compact`, tool-heavy, boundary, drift). Settled: `/compact` is a line-start command (a message containing `/compact` mid-sentence, e.g. "解释一下 /compact", must NOT trigger); rolling summary is the default strategy; keep 2 rounds. One design flaw found during implementation: the drift flag (real usage crossed the threshold) is **sticky until a compaction succeeds** — otherwise it expires before the keepRounds floor makes compaction possible.

## User Stories

1. As a user, I want long runs to compact automatically past a threshold, so that they don't blow the context window.
2. As a user, I want the estimate to count CJK at 1.5 chars/token and other text at 4 chars/token, so that Chinese-heavy sessions are budgeted conservatively.
3. As a user, I want compaction to keep the system prompt and my original task untouched, so that context is never lost from the top.
4. As a user, I want older rounds folded into a summary (kept in context as a `[对话摘要]` message) rather than silently dropped, so that earlier facts survive.
5. As a user, I want `/compact` (alone or at the start of a message) to force a compaction, and the marker itself to never reach the model.
6. As a user, I want a message that merely *mentions* `/compact` (e.g. asking what it does) to be sent normally.
7. As a user, I want the real API usage to count too — if it crossed the threshold, compact even when the estimate looks small.
8. As a user, I want `--verbose` to report how many compactions happened.
9. As a developer, I want the budget logic pure and testable without network or models.

## Implementation Decisions

- **Estimation** (`src/agent/budget.ts`): CJK (kana, CJK ideographs, hangul) at 1.5 chars/token, else 4 chars/token, ceil per group; +3 tokens per message for role/format overhead. Conservative direction for Chinese (slightly over real tokenization) — safe for budgeting.
- **Fixed overhead**: system prompt + every tool's name/description/JSON-schema, computed once per run.
- **Threshold**: `floor(contextWindow × thresholdPct)`; `contextWindow` comes from the provider registry (deepseek 384000, claude 200000), default 80%.
- **Compaction**: `findDropRange` keeps messages[0..firstUserEnd] (system + original task) plus the last `keepRounds` assistant-anchored rounds; the dropped prefix is replaced by one `[对话摘要]` user message (summary strategy, produced by `summarizeWithAdapter` — one extra model call; on failure, no compaction happens rather than losing text). Truncate strategy drops the oldest tool results until under the threshold.
- **Drift**: `usage.prompt_tokens` from each API response is recorded; once it crosses the threshold the flag is sticky and cleared only by a successful compaction.
- **`/compact`**: `extractCompactCommand` — exact `/compact` or a line-start command; returns the stripped remainder. `forceCompact` in the loop persists until a compaction actually succeeds.
- **CLI**: no new flags; budget always on. `--verbose` adds `compacted=N`.

## Testing Decisions

- **Seam**: pure functions (`estimateTokens`, `findDropRange`, `compactMessages`, `extractCompactCommand`, `TokenBudget.decide/recordUsage/markCompacted`) tested directly; `summarizeWithAdapter` tested with a fake adapter; loop integration tests run `runAgent` with a fake adapter scripted to produce big tool results, an injected summarizer, and budget configs tuned to small windows (4000 tokens) so crossings are visible.
- **Key cases**: CJK/ASCII/mixed estimation; threshold boundary; sticky drift; drop-range math (drop round 1 of 3 with keepRounds 2); summary replacement and no-op cases; truncate until under threshold; auto-compact mid-loop (summary message present, dropped content gone, compactions counted); drift-triggered compact; forced compact below threshold; `/compact` detection vs mid-sentence mention.
- **Live E2E**: normal runs report `compacted=0`; `/compact` is stripped and answered without sending the marker.

## Out of Scope

- Interactive multi-turn sessions (the budget works within one agent run; `/compact`'s value grows when sessions arrive)
- Making the threshold/strategy user-configurable (constants + registry for now)
- Token-accurate counting (the estimate is a heuristic; real usage reconciles via the drift mechanism)

## Further Notes

- Prototype (primary source): branch `prototype/token-budget`, file `src/prototype-token-budget.html`.
- Provider context windows verified: deepseek-v4 = 384K; claude 4.x = 200K.
- Both providers' prompt caches are prefix-based; the budget is independent of (and complementary to) caching.
