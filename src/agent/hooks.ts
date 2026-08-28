import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Hook system: user-attached logic at the agent's execution key points.
 *
 * Events: PreToolUse (before a tool runs — block or rewrite arguments, the
 * request-level middleware), PostToolUse (after — lint/log), SessionStart
 * (session begins), Stop (agent stops). Configured in a workspace `.hooks`
 * file (JSON array): { name, event, matcher?, handler }.
 *
 * Handler protocol: the context is JSON — command handlers read it on stdin
 * and return a JSON object on stdout; http handlers receive it as a POST
 * body and the response body is parsed. Return {} (pass), { blocked, reason },
 * or { modifiedParams }. Failure policy: PreToolUse fails closed (a broken
 * guard blocks the call), everything else fails open (skip, never block).
 * PreToolUse hooks chain in registration order: blocked short-circuits,
 * modifiedParams feeds the next hook. The built-in security policy runs
 * before hooks — hooks can never bypass it.
 */

export type HookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "Stop";

export type HookHandler =
  | { type: "command"; command: string }
  | { type: "http"; url: string };

export interface HookConfig {
  name: string;
  event: HookEvent;
  /** Tool-name glob for PreToolUse/PostToolUse; missing = all tools. */
  matcher?: string;
  handler: HookHandler;
}

export interface HookContext {
  event: HookEvent;
  tool?: string;
  input?: Record<string, unknown>;
  result?: string;
  workspace: string;
  finalText?: string;
  iterations?: number;
  toolCallsMade?: number;
  aborted?: boolean;
  hook: string;
}

export interface HandlerResult {
  blocked?: boolean;
  reason?: string;
  modifiedParams?: Record<string, unknown>;
  failed?: boolean;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const EVENTS: HookEvent[] = ["PreToolUse", "PostToolUse", "SessionStart", "Stop"];

export function isValidHook(x: unknown): x is HookConfig {
  if (typeof x !== "object" || x === null) return false;
  const h = x as Record<string, unknown>;
  if (typeof h.name !== "string" || !EVENTS.includes(h.event as HookEvent)) return false;
  if (h.matcher !== undefined && typeof h.matcher !== "string") return false;
  const handler = h.handler as Record<string, unknown> | undefined;
  if (!handler || typeof handler !== "object") return false;
  if (handler.type === "command") return typeof handler.command === "string";
  if (handler.type === "http") return typeof handler.url === "string";
  return false;
}

/** 读取工作区 .hooks（JSON 数组）。缺失 → []；损坏 → 大声失败（与 .rules 一致）。 */
export async function loadHooks(workspace: string): Promise<HookConfig[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(workspace, ".hooks"), "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`.hooks 不是合法 JSON：${(e as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('.hooks 应为 JSON 数组，如 [{ "name": "guard", "event": "PreToolUse", "matcher": "bash", "handler": { "type": "command", "command": "node guard.mjs" } }]');
  }
  return parsed.filter(isValidHook);
}

function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher) return true;
  const re = new RegExp(`^${matcher.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
  return re.test(tool);
}

// ---------- handler 执行 ----------

function runCommandHandler(command: string, ctx: HookContext, timeoutMs: number): Promise<HandlerResult> {
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (r: HandlerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ failed: true, error: `timeout ${timeoutMs}ms` });
    }, timeoutMs);
    child.on("error", (e) => finish({ failed: true, error: e.message }));
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) {
        const tail = stderr.trim() ? `：${stderr.trim().slice(0, 200)}` : "";
        finish({ failed: true, error: `exit code ${code}${tail}` });
        return;
      }
      try {
        finish(JSON.parse(stdout) as HandlerResult);
      } catch {
        finish({ failed: true, error: "handler stdout 不是合法 JSON" });
      }
    });
    child.stdin.write(JSON.stringify(ctx));
    child.stdin.end();
  });
}

async function runHttpHandler(url: string, ctx: HookContext, timeoutMs: number): Promise<HandlerResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ctx),
      signal: controller.signal,
    });
    if (!res.ok) return { failed: true, error: `HTTP ${res.status}` };
    const text = await res.text();
    try {
      return JSON.parse(text) as HandlerResult;
    } catch {
      return { failed: true, error: "handler 响应不是合法 JSON" };
    }
  } catch (e) {
    return { failed: true, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** 执行单个 handler；失败返回 { failed, error }（不抛出）。 */
export async function runHandler(
  hook: HookConfig,
  ctx: HookContext,
  opts: { timeoutMs?: number } = {},
): Promise<HandlerResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (hook.handler.type === "command") {
    return runCommandHandler(hook.handler.command, ctx, timeoutMs);
  }
  return runHttpHandler(hook.handler.url, ctx, timeoutMs);
}

// ---------- PreToolUse：中间件链 ----------

export interface PreToolUseResult {
  action: "allow" | "blocked" | "fail-closed";
  params: Record<string, unknown>;
  message?: string;
}

export async function runPreToolUseHooks(
  hooks: HookConfig[],
  ctx: { tool: string; input: Record<string, unknown>; workspace: string },
  opts: { timeoutMs?: number } = {},
): Promise<PreToolUseResult> {
  let params = ctx.input;
  let modified = false;
  for (const hook of hooks) {
    if (hook.event !== "PreToolUse" || !matches(hook.matcher, ctx.tool)) continue;
    const r = await runHandler(hook, { event: "PreToolUse", tool: ctx.tool, input: params, workspace: ctx.workspace, hook: hook.name }, opts);
    if (r.failed) {
      return {
        action: "fail-closed",
        params,
        message: `[hook blocked] Hook「${hook.name}」不可用（${r.error}），按 fail-closed 策略阻止执行。请向用户说明 hook 配置问题，不要尝试绕过。`,
      };
    }
    if (r.blocked) {
      return {
        action: "blocked",
        params,
        message: `[hook blocked] 工具调用被 Hook「${hook.name}」拦截：${r.reason ?? "无原因"}。不要尝试绕过；如确需此操作，请在最终回答中向用户说明。`,
      };
    }
    if (r.modifiedParams) {
      params = { ...params, ...r.modifiedParams };
      modified = true;
    }
  }
  return {
    action: "allow",
    params,
    message: modified
      ? `[hook modified input] 参数已被 Hook 修改，实际执行参数：${JSON.stringify(params)}`
      : undefined,
  };
}

// ---------- 其他事件：fail-open ----------

/** PostToolUse / SessionStart / Stop：逐条执行，失败跳过（fail-open，不阻塞）。 */
export async function dispatchEvent(
  hooks: HookConfig[],
  event: Exclude<HookEvent, "PreToolUse">,
  ctx: Omit<HookContext, "event" | "hook">,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  for (const hook of hooks) {
    if (hook.event !== event) continue;
    if (event !== "SessionStart" && event !== "Stop" && !matches(hook.matcher, (ctx as { tool?: string }).tool ?? "")) continue;
    try {
      await runHandler(hook, { ...ctx, event, hook: hook.name }, opts);
    } catch {
      // fail-open：handler 内部已吞掉失败（runHandler 不抛），此处兜底
    }
  }
}
