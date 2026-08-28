import { describe, expect, it } from "vitest";

import {
  accumulateClaudeEvents,
  accumulateDeepseekChunks,
  collectStream,
  type AnthropicStreamEvent,
  type DeepseekChunk,
} from "../../src/adapters/stream.js";

// ---------- OpenAI wire (DeepSeek) ----------

function chunk(partial: Partial<DeepseekChunk>): DeepseekChunk {
  return { model: "deepseek-v4-flash", choices: [], ...partial };
}

function delta(content: string | null | undefined, toolCalls?: NonNullable<NonNullable<DeepseekChunk["choices"]>[number]["delta"]>["tool_calls"]) {
  return { delta: { content, tool_calls: toolCalls } };
}

describe("accumulateDeepseekChunks", () => {
  it("joins text split across chunks", () => {
    const raw = accumulateDeepseekChunks([
      chunk({ choices: [delta("你好，")] }),
      chunk({ choices: [delta("世界")] }),
      chunk({ choices: [delta(null)] }),
    ]);
    expect(raw.choices[0]?.message.content).toBe("你好，世界");
    expect(raw.model).toBe("deepseek-v4-flash");
  });

  it("assembles tool_calls from indexed partials (id/name first, arguments across chunks)", () => {
    const calls = [{ index: 0, function: { arguments: '{"path":"src' } }];
    const calls2 = [{ index: 0, function: { arguments: '/app.ts"}' } }];
    const raw = accumulateDeepseekChunks([
      chunk({
        choices: [
          delta(null, [
            { index: 0, id: "call_1", type: "function", function: { name: "read_file", arguments: "" } },
            { index: 1, id: "call_2", type: "function", function: { name: "bash", arguments: "" } },
          ]),
        ],
      }),
      chunk({ choices: [delta(null, calls)] }),
      chunk({ choices: [delta(null, calls2)] }),
    ]);
    const got = raw.choices[0]?.message.tool_calls!;
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({
      id: "call_1",
      type: "function",
      function: { name: "read_file", arguments: '{"path":"src/app.ts"}' },
    });
    expect(got[1]).toEqual({
      id: "call_2",
      type: "function",
      function: { name: "bash", arguments: "" },
    });
  });

  it("captures usage from the final chunk and nulls missing content", () => {
    const raw = accumulateDeepseekChunks([
      chunk({ choices: [delta("ok")] }),
      chunk({ choices: [delta(null)], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    ]);
    expect(raw.choices[0]?.message.content).toBe("ok");
    expect(raw.usage?.total_tokens).toBe(15);

    const none = accumulateDeepseekChunks([chunk({ choices: [delta(null)] })]);
    expect(none.choices[0]?.message.content).toBeNull();
    expect(none.choices[0]?.message.tool_calls).toBeUndefined();
  });
});

// ---------- Anthropic wire (Claude) ----------

function ev(partial: Partial<AnthropicStreamEvent> & { type: string }): AnthropicStreamEvent {
  return partial as AnthropicStreamEvent;
}

describe("accumulateClaudeEvents", () => {
  it("joins text_delta blocks and captures usage", () => {
    const raw = accumulateClaudeEvents([
      ev({ type: "message_start", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 7 } } }),
      ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "你好，" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "世界" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "message_delta", usage: { output_tokens: 3 } }),
      ev({ type: "message_stop" }),
    ]);
    expect(raw.model).toBe("claude-sonnet-4-5");
    expect(raw.content[0]?.text).toBe("你好，世界");
    expect(raw.usage).toEqual({ input_tokens: 7, output_tokens: 3 });
  });

  it("assembles tool_use from input_json_delta partials and parses the JSON", () => {
    const raw = accumulateClaudeEvents([
      ev({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"path\":\"s" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "rc/app.ts\"}" } }),
      ev({ type: "content_block_stop", index: 0 }),
    ]);
    const block = raw.content[0]!;
    expect(block.type).toBe("tool_use");
    expect(block.id).toBe("tu_1");
    expect(block.name).toBe("read_file");
    expect(block.input).toEqual({ path: "src/app.ts" });
  });

  it("keeps text and tool_use blocks in order", () => {
    const raw = accumulateClaudeEvents([
      ev({ type: "content_block_start", index: 0, content_block: { type: "text" } }),
      ev({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "先看看文件" } }),
      ev({ type: "content_block_stop", index: 0 }),
      ev({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu_1", name: "read_file" } }),
      ev({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } }),
      ev({ type: "content_block_stop", index: 1 }),
    ]);
    expect(raw.content.map((b) => b.type)).toEqual(["text", "tool_use"]);
  });
});

// ---------- collectStream ----------

describe("collectStream", () => {
  it("forwards text deltas in order and resolves the done raw", async () => {
    const texts: string[] = [];
    const raw = await collectStream(
      (async function* () {
        yield { type: "text", text: "Hel" };
        yield { type: "text", text: "lo" };
        yield { type: "done", raw: { model: "m", choices: [{ message: { content: "Hello" } }] } };
      })(),
      (t) => texts.push(t),
    );
    expect(texts).toEqual(["Hel", "lo"]);
    expect(raw).toEqual({ model: "m", choices: [{ message: { content: "Hello" } }] });
  });

  it("throws when the stream ends without done", async () => {
    await expect(
      collectStream(
        (async function* () {
          yield { type: "text", text: "x" };
        })(),
      ),
    ).rejects.toThrow(/done/);
  });

  it("propagates stream errors", async () => {
    await expect(
      collectStream(
        (async function* () {
          throw new Error("wire exploded");
        })(),
      ),
    ).rejects.toThrow(/wire exploded/);
  });
});
