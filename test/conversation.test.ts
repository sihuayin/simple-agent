import { describe, expect, it, vi } from "vitest";

import { createClient } from "../src/client.js";
import { formatResult } from "../src/cli.js";
import { MissingApiKeyError, runConversation, type ChatClient } from "../src/conversation.js";

function fakeClient(create: ReturnType<typeof vi.fn>): ChatClient {
  return { chat: { completions: { create } } } as unknown as ChatClient;
}

const sampleCompletion = {
  model: "deepseek-v4-flash",
  choices: [{ message: { content: "Hello, world!" } }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

describe("runConversation", () => {
  it("sends the prompt as a single user message with the given model", async () => {
    const create = vi.fn().mockResolvedValue(sampleCompletion);
    const client = fakeClient(create);

    const result = await runConversation({ client, model: "deepseek-v4-flash", prompt: "hi" });

    expect(create).toHaveBeenCalledWith({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "hi" }],
      stream: false,
    });
    expect(result.content).toBe("Hello, world!");
  });

  it("returns the response content for printing", async () => {
    const create = vi.fn().mockResolvedValue(sampleCompletion);
    const result = await runConversation({
      client: fakeClient(create),
      model: "deepseek-v4-flash",
      prompt: "hi",
    });

    const { stdout, stderr } = formatResult(result, { verbose: false });
    expect(stdout).toBe("Hello, world!\n");
    expect(stderr).toBeNull();

    const verbose = formatResult(result, { verbose: true });
    expect(verbose.stdout).toBe("Hello, world!\n");
    expect(verbose.stderr).toContain("model=deepseek-v4-flash");
    expect(verbose.stderr).toContain("total=5");
  });
});

describe("createClient", () => {
  it("throws a friendly error when DEEPSEEK_API_KEY is missing", () => {
    expect(() => createClient({} as NodeJS.ProcessEnv)).toThrow(MissingApiKeyError);
    expect(() =>
      createClient({ DEEPSEEK_API_KEY: "sk-test" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
