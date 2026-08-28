Status: ready-for-agent

# Spec: session memory (user / project / feedback)

## Problem Statement

Session solves "接着上次聊", but some information outlives a single conversation: user preferences, project conventions, and corrections the user made to the agent. That information should be stored permanently and auto-loaded into every new session. The open question was the classification/lifecycle model: what to remember, what to skip, how loading filters by project, and who wins when memories conflict.

## Solution

Three memory types, decided by the prototype: **user** (personal preference, global — survives switching projects), **project** (project-level convention, only loads in its source project), **feedback** (user corrections of agent behavior, project-level). The filter rule is the point of classification: on a new session, user memories always load, project/feedback memories load only in their source project.

- **Judgement**: a memory is worth keeping iff "it would still be useful in a new session" (the user's rule). Transient debug info, one-off task details, and overly specific code fragments must NOT be remembered — the agent (a model) makes this call when it decides to invoke the remember tool.
- **Topic key**: every memory carries a short topic ("naming", "deploy-order", "language"…). Same topic + same type + same scope → overwrite (version+1, old text into history); different types on the same topic do NOT overwrite — they conflict, resolved at load time.
- **Auto-store**: the agent stores by calling a `remember` tool — no confirmation step (the human decided: 自动落库). The tool guards against empty text/topic only.
- **Conflict ruling**: at load time, same-topic memories are resolved — project-level (project/feedback) always beats global (user); within the same level the newest `updatedAt` wins. The loser goes into a visible "suppressed" list (not deleted).
- **No expiry**: memories only change via overwrite or explicit forget. No auto-decay.

## Storage

- Global (user) memories: `~/.simple-agent/memory.json`
- Project (project/feedback) memories: `<workspace>/.simple-agent/memory.json`
- File format: `{ version: 1, memories: Memory[] }`; writes are atomic (temp file + rename). Corrupt/missing files load as empty (memory is an enhancement — a broken file must not crash the run; a stderr note is printed). `.simple-agent/` is gitignored (project memories are local accumulations, not source).
- `scope`: `"global"` for user; the normalized workspace path for project/feedback.

## User Stories

1. As a user, I want my preferences (回复用中文, camelCase) to load into every session in every project, so I don't repeat myself.
2. As a user, I want project conventions to load only in that project, so switching projects doesn't leak conventions.
3. As a user, I want corrections of agent behavior remembered as project-level feedback, so the agent doesn't repeat the mistake.
4. As a user, I want the agent to remember on its own (no confirmation prompts), with the "useful next session" judgement.
5. As a user, I want same-topic repeated corrections to overwrite (versioned, history kept), not pile up.
6. As a user, I want conflicting memories resolved at load (project > user; newest within a level), with the suppressed one still visible.
7. As a user, I want to list and delete memories from the CLI (`--memory` / `--memory-forget <id>`).

## Implementation Decisions

- **Seam**: `src/agent/memory.ts` — pure logic lifted from the prototype (`remember`, `forget`, `loadForSession`, worth judgement) + IO (`loadMemoryStore`, `saveMemoryStore`, atomic writes, corrupt-file tolerance). `projectId` = normalized absolute workspace path.
- **Agent write path**: a `remember` tool (advertised in `toolSpecs()` like the others): `{ type: "user"|"project"|"feedback", topic, text }`; scope derived from type (user → global) and workspace (project/feedback → workspace). Executes via load → remember → save; returns "已记住"/"已覆盖 vN"/"已拒绝" so the model knows.
- **Load path**: `buildSystemPrompt(workspace, memories)` gains a memory layer appended after AGENTS.md: `【记忆】` bullets grouped by type. Memories written this session take effect next session (the system prompt is fixed at start — intended).
- **CLI**: `--memory` prints global + project memories (and the load result); `--memory-forget <id>` deletes one. Both exit without running a session.
- **ADR-0003** records the storage layout and load-time conflict ruling.

## Testing Decisions

- **Seam**: pure functions tested directly (add/overwrite/reject, load filtering by project, conflict ruling with suppressed list, forget); IO tested against temp dirs (round-trip, scope routing to the two files, corrupt file → empty + no crash, atomic write leaves no partial file).
- **Integration**: remember tool writes real files in a temp workspace; toolSpecs() advertises remember; system prompt memory layer rendered; CLI --memory/--memory-forget against a temp HOME.
- **Live E2E**: a real run stores a memory (agent decides), a second run loads it into the system prompt.
- **Regression**: full suite green.

## Out of Scope

- Memory editing/merging UIs beyond list/forget (edit = re-remember same topic)
- Cross-machine sync of project memories
- Auto-decay / expiry of memories (explicitly rejected: 暂时不过期)
- Agent-visible forget tool (the human owns deletion via CLI)

## Further Notes

- Primary source: prototype on branch `prototype/memory`, file `src/prototype-memory.html`. Verdict recorded: ① conflict ruling 项目级>全局 — approved; ② topic key — approved; ③ auto-store without confirmation — approved; ④ overwrite with version+history — approved; ⑤ no expiry — approved.
- The prototype's noise rejection (topic "noise" → refuse) is realized in production as the agent's own judgement when deciding to call remember; the tool guards only empty text/topic.
