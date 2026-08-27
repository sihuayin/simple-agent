import { readFileSync } from "node:fs";
import { stdin } from "node:process";
import readline from "node:readline/promises";

import { DEFAULT_MODEL } from "./config.js";
import type { ConversationResult } from "./conversation.js";

export interface CliArgs {
  prompt: string | undefined;
  model: string | undefined;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: undefined,
    model: undefined,
    verbose: false,
    help: false,
    version: false,
  };
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--version") args.version = true;
    else if (arg === "--verbose") args.verbose = true;
    else if (arg === "--model") {
      const value = argv[++i];
      if (!value) throw new CliUsageError("--model requires a value");
      args.model = value;
    } else if (arg.startsWith("--model=")) {
      args.model = arg.slice("--model=".length);
    } else if (arg.startsWith("-")) {
      throw new CliUsageError(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  args.prompt = positionals.join(" ");
  return args;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

/** Precedence: --model flag > DEEPSEEK_MODEL env > built-in default. */
export function resolveModel(
  flag: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return flag ?? env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;
}

/** Positional prompt first; else piped stdin; else an interactive TTY prompt. */
export async function readPrompt(
  positional: string | undefined,
): Promise<string> {
  if (positional !== undefined) return positional;
  if (!stdin.isTTY) {
    return (await readStdin()).trimEnd();
  }
  const rl = readline.createInterface({ input: stdin, output: process.stdout });
  try {
    const answer = await rl.question("Prompt: ");
    return answer;
  } finally {
    rl.close();
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk: string) => (data += chunk));
    stdin.on("end", () => resolve(data));
    stdin.on("error", reject);
  });
}

/** Pure formatting so tests can assert on what gets printed. */
export function formatResult(
  result: ConversationResult,
  options: { verbose: boolean },
): { stdout: string; stderr: string | null } {
  const stdout = `${result.content ?? ""}\n`;

  let stderr: string | null = null;
  if (options.verbose) {
    const parts = [`model=${result.model}`];
    const usage = result.usage;
    if (usage) {
      parts.push(
        `prompt=${usage.promptTokens}`,
        `completion=${usage.completionTokens}`,
        `total=${usage.totalTokens}`,
      );
    }
    stderr = `[${parts.join(" ")}]\n`;
  }

  return { stdout, stderr };
}

export function helpText(): string {
  return `simple-agent — one-shot DeepSeek conversation

Usage:
  simple-agent [options] [prompt]
  echo "..." | simple-agent [options]

Options:
  --model <name>   Model to use (default: $DEEPSEEK_MODEL or ${DEFAULT_MODEL})
  --verbose        Print model and token usage to stderr
  -h, --help       Show this help
  --version        Print the version

Environment:
  DEEPSEEK_API_KEY    required — API key (or put it in .env)
  DEEPSEEK_MODEL      default model
  DEEPSEEK_BASE_URL   API base URL (default: https://api.deepseek.com)
`;
}

export function versionText(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}
