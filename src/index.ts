#!/usr/bin/env node
import "dotenv/config";

import { createAdapter, MissingApiKeyError } from "./adapters/client.js";
import { resolveModel, resolveProvider, UnknownProviderError } from "./adapters/resolve.js";
import { runAgent } from "./agent/loop.js";
import { buildSystemPrompt } from "./agent/system_prompt.js";
import {
  CliUsageError,
  helpText,
  parseArgs,
  readPrompt,
  versionText,
} from "./cli.js";
import { toolSpecs } from "./tools/registry.js";

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

  // Tools are always available; the model decides whether to call them.
  // When it doesn't, this is exactly a one-shot conversation.
  const result = await runAgent({
    adapter,
    model,
    systemPrompt: await buildSystemPrompt(process.cwd()),
    userPrompt: prompt,
    tools: toolSpecs(),
    toolContext: { workspace: process.cwd(), cwd: process.cwd(), env: process.env },
  });
  process.stdout.write(`${result.text}\n`);
  if (result.aborted) {
    process.stderr.write("Aborted: the model kept requesting tools past the iteration cap.\n");
    process.exitCode = 1;
  } else if (args.verbose) {
    process.stderr.write(
      `[provider=${provider} model=${result.model} iterations=${result.iterations} toolCalls=${result.toolCallsMade}]\n`,
    );
  }
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
