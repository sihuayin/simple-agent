import type {
  ClaudeRaw,
  ConversationResult,
  DeepseekRaw,
  ProviderId,
  ProviderRawResponse,
  ToolCall,
} from "./types.js";

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Normalize an OpenAI-compatible (DeepSeek) raw response, incl. tool calls. */
export function normalizeDeepseek(raw: DeepseekRaw): ConversationResult {
  const message = raw.choices?.[0]?.message;
  const toolCalls: ToolCall[] | null = message?.tool_calls?.length
    ? message.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: safeParseJson(tc.function.arguments),
      }))
    : null;
  return {
    content: message?.content ?? null,
    toolCalls,
    model: raw.model,
    usage: raw.usage
      ? {
          promptTokens: raw.usage.prompt_tokens,
          completionTokens: raw.usage.completion_tokens,
          totalTokens: raw.usage.total_tokens,
        }
      : undefined,
  };
}

/** Normalize an Anthropic (Claude) raw response: text blocks joined, tool_use extracted. */
export function normalizeClaude(raw: ClaudeRaw): ConversationResult {
  const blocks = raw.content ?? [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n");
  const toolCalls: ToolCall[] | null = blocks.some((b) => b.type === "tool_use")
    ? blocks
        .filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} }))
    : null;
  return {
    content: text || null,
    toolCalls,
    model: raw.model,
    usage: raw.usage
      ? {
          promptTokens: raw.usage.input_tokens,
          completionTokens: raw.usage.output_tokens,
          totalTokens: raw.usage.input_tokens + raw.usage.output_tokens,
        }
      : undefined,
  };
}

export function normalizeResponse(provider: "deepseek", raw: DeepseekRaw): ConversationResult;
export function normalizeResponse(provider: "claude", raw: ClaudeRaw): ConversationResult;
export function normalizeResponse(
  provider: ProviderId,
  raw: ProviderRawResponse,
): ConversationResult;
export function normalizeResponse(
  provider: ProviderId,
  raw: ProviderRawResponse,
): ConversationResult {
  // The provider id decides which shape the raw response has.
  return provider === "deepseek"
    ? normalizeDeepseek(raw as DeepseekRaw)
    : normalizeClaude(raw as ClaudeRaw);
}
