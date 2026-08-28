import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * MCP 服务器配置：工作区 .mcp.json（Claude Desktop 格式）。
 * 缺失 → 无服务器；JSON 损坏 / 条目非法 → 大声失败（与 .rules/.hooks 一致）。
 * env 值支持 ${VAR} 插值（从 process.env 读取；未定义 → 空字符串，server 连接会失败并被跳过）。
 */

export interface McpStdioServer {
  name: string;
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpHttpServer {
  name: string;
  type: "http";
  url: string;
  /** 附加请求头（值支持 ${VAR} 插值），如 Authorization: Bearer ${TOKEN}。 */
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export async function loadMcpConfig(workspace: string): Promise<McpServerConfig[]> {
  const file = path.join(workspace, ".mcp.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`.mcp.json 不是合法 JSON：${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error('.mcp.json 应为对象：{ "mcpServers": { "name": { "command": "…" } } }');
  }
  const mcpServers = (parsed as Record<string, unknown>).mcpServers;
  if (typeof mcpServers !== "object" || mcpServers === null || Array.isArray(mcpServers)) {
    throw new Error('.mcp.json 缺少 "mcpServers" 对象');
  }
  const out: McpServerConfig[] = [];
  for (const [name, rawEntry] of Object.entries(mcpServers as Record<string, unknown>)) {
    out.push(parseServer(name, rawEntry));
  }
  return out;
}

function parseServer(name: string, raw: unknown): McpServerConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`.mcp.json 服务器 "${name}" 应为对象`);
  }
  const e = raw as Record<string, unknown>;
  const hasCommand = typeof e.command === "string";
  const hasUrl = typeof e.url === "string";
  if (hasCommand && hasUrl) {
    throw new Error(`.mcp.json 服务器 "${name}" 不能同时声明 command 和 url`);
  }
  if (hasCommand) {
    if (e.args !== undefined && !Array.isArray(e.args)) {
      throw new Error(`.mcp.json 服务器 "${name}" 的 args 应为数组`);
    }
    if (e.env !== undefined && (typeof e.env !== "object" || e.env === null || Array.isArray(e.env))) {
      throw new Error(`.mcp.json 服务器 "${name}" 的 env 应为对象`);
    }
    const rawEnv = (e.env ?? {}) as Record<string, unknown>;
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawEnv)) {
      env[k] = interpolateEnv(String(v));
    }
    return {
      name,
      type: "stdio",
      command: e.command as string,
      args: (e.args as string[]) ?? [],
      env: Object.keys(env).length > 0 ? env : undefined,
    };
  }
  if (hasUrl) {
    let headers: Record<string, string> | undefined;
    if (e.headers !== undefined) {
      if (typeof e.headers !== "object" || e.headers === null || Array.isArray(e.headers)) {
        throw new Error(`.mcp.json 服务器 "${name}" 的 headers 应为对象`);
      }
      headers = {};
      for (const [k, v] of Object.entries(e.headers as Record<string, unknown>)) {
        headers[k] = interpolateEnv(String(v));
      }
    }
    return { name, type: "http", url: e.url as string, headers };
  }
  throw new Error(`.mcp.json 服务器 "${name}" 需要 command（stdio）或 url（http）`);
}

/** `${VAR}` → process.env[VAR]（未定义 → ""）。其余原样保留。 */
export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, v: string) => process.env[v] ?? "");
}
