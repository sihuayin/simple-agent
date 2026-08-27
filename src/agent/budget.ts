import type { NormalizedMessage, ProviderAdapter } from "../adapters/types.js";
import { normalizeResponse } from "../adapters/normalize.js";

/**
 * Token 预算管理：发送前估算上下文用量，超过阈值自动压缩（滚动摘要或截断），
 * 并用 API 返回的真实用量做漂移校准。见 ADR 与 .scratch/token-budget/spec.md。
 */

// CJK（假名/扩展汉字/汉字/谚文）按 1.5 字符/token，其余按 4 字符/token；向上取整。
// 中文按此规则估算偏保守（略高于真实分词），用于预算决策是安全方向。
const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of String(text)) {
    if (CJK_RE.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk / 1.5) + Math.ceil(other / 4);
}

/** 每条消息的角色/格式开销。 */
const MSG_OVERHEAD = 3;

export function estimateMessageTokens(msg: NormalizedMessage): number {
  const content = msg.role === "assistant" ? (msg.content ?? "") : msg.content;
  return MSG_OVERHEAD + estimateTokens(content);
}

/** 会话估算 = 固定开销（系统提示词 + 工具 schema）+ 摘要 + 各消息之和。 */
export function estimateConversation(
  messages: NormalizedMessage[],
  fixedTokens: number,
): number {
  let total = fixedTokens;
  for (const m of messages) total += estimateMessageTokens(m);
  return total;
}

export function fixedTokensFor(
  systemPrompt: string | undefined,
  tools: { name: string; description: string; parameters: Record<string, unknown> }[],
): number {
  let n = estimateTokens(systemPrompt ?? "");
  for (const t of tools) {
    n += estimateTokens(t.name + t.description + JSON.stringify(t.parameters));
  }
  return n;
}

export interface BudgetConfig {
  contextWindow: number;
  /** 触发自动压缩的估算阈值（占窗口比例），默认 0.8。 */
  thresholdPct?: number;
  /** 压缩时保留的最近轮数（每轮 = assistant + 其工具结果），默认 2。 */
  keepRounds?: number;
  /** 压缩策略：滚动摘要（默认）或直接截断。 */
  strategy?: "summary" | "truncate";
}

export class TokenBudget {
  readonly threshold: number;
  readonly keepRounds: number;
  readonly strategy: "summary" | "truncate";
  compactions = 0;
  /** 最近一次 API 返回的真实 prompt_tokens，用于展示。 */
  lastActual: number | null = null;
  /** 实际用量曾越过阈值：粘性标记，直到一次压缩成功才清除。 */
  private actualOverThreshold = false;

  constructor(config: BudgetConfig) {
    this.threshold = Math.floor(config.contextWindow * (config.thresholdPct ?? 0.8));
    this.keepRounds = config.keepRounds ?? 2;
    this.strategy = config.strategy ?? "summary";
  }

  /** 发送前决策：估算超阈值，或实际用量曾超阈值（估算偏小）→ 压缩。 */
  decide(estimate: number): boolean {
    if (estimate >= this.threshold) return true;
    return this.actualOverThreshold;
  }

  recordUsage(promptTokens: number | null | undefined): void {
    this.lastActual = promptTokens ?? null;
    if (promptTokens !== null && promptTokens !== undefined && promptTokens >= this.threshold) {
      this.actualOverThreshold = true;
    }
  }

  /** 压缩成功后清除漂移标记。 */
  markCompacted(): void {
    this.actualOverThreshold = false;
  }
}

/**
 * /compact 指令：独立消息或行首指令（避免"解释一下 /compact"这类
 * 正常问题误触发）。返回指令是否出现以及剥离后的剩余文本。
 */
export function extractCompactCommand(text: string): { compact: boolean; rest: string } {
  const trimmed = text.trim();
  if (trimmed === "/compact") return { compact: true, rest: "" };
  const marker = "/compact";
  if (trimmed.startsWith(marker)) {
    const next = trimmed[marker.length];
    if (next === undefined || /\s/.test(next)) {
      return { compact: true, rest: trimmed.slice(marker.length).trim() };
    }
  }
  return { compact: false, rest: text };
}

/**
 * 找出可压缩区间：保留 [0, firstUserEnd]（system + 原始 user 消息，绝不被压缩）
 * 和最后 keepRounds 轮（assistant 锚定），其余区间可丢弃。
 * 返回 null 表示无可压缩内容。
 */
export function findDropRange(
  messages: NormalizedMessage[],
  keepRounds: number,
): { from: number; to: number } | null {
  let roundsStart = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i]!.role === "user") {
      roundsStart = i + 1;
      break;
    }
  }
  if (roundsStart >= messages.length) return null;

  let keepFrom = roundsStart;
  let kept = 0;
  for (let i = messages.length - 1; i >= roundsStart; i--) {
    if (messages[i]!.role === "assistant") {
      kept++;
      if (kept > keepRounds) break;
      keepFrom = i;
    }
  }
  if (keepFrom <= roundsStart) return null;
  return { from: roundsStart, to: keepFrom };
}

export interface CompactResult {
  messages: NormalizedMessage[];
  dropped: number;
}

/**
 * 压缩。summary 策略：被丢弃区间替换为一条 [对话摘要] user 消息
 * （summaryText 由一次额外的模型调用生成，失败时调用方应回退 truncate）。
 * truncate 策略：从最旧开始丢弃工具结果，直到估算低于阈值。
 */
export function compactMessages(
  messages: NormalizedMessage[],
  keepRounds: number,
  strategy: "summary" | "truncate",
  summaryText: string | null,
  estimateFn: (msgs: NormalizedMessage[]) => number,
  threshold: number,
): CompactResult {
  if (strategy === "truncate") {
    const msgs = [...messages];
    let dropped = 0;
    while (estimateFn(msgs) >= threshold && msgs.some((m) => m.role === "tool")) {
      const idx = msgs.findIndex((m) => m.role === "tool");
      msgs.splice(idx, 1);
      dropped++;
    }
    return { messages: msgs, dropped };
  }

  const range = findDropRange(messages, keepRounds);
  if (!range || !summaryText) return { messages, dropped: 0 };
  const msgs = [...messages];
  const summary: NormalizedMessage = { role: "user", content: `[对话摘要] ${summaryText}` };
  msgs.splice(range.from, range.to - range.from, summary);
  return { messages: msgs, dropped: range.to - range.from };
}

const SUMMARY_PROMPT = `请用简洁的中文总结以下对话内容，保留关键事实、已做的决策、读取过的文件内容要点与待办事项。不要使用工具。\n\n`;

/** 默认摘要实现：用适配器额外调一次模型，把被丢弃的区间压成一段摘要。 */
export async function summarizeWithAdapter(
  adapter: ProviderAdapter,
  model: string,
  dropped: NormalizedMessage[],
): Promise<string> {
  const serialized = dropped
    .map((m) => {
      if (m.role === "assistant") {
        const calls = m.toolCalls?.length ? ` tool_calls=${JSON.stringify(m.toolCalls)}` : "";
        return `assistant: ${m.content ?? ""}${calls}`;
      }
      if (m.role === "tool") return `tool(${m.toolCallId}): ${m.content}`;
      return `${m.role}: ${m.content}`;
    })
    .join("\n")
    .slice(0, 60000);
  const raw = await adapter.chat({
    model,
    messages: [{ role: "user", content: SUMMARY_PROMPT + serialized }],
  });
  const result = normalizeResponse(adapter.info.id, raw);
  return result.content ?? "";
}
