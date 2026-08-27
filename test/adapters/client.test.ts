import { describe, expect, it } from "vitest";

import { createAdapter, MissingApiKeyError } from "../../src/adapters/client.js";

describe("createAdapter", () => {
  it("throws a friendly error naming DEEPSEEK_API_KEY for deepseek", () => {
    expect(() => createAdapter("deepseek", {})).toThrow(MissingApiKeyError);
    expect(() => createAdapter("deepseek", {})).toThrow(/DEEPSEEK_API_KEY/);
  });

  it("throws a friendly error naming ANTHROPIC_API_KEY for claude", () => {
    expect(() => createAdapter("claude", {})).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("a deepseek key does not satisfy the claude provider", () => {
    expect(() => createAdapter("claude", { DEEPSEEK_API_KEY: "sk-x" })).toThrow(
      /ANTHROPIC_API_KEY/,
    );
  });

  it("constructs the adapter with the provider's default model", () => {
    expect(
      createAdapter("deepseek", { DEEPSEEK_API_KEY: "sk-x" }).info.defaultModel,
    ).toBe("deepseek-v4-flash");
    expect(
      createAdapter("claude", { ANTHROPIC_API_KEY: "sk-x" }).info.defaultModel,
    ).toBe("claude-sonnet-4-5");
  });
});
