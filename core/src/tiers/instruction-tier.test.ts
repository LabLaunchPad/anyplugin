import { describe, it, expect } from "vitest";
import { generateInstructionTier } from "./instruction-tier.js";
import { parsePluginManifest } from "../schema/index.js";

const manifest = parsePluginManifest({
  name: "guard-kit",
  version: "1.2.0",
  description: "Tool guards for every coding agent.",
  skills: ["./skills/policy-pack"],
  hooks: [{ id: "guard-bash", event: "before-tool-use", handler: "./hooks/guard.mjs" }],
  knowledge: "./knowledge",
});

describe("instruction-tier fallback (ponytail pattern)", () => {
  it("renders identity, payload inventory, and uninstall pointer", () => {
    const md = generateInstructionTier(manifest);
    expect(md).toContain("# guard-kit (v1.2.0)");
    expect(md).toContain("Tool guards for every coding agent.");
    expect(md).toContain("- Skills: 1 (./skills/policy-pack)");
    expect(md).toContain("before-tool-use");
    expect(md).toContain("OKF knowledge bundle: ./knowledge");
    expect(md).toContain("anyplugin uninstall");
  });

  it("renders the behavioral ladder as an ordered decision tree", () => {
    const withLadder = parsePluginManifest({
      ...manifest,
      extra: undefined,
      ladder: ["Does this tool call match a dangerous pattern?", "Is the user authorized?", "Only then: intercept and block"],
    } as never);
    const md = generateInstructionTier(withLadder);
    expect(md).toContain("## Behavioral ladder");
    expect(md).toContain("Stop at the first rung that holds");
    expect(md).toContain("1. Does this tool call match a dangerous pattern?");
    expect(md).toContain("3. Only then: intercept and block");
  });

  it("renders intensity modes and the switch command", () => {
    const withIntensity = parsePluginManifest({
      ...manifest,
      intensity: { conservative: "Only intercept explicit violations", aggressive: "Intercept everything" },
    } as never);
    const md = generateInstructionTier(withIntensity);
    expect(md).toContain("## Intensity modes");
    expect(md).toContain("**conservative**: Only intercept explicit violations");
    expect(md).toContain("**aggressive**: Intercept everything");
    expect(md).toContain("anyplugin intensity --mode");
  });

  it("handles instructions-only plugins (no runtime payload)", () => {
    const bare = parsePluginManifest({ name: "pure-instructions", version: "0.1.0", description: "No payload." });
    const md = generateInstructionTier(bare);
    expect(md).toContain("instructions-only");
  });
});
