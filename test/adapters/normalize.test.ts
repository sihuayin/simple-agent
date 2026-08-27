import { describe, expect, it } from "vitest";

import { normalizeClaude, normalizeDeepseek } from "../../src/adapters/normalize.js";
import type { ClaudeRaw, DeepseekRaw } from "../../src/adapters/types.js";

const deepseekRaw: DeepseekRaw = {
  model: "deepseek-v4-flash",
  choices: [{ message: { content: "DeepSeek reply" } }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

describe("normalizeDeepseek", () => {
  it("extracts content from choices[0].message and maps usage", () => {
    const result = normalizeDeepseek(deepseekRaw);
    expect(result).toEqual({
      content: "DeepSeek reply",
      model: "deepseek-v4-flash",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it("returns null content when the message has none", () => {
    const raw: DeepseekRaw = { model: "deepseek-v4-flash", choices: [{ message: { content: null } }] };
    expect(normalizeDeepseek(raw).content).toBeNull();
  });
});

describe("normalizeClaude", () => {
  it("joins text blocks and maps input/output tokens to the unified usage", () => {
    const raw: ClaudeRaw = {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      usage: { input_tokens: 4, output_tokens: 3 },
    };
    expect(normalizeClaude(raw)).toEqual({
      content: "first\nsecond",
      model: "claude-sonnet-4-5",
      usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
    });
  });

  it("skips non-text blocks (e.g. tool_use)", () => {
    const raw: ClaudeRaw = {
      model: "claude-sonnet-4-5",
      content: [
        { type: "text", text: "kept" },
        { type: "tool_use" },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    expect(normalizeClaude(raw).content).toBe("kept");
  });

  it("returns null content for an empty content array instead of crashing", () => {
    const raw: ClaudeRaw = { model: "claude-sonnet-4-5", content: [] };
    expect(normalizeClaude(raw).content).toBeNull();
  });
});
