import type { NormalizedMessage, ProviderAdapter, ToolSpec } from "../adapters/types.js";
import { normalizeResponse } from "../adapters/normalize.js";
import { collectStream } from "../adapters/stream.js";
import { dispatchEvent, loadHooks, runPreToolUseHooks, type HookConfig } from "./hooks.js";
import {
  compactMessages,
  estimateConversation,
  findDropRange,
  fixedTokensFor,
  summarizeWithAdapter,
  TokenBudget,
  type BudgetConfig,
} from "./budget.js";
import {
  askRejectedMessage,
  candidateFor,
  defaultAsk,
  DEFAULT_PROTECTED_PATHS,
  evaluatePolicy,
  loadRules,
  policyFeedbackMessage,
  type PolicyRule,
} from "./policy.js";
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
  /** Policy rules + protected paths; defaults load .rules from the workspace. */
  policy?: { rules: PolicyRule[]; protectedPaths: string[] };
  /** Human confirmation for ask decisions; defaults to a TTY readline prompt. */
  ask?: (message: string) => Promise<boolean>;
  /** Hooks (PreToolUse/PostToolUse/SessionStart/Stop); defaults load .hooks from the workspace. */
  hooks?: HookConfig[];
  /** Receives assistant text deltas as they stream in (live output). */
  onText?: (text: string) => void;
  /** Lifecycle: "waiting" before each model call, "streaming" on first text, "done" at the end. */
  onPhase?: (phase: "waiting" | "streaming" | "done") => void;
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
  const policy = input.policy ?? {
    rules: await loadRules(input.toolContext.workspace),
    protectedPaths: DEFAULT_PROTECTED_PATHS,
  };
  const ask = input.ask ?? defaultAsk;
  const hooks = input.hooks ?? (await loadHooks(input.toolContext.workspace));
  const onPhase = input.onPhase;
  const onText = input.onText
    ? (() => {
        let streaming = false;
        return (t: string) => {
          if (!streaming) {
            streaming = true;
            onPhase?.("streaming");
          }
          input.onText!(t);
        };
      })()
    : undefined;

  const messages: NormalizedMessage[] = [];
  if (input.systemPrompt) messages.push({ role: "system", content: input.systemPrompt });
  messages.push({ role: "user", content: input.userPrompt });

  let toolCallsMade = 0;
  let forceCompact = input.forceCompact === true;

  // SessionStart：会话初始化 hook（fail-open）
  await dispatchEvent(hooks, "SessionStart", { workspace: input.toolContext.workspace });

  // Stop 载荷：在 finally 中随最终结果一起发送
  let stopInfo = { finalText: "", iterations: 0, toolCallsMade: 0, aborted: false };

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

  try {
    for (let round = 0; ; round++) {
      await maybeCompact();

      onPhase?.("waiting");
      const raw = await collectStream(
        input.adapter.chatStream({ model: input.model, messages, tools }),
        onText,
      );
      const result = normalizeResponse(input.adapter.info.id, raw);
      budget.recordUsage(result.usage?.promptTokens);

      if (!result.toolCalls || result.toolCalls.length === 0) {
        const res = {
          text: result.content ?? "",
          model: result.model,
          iterations: round + 1,
          toolCallsMade,
          aborted: false,
          compactions: budget.compactions,
        };
        stopInfo = { finalText: res.text, iterations: res.iterations, toolCallsMade, aborted: false };
        return res;
      }

      if (round >= maxIterations) {
        const res = {
          text: result.content ?? "",
          model: result.model,
          iterations: round + 1,
          toolCallsMade,
          aborted: true,
          compactions: budget.compactions,
        };
        stopInfo = { finalText: res.text, iterations: res.iterations, toolCallsMade, aborted: true };
        return res;
      }

      messages.push({ role: "assistant", content: result.content, toolCalls: result.toolCalls });
      for (const call of result.toolCalls) {
        toolCallsMade += 1;
        const tool = TOOLS[call.name];
        let content: string;
        if (!tool) {
          content = `Unknown tool: ${call.name}. Available: ${Object.keys(TOOLS).join(", ")}`;
          messages.push({ role: "tool", toolCallId: call.id, content });
          continue;
        }

        const toolInput = (call.input ?? {}) as Record<string, unknown>;
        const candidate = candidateFor(call.name, toolInput);
        const decision = evaluatePolicy(candidate, policy.rules, policy.protectedPaths);

        const execute = async (params?: Record<string, unknown>): Promise<string> => {
          try {
            return String(await tool.execute(params ?? toolInput, input.toolContext));
          } catch (e) {
            return e instanceof Error ? e.message : String(e);
          }
        };

        // 所有实际执行的调用都走 PreToolUse hook 链（policy 之后——hook 不能绕过内置安全；执行之前）
        const runWithHooks = async (): Promise<string> => {
          const hookOutcome = await runPreToolUseHooks(hooks, {
            tool: call.name,
            input: toolInput,
            workspace: input.toolContext.workspace,
          });
          if (hookOutcome.action !== "allow") return hookOutcome.message ?? "[hook blocked]";
          let out = await execute(hookOutcome.params);
          if (hookOutcome.message) out = `${hookOutcome.message}\n${out}`;
          await dispatchEvent(hooks, "PostToolUse", {
            tool: call.name,
            input: hookOutcome.params,
            result: out,
            workspace: input.toolContext.workspace,
          });
          return out;
        };

        // 执行许可：deny → 直接拒绝；ask → 人类确认后走 hooks；allow → 走 hooks
        if (decision.action === "deny") {
          content = policyFeedbackMessage(decision, candidate);
        } else if (decision.action === "ask") {
          const allowed = await ask(policyFeedbackMessage(decision, candidate));
          content = allowed ? await runWithHooks() : askRejectedMessage(decision, candidate);
        } else {
          content = await runWithHooks();
        }

        if (content.length > TOOL_RESULT_CAP) {
          content = content.slice(0, TOOL_RESULT_CAP) + `\n[TOOL_RESULT_TRUNCATED — ${content.length} chars]`;
        }
        messages.push({ role: "tool", toolCallId: call.id, content });
      }
    }
  } finally {
    await dispatchEvent(hooks, "Stop", { workspace: input.toolContext.workspace, ...stopInfo });
    onPhase?.("done");
  }
}
