import { describe, expect, it } from "vitest";

import { CliUsageError, parseArgs } from "../src/cli.js";

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

  it("parses --provider with a separate value and =value form", () => {
    expect(parseArgs(["--provider", "claude"]).provider).toBe("claude");
    expect(parseArgs(["--provider=claude"]).provider).toBe("claude");
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

  it("leaves prompt undefined when no positional is given (so stdin is used)", () => {
    expect(parseArgs(["--verbose"]).prompt).toBeUndefined();
    expect(parseArgs([]).prompt).toBeUndefined();
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(CliUsageError);
  });

  it("rejects --model without a value", () => {
    expect(() => parseArgs(["--model"])).toThrow(CliUsageError);
  });

  it("rejects --provider without a value", () => {
    expect(() => parseArgs(["--provider"])).toThrow(CliUsageError);
  });
});
