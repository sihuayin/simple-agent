import { describe, expect, it, vi } from "vitest";

import type { DeepseekRaw, NormalizedMessage } from "../../src/adapters/types.js";
import {
  compactMessages,
  estimateConversation,
  estimateTokens,
  extractCompactCommand,
  findDropRange,
  fixedTokensFor,
  summarizeWithAdapter,
  TokenBudget,
} from "../../src/agent/budget.js";

describe("estimateTokens", () => {
  it("counts CJK at 1.5 chars/token", () => {
    expect(estimateTokens("你好世界你好")).toBe(4); // 6 CJK → ceil(6/1.5)
  });

  it("counts everything else at 4 chars/token", () => {
    expect(estimateTokens("hello world")).toBe(3); // 11 chars → ceil(11/4)
  });

  it("handles mixed content", () => {
    expect(estimateTokens("修复bug")).toBe(3); // 2 CJK (ceil 2/1.5=2) + 3 ascii (ceil 3/4=1)
  });
});

describe("extractCompactCommand", () => {
  it("detects a standalone /compact", () => {
    expect(extractCompactCommand("/compact")).toEqual({ compact: true, rest: "" });
  });

  it("detects /compact at the start of a line", () => {
    expect(extractCompactCommand("/compact 然后总结")).toEqual({ compact: true, rest: "然后总结" });
  });

  it("does not trigger on /compact inside a sentence", () => {
    expect(extractCompactCommand("解释一下 /compact 命令")).toEqual({ compact: false, rest: "解释一下 /compact 命令" });
    expect(extractCompactCommand("read /compact")).toEqual({ compact: false, rest: "read /compact" });
  });
});

describe("TokenBudget", () => {
  it("computes the threshold from the context window", () => {
    expect(new TokenBudget({ contextWindow: 20000 }).threshold).toBe(16000);
    expect(new TokenBudget({ contextWindow: 384000, thresholdPct: 0.9 }).threshold).toBe(345600);
  });

  it("decides compact when the estimate crosses the threshold", () => {
    const b = new TokenBudget({ contextWindow: 20000 });
    expect(b.decide(15999)).toBe(false);
    expect(b.decide(16000)).toBe(true);
  });

  it("decides compact on drift and stays sticky until a compaction succeeds", () => {
    const b = new TokenBudget({ contextWindow: 20000 });
    b.recordUsage(20000);
    expect(b.decide(100)).toBe(true); // 估算低，但实际用量已超
    b.recordUsage(500); // 后续轮次实际用量回落
    expect(b.decide(100)).toBe(true); // 漂移标记仍粘性生效
    b.markCompacted();
    expect(b.decide(100)).toBe(false);
  });
});

describe("findDropRange", () => {
  const sys: NormalizedMessage = { role: "system", content: "sys" };
  const user: NormalizedMessage = { role: "user", content: "task" };
  const round = (n: number): NormalizedMessage[] => [
    { role: "assistant", content: `a${n}`, toolCalls: [{ id: `c${n}`, name: "x", input: {} }] },
    { role: "tool", toolCallId: `c${n}`, content: `tool result ${n}` },
  ];

  it("keeps system+user and the last keepRounds rounds", () => {
    const msgs = [sys, user, ...round(1), ...round(2), ...round(3)];
    const range = findDropRange(msgs, 2)!;
    expect(range).toEqual({ from: 2, to: 4 }); // 丢 round 1（a1+t1），保留 round 2、3
  });

  it("returns null when nothing is droppable", () => {
    expect(findDropRange([sys, user, ...round(1), ...round(2)], 2)).toBeNull();
    expect(findDropRange([user], 2)).toBeNull();
  });
});

describe("compactMessages", () => {
  const sys: NormalizedMessage = { role: "system", content: "sys" };
  const user: NormalizedMessage = { role: "user", content: "task" };
  const round = (n: number): NormalizedMessage[] => [
    { role: "assistant", content: `a${n}`, toolCalls: [{ id: `c${n}`, name: "x", input: {} }] },
    { role: "tool", toolCallId: `c${n}`, content: `tool result ${n}` },
  ];
  const est = (msgs: NormalizedMessage[]) => estimateConversation(msgs, 0);

  it("summary strategy replaces the dropped prefix with a [对话摘要] user message", () => {
    const msgs = [sys, user, ...round(1), ...round(2), ...round(3)];
    const out = compactMessages(msgs, 2, "summary", "要点保留", est, 16000);
    expect(out.dropped).toBe(2);
    expect(out.messages.filter((m) => m.role === "tool")).toHaveLength(2); // 只剩 round 2、3
    const summary = out.messages.find((m) => m.role === "user" && m.content.startsWith("[对话摘要]"));
    expect(summary).toBeDefined();
    expect(out.messages[0]).toEqual(sys);
    expect(out.messages[1]).toEqual(user);
  });

  it("summary strategy with no droppable range is a no-op", () => {
    const msgs = [sys, user, ...round(1), ...round(2)];
    const out = compactMessages(msgs, 2, "summary", "要点", est, 16000);
    expect(out.dropped).toBe(0);
    expect(out.messages).toEqual(msgs);
  });

  it("truncate strategy drops the oldest tool results until under the threshold", () => {
    const bigTool: NormalizedMessage = { role: "tool", toolCallId: "b", content: "x".repeat(20000) };
    const msgs: NormalizedMessage[] = [
      user,
      { role: "assistant", content: "a", toolCalls: [{ id: "b", name: "x", input: {} }] },
      bigTool,
    ];
    const out = compactMessages(msgs, 1, "truncate", null, est, 2000);
    expect(out.dropped).toBeGreaterThan(0);
    expect(est(out.messages)).toBeLessThan(2000);
    expect(out.messages.some((m) => m.role === "tool")).toBe(false);
  });
});

describe("fixedTokensFor", () => {
  it("counts the system prompt and tool schemas", () => {
    const n = fixedTokensFor("系统提示", [{ name: "read_file", description: "读文件", parameters: { type: "object" } }]);
    expect(n).toBeGreaterThan(0);
  });
});

describe("summarizeWithAdapter", () => {
  it("sends the dropped messages to the model and returns the summary", async () => {
    const chat = vi.fn(async (_input: { messages: NormalizedMessage[] }): Promise<DeepseekRaw> => ({
      model: "m",
      choices: [{ message: { content: "浓缩摘要" } }],
    }));
    const adapter = {
      info: { id: "deepseek" as const, name: "DeepSeek", defaultModel: "deepseek-v4-flash", keyEnvVar: "DEEPSEEK_API_KEY", modelEnvVar: "DEEPSEEK_MODEL", baseUrlEnvVar: "DEEPSEEK_BASE_URL", defaultBaseUrl: "https://api.deepseek.com" },
      chat,
    };
    const dropped: NormalizedMessage[] = [{ role: "tool", toolCallId: "c1", content: "file content here" }];
    const summary = await summarizeWithAdapter(adapter, "m", dropped);
    expect(summary).toBe("浓缩摘要");
    const sent = chat.mock.calls[0]![0] as { messages: NormalizedMessage[] };
    expect(sent.messages[0]!.content).toContain("file content here");
    expect(sent.messages[0]!.content).toContain("总结");  });
});
