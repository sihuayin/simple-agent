# 01: Hook system (PreToolUse / PostToolUse / SessionStart / Stop)

**What to build:** `src/agent/hooks.ts` — `.hooks` config (JSON, like .rules; missing → [], corrupt → loud error), handler protocol (command: stdin JSON → stdout JSON via spawn; http: POST → response JSON; default 10s timeout), PreToolUse middleware chain (registration order, blocked short-circuit, modifiedParams chained, fail-closed on failure), fail-open dispatch for the other events. Loop: SessionStart before first call; PreToolUse between policy and execution (execute with rewritten params); PostToolUse after execution; Stop in finally with finalText/iterations/toolCallsMade/aborted. Model messages: `[hook blocked]` / `[hook modified input]`.

**Blocked by:** None (prototype verdict received).

**Status:** ready-for-agent

- [ ] loadHooks: missing → [], valid parse, corrupt → throws
- [ ] runPreToolUseHooks: chain order, blocked short-circuit (later hooks skipped), modifiedParams chained, no-match pass, fail-closed with message on handler failure
- [ ] dispatchEvent (PostToolUse/SessionStart/Stop): fail-open — a crashing handler is skipped
- [ ] runHandler: command via real subprocess (stdin JSON in, stdout JSON out, timeout kill), http via fetch (POST, non-2xx → failure)
- [ ] Loop: SessionStart fires before the first call; PreToolUse between policy and execution; PostToolUse after execution (final params + result); Stop in finally carrying finalText/iterations/toolCallsMade/aborted
- [ ] Model messages: blocked → `[hook blocked] …`, rewritten params → `[hook modified input] …`
- [ ] `.hooks.example` + README/CONTEXT docs + ADR-0004
- [ ] Live E2E with a real command hook
- [ ] Full suite green, typecheck, build
