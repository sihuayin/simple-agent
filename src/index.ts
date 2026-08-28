#!/usr/bin/env node
import "dotenv/config";

import { createAdapter, MissingApiKeyError } from "./adapters/client.js";
import { resolveModel, resolveProvider, UnknownProviderError } from "./adapters/resolve.js";
import { runAgent } from "./agent/loop.js";
import { buildSystemPrompt } from "./agent/system_prompt.js";
import { extractCompactCommand } from "./agent/budget.js";
import {
  CliUsageError,
  helpText,
  parseArgs,
  readPrompt,
  versionText,
} from "./cli.js";
import { toolSpecs } from "./tools/registry.js";
import { Spinner } from "./spinner.js";
import { forget, loadForSession, loadMemoryStore, saveMemoryStore } from "./agent/memory.js";
import { loadMcpConfig } from "./mcp/config.js";
import { McpManager } from "./mcp/client.js";

const TYPE_CN = { user: "用户偏好", project: "项目约定", feedback: "反馈纠正" } as const;

async function memoryCommand(workspace: string, forgetId?: string): Promise<boolean> {
  if (forgetId) {
    const store = await loadMemoryStore(workspace);
    const target = store.memories.find((m) => m.id === forgetId);
    if (!target) {
      process.stderr.write(`未找到记忆 id：${forgetId}\n`);
      return false;
    }
    await saveMemoryStore(forget(store, forgetId), workspace);
    process.stdout.write(`已忘记：${target.text}\n`);
    return true;
  }
  const store = await loadMemoryStore(workspace);
  const { injected, dropped } = loadForSession(store, workspace);
  if (store.memories.length === 0) {
    process.stdout.write("（没有记忆——agent 会在会话中通过 remember 工具自动积累）\n");
    return true;
  }
  for (const m of store.memories) {
    const where = m.scope === "global" ? "全局" : "本项目";
    process.stdout.write(`${m.id}\t[${TYPE_CN[m.type]}] ${m.text}（${where}，v${m.version}）\n`);
  }
  const notLoaded = dropped.map((m) => m.text).join("；");
  if (notLoaded) process.stderr.write(`本次会话不会加载（其他项目的记忆）：${notLoaded}\n`);
  if (injected.length === 0 && store.memories.length > 0) process.stderr.write("（本项目的记忆将在下次会话自动注入系统提示词）\n");
  return true;
}

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
  if (args.memory || args.memoryForget) {
    process.exitCode = (await memoryCommand(process.cwd(), args.memoryForget)) ? 0 : 1;
    return;
  }

  const provider = resolveProvider(args.provider);
  const adapter = createAdapter(provider);
  const model = resolveModel(provider, args.model);

  const prompt = await readPrompt(args.prompt);
  const { compact: forceCompact, rest: cleanPrompt } = extractCompactCommand(prompt);
  if (!cleanPrompt.trim()) {
    process.stderr.write("No prompt given.\n\n");
    process.stderr.write(helpText());
    process.exitCode = 2;
    return;
  }

  // Tools are always available; the model decides whether to call them.
  // When it doesn't, this is exactly a one-shot conversation.
  // Streaming by default: live text + a spinner while waiting.
  // --no-stream restores one-shot behavior (final answer printed once).
  const spinner = new Spinner("工作中…");
  // 记忆：历史会话注入本次提示词；本次会话记住的，下次生效
  const workspace = process.cwd();
  const memoryStore = await loadMemoryStore(workspace);
  const { injected } = loadForSession(memoryStore, workspace);
  if (args.verbose && injected.length > 0) {
    process.stderr.write(`[memory=${injected.length} loaded]\n`);
  }

  // MCP：.mcp.json 声明外部工具服务器；连接失败只跳过该服务器（stderr 警告），会话继续
  const mcp = new McpManager(await loadMcpConfig(workspace));
  const { connected, failed: mcpFailed } = await mcp.connectAll();
  const mcpTools = mcp.getToolEntries();
  for (const f of mcpFailed) {
    process.stderr.write(`[mcp] 服务器 "${f.name}" 连接失败，已跳过：${f.error}\n`);
  }
  if (args.verbose && (connected.length > 0 || mcpFailed.length > 0)) {
    process.stderr.write(`[mcp=${connected.length}/${connected.length + mcpFailed.length} servers, ${mcpTools.length} tools${mcpFailed.length > 0 ? `, ${mcpFailed.length} failed` : ""}]\n`);
  }

  spinner.start();
  try {
    const result = await runAgent({
      adapter,
      model,
      systemPrompt: await buildSystemPrompt(workspace, injected),
      userPrompt: cleanPrompt,
      forceCompact,
      tools: [...toolSpecs(), ...mcpTools],
      mcpTools,
      toolContext: { workspace, cwd: workspace, env: process.env },
      onText: args.noStream ? undefined : (t) => process.stdout.write(t),
      onPhase: (phase) => {
        if (phase === "waiting") spinner.start();
        else if (phase === "streaming" || phase === "done") spinner.stop();
      },
    });
    spinner.stop();
    if (args.noStream) {
      process.stdout.write(`${result.text}\n`);
    } else {
      process.stdout.write("\n"); // 流式文本末尾补换行
    }
    if (result.aborted) {
      process.stderr.write("Aborted: the model kept requesting tools past the iteration cap.\n");
      process.exitCode = 1;
    } else if (args.verbose) {
      process.stderr.write(
        `[provider=${provider} model=${result.model} iterations=${result.iterations} toolCalls=${result.toolCallsMade} compacted=${result.compactions}]\n`,
      );
    }
  } finally {
    await mcp.closeAll();
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
