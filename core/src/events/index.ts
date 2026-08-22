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
    "prompt-submit": "chat.message",
    "turn-stop": "session.idle",
    "session-end": "session.idle",
    "permission-request": "permission.ask",
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
