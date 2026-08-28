# ADR-0003: Session memory with type-scoped loading

- Status: Accepted
- Date: 2026-08-28
- Context: `.scratch/memory/spec.md`; prototype on `prototype/memory`

## Decision

Memories are typed **user** (global scope — personal preferences, load in every project), **project** (conventions, load only in the source workspace), and **feedback** (corrections of agent behavior, project-level). A memory carries a **topic key**; same topic + same type + same scope overwrite (version+1, old text into history), while different types on the same topic conflict and are resolved at load time: project-level always beats global, newest `updatedAt` wins within a level, and losers go into a visible suppressed list — never deleted. There is no expiry: memories change only via overwrite or explicit `--memory-forget`. The agent stores memories itself via the `remember` tool (no confirmation step); the judgement "would this still be useful in a new session" is the model's, and the tool only guards empty text/topic.

## Consequences

- Storage: global at `~/.simple-agent/memory.json`, project at `<workspace>/.simple-agent/memory.json` (atomic writes; corrupt/missing files load empty with a stderr note; `.simple-agent/` gitignored).
- Loading: every session injects the memory layer into the system prompt after AGENTS.md (`【记忆】` bullets grouped by type). Memories written this session take effect next session (the prompt is fixed at start).
- The conflict ruling (project > user) was explicitly approved by the user ("① 对"), as were the topic key ("② 接受"), auto-store without confirmation ("③ 自动落库"), overwrite-with-history ("④ 覆盖"), and no expiry ("⑤ 暂时不过期").
- Trade-off accepted: global memory lives in the real `$HOME` — two machines don't share it; project memory is per-workspace and local.
- Trade-off accepted: `remember` is allow-listed in the policy (it writes only the two memory files, never project source), so auto-store never hits an ask prompt.
