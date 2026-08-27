import { readFileSync } from "node:fs";
import { stdin } from "node:process";
import readline from "node:readline/promises";

import { PROVIDERS } from "./adapters/providers.js";
import type { ConversationResult } from "./adapters/types.js";

export interface CliArgs {
  prompt: string | undefined;
  provider: string | undefined;
  model: string | undefined;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: undefined,
    provider: undefined,
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
    else if (arg === "--provider") {
      const value = argv[++i];
      if (!value) throw new CliUsageError("--provider requires a value");
      args.provider = value;
    } else if (arg.startsWith("--provider=")) {
      args.provider = arg.slice("--provider=".length);
    } else if (arg === "--model") {
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

  args.prompt = positionals.length > 0 ? positionals.join(" ") : undefined;
  return args;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
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
  return `simple-agent — one-shot LLM conversation

Usage:
  simple-agent [options] [prompt]
  echo "..." | simple-agent [options]

Options:
  --provider <id>  Provider: ${Object.keys(PROVIDERS).join(" | ")} (default: $LLM_PROVIDER or ${PROVIDERS.deepseek.id})
  --model <name>   Model (default: $<PROVIDER>_MODEL or the provider's default, e.g. ${PROVIDERS.deepseek.defaultModel})
  --verbose        Print model, iterations, and tool-call count to stderr
  -h, --help       Show this help
  --version        Print the version

Tools (always available — the model decides whether to call them):
  read_file, write_file, edit_file, grep, glob, bash, list_files

Environment:
  DEEPSEEK_API_KEY        required for provider "deepseek" (or put it in .env)
  ANTHROPIC_API_KEY       required for provider "claude" (or put it in .env)
  LLM_PROVIDER            default provider
  DEEPSEEK_MODEL          default model for deepseek
  ANTHROPIC_MODEL         default model for claude
  DEEPSEEK_BASE_URL       API base URL for deepseek
  ANTHROPIC_BASE_URL      API base URL for claude
`;
}

export function versionText(): string {
  const pkg = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  return pkg.version;
}
