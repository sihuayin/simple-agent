import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  dispatchEvent,
  loadHooks,
  runHandler,
  runPreToolUseHooks,
  type HookConfig,
} from "../../src/agent/hooks.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sa-hooks-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const bashHook = (name: string, command: string, matcher = "bash"): HookConfig => ({
  name,
  event: "PreToolUse",
  matcher,
  handler: { type: "command", command },
});

/** 命令 handler：stdin 收到的 JSON 回显，并按脚本逻辑决定返回。 */
const ECHO_SCRIPT = `node -e "const d=require('fs').readFileSync(0,'utf8');const c=JSON.parse(d);console.log(JSON.stringify({echo:c}))"`;
const BLOCK_SCRIPT = `node -e "const d=require('fs').readFileSync(0,'utf8');const c=JSON.parse(d);console.log(JSON.stringify({blocked:true,reason:'blocked-by-'+c.hook}))"`;
const CRASH_SCRIPT = `node -e "process.exit(3)"`;
const SLOW_SCRIPT = `node -e "setTimeout(()=>{},5000)"`;

describe("loadHooks", () => {
  it("returns [] when .hooks is missing", async () => {
    expect(await loadHooks(root)).toEqual([]);
  });

  it("parses a valid hook array", async () => {
    await fs.writeFile(path.join(root, ".hooks"), JSON.stringify([bashHook("g", "x"), { name: "n", event: "Stop", handler: { type: "http", url: "https://n.example" } }]));
    const hooks = await loadHooks(root);
    expect(hooks).toHaveLength(2);
    expect(hooks[0]).toMatchObject({ name: "g", event: "PreToolUse", matcher: "bash" });
  });

  it("throws loudly on corrupt JSON and non-array bodies", async () => {
    await fs.writeFile(path.join(root, ".hooks"), "{ nope");
    await expect(loadHooks(root)).rejects.toThrow(/合法 JSON/);
    await fs.writeFile(path.join(root, ".hooks"), '{"name":"x"}');
    await expect(loadHooks(root)).rejects.toThrow(/JSON 数组/);
  });
});

