import type {
  ClaudeRaw,
  ConversationResult,
  DeepseekRaw,
  ProviderId,
  ProviderRawResponse,
} from "./types.js";

/** Normalize an OpenAI-compatible (DeepSeek) raw response. */
export function normalizeDeepseek(raw: DeepseekRaw): ConversationResult {
  return {
    content: raw.choices?.[0]?.message.content ?? null,
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

/** Normalize an Anthropic (Claude) raw response: text blocks joined, usage renamed. */
export function normalizeClaude(raw: ClaudeRaw): ConversationResult {
  const text = (raw.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
  return {
    content: text || null,
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
