import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DeepseekRaw, NormalizedMessage, ProviderAdapter } from "../../src/adapters/types.js";
import { runAgent } from "../../src/agent/loop.js";
import { toolSpecs } from "../../src/tools/registry.js";
import type { ToolContext } from "../../src/tools/types.js";

let root: string;
let ctx: ToolContext;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sa-agent-"));
  await fs.writeFile(path.join(root, "greet.txt"), "hello from greet.txt");
  // 大文件：工具结果会被截断到 8000 字符（约 2000 token），用于预算测试
  await fs.writeFile(
    path.join(root, "big.txt"),
    Array.from({ length: 400 }, (_, i) => `line ${String(i).padStart(4, "0")} ${i}-padding-padding-padding-padding-padding-padding`).join("\n"),
  );
  ctx = { workspace: root, cwd: root, env: process.env };
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function toolUseRaw(name: string, id: string, input: unknown): DeepseekRaw {
  return {
    model: "deepseek-v4-flash",
    choices: [
      {
        message: {
          content: null,
          tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }],
        },
      },
    ],
  };
}

function finalRaw(text: string): DeepseekRaw {
  return { model: "deepseek-v4-flash", choices: [{ message: { content: text } }] };
}

function fakeAdapter(script: DeepseekRaw[]): ProviderAdapter & { chats: NormalizedMessage[][] } {
  const calls: NormalizedMessage[][] = [];
  return {
    info: { id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-v4-flash", keyEnvVar: "DEEPSEEK_API_KEY", modelEnvVar: "DEEPSEEK_MODEL", baseUrlEnvVar: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com", contextWindow: 20000 },
    async chat(input) {
      calls.push(input.messages);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      return next;
    },
    chats: calls,
  };
}

