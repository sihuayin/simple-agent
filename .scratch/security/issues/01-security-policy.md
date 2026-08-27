# 01: Security policy with deny/allow/ask and protected paths

**What to build:** Every tool call is evaluated before execution — three passes (deny → ask → allow, ask as the post-pass default). Deny blocks irreversible commands (`rm -rf /`, `dd`, `curl … | bash`); allow passes daily operations (npm run, git view, file reads); ask prompts the human via readline on a TTY (auto-block non-interactive) for risky actions and all writes. A protected-path list (.git/**, .env*, keys…) forces ask even on allow. Rules = built-in defaults + workspace `.rules` file.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] `rm -rf /` variants, `dd`, `curl|bash` are denied; the denial is fed back as a tool result and the command never executes
- [ ] `npm run *`, `git status/log/diff/branch`, `read_file`/`grep`/`glob`/`list_files` pass without asking
- [ ] `git push --force`, `rm -r`, `write_file`, `edit_file` ask: TTY → y/N readline; non-interactive → blocked with reason
- [ ] Human yes executes; human no produces `[permission denied by user]` and no side effect
- [ ] Protected paths (.env, .git/config, keys) override allow to ask for file tools
- [ ] `.rules` file appends user rules; malformed `.rules` fails loudly
- [ ] bash has no read commands in allow (cat blocked via fallback), so protected paths can't be bypassed via bash
