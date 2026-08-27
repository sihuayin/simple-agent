import { promises as fs } from "node:fs";
import path from "node:path";

import { ToolExecutionError, type ToolEntry } from "./types.js";
import { resolveInWorkspace, walkFiles } from "./workspace.js";

export const grepTool: ToolEntry = {
  name: "grep",
  description:
    "Search file contents for a regex pattern. Returns matching lines with file path and line number, capped at maxResults. Useful to locate where something is mentioned before reading the file.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "Directory or single file to search; defaults to the workspace root." },
      maxResults: { type: "number", description: "Maximum matches to return (default 50)." },
    },
    required: ["pattern"],
  },
  async execute(input, ctx) {
    let re: RegExp;
    try {
      re = new RegExp(String(input.pattern ?? ""));
    } catch (e) {
      throw new ToolExecutionError(`grep: invalid pattern: ${(e as Error).message}`);
    }
    const max = typeof input.maxResults === "number" ? input.maxResults : 50;
    const scope = input.path ? resolveInWorkspace(ctx.workspace, String(input.path)) : ctx.workspace;
    const results: string[] = [];

    let stat;
    try {
      stat = await fs.stat(scope);
    } catch {
      throw new ToolExecutionError(`grep: no such path: ${input.path ?? "."}`);
    }

    const targets: string[] = [];
    if (stat.isFile()) {
      targets.push(scope);
    } else {
      for await (const f of walkFiles(scope)) targets.push(f);
    }

    for (const file of targets) {
      let content: string;
      try {
        content = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const rel = path.relative(ctx.workspace, file);
      for (const [i, line] of content.split("\n").entries()) {
        if (results.length >= max) break;
        if (re.test(line)) results.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
      if (results.length >= max) break;
    }
    return results.length ? results.join("\n") : `grep: no matches for /${input.pattern}/`;
  },
};
