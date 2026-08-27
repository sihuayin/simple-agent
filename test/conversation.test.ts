import { describe, expect, it, vi } from "vitest";

import { PROVIDERS } from "../src/adapters/providers.js";
import type { DeepseekRaw, ProviderAdapter } from "../src/adapters/types.js";
import { formatResult } from "../src/cli.js";
import { runConversation } from "../src/conversation.js";

function fakeAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    info: PROVIDERS.deepseek,
    chat: vi.fn(async (): Promise<DeepseekRaw> => ({
      model: "deepseek-v4-flash",
      choices: [{ message: { content: "Hello, world!" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    })),
    ...overrides,
  };
}

describe("runConversation", () => {
  it("sends the prompt as a single user message and normalizes the response", async () => {
    const chat = vi.fn(async (): Promise<DeepseekRaw> => ({
      model: "deepseek-v4-flash",
      choices: [{ message: { content: "Hello, world!" } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    }));
    const adapter = fakeAdapter({ chat });

    const result = await runConversation({ adapter, model: "deepseek-v4-flash", prompt: "hi" });

    expect(chat).toHaveBeenCalledWith({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(result.content).toBe("Hello, world!");
    expect(result.toolCalls).toBeNull();
    expect(result.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  });

  it("normalizes an Anthropic-shaped raw response when the adapter is claude", async () => {
    const chat = vi.fn(async () => ({
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "Hello from Claude" }],
      usage: { input_tokens: 4, output_tokens: 3 },
    }));
    const adapter = fakeAdapter({ info: PROVIDERS.claude, chat });

    const result = await runConversation({ adapter, model: "claude-sonnet-4-5", prompt: "hi" });

    expect(result.content).toBe("Hello from Claude");
    expect(result.usage).toEqual({ promptTokens: 4, completionTokens: 3, totalTokens: 7 });
  });
});

describe("formatResult", () => {
  const result = {
    content: "Hello, world!",
    toolCalls: null,
    model: "deepseek-v4-flash",
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
  };

  it("prints only the content by default", () => {
    const { stdout, stderr } = formatResult(result, { verbose: false });
    expect(stdout).toBe("Hello, world!\n");
    expect(stderr).toBeNull();
  });

  it("adds model and usage to stderr with --verbose", () => {
    const verbose = formatResult(result, { verbose: true });
    expect(verbose.stdout).toBe("Hello, world!\n");
    expect(verbose.stderr).toContain("model=deepseek-v4-flash");
    expect(verbose.stderr).toContain("total=5");
  });
});
