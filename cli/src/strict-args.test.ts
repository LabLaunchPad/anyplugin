import { describe, it, expect } from "vitest";
import { parseCliArgv } from "./strict-args.js";

describe("strict CLI contract (Pattern C)", () => {
  it("parses flags without positionals (okf-validate --json)", () => {
    const { command, values, positionals } = parseCliArgv(["okf-validate", "--json"]);
    expect(command).toBe("okf-validate");
    expect(values.json).toBe(true);
    expect(positionals).toEqual([]);
  });

  it("parses flags before positionals (okf-validate --json knowledge)", () => {
    const { positionals } = parseCliArgv(["okf-validate", "--json", "knowledge"]);
    expect(positionals).toEqual(["knowledge"]);
  });

  it("accepts every documented install/uninstall flag", () => {
    const { values } = parseCliArgv<"install">([
      "install", "--plugin", "p", "--agents", "codex", "--home", "h", "--project", "pr",
      "--dry-run", "--runner", "r", "--mcp-runtime", "m", "--json",
    ]);
    expect(values.plugin).toBe("p");
    expect(values["dry-run"]).toBe(true);
  });

  it("requires --name for init with a field-level error", () => {
    expect(() => parseCliArgv(["init", "--json"])).toThrow(/init requires --name/);
  });

  it("rejects unknown flags (typo guard)", () => {
    expect(() => parseCliArgv(["detect", "--dryrun"])).toThrow(/invalid arguments/);
    expect(() => parseCliArgv(["build", "--plug", "x"])).toThrow(/invalid arguments/);
  });

  it("rejects flags that are meaningless for the command (strict schemas)", () => {
    expect(() => parseCliArgv(["detect", "--dry-run"])).toThrow(/dry-run/);
    expect(() => parseCliArgv(["okf-validate", "--name", "x"])).toThrow(/name/);
  });

  it("rejects unknown commands", () => {
    expect(() => parseCliArgv(["frobnicate", "--json"])).toThrow(/unknown command/);
  });

  it("rejects positionals on commands that take none (no silent no-ops)", () => {
    expect(() => parseCliArgv(["build", "my-plugin"])).toThrow(/takes no positional/);
    expect(() => parseCliArgv(["detect", "xyz"])).toThrow(/takes no positional/);
    expect(() => parseCliArgv(["install", "foo", "--dry-run"])).toThrow(/takes no positional/);
  });

  it("okf commands accept at most one bundle directory positional", () => {
    expect(() => parseCliArgv(["okf-validate", "a", "b"])).toThrow(/at most one/);
    const { positionals } = parseCliArgv(["okf-validate", "knowledge"]);
    expect(positionals).toEqual(["knowledge"]);
  });
});
