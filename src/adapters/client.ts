import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { PROVIDERS } from "./providers.js";
import type {
  ClaudeRaw,
  DeepseekRaw,
  NormalizedMessage,
  ProviderAdapter,
  ProviderId,
  ProviderInfo,
  ToolSpec,
} from "./types.js";
import { toAnthropicMessages, toAnthropicTools, toOpenAIMessages, toOpenAITools } from "./wire.js";

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

  async chat({
    model,
    messages,
    tools,
  }: {
    model: string;
    messages: NormalizedMessage[];
    tools?: ToolSpec[];
  }): Promise<DeepseekRaw> {
    const completion = await this.client.chat.completions.create({
      model,
      messages: toOpenAIMessages(messages) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: tools?.length ? (toOpenAITools(tools) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[]) : undefined,
      stream: false,
    });
    const message = completion.choices[0]?.message;
    const toolCalls = message?.tool_calls
      ?.map((tc) => {
        const fn = (tc as { function?: { name?: unknown; arguments?: unknown } }).function;
        if (!fn || typeof fn.name !== "string") return null;
        return {
          id: tc.id,
          type: tc.type,
          function: { name: fn.name, arguments: String(fn.arguments ?? "{}") },
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
    return {
      model: completion.model,
      choices: [{ message: { content: message?.content ?? null, tool_calls: toolCalls } }],
      usage: completion.usage,
    };
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

  async chat({
    model,
    messages,
    tools,
  }: {
    model: string;
    messages: NormalizedMessage[];
    tools?: ToolSpec[];
  }): Promise<ClaudeRaw> {
    const { system, messages: wire } = toAnthropicMessages(messages);
    const message = await this.client.messages.create({
      model,
      max_tokens: this.info.maxTokens ?? 4096,
      system,
      messages: wire as Anthropic.MessageParam[],
      tools: tools?.length ? (toAnthropicTools(tools) as unknown as Anthropic.ToolUnion[]) : undefined,
    });
    return { model: message.model, content: message.content, usage: message.usage };
  }
}
