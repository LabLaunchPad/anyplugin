import { describe, it, expect } from "vitest";
import { detectAgent, detectInstalledAgents } from "./index.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("detectAgent", () => {
  it("self-marker wins", () => {
    const d = detectAgent({ AGENT_PRISM_HOST: "opencode", CLAUDECODE: "1" }, "/nope");
    expect(d).toMatchObject({ agent: "opencode", confidence: "marker" });
  });
  it("CLAUDECODE=1 is authoritative for claude-code", () => {
    const d = detectAgent({ CLAUDECODE: "1" }, "/nope");
    expect(d).toMatchObject({ agent: "claude-code", confidence: "authoritative" });
  });
  it("CODEX_SANDBOX detects codex", () => {
    const d = detectAgent({ CODEX_SANDBOX: "seatbelt" }, "/nope");
    expect(d).toMatchObject({ agent: "codex", confidence: "high" });
  });
  it("ANTIGRAVITY_AGENT detects antigravity", () => {
    const d = detectAgent({ ANTIGRAVITY_AGENT: "1" }, "/nope");
    expect(d).toMatchObject({ agent: "antigravity", confidence: "high" });
  });
  it("OPENCODE_TERMINAL infers opencode (v2 PTY marker)", () => {
    const d = detectAgent({ OPENCODE_TERMINAL: "1" }, "/nope");
    expect(d).toMatchObject({ agent: "opencode", confidence: "inferred" });
  });
  it("empty-string env vars do not trigger detection", () => {
    const d = detectAgent({ CLAUDECODE: "", CODEX_CI: "", ANTIGRAVITY_AGENT: "" }, "/nope");
    expect(d.agent).toBeNull();
  });
});

describe("detectInstalledAgents", () => {
  it("finds agents by user-level config dirs", async () => {
    const home = await mkdtemp(join(tmpdir(), "home-"));
    await mkdir(join(home, ".claude"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), "");
    await mkdir(join(home, ".gemini"), { recursive: true });
    const found = detectInstalledAgents(home, {});
    expect(found).toContain("claude-code");
    expect(found).toContain("codex");
    expect(found).toContain("antigravity");
    expect(found).not.toContain("opencode");
  });
});
