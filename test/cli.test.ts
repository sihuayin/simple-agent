import { describe, expect, it } from "vitest";

import { CliUsageError, parseArgs, resolveModel } from "../src/cli.js";
import { DEFAULT_MODEL } from "../src/config.js";

describe("parseArgs", () => {
  it("collects a positional prompt", () => {
    expect(parseArgs(["hello world"]).prompt).toBe("hello world");
  });

  it("joins multiple positionals into one prompt", () => {
    expect(parseArgs(["hello", "world"]).prompt).toBe("hello world");
  });

  it("parses --model with a separate value", () => {
    const args = parseArgs(["--model", "deepseek-v4-pro", "hi"]);
    expect(args.model).toBe("deepseek-v4-pro");
    expect(args.prompt).toBe("hi");
  });

  it("parses --model=value form", () => {
    expect(parseArgs(["--model=deepseek-v4-pro"]).model).toBe("deepseek-v4-pro");
  });

  it("parses --help and -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("parses --version", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("parses --verbose", () => {
    expect(parseArgs(["--verbose"]).verbose).toBe(true);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(CliUsageError);
  });

  it("rejects --model without a value", () => {
    expect(() => parseArgs(["--model"])).toThrow(CliUsageError);
  });
});

describe("resolveModel", () => {
  it("flag wins over the environment default", () => {
    expect(resolveModel("deepseek-v4-pro", { DEEPSEEK_MODEL: "deepseek-chat" })).toBe(
      "deepseek-v4-pro",
    );
  });

  it("uses the environment default when no flag is given", () => {
    expect(resolveModel(undefined, { DEEPSEEK_MODEL: "deepseek-chat" })).toBe("deepseek-chat");
  });

  it("falls back to the built-in default when neither is set", () => {
    expect(resolveModel(undefined, {})).toBe(DEFAULT_MODEL);
  });

  it("treats an empty or whitespace-only env value as unset", () => {
    expect(resolveModel(undefined, { DEEPSEEK_MODEL: "" })).toBe(DEFAULT_MODEL);
    expect(resolveModel(undefined, { DEEPSEEK_MODEL: "   " })).toBe(DEFAULT_MODEL);
  });
});
