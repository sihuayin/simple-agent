import { promises as fs } from "node:fs";
import path from "node:path";

import { ToolExecutionError } from "./types.js";

/** Resolve a tool-supplied path and forbid escaping the workspace root. */
export function resolveInWorkspace(workspace: string, p: string): string {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, p);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new ToolExecutionError(`path escapes the workspace: ${p}`);
  }
  return abs;
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", "coverage"]);

/** Walk files under a directory, skipping common generated/vendor dirs. */
export async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}
