import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { ToolEntry } from "../tools/types.js";
import type { McpServerConfig } from "./config.js";

/**
 * MCP 客户端管理器：并行连接所有服务器（失败隔离——一个挂掉只跳过它自己）、
 * 发现工具并适配成 ToolEntry（`mcp_<server>_<tool>` 命名）、路由调用、会话结束关闭。
 * 运行时调用失败返回错误文本（`[mcp error] …`），从不向上抛。
 */

interface ConnectedServer {
  config: McpServerConfig;
  client: Client;
}

interface ToolRecord {
  server: ConnectedServer;
  toolName: string;
  toolDef: { description?: string; inputSchema?: unknown };
}

export interface ConnectResult {
  connected: string[];
  failed: { name: string; error: string }[];
}

export function mcpToolName(server: string, tool: string): string {
  // 分隔符用下划线：provider wire 层（OpenAI/Anthropic）工具名只允许 [a-zA-Z0-9_-]，冒号会 400
  return `mcp_${server}_${tool}`;
}

const CONNECT_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;

function messageOf(e: unknown, fallback: string): string {
  return e instanceof Error ? e.message : String(e ?? fallback);
}

/** tools/call 的 content 数组 → 纯文本（text 拼接，image 给占位）。 */
export function serializeMcpContent(content: unknown[] | undefined): string {
  return (content ?? [])
    .map((c) => {
      const part = c as { type?: string; text?: string; mimeType?: string };
      if (part.type === "image") return `[image ${part.mimeType ?? "unknown"}]`;
      if (part.type === "resource") return `[resource ${String((part as { uri?: string }).uri ?? "")}]`;
      return String(part.text ?? "");
    })
    .join("\n");
}

export class McpManager {
  private servers: ConnectedServer[] = [];
  private toolRecords = new Map<string, ToolRecord>();

  constructor(private configs: McpServerConfig[]) {}

  /** 并行连接全部服务器；每个服务器独立成败，连接失败只跳过它自己。 */
  async connectAll(): Promise<ConnectResult> {
    const results = await Promise.allSettled(this.configs.map((c) => this.connectOne(c)));
    const connected: string[] = [];
    const failed: { name: string; error: string }[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        connected.push(r.value);
      } else {
        const reason = r.reason as { name?: string; error?: string };
        failed.push({ name: reason.name ?? "?", error: reason.error ?? messageOf(r.reason, "unknown error") });
      }
    }
    return { connected, failed };
  }

  private async connectOne(config: McpServerConfig): Promise<string> {
    try {
      const client = new Client({ name: "simple-agent", version: "0.1.0" }, { capabilities: {} });
      const transport =
        config.type === "stdio"
          ? new StdioClientTransport({
              command: config.command,
              args: config.args,
              env: config.env,
              // stderr 默认 inherit：server 日志直接打到终端，方便排查
            })
          : new StreamableHTTPClientTransport(new URL(config.url), {
              requestInit: config.headers ? { headers: config.headers } : undefined,
            });
      await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
      const { tools } = await client.listTools({}, { timeout: CONNECT_TIMEOUT_MS });
      for (const t of tools) {
        const fullName = mcpToolName(config.name, t.name);
        this.toolRecords.set(fullName, {
          server: { config, client },
          toolName: t.name,
          toolDef: { description: t.description, inputSchema: t.inputSchema },
        });
      }
      this.servers.push({ config, client });
      return config.name;
    } catch (e) {
      throw { name: config.name, error: messageOf(e, "connect failed") };
    }
  }

  /** MCP 工具 → 模型可见的 ToolEntry（execute 闭包路由回对应服务器）。 */
  getToolEntries(): ToolEntry[] {
    const entries: ToolEntry[] = [];
    for (const [fullName, rec] of this.toolRecords) {
      entries.push({
        name: fullName,
        description: `[MCP 服务器 "${rec.server.config.name}"] ${rec.toolDef.description ?? ""}`.trim(),
        parameters: (rec.toolDef.inputSchema ?? { type: "object" }) as Record<string, unknown>,
        execute: async (input: Record<string, unknown>): Promise<string> => this.callTool(fullName, input),
      });
    }
    return entries;
  }

  /** 调用 MCP 工具；isError/客户端错误 → `[mcp error] …` 文本，从不抛。 */
  async callTool(fullName: string, args: Record<string, unknown>): Promise<string> {
    const rec = this.toolRecords.get(fullName);
    if (!rec) return `[mcp error] 未知 MCP 工具：${fullName}`;
    try {
      const result = await rec.server.client.callTool(
        { name: rec.toolName, arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
      const text = serializeMcpContent(result.content as unknown[]);
      if (result.isError) return `[mcp error] ${text}`;
      return text;
    } catch (e) {
      return `[mcp error] ${messageOf(e, "call failed")}`;
    }
  }

  /** 关闭全部连接；幂等，从不抛。 */
  async closeAll(): Promise<void> {
    await Promise.allSettled(
      this.servers.map(async (s) => {
        try {
          await s.client.close();
        } catch {
          // 忽略关闭错误
        }
      }),
    );
    this.servers = [];
    this.toolRecords.clear();
  }
}
