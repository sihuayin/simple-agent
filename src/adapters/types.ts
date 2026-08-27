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

export interface ConversationResult {
  content: string | null;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * The single test seam: one provider adapter per provider.
 * `send` returns the provider-specific raw response, which the
 * normalize step maps onto ConversationResult.
 */
export interface ProviderAdapter {
  readonly info: ProviderInfo;
  send(input: { model: string; prompt: string }): Promise<ProviderRawResponse>;
}

/** Raw response shape for OpenAI-compatible APIs (DeepSeek). */
export interface DeepseekRaw {
  model: string;
  choices: { message: { content: string | null } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
}

/** Raw response shape for the Anthropic Messages API (Claude). */
export interface ClaudeRaw {
  model: string;
  content: { type: string; text?: string }[];
  usage?: { input_tokens: number; output_tokens: number } | null;
}

export type ProviderRawResponse = DeepseekRaw | ClaudeRaw;
