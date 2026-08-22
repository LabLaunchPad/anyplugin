import { describe, it, expect } from "vitest";
import { parsePluginManifest } from "./index.js";
import { SecurityError } from "../fs/safe-path.js";

const base = {
  name: "path-guard",
  version: "0.1.0",
  description: "manifest path boundary",
};

describe("manifest paths pass the SafePath boundary (spec §1.1)", () => {
  it("accepts ordinary relative payload paths", () => {
    const plugin = parsePluginManifest({
      ...base,
      skills: ["./skills/demo"],
      commands: ["./commands/foo.md"],
      agents: ["./agents/bar.md"],
      knowledge: "./knowledge",
      hooks: [{ id: "h1", event: "before-tool-use", handler: "./hooks/h1.mjs" }],
    });
    // validation must not mutate the declared payload paths
    expect(plugin.skills).toEqual(["./skills/demo"]);
    expect(plugin.knowledge).toBe("./knowledge");
  });

  it("rejects traversal, absolute, and drive-letter paths in every path-bearing field", () => {
    const hostile = ["../outside", "/etc/passwd", "C:\\evil", "\\\\srv\\share", "a/../../b"];
    for (const bad of hostile) {
      expect(() => parsePluginManifest({ ...base, skills: [bad] }), `skills ${bad}`).toThrow(SecurityError);
      expect(() => parsePluginManifest({ ...base, commands: [bad] }), `commands ${bad}`).toThrow(SecurityError);
      expect(() => parsePluginManifest({ ...base, agents: [bad] }), `agents ${bad}`).toThrow(SecurityError);
      expect(() => parsePluginManifest({ ...base, knowledge: bad }), `knowledge ${bad}`).toThrow(SecurityError);
      expect(
        () => parsePluginManifest({ ...base, hooks: [{ id: "h", event: "turn-stop", handler: bad }] }),
        `handler ${bad}`,
      ).toThrow(SecurityError);
    }
  });
});
