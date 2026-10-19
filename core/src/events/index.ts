import type { AgentId } from "../detect/index.js";
import type { CanonicalEvent, Hook } from "../schema/index.js";

/**
 * Canonical event → native event name per agent (see knowledge/adapters/event-mapping.md).
 * OpenCode values are TS hook keys (v1 plugin API) — the plugin shim subscribes to them
 * and spawns the canonical runner as a child process.
 */
export const NATIVE_EVENT_MAP: Record<AgentId, Partial<Record<CanonicalEvent, string>>> = {
  "claude-code": {
    "session-start": "SessionStart",
    "before-tool-use": "PreToolUse",
    "after-tool-use": "PostToolUse",
    "prompt-submit": "UserPromptSubmit",
    "turn-stop": "Stop",
    "session-end": "SessionEnd",
    "permission-request": "PermissionRequest",
  },
  codex: {
    "session-start": "SessionStart",
    "before-tool-use": "PreToolUse",
    "after-tool-use": "PostToolUse",
    "prompt-submit": "UserPromptSubmit",
    "turn-stop": "Stop",
    "session-end": "SessionEnd",
    "permission-request": "PermissionRequest",
  },
  antigravity: {
    // Antigravity has 5 events; SessionStart folds into PreInvocation.
    "session-start": "PreInvocation",
    "before-tool-use": "PreToolUse",
    "after-tool-use": "PostToolUse",
    "prompt-submit": "PreInvocation",
    "turn-stop": "Stop",
    "session-end": undefined,
    "permission-request": "PreToolUse",
  },
  opencode: {
    "session-start": "session.created",
    "before-tool-use": "tool.execute.before",
    "after-tool-use": "tool.execute.after",
    // No documented prompt hook exists (message.* events are post-hoc updates);
    // dropped at emit time per the official plugin API docs (2026-08).
    "prompt-submit": undefined,
    "turn-stop": "session.idle",
    "session-end": "session.idle",
    "permission-request": "permission.asked",
  },
};

/** Normalized payload every hook handler receives, regardless of originating agent. */
export interface HookPayload {
  platform: AgentId | "unknown";
  event: CanonicalEvent;
  nativeEvent: string;
  sessionId?: string;
  conversationId?: string;
  cwd?: string;
  transcriptPath?: string;
  permissionMode?: string;
  toolName?: string;
  toolInput?: unknown;
  toolResponse?: unknown;
  prompt?: string;
  stopHookActive?: boolean;
  /** The raw platform JSON, camelCase or snake_case as delivered. */
  raw: Record<string, unknown>;
}

/** What a handler returns; the runner translates to platform-native stdout/exit codes. */
export interface HookResult {
  /** exit 2 = blocking (stderr/JSON reason fed back to the model); 0 = success. */
  block?: boolean;
  reason?: string;
  /** Context injected into the session (SessionStart/UserPromptSubmit family). */
  additionalContext?: string;
  /** PreToolUse permission decision (translated per platform). */
  permissionDecision?: "allow" | "deny" | "ask";
  systemMessage?: string;
  /** Arbitrary platform-specific stdout JSON merged as-is (escape hatch). */
  raw?: Record<string, unknown>;
}

function pick(raw: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) {
    if (raw[k] !== undefined) return raw[k];
  }
  return undefined;
}

/** Normalize a native hook stdin payload into the canonical HookPayload. */
export function normalizePayload(
  platform: AgentId | "unknown",
  event: CanonicalEvent,
  raw: Record<string, unknown>,
): HookPayload {
  const nativeEvent = NATIVE_EVENT_MAP[platform as AgentId]?.[event] ?? String(raw["hook_event_name"] ?? event);
  return {
    platform,
    event,
    nativeEvent,
    sessionId: pick(raw, "session_id", "sessionId") as string | undefined,
    conversationId: pick(raw, "conversationId") as string | undefined,
    cwd: pick(raw, "cwd") as string | undefined,
    transcriptPath: pick(raw, "transcript_path", "transcriptPath") as string | undefined,
    permissionMode: pick(raw, "permission_mode", "permissionMode") as string | undefined,
    toolName: pick(raw, "tool_name", "toolName") as string | undefined,
    toolInput: pick(raw, "tool_input", "toolInput"),
    toolResponse: pick(raw, "tool_response", "toolResponse"),
    prompt: pick(raw, "prompt") as string | undefined,
    stopHookActive: pick(raw, "stop_hook_active", "stopHookActive") as boolean | undefined,
    raw,
  };
}

