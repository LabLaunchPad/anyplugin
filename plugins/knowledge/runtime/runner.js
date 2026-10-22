#!/usr/bin/env node
/**
 * AnyPlugin canonical hook runner — the ONE process all four agents execute.
 * Usage:
 *   node runner.js <hook-id>                    single hook
 *   node runner.js --batch '<json>'             batch execution
 *
 * Self-contained by design: emitted bundles must run without the AnyPlugin
 * workspace. Handlers live at ./handlers/<hook-id>.mjs next to this file and
 * export `async function run(payload) => HookResult`.
 *
 * HookResult: { block?, reason?, additionalContext?, permissionDecision?,
 *               systemMessage?, raw? }
 *
 * Exit codes:
 *   0 = success (no block) / non-blocking failure
 *   1 = runner error (parse failure, import failure)
 *   2 = hook blocked (decision: "block") OR blocking-policy failure
 *   3 = capability unknown / fail-closed
 *   4 = invalid input / malformed payload
 *
 * ── Runtime policy (timeout + failure policy) ─────────────────────────────
 *
 * `timeoutSec` and `failurePolicy` live in the manifest, but this runner is
 * dependency-free and never parses YAML. The build step (which does have a
 * parser) writes the policy for every hook to `hooks/policies.json` in the
 * bundle; the runner reads that file. A payload may override both, which is
 * how `anyplugin run` and the tests exercise the paths directly.
 */

import { readFileSync, realpathSync, lstatSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve, parse, sep, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RUNNER_DIR = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const hookId = args[0];

/** Default policy when nothing declares one: fail open, never break the host. */
const DEFAULT_FAILURE_POLICY = "non-blocking";

/**
 * The prefix of the stderr note written when a handler fails.
 *
 * It is a named convention because batch mode has to recognise it: under the
 * default "non-blocking" policy a failure exits 0, so the exit code alone
 * cannot tell a success from a failure the policy let through.
 */
const FAILURE_NOTE_PREFIX = "anyplugin runner ";

/**
 * The runtime's own SafePath — the ONE way untrusted input becomes a path.
 *
 * This mirrors `core/src/fs/safe-path.ts` exactly, but it is INLINED because
 * the runtime ships with no dependencies: an emitted bundle must run on a
 * machine that has Node and nothing else. A handler that imported
 * `@lablaunchpad/core` for this would break that contract, and the Node 20 CI
 * job exists to catch exactly that.
 *
 * The equivalence with the core implementation is not assumed — it is proven
 * by a differential test over a hostile corpus.
 */
function isContained(candidate, root) {
  const norm = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  if (norm(candidate) === norm(root)) return true;
  const withSep = root.endsWith(sep) ? root : root + sep;
  return norm(candidate).startsWith(norm(withSep));
}

function tryRealpath(p) {
  try {
    return realpathSync(p);
  } catch (err) {
    // ENOENT is the normal case — the path does not exist yet, and the
    // walk-up loop depends on it. Anything else (EACCES, ELOOP, a device
    // error) means the path could not be RESOLVED, and treating that as
    // "absent" would walk the probe past a directory it could not inspect.
    // core/src/fs/safe-path.ts refuses in that case, and this copy must
    // refuse the same way: the comment above claims the two are equivalent,
    // and the differential test in dependency-free.test.ts is what keeps
    // them that way.
    if (err.code === "ENOENT") return null;
    throw new Error(`path escape/resolution error: cannot resolve realpath for ${p}: ${err.message}`);
  }
}

function entryExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw new Error(`unsafe path: cannot stat entry ${p}: ${err.message}`);
  }
}

/** Lexical validation of an untrusted RELATIVE path. Returns the posix form. */
function assertSafeRelative(input) {
  if (typeof input !== "string" || input.length === 0) throw new Error("unsafe path: empty input");
  if (input.length > 4096) throw new Error("unsafe path: longer than 4096 bytes");
  if (input.includes("\0")) throw new Error("unsafe path: NUL byte");
  if (isAbsolute(input)) throw new Error(`unsafe path: absolute path ${JSON.stringify(input)}`);
  if (/^[A-Za-z]:/u.test(input) || input.startsWith("\\\\") || input.startsWith("//")) {
    throw new Error(`unsafe path: drive/UNC path ${JSON.stringify(input)}`);
  }
  if (sep === "/" && input.includes("\\")) throw new Error("unsafe path: backslash separator on posix");
  const segments = [];
  for (const raw of input.split(/[\\/]+/u)) {
    if (raw === "" || raw === ".") continue;
    if (raw === "..") throw new Error(`unsafe path: traversal segment in ${JSON.stringify(input)}`);
    if (raw.length > 255) throw new Error("unsafe path: segment longer than 255 bytes");
    if (/^[A-Za-z]:/u.test(raw)) throw new Error(`unsafe path: drive-letter segment ${JSON.stringify(input)}`);
    if (/[\x00-\x1f\x7f]/.test(raw)) throw new Error("unsafe path: control characters");
    segments.push(raw);
  }
  if (segments.length === 0) throw new Error("unsafe path: resolves to the authorized root itself");
  return segments.join("/");
}

