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

/**
 * When a verdict was established, and against what.
 *
 * `observedAt` is an ISO date or the literal `"UNKNOWN"`. UNKNOWN here does NOT
 * mean the capability is unknown — the verdict is asserted either way. It means
 * **nobody recorded when the claim was checked**, so its staleness cannot be
 * reasoned about. Making that a required field rather than an absent one is the
 * point: an unrecorded audit date is a real deficit, and a deficit that is
 * counted can be driven down, while one that is merely missing cannot.
 */
export interface CapabilityProvenance {
  /** What was consulted. Not invented — only what the audit actually used. */
  readonly source: string;
  /** ISO-8601 date (YYYY-MM or YYYY-MM-DD), or "UNKNOWN" if never recorded. */
  readonly observedAt: string;
}

interface Verdict {
  level: Exclude<SupportLevel, "UNKNOWN">;
  rationale: string;
}

/**
 * One audited agent surface.
 *
 * Provenance sits at the ROW because that is how the audits were actually
 * performed — one pass over one agent's plugin surface, not one pass per
 * capability. Recording it per capability would imply a granularity of evidence
 * that does not exist.
 *
 * `capabilities` stays partial, and that is load-bearing: **UNKNOWN remains the
 * absence of a key**, never a value. `Verdict.level` excludes UNKNOWN by type,
 * so an unaudited combination cannot be given a verdict even by accident.
 */
interface MatrixRow {
  readonly provenance: CapabilityProvenance;
  readonly capabilities: Partial<Record<Capability, Verdict>>;
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

const MATRIX: Record<string, MatrixRow> = {
  // Claude Code: 33-event superset; .mcp.json supports stdio and http.
  "claude-code@latest": {
    provenance: { source: "claude-code plugin + hook documentation", observedAt: "UNKNOWN" },
    capabilities: {
      ...all(HOOK_EVENTS, () => ({ level: "NATIVE", rationale: "claude-code 33-event hook superset, command hooks" })),
      "mcp.stdio": { level: "NATIVE", rationale: ".mcp.json stdio servers" },
      "mcp.http": { level: "NATIVE", rationale: ".mcp.json http servers" },
      skills: { level: "NATIVE", rationale: "SKILL.md directories" },
      commands: { level: "NATIVE", rationale: "slash-command markdown" },
      "agents.subagent": { level: "NATIVE", rationale: "subagent markdown" },
      knowledge: { level: "NATIVE", rationale: "bundle dir ships with the plugin root" },
    },
  },
  // OpenCode (official plugin API docs, verified 2026-08: hook-based, no
  // documented v1/v2 split): session.created, tool.execute.before/after,
  // session.idle, permission.asked. No prompt hook exists — prompt-submit is
  // UNSUPPORTED (fail-closed) rather than mapped to an undocumented event.
  "opencode@v1": {
    // The only row whose audit date was ever written down — it survived as prose
    // inside a rationale string, which is exactly why this field now exists.
    provenance: { source: "opencode official plugin API docs", observedAt: "2026-08" },
    capabilities: {
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
  },
  // OpenCode v2: dev core DROPPED v1 hooks (no v2 hook surface audited yet).
  // V2-native emission stays OPEN in the ledger; until audited, anything not
  // explicitly marked below is UNKNOWN and fails closed.
  "opencode@v2": {
    provenance: { source: "opencode v2 core changelog; no v2 plugin-API audit performed", observedAt: "UNKNOWN" },
    capabilities: {
      ...all(HOOK_EVENTS, () => ({ level: "UNSUPPORTED", rationale: "opencode v2 core dropped the v1 hook API; no v2 hook surface has been audited" })),
      skills: { level: "NATIVE", rationale: "config skills[] paths are v2-safe" },
      knowledge: { level: "NATIVE", rationale: "bundle dir ships with the plugin root" },
    },
  },
  // Codex >=0.147: hooks on by default, Claude-plugin-compatible; the plugin
  // surface carries skills + hooks + MCP + AGENTS.md — no command/agent artifacts.
  "codex@>=0.147": {
    provenance: { source: "codex plugin surface documentation", observedAt: "UNKNOWN" },
    capabilities: {
      ...all(HOOK_EVENTS, () => ({ level: "NATIVE", rationale: "codex hooks on by default, Claude-plugin-compatible" })),
      "mcp.stdio": { level: "NATIVE", rationale: "config.toml [mcp_servers]" },
      skills: { level: "NATIVE", rationale: ".codex-plugin skills" },
      commands: { level: "DEGRADED", rationale: "codex plugin surface has no command artifacts; omitted with warning" },
      "agents.subagent": { level: "DEGRADED", rationale: "codex plugin surface has no subagent artifacts; omitted with warning" },
      knowledge: { level: "NATIVE", rationale: "bundle dir ships with the plugin root" },
    },
  },
  // Antigravity: 5-event camelCase protocol; some canonical events fold.
  "antigravity@current": {
    provenance: { source: "antigravity hook protocol documentation", observedAt: "UNKNOWN" },
    capabilities: {
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
  },
};

/**
 * Query the matrix. UNKNOWN is returned for any unaudited (agent, variant)
 * pair or capability — callers MUST fail closed on it (spec §2.2).
 */
export function supports(agent: AgentId, variant: string, capability: Capability): SupportLevel {
  const row = MATRIX[`${agent}@${variant}`];
  if (!row) return "UNKNOWN";
  return row.capabilities[capability]?.level ?? "UNKNOWN";
}

/** The rationale for a verdict (diagnostics; empty for UNKNOWN rows). */
export function rationale(agent: AgentId, variant: string, capability: Capability): string {
  return MATRIX[`${agent}@${variant}`]?.capabilities[capability]?.rationale ?? "";
}

/**
 * Provenance for an audited agent surface, or `undefined` if the surface was
 * never audited at all.
 *
 * Returning `undefined` rather than a placeholder keeps the same discipline as
 * `supports`: an unaudited surface has no provenance, and inventing one would
 * assert that an audit happened.
 */
export function provenance(agent: AgentId, variant: string): CapabilityProvenance | undefined {
  return MATRIX[`${agent}@${variant}`]?.provenance;
}

/** Every audited surface key, for coverage guards. */
export function auditedSurfaces(): string[] {
  return Object.keys(MATRIX);
}

/**
 * Surfaces asserting verdicts with no recorded audit date.
 *
 * This is a deficit list, not a failure list — the verdicts are still asserted.
 * A ratchet test freezes its size so it can shrink and never grow: a NEW row
 * must record when it was checked, while existing rows stay honest about the
 * fact that nobody did.
 */
export function surfacesWithoutObservedAt(): string[] {
  return Object.entries(MATRIX)
    .filter(([, row]) => row.provenance.observedAt === "UNKNOWN")
    .map(([key]) => key);
}
