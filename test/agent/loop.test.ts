import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { DeepseekRaw, NormalizedMessage, ProviderAdapter } from "../../src/adapters/types.js";
import type { StreamEvent } from "../../src/adapters/stream.js";
import { collectStream } from "../../src/adapters/stream.js";
import { runAgent } from "../../src/agent/loop.js";
import { DEFAULT_RULES } from "../../src/agent/policy.js";
import { toolSpecs } from "../../src/tools/registry.js";
import type { ToolContext, ToolEntry } from "../../src/tools/types.js";

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
      return collectStream(this.chatStream(input));
    },
    async *chatStream(input): AsyncGenerator<StreamEvent> {
      calls.push(input.messages);
      const next = script.shift();
      if (!next) throw new Error("script exhausted");
      yield { type: "done", raw: next };
    },
    chats: calls,
  };
}

/** 让 fake 像真实适配器一样先发 text 增量再 done（贴近流式现实）。 */
function withTextEvents(adapter: ProviderAdapter & { chats: NormalizedMessage[][] }): ProviderAdapter {
  const orig = adapter.chatStream.bind(adapter);
  adapter.chatStream = async function* (input) {
    for await (const e of orig(input)) {
      if (e.type === "done") {
        const content = (e.raw as DeepseekRaw).choices[0]?.message.content ?? "";
        if (content) yield { type: "text", text: content };
      }
      yield e;
    }
  };
  return adapter;
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

  it("streams text deltas to onText in order", async () => {
    const adapter = fakeAdapter([finalRaw("最终答案")]);
    const texts: string[] = [];
    // 覆盖 chatStream 为分段发送文本增量
    const streamy = adapter;
    const orig = streamy.chatStream.bind(streamy);
    (streamy as { chatStream: typeof orig }).chatStream = async function* (input) {
      for await (const e of orig(input)) {
        if (e.type === "done") {
          const raw = e.raw as DeepseekRaw;
          const content = raw.choices[0]?.message.content ?? "";
          yield { type: "text", text: content.slice(0, 2) };
          yield { type: "text", text: content.slice(2) };
          yield e;
        } else {
          yield e;
        }
      }
    };
    await runAgent({ adapter: streamy, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx, onText: (t) => texts.push(t) });
    expect(texts).toEqual(["最终", "答案"]);
  });

  it("emits waiting -> streaming -> done phases in order", async () => {
    const adapter = withTextEvents(fakeAdapter([finalRaw("hi")]));
    const phases: string[] = [];
    await runAgent({
      adapter,
      model: "m",
      userPrompt: "go",
      tools: toolSpecs(),
      toolContext: ctx,
      onText: () => undefined,
      onPhase: (p) => phases.push(p),
    });
    expect(phases).toEqual(["waiting", "streaming", "done"]);
  });

  it("emits waiting -> done (no streaming) for tool-call rounds", async () => {
    const adapter = withTextEvents(fakeAdapter([toolUseRaw("read_file", "c1", { path: "greet.txt" }), finalRaw("好了")]));
    const phases: string[] = [];
    const texts: string[] = [];
    await runAgent({
      adapter,
      model: "m",
      userPrompt: "go",
      tools: toolSpecs(),
      toolContext: ctx,
      onText: (t) => texts.push(t),
      onPhase: (p) => phases.push(p),
    });
    // 第一轮无文本（工具调用）；第二轮有文本
    expect(phases).toEqual(["waiting", "waiting", "streaming", "done"]);
    expect(texts).toEqual(["好了"]);
  });

  it("works without onText/onPhase (no-stream consumers)", async () => {
    const adapter = fakeAdapter([finalRaw("plain")]);
    const result = await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx });
    expect(result.text).toBe("plain");
  });

  it("PreToolUse hook blocks a call: tool not executed, model sees [hook blocked]", async () => {
    const adapter = fakeAdapter([toolUseRaw("read_file", "c1", { path: "definitely-missing-file.txt" }), finalRaw("done")]);
    const hooks = [{
      name: "guard", event: "PreToolUse" as const, matcher: "read_file",
      handler: { type: "command" as const, command: `node -e "const d=require('fs').readFileSync(0,'utf8');const c=JSON.parse(d);console.log(JSON.stringify({blocked:true,reason:'guard-no'}))"` },
    }];
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx, hooks });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("[hook blocked]");
    expect(toolMsg.content).toContain("guard-no");
    expect(toolMsg.content).not.toContain("ENOENT"); // 工具确实没执行（否则会读到不存在的文件报错）
  });

  it("PreToolUse modifiedParams rewrites the executed arguments", async () => {
    const adapter = fakeAdapter([toolUseRaw("read_file", "c1", { path: "x.txt" }), finalRaw("done")]);
    const hooks = [{
      name: "prefix", event: "PreToolUse" as const, matcher: "read_file",
      handler: { type: "command" as const, command: `node -e "const d=require('fs').readFileSync(0,'utf8');const c=JSON.parse(d);console.log(JSON.stringify({modifiedParams:{path:'greet.txt'}}))"` },
    }];
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx, hooks });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("[hook modified input]");
    expect(toolMsg.content).toContain("hello from greet.txt"); // 实际读的是被改后的路径
  });

  it("SessionStart and Stop fire; Stop carries the final text", async () => {
    const calls: { event: string; finalText?: string }[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as { event: string; finalText?: string });
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = fakeAdapter([finalRaw("final answer")]);
      const hooks = [
        { name: "init", event: "SessionStart" as const, handler: { type: "http" as const, url: "https://init.example" } },
        { name: "notify", event: "Stop" as const, handler: { type: "http" as const, url: "https://notify.example" } },
      ];
      await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx, hooks });
      const events = calls.map((c) => c.event);
      expect(events).toEqual(["SessionStart", "Stop"]);
      expect(calls[1]!.finalText).toBe("final answer");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("PostToolUse fires after execution with the result", async () => {
    const calls: { event: string; result?: string; tool?: string }[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)) as { event: string; result?: string; tool?: string });
      return { ok: true, status: 200, text: async () => "{}" } as Response;
    }) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    try {
      const adapter = fakeAdapter([toolUseRaw("read_file", "c1", { path: "greet.txt" }), finalRaw("done")]);
      const hooks = [{ name: "lint", event: "PostToolUse" as const, matcher: "read_file", handler: { type: "http" as const, url: "https://lint.example" } }];
      await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx, hooks });
      const post = calls.find((c) => c.event === "PostToolUse")!;
      expect(post.tool).toBe("read_file");
      expect(post.result).toContain("hello from greet.txt");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("mcpTools: model calls mcp_<server>_<tool>, routed through policy + execute", async () => {
    const adapter = fakeAdapter([toolUseRaw("mcp_fixture_echo", "c1", { text: "hi" }), finalRaw("done")]);
    const mcpEntry: ToolEntry = {
      name: "mcp_fixture_echo",
      description: '[MCP 服务器 "fixture"] 回显',
      parameters: { type: "object", properties: { text: { type: "string" } } },
      execute: async (input) => `echo:${JSON.stringify(input)}`,
    };
    const policy = { rules: [...DEFAULT_RULES, { tool: "mcp_fixture_*", action: "allow" as const }], protectedPaths: [] };
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), mcpTools: [mcpEntry], toolContext: ctx, policy });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toBe('echo:{"text":"hi"}');
  });

  it("mcpTools: default fallback is ask — non-TTY rejects (black-box default)", async () => {
    const adapter = fakeAdapter([toolUseRaw("mcp_shell_execute", "c1", { command: "id" }), finalRaw("done")]);
    const mcpEntry: ToolEntry = {
      name: "mcp_shell_execute",
      description: '[MCP 服务器 "shell"] 执行命令',
      parameters: { type: "object" },
      execute: async () => "ran",
    };
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), mcpTools: [mcpEntry], toolContext: ctx });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("[permission denied by user]"); // 兜底 ask → 非 TTY 自动拒
    expect(toolMsg.content).toContain("mcp_shell_execute");
  });

  it("mcpTools: ask-confirmed executes (hooks still apply)", async () => {
    const adapter = fakeAdapter([toolUseRaw("mcp_shell_execute", "c1", { command: "id" }), finalRaw("done")]);
    const mcpEntry: ToolEntry = {
      name: "mcp_shell_execute",
      description: '[MCP 服务器 "shell"] 执行命令',
      parameters: { type: "object" },
      execute: async () => "ran",
    };
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), mcpTools: [mcpEntry], toolContext: ctx, ask: async () => true });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toBe("ran");
  });

  it("mcpTools: hook matcher mcp_fixture_* intercepts the call", async () => {
    const adapter = fakeAdapter([toolUseRaw("mcp_fixture_echo", "c1", { text: "hi" }), finalRaw("done")]);
    const mcpEntry: ToolEntry = {
      name: "mcp_fixture_echo",
      description: '[MCP 服务器 "fixture"] 回显',
      parameters: { type: "object" },
      execute: async () => "echo:hi",
    };
    const policy = { rules: [...DEFAULT_RULES, { tool: "mcp_fixture_*", action: "allow" as const }], protectedPaths: [] };
    const hooks = [{
      name: "mcp-guard", event: "PreToolUse" as const, matcher: "mcp_fixture_*",
      handler: { type: "command" as const, command: `node -e "const d=require('fs').readFileSync(0,'utf8');const c=JSON.parse(d);console.log(JSON.stringify({blocked:true,reason:'mcp-guard-no'}))"` },
    }];
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), mcpTools: [mcpEntry], toolContext: ctx, policy, hooks });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("[hook blocked]");
    expect(toolMsg.content).toContain("mcp-guard-no");
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