/** Translate a canonical HookResult into platform-native stdout JSON + exit code. */
export function toPlatformOutput(
  platform: AgentId | "unknown",
  result: HookResult,
): { stdout: string | undefined; exitCode: number } {
  if (result.raw !== undefined) {
    return { stdout: JSON.stringify(result.raw), exitCode: result.block ? 2 : 0 };
  }
  const out: Record<string, unknown> = {};
  if (result.systemMessage) out["systemMessage"] = result.systemMessage;
  if (result.additionalContext) {
    if (platform === "antigravity") {
      // PostInvocation injectSteps (camelCase protocol)
      out["injectSteps"] = [{ type: "userMessage", content: result.additionalContext }];
    } else {
      out["hookSpecificOutput"] = { additionalContext: result.additionalContext };
    }
  }
  if (result.permissionDecision) {
    if (platform === "antigravity") {
      out["decision"] = result.permissionDecision;
    } else if (platform === "codex") {
      out["hookSpecificOutput"] = {
        ...(out["hookSpecificOutput"] as object | undefined),
        permissionDecision: result.permissionDecision,
        ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
      };
    } else {
      out["hookSpecificOutput"] = {
        ...(out["hookSpecificOutput"] as object | undefined),
        permissionDecision: result.permissionDecision,
        ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
      };
    }
  }
  if (result.block) {
    if (platform === "antigravity") {
      out["decision"] = "deny";
      if (result.reason) out["reason"] = result.reason;
    } else {
      out["decision"] = "block";
      if (result.reason) out["reason"] = result.reason;
    }
    return { stdout: Object.keys(out).length ? JSON.stringify(out) : undefined, exitCode: 2 };
  }
  return { stdout: Object.keys(out).length ? JSON.stringify(out) : undefined, exitCode: 0 };
}

/** Build the cross-platform hook command line every adapter emits. */
export function hookCommand(runtimeJs: string, hook: Hook): { command: string; args: string[] } {
  return {
    command: process.execPath || "node",
    args: [runtimeJs, hook.id],
  };
}

/**
 * Per-hook runtime policy the runner needs but cannot derive on its own.
 *
 * The runner is dependency-free and never parses the manifest (that needs a
 * YAML parser it deliberately does not ship). So the *build* step — which does
 * have the parser — extracts the policy and writes it into the bundle as JSON.
 * The runner reads that file. This keeps the runtime self-contained without
 * weakening the manifest as the single source of truth.
 */
export interface HookPolicy {
  /** Hard deadline for the handler, in seconds. Absent = no deadline. */
  timeoutSec?: number;
  /**
   * What a handler failure means:
   * - "blocking"   → the host is denied (exit 2; Antigravity: decision "deny")
   * - "non-blocking" → the host continues (exit 0)
   */
  failurePolicy: "blocking" | "non-blocking";
}

/** Every hook's runtime policy, keyed by hook id. */
export type HookPolicies = Record<string, HookPolicy>;

/** Filename (relative to the bundle's hooks dir) of the emitted policy file. */
export const HOOK_POLICIES_FILENAME = "policies.json";

/** Extract the runtime policy of every hook in a plugin. */
export function hookPolicies(hooks: readonly Hook[]): HookPolicies {
  const out: HookPolicies = {};
  for (const hook of hooks) {
    out[hook.id] = {
      ...(hook.timeoutSec !== undefined ? { timeoutSec: hook.timeoutSec } : {}),
      failurePolicy: hook.failurePolicy,
    };
  }
  return out;
}

/**
 * Serialize hook policies into the JSON the dependency-free runner reads.
 *
 * The runner never parses YAML, so the build step writes this file. The shape
 * is deliberately flat (`{ "<hook-id>": { timeoutSec, failurePolicy } }`) so the
 * runner can look up one hook without walking a schema.
 */
export function renderHookPolicies(hooks: readonly Hook[]): string {
  return JSON.stringify(hookPolicies(hooks), null, 2) + "\n";
}
