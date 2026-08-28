# ADR-0004: Hook system (PreToolUse / PostToolUse / SessionStart / Stop)

- Status: Accepted
- Date: 2026-08-28
- Context: `.scratch/hooks/spec.md`; prototype on `prototype/hooks`

## Decision

Users attach their own logic at four execution points: **PreToolUse** (before a tool runs — block with `{blocked, reason}` or rewrite arguments with `{modifiedParams}`, the request-level middleware), **PostToolUse** (lint/log), **SessionStart** (init), **Stop** (notify/summary). Configured in a workspace `.hooks` file: `{ name, event, matcher?, handler: {type:"command"|"http", …} }`. Command handlers get the context JSON on stdin and return JSON on stdout; http handlers get it as a POST body and the response body is parsed.

PreToolUse hooks chain in registration order — `blocked` short-circuits, `modifiedParams` feeds the next hook. Handler failure follows the **failure policy**: PreToolUse fails closed (a broken guard blocks the call), all other events fail open (skip, never block). The built-in security policy evaluates before hooks, so hooks can never bypass it. The model sees `[hook blocked] …` (must explain, not bypass) or `[hook modified input] …` (knows what actually ran).

## Consequences

- Loop order per tool call: policy (deny/ask/allow) → PreToolUse chain → execute (possibly rewritten params) → PostToolUse. SessionStart fires before the first model call; Stop fires in the `finally` with `{ finalText, iterations, toolCallsMade, aborted }`.
- Command handlers run through `child_process.spawn` with a default 10s timeout; http through `fetch` POST with an abort timeout. Handler errors are captured, never thrown into the loop.
- `.hooks` corrupt → loud error (like `.rules`); missing → no hooks. No hot-reload: hooks load once per session.
- Trade-off accepted: a misconfigured PreToolUse hook that crashes blocks the agent's tool calls (fail-closed is the safety side); users must keep guards runnable. PostToolUse/SessionStart/Stop failures are invisible by design.
- All five prototype verdicts were approved by the user: ① failure policy, ② chain semantics, ③ policy before hooks, ④ `[hook blocked]`/`[hook modified input]` messages, ⑤ `.hooks` JSON config.
