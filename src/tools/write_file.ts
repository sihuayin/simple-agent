import { promises as fs } from "node:fs";
import path from "node:path";

import { ToolExecutionError, type ToolEntry } from "./types.js";
import { resolveInWorkspace } from "./workspace.js";

export const writeFileTool: ToolEntry = {
  name: "write_file",
  description:
    "Create or overwrite a file with the given content. Overwrites existing files entirely — use edit_file for surgical changes. Returns a short confirmation.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      content: { type: "string", description: "Full new content of the file." },
    },
    required: ["path", "content"],
  },
  async execute(input, ctx) {
    const p = String(input.path ?? "");
    const content = String(input.content ?? "");
    if (!p) throw new ToolExecutionError("write_file: missing required parameter: path");
    const abs = resolveInWorkspace(ctx.workspace, p);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `write_file: wrote ${content.split("\n").length} line(s) to ${p}`;
  },
};
