/** Shared types for the provider adapter layer. */

export type ProviderId = "deepseek" | "claude";

export interface ProviderInfo {
  readonly id: ProviderId;
  readonly name: string;
  readonly defaultModel: string;
  readonly keyEnvVar: string;
  readonly modelEnvVar: string;
  readonly baseUrlEnvVar: string;
  readonly defaultBaseUrl: string;
  /** Some APIs (e.g. Anthropic) require an explicit max-tokens cap. */
  readonly maxTokens?: number;
}

/**
 * Provider-agnostic conversation message. The adapters translate between
 * this and each provider's wire format (OpenAI tool_calls / Anthropic
 * tool_use + tool_result).
 */
export type NormalizedMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      toolCalls?: { id: string; name: string; input: unknown }[];
    }
  | { role: "tool"; toolCallId: string; content: string };

/** A tool advertised to the model (JSON-schema parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ConversationResult {
  content: string | null;
  toolCalls: ToolCall[] | null;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * The single test seam: one provider adapter per provider.
 * `chat` sends the full conversation (plus optional tool schemas) and
 * returns the provider-specific raw response, which the normalize step
 * maps onto ConversationResult.
 */
export interface ProviderAdapter {
  readonly info: ProviderInfo;
  chat(input: {
    model: string;
    messages: NormalizedMessage[];
    tools?: ToolSpec[];
  }): Promise<ProviderRawResponse>;
}

/** Raw response shape for OpenAI-compatible APIs (DeepSeek). */
export interface DeepseekRaw {
  model: string;
  choices: {
    message: {
      content: string | null;
      tool_calls?: {
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

/** Raw response shape for the Anthropic Messages API (Claude). */
export interface ClaudeRaw {
  model: string;
  content: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  usage?: { input_tokens: number; output_tokens: number } | null;
}

export type ProviderRawResponse = DeepseekRaw | ClaudeRaw;
