import { describe, expect, it } from "vitest";

import {
  toAnthropicMessages,
  toAnthropicTools,
  toOpenAIMessages,
  toOpenAITools,
} from "../../src/adapters/wire.js";
import type { NormalizedMessage, ToolSpec } from "../../src/adapters/types.js";

const toolSpec: ToolSpec = {
  name: "read_file",
  description: "Read a file.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

describe("toOpenAIMessages", () => {
  it("passes system and user messages through", () => {
    const out = toOpenAIMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(out).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
  });

  it("serializes assistant tool calls as tool_calls with stringified arguments", () => {
    const messages: NormalizedMessage[] = [
      { role: "assistant", content: null, toolCalls: [{ id: "c1", name: "read_file", input: { path: "a.txt" } }] },
    ];
    expect(toOpenAIMessages(messages)[0]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    });
  });

  it("maps tool results to the tool role with tool_call_id", () => {
    expect(toOpenAIMessages([{ role: "tool", toolCallId: "c1", content: "result" }])).toEqual([
      { role: "tool", content: "result", tool_call_id: "c1" },
    ]);
  });
});

describe("toOpenAITools", () => {
  it("wraps specs in the function-calling envelope", () => {
    expect(toOpenAITools([toolSpec])).toEqual([
      { type: "function", function: { name: "read_file", description: "Read a file.", parameters: toolSpec.parameters } },
    ]);
  });
});

describe("toAnthropicMessages", () => {
  it("extracts system messages into the system field", () => {
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ]);
    expect(system).toBe("sys");
    expect(messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("turns assistant tool calls into tool_use content blocks", () => {
    const { messages } = toAnthropicMessages([
      { role: "assistant", content: "thinking out loud", toolCalls: [{ id: "tu1", name: "grep", input: { pattern: "x" } }] },
    ]);
    expect(messages[0]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "thinking out loud" },
        { type: "tool_use", id: "tu1", name: "grep", input: { pattern: "x" } },
      ],
    });
  });

  it("folds tool results into a single user turn with tool_result blocks", () => {
    const { messages } = toAnthropicMessages([
      { role: "tool", toolCallId: "tu1", content: "r1" },
      { role: "tool", toolCallId: "tu2", content: "r2" },
    ]);
    expect(messages).toEqual([
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu1", content: "r1" },
          { type: "tool_result", tool_use_id: "tu2", content: "r2" },
        ],
      },
    ]);
  });

  it("appends a tool result to an existing tool_result user turn", () => {
    const { messages } = toAnthropicMessages([
      { role: "tool", toolCallId: "tu1", content: "r1" },
      { role: "tool", toolCallId: "tu2", content: "r2" },
      { role: "tool", toolCallId: "tu3", content: "r3" },
    ]);
    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as unknown[]).length).toBe(3);
  });
});

describe("toAnthropicTools", () => {
  it("maps specs to name/description/input_schema", () => {
    expect(toAnthropicTools([toolSpec])).toEqual([
      { name: "read_file", description: "Read a file.", input_schema: toolSpec.parameters },
    ]);
  });
});
