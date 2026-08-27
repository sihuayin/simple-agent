import type { ProviderId, ProviderInfo } from "./types.js";

/**
 * Provider registry. Adding a new model provider = one entry here plus an
 * adapter implementation in client.ts; nothing else in the CLI changes.
 */
export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    defaultModel: "deepseek-v4-flash",
    keyEnvVar: "DEEPSEEK_API_KEY",
    modelEnvVar: "DEEPSEEK_MODEL",
    baseUrlEnvVar: "DEEPSEEK_BASE_URL",
    defaultBaseUrl: "https://api.deepseek.com",
  },
  claude: {
    id: "claude",
    name: "Claude",
    defaultModel: "claude-sonnet-4-5",
    keyEnvVar: "ANTHROPIC_API_KEY",
    modelEnvVar: "ANTHROPIC_MODEL",
    baseUrlEnvVar: "ANTHROPIC_BASE_URL",
    defaultBaseUrl: "https://api.anthropic.com",
    maxTokens: 4096,
  },
};
