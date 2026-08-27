import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { bashTool } from "../../src/tools/bash.js";
import { editFileTool } from "../../src/tools/edit_file.js";
import { globTool } from "../../src/tools/glob.js";
import { grepTool } from "../../src/tools/grep.js";
import { listFilesTool } from "../../src/tools/list_files.js";
import { readFileTool, readChunk } from "../../src/tools/read_file.js";
import { ToolExecutionError, type ToolContext } from "../../src/tools/types.js";
import { writeFileTool } from "../../src/tools/write_file.js";

let root: string;
let workspace: string;
let ctx: ToolContext;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sa-tools-"));
  workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.mkdir(path.join(workspace, "node_modules"), { recursive: true });
  await fs.writeFile(path.join(root, "secret.txt"), "outside the workspace");
  await fs.writeFile(path.join(workspace, "short.txt"), "alpha\nbeta\ngamma");
  await fs.writeFile(
    path.join(workspace, "long.txt"),
    Array.from({ length: 100 }, (_, i) => `line ${String(i + 1).padStart(3, "0")}`).join("\n"),
  );
  await fs.writeFile(path.join(workspace, "src", "app.ts"), 'export const x = 1;\n// TODO: wire tools\n');
  await fs.writeFile(path.join(workspace, "node_modules", "junk.txt"), "TODO in node_modules");
  await fs.writeFile(
    path.join(workspace, "big.txt"),
    Array.from({ length: 1500 }, (_, i) => `row ${i + 1}`).join("\n"),
  );
  await fs.writeFile(
    path.join(workspace, "many.txt"),
    Array.from({ length: 60 }, (_, i) => `dup line ${i + 1}`).join("\n"),
  );
  ctx = { workspace, cwd: workspace, env: process.env };
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("read_file", () => {
  it("paginates long files with a [TRUNCATED] marker and next offset", async () => {
    const first = await readFileTool.execute({ path: "long.txt", maxLines: 10 }, ctx);
    expect(first.split("\n")).toHaveLength(11);
    expect(first).toContain("[TRUNCATED — 100 lines total; continue with offset=11]");

    const second = await readFileTool.execute({ path: "long.txt", offset: 11, maxLines: 10 }, ctx);
    expect(second).toContain("line 011");
    expect(second).toContain("offset=21");
  });

  it("reads a whole short file without a marker", async () => {
    const out = await readFileTool.execute({ path: "short.txt" }, ctx);
    expect(out).toBe("alpha\nbeta\ngamma");
  });

  it("rejects a missing file", async () => {
    await expect(readFileTool.execute({ path: "nope.txt" }, ctx)).rejects.toThrow(ToolExecutionError);
  });

  it("caps maxLines at 1000 even when asked for more", async () => {
    const out = await readFileTool.execute({ path: "big.txt", maxLines: 5000 }, ctx);
    const lines = out.split("\n");
    expect(lines).toHaveLength(1001); // 1000 lines + TRUNCATED marker
    expect(out).toContain("[TRUNCATED — 1500 lines total");
  });

  it("rejects a path that escapes the workspace", async () => {
    await expect(readFileTool.execute({ path: "../secret.txt" }, ctx)).rejects.toThrow(/escapes the workspace/);
  });
});

describe("readChunk", () => {
  it("handles a trailing offset past the end", () => {
    expect(readChunk("a\nb\nc", 5, 10)).toBe("");
  });
});

describe("write_file", () => {
  it("creates a file (and parent directories)", async () => {
    const out = await writeFileTool.execute({ path: "nested/deep/new.txt", content: "hello\nworld" }, ctx);
    expect(out).toContain("wrote 2 line(s)");
    expect(await fs.readFile(path.join(workspace, "nested/deep/new.txt"), "utf8")).toBe("hello\nworld");
  });

  it("overwrites an existing file", async () => {
    await writeFileTool.execute({ path: "overwrite.txt", content: "first" }, ctx);
    await writeFileTool.execute({ path: "overwrite.txt", content: "second" }, ctx);
    expect(await fs.readFile(path.join(workspace, "overwrite.txt"), "utf8")).toBe("second");
  });

  it("rejects a path that escapes the workspace", async () => {
    await expect(writeFileTool.execute({ path: "../evil.txt", content: "x" }, ctx)).rejects.toThrow(/escapes/);
  });
});

describe("edit_file", () => {
  it("replaces the first occurrence of oldText", async () => {
    await editFileTool.execute({ path: "short.txt", edits: [{ oldText: "beta", newText: "BETA" }] }, ctx);
    expect(await fs.readFile(path.join(workspace, "short.txt"), "utf8")).toBe("alpha\nBETA\ngamma");
  });

  it("fails the whole call when an oldText is not found", async () => {
    await expect(
      editFileTool.execute({ path: "short.txt", edits: [{ oldText: "missing", newText: "x" }] }, ctx),
    ).rejects.toThrow(/oldText not found/);
    expect(await fs.readFile(path.join(workspace, "short.txt"), "utf8")).toBe("alpha\nBETA\ngamma");
  });
});

describe("grep", () => {
  it("returns matches with path and line number", async () => {
    const out = await grepTool.execute({ pattern: "TODO" }, ctx);
    expect(out).toContain("src/app.ts:2:");
    expect(out).not.toContain("node_modules"); // skipped
  });

  it("reports no matches", async () => {
    expect(await grepTool.execute({ pattern: "zzz-no-such" }, ctx)).toContain("no matches");
  });

  it("caps results at maxResults", async () => {
    const out = await grepTool.execute({ pattern: "dup line" }, ctx);
    expect(out.split("\n")).toHaveLength(50);
  });
});

describe("glob", () => {
  it("matches ** and * patterns", async () => {
    const all = await globTool.execute({ pattern: "**/*.ts" }, ctx);
    expect(all).toContain("src/app.ts");
    const nested = await globTool.execute({ pattern: "src/*.ts" }, ctx);
    expect(nested).toContain("src/app.ts");
  });
});

describe("list_files", () => {
  it("lists top-level entries with dirs marked", async () => {
    const out = await listFilesTool.execute({}, ctx);
    expect(out).toContain("src/");
    expect(out).toContain("short.txt");
  });

  it("lists recursively when asked", async () => {
    const out = await listFilesTool.execute({ recursive: true }, ctx);
    expect(out).toContain("src/app.ts");
  });

  it("lists a single file path", async () => {
    expect(await listFilesTool.execute({ path: "short.txt" }, ctx)).toBe("short.txt");
  });

  it("rejects a path that escapes the workspace", async () => {
    await expect(listFilesTool.execute({ path: "../secret.txt" }, ctx)).rejects.toThrow(/escapes the workspace/);
  });
});

describe("bash", () => {
  it("runs a command and returns output", async () => {
    const out = await bashTool.execute({ command: "echo hello" }, ctx);
    expect(out).toContain("hello");
  });

  it("reports a failing command", async () => {
    const out = await bashTool.execute({ command: "exit 3" }, ctx);
    expect(out.length).toBeGreaterThan(0);
  });

  it("honors timeoutSeconds", async () => {
    const out = await bashTool.execute({ command: "sleep 5", timeoutSeconds: 1 }, ctx);
    expect(out).toMatch(/bash:|Command failed|killed|timed? ?out/i);
  });
});
