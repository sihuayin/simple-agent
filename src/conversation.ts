/**
 * The minimal client surface the conversation logic needs.
 * `OpenAI` satisfies this structurally; tests can pass a fake.
 */
export interface ChatCompletionsLike {
  create(params: {
    model: string;
    messages: { role: "user" | "assistant" | "system"; content: string }[];
    stream: false;
  }): Promise<{
    model: string;
    choices: { message: { content: string | null } }[];
    usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  }>;
}

export interface ChatClient {
  chat: { completions: ChatCompletionsLike };
}

export interface RunConversationInput {
  client: ChatClient;
  model: string;
  prompt: string;
}

export interface ConversationResult {
  content: string | null;
  model: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

export class MissingApiKeyError extends Error {
  constructor() {
    super(
      "Missing DEEPSEEK_API_KEY. Set it in your environment or a .env file (see .env.example).",
    );
    this.name = "MissingApiKeyError";
  }
}

/**
 * Send one user message to the model and return the response.
 * Pure of I/O beyond the injected client, so it is trivially testable.
 */
export async function runConversation({
  client,
  model,
  prompt,
}: RunConversationInput): Promise<ConversationResult> {
  const completion = await client.chat.completions.create({
    model,
    messages: [{ role: "user", content: prompt }],
    stream: false,
  });

  const usage = completion.usage;
  return {
    content: completion.choices[0]?.message.content ?? null,
    model: completion.model,
    usage: usage
      ? {
          promptTokens: usage.prompt_tokens,
          completionTokens: usage.completion_tokens,
          totalTokens: usage.total_tokens,
        }
      : undefined,
  };
}
