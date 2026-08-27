#!/usr/bin/env node
import "dotenv/config";

import { createAdapter, MissingApiKeyError } from "./adapters/client.js";
import { resolveModel, resolveProvider, UnknownProviderError } from "./adapters/resolve.js";
import {
  CliUsageError,
  formatResult,
  helpText,
  parseArgs,
  readPrompt,
  versionText,
} from "./cli.js";
import { runConversation } from "./conversation.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(helpText());
    return;
  }
  if (args.version) {
    process.stdout.write(`${versionText()}\n`);
    return;
  }

  const provider = resolveProvider(args.provider);
  const adapter = createAdapter(provider);
  const model = resolveModel(provider, args.model);

  const prompt = await readPrompt(args.prompt);
  if (!prompt.trim()) {
    process.stderr.write("No prompt given.\n\n");
    process.stderr.write(helpText());
    process.exitCode = 2;
    return;
  }

  const result = await runConversation({ adapter, model, prompt });
  const { stdout, stderr } = formatResult(result, { verbose: args.verbose });
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
}

main().catch((err: unknown) => {
  if (err instanceof CliUsageError || err instanceof UnknownProviderError) {
    process.stderr.write(`${err.message}\n\n`);
    process.stderr.write(helpText());
    process.exitCode = 2;
  } else if (err instanceof MissingApiKeyError) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  } else {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
});