describe("runAgent", () => {
  it("executes requested tools, feeds results back, and stops on a final answer", async () => {
    const adapter = fakeAdapter([
      toolUseRaw("read_file", "c1", { path: "greet.txt" }),
      finalRaw("The file says: hello from greet.txt"),
    ]);

    const result = await runAgent({
      adapter,
      model: "deepseek-v4-flash",
      userPrompt: "what's in greet.txt?",
      tools: toolSpecs(),
      toolContext: ctx,
    });

    // Second API call must include the tool result (real file content).
    const secondMessages = adapter.chats[1]!;
    expect(secondMessages.some((m) =>
      m.role === "tool" && m.content.includes("hello from greet.txt"),
    )).toBe(true);
    expect(adapter.chats[0]!.some((m) => m.role === "user" && m.content.includes("greet.txt"))).toBe(true);
    expect(result.text).toBe("The file says: hello from greet.txt");
    expect(result.iterations).toBe(2);
    expect(result.toolCallsMade).toBe(1);
    expect(result.aborted).toBe(false);
  });

  it("feeds an unknown tool name back as an error result", async () => {
    const adapter = fakeAdapter([
      { model: "m", choices: [{ message: { content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "nope", arguments: "{}" } }] } }] },
      finalRaw("recovered"),
    ]);
    const result = await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx });
    const second = adapter.chats[1]!;
    expect(second.some((m) => m.role === "tool" && m.content.includes("Unknown tool: nope"))).toBe(true);
    expect(result.text).toBe("recovered");
  });

  it("aborts when the iteration cap is hit, without executing the extra round", async () => {
    const adapter = fakeAdapter([
      toolUseRaw("list_files", "c1", {}),
      toolUseRaw("list_files", "c2", {}),
      toolUseRaw("list_files", "c3", {}),
    ]);
    const result = await runAgent({
      adapter,
      model: "m",
      userPrompt: "go",
      tools: toolSpecs(),
      toolContext: ctx,
      maxIterations: 2,
    });
    expect(result.aborted).toBe(true);
    expect(result.toolCallsMade).toBe(2); // only rounds within the cap executed
  });

  it("returns immediately when the model answers without calling tools", async () => {
    const adapter = fakeAdapter([finalRaw("42")]);
    const result = await runAgent({ adapter, model: "m", userPrompt: "what is 6*7?", tools: toolSpecs(), toolContext: ctx });
    expect(result.text).toBe("42");
    expect(result.iterations).toBe(1);
    expect(result.toolCallsMade).toBe(0);
    expect(result.aborted).toBe(false);
    expect(adapter.chats).toHaveLength(1);
  });

  it("honors the system prompt as the first message", async () => {
    const adapter = fakeAdapter([finalRaw("ok")]);
    await runAgent({
      adapter,
      model: "m",
      systemPrompt: "you are a coding agent",
      userPrompt: "go",
      tools: [],
      toolContext: ctx,
    });
    expect(adapter.chats[0]![0]).toEqual({ role: "system", content: "you are a coding agent" });
  });

  it("truncates oversized tool results with a marker", async () => {
    const adapter = fakeAdapter([
      toolUseRaw("read_file", "c9", { path: "big.txt" }),
      finalRaw("done"),
    ]);
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("[TOOL_RESULT_TRUNCATED");
    expect(toolMsg.content.length).toBeLessThan(9000);
  });

  it("auto-compacts when the estimate crosses the budget threshold", async () => {
    const adapter = fakeAdapter([
      toolUseRaw("read_file", "c1", { path: "big.txt" }),
      toolUseRaw("read_file", "c2", { path: "big.txt" }),
      finalRaw("done"),
    ]);
    const summarizer = vi.fn(async () => "SUM-1");
    const result = await runAgent({
      adapter,
      model: "m",
      userPrompt: "go",
      tools: toolSpecs(),
      toolContext: ctx,
      budgetConfig: { contextWindow: 4000, keepRounds: 1 },
      summarizer,
    });
    const lastChat = adapter.chats[2]!;
    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(lastChat.some((m) => m.role === "user" && m.content.startsWith("[对话摘要] SUM-1"))).toBe(true);
    // 第 1 轮的工具结果已不在发送内容里（只剩第 2 轮的）
    expect(lastChat.filter((m) => m.role === "tool")).toHaveLength(1);
    expect(result.compactions).toBe(1);
  });

  it("compacts on drift when the last actual usage crossed the threshold", async () => {
    const bigUsage: DeepseekRaw = {
      model: "m",
      choices: [{ message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "list_files", arguments: "{}" } }] } }],
      usage: { prompt_tokens: 4000, completion_tokens: 1, total_tokens: 4001 },
    };
    const adapter = fakeAdapter([
      bigUsage,
      toolUseRaw("list_files", "c2", {}),
      finalRaw("done"),
    ]);
    const result = await runAgent({
      adapter,
      model: "m",
      userPrompt: "go",
      tools: toolSpecs(),
      toolContext: ctx,
      budgetConfig: { contextWindow: 4000, keepRounds: 1 },
      summarizer: async () => "DRIFT-SUM",
    });
    const lastChat = adapter.chats[2]!;
    expect(lastChat.some((m) => m.role === "user" && m.content.startsWith("[对话摘要] DRIFT-SUM"))).toBe(true);
    expect(result.compactions).toBe(1);
  });

  it("blocks a denied tool call and feeds the denial message back", async () => {
    const adapter = fakeAdapter([
      toolUseRaw("bash", "c1", { command: "rm -rf /" }),
      finalRaw("done"),
    ]);
    const result = await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("[permission denied]");
    expect(toolMsg.content).toContain("rm -rf /");
    expect(result.toolCallsMade).toBe(1); // 工具被评估，但未执行
  });

  it("executes an ask decision when the human confirms", async () => {
    const adapter = fakeAdapter([
      toolUseRaw("write_file", "c1", { path: "new-file.txt", content: "hi" }),
      finalRaw("done"),
    ]);
    const ask = vi.fn(async () => true);
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx, ask });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(ask).toHaveBeenCalledTimes(1);
    expect(toolMsg.content).toContain("wrote"); // 确实执行了
    expect(await fs.readFile(path.join(root, "new-file.txt"), "utf8")).toBe("hi");
  });

  it("does not execute an ask decision when the human rejects", async () => {
    const adapter = fakeAdapter([
      toolUseRaw("write_file", "c1", { path: "rejected.txt", content: "x" }),
      finalRaw("done"),
    ]);
    const ask = vi.fn(async () => false);
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx, ask });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("[permission denied by user]");
    await expect(fs.readFile(path.join(root, "rejected.txt"))).rejects.toThrow();
  });

  it("asks before an allow-rule hit when the path is protected", async () => {
    const adapter = fakeAdapter([
      toolUseRaw("read_file", "c1", { path: ".env" }),
      finalRaw("done"),
    ]);
    const ask = vi.fn(async () => false);
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx, ask });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("[permission denied by user]");
  });

  it("loads custom rules from the workspace .rules file", async () => {
    await fs.writeFile(path.join(root, ".rules"), JSON.stringify([{ tool: "bash", pattern: "echo *", action: "deny" }]));
    try {
      const adapter = fakeAdapter([
        toolUseRaw("bash", "c1", { command: "echo hi" }),
        finalRaw("done"),
      ]);
      await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx });
      const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
      expect(toolMsg.content).toContain("[permission denied]");
    } finally {
      await fs.rm(path.join(root, ".rules"), { force: true });
    }
  });

  it("force-compacts on /compact even below the threshold", async () => {
    const adapter = fakeAdapter([
      toolUseRaw("list_files", "c1", {}),
      toolUseRaw("list_files", "c2", {}),
      finalRaw("done"),
    ]);
    const result = await runAgent({
      adapter,
      model: "m",
      userPrompt: "go",
      tools: toolSpecs(),
      toolContext: ctx,
      budgetConfig: { contextWindow: 4000, keepRounds: 1 },
      forceCompact: true,
      summarizer: async () => "FORCED-SUM",
    });
    const lastChat = adapter.chats[2]!;
    expect(lastChat.some((m) => m.role === "user" && m.content.startsWith("[对话摘要] FORCED-SUM"))).toBe(true);
    expect(result.compactions).toBe(1);
  });
});
