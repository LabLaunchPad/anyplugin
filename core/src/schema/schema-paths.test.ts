import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { parsePluginManifest } from "./index.js";
import { SecurityError } from "../fs/safe-path.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let mockRoot: string;

beforeAll(async () => {
  mockRoot = await mkdtemp(join(tmpdir(), "schema-test-root-"));
});

afterAll(async () => {
  try { await rm(mockRoot, { recursive: true, force: true }); } catch {}
});

const base = {
  name: "path-guard",
  version: "0.1.0",
  description: "manifest path boundary",
};

describe("manifest paths pass the SafePath boundary (spec §1.1)", () => {
  it("accepts ordinary relative payload paths", async () => {
    const plugin = await parsePluginManifest({
      ...base,
      skills: ["./skills/demo"],
      commands: ["./commands/foo.md"],
      agents: ["./agents/bar.md"],
      knowledge: "./knowledge",
      hooks: [{ id: "h1", event: "before-tool-use", handler: "./hooks/h1.mjs" }],
    }, mockRoot);
    // validation must not mutate the declared payload paths
    expect(plugin.skills).toEqual(["./skills/demo"]);
    expect(plugin.knowledge).toBe("./knowledge");
  });

  it("rejects traversal, absolute, and drive-letter paths in every path-bearing field", async () => {
    const hostile = ["../outside", "/etc/passwd", "C:\\evil", "\\\\srv\\share", "a/../../b"];
    for (const bad of hostile) {
      await expect(parsePluginManifest({ ...base, skills: [bad] }, mockRoot), `skills ${bad}`).rejects.toThrow(SecurityError);
      await expect(parsePluginManifest({ ...base, commands: [bad] }, mockRoot), `commands ${bad}`).rejects.toThrow(SecurityError);
      await expect(parsePluginManifest({ ...base, agents: [bad] }, mockRoot), `agents ${bad}`).rejects.toThrow(SecurityError);
      await expect(parsePluginManifest({ ...base, knowledge: bad }, mockRoot), `knowledge ${bad}`).rejects.toThrow(SecurityError);
      await expect(
        parsePluginManifest({ ...base, hooks: [{ id: "h", event: "turn-stop", handler: bad }] }, mockRoot),
        `handler ${bad}`,
      ).rejects.toThrow(SecurityError);
    }
  });
});
