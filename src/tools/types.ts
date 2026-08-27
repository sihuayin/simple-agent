import type { ToolSpec } from "../adapters/types.js";

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

/** What a tool needs to do its job in the real CLI. */
export interface ToolContext {
  /** Root directory that file tools are confined to. */
  workspace: string;
  /** Working directory for bash. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** A tool as the model sees it (spec) plus its implementation. */
export interface ToolEntry extends ToolSpec {
  execute(input: Record<string, unknown>, ctx: ToolContext): string | Promise<string>;
}
