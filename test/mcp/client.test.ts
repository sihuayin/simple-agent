import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { McpManager } from "../../src/mcp/client.js";
import type { ToolContext } from "../../src/tools/types.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp-server.mjs", import.meta.url));
const ctx = { workspace: process.cwd(), cwd: process.cwd(), env: process.env } as ToolContext;

describe("McpManager (real SDK + real child-process server)", () => {
  it("connects, discovers tools with mcp_<server>_<tool> names, and calls echo round-trip", async () => {
    const m = new McpManager([
      { name: "fixture", type: "stdio", command: process.execPath, args: [FIXTURE] },
    ]);
    try {
      const { connected, failed } = await m.connectAll();
      expect(connected).toEqual(["fixture"]);
      expect(failed).toEqual([]);

      const tools = m.getToolEntries();
      expect(tools.map((t) => t.name)).toEqual(["mcp_fixture_echo", "mcp_fixture_fail"]);
      expect(tools[0]!.description).toContain('MCP 服务器 "fixture"');
      expect(tools[0]!.description).toContain("回显");
      expect(tools[0]!.parameters).toMatchObject({ type: "object" });

      const out = await tools[0]!.execute({ text: "hi" }, ctx);
      expect(out).toBe('echo:{"text":"hi"}');
    } finally {
      await m.closeAll();
    }
  });

  it("isError results get the [mcp error] prefix", async () => {
    const m = new McpManager([
      { name: "fixture", type: "stdio", command: process.execPath, args: [FIXTURE] },
    ]);
    try {
      await m.connectAll();
      const tools = m.getToolEntries();
      const out = await tools.find((t) => t.name === "mcp_fixture_fail")!.execute({}, ctx);
      expect(out).toBe("[mcp error] boom");
    } finally {
      await m.closeAll();
    }
  });

  it("server crashing mid-call returns an error result instead of throwing", async () => {
    const m = new McpManager([
      { name: "fixture", type: "stdio", command: process.execPath, args: [FIXTURE], env: { SA_MCP_CRASH_ON_CALL: "1" } },
    ]);
    try {
      await m.connectAll();
      const tools = m.getToolEntries();
      const out = await tools.find((t) => t.name === "mcp_fixture_echo")!.execute({ text: "x" }, ctx);
      expect(out).toMatch(/mcp error|Error|error|失败/i);
      // 调用失败后 closeAll 不应抛错
    } finally {
      await m.closeAll();
    }
  });

  it("failure isolation: a bad server is skipped, the good one still works", async () => {
    const m = new McpManager([
      { name: "good", type: "stdio", command: process.execPath, args: [FIXTURE] },
      { name: "bad", type: "stdio", command: "definitely-not-a-real-command-xyz", args: [] },
    ]);
    try {
      const { connected, failed } = await m.connectAll();
      expect(connected).toEqual(["good"]);
      expect(failed).toHaveLength(1);
      expect(failed[0]!.name).toBe("bad");
      expect(failed[0]!.error).toBeTruthy();

      const tools = m.getToolEntries();
      expect(tools.map((t) => t.name)).toEqual(["mcp_good_echo", "mcp_good_fail"]);
      expect(await tools[0]!.execute({ text: "ok" }, ctx)).toBe('echo:{"text":"ok"}');
    } finally {
      await m.closeAll();
    }
  });

  it("a server crashing after startup drops its tools (callable tool reports failure)", async () => {
    const m = new McpManager([
      { name: "fixture", type: "stdio", command: process.execPath, args: [FIXTURE], env: { SA_MCP_CRASH_AFTER: "300" } },
    ]);
    try {
      await m.connectAll();
      const tools = m.getToolEntries();
      expect(tools.length).toBe(2);
      // 等它崩（300ms 后）；调用应得到错误而不是挂死
      await new Promise((r) => setTimeout(r, 600));
      const out = await tools[0]!.execute({ text: "x" }, ctx);
      expect(out).toMatch(/mcp error|Error|error|失败/i);
    } finally {
      await m.closeAll();
    }
  });

  it("closeAll is idempotent and never throws", async () => {
    const m = new McpManager([
      { name: "good", type: "stdio", command: process.execPath, args: [FIXTURE] },
      { name: "bad", type: "stdio", command: "not-a-real-command-zzz", args: [] },
    ]);
    await m.connectAll();
    await m.closeAll();
    await expect(m.closeAll()).resolves.toBeUndefined();
  });
});
