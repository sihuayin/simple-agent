import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { PROVIDERS } from "./providers.js";
import type {
  ClaudeRaw,
  DeepseekRaw,
  ProviderAdapter,
  ProviderId,
  ProviderInfo,
} from "./types.js";

export class MissingApiKeyError extends Error {
  constructor(keyEnvVar: string, providerName: string) {
    super(
      `Missing ${keyEnvVar} for provider "${providerName}". Set it in your environment or a .env file (see .env.example).`,
    );
    this.name = "MissingApiKeyError";
  }
}

/**
 * Build the adapter for a provider from the environment.
 * Throws MissingApiKeyError when that provider's key isn't configured;
 * each provider requires its own key.
 */
export function createAdapter(
  provider: ProviderId,
  env: NodeJS.ProcessEnv = process.env,
): ProviderAdapter {
  const info = PROVIDERS[provider];
  const apiKey = env[info.keyEnvVar];
  if (!apiKey) throw new MissingApiKeyError(info.keyEnvVar, info.name);
  if (provider === "deepseek") return new DeepseekAdapter(info, apiKey, env);
  return new ClaudeAdapter(info, apiKey, env);
}

class DeepseekAdapter implements ProviderAdapter {
  readonly info: ProviderInfo;
  private readonly client: OpenAI;

  constructor(info: ProviderInfo, apiKey: string, env: NodeJS.ProcessEnv) {
    this.info = info;
    this.client = new OpenAI({
      apiKey,
      baseURL: env[info.baseUrlEnvVar] ?? info.defaultBaseUrl,
    });
  }

  async send({ model, prompt }: { model: string; prompt: string }): Promise<DeepseekRaw> {
    return this.client.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
    });
  }
}

class ClaudeAdapter implements ProviderAdapter {
  readonly info: ProviderInfo;
  private readonly client: Anthropic;

  constructor(info: ProviderInfo, apiKey: string, env: NodeJS.ProcessEnv) {
    this.info = info;
    this.client = new Anthropic({
      apiKey,
      baseURL: env[info.baseUrlEnvVar] ?? info.defaultBaseUrl,
    });
  }

  async send({ model, prompt }: { model: string; prompt: string }): Promise<ClaudeRaw> {
    const message = await this.client.messages.create({
      model,
      max_tokens: this.info.maxTokens ?? 4096,
      messages: [{ role: "user", content: prompt }],
    });
    return { model: message.model, content: message.content, usage: message.usage };
  }
}
