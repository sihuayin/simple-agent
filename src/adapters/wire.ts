import type { NormalizedMessage, ToolSpec } from "./types.js";

/**
 * Wire-format translation between the normalized message model and each
 * provider's API. Pure functions so the mapping is unit-testable without
 * any SDK or network.
 */

// ---------- OpenAI-compatible (DeepSeek) ----------

export type OpenAIChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; content: string; tool_call_id: string };

export function toOpenAIMessages(messages: NormalizedMessage[]): OpenAIChatMessage[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
    }
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content,
        tool_calls: m.toolCalls?.map((c) => ({
          id: c.id,
          type: "function" as const,
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      };
    }
    return { role: m.role, content: m.content };
  });
}

export function toOpenAITools(tools: ToolSpec[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// ---------- Anthropic (Claude) ----------

export type AnthropicContentBlock = {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: string;
};

export interface AnthropicChatMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[] | string;
}

export function toAnthropicMessages(messages: NormalizedMessage[]): {
  system: string | undefined;
  messages: AnthropicChatMessage[];
} {
  const systems: string[] = [];
  const wire: AnthropicChatMessage[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      systems.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      // Anthropic requires tool results inside a user turn,
      // so consecutive tool results fold into one user message.
      const last = wire[wire.length - 1];
      const block: AnthropicContentBlock = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      if (last && last.role === "user" && Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result")) {
        (last.content as AnthropicContentBlock[]).push(block);
      } else {
        wire.push({ role: "user", content: [block] });
      }
      continue;
    }
    if (m.role === "assistant") {
      const blocks: AnthropicContentBlock[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
      }
      wire.push({ role: "assistant", content: blocks });
      continue;
    }
    wire.push({ role: "user", content: m.content });
  }

  return { system: systems.length ? systems.join("\n\n") : undefined, messages: wire };
}

export function toAnthropicTools(tools: ToolSpec[]) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters as Record<string, unknown>,
  }));
}
