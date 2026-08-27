import { exec } from "node:child_process";

import { ToolExecutionError, type ToolEntry } from "./types.js";

const OUTPUT_CAP = 8000;

/** NOTE: no sandbox by design — bash safety policy is a later requirement. */
export const bashTool: ToolEntry = {
  name: "bash",
  description:
    "Execute a shell command in the workspace directory and return its stdout/stderr. Commands are checked by a security policy: destructive commands (rm -rf /, dd, download-and-run) are blocked, and risky commands or file writes require human confirmation — if a call comes back as [permission denied] or [permission required], do not rephrase and retry; explain the need in your final answer instead. Prefer the purpose-built tools (read_file, grep, glob, list_files) for file operations. Output is capped at 8000 characters.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run." },
      timeoutSeconds: { type: "number", description: "Timeout in seconds (default 30)." },
    },
    required: ["command"],
  },
  async execute(input, ctx) {
    const command = String(input.command ?? "");
    if (!command.trim()) throw new ToolExecutionError("bash: missing required parameter: command");
    const timeoutSeconds = typeof input.timeoutSeconds === "number" ? input.timeoutSeconds : 30;

    return new Promise((resolve) => {
      exec(
        command,
        {
          cwd: ctx.cwd,
          timeout: timeoutSeconds * 1000,
          maxBuffer: 8 * 1024 * 1024,
          env: ctx.env as Record<string, string>,
        },
        (err, stdout, stderr) => {
          let out = stdout;
          if (stderr) out += (out ? "\n" : "") + stderr.trimEnd();
          if (err && !out.trim()) out = `bash: ${err.message}`;
          if (out.length > OUTPUT_CAP) {
            out = out.slice(0, OUTPUT_CAP) + `\n[OUTPUT_TRUNCATED — ${out.length} chars]`;
          }
          resolve(out);
        },
      );
    });
  },
};
