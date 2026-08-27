import path from "node:path";

import { ToolExecutionError, type ToolEntry } from "./types.js";
import { walkFiles } from "./workspace.js";

/** Minimal glob: `**` crosses directories, `*` matches within a segment. */
export function globToRegex(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((seg) =>
      seg === "**"
        ? ".*"
        : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"),
    )
    .join("/");
  return new RegExp(`^${source}$`);
}

export const globTool: ToolEntry = {
  name: "glob",
  description:
    'Find file paths matching a glob pattern (e.g. "src/**/*.ts"). Returns matching paths, one per line. Use it to locate files before read_file.',
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, relative to the workspace root. Supports * and **." },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    const pattern = String(input.pattern ?? "");
    if (!pattern) throw new ToolExecutionError("glob: missing required parameter: pattern");
    let re: RegExp;
    try {
      re = globToRegex(pattern);
    } catch (e) {
      throw new ToolExecutionError(`glob: invalid pattern: ${(e as Error).message}`);
    }
    const hits: string[] = [];
    for await (const f of walkFiles(ctx.workspace)) {
      const rel = path.relative(ctx.workspace, f).split(path.sep).join("/");
      if (re.test(rel)) hits.push(rel);
    }
    return hits.length ? hits.join("\n") : `glob: no files match ${pattern}`;
  },
};
