# 01: Session memory (user / project / feedback) with auto-load + remember tool

**What to build:** `src/agent/memory.ts` — pure logic (remember/forget/loadForSession, topic-key overwrite, conflict ruling project>global with visible suppression) + IO (global `~/.simple-agent/memory.json`, project `<workspace>/.simple-agent/memory.json`, atomic writes, corrupt-file tolerance). A `remember` tool lets the agent auto-store (`{type, topic, text}`; scope from type+workspace) with no confirmation. The system prompt gains a `【记忆】` layer after AGENTS.md. CLI: `--memory` (list) and `--memory-forget <id>`.

**Blocked by:** None (prototype verdict received).

**Status:** ready-for-agent

- [ ] Pure logic: remember adds / overwrites same topic+type+scope (v+1, history) / rejects empty; loadForSession filters by project, resolves conflicts (project/feedback > user; newest within level), tracks suppressed (visible, not deleted); forget removes
- [ ] IO: loads global + project files, saves routing by scope, atomic writes, corrupt/missing files → empty + stderr note, no crash
- [ ] remember tool: registered + advertised in toolSpecs(), executes load→remember→save, returns 已记住/已覆盖 vN/已拒绝
- [ ] System prompt memory layer rendered after AGENTS.md, grouped by type
- [ ] CLI `--memory` (list) and `--memory-forget <id>`, both exit without a session; help text updated
- [ ] `.gitignore` covers `.simple-agent/`
- [ ] Live E2E: agent stores a memory in a real run; a second run loads it into the system prompt
- [ ] Full suite green, typecheck, build
