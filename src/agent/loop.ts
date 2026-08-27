import type { NormalizedMessage, ProviderAdapter, ToolSpec } from "../adapters/types.js";
import { normalizeResponse } from "../adapters/normalize.js";
import { TOOLS } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";

const TOOL_RESULT_CAP = 8000;

export interface RunAgentInput {
  adapter: ProviderAdapter;
  model: string;
  systemPrompt?: string;
  userPrompt: string;
  tools?: ToolSpec[];
  /** How many tool rounds the model may use before the loop aborts. */
  maxIterations?: number;
  toolContext: ToolContext;
}

export interface AgentResult {
  text: string;
  model: string;
  iterations: number;
  toolCallsMade: number;
  aborted: boolean;
}

/**
 * The agent loop: send the conversation (with tool schemas) to the model;
 * while the model requests tools, execute them and feed the results back;
 * stop on a final text answer or when the iteration cap is hit (the cap
 * aborts without executing the round that exceeded it).
 *
 * Single seam: the injected adapter. Tools execute against the real
 * filesystem via toolContext.
 */
export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const tools = input.tools ?? [];
  const maxIterations = input.maxIterations ?? 10;
  const messages: NormalizedMessage[] = [];
  if (input.systemPrompt) messages.push({ role: "system", content: input.systemPrompt });
  messages.push({ role: "user", content: input.userPrompt });

  let toolCallsMade = 0;

  for (let round = 0; ; round++) {
    const raw = await input.adapter.chat({ model: input.model, messages, tools });
    const result = normalizeResponse(input.adapter.info.id, raw);

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        text: result.content ?? "",
        model: result.model,
        iterations: round + 1,
        toolCallsMade,
        aborted: false,
      };
    }

    if (round >= maxIterations) {
      return {
        text: result.content ?? "",
        model: result.model,
        iterations: round + 1,
        toolCallsMade,
        aborted: true,
      };
    }

    messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
    for (const call of result.toolCalls) {
      toolCallsMade += 1;
      const tool = TOOLS[call.name];
      let content: string;
      if (!tool) {
        content = `Unknown tool: ${call.name}. Available: ${Object.keys(TOOLS).join(", ")}`;
      } else {
        try {
          content = String(await tool.execute((call.input ?? {}) as Record<string, unknown>, input.toolContext));
        } catch (e) {
          content = e instanceof Error ? e.message : String(e);
        }
      }
      if (content.length > TOOL_RESULT_CAP) {
        content = content.slice(0, TOOL_RESULT_CAP) + `\n[TOOL_RESULT_TRUNCATED — ${content.length} chars]`;
      }
      messages.push({ role: "tool", toolCallId: call.id, content });
    }
  }
}
