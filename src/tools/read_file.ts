import { promises as fs } from "node:fs";

import { ToolExecutionError, type ToolEntry } from "./types.js";
import { resolveInWorkspace } from "./workspace.js";

const DEFAULT_MAX_LINES = 200;
const MAX_MAX_LINES = 1000;

/**
 * Slice content by lines. When more remains, append a [TRUNCATED] marker
 * telling the model the next offset to continue from — this is how long
 * files are read across multiple calls.
 */
export function readChunk(content: string, offset: number, maxLines: number): string {
  const lines = content.split("\n");
  const start = Math.max(0, offset - 1);
  const chunk = lines.slice(start, start + maxLines);
  const hasMore = start + chunk.length < lines.length;
  const nextOffset = start + chunk.length + 1;
  const text = chunk.join("\n");
  return hasMore
    ? `${text}\n[TRUNCATED — ${lines.length} lines total; continue with offset=${nextOffset}]`
    : text;
}

export const readFileTool: ToolEntry = {
  name: "read_file",
  description:
    'Read a text file from the workspace. Control response length: pass maxLines to cap each read and offset to continue from a later line; when the result contains the [TRUNCATED] marker, call again with the suggested offset to read the next chunk. Prefer this over bash cat for reading.',
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: 'File path relative to the workspace root, e.g. "src/app.ts".' },
      offset: { type: "number", description: "1-based line to start reading from (default 1)." },
      maxLines: { type: "number", description: "Maximum lines to return in this call (default 200, max 1000)." },
    },
    required: ["path"],
  },
  async execute(input, ctx) {
    const p = String(input.path ?? "");
    if (!p) throw new ToolExecutionError("read_file: missing required parameter: path");
    const abs = resolveInWorkspace(ctx.workspace, p);
    let content: string;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (e) {
      throw new ToolExecutionError(`read_file: ${(e as Error).message}`);
    }
    const offset = typeof input.offset === "number" ? input.offset : 1;
    const maxLines = Math.min(
      typeof input.maxLines === "number" ? input.maxLines : DEFAULT_MAX_LINES,
      MAX_MAX_LINES,
    );
    return readChunk(content, offset, maxLines);
  },
};
