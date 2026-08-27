import { describe, expect, it } from "vitest";

import { normalizeClaude, normalizeDeepseek } from "../../src/adapters/normalize.js";
import type { ClaudeRaw, DeepseekRaw } from "../../src/adapters/types.js";

describe("normalizeDeepseek", () => {
  it("extracts content from choices[0].message and maps usage", () => {
    const raw: DeepseekRaw = {
      model: "deepseek-v4-flash",
      choices: [{ message: { content: "DeepSeek reply" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
    expect(normalizeDeepseek(raw)).toEqual({
      content: "DeepSeek reply",
      toolCalls: null,
      model: "deepseek-v4-flash",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    });
  });

  it("returns null content when the message has none", () => {
    const raw: DeepseekRaw = { model: "deepseek-v4-flash", choices: [{ message: { content: null } }] };
    expect(normalizeDeepseek(raw).content).toBeNull();
  });

  it("extracts tool_calls and parses the JSON arguments", () => {
    const raw: DeepseekRaw = {
      model: "deepseek-v4-flash",
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
            ],
          },
        },
      ],
    };
    expect(normalizeDeepseek(raw).toolCalls).toEqual([
      { id: "call_1", name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  it("keeps unparseable tool arguments as a raw string", () => {
    const raw: DeepseekRaw = {
      model: "deepseek-v4-flash",
      choices: [{ message: { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "x", arguments: "not json" } }] } }],
    };
    expect(normalizeDeepseek(raw).toolCalls?.[0]?.input).toBe("not json");
  });
});

describe("normalizeClaude", () => {
  it("joins text blocks and maps input/output tokens", () => {
    const raw: ClaudeRaw = {
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "first" }, { type: "text", text: "second" }],
      usage: { input_tokens: 4, output_tokens: 3 },
    };
    expect(normalizeClaude(raw)).toEqual({
      content: "first\nsecond",
      toolCalls: null,
      model: "claude-sonnet-4-5",
      usage: { promptTokens: 4, completionTokens: 3, totalTokens: 7 },
    });
  });

  it("skips non-text blocks (e.g. tool_use) when building content", () => {
    const raw: ClaudeRaw = {
      model: "claude-sonnet-4-5",
      content: [
        { type: "text", text: "kept" },
        { type: "tool_use", id: "tu_1", name: "read_file", input: { path: "a.txt" } },
      ],
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    expect(normalizeClaude(raw).content).toBe("kept");
  });

  it("extracts tool_use blocks into toolCalls", () => {
    const raw: ClaudeRaw = {
      model: "claude-sonnet-4-5",
      content: [
        { type: "tool_use", id: "tu_9", name: "grep", input: { pattern: "TODO" } },
      ],
      usage: { input_tokens: 2, output_tokens: 1 },
    };
    expect(normalizeClaude(raw).toolCalls).toEqual([
      { id: "tu_9", name: "grep", input: { pattern: "TODO" } },
    ]);
  });

  it("returns null content for an empty content array instead of crashing", () => {
    const raw: ClaudeRaw = { model: "claude-sonnet-4-5", content: [] };
    expect(normalizeClaude(raw).content).toBeNull();
    expect(normalizeClaude(raw).toolCalls).toBeNull();
  });
});
