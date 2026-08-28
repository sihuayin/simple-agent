import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

/**
 * 权限与安全策略：Deny / Allow / Ask 三轮评估 + 受保护路径。
 *
 * 评估顺序：deny → ask → allow，未命中任何规则则兜底 ask。
 * 同类型规则按数组顺序先命中生效。兜底是三轮后的默认值，
 * 不能写成数组里的规则（会遮蔽所有 allow）。
 *
 * 规则来源：内置默认（DEFAULT_RULES）+ 工作区 .rules 文件（追加在默认之后）。
 * ask 的交互：TTY 下用 readline 询问用户；非交互自动阻止并回喂模型。
 * 受保护路径：独立清单，即使 allow 命中，文件工具的目标路径匹配仍转 ask。
 */

export type PolicyAction = "deny" | "ask" | "allow";

export interface PolicyRule {
  tool: string;
  /** 缺省 = 工具级规则（任意调用都匹配）。bash 的 pattern 匹配命令串（glob，`*` 含斜杠）。 */
  pattern?: string;
  action: PolicyAction;
}

// ---- Deny：后果不可逆、Agent 没有合理理由调用 ----
const DENY_RULES: PolicyRule[] = [
  { tool: "bash", pattern: "rm -rf /", action: "deny" },
  { tool: "bash", pattern: "rm -rf /*", action: "deny" },
  { tool: "bash", pattern: "sudo rm -rf /*", action: "deny" },
  { tool: "bash", pattern: "dd*", action: "deny" }, // 直接操作磁盘块
  { tool: "bash", pattern: "curl * | *sh", action: "deny" }, // 下载即执行
  { tool: "bash", pattern: "wget * | *sh", action: "deny" },
];

// ---- Ask：危险但可恢复 / 写操作始终确认 ----
const ASK_RULES: PolicyRule[] = [
  { tool: "bash", pattern: "git push --force*", action: "ask" },
  { tool: "bash", pattern: "git reset --hard*", action: "ask" },
  { tool: "bash", pattern: "git clean -f*", action: "ask" },
  { tool: "bash", pattern: "rm -r*", action: "ask" }, // 非根目录的递归删除
  { tool: "write_file", action: "ask" },
  { tool: "edit_file", action: "ask" },
];

// ---- Allow：日常安全操作。注意：bash 不放读取类命令（cat 等）——
// 否则会绕过受保护路径检查；模型应使用带路径检查的 read_file。 ----
const ALLOW_RULES: PolicyRule[] = [
  { tool: "bash", pattern: "npm run *", action: "allow" },
  { tool: "bash", pattern: "npm *", action: "allow" },
  { tool: "bash", pattern: "git status*", action: "allow" },
  { tool: "bash", pattern: "git log*", action: "allow" },
  { tool: "bash", pattern: "git diff*", action: "allow" },
  { tool: "bash", pattern: "git branch*", action: "allow" },
  { tool: "bash", pattern: "ls*", action: "allow" },
  { tool: "bash", pattern: "pwd", action: "allow" },
  { tool: "read_file", action: "allow" },
  { tool: "grep", action: "allow" },
  { tool: "glob", action: "allow" },
  { tool: "list_files", action: "allow" },
  // remember 只写记忆文件（~/.simple-agent/ 与工作区 .simple-agent/），不碰项目源码——自动落库无需确认
  { tool: "remember", action: "allow" },
];

export const DEFAULT_RULES: PolicyRule[] = [...DENY_RULES, ...ASK_RULES, ...ALLOW_RULES];

export const DEFAULT_PROTECTED_PATHS: string[] = [
  ".git/**",
  ".env*",
  ".claude/**",
  ".vscode/**",
  "node_modules/**",
  "**/*.key",
  "**/*.pem",
  "**/credentials*",
  "**/secret*",
];

const FILE_TOOLS = new Set(["read_file", "write_file", "edit_file", "grep", "glob", "list_files"]);

// ---------- 匹配 ----------
/**
 * pathStyle=true：`*` 匹配单个路径段内任意字符（路径/受保护列表）；
 * pathStyle=false：`*` 匹配任意字符含斜杠（bash 命令串，如 `dd if=/dev/sda`、`curl * | *sh`）。
 */
export function globToRegex(pattern: string, pathStyle: boolean): RegExp {
  const star = pathStyle ? "[^/]*" : ".*";
  const source = pattern
    .split("/")
    .map((seg) =>
      seg === "**" && pathStyle ? ".*" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, star),
    )
    .join("/");
  return new RegExp(`^${source}$`);
}

