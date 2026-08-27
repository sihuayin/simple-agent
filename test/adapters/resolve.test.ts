import { describe, expect, it } from "vitest";

import {
  resolveModel,
  resolveProvider,
  UnknownProviderError,
} from "../../src/adapters/resolve.js";

describe("resolveProvider", () => {
  it("flag wins over env and default", () => {
    expect(resolveProvider("claude", { LLM_PROVIDER: "deepseek" })).toBe("claude");
  });

  it("uses the env value when no flag is given", () => {
    expect(resolveProvider(undefined, { LLM_PROVIDER: "claude" })).toBe("claude");
  });

  it("defaults to deepseek when neither is set", () => {
    expect(resolveProvider(undefined, {})).toBe("deepseek");
  });

  it("throws UnknownProviderError listing the available providers", () => {
    expect(() => resolveProvider("llama", {})).toThrow(
      /Unknown provider "llama".*deepseek.*claude/,
    );
  });
});

describe("resolveModel", () => {
  it("flag wins over the provider's model env var", () => {
    expect(resolveModel("deepseek", "deepseek-v4-pro", { DEEPSEEK_MODEL: "deepseek-chat" })).toBe(
      "deepseek-v4-pro",
    );
  });

  it("uses the provider's model env var when no flag is given", () => {
    expect(resolveModel("deepseek", undefined, { DEEPSEEK_MODEL: "deepseek-chat" })).toBe(
      "deepseek-chat",
    );
  });

  it("claude reads ANTHROPIC_MODEL, not DEEPSEEK_MODEL", () => {
    expect(
      resolveModel("claude", undefined, { ANTHROPIC_MODEL: "claude-opus-4-8", DEEPSEEK_MODEL: "deepseek-chat" }),
    ).toBe("claude-opus-4-8");
  });

  it("falls back to the provider's default model", () => {
    expect(resolveModel("claude", undefined, {})).toBe("claude-sonnet-4-5");
    expect(resolveModel("deepseek", undefined, {})).toBe("deepseek-v4-flash");
  });

  it("treats an empty or whitespace-only env value as unset", () => {
    expect(resolveModel("deepseek", undefined, { DEEPSEEK_MODEL: "" })).toBe("deepseek-v4-flash");
    expect(resolveModel("deepseek", undefined, { DEEPSEEK_MODEL: "   " })).toBe("deepseek-v4-flash");
  });
});
