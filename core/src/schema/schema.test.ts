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

  describe("runtime (CORE-INVARIANTS-V2.md §1.3)", () => {
    const base = { name: "p", version: "0.0.1", description: "d" };

    it("is absent by default — no runtime block means the implicit non-blocking default, not a filled-in object", () => {
      const m = parsePluginManifest(base);
      expect(m.runtime).toBeUndefined();
    });

    it("defaults failurePolicy to non-blocking when the block is present but the field is omitted", () => {
      const m = parsePluginManifest({ ...base, runtime: {} });
      expect(m.runtime?.failurePolicy).toBe("non-blocking");
    });

    it("accepts an explicit blocking opt-in", () => {
      const m = parsePluginManifest({ ...base, runtime: { failurePolicy: "blocking" } });
      expect(m.runtime?.failurePolicy).toBe("blocking");
    });

    it("rejects a failurePolicy value outside the closed set — never silently coerced", () => {
      expect(() => parsePluginManifest({ ...base, runtime: { failurePolicy: "always" } })).toThrow(/manifest/);
    });

    it("accepts hookTimeoutSec within [1, 600] and rejects outside it", () => {
      expect(() => parsePluginManifest({ ...base, runtime: { hookTimeoutSec: 30 } })).not.toThrow();
      expect(() => parsePluginManifest({ ...base, runtime: { hookTimeoutSec: 0 } })).toThrow(/manifest/);
      expect(() => parsePluginManifest({ ...base, runtime: { hookTimeoutSec: 601 } })).toThrow(/manifest/);
    });
  });
});
