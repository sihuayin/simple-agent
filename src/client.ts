import OpenAI from "openai";

import { DEFAULT_BASE_URL } from "./config.js";
import { MissingApiKeyError, type ChatClient } from "./conversation.js";

/**
 * Build the API client from the environment.
 * Throws MissingApiKeyError when no key is configured, so the CLI can
 * print a friendly message and exit non-zero.
 */
export function createClient(env: NodeJS.ProcessEnv = process.env): ChatClient {
  const apiKey = env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new MissingApiKeyError();
  }
  return new OpenAI({
    apiKey,
    baseURL: env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL,
  });
}
