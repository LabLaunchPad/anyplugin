import { describe, it, expect } from "vitest";
import { supports, DEFAULT_VARIANTS, type Capability } from "./matrix.js";
import type { AgentId } from "../detect/index.js";

const q = (agent: AgentId, variant: string, cap: Capability) => supports(agent, variant, cap);

describe("capability negotiation matrix (spec §2)", () => {
  it("classifies audited support levels correctly", () => {
    expect(q("claude-code", "latest", "hooks.session-end")).toBe("NATIVE");
    expect(q("claude-code", "latest", "mcp.http")).toBe("NATIVE");
    expect(q("opencode", "v1", "hooks.turn-stop")).toBe("NATIVE");
    expect(q("codex", ">=0.147", "hooks.before-tool-use")).toBe("NATIVE");
    expect(q("antigravity", "current", "hooks.before-tool-use")).toBe("NATIVE");
    // documented semantic loss, not silence
    expect(q("antigravity", "current", "hooks.session-start")).toBe("DEGRADED"); // folds into PreInvocation
    expect(q("antigravity", "current", "hooks.prompt-submit")).toBe("DEGRADED");
    expect(q("antigravity", "current", "hooks.permission-request")).toBe("DEGRADED"); // PreToolUse decision
    // hard-unsupported
    expect(q("antigravity", "current", "hooks.session-end")).toBe("UNSUPPORTED"); // 5-event protocol
    expect(q("opencode", "v2", "hooks.turn-stop")).toBe("UNSUPPORTED"); // v2 core dropped v1 hooks
    // artifacts that exist but are omitted with warnings on some targets
    expect(q("codex", ">=0.147", "commands")).toBe("DEGRADED");
    expect(q("antigravity", "current", "commands")).toBe("DEGRADED");
    expect(q("opencode", "v2", "skills")).toBe("NATIVE"); // config skills[] paths are v2-safe
  });

  it("fails closed on UNKNOWN — never falls back to supported", () => {
    expect(q("opencode", "v9", "skills")).toBe("UNKNOWN");
    expect(q("codex", "0.1", "hooks.turn-stop")).toBe("UNKNOWN");
    expect(q("opencode", "v2", "commands")).toBe("UNKNOWN"); // not yet audited for v2
    expect(q("opencode", "v2", "agents.subagent")).toBe("UNKNOWN");
    expect(q("codex", ">=0.147", "mcp.http")).toBe("UNKNOWN");
  });

  it("default variants cover all four agents", () => {
    expect(Object.keys(DEFAULT_VARIANTS).sort()).toEqual(["antigravity", "claude-code", "codex", "opencode"]);
    for (const [agent, variant] of Object.entries(DEFAULT_VARIANTS)) {
      expect(q(agent as AgentId, variant, "skills"), `${agent}@${variant}`).not.toBe("UNKNOWN");
    }
  });
});
