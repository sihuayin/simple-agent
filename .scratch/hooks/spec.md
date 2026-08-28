Status: ready-for-agent

# Spec: hook system (PreToolUse / PostToolUse / SessionStart / Stop)

## Problem Statement

The agent's execution flow has key points where users want to attach their own logic: intercept/modify tool calls before they run, lint or log after they run, initialize at session start, and notify when the agent stops. The question was the event/middleware/failure model; the prototype settled it.

## Solution

Four events: **PreToolUse** (before a tool executes — can block with `blocked: true` or rewrite arguments with `modifiedParams`, the request-level middleware), **PostToolUse** (after execution — lint/log), **SessionStart** (init/config load), **Stop** (notify/summary). Hooks are configured in a workspace `.hooks` file (JSON array, like `.rules`): `{ name, event, matcher?, handler: { type: "command", command } | { type: "http", url } }`.

**Handler protocol**: the hook context is a JSON object — `command` handlers receive it on stdin and return a JSON object on stdout; `http` handlers receive it as a POST body and the response body is parsed. Return `{}` (pass), `{ blocked: true, reason }`, or `{ modifiedParams }`. Handler failure (non-zero exit / non-2xx / timeout / non-JSON) follows the **failure policy**: PreToolUse → **fail-closed** (block the call, tell the model the hook is unavailable), every other event → **fail-open** (skip the hook, never block).

**Middleware chain**: hooks matching the same event+tool run in registration order; a `blocked` short-circuits; `modifiedParams` feeds the *next* hook in the chain (chained rewriting). If nothing blocks, the tool executes with the final (possibly modified) parameters.

**Ordering**: the built-in security policy evaluates **before** hooks — hooks can never bypass policy.

**Model awareness**: a blocked call returns `[hook blocked] …` as the tool result (model must explain, not bypass); modified parameters are announced with `[hook modified input] …` so the model knows what actually ran.

## User Stories

1. As a user, I want to intercept tool calls before execution — block them or rewrite their arguments — so I can enforce project-specific rules the built-in policy doesn't cover.
2. As a user, I want multiple hooks on the same tool to chain in order, so that layered checks compose.
3. As a user, I want a failing PreToolUse hook to block the call (fail-closed), so a broken guard never silently lets a dangerous call through.
4. As a user, I want failing PostToolUse/SessionStart/Stop hooks to be skipped (fail-open), so a broken linter or notifier never blocks the agent.
5. As a user, I want hooks to run only after the built-in policy passes, so custom hooks can't override the security baseline.
6. As a user, I want the model to see why a call was blocked and when arguments were rewritten, so it can adapt and explain.
7. As a user, I want both command handlers (stdin/stdout JSON) and http handlers (POST/response JSON), so I can use scripts or services.

## Implementation Decisions

- **Seam**: `src/agent/hooks.ts` — pure-ish module: `loadHooks` (.hooks JSON; missing → [], corrupt → loud error like .rules), `runPreToolUseHooks` (chain, returns action allow/blocked/fail-closed + final params + message), `dispatchEvent` (fail-open for the other three), `runHandler` (command via `child_process.spawn`, stdin JSON, stdout JSON, timeout kill; http via `fetch` POST, non-2xx → failure; both with a default 10s timeout).
- **Loop integration**: hooks loaded once (`input.hooks ?? loadHooks(workspace)`); SessionStart dispatched before the first model call; PreToolUse runs between the policy evaluation and execution (execute receives the possibly-modified params); PostToolUse after execution with the final params + result; Stop in the `finally` with `{ finalText, iterations, toolCallsMade, aborted }`.
- **Model messages**: `[hook blocked] …` / `[hook modified input] …` fed as the tool result (existing cap/truncation applies).
- **`.hooks.example`** documents the format; ADR-0004 records the design.

## Testing Decisions

- **Seam**: `loadHooks` (missing → [], valid parse, corrupt → throws); chain semantics (blocked short-circuits — later hooks don't run; modifiedParams chains — second hook sees the first's rewrite; no match → pass); failure policy (a crashing command handler on PreToolUse → fail-closed with message; crashing PostToolUse → skipped, call proceeds); handler protocol with real subprocesses (node -e scripts echo stdin, verifying JSON round-trip) and a mocked fetch for http; timeout (injectable timeoutMs, a sleeping script → failed).
- **Loop integration**: injected hooks on the fake adapter — PreToolUse blocked → tool not executed, content contains `[hook blocked]`; modifiedParams → tool executes with the rewritten path; PostToolUse/SessionStart/Stop all fire (recorded), Stop carries the final text.
- **Live E2E**: a real `.hooks` file with a command handler that rewrites/observes a real run.
- **Regression**: full suite green.

## Out of Scope

- Hook hot-reload (hooks are read once per session)
- Async long-running handlers beyond the timeout (10s)
- Remote hook registries / marketplaces
- Hooks on policy decisions themselves (policy stays built-in and un-hookable)

## Further Notes

- Primary source: prototype on branch `prototype/hooks`, file `src/prototype-hooks.html`. Verdict (user, all approved): ① failure policy PreToolUse fail-closed / others fail-open; ② chain semantics (serial, blocked short-circuit, modifiedParams chained); ③ policy before hooks; ④ `[hook blocked]` / `[hook modified input]` model messages; ⑤ `.hooks` JSON config.
