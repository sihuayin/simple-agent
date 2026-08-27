import { promises as fs } from "node:fs";
import path from "node:path";

import { ToolExecutionError, type ToolEntry } from "./types.js";
import { resolveInWorkspace, walkFiles } from "./workspace.js";

export const listFilesTool: ToolEntry = {
  name: "list_files",
  description:
    "List the entries in a directory. Non-recursive by default; set recursive to true to traverse subdirectories. Directories are shown with a trailing slash. Use it to get an overview before reading.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list (default: workspace root)." },
      recursive: { type: "boolean", description: "List subdirectories recursively (default false)." },
    },
    required: [],
  },
  async execute(input, ctx) {
    const base = input.path ? resolveInWorkspace(ctx.workspace, String(input.path)) : ctx.workspace;
    let stat;
    try {
      stat = await fs.stat(base);
    } catch {
      throw new ToolExecutionError(`list_files: no such path: ${input.path ?? "."}`);
    }

    if (stat.isFile()) {
      return path.relative(ctx.workspace, base).split(path.sep).join("/");
    }

    const relBase = path.relative(ctx.workspace, base);
    const prefix = relBase === "" ? "" : relBase.split(path.sep).join("/") + "/";

    const entries = await fs.readdir(base, { withFileTypes: true });
    if (!input.recursive) {
      const lines = entries
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      return lines.length ? lines.map((l) => prefix + l).join("\n") : `list_files: nothing under ${input.path ?? "."}`;
    }

    const lines: string[] = [];
    for await (const f of walkFiles(base)) {
      lines.push((path.relative(ctx.workspace, f)).split(path.sep).join("/"));
    }
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) dirs.push(prefix + e.name + "/");
    }
    return [...dirs.sort(), ...lines.sort()].join("\n");
  },
};
