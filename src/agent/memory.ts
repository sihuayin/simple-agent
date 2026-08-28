import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Session memory: user preferences (global), project conventions and user
 * corrections (project-level). Judgement rule: a memory is worth keeping iff
 * it would still be useful in a new session. Memories auto-load into every
 * new session's system prompt; the agent stores them itself via the remember
 * tool (no confirmation). Same topic + same type + same scope overwrite
 * (version+1, history kept); on load, project-level beats global on the same
 * topic and the newest wins within a level — losers are suppressed but never
 * deleted. No expiry: memories change only via overwrite or explicit forget.
 */

export type MemoryType = "user" | "project" | "feedback";

export interface MemoryHistoryEntry {
  text: string;
  updatedAt: number;
}

export interface Memory {
  id: string;
  type: MemoryType;
  topic: string;
  text: string;
  /** "global" for user; the normalized workspace path for project/feedback. */
  scope: string;
  sourceProject: string;
  createdAt: number;
  updatedAt: number;
  version: number;
  history: MemoryHistoryEntry[];
}

export interface MemoryStore {
  memories: Memory[];
}

export interface RememberInput {
  type: MemoryType;
  topic: string;
  text: string;
  sourceProject: string;
  /** true → scope "global" (user); false → scope = sourceProject. */
  global: boolean;
}

export type RememberResult =
  | { kind: "added"; memory: Memory }
  | { kind: "updated"; memory: Memory }
  | { kind: "rejected"; reason: string };

export function emptyStore(): MemoryStore {
  return { memories: [] };
}

// ---------- 纯逻辑 ----------

/** 自动落库（无确认环节）；空文本/空主题拒绝。噪音判定由调用方（agent）做出。 */
export function remember(store: MemoryStore, input: RememberInput): { store: MemoryStore; result: RememberResult } {
  if (!input.text.trim() || !input.topic.trim()) {
    return { store, result: { kind: "rejected", reason: "记忆文本或主题为空" } };
  }
  const scope = input.global ? "global" : input.sourceProject;
  const now = Date.now();
  const idx = store.memories.findIndex(
    (m) => m.topic === input.topic && m.type === input.type && m.scope === scope,
  );
  if (idx >= 0) {
    const prev = store.memories[idx]!;
    const next: Memory = {
      ...prev,
      text: input.text,
      updatedAt: now,
      version: prev.version + 1,
      history: [...prev.history, { text: prev.text, updatedAt: prev.updatedAt }],
    };
    store.memories[idx] = next;
    return { store, result: { kind: "updated", memory: next } };
  }
  const memory: Memory = {
    id: `${scope === "global" ? "g" : "p"}${store.memories.length + 1}-${now.toString(36)}`,
    type: input.type,
    topic: input.topic,
    text: input.text,
    scope,
    sourceProject: input.sourceProject,
    createdAt: now,
    updatedAt: now,
    version: 1,
    history: [],
  };
  store.memories.push(memory);
  return { store, result: { kind: "added", memory } };
}

export function forget(store: MemoryStore, memoryId: string): MemoryStore {
  return { memories: store.memories.filter((m) => m.id !== memoryId) };
}

export interface SessionLoad {
  injected: Memory[];
  suppressed: { mem: Memory; reason: string }[];
  dropped: Memory[];
}

/**
 * 新会话加载：user(global) 总是注入；project/feedback 仅当 scope === 当前项目。
 * 冲突裁定：同 topic → 项目级恒压全局；同级别内 updatedAt 新者赢；被压制的可见不丢。
 */
export function loadForSession(store: MemoryStore, projectId: string): SessionLoad {
  const eligible = store.memories.filter((m) => m.scope === "global" || m.scope === projectId);
  const dropped = store.memories.filter((m) => !(m.scope === "global" || m.scope === projectId));

  const groups = new Map<string, Memory[]>();
  for (const m of eligible) {
    const g = groups.get(m.topic) ?? [];
    g.push(m);
    groups.set(m.topic, g);
  }

  const injected: Memory[] = [];
  const suppressed: { mem: Memory; reason: string }[] = [];
  for (const group of groups.values()) {
    const projectLevel = group.filter((m) => m.type !== "user");
    const userLevel = group.filter((m) => m.type === "user");
    if (projectLevel.length === 0) {
      injected.push(...userLevel);
      continue;
    }
    const winner = projectLevel.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0]!;
    injected.push(winner);
    for (const m of group) {
      if (m === winner) continue;
      suppressed.push({
        mem: m,
        reason: m.type === "user" ? "用户偏好与项目约定冲突，项目约定优先" : "同主题下更新的纠正生效，旧条目被压制",
      });
    }
  }
  return { injected, suppressed, dropped };
}

// ---------- 存储 ----------

export function memoryFilePaths(workspace: string): { globalFile: string; projectFile: string } {
  const home = os.homedir();
  return {
    globalFile: path.join(home, ".simple-agent", "memory.json"),
    projectFile: path.join(workspace, ".simple-agent", "memory.json"),
  };
}

interface MemoryFile {
  version: number;
  memories: Memory[];
}

async function readFile(file: string): Promise<Memory[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return []; // 缺失 → 空
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MemoryFile>;
    return Array.isArray(parsed.memories) ? (parsed.memories as Memory[]) : [];
  } catch {
    process.stderr.write(`Warning: 记忆文件损坏，已忽略：${file}\n`);
    return [];
  }
}

/** 加载全局 + 项目两份记忆文件，合并为一个 store。 */
export async function loadMemoryStore(workspace: string): Promise<MemoryStore> {
  const { globalFile, projectFile } = memoryFilePaths(workspace);
  const [globalMemories, projectMemories] = await Promise.all([readFile(globalFile), readFile(projectFile)]);
  return { memories: [...globalMemories, ...projectMemories] };
}

/** 按 scope 路由写回全局/项目文件；原子写（临时文件 + rename）。 */
export async function saveMemoryStore(store: MemoryStore, workspace: string): Promise<void> {
  const { globalFile, projectFile } = memoryFilePaths(workspace);
  const globalMemories = store.memories.filter((m) => m.scope === "global");
  const projectMemories = store.memories.filter((m) => m.scope !== "global");
  await Promise.all([
    writeFileAtomic(globalFile, globalMemories),
    writeFileAtomic(projectFile, projectMemories),
  ]);
}

async function writeFileAtomic(file: string, memories: Memory[]): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify({ version: 1, memories }, null, 2), "utf8");
  await fs.rename(tmp, file);
}
