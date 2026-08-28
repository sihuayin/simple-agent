import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

import { PROVIDERS } from "./providers.js";
import { accumulateClaudeEvents, accumulateDeepseekChunks, collectStream, type DeepseekChunk, type StreamEvent } from "./stream.js";
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

  chat(input: { model: string; messages: NormalizedMessage[]; tools?: ToolSpec[] }): Promise<DeepseekRaw> {
    return collectStream(this.chatStream(input)) as Promise<DeepseekRaw>;
  }

  async *chatStream({
    model,
    messages,
    tools,
  }: {
    model: string;
    messages: NormalizedMessage[];
    tools?: ToolSpec[];
  }): AsyncGenerator<StreamEvent> {
    const stream = await this.client.chat.completions.create({
      model,
      messages: toOpenAIMessages(messages) as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      tools: tools?.length ? (toOpenAITools(tools) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[]) : undefined,
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks: DeepseekChunk[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as unknown as DeepseekChunk);
      for (const choice of chunk.choices ?? []) {
        if (choice.delta?.content) yield { type: "text", text: choice.delta.content };
      }
    }
    yield { type: "done", raw: accumulateDeepseekChunks(chunks) };
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

  chat(input: { model: string; messages: NormalizedMessage[]; tools?: ToolSpec[] }): Promise<ClaudeRaw> {
    return collectStream(this.chatStream(input)) as Promise<ClaudeRaw>;
  }

  async *chatStream({
    model,
    messages,
    tools,
  }: {
    model: string;
    messages: NormalizedMessage[];
    tools?: ToolSpec[];
  }): AsyncGenerator<StreamEvent> {
    const { system, messages: wire } = toAnthropicMessages(messages);
    const stream = await this.client.messages.create({
      model,
      max_tokens: this.info.maxTokens ?? 4096,
      system,
      messages: wire as Anthropic.MessageParam[],
      tools: tools?.length ? (toAnthropicTools(tools) as unknown as Anthropic.ToolUnion[]) : undefined,
      stream: true,
    });
    const events: Parameters<typeof accumulateClaudeEvents>[0] = [];
    for await (const event of stream) {
      events.push(event as (typeof events)[number]);
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        yield { type: "text", text: event.delta.text };
      }
    }
    yield { type: "done", raw: accumulateClaudeEvents(events) };
  }
}
