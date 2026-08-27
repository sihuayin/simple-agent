# 01: Agent loop with seven tools

**What to build:** `simple-agent "<task>"` runs the agent loop by default: the model gets seven tools (read_file, write_file, edit_file, grep, glob, bash, list_files) with descriptions and JSON-schema params; it may call them, the CLI executes them against the current directory, and results feed back until a final answer or the iteration cap. When no tool is called, the run is a plain one-shot answer. read_file paginates long files via offset/maxLines with a [TRUNCATED] marker.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] A plain question (no tools needed) answers in one round with zero tool calls
- [ ] A task that requires reading files produces an answer derived from real tool results
- [ ] read_file paginates: maxLines caps each read, [TRUNCATED] names the next offset, continuation reads the rest
- [ ] Tool errors (missing file, unmatched edit oldText, unknown tool name) are fed back to the model as results, not crashes
- [ ] Iteration cap (10) aborts without executing the exceeding round and exits 1 with a warning
- [ ] File tools reject paths that escape the workspace; grep/glob skip node_modules/.git/dist
- [ ] bash executes unsandboxed for now (sandbox policy is a later requirement), output capped at 8000 chars
- [ ] `--verbose` reports provider, model, iterations, and tool-call count
- [ ] Loop tested against a fake adapter — no network in tests