/**
 * Resolve an untrusted relative path against an authorized root, with
 * two-sided realpath containment. Throws on any escape.
 */
function resolveAuthorizedPath(authorizedRoot, untrustedInput) {
  const rel = assertSafeRelative(untrustedInput);
  const rootReal = tryRealpath(resolve(authorizedRoot));
  if (rootReal === null) throw new Error(`unsafe path: authorized root does not exist: ${authorizedRoot}`);
  const candidate = resolve(authorizedRoot, rel);

  let probe = candidate;
  for (;;) {
    const probed = tryRealpath(probe);
    if (probed !== null) {
      if (!isContained(probed, rootReal)) {
        throw new Error(`path escape detected: ${JSON.stringify(untrustedInput)} resolves outside the authorized root`);
      }
      return candidate;
    }
    // realpath failed but the entry EXISTS => an unresolvable link, whose
    // target may live outside the root. Refuse rather than treat it as absent.
    if (entryExists(probe)) {
      throw new Error(`path escape detected: ${JSON.stringify(untrustedInput)} passes through an unresolvable link`);
    }
    if (probe === parse(probe).root || probe.length <= 2) {
      throw new Error(`unsafe path: authorized root does not exist: ${authorizedRoot}`);
    }
    const idx = probe.lastIndexOf(sep);
    if (idx < 0) throw new Error(`unsafe path: cannot resolve ${JSON.stringify(untrustedInput)}`);
    probe = probe.slice(0, idx);
  }
}

// --- batch mode ---
if (args[0] === "--batch") {
  const batchPayload = args[1];
  if (!batchPayload) {
    process.stderr.write("anyplugin runner: --batch requires a JSON payload\n");
    process.exit(4);
  }
  let batch;
  try {
    batch = JSON.parse(batchPayload);
  } catch {
    process.stderr.write("anyplugin runner: --batch payload is not valid JSON\n");
    process.exit(4);
  }

  if (!Array.isArray(batch.hookIds) || batch.hookIds.length === 0) {
    process.stderr.write("anyplugin runner: --batch requires hookIds array\n");
    process.exit(4);
  }

  // Each hook runs in its OWN process, in single-hook mode. The child is
  // spawned with `process.execPath` and this file's own path — NOT with
  // `require`, which does not exist in an ES module.
  const RUNNER_PATH = fileURLToPath(import.meta.url);
  const runOne = (id) =>
    new Promise((resolveOne) => {
      const child = spawn(process.execPath, [RUNNER_PATH, id], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d.toString()));
      child.stderr.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        resolveOne({ hookId: id, code: 1, stdout: "", stderr: String(err && err.message ? err.message : err) });
      });
      child.on("close", (code) => {
        resolveOne({ hookId: id, code: code === null ? 1 : code, stdout, stderr });
      });
      // The batch payload is the child's stdin, exactly as in single mode.
      if (typeof batch.payload === "string" && batch.payload.length > 0) {
        child.stdin.write(batch.payload);
      }
      child.stdin.end();
    });

  // The process must NOT exit before the children are done: the combined
  // result is written from the promise resolution, and an early exit would
  // truncate it to nothing.
  const settled = await Promise.all(batch.hookIds.map((id) => runOne(id)));
  // A handler failure under the default "non-blocking" policy exits 0 — the
  // host must never break — so the exit code alone cannot distinguish "the
  // hook succeeded" from "the hook failed and the policy let it pass". The
  // evidence is the failure note the child wrote to stderr, so the summary
  // counts that as an error too. Without this the summary would report a
  // failed hook as a success.
  const failed = (r) => r.code !== 0 || r.stderr.startsWith(FAILURE_NOTE_PREFIX);
  const combined = {
    hookResults: settled,
    summary: {
      total: settled.length,
      success: settled.filter((r) => !failed(r)).length,
      blocked: settled.filter((r) => r.code === 2).length,
      // 1 = runner error, 3 = capability unknown / fail-closed, 4 = invalid input.
      errors: settled.filter(failed).length,
    },
  };
  process.stdout.write(JSON.stringify(combined));
  process.exit(0);
}