describe("runHandler: 协议", () => {
  it("command: sends context JSON on stdin, parses stdout JSON", async () => {
    const r = await runHandler(bashHook("e", ECHO_SCRIPT), { event: "PreToolUse", tool: "bash", input: { command: "ls" }, workspace: root, hook: "e" });
    expect(r).toEqual({ echo: { event: "PreToolUse", tool: "bash", input: { command: "ls" }, workspace: root, hook: "e" } });
  });

  it("command: non-zero exit is a failure", async () => {
    const r = await runHandler(bashHook("c", CRASH_SCRIPT), { event: "PreToolUse", tool: "bash", input: {}, workspace: root, hook: "c" });
    expect(r.failed).toBe(true);
    expect(r.error).toMatch(/exit code 3/);
  });

  it("command: timeout kills the handler", async () => {
    const r = await runHandler(bashHook("s", SLOW_SCRIPT), { event: "PreToolUse", tool: "bash", input: {}, workspace: root, hook: "s" }, { timeoutMs: 300 });
    expect(r.failed).toBe(true);
    expect(r.error).toMatch(/timeout/);
  });

  it("http: POSTs JSON and parses the response body", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, text: async () => JSON.stringify({ blocked: true, reason: "http-rule" }) }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    try {
      const r = await runHandler({ name: "h", event: "PreToolUse", handler: { type: "http", url: "https://guard.example/check" } }, { event: "PreToolUse", tool: "bash", input: {}, workspace: root, hook: "h" });
      expect(r).toEqual({ blocked: true, reason: "http-rule" });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe("https://guard.example/check");
      expect((init as RequestInit).method).toBe("POST");
      expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({ event: "PreToolUse", tool: "bash" });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("http: non-2xx is a failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, text: async () => "" })));
    try {
      const r = await runHandler({ name: "h", event: "PostToolUse", handler: { type: "http", url: "https://x.example" } }, { event: "PostToolUse", tool: "bash", input: {}, result: "", workspace: root, hook: "h" });
      expect(r.failed).toBe(true);
      expect(r.error).toMatch(/503/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("runPreToolUseHooks: 中间件链", () => {
  const ctx = { tool: "bash", input: { command: "ls" } as Record<string, unknown>, workspace: root };

  it("no matching hooks → allow with original params", async () => {
    const r = await runPreToolUseHooks([bashHook("g", BLOCK_SCRIPT, "write_file")], ctx);
    expect(r.action).toBe("allow");
    expect(r.params).toEqual({ command: "ls" });
    expect(r.message).toBeUndefined();
  });

  it("blocked short-circuits: hooks after the blocker never run", async () => {
    const logFile = path.join(root, `log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.HOOK_LOG = logFile;
    const ran = (name: string, extra: string) =>
      `node -e "const fs=require('fs');const d=fs.readFileSync(0,'utf8');const c=JSON.parse(d);fs.appendFileSync(process.env.HOOK_LOG,JSON.stringify({name:'${name}',input:c.input})+String.fromCharCode(10));${extra}"`;
    try {
      const r = await runPreToolUseHooks(
        [
          { name: "first", event: "PreToolUse", matcher: "bash", handler: { type: "command", command: ran("first", "console.log(JSON.stringify({}))") } },
          { name: "blocker", event: "PreToolUse", matcher: "bash", handler: { type: "command", command: ran("blocker", "console.log(JSON.stringify({blocked:true,reason:'no'}))") } },
          { name: "third", event: "PreToolUse", matcher: "bash", handler: { type: "command", command: ran("third", "console.log(JSON.stringify({}))") } },
        ],
        ctx,
      );
      expect(r.action).toBe("blocked");
      expect(r.message).toContain("[hook blocked]");
      expect(r.message).toContain("blocker");
      const ranHooks = (await fs.readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l).name);
      expect(ranHooks).toEqual(["first", "blocker"]); // third 未执行（短路）
    } finally {
      delete process.env.HOOK_LOG;
      await fs.rm(logFile, { force: true });
    }
  });

  it("modifiedParams chains: the second hook sees the first hook's rewrite", async () => {
    const logFile = path.join(root, `log-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.HOOK_LOG = logFile;
    const ran = (name: string, out: string) =>
      `node -e "const fs=require('fs');const d=fs.readFileSync(0,'utf8');const c=JSON.parse(d);fs.appendFileSync(process.env.HOOK_LOG,JSON.stringify({name:'${name}',input:c.input})+String.fromCharCode(10));console.log(JSON.stringify(${out}))"`;
    try {
      const r = await runPreToolUseHooks(
        [
          { name: "add-flag", event: "PreToolUse", matcher: "bash", handler: { type: "command", command: ran("add-flag", "{modifiedParams:{flag:true}}") } },
          { name: "echo", event: "PreToolUse", matcher: "bash", handler: { type: "command", command: ran("echo", "{}") } },
        ],
        ctx,
      );
      expect(r.action).toBe("allow");
      expect(r.params).toEqual({ command: "ls", flag: true });
      expect(r.message).toContain("[hook modified input]");
      const inputs = (await fs.readFile(logFile, "utf8")).trim().split("\n").map((l) => JSON.parse(l).input);
      expect(inputs[0]).toEqual({ command: "ls" }); // 第一个 hook 看到原始参数
      expect(inputs[1]).toEqual({ command: "ls", flag: true }); // 第二个 hook 看到改后的参数
    } finally {
      delete process.env.HOOK_LOG;
      await fs.rm(logFile, { force: true });
    }
  });

  it("fail-closed: a crashing PreToolUse hook blocks with a message", async () => {
    const r = await runPreToolUseHooks([bashHook("crashy", CRASH_SCRIPT)], ctx);
    expect(r.action).toBe("fail-closed");
    expect(r.message).toContain("[hook blocked]");
    expect(r.message).toContain("fail-closed");
    expect(r.message).toContain("crashy");
  });
});

describe("dispatchEvent: fail-open", () => {
  it("a crashing PostToolUse hook is skipped, no throw", async () => {
    await expect(
      dispatchEvent([{ name: "lint", event: "PostToolUse", matcher: "bash", handler: { type: "command", command: CRASH_SCRIPT } }], "PostToolUse", { tool: "bash", input: {}, result: "ok", workspace: root }),
    ).resolves.toBeUndefined();
  });

  it("SessionStart/Stop fire matching hooks", async () => {
    // 无法从外部观察子进程，改用 http mock 记录
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, text: async () => "{}" }));
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    try {
      await dispatchEvent([{ name: "init", event: "SessionStart", handler: { type: "http", url: "https://init.example" } }], "SessionStart", { workspace: root });
      await dispatchEvent([{ name: "notify", event: "Stop", handler: { type: "http", url: "https://notify.example" } }], "Stop", { workspace: root, finalText: "done", iterations: 2, toolCallsMade: 1, aborted: false });
      const bodies = fetchMock.mock.calls.map(([, init]) => JSON.parse(String((init as RequestInit).body))) as { event: string; finalText?: string }[];
      expect(bodies.map((b) => b.event)).toEqual(["SessionStart", "Stop"]);
      expect(bodies[1]!.finalText).toBe("done");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
