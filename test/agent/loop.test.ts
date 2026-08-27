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
    info: { id: "deepseek", name: "DeepSeek", defaultModel: "deepseek-v4-flash", keyEnvVar: "DEEPSEEK_API_KEY", modelEnvVar: "DEEPSEEK_MODEL", baseUrlEnvVar: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com" },
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
      toolUseRaw("bash", "c9", { command: "yes a | head -c 9000" }),
      finalRaw("done"),
    ]);
    await runAgent({ adapter, model: "m", userPrompt: "go", tools: toolSpecs(), toolContext: ctx });
    const toolMsg = adapter.chats[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toContain("[TOOL_RESULT_TRUNCATED");
    expect(toolMsg.content.length).toBeLessThan(9000);
  });
});
