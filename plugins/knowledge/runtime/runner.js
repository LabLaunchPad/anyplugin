#!/usr/bin/env node
/**
 * agent-prism canonical hook runner — the ONE process all four agents execute.
 * Usage: node runner.js <hook-id>   (platform JSON arrives on stdin)
 *
 * Self-contained by design: emitted bundles must run without the agent-prism
 * workspace. Handlers live at ./handlers/<hook-id>.mjs next to this file and
 * export `async function run(payload) => HookResult`.
 *
 * HookResult: { block?, reason?, additionalContext?, permissionDecision?,
 *               systemMessage?, raw? }
 */
import { readFileSync } from "node:fs";
import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const hookId = process.argv[2];
if (!hookId) {
  console.error("usage: node runner.js <hook-id>");
  process.exit(1);
}

// --- stdin ---------------------------------------------------------------
let rawText = "";
try {
  rawText = readFileSync(0, "utf8");
} catch {
  rawText = "";
}
let raw = {};
try {
  raw = rawText.trim() ? JSON.parse(rawText) : {};
} catch {
  process.stderr.write(`agent-prism runner: stdin was not JSON (${rawText.slice(0, 80)}…)`);
  process.exit(0); // never break the host agent on our own parse failure
}

// --- platform detection (inline mirror of @agent-prism/core detect) -------
const env = process.env;
let platform = "unknown";
if (env["AGENT_PRISM_HOST"] === "claude-code" || env["AGENT_PRISM_HOST"] === "opencode" || env["AGENT_PRISM_HOST"] === "codex" || env["AGENT_PRISM_HOST"] === "antigravity") {
  platform = env["AGENT_PRISM_HOST"];
} else if (env["CLAUDECODE"] === "1" || env["CLAUDE_CODE_SESSION_ID"]) {
  platform = "claude-code";
} else if ((env["CODEX_SANDBOX"] && env["CODEX_SANDBOX"] !== "") || env["CODEX_CI"]) {
  platform = "codex";
} else if (env["ANTIGRAVITY_AGENT"]) {
  platform = "antigravity";
}

// --- plugin root discovery -------------------------------------------------
// Claude Code and Codex inject CLAUDE_PLUGIN_ROOT / PLUGIN_ROOT for plugin hooks;
// OpenCode shim and Antigravity install embed absolute paths; fallback: runner's
// grandparent directory (bundle root).
const pluginRoot =
  env["CLAUDE_PLUGIN_ROOT"] ||
  env["PLUGIN_ROOT"] ||
  env["AGENT_PRISM_PLUGIN_ROOT"] ||
  resolve(RUNNER_DIR, "..");

// --- execute handler -------------------------------------------------------
const payload = {
  platform,
  hookId,
  pluginRoot,
  sessionId: raw["session_id"] ?? raw["sessionId"],
  conversationId: raw["conversationId"],
  cwd: raw["cwd"] ?? process.cwd(),
  transcriptPath: raw["transcript_path"] ?? raw["transcriptPath"],
  permissionMode: raw["permission_mode"] ?? raw["permissionMode"],
  toolName: raw["tool_name"] ?? raw["toolName"],
  toolInput: raw["tool_input"] ?? raw["toolInput"],
  toolResponse: raw["tool_response"] ?? raw["toolResponse"],
  prompt: raw["prompt"],
  raw,
};

let result = {};
try {
  const handlerUrl = new URL(`./handlers/${hookId}.mjs`, `${import.meta.url}`);
  const mod = await import(handlerUrl.href);
  const fn = mod.run ?? mod.default?.run ?? mod.default;
  if (typeof fn !== "function") {
    process.stderr.write(`agent-prism runner: handler ${hookId} exports no run()`);
    process.exit(0);
  }
  result = (await fn(payload)) ?? {};
} catch (err) {
  process.stderr.write(`agent-prism runner ${hookId} failed: ${err && err.message ? err.message : err}`);
  process.exit(0); // handler failure must not break the host agent
}

// --- translate to platform output -------------------------------------------
const out = {};
if (result.systemMessage) out["systemMessage"] = result.systemMessage;
if (result.additionalContext) {
  if (platform === "antigravity") {
    out["injectSteps"] = [{ type: "userMessage", content: result.additionalContext }];
  } else {
    out["hookSpecificOutput"] = { ...(out["hookSpecificOutput"] ?? {}), additionalContext: result.additionalContext };
  }
}
if (result.permissionDecision) {
  const d = result.permissionDecision;
  if (platform === "antigravity") {
    out["decision"] = d;
  } else if (platform === "codex") {
    out["hookSpecificOutput"] = {
      ...(out["hookSpecificOutput"] ?? {}),
      permissionDecision: d,
      ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
    };
  } else {
    out["hookSpecificOutput"] = {
      ...(out["hookSpecificOutput"] ?? {}),
      permissionDecision: d,
      ...(result.reason ? { permissionDecisionReason: result.reason } : {}),
    };
  }
}
if (result.raw && typeof result.raw === "object") {
  Object.assign(out, result.raw);
}
if (result.block) {
  if (platform === "antigravity") {
    out["decision"] = "deny";
    if (result.reason) out["reason"] = result.reason;
  } else {
    out["decision"] = "block";
    if (result.reason) out["reason"] = result.reason;
  }
}

if (Object.keys(out).length > 0) {
  process.stdout.write(JSON.stringify(out));
}
process.exit(result.block ? 2 : 0);
