Status: ready-for-agent

# Spec: security policy (Deny / Allow / Ask + protected paths)

## Problem Statement

The agent can execute arbitrary tools — bash above all. Without a policy, a confused or misdirected model could run `rm -rf /`, download-and-execute scripts, or read secrets. The tools spec deferred "bash sandboxing" to a later requirement; this feature is that requirement.

## Solution

Every tool call is evaluated before execution in three passes by action type — **deny → ask → allow** — with **ask as the post-pass default** (the fallback is NOT a rule in the array; a catch-all ask rule would shadow every allow). Deny covers short, precise, irreversible commands (`rm -rf /`, `dd`, `curl … | bash`); allow covers daily safe operations (`npm run *`, git view commands, file reads); ask covers risky-but-recoverable actions and **all writes** (`write_file`, `edit_file` always confirm). On ask, the CLI confirms with the human via `readline` on a TTY (`y/N`); non-interactive runs block and feed the reason back to the model. A separate protected-path list (`.git/**`, `.env*`, …) forces ask even when an allow rule matched. Rules come from built-in defaults plus the workspace `.rules` file (JSON array, appended after defaults).

## Verdict (from prototype)

A throwaway HTML prototype (`prototype/permissions` branch, `src/prototype-permissions.html`) validated the evaluation logic against 18 cases. Three findings nailed during prototyping: (1) the ask fallback must be the post-pass default, not a rule; (2) bash command patterns need command-style globs (`*` matches slashes) or `dd if=/dev/sda` / `curl … | bash` never match; (3) bash must NOT allow read commands (`cat`, …) or it bypasses the protected-path check — the model should use `read_file`. User directives folded in: ask confirms via readline; rules load from a local `.rules` file.

## User Stories

1. As a user, I want irreversible commands (rm -rf /, dd, curl|bash) denied outright, so that the agent can never destroy the machine.
2. As a user, I want daily operations (npm run, git status/log/diff, file reads) allowed without asking, so that the agent isn't annoying.
3. As a user, I want risky-but-recoverable actions (git push --force, rm -r) and all file writes to ask me first, so that nothing with side effects happens silently.
4. As a user, I want ask to prompt me on a terminal (y/N), so that I can approve or reject mid-run.
5. As a user, I want non-interactive runs to block ask decisions and tell the model why, so that the model explains instead of acting.
6. As a user, I want protected paths (.git, .env, keys…) to require confirmation even when a rule would allow the call, so that secrets have a second layer of defense.
7. As a user, I want to add my own rules in a `.rules` file, so that the policy adapts per project.
8. As a user, I want a malformed `.rules` file to fail loudly, so that a typo never silently weakens the policy.

## Implementation Decisions

- **Rule model**: `{ tool, pattern?, action: "deny"|"ask"|"allow" }`; missing pattern = tool-level (matches any invocation). bash patterns are command globs (`*` matches slashes); path patterns use path-style globs (`*` within a segment, `**` across).
- **Evaluation** (`src/agent/policy.ts`): pass deny → pass ask → pass allow, first match in array order within a pass; unmatched → ask fallback. After an allow match, file tools' paths are checked against the protected list → ask override.
- **Feedback**: deny/ask produce `[permission denied]` / `[permission required]` tool results (never a crash) explaining the rule; a human rejection produces `[permission denied by user]`. The model must explain in its final answer.
- **ask interaction**: `defaultAsk` — `readline` prompt on a TTY; auto-block when stdin is not a TTY. Injectable `ask` seam for tests.
- **Rules source**: `loadRules(workspace)` = built-in defaults + `.rules` (JSON array) appended. Missing file → defaults; malformed JSON or non-array → throws (loud, never silent weakening); invalid entries dropped.
- **Protected paths**: built-in `DEFAULT_PROTECTED_PATHS` (`.git/**`, `.env*`, `.claude/**`, `.vscode/**`, `node_modules/**`, `**/*.key`, `**/*.pem`, `**/credentials*`, `**/secret*`).
- **Loop integration**: policy evaluated in the tool-execution branch before `tool.execute`; deny blocks, ask confirms-then-executes-or-blocks, allow executes. `bash` itself stays unsandboxed — enforcement lives at the single loop point.
- **`.rules.example`** documents the format.

## Testing Decisions

- **Seam**: pure functions (`globToRegex` modes, `ruleMatches`, `evaluatePolicy`, `pathHitsProtected`, `loadRules`, feedback messages) tested directly; loop integration with an injected `ask` and a temp workspace `.rules` file.
- **Key cases**: all three passes + fallback; command-style vs path-style globs (`dd if=/dev/sda`, `curl … | bash`, `**/*.ts`); protected-path override (.env, .git/config) and non-override (src/); deny → tool not executed; ask + human yes → executed; ask + human no → rejected message + no side effect; `.rules` merge / malformed throw / invalid-entry drop; default ask auto-blocks without a TTY.
- **Live E2E**: normal runs unaffected (policy passes, `compacted=0`).

## Out of Scope

- Interactive confirmation in non-TTY contexts (blocked by default; a remote-approval mechanism is future work)
- Per-rule override of the built-in defaults (user rules append; defaults are the safety floor)
- Scanning bash command strings for protected-path mentions (bash has no read commands in allow, closing the main hole)

## Further Notes

- Prototype (primary source): branch `prototype/permissions`, file `src/prototype-permissions.html`.
- **Closes the deferred "bash sandbox" item** from the tools spec (Out of Scope there), which pointed here.
- Glossary updated in `CONTEXT.md`: policy, rule, protected path.
