import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parsePluginManifest } from "./index.js";
import { SecurityError } from "../fs/safe-path.js";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mockRoot: string;

beforeAll(async () => {
  mockRoot = await mkdtemp(join(tmpdir(), "schema-test-root-"));
});

afterAll(async () => {
  try { await rm(mockRoot, { recursive: true, force: true }); } catch {}
});

describe("parsePluginManifest", () => {
  it("fills defaults and preserves unknown keys", async () => {
    const m = await parsePluginManifest({
      name: "my-plugin",
      version: "1.0.0",
      description: "test",
      skills: ["./skills/a"],
      unknownTop: { keep: true },
    }, mockRoot);
    expect(m.name).toBe("my-plugin");
    expect(m.commands).toEqual([]);
    expect(m.hooks).toEqual([]);
    expect(m.mcp.servers).toEqual({});
    expect((m.extra as Record<string, unknown>)["unknownTop"]).toEqual({ keep: true });
  });

  it("rejects bad names and missing fields", async () => {
    await expect(parsePluginManifest({ name: "Bad_Name", version: "1.0.0", description: "x" }, mockRoot)).rejects.toThrow(/manifest/);
    await expect(parsePluginManifest({ name: "ok", description: "x" }, mockRoot)).rejects.toThrow(/manifest/);
  });

  it("validates hooks against canonical events", async () => {
    // Create the necessary directory structure for the valid hook test
    await mkdir(join(mockRoot, "hooks"), { recursive: true });
    await writeFile(join(mockRoot, "hooks", "guard.js"), "export async function run() { return {}; }");
    
    // Valid hook should not throw
    await expect(
      parsePluginManifest({
        name: "p",
        version: "0.0.1",
        description: "d",
        hooks: [{ id: "h1", event: "before-tool-use", handler: "./hooks/guard.js" }],
      }, mockRoot),
    ).resolves.toBeDefined();
    
    // Invalid event should throw
    await expect(
      parsePluginManifest({
        name: "p",
        version: "0.0.1",
        description: "d",
        hooks: [{ id: "h1", event: "NotAnEvent", handler: "./hooks/guard.js" }],
      }, mockRoot),
    ).rejects.toThrow(/manifest/);
  });

  it("refuses a hook matcher that could freeze the agent", async () => {
    await mkdir(join(mockRoot, "hooks"), { recursive: true });
    await writeFile(join(mockRoot, "hooks", "guard.js"), "export async function run() { return {}; }");

    const withMatch = (match: string) =>
      parsePluginManifest({
        name: "p",
        version: "0.0.1",
        description: "d",
        hooks: [{ id: "h1", event: "before-tool-use", handler: "./hooks/guard.js", match }],
      }, mockRoot);

    // A group that can match its own text more than one way, under a
    // quantifier, backtracks exponentially. Measured on this repository's
    // own runtime, `(a+)+$` and `(a|a)+$` both ran past a 5-second cap
    // against a 24-character input. The tool name is not the plugin author's
    // to choose, so this has to be refused at parse time.
    for (const evil of [
      // the nested-quantifier shape
      "(a+)+$", "(a*)*", "(a+)*", "^(x+)+$", "(a{1,2})+", "((a+)+)+", "([a-z]+)+",
      // the overlapping-alternation shape — a DIFFERENT hazard with the
      // same effect, and the one a quantifier-only check would miss
      "(a|a)+$", "(a|a?)+$", "(a|ab)+$", "(aa|a)+$", "(x+x+)+y",
    ]) {
      await expect(withMatch(evil), evil).rejects.toThrow(/ambiguous quantified group/);
    }

    // A plain tool name is not a regex and must still work.
    await expect(withMatch("Bash")).resolves.toBeDefined();
    // A simple regex must still work — the starter template ships `.*`.
    await expect(withMatch(".*")).resolves.toBeDefined();
    await expect(withMatch("^(Read|Write)$")).resolves.toBeDefined();
    await expect(withMatch("^Bash")).resolves.toBeDefined();
    // An alternation of DISTINCT branches is fine, even when quantified:
    // the branches cannot match the same text, so there is only one way to
    // split it.
    await expect(withMatch("(Read|Write)+")).resolves.toBeDefined();
    await expect(withMatch("(?:foo)+")).resolves.toBeDefined();

    // A very long pattern is refused too: it is a cheap way to make an
    // agent's regex engine work.
    await expect(withMatch("a".repeat(201))).rejects.toThrow(/200 characters/);
  });
});
