import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  forget,
  loadForSession,
  loadMemoryStore,
  memoryFilePaths,
  remember,
  saveMemoryStore,
  type Memory,
  type MemoryStore,
} from "../../src/agent/memory.js";

let root: string;
let home: string;
const PROJECT_A = path.join(os.tmpdir(), "sa-mem-proj-a");
const PROJECT_B = path.join(os.tmpdir(), "sa-mem-proj-b");

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sa-memory-"));
  home = await fs.mkdtemp(path.join(root, "home-"));
  vi.spyOn(os, "homedir").mockReturnValue(home); // 隔离真实 ~/.simple-agent
});

afterAll(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

const base = (): MemoryStore => ({ memories: [] });
const mem = (m: Partial<Memory> & { type: Memory["type"]; topic: string; text: string }): Memory => ({
  id: "x",
  scope: "global",
  sourceProject: PROJECT_A,
  createdAt: 0,
  updatedAt: 0,
  version: 1,
  history: [],
  ...m,
});

describe("remember: 自动落库", () => {
  it("adds a new memory and reports added", () => {
    const r = remember(base(), { type: "user", topic: "language", text: "回复用中文", sourceProject: PROJECT_A, global: true });
    expect(r.result.kind).toBe("added");
    expect(r.store.memories).toHaveLength(1);
    expect(r.store.memories[0]).toMatchObject({ type: "user", topic: "language", text: "回复用中文", scope: "global", version: 1 });
  });

  it("overwrites same topic + type + scope with version+1 and history", () => {
    let s = remember(base(), { type: "feedback", topic: "deploy", text: "部署时要先跑 migrate", sourceProject: PROJECT_A, global: false }).store;
    s = remember(s, { type: "feedback", topic: "deploy", text: "先跑 migrate 再跑测试", sourceProject: PROJECT_A, global: false }).store;
    expect(s.memories).toHaveLength(1);
    const m = s.memories[0]!;
    expect(m.version).toBe(2);
    expect(m.history).toHaveLength(1);
    expect(m.history[0]!.text).toBe("部署时要先跑 migrate");
  });

  it("does NOT overwrite across types on the same topic", () => {
    let s = remember(base(), { type: "user", topic: "naming", text: "camelCase", sourceProject: PROJECT_A, global: true }).store;
    s = remember(s, { type: "project", topic: "naming", text: "camelCase", sourceProject: PROJECT_A, global: false }).store;
    expect(s.memories).toHaveLength(2);
  });

  it("rejects empty text or topic without writing", () => {
    const r = remember(base(), { type: "project", topic: "", text: "  ", sourceProject: PROJECT_A, global: false });
    expect(r.result.kind).toBe("rejected");
    expect(r.store.memories).toHaveLength(0);
  });
});

describe("loadForSession: 过滤 + 冲突裁定", () => {
  it("injects global + this-project memories; drops other projects'", () => {
    const store = {
      memories: [
        mem({ id: "u1", type: "user", scope: "global", topic: "language", text: "回复用中文", updatedAt: 1 }),
        mem({ id: "p1", type: "project", scope: PROJECT_A, topic: "style", text: "不要用 class", updatedAt: 2 }),
        mem({ id: "p2", type: "project", scope: PROJECT_B, topic: "style", text: "B 的约定", updatedAt: 3 }),
      ],
    };
    const r = loadForSession(store, PROJECT_A);
    expect(r.injected.map((m) => m.id)).toEqual(["u1", "p1"]);
    expect(r.dropped.map((m) => m.id)).toEqual(["p2"]);
  });

  it("project/feedback beat global on the same topic; loser is suppressed, not deleted", () => {
    const store = {
      memories: [
        mem({ id: "u1", type: "user", scope: "global", topic: "naming", text: "snake_case", updatedAt: 9 }),
        mem({ id: "p1", type: "project", scope: PROJECT_A, topic: "naming", text: "camelCase", updatedAt: 2 }),
      ],
    };
    const r = loadForSession(store, PROJECT_A);
    expect(r.injected.map((m) => m.id)).toEqual(["p1"]);
    expect(r.suppressed.map((x) => x.mem.id)).toEqual(["u1"]);
    expect(r.suppressed[0]!.reason).toMatch(/用户偏好/);
    expect(store.memories).toHaveLength(2); // 没删
  });

  it("within the same level, the newest updatedAt wins", () => {
    const store = {
      memories: [
        mem({ id: "p1", type: "project", scope: PROJECT_A, topic: "deploy", text: "先跑 migrate", updatedAt: 2 }),
        mem({ id: "f1", type: "feedback", scope: PROJECT_A, topic: "deploy", text: "先跑 migrate 再跑测试", updatedAt: 8 }),
      ],
    };
    const r = loadForSession(store, PROJECT_A);
    expect(r.injected.map((m) => m.id)).toEqual(["f1"]);
    expect(r.suppressed.map((x) => x.mem.id)).toEqual(["p1"]);
    expect(r.suppressed[0]!.reason).toMatch(/更新的/);
  });
});

describe("forget", () => {
  it("removes a memory by id", () => {
    const s = remember(base(), { type: "user", topic: "language", text: "回复用中文", sourceProject: PROJECT_A, global: true }).store;
    const r = forget(s, s.memories[0]!.id);
    expect(r.memories).toHaveLength(0);
  });
});

describe("IO: 文件读写", () => {
  // 每个用例独立 HOME + workspace，避免全局文件串扰
  async function fresh(): Promise<{ workspace: string; cleanup: () => Promise<void> }> {
    const home = await fs.mkdtemp(path.join(root, "home-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const workspace = path.join(root, `io-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(workspace, { recursive: true });
    return { workspace, cleanup: async () => fs.rm(home, { recursive: true, force: true }) };
  }

  it("routes global vs project memories to the two files", async () => {
    const { workspace } = await fresh();
    const { globalFile, projectFile } = memoryFilePaths(workspace);
    await saveMemoryStore(
      {
        memories: [
          mem({ id: "u1", type: "user", scope: "global", topic: "language", text: "回复用中文" }),
          mem({ id: "p1", type: "project", scope: workspace, topic: "style", text: "不要用 class" }),
        ],
      },
      workspace,
    );
    const globalRaw = JSON.parse(await fs.readFile(globalFile, "utf8")) as { memories: Memory[] };
    const projRaw = JSON.parse(await fs.readFile(projectFile, "utf8")) as { memories: Memory[] };
    expect(globalRaw.memories).toHaveLength(1);
    expect(globalRaw.memories[0]!.type).toBe("user");
    expect(projRaw.memories).toHaveLength(1);
    expect(projRaw.memories[0]!.type).toBe("project");
  });

  it("round-trips: load after save returns the same memories", async () => {
    const { workspace } = await fresh();
    const store = {
      memories: [
        mem({ id: "u1", type: "user", scope: "global", topic: "language", text: "回复用中文", updatedAt: 42 }),
        mem({ id: "p1", type: "project", scope: workspace, topic: "deploy", text: "先跑 migrate", updatedAt: 43, version: 2, history: [{ text: "旧", updatedAt: 1 }] }),
      ],
    };
    await saveMemoryStore(store, workspace);
    const loaded = await loadMemoryStore(workspace);
    expect(loaded.memories).toHaveLength(2);
    const p = loaded.memories.find((m) => m.id === "p1")!;
    expect(p).toMatchObject({ topic: "deploy", text: "先跑 migrate", version: 2 });
    expect(p.history).toHaveLength(1);
  });

  it("missing files load as empty without crashing", async () => {
    const { workspace } = await fresh();
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const store = await loadMemoryStore(workspace);
      expect(store.memories).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("corrupt file loads as empty with a stderr note, and a later save overwrites it", async () => {
    const { workspace } = await fresh();
    const { projectFile } = memoryFilePaths(workspace);
    await fs.mkdir(path.dirname(projectFile), { recursive: true });
    await fs.writeFile(projectFile, "{ not json");
    const warn = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const store = await loadMemoryStore(workspace);
      expect(store.memories).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    // 之后保存会覆盖损坏文件
    await saveMemoryStore({ memories: [mem({ id: "p1", type: "project", scope: workspace, topic: "style", text: "ok" })] }, workspace);
    const raw = JSON.parse(await fs.readFile(projectFile, "utf8")) as { memories: Memory[] };
    expect(raw.memories[0]!.text).toBe("ok");
  });
});
