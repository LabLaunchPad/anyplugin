import { describe, it, expect } from "vitest";
import { parsePluginManifest } from "./index.js";

describe("parsePluginManifest", () => {
  it("fills defaults and preserves unknown keys", () => {
    const m = parsePluginManifest({
      name: "my-plugin",
      version: "1.0.0",
      description: "test",
      skills: ["./skills/a"],
      unknownTop: { keep: true },
    });
    expect(m.name).toBe("my-plugin");
    expect(m.commands).toEqual([]);
    expect(m.hooks).toEqual([]);
    expect(m.mcp.servers).toEqual({});
    expect((m.extra as Record<string, unknown>)["unknownTop"]).toEqual({ keep: true });
  });

  it("rejects bad names and missing fields", () => {
    expect(() => parsePluginManifest({ name: "Bad_Name", version: "1.0.0", description: "x" })).toThrow(/manifest/);
    expect(() => parsePluginManifest({ name: "ok", description: "x" })).toThrow(/manifest/);
  });

  it("validates hooks against canonical events", () => {
    expect(() =>
      parsePluginManifest({
        name: "p",
        version: "0.0.1",
        description: "d",
        hooks: [{ id: "h1", event: "before-tool-use", handler: "./hooks/guard.js" }],
      }),
    ).not.toThrow();
    expect(() =>
      parsePluginManifest({
        name: "p",
        version: "0.0.1",
        description: "d",
        hooks: [{ id: "h1", event: "NotAnEvent", handler: "./x.js" }],
      }),
    ).toThrow(/manifest/);
  });
});
