// MCP fixture server: a minimal real MCP server (official SDK) for tests & E2E.
// Env knobs:
//   SA_MCP_CRASH_ON_CALL=1  -> crash when echo is called (exit 1)
//   SA_MCP_CRASH_AFTER=ms   -> crash ms after startup
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "sa-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "回显传入的参数",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    { name: "fail", description: "总是返回 isError", inputSchema: { type: "object" } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  if (process.env.SA_MCP_CRASH_ON_CALL === "1" && name === "echo") process.exit(1);
  if (name === "echo") return { content: [{ type: "text", text: `echo:${JSON.stringify(args)}` }], isError: false };
  if (name === "fail") return { content: [{ type: "text", text: "boom" }], isError: true };
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
});

if (process.env.SA_MCP_CRASH_AFTER) {
  setTimeout(() => process.exit(1), Number(process.env.SA_MCP_CRASH_AFTER));
}

await server.connect(new StdioServerTransport());
