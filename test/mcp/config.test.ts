import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { interpolateEnv, loadMcpConfig } from "../../src/mcp/config.js";

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

  it("env values interpolate ${VAR} from process.env (undefined → empty string)", async () => {
    process.env.SA_TEST_TOKEN = "sekrit";
    try {
      await withMcpJson(
        JSON.stringify({
          mcpServers: {
            gh: {
              command: "docker",
              args: ["run", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN"],
              env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${SA_TEST_TOKEN}", FOO: "literal", MISSING: "${SA_NO_SUCH_VAR}" },
            },
          },
        }),
        async (ws) => {
          const [server] = await loadMcpConfig(ws);
          expect(server!.type).toBe("stdio");
          if (server!.type !== "stdio") return;
          expect(server!.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "sekrit", FOO: "literal", MISSING: "" });
        },
      );
    } finally {
      delete process.env.SA_TEST_TOKEN;
    }
  });

  it("non-${} braces are left as-is", async () => {
    await withMcpJson(JSON.stringify({ mcpServers: {} }), async () => {
      expect(interpolateEnv("$HOME and ${HOME} and {x}")).toContain("{x}");
      expect(interpolateEnv("a${UNSET_VAR}b")).toBe("ab");
    });
  });

  it("http servers support headers with ${VAR} interpolation", async () => {
    process.env.SA_TEST_TOKEN = "ghp_sekrit";
    try {
      await withMcpJson(
        JSON.stringify({
          mcpServers: {
            gh: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: "Bearer ${SA_TEST_TOKEN}", "X-Static": "v" } },
          },
        }),
        async (ws) => {
          const [server] = await loadMcpConfig(ws);
          expect(server).toEqual({
            name: "gh",
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: { Authorization: "Bearer ghp_sekrit", "X-Static": "v" },
          });
        },
      );
    } finally {
      delete process.env.SA_TEST_TOKEN;
    }
  });

  it("http headers must be an object", async () => {
    await withMcpJson(
      JSON.stringify({ mcpServers: { gh: { url: "https://x", headers: "Bearer x" } } }),
      async (ws) => {
        await expect(loadMcpConfig(ws)).rejects.toThrow(/gh/);
      },
    );
  });
});
