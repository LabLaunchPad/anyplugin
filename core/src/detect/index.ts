import { existsSync } from "node:fs";
import { join, dirname } from "node:path";

/** The four agents AnyPlugin adapts to. */
export type AgentId = "claude-code" | "opencode" | "codex" | "antigravity";

export const ALL_AGENTS: readonly AgentId[] = ["claude-code", "opencode", "codex", "antigravity"];

export interface Detection {
  agent: AgentId | null;
  /** authoritative = documented marker set by the agent itself; high = strong but community-verified;
   *  inferred = filesystem/env fingerprints; marker = our own injected self-marker. */
  confidence: "marker" | "authoritative" | "high" | "inferred" | "none";
  signals: string[];
}

interface EnvLike {
  [key: string]: string | undefined;
}

function hasEnv(env: EnvLike, key: string): boolean {
  const v = env[key];
  return v !== undefined && v !== "";
}

/** Detect which coding agent is driving the current process (see knowledge/adapters/detection-matrix.md). */
export function detectAgent(env: EnvLike, home: string): Detection {
  const signals: string[] = [];

  // 0. Our own self-marker (injected by the opencode shell.env shim / claude hooks).
  // ANYPLUGIN_HOST is current; AGENT_PRISM_HOST read as a legacy alias.
  const host = env["ANYPLUGIN_HOST"] ?? env["AGENT_PRISM_HOST"];
  if (host === "opencode" || host === "claude-code" || host === "codex" || host === "antigravity") {
    return { agent: host, confidence: "marker", signals: ["ANYPLUGIN_HOST"] };
  }

  // 1. Claude Code — CLAUDECODE=1 is set in ALL spawned subprocesses (documented).
  if (env["CLAUDECODE"] === "1") {
    signals.push("CLAUDECODE=1");
    return { agent: "claude-code", confidence: "authoritative", signals };
  }
  if (hasEnv(env, "CLAUDE_CODE_SESSION_ID")) {
    signals.push("CLAUDE_CODE_SESSION_ID");
    return { agent: "claude-code", confidence: "authoritative", signals };
  }

  // 2. Codex — sandbox markers set inside child shells.
  if (hasEnv(env, "CODEX_SANDBOX") || hasEnv(env, "CODEX_CI")) {
    signals.push("CODEX_SANDBOX/CODEX_CI");
    return { agent: "codex", confidence: "high", signals };
  }

  // 3. Antigravity — community-verified marker (not in official docs).
  if (hasEnv(env, "ANTIGRAVITY_AGENT")) {
    signals.push("ANTIGRAVITY_AGENT");
    return { agent: "antigravity", confidence: "high", signals };
  }
  if (hasEnv(env, "VSCODE_PID") && existsSync(join(home, ".gemini"))) {
    signals.push("VSCODE_PID + ~/.gemini/");
    return { agent: "antigravity", confidence: "inferred", signals };
  }

  // 4. OpenCode — NO native marker (issue #34065). OPENCODE_TERMINAL covers v2 PTY sessions only.
  const opencodeEnvKeys = [
    "OPENCODE_TERMINAL",
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_SERVER",
  ];
  const hit = opencodeEnvKeys.find((k) => hasEnv(env, k));
  if (hit) {
    signals.push(hit);
    return { agent: "opencode", confidence: "inferred", signals };
  }

  // Filesystem fallbacks.
  if (existsSync(join(home, ".claude"))) {
    signals.push("~/.claude/");
    return { agent: "claude-code", confidence: "inferred", signals };
  }
  if (existsSync(join(home, ".codex", "config.toml"))) {
    signals.push("~/.codex/config.toml");
    return { agent: "codex", confidence: "inferred", signals };
  }
  if (existsSync(join(home, ".config", "opencode"))) {
    signals.push("~/.config/opencode/");
    return { agent: "opencode", confidence: "inferred", signals };
  }

  return { agent: null, confidence: "none", signals };
}

export interface EnvironmentInfo {
  platform: NodeJS.Platform;
  os: "windows" | "macos" | "linux" | "other";
  shell: string;
  /** claude permission_mode (default|plan|acceptEdits|auto|dontAsk|bypassPermissions) or codex sandbox mode if known. */
  permissionMode: string | null;
  networkBlocked: boolean;
  cwd: string;
  gitRepo: boolean;
  nodeVersion: string;
}

/** Environment capability layer used to gate capabilities{} per platform. */
export function detectEnvironment(env: EnvLike, cwd: string): EnvironmentInfo {
  const platform = process.platform;
  const os =
    platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : "other";
  let gitRepo = false;
  let dir: string | undefined = cwd;
  while (dir) {
    if (existsSync(join(dir, ".git"))) {
      gitRepo = true;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return {
    platform,
    os,
    shell: env["COMSPEC"] ?? env["SHELL"] ?? (os === "windows" ? "cmd.exe" : "/bin/sh"),
    permissionMode: env["CLAUDE_PERMISSION_MODE"] ?? null,
    networkBlocked: env["CODEX_SANDBOX_NETWORK_DISABLED"] === "1",
    cwd,
    gitRepo,
    nodeVersion: process.version,
  };
}

/** Filesystem scan for CLI install targeting: which agents have user-level config on this machine. */
export function detectInstalledAgents(home: string, env: EnvLike): AgentId[] {
  const found: AgentId[] = [];
  if (env["CLAUDECODE"] === "1" || existsSync(join(home, ".claude"))) found.push("claude-code");
  if (env["CODEX_HOME"]
    ? existsSync(join(env["CODEX_HOME"]!, "config.toml"))
    : existsSync(join(home, ".codex", "config.toml"))) {
    found.push("codex");
  }
  const cfgDir = env["OPENCODE_CONFIG_DIR"] ?? join(home, ".config", "opencode");
  if (existsSync(cfgDir)) found.push("opencode");
  if (existsSync(join(home, ".gemini"))) found.push("antigravity");
  return found;
}
