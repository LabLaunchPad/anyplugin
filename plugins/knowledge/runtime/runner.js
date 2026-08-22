#!/usr/bin/env node
/**
 * AnyPlugin canonical hook runner — the ONE process all four agents execute.
 * Usage: node runner.js <hook-id>   (platform JSON arrives on stdin)
 *
 * Self-contained by design: emitted bundles must run without the AnyPlugin
 * workspace. Handlers live at ./handlers/<hook-id>.mjs next to this file and
 * export `async function run(payload) => HookResult`.
 *
 * HookResult: { block?, reason?, additionalContext?, permissionDecision?,
 *               systemMessage?, raw? }
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const hookId = process.argv[2];
// The hook id becomes part of a module import path — lock it to a plain
// identifier so a hostile/typo'd id can never traverse the filesystem.
if (!hookId || !/^[a-zA-Z0-9_-]+$/.test(hookId)) {
  process.stderr.write("anyplugin runner: invalid hook id\n");
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
  process.stderr.write(`anyplugin runner: stdin was not JSON (${rawText.slice(0, 80)}…)`);
  process.exit(0); // never break the host agent on our own parse failure
}

// --- platform detection (inline mirror of @lablaunchpad/core detect) -------
const env = process.env;
let platform = "unknown";
const hostMarker = env["ANYPLUGIN_HOST"];
if (hostMarker === "claude-code" || hostMarker === "opencode" || hostMarker === "codex" || hostMarker === "antigravity") {
  platform = hostMarker;
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
  env["ANYPLUGIN_PLUGIN_ROOT"] ||
  env["CLAUDE_PLUGIN_ROOT"] ||
  env["PLUGIN_ROOT"] ||
  resolve(RUNNER_DIR, "..");

// Runtime intensity mode (ponytail pattern): a tiny flag file inside the
// plugin root; best-effort read so a missing/corrupt flag never breaks a hook.
let intensityMode = null;
try {
  const flag = JSON.parse(readFileSync(join(pluginRoot, ".anyplugin-mode"), "utf8"));
  if (flag && typeof flag.mode === "string") intensityMode = flag.mode;
} catch {
  /* no mode set — handlers treat null as the default/balanced behavior */
}

// --- execute handler -------------------------------------------------------
const payload = {
  platform,
  hookId,
  pluginRoot,
  intensityMode,
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
  // Emitted bundles place handlers at ./handlers/<id>.mjs next to this runner;
  // the canonical repo layout keeps the runner in plugins/<name>/runtime/ and
  // handlers in plugins/<name>/plugin/hooks/.
  // Handler discovery: every candidate is CONSTRUCTED with path joins from the
  // validated hook id under fixed roots — never by concatenating unvalidated
  // strings, so no ../ can enter a path. Roots: the runner's own dir (emitted
  // layout: handlers/<id>.mjs), the bundle root (repo layout:
  // plugin/hooks/<id>.mjs), and the host-injected plugin root (trusted env:
  // hooks/<id>.mjs).
  const candidates = [
    join(RUNNER_DIR, "handlers", `${hookId}.mjs`),
    join(resolve(RUNNER_DIR, ".."), "plugin", "hooks", `${hookId}.mjs`),
    pluginRoot ? join(pluginRoot, "hooks", `${hookId}.mjs`) : undefined,
  ].filter(Boolean);
  let mod;
  let lastError;
  for (const candidate of candidates) {
    try {
      mod = await import(pathToFileURL(candidate).href);
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (!mod) throw lastError ?? new Error("no handler found");
  const fn = mod.run ?? mod.default?.run ?? mod.default;
  if (typeof fn !== "function") {
    process.stderr.write(`anyplugin runner: handler ${hookId} exports no run()`);
    process.exit(0);
  }
  result = (await fn(payload)) ?? {};
} catch (err) {
  process.stderr.write(`anyplugin runner ${hookId} failed: ${err && err.message ? err.message : err}`);
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
