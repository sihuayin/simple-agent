import type { ToolContext, ToolEntry } from "./types.js";
import { loadMemoryStore, remember, saveMemoryStore } from "../agent/memory.js";

/**
 * remember：自动记忆。模型判断某信息"下次新会话还有用"（用户偏好、
 * 项目约定、用户对行为的纠正）时调用。无确认环节——落库即生效，
 * 下次会话自动加载进系统提示词。同主题同类型会覆盖（保留历史版本）。
 */
export const rememberTool: ToolEntry = {
  name: "remember",
  description:
    "Store a memory that will auto-load into every future session: user preferences (language, naming style — type=user), project conventions (architecture, tech constraints — type=project), or user corrections of your behavior (type=feedback). Only store what would still be useful in a new session — never transient debug info, one-off task details, or code fragments. Same topic overwrites the previous entry (versioned). Returns what happened.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["user", "project", "feedback"], description: "user = personal preference (global, all projects); project = convention for the current project; feedback = a correction of your behavior for the current project" },
      topic: { type: "string", description: "Short stable topic key, e.g. language, naming, deploy-order. Same topic + same type overwrites." },
      text: { type: "string", description: "The memory text, concise and actionable, in Chinese." },
    },
    required: ["type", "topic", "text"],
  },
  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string> {
    const type = String(input.type ?? "");
    const topic = String(input.topic ?? "").trim();
    const text = String(input.text ?? "").trim();
    if (type !== "user" && type !== "project" && type !== "feedback") {
      return `[remember] type 必须是 user | project | feedback，收到：${JSON.stringify(input.type)}`;
    }
    if (!topic || !text) {
      return "[remember] topic 和 text 不能为空。如果这条信息不值得记（临时调试、一次性任务、代码片段），就不要调用本工具。";
    }
    const store = await loadMemoryStore(ctx.workspace);
    const { store: next, result } = remember(store, {
      type,
      topic,
      text,
      sourceProject: ctx.workspace,
      global: type === "user",
    });
    await saveMemoryStore(next, ctx.workspace);
    if (result.kind === "rejected") return `[remember] 已拒绝：${result.reason}`;
    const tag = type === "user" ? "全局（跨项目生效）" : `项目级（仅 ${ctx.workspace}）`;
    return result.kind === "added"
      ? `[remember] 已记住（${tag}，${result.memory.topic}）：${result.memory.text}`
      : `[remember] 已覆盖为 v${result.memory.version}（${tag}，${result.memory.topic}）：${result.memory.text}（旧文本已进历史）`;
  },
};
