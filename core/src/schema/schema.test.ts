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
});
