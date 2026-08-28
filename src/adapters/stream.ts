import type { ClaudeRaw, DeepseekRaw, ProviderRawResponse } from "./types.js";
import { safeParseJson } from "./normalize.js";

/**
 * Streaming accumulation for the two wire formats.
 *
 * chatStream (the adapter primitive) yields `{type:"text"}` deltas as content
 * arrives and one final `{type:"done", raw}` with the fully accumulated raw
 * response — the same shape a non-streaming call returns, so normalizeResponse
 * handles both identically. This module holds the format-specific logic:
 * OpenAI chunks arrive with indexed tool_calls partials; Anthropic delivers
 * text via content_block_delta.text_delta and tool args via input_json_delta
 * partial JSON assembled per content block.
 */

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; raw: ProviderRawResponse };

// ---------- OpenAI-compatible wire (DeepSeek) ----------

export interface DeepseekChunk {
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

export function accumulateDeepseekChunks(chunks: DeepseekChunk[]): DeepseekRaw {
  let content = "";
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  for (const chunk of chunks) {
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? {};
      if (delta.content) content += delta.content;
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? 0;
        const current = toolCalls.get(index) ?? { id: "", name: "", arguments: "" };
        if (tc.id) current.id = tc.id;
        if (tc.function?.name) current.name = tc.function.name;
        if (tc.function?.arguments) current.arguments += tc.function.arguments;
        toolCalls.set(index, current);
      }
    }
  }

  const calls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, tc]) => ({
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.arguments },
    }));

  return {
    model: chunks.find((c) => c.model)?.model ?? "",
    choices: [{ message: { content: content || null, tool_calls: calls.length ? calls : undefined } }],
    usage: chunks.find((c) => c.usage)?.usage ?? undefined,
  };
}

// ---------- Anthropic wire (Claude) ----------

export interface AnthropicStreamEvent {
  type: string;
  index?: number;
  message?: { model?: string; usage?: { input_tokens?: number } };
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string };
  usage?: { output_tokens?: number };
}

interface AccumulatedBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  /** For tool_use blocks: the raw accumulated partial JSON string. */
  input?: string;
}

function parseToolInput(raw: string): unknown {
  const parsed = safeParseJson(raw);
  return parsed === "" ? {} : parsed;
}

export function accumulateClaudeEvents(events: AnthropicStreamEvent[]): ClaudeRaw {
  const blocks: AccumulatedBlock[] = [];
  let model = "";
  let inputTokens = 0;
  let outputTokens = 0;

  for (const event of events) {
    switch (event.type) {
      case "message_start":
        model = event.message?.model ?? model;
        inputTokens = event.message?.usage?.input_tokens ?? 0;
        break;
      case "content_block_start": {
        if (event.index === undefined) break;
        const cb = event.content_block ?? {};
        blocks[event.index] =
          cb.type === "tool_use"
            ? { type: "tool_use", id: cb.id ?? "", name: cb.name ?? "", input: "" }
            : { type: "text", text: "" };
        break;
      }
      case "content_block_delta": {
        const block = blocks[event.index ?? -1];
        const d = event.delta ?? {};
        if (!block) break;
        if (d.type === "text_delta" && d.text) block.text = (block.text ?? "") + d.text;
        if (d.type === "input_json_delta" && d.partial_json) block.input = (block.input ?? "") + d.partial_json;
        break;
      }
      case "message_delta":
        outputTokens = event.usage?.output_tokens ?? outputTokens;
        break;
    }
  }

  return {
    model,
    content: blocks
      .filter((b): b is AccumulatedBlock => b !== undefined)
      .map((b) =>
        b.type === "tool_use"
          ? { type: "tool_use", id: b.id, name: b.name, input: parseToolInput(b.input ?? "") }
          : { type: "text", text: b.text ?? "" },
      ),
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

// ---------- stream consumption ----------

/**
 * Iterate a chatStream, forwarding text deltas to onText, and resolve the
 * accumulated `done` raw. Throws if the stream ends without done.
 */
export async function collectStream(
  stream: AsyncIterable<StreamEvent>,
  onText?: (text: string) => void,
): Promise<ProviderRawResponse> {
  let raw: ProviderRawResponse | undefined;
  for await (const event of stream) {
    if (event.type === "text") onText?.(event.text);
    else if (event.type === "done") raw = event.raw;
  }
  if (!raw) throw new Error("stream ended without a done event");
  return raw;
}
