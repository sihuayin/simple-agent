import { describe, expect, it, vi } from "vitest";

import { Spinner } from "../src/spinner.js";

function mockOut() {
  const writes: string[] = [];
  return {
    isTTY: true,
    write: (s: string) => {
      writes.push(s);
      return true;
    },
    writes,
  };
}

describe("Spinner", () => {
  it("is a no-op when the stream is not a TTY", () => {
    const writes: string[] = [];
    const out = { isTTY: false, write: (s: string) => (writes.push(s), true) };
    const spinner = new Spinner("工作中", out as NodeJS.WriteStream);
    spinner.start();
    spinner.stop();
    expect(writes).toEqual([]);
  });

  it("renders frames while running and stops cleanly", () => {
    vi.useFakeTimers();
    try {
      const out = mockOut();
      const spinner = new Spinner("工作中", out as unknown as NodeJS.WriteStream);
      spinner.start();
      expect(out.writes.length).toBe(1); // 立即渲染一帧
      vi.advanceTimersByTime(240); // 3 个周期
      expect(out.writes.length).toBe(4);
      expect(out.writes[0]).toMatch(/^\r. 工作中$/);
      spinner.stop();
      expect(out.writes.at(-1)).toBe("\r\x1b[K"); // 清行
      const afterStop = out.writes.length;
      vi.advanceTimersByTime(240); // 定时器已清理
      expect(out.writes.length).toBe(afterStop);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start is idempotent while active", () => {
    vi.useFakeTimers();
    try {
      const out = mockOut();
      const spinner = new Spinner("x", out as unknown as NodeJS.WriteStream);
      spinner.start();
      spinner.start();
      const count = out.writes.length;
      vi.advanceTimersByTime(160);
      expect(out.writes.length).toBe(count + 2); // 只有一个定时器
    } finally {
      vi.useRealTimers();
    }
  });
});
