import type { NormalizedMessage, ProviderAdapter, ToolSpec } from "../adapters/types.js";
import { normalizeResponse } from "../adapters/normalize.js";
import {
  compactMessages,
  estimateConversation,
  findDropRange,
  fixedTokensFor,
  summarizeWithAdapter,
  TokenBudget,
  type BudgetConfig,
} from "./budget.js";
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
  /** Token budget config; defaults to the provider's context window × 0.8. */
  budgetConfig?: BudgetConfig;
  /** Set when the user message contained /compact: force a compaction before sending. */
  forceCompact?: boolean;
  /** Injectable summarizer for the summary compaction strategy (test seam). */
  summarizer?: (dropped: NormalizedMessage[]) => Promise<string>;
}

export interface AgentResult {
  text: string;
  model: string;
  iterations: number;
  toolCallsMade: number;
  aborted: boolean;
  compactions: number;
}

/**
 * The agent loop: send the conversation (with tool schemas) to the model;
 * while the model requests tools, execute them and feed the results back;
 * stop on a final text answer or when the iteration cap is hit (the cap
 * aborts without executing the round that exceeded it).
 *
 * Before each send the token budget is checked: when the estimate (or the
 * last API-reported usage) crosses the threshold, older rounds are compacted
 * (rolling summary via an extra model call, or truncation). See budget.ts.
 *
 * Single seam: the injected adapter.
 */
export async function runAgent(input: RunAgentInput): Promise<AgentResult> {
  const tools = input.tools ?? [];
  const maxIterations = input.maxIterations ?? 10;
  const contextWindow = input.adapter.info.contextWindow ?? 128000;
  const budget = new TokenBudget(input.budgetConfig ?? { contextWindow });
  const fixedTokens = fixedTokensFor(input.systemPrompt, tools);
  const summarizer =
    input.summarizer ?? ((dropped) => summarizeWithAdapter(input.adapter, input.model, dropped));

  const messages: NormalizedMessage[] = [];
  if (input.systemPrompt) messages.push({ role: "system", content: input.systemPrompt });
  messages.push({ role: "user", content: input.userPrompt });

  let toolCallsMade = 0;
  let forceCompact = input.forceCompact === true;

  const estimate = (msgs: NormalizedMessage[]) => estimateConversation(msgs, fixedTokens);

  const maybeCompact = async (): Promise<void> => {
    if (!forceCompact && !budget.decide(estimate(messages))) return;

    if (budget.strategy === "truncate") {
      const out = compactMessages(
        messages,
        budget.keepRounds,
        "truncate",
        null,
        estimate,
        budget.threshold,
      );
      if (out.dropped > 0) {
        budget.compactions += 1;
        budget.markCompacted();
        forceCompact = false;
        messages.splice(0, messages.length, ...out.messages);
      }
      return;
    }

    const range = findDropRange(messages, budget.keepRounds);
    if (!range) return; // 无可压缩内容（轮数还没超过 keepRounds）
    const dropped = messages.slice(range.from, range.to);
    let summaryText: string | null = null;
    try {
      summaryText = await summarizer(dropped);
    } catch {
      summaryText = null;
    }
    if (!summaryText) return; // 摘要失败：宁可不压缩也不丢原文
    const out = compactMessages(messages, budget.keepRounds, "summary", summaryText, estimate, budget.threshold);
    if (out.dropped > 0) {
      budget.compactions += 1;
      budget.markCompacted();
      forceCompact = false;
      messages.splice(0, messages.length, ...out.messages);
    }
  };

  for (let round = 0; ; round++) {
    await maybeCompact();

    const raw = await input.adapter.chat({ model: input.model, messages, tools });
    const result = normalizeResponse(input.adapter.info.id, raw);
    budget.recordUsage(result.usage?.promptTokens);

    if (!result.toolCalls || result.toolCalls.length === 0) {
      return {
        text: result.content ?? "",
        model: result.model,
        iterations: round + 1,
        toolCallsMade,
        aborted: false,
        compactions: budget.compactions,
      };
    }

    if (round >= maxIterations) {
      return {
        text: result.content ?? "",
        model: result.model,
        iterations: round + 1,
        toolCallsMade,
        aborted: true,
        compactions: budget.compactions,
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
