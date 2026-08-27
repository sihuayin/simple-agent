import { bashTool } from "./bash.js";
import { editFileTool } from "./edit_file.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listFilesTool } from "./list_files.js";
import { readFileTool } from "./read_file.js";
import type { ToolEntry } from "./types.js";
import { writeFileTool } from "./write_file.js";

/** The tool registry: the single place tools are declared for the model. */
export const TOOLS: Record<string, ToolEntry> = {
  read_file: readFileTool,
  write_file: writeFileTool,
  edit_file: editFileTool,
  grep: grepTool,
  glob: globTool,
  bash: bashTool,
  list_files: listFilesTool,
};

/** Tool specs (name/description/parameters) to advertise to the model. */
export function toolSpecs(): { name: string; description: string; parameters: Record<string, unknown> }[] {
  return Object.values(TOOLS).map(({ execute: _execute, ...spec }) => spec);
}
