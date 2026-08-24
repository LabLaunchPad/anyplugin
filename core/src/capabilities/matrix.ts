import type { AgentId } from "../detect/index.js";
import type { CanonicalEvent } from "../schema/index.js";

/**
 * Capability Negotiation Matrix (spec CORE-INVARIANTS-V2 §2). Layer 2 guardrail:
 * adapters never silently guess compatibility. Every (agent, variant,
 * capability) verdict is NATIVE, DEGRADED (emit documented fallback + warning),
 * UNSUPPORTED (hard build error), or UNKNOWN (fail closed — hard build error).
 * Rows cite audited facts; unaudited combinations are UNKNOWN by construction.
 */

export type SupportLevel = "NATIVE" | "DEGRADED" | "UNSUPPORTED" | "UNKNOWN";

export type Capability =
  | `hooks.${CanonicalEvent}`
  | "mcp.stdio"
  | "mcp.http"
  | "skills"
  | "commands"
  | "agents.subagent"
  | "knowledge";

/** Variant used for an agent when the caller does not pin one. */
export const DEFAULT_VARIANTS: Record<AgentId, string> = {
  "claude-code": "latest",
  opencode: "v1",
  codex: ">=0.147",
  antigravity: "current",
};

interface Verdict {
  level: Exclude<SupportLevel, "UNKNOWN">;
  rationale: string;
}

const HOOK_EVENTS: CanonicalEvent[] = [
  "session-start",
  "before-tool-use",
  "after-tool-use",
  "prompt-submit",
  "turn-stop",
  "session-end",
  "permission-request",
];

function all(events: CanonicalEvent[], verdict: (e: CanonicalEvent) => Verdict): Partial<Record<Capability, Verdict>> {
  const out: Partial<Record<Capability, Verdict>> = {};
  for (const e of events) out[`hooks.${e}` as Capability] = verdict(e);
  return out;
}

const MATRIX: Record<string, Partial<Record<Capability, Verdict>>> = {
  // Claude Code: 33-event superset; .mcp.json supports stdio and http.
  "claude-code@latest": {
    ...all(HOOK_EVENTS, () => ({ level: "NATIVE", rationale: "claude-code 33-event hook superset, command hooks" })),
    "mcp.stdio": { level: "NATIVE", rationale: ".mcp.json stdio servers" },
    "mcp.http": { level: "NATIVE", rationale: ".mcp.json http servers" },
    skills: { level: "NATIVE", rationale: "SKILL.md directories" },
    commands: { level: "NATIVE", rationale: "slash-command markdown" },
    "agents.subagent": { level: "NATIVE", rationale: "subagent markdown" },
    knowledge: { level: "NATIVE", rationale: "bundle dir ships with the plugin root" },
  },
  // OpenCode (official plugin API docs, verified 2026-08: hook-based, no
  // documented v1/v2 split): session.created, tool.execute.before/after,
  // session.idle, permission.asked. No prompt hook exists — prompt-submit is
  // UNSUPPORTED (fail-closed) rather than mapped to an undocumented event.
  "opencode@v1": {
    ...all(HOOK_EVENTS, (e) => {
      if (e === "prompt-submit") return { level: "UNSUPPORTED", rationale: "opencode plugin API documents no prompt-submission hook (message.* events are post-hoc); no faithful mapping exists" };
      return { level: "NATIVE", rationale: "opencode official plugin API hook (docs verified 2026-08) via the runner shim" };
    }),
    "mcp.stdio": { level: "NATIVE", rationale: "opencode.json mcp with argv commands" },
    "mcp.http": { level: "NATIVE", rationale: "opencode.json mcp url servers" },
    skills: { level: "NATIVE", rationale: "skills[] paths" },
    commands: { level: "NATIVE", rationale: "command markdown" },
    "agents.subagent": { level: "NATIVE", rationale: "agent markdown" },
    knowledge: { level: "NATIVE", rationale: "bundle dir ships with the plugin root" },
  },
  // OpenCode v2: dev core DROPPED v1 hooks (no v2 hook surface audited yet).
  // V2-native emission stays OPEN in the ledger; until audited, anything not
  // explicitly marked below is UNKNOWN and fails closed.
  "opencode@v2": {
    ...all(HOOK_EVENTS, () => ({ level: "UNSUPPORTED", rationale: "opencode v2 core dropped the v1 hook API; no v2 hook surface has been audited" })),
    skills: { level: "NATIVE", rationale: "config skills[] paths are v2-safe" },
    knowledge: { level: "NATIVE", rationale: "bundle dir ships with the plugin root" },
  },
  // Codex >=0.147: hooks on by default, Claude-plugin-compatible; the plugin
  // surface carries skills + hooks + MCP + AGENTS.md — no command/agent artifacts.
  "codex@>=0.147": {
    ...all(HOOK_EVENTS, () => ({ level: "NATIVE", rationale: "codex hooks on by default, Claude-plugin-compatible" })),
    "mcp.stdio": { level: "NATIVE", rationale: "config.toml [mcp_servers]" },
    skills: { level: "NATIVE", rationale: ".codex-plugin skills" },
    commands: { level: "DEGRADED", rationale: "codex plugin surface has no command artifacts; omitted with warning" },
    "agents.subagent": { level: "DEGRADED", rationale: "codex plugin surface has no subagent artifacts; omitted with warning" },
    knowledge: { level: "NATIVE", rationale: "bundle dir ships with the plugin root" },
  },
  // Antigravity: 5-event camelCase protocol; some canonical events fold.
  "antigravity@current": {
    ...all(HOOK_EVENTS, (e) => {
      if (e === "session-end") return { level: "UNSUPPORTED", rationale: "antigravity has a 5-event protocol; no SessionEnd — folds are documented, this one has none" };
      if (e === "session-start" || e === "prompt-submit") return { level: "DEGRADED", rationale: "folds into PreInvocation" };
      if (e === "permission-request") return { level: "DEGRADED", rationale: "maps to PreToolUse decision" };
      return { level: "NATIVE", rationale: "native antigravity hook event" };
    }),
    "mcp.stdio": { level: "NATIVE", rationale: "mcp_config.json stdio" },
    "mcp.http": { level: "NATIVE", rationale: "mcp_config.json serverUrl (http)" },
    skills: { level: "NATIVE", rationale: ".agents/ skills" },
    commands: { level: "DEGRADED", rationale: "antigravity surface has no command artifacts; omitted with warning" },
    "agents.subagent": { level: "NATIVE", rationale: "custom agents" },
    knowledge: { level: "NATIVE", rationale: "bundle dir ships with the plugin root" },
  },
};

/**
 * Query the matrix. UNKNOWN is returned for any unaudited (agent, variant)
 * pair or capability — callers MUST fail closed on it (spec §2.2).
 */
export function supports(agent: AgentId, variant: string, capability: Capability): SupportLevel {
  const row = MATRIX[`${agent}@${variant}`];
  if (!row) return "UNKNOWN";
  return row[capability]?.level ?? "UNKNOWN";
}

/** The rationale for a verdict (diagnostics; empty for UNKNOWN rows). */
export function rationale(agent: AgentId, variant: string, capability: Capability): string {
  return MATRIX[`${agent}@${variant}`]?.[capability]?.rationale ?? "";
}
