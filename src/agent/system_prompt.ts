import { promises as fs } from "node:fs";
import path from "node:path";

import type { Memory } from "./memory.js";

const PROJECT_SETTINGS_CAP = 20000;

/** 第一层：角色定义。最稳定，位于最上层，优先命中缓存前缀。 */
const LAYER_ROLE = `你是一个编码助手，帮助用户构建真实项目。
你可以使用工具来读取、写入、编辑、搜索文件以及执行命令。
遇到任务时一步步思考：把任务拆成步骤；每次拿到工具结果后，评估结果并决定下一步；确认任务完成后再给出最终回答。`;

/** 第二层：通用规则。稳定不变，位于角色层之后。 */
const LAYER_RULES = `通用规则：
- 禁止破坏性操作：不执行 rm -rf、git push --force、git reset --hard、git clean -f 等会破坏文件或历史记录的命令；如果任务确实需要，在最终回答中提出方案，而不是直接执行。
- 编辑或覆盖文件前，先用 read_file 确认文件存在及其当前内容。
- 不运行会阻塞等待输入的交互式命令。
- read_file 每次最多返回 maxLines 行；结果出现 [TRUNCATED] 标记时，按提示的 offset 继续读取，直到标记消失，不要假设文件已读完。
- 文件操作优先使用 read_file、grep、glob、list_files，而不是 bash。
- 任务完成后再给出简洁的最终回答；最终回答中不要再调用工具。`;

/** 第三层：项目基础设定。从工作区 AGENTS.md 读取，缺失时该层留空。 */
async function loadProjectLayer(workspace: string): Promise<string | null> {
  let content: string;
  try {
    content = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf8");
  } catch {
    return null;
  }
  if (!content.trim()) return null;
  if (content.length > PROJECT_SETTINGS_CAP) {
    content = content.slice(0, PROJECT_SETTINGS_CAP) + "\n…（内容过长已截断）";
  }
  return `项目基础设定与开发约束（来自项目 AGENTS.md），开发时遵守：\n${content}`;
}

/** 记忆层：从历史会话注入的记忆（user 全局 + 当前项目级）。 */
export function buildMemorySection(injected: Memory[]): string | null {
  if (injected.length === 0) return null;
  const labels: Record<Memory["type"], string> = {
    user: "用户偏好（全局）",
    project: "项目约定",
    feedback: "反馈纠正（历史会话中的修正）",
  };
  const lines = injected
    .map((m) => `- [${labels[m.type]}] ${m.text}`)
    .join("\n");
  return `记忆（来自历史会话，自动加载，请遵守）：\n${lines}`;
}

/**
 * 分层系统提示词。稳定内容在前：两家提供方的提示缓存都是前缀匹配
 * （DeepSeek 自动 KV 缓存；Anthropic cache_control 断点），因此
 * 角色 → 规则 → 项目设定的稳定前缀会在多次请求间被复用。见 ADR-0001。
 * 记忆层排在项目设定之后（变化频率高于前缀，且越晚越不容易失效）。
 */
export async function buildSystemPrompt(
  workspace: string,
  injectedMemories: Memory[] = [],
): Promise<string> {
  const layers = [LAYER_ROLE, LAYER_RULES];
  const project = await loadProjectLayer(workspace);
  if (project) layers.push(project);
  const memory = buildMemorySection(injectedMemories);
  if (memory) layers.push(memory);
  return layers.join("\n\n");
}
