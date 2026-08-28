# 01 — MCP 支持（tools only，stdio + HTTP）

Status: needs-triage

## Context

simple-agent 只有 8 个内置工具。MCP（Model Context Protocol）让 agent 连接外部工具服务器（本地 stdio 子进程 / 远程 HTTP），动态发现并调用其工具。此 issue 覆盖 spec 的全部范围（`.scratch/mcp/spec.md`）。

## Definition of Done

- [ ] `.mcp.json` 工作区配置（Claude Desktop 格式：`command/args/env` 或 `url`）；缺失 → 空，损坏 → 大声失败
- [ ] `src/mcp/`：config 加载 / McpManager（并行连接、失败隔离）/ 工具适配（`mcp:<server>:<tool>` 命名、描述前缀、schema 透传、结果文本化）
- [ ] MCP 工具并入模型可见工具集；loop 工具查找 = 内置 → MCP
- [ ] MCP 调用走完整流水线：policy（兜底 ask，`.rules` 可 allow `mcp:files:*`）→ PreToolUse hooks → 执行 → PostToolUse hooks
- [ ] 运行时失败（崩溃/超时/isError）→ 错误工具结果，loop 继续；server 连接失败 → stderr 警告 + 跳过该 server
- [ ] 会话 finally 自动关闭全部连接；`--verbose` 输出 `[mcp=…]`
- [ ] 测试：config / 真实子进程 fixture server 协议往返 / 适配 / 安全 / loop 集成 / 真机 E2E；全绿 + typecheck + build
- [ ] 文档：README 段落、CONTEXT.md 词条、`.mcp.json.example`、ADR-0005
- [ ] 原型归档 `prototype/mcp` 分支（含裁决记录）
- [ ] 双轴评审 0/0、提交、推送

## Prototype pointer

- 分支：`prototype/mcp`（落地后）
- 文件：`src/prototype-mcp.html`
- 裁决：见原型 Further Notes / issue 更新

## Notes

- 关键决策点（原型已裁决，用户逐项确认）：① 官方 `@modelcontextprotocol/sdk`；② MCP 工具安全兜底 ask（`.rules` 可 allow `mcp_files_*`）；③ 连接失败 → 警告 + 跳过该 server，会话继续；④ `mcp_<server>_<tool>` 命名（原型为 `mcp:server:tool`——真机 E2E 发现 provider wire 层拒绝冒号，`^[a-zA-Z0-9_-]+$`，改用下划线）；⑤ `.mcp.json` Claude Desktop 格式；⑥ stdio + streamable HTTP 双传输（无 OAuth）
- policy 变更：`.rules` 的 `tool` 字段改为 glob 匹配（字面量规则行为不变）
