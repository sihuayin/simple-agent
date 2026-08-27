import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildSystemPrompt } from "../../src/agent/system_prompt.js";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sa-prompt-"));
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("buildSystemPrompt", () => {
  it("starts with the role layer (coding assistant, step-by-step, tools)", async () => {
    const prompt = await buildSystemPrompt(root);
    expect(prompt).toContain("你是一个编码助手，帮助用户构建真实项目");
    expect(prompt).toContain("一步步思考");
    expect(prompt).toContain("可以使用工具");
  });

  it("includes the general rules layer", async () => {
    const prompt = await buildSystemPrompt(root);
    expect(prompt).toContain("禁止破坏性操作");
    expect(prompt).toContain("rm -rf");
    expect(prompt).toContain("编辑或覆盖文件前");
    expect(prompt).toContain("阻塞等待输入");
    expect(prompt).toContain("最终回答中不要再调用工具");
    expect(prompt).toContain("[TRUNCATED]");
  });

  it("omits the project layer when AGENTS.md is missing", async () => {
    const prompt = await buildSystemPrompt(root);
    expect(prompt).not.toContain("AGENTS.md");
  });

  it("appends the project layer from AGENTS.md when present", async () => {
    await fs.writeFile(path.join(root, "AGENTS.md"), "项目约束：保持测试绿。");
    const prompt = await buildSystemPrompt(root);
    expect(prompt).toContain("项目基础设定与开发约束");
    expect(prompt).toContain("保持测试绿");
  });

  it("orders layers stably: role → rules → project settings", async () => {
    await fs.writeFile(path.join(root, "AGENTS.md"), "项目约束：保持测试绿。");
    const prompt = await buildSystemPrompt(root);
    const role = prompt.indexOf("你是一个编码助手");
    const rules = prompt.indexOf("通用规则");
    const project = prompt.indexOf("项目基础设定");
    expect(role).toBeGreaterThanOrEqual(0);
    expect(rules).toBeGreaterThan(role);
    expect(project).toBeGreaterThan(rules);
  });
});
