import { promises as fs } from "node:fs";

import { ToolExecutionError, type ToolEntry } from "./types.js";
import { resolveInWorkspace } from "./workspace.js";

export const editFileTool: ToolEntry = {
  name: "edit_file",
  description:
    "Make precise edits to a file by replacing exact text. Provide one or more edits; each oldText must match exactly (a unique region) in the file, otherwise the whole call fails and no edit is applied. Prefer the smallest oldText that captures your intent.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path relative to the workspace root." },
      edits: {
        type: "array",
        items: {
          type: "object",
          properties: {
            oldText: { type: "string", description: "Exact existing text to replace (must match exactly)." },
            newText: { type: "string", description: "Replacement text." },
          },
          required: ["oldText", "newText"],
        },
      },
    },
    required: ["path", "edits"],
  },
  async execute(input, ctx) {
    const p = String(input.path ?? "");
    const edits = Array.isArray(input.edits) ? input.edits : [];
    if (!p) throw new ToolExecutionError("edit_file: missing required parameter: path");
    if (edits.length === 0) throw new ToolExecutionError("edit_file: no edits provided");
    const abs = resolveInWorkspace(ctx.workspace, p);
    let text: string;
    try {
      text = await fs.readFile(abs, "utf8");
    } catch (e) {
      throw new ToolExecutionError(`edit_file: ${(e as Error).message}`);
    }
    for (const e of edits) {
      const oldText = String((e as Record<string, unknown>).oldText ?? "");
      const newText = String((e as Record<string, unknown>).newText ?? "");
      const idx = text.indexOf(oldText);
      if (idx === -1) {
        throw new ToolExecutionError(`edit_file: oldText not found in ${p}: ${JSON.stringify(oldText)}`);
      }
      text = text.slice(0, idx) + newText + text.slice(idx + oldText.length);
    }
    await fs.writeFile(abs, text, "utf8");
    return `edit_file: applied ${edits.length} edit(s) to ${p}`;
  },
};
