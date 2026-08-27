import { normalizeResponse } from "./adapters/normalize.js";
import type { ConversationResult, ProviderAdapter } from "./adapters/types.js";

export type { ConversationResult } from "./adapters/types.js";

export interface RunConversationInput {
  adapter: ProviderAdapter;
  model: string;
  prompt: string;
}

/**
 * Send one user message through the provider adapter and normalize the
 * provider-specific raw response. Pure of I/O beyond the injected adapter,
 * which is the single test seam.
 */
export async function runConversation({
  adapter,
  model,
  prompt,
}: RunConversationInput): Promise<ConversationResult> {
  const raw = await adapter.send({ model, prompt });
  return normalizeResponse(adapter.info.id, raw);
}
