import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadMcpConfig } from "../../src/mcp/config.js";

async function withMcpJson(content: string | null, fn: (workspace: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "sa-mcp-"));
  try {
    if (content !== null) await writeFile(path.join(dir, ".mcp.json"), content, "utf8");
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("loadMcpConfig", () => {
  it("missing .mcp.json → no servers", async () => {
    await withMcpJson(null, async (ws) => {
      expect(await loadMcpConfig(ws)).toEqual([]);
    });
  });

  it("parses stdio and http servers", async () => {
    await withMcpJson(
      JSON.stringify({
        mcpServers: {
          files: { command: "npx", args: ["-y", "server-filesystem", "."], env: { FOO: "1" } },
          remote: { url: "https://mcp.example.com/mcp" },
        },
      }),
      async (ws) => {
        const out = await loadMcpConfig(ws);
        expect(out).toEqual([
          { name: "files", type: "stdio", command: "npx", args: ["-y", "server-filesystem", "."], env: { FOO: "1" } },
          { name: "remote", type: "http", url: "https://mcp.example.com/mcp" },
        ]);
      },
    );
  });

  it("corrupt JSON → loud error", async () => {
    await withMcpJson("{ not json", async (ws) => {
      await expect(loadMcpConfig(ws)).rejects.toThrow(/\.mcp\.json/);
    });
  });

  it("entry with neither command nor url → loud error", async () => {
    await withMcpJson(JSON.stringify({ mcpServers: { bad: { args: ["x"] } } }), async (ws) => {
      await expect(loadMcpConfig(ws)).rejects.toThrow(/bad/);
    });
  });

  it("entry with both command and url → loud error", async () => {
    await withMcpJson(
      JSON.stringify({ mcpServers: { bad: { command: "x", url: "https://y" } } }),
      async (ws) => {
        await expect(loadMcpConfig(ws)).rejects.toThrow(/bad/);
      },
    );
  });

  it("non-object mcpServers → loud error", async () => {
    await withMcpJson(JSON.stringify({ mcpServers: [] }), async (ws) => {
      await expect(loadMcpConfig(ws)).rejects.toThrow(/mcpServers/);
    });
  });

  it("empty mcpServers object → no servers", async () => {
    await withMcpJson(JSON.stringify({ mcpServers: {} }), async (ws) => {
      expect(await loadMcpConfig(ws)).toEqual([]);
    });
  });
});
