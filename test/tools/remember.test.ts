import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildMemorySection, buildSystemPrompt } from "../../src/agent/system_prompt.js";
import type { Memory } from "../../src/agent/memory.js";
import { rememberTool } from "../../src/tools/remember.js";
import { TOOLS, toolSpecs } from "../../src/tools/registry.js";

let root: string;
let home: string;
let ctx: { workspace: string; cwd: string; env: NodeJS.ProcessEnv };

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sa-remember-"));
  home = await fs.mkdtemp(path.join(root, "home-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const workspace = path.join(root, "proj");
  await fs.mkdir(workspace, { recursive: true });
  ctx = { workspace, cwd: workspace, env: process.env };
});

afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const mem = (m: Partial<Memory> & { type: Memory["type"]; topic: string; text: string }): Memory => ({
  id: "x",
  scope: "global",
  sourceProject: "p",
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  history: [],
  ...m,
});

describe("remember tool", () => {
  it("is registered and advertised with type/topic/text", () => {
    expect(TOOLS.remember).toBeDefined();
    const spec = toolSpecs().find((s) => s.name === "remember")!;
    expect(spec.parameters.properties).toHaveProperty("type");
    expect(spec.parameters.properties).toHaveProperty("topic");
    expect(spec.parameters.properties).toHaveProperty("text");
    expect(spec.description).toMatch(/useful in a new session/);
  });

  it("stores a user memory to the global file", async () => {
    const out = await rememberTool.execute({ type: "user", topic: "language", text: "回复用中文" }, ctx);
    expect(out).toContain("已记住");
    expect(out).toContain("全局");
    const file = path.join(home, ".simple-agent", "memory.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { memories: Memory[] };
    expect(raw.memories[0]).toMatchObject({ type: "user", topic: "language", text: "回复用中文", scope: "global" });
  });

  it("overwrites same topic+type (version+1) and reports it", async () => {
    await rememberTool.execute({ type: "project", topic: "deploy", text: "先跑 migrate", }, ctx);
    const out = await rememberTool.execute({ type: "project", topic: "deploy", text: "先跑 migrate 再跑测试" }, ctx);
    expect(out).toContain("已覆盖为 v2");
    const file = path.join(ctx.workspace, ".simple-agent", "memory.json");
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as { memories: Memory[] };
    expect(raw.memories[0]).toMatchObject({ type: "project", version: 2, text: "先跑 migrate 再跑测试" });
  });

  it("rejects invalid type and empty text", async () => {
    expect(await rememberTool.execute({ type: "bogus", topic: "x", text: "y" }, ctx)).toContain("type 必须是");
    expect(await rememberTool.execute({ type: "user", topic: "", text: "" }, ctx)).toContain("不能为空");
  });
});

describe("buildMemorySection", () => {
  it("returns null for no memories", () => {
    expect(buildMemorySection([])).toBeNull();
  });

  it("renders typed bullets", () => {
    const section = buildMemorySection([
      mem({ id: "u1", type: "user", scope: "global", topic: "language", text: "回复用中文" }),
      mem({ id: "p1", type: "project", scope: "p", topic: "style", text: "不要用 class" }),
      mem({ id: "f1", type: "feedback", scope: "p", topic: "deploy", text: "先跑 migrate" }),
    ]);
    expect(section).toContain("记忆（来自历史会话");
    expect(section).toContain("[用户偏好（全局）] 回复用中文");
    expect(section).toContain("[项目约定] 不要用 class");
    expect(section).toContain("[反馈纠正");
  });
});

describe("buildSystemPrompt memory layer", () => {
  it("appends the memory layer after the project layer", async () => {
    const prompt = await buildSystemPrompt(ctx.workspace, [mem({ id: "u1", type: "user", scope: "global", topic: "language", text: "回复用中文" })]);
    expect(prompt).toContain("记忆（来自历史会话");
    // 层序：角色 → 规则 → 项目 → 记忆
    expect(prompt.indexOf("通用规则")).toBeLessThan(prompt.indexOf("记忆（来自历史会话"));
  });

  it("omits the layer when there are no memories", async () => {
    const prompt = await buildSystemPrompt(ctx.workspace);
    expect(prompt).not.toContain("记忆（来自历史会话");
  });
});