export function ruleMatches(
  toolName: string,
  rule: PolicyRule,
  args: { command?: string; path?: string },
): boolean {
  // tool 字段按 glob 匹配（`mcp_files_*` 匹配该服务器全部工具；无通配符时即精确匹配）
  if (!globToRegex(rule.tool, false).test(toolName)) return false;
  if (rule.pattern === undefined) return true; // 工具级规则
  const target = toolName === "bash" ? String(args.command ?? "") : String(args.path ?? "");
  return globToRegex(rule.pattern, toolName !== "bash").test(target);
}

export function pathHitsProtected(filePath: string | undefined, protectedPaths: string[]): boolean {
  const normalized = String(filePath ?? "").replace(/^\.\//, "");
  if (!normalized) return false;
  return protectedPaths.some((p) => globToRegex(p, true).test(normalized));
}

// ---------- 评估（三轮：deny → ask → allow；未命中兜底 ask） ----------
export interface PolicyDecision {
  action: PolicyAction;
  rule: PolicyRule | null;
  overridden: boolean;
  fallback: boolean;
}

export interface ToolCandidate {
  tool: string;
  command?: string;
  path?: string;
}

export function candidateFor(toolName: string, input: Record<string, unknown>): ToolCandidate {
  if (toolName === "bash") {
    return { tool: toolName, command: String(input.command ?? "") };
  }
  if (FILE_TOOLS.has(toolName)) {
    return { tool: toolName, path: input.path === undefined ? undefined : String(input.path) };
  }
  return { tool: toolName };
}

export function evaluatePolicy(
  candidate: ToolCandidate,
  rules: PolicyRule[],
  protectedPaths: string[],
): PolicyDecision {
  for (const pass of ["deny", "ask", "allow"] as const) {
    for (const rule of rules) {
      if (rule.action !== pass) continue;
      if (!ruleMatches(candidate.tool, rule, candidate)) continue;
      if (pass === "allow" && FILE_TOOLS.has(candidate.tool) && pathHitsProtected(candidate.path, protectedPaths)) {
        return { action: "ask", rule, overridden: true, fallback: false };
      }
      return { action: pass, rule, overridden: false, fallback: false };
    }
  }
  return { action: "ask", rule: null, overridden: false, fallback: true };
}

// ---------- 反馈消息（模型收到的内容） ----------
function describeCandidate(c: ToolCandidate): string {
  return c.tool === "bash" ? `命令 ${JSON.stringify(c.command)}` : `${c.tool}(${JSON.stringify(c.path ?? "")})`;
}

function reasonFor(decision: PolicyDecision): string {
  if (decision.rule) {
    return `（规则：${decision.rule.pattern ?? decision.rule.tool}${decision.overridden ? "；且目标路径命中受保护列表" : ""}）`;
  }
  return "（未命中任何规则——兜底）";
}

export function policyFeedbackMessage(decision: PolicyDecision, candidate: ToolCandidate): string {
  const what = describeCandidate(candidate);
  if (decision.action === "deny") {
    const r = decision.rule;
    return `[permission denied] ${what} 被安全策略阻止（Deny：${r?.pattern ?? r?.tool}）。不要尝试绕过；如确需此操作，请在最终回答中向用户说明。`;
  }
  return `[permission required] ${what} 需要人类确认${reasonFor(decision)}。请在最终回答中向用户说明或给出替代方案。`;
}

/** ask 被用户明确拒绝时的反馈（带原因，模型才能向用户解释）。 */
export function askRejectedMessage(decision: PolicyDecision, candidate: ToolCandidate): string {
  return `[permission denied by user] ${describeCandidate(candidate)} 未获确认，未执行${reasonFor(decision)}。请在最终回答中向用户说明。`;
}

// ---------- 规则加载：内置默认 + 工作区 .rules ----------
export function isValidRule(x: unknown): x is PolicyRule {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.tool === "string" &&
    (r.action === "deny" || r.action === "ask" || r.action === "allow") &&
    (r.pattern === undefined || typeof r.pattern === "string")
  );
}

/**
 * 读取工作区 .rules（JSON 数组，追加在默认规则之后；同类型中默认先命中）。
 * 文件缺失 → 仅默认；JSON 损坏 → 抛错（安全配置错误应大声失败，不能悄悄失效）。
 */
export async function loadRules(workspace: string): Promise<PolicyRule[]> {
  const file = path.join(workspace, ".rules");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [...DEFAULT_RULES];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`.rules 不是合法 JSON：${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(".rules 应为 JSON 数组，如 [{ \"tool\": \"bash\", \"pattern\": \"git push*\", \"action\": \"ask\" }]");
  }
  const userRules = parsed.filter(isValidRule);
  return [...DEFAULT_RULES, ...userRules];
}

// ---------- ask 交互：TTY 用 readline 询问；非交互自动阻止 ----------
export async function defaultAsk(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false; // 非交互：不允许，回喂模型
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(`${message}\n是否允许执行？[y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