// --- single hook mode ---
if (!hookId) {
  process.stderr.write("anyplugin runner: missing hook id\n");
  process.exit(1);
}
// The hook id becomes part of a module import path — lock it to a plain
// identifier so a hostile/typo'd id can never traverse the filesystem.
// Audit Finding A: strict ^[a-z][a-z0-9-]{0,63}$ (lowercase, starts with letter, max 64)
if (!/^[a-z][a-z0-9-]{0,63}$/.test(hookId)) {
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

// --- platform detection (inline mirror of @lablaunchpad/core detect)----------
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

// --- runtime context envelope ------------------------------------------------
// The context envelope is a set of key-value pairs passed from the host agent
// that can be read by handlers and modified by the runner. It is forwarded
// as part of the payload and also available as a top-level env variable
// RUNNER_CONTEXT for handlers that read it directly from the environment.
const contextEnv = env["RUNNER_CONTEXT"];
let context = {};
try {
  if (contextEnv && contextEnv.trim()) {
    context = JSON.parse(contextEnv);
  }
} catch {
  context = {};
}

/**
 * Resolve the runtime policy for a hook.
 *
 * Precedence (highest first):
 *   1. the payload — an explicit override from the caller (`anyplugin run`,
 *      tests, or a host that knows the hook's policy);
 *   2. `hooks/policies.json` in the bundle — written by the build step from
 *      the manifest, so the manifest stays the single source of truth;
 *   3. the built-in default — non-blocking, no deadline.
 *
 * A malformed policy file is ignored rather than fatal: a broken policy must
 * never take the host agent down with it.
 */
function resolvePolicy(id, override) {
  const policy = { failurePolicy: DEFAULT_FAILURE_POLICY, timeoutSec: undefined };

  // Candidate policy files, in priority order. The runner sits at
  // <bundle>/hooks/runner.js in every emitted layout, so the policy file the
  // build writes at <bundle>/hooks/policies.json is found via the bundle root.
  const roots = [RUNNER_DIR, resolve(RUNNER_DIR, ".."), pluginRoot].filter(Boolean);
  const candidates = [];
  for (const root of roots) {
    candidates.push(join(root, "hooks", "policies.json"));
    candidates.push(join(root, "policies.json"));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(candidate, "utf8"));
      const entry = parsed && typeof parsed === "object" ? parsed[id] : undefined;
      if (entry && typeof entry === "object") {
        if (entry.failurePolicy === "blocking" || entry.failurePolicy === "non-blocking") {
          policy.failurePolicy = entry.failurePolicy;
        }
        if (Number.isFinite(entry.timeoutSec) && entry.timeoutSec > 0) policy.timeoutSec = entry.timeoutSec;
        break;
      }
    } catch {
      /* no policy file here — try the next candidate */
    }
  }

  // Payload overrides win, but only when they are well-formed.
  if (override && typeof override === "object") {
    if (override.failurePolicy === "blocking" || override.failurePolicy === "non-blocking") {
      policy.failurePolicy = override.failurePolicy;
    }
    if (Number.isFinite(override.timeoutSec) && override.timeoutSec > 0) {
      policy.timeoutSec = override.timeoutSec;
    }
  }

  if (policy.failurePolicy !== "blocking" && policy.failurePolicy !== "non-blocking") {
    policy.failurePolicy = DEFAULT_FAILURE_POLICY;
  }
  return policy;
}

// Merge context into payload for handler consumption
const payloadContext = {
  ...context,
  __envelope__: {
    source: env["ANYPLUGIN_HOST"] || "unknown",
    timestamp: Date.now(),
  },
};

/**
 * Resolve the untrusted `cwd` from the host's payload.
 *
 * The host's `cwd` is UNTRUSTED input: it arrives over stdin and is used to
 * build filesystem paths. It is validated here — at the single point where
 * untrusted input enters the runtime — so that a handler can trust
 * `payload.cwd` without repeating the check (and without importing a
 * SafePath implementation, which the dependency-free runtime cannot do).
 *
 * A `cwd` that escapes falls back to the process's own directory rather than
 * failing the hook: a wrong directory is recoverable, a broken host is not.
 */
function safeCwd() {
  const rawCwd = raw["cwd"] ?? raw["cwdPath"];
  if (typeof rawCwd !== "string" || rawCwd.trim() === "") return process.cwd();
  try {
    return resolveAuthorizedPath(process.cwd(), rawCwd);
  } catch {
    return process.cwd();
  }
}

// --- execute handler -------------------------------------------------------
// The runtime policy is resolved BEFORE the payload so handlers can see it.
const policyOverride = {
  ...(raw["timeoutSec"] !== undefined ? { timeoutSec: raw["timeoutSec"] } : {}),
  ...(raw["failurePolicy"] !== undefined ? { failurePolicy: raw["failurePolicy"] } : {}),
  ...(raw["__policy"] && typeof raw["__policy"] === "object" ? raw["__policy"] : {}),
};
const policy = resolvePolicy(hookId, policyOverride);

const payload = {
  platform,
  hookId,
  pluginRoot,
  intensityMode,
  sessionId: raw["session_id"] ?? raw["sessionId"],
  conversationId: raw["conversationId"],
  // Validated above: a handler may trust this.
  cwd: safeCwd(),
  transcriptPath: raw["transcript_path"] ?? raw["transcriptPath"],
  permissionMode: raw["permission_mode"] ?? raw["permissionMode"],
  toolName: raw["tool_name"] ?? raw["toolName"],
  toolInput: raw["tool_input"] ?? raw["toolInput"],
  toolResponse: raw["tool_response"] ?? raw["toolResponse"],
  prompt: raw["prompt"],
  policy,
  raw,
  ...payloadContext,
};

let result = {};

/**
 * Exit the process according to the hook's failure policy.
 *
 * "non-blocking" (the default) keeps the host running: exit 0 with a stderr
 * note. "blocking" denies the host: exit 2 so the host treats the hook as a
 * hard stop. Antigravity's protocol differs — it expects `decision: "deny"`
 * on stdout with exit 0 semantics — so the denial is expressed there.
 */
function exitForFailure(message, kind) {
  process.stderr.write(`anyplugin runner ${hookId} ${kind}: ${message}`);
  if (policy.failurePolicy === "blocking") {
    if (platform === "antigravity") {
      process.stdout.write(JSON.stringify({ decision: "deny", reason: message }));
      process.exit(0);
    }
    process.exit(2);
  }
  process.exit(0);
}

/**
 * Run the handler under a hard deadline.
 *
 * The timer is what makes the deadline real: when it fires we call
 * `process.exit`, which tears down the event loop and any pending handler
 * work. A bare `Promise.race` would leave the handler running in the
 * background, so the runner would keep the process alive past its deadline.
 */
async function runWithDeadline(fn) {
  if (!policy.timeoutSec) return await fn();
  const deadlineMs = Math.ceil(policy.timeoutSec * 1000);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => fn()),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`handler exceeded timeoutSec ${policy.timeoutSec}`);
          err["code"] = "ANYPLUGIN_TIMEOUT";
          reject(err);
        }, deadlineMs);
        // The timer is deliberately NOT unref'd. An unref'd timer does not keep
        // the event loop alive, so a handler awaiting a promise that will never
        // settle would let the process exit 0 — silently reporting success for
        // a hook that never ran. The `finally` below clears it as soon as the
        // handler settles, so there is no leak.
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
    exitForFailure(`handler ${hookId} exports no run()`, "failed");
  }
  result = (await runWithDeadline(() => fn(payload))) ?? {};
} catch (err) {
  const isTimeout = err && err["code"] === "ANYPLUGIN_TIMEOUT";
  exitForFailure(
    isTimeout ? err.message : (err && err.message ? err.message : String(err)),
    isTimeout ? "timed out" : "failed",
  );
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
  // F-04: merge raw as fallback — explicitly set fields take priority
  // over raw, establishing a single precedence rule: explicit fields > raw fallback.
  // This resolves the divergence where runner formerly unconditionally overwrote
  // everything with raw, while core early-returns on raw discarding other fields.
  for (const [key, value] of Object.entries(result.raw)) {
    if (!(key in out)) out[key] = value;
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
}

// Error code determination based on result
// F-08: exit code is platform-aware — Antigravity uses decision: "deny" with exit 0
// semantics per its protocol, while other hosts (claude-code, opencode, codex) use
// decision: "block" with exit code 2.
let exitCode = 0; // 0 = success
if (result.block) {
  exitCode = platform === "antigravity" ? 0 : 2; // 2 = hook blocked (non-Antigravity)
}
// If the handler explicitly set a non-zero exit-worthy condition, respect it
// (this is extendable; currently only block maps to exit code 2)

if (Object.keys(out).length > 0) {
  process.stdout.write(JSON.stringify(out));
}
process.exit(exitCode);