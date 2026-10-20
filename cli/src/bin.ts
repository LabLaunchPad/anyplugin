#!/usr/bin/env node
import { homedir, tmpdir, hostname } from "node:os";
import { join, resolve, dirname } from "node:path";
import { statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  buildAll,
  executeInstall,
  executeUninstall,
  scaffoldPlugin,
  installInstructions,
  uninstallInstructions,
  installedRoot,
  detectAgent,
  detectInstalledAgents,
  detectEnvironment,
  loadPluginSafe,
  validateBundle,
  regenerateIndexes,
} from "./index.js";
import type { AgentId } from "@lablaunchpad/core";
import { ALL_AGENTS, removeTree, pathExists, BackendCatalog } from "@lablaunchpad/core";
import { parseCliArgv, type CommandName } from "./strict-args.js";
import { setIntensityMode, getActivePlugin } from "./state.js";
import { JOURNAL_SCHEMA_VERSION as CURRENT_JOURNAL_SCHEMA_VERSION } from "./journal.js";
import { delegate, persistDelegationTelemetry, probeBackend } from "./delegate.js";
import { BACKUPS_DIRNAME, STAGING_DIRNAME } from "./transaction.js";
import { readFile } from "node:fs/promises";

const HELP = `anyplugin — agent-agnostic plugin development for Claude Code, OpenCode, Codex, Antigravity

Every agent has plugin dev. AnyPlugin makes it agent-agnostic.

commands:
  anyplugin init --name NAME [--dir DIR]
                                     scaffold a new plugin from templates/starter
  anyplugin detect                   show detected agent + environment + installed agents
  anyplugin build [--plugin DIR] [--out DIR] [--agents LIST]
                                     emit native bundles per agent (default all four)
  anyplugin install [--plugin DIR] [--agents LIST] [--home DIR] [--project DIR] [--dry-run] [--tier native|instruction]
                                     install emitted bundles into agent locations
  anyplugin uninstall [--plugin DIR] [--agents LIST] [--home DIR] [--project DIR] [--dry-run] [--tier native|instruction]
                                       reverse an install
  anyplugin intensity --mode conservative|balanced|aggressive [--plugin DIR] [--agents LIST] [--home DIR] [--project DIR]
                                     switch the active intensity mode for every currently-installed root of this plugin
  anyplugin okf-validate [DIR]       validate an OKF v0.2 bundle (default ./knowledge)
  anyplugin okf-reindex [DIR]        regenerate bundle index.md files
  anyplugin doctor [--json] [--fix]   diagnose runtime issues (stale locks, stale journals,
                                      orphaned install transactions, etc.); --fix auto-remediates
                                      safe problems (never repairs a corrupt journal)
  anyplugin backends list|probe [--registry FILE] [--json]
                                      list the declared delegation backends, or probe them for
                                      availability (a probe never runs the real work)
  anyplugin delegate [--backend ID] [--capability CAP] [--domain DOM] [--registry FILE]
                                      [--timeout MS] [--budget MS] [--re-runnable] [--json] -- [ARGS...]
                                      run a request through the wrapper: capability-matched
                                      routing, safe spawn (never a shell), deadline, output cap,
                                      and a classified failure for every attempt
                                      --budget MS bounds the WHOLE chain, not one attempt
                                      --re-runnable asserts the task is safe to repeat, which
                                      permits a fallback after a failed attempt; without it a
                                      failed attempt is never retried on another backend,
                                      because the attempt may already have had an effect
  anyplugin help                     this help
  anyplugin run <hook-id> [--plugin DIR] [--event <canonical-event>] [--payload '<json>']
                                  execute a hook handler locally with a payload

options:
  --plugin DIR     canonical plugin root containing anyplugin.plugin.yaml (default: .)
  --out DIR        build output root (default: .anyplugin-build)
  --agents LIST    comma subset of: claude-code,opencode,codex,antigravity
  --name NAME      plugin name for init (kebab-case)
  --dir DIR        target directory for init (default: ./NAME)
  --runner PATH    hook runner script copied into bundles (default: bundled runner)
  --tier native|instruction  install/uninstall as a native bundle (default) or as a
                   marked AGENTS.md section for agents with no plugin API (ponytail pattern)
  --mode MODE      intensity command: conservative|balanced|aggressive
  --mcp-runtime DIR  MCP server runtime dir copied into bundles
  --json           machine-readable JSON output for every command
`;

interface ParsedFlags {
  plugin?: string;
  out?: string;
  agents?: string;
  home?: string;
  project?: string;
  "dry-run"?: boolean;
  runner?: string;
  "mcp-runtime"?: string;
  name?: string;
  dir?: string;
  mode?: string;
  tier?: string;
  json?: boolean;
  fix?: boolean;
  "include-root"?: boolean;
  "re-runnable"?: boolean;
  budget?: string;
  registry?: string;
  backend?: string;
  capability?: string;
  domain?: string;
  timeout?: string;
  hookId?: string;
  event?: string;
  payload?: string;
}

/**
 * Execute a hook handler locally — spawns `node runner.js <hook-id>` with
 * the given (or auto-detected) payload, then prints the HookResult.
 *
 * Exit code is always 0 per the hook runtime protocol: handler failure is
 * non-blocking. The result JSON is printed to stdout.
 */
async function runCommand(values: ParsedFlags): Promise<void> {
  const pluginRoot = requireDir(resolve(values.plugin ?? "."), "--plugin");
  const hookId = values.hookId!;

  // Build the payload JSON
  let raw: Record<string, unknown> = {};
  if (values.payload) {
    raw = JSON.parse(values.payload);
  } else {
    // Auto-detect agent from env markers; fall back to minimal shape
    const hostMarker = process.env["ANYPLUGIN_HOST"];
    if (hostMarker === "claude-code" || hostMarker === "opencode" || hostMarker === "codex" || hostMarker === "antigravity") {
      raw = { cwd: process.cwd(), platform: hostMarker, hookId };
    } else if (process.env["CLAUDECODE"] === "1") {
      raw = { cwd: process.cwd(), platform: "claude-code", hookId };
    } else if ((process.env["CODEX_SANDBOX"] && process.env["CODEX_SANDBOX"] !== "") || process.env["CODEX_CI"]) {
      raw = { cwd: process.cwd(), platform: "codex", hookId };
    } else if (process.env["ANTIGRAVITY_AGENT"]) {
      raw = { cwd: process.cwd(), platform: "antigravity", hookId };
    } else {
      raw = { cwd: process.cwd(), platform: "unknown", hookId };
    }
    // Override event if provided
    if (values.event) {
      raw.event = values.event;
    }
  }

  // Ensure hookId is on the payload for the runner
  raw.hookId = hookId;

  // Spawn the self-contained runner
  const runnerPath = resolve(join(pluginRoot, "plugins/knowledge/runtime/runner.js"));
  const { spawn } = await import("node:child_process");
  const proc = spawn(process.execPath, [runnerPath, hookId], {
    cwd: pluginRoot,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ANYPLUGIN_HOST: values.payload ? undefined : (process.env["ANYPLUGIN_HOST"] || "unknown") },
  });

  // Write the payload JSON to the process stdin
  proc.stdin!.write(JSON.stringify(raw));
  proc.stdin!.end();

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d.toString()));
  proc.stderr.on("data", (d) => (stderr += d.toString()));

  await new Promise<void>((resolve) => proc.on("close", resolve));

  console.log("--- Hook Result ---");
  console.log("Exit code:", proc.exitCode ?? 0);
  console.log("STDOUT:", stdout);
  if (stderr) console.log("STDERR:", stderr);
  console.log("--- End ---");
}

/**
 * Is a process with this pid alive on this host?
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `EPERM` means the process EXISTS but belongs to another user —
 * which still counts as alive, because a live writer is a live writer.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true;
    return false;
  }
}

/** Run the doctor diagnostic command. */
async function runDoctor(values: ParsedFlags): Promise<void> {
  const home = values.home ?? homedir();
  const projectDir = resolve(values.project ?? process.cwd());
  const codexHome = process.env["CODEX_HOME"] ?? join(home, ".codex");
  const ctx = { home, projectDir, codexHome };
  
  const issues: Array<{ type: string; severity: "error" | "warning" | "info"; message: string; path?: string }> = [];
  
  // Check for stale locks in worker-runtime.
  //
  // "Stale" is decided by whether the HOLDING PROCESS IS STILL ALIVE, not by
  // how old the lock file is: a lock held by a live writer is legitimate no
  // matter its age, and a lock whose holder is gone is stale no matter how
  // recently it was written. The worker-runtime deliberately refuses to
  // auto-break locks, so the diagnosis is the only safe automation point.
  const workerRuntimeDir = join(projectDir, ".worker-runtime", "events");
  try {
    const lockPath = join(workerRuntimeDir, "writer.lock");
    const { lstat, readFile } = await import("node:fs/promises");
    try {
      const stat = await lstat(lockPath);
      const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);

      let holder: { pid?: number; host?: string; claimedAt?: string } = {};
      try {
        holder = JSON.parse((await readFile(lockPath, "utf8")).trim()) as typeof holder;
      } catch {
        // An unreadable lock is still a lock. The diagnosis must not soften
        // because the holder could not be described.
      }

      const sameHost = !holder.host || holder.host === hostname();
      const alive = sameHost && typeof holder.pid === "number" ? isProcessAlive(holder.pid) : null;

      if (alive === false) {
        issues.push({
          type: "stale-lock",
          severity: "error",
          message:
            `Stale worker-runtime lock: the holder (pid ${holder.pid ?? "?"} on ${holder.host ?? "?"}) is gone. ` +
            `Remove ${join(workerRuntimeDir, "writer.lock")} deliberately to release it — the runtime refuses to auto-break locks.`,
          path: lockPath,
        });
      } else if (alive === true) {
        issues.push({
          type: "active-lock",
          severity: "info",
          message: `Active worker-runtime lock held by pid ${holder.pid ?? "?"} on ${holder.host ?? "?"} (age: ${ageHours.toFixed(1)} hours)`,
          path: lockPath,
        });
      } else {
        // The holder is on another host, or the lock is unreadable: the
        // runtime cannot tell whether it is alive, so it must not be broken.
        issues.push({
          type: "unverifiable-lock",
          severity: ageHours > 24 ? "warning" : "info",
          message:
            `Worker-runtime lock held by ${holder.pid ? `pid ${holder.pid}` : "an unidentified writer"} on ${holder.host ?? "an unknown host"} ` +
            `(age: ${ageHours.toFixed(1)} hours) — liveness cannot be verified from this host, so the lock is left alone`,
          path: lockPath,
        });
      }
    } catch {
      // No lock file - this is normal
      issues.push({
        type: "no-lock",
        severity: "info",
        message: "No active worker-runtime lock",
        path: workerRuntimeDir,
      });
    }
  } catch {
    // Worker runtime directory doesn't exist
    issues.push({
      type: "no-runtime",
      severity: "info",
      message: "No worker-runtime directory found",
      path: workerRuntimeDir,
    });
  }
  
  // Check for stale journals in known agent locations
  const agentRoots = [
    { agent: "claude-code", root: join(home, ".claude", "plugins") },
    { agent: "opencode", root: join(projectDir, ".opencode", "plugins") },
    { agent: "codex", root: join(codexHome, "plugins") },
    { agent: "antigravity", root: join(projectDir, ".agents", "plugins") },
  ];
  
  for (const { agent, root } of agentRoots) {
    try {
      const { readdir, lstat } = await import("node:fs/promises");
      const plugins = await readdir(root, { withFileTypes: true });
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue;

        // Transaction scratch spaces (.anyplugin-tx-<name>) are siblings of the
        // installed plugin roots. A leftover one means an install was killed
        // mid-flight: its rollback never ran.
        if (plugin.name.startsWith(".anyplugin-tx-")) {
          const txRoot = join(root, plugin.name);
          let ageHours = 0;
          try {
            const stat = await lstat(txRoot);
            ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);
          } catch {
            /* raced with cleanup */
          }
          issues.push({
            type: "orphaned-transaction",
            severity: ageHours > 1 ? "error" : "warning",
            message: `Orphaned install transaction scratch space (age: ${ageHours.toFixed(1)} hours) — a previous install did not complete; remove it to reclaim disk`,
            path: txRoot,
          });
          continue;
        }

        const pluginDir = join(root, plugin.name);
        const journalPath = join(pluginDir, ".anyplugin-state.json");
        try {
          const { readJournal } = await import("./index.js");
          const journal = await readJournal(pluginDir);
          if (journal) {
            if (!journal.installationId) {
              issues.push({
                type: "legacy-journal",
                severity: "warning",
                message: `Legacy journal format (missing installationId)`,
                path: journalPath,
              });
            }
            // A journal written before schema versioning is migrated on read.
            // Report it so the operator knows the file will be rewritten.
            if (journal.schemaVersion !== undefined && journal.schemaVersion < CURRENT_JOURNAL_SCHEMA_VERSION) {
              issues.push({
                type: "outdated-journal-schema",
                severity: "info",
                message: `Journal schema v${journal.schemaVersion} migrated to v${CURRENT_JOURNAL_SCHEMA_VERSION} on read for ${agent}/${plugin.name}`,
                path: journalPath,
              });
            }
          } else {
            // Plugin directory exists but no journal
            issues.push({
              type: "missing-journal",
              severity: "warning",
              message: `Plugin directory exists but no journal found for ${agent}/${plugin.name}`,
              path: pluginDir,
            });
          }
        } catch (err) {
          // Journal corrupt or unreadable — fail-closed, this blocks uninstall.
          issues.push({
            type: "corrupt-journal",
            severity: "error",
            message: `Corrupt or unreadable journal for ${agent}/${plugin.name}: ${(err as Error).message}`,
            path: journalPath,
          });
        }
      }
    } catch {
      // Agent root doesn't exist - this is normal
    }
  }
  
  // ── REMEDIATION (--fix) ───────────────────────────────────────────────────
  // Only reversible, unambiguous problems are auto-fixed. Corrupt journals are
  // reported but NEVER auto-repaired: the journal is the only record of which
  // bytes the plugin owns, and guessing would risk deleting user data.
  const fixed: string[] = [];
  const unfixable: string[] = [];
  if (values.fix) {
    for (const issue of issues) {
      if (issue.type === "stale-lock" && issue.path) {
        // A lock whose HOLDER IS GONE is safe to release: no live writer can
        // be harmed by removing it. A lock whose liveness cannot be verified
        // is NOT — the runtime refuses to auto-break those for exactly this
        // reason, and so does the doctor.
        try {
          await removeTree(issue.path);
          fixed.push(`released stale worker-runtime lock: ${issue.path}`);
        } catch (err) {
          unfixable.push(`could not release ${issue.path}: ${(err as Error).message}`);
        }
      } else if (issue.type === "orphaned-transaction" && issue.path) {
        // The scratch space holds the staged payload AND the backups of every
        // destination. It is the crash-recovery material for an install that
        // died mid-flight, so the backups are NOT deleted on a whim: only the
        // staging area is purged, and the backups are preserved and named.
        try {
          const { readdir: readEntries } = await import("node:fs/promises");
          const entries = await readEntries(issue.path).catch(() => [] as string[]);
          if (entries.includes(BACKUPS_DIRNAME)) {
            const backupsPath = join(issue.path, BACKUPS_DIRNAME);
            const stagingPath = join(issue.path, STAGING_DIRNAME);
            await removeTree(stagingPath);
            fixed.push(
              `purged the staging area of ${issue.path}; the pre-install backups were KEPT at ${backupsPath} ` +
                `(they are the only copy of the content the crashed install replaced)`,
            );
          } else {
            await removeTree(issue.path);
            fixed.push(`removed orphaned transaction scratch space: ${issue.path}`);
          }
        } catch (err) {
          unfixable.push(`could not remove ${issue.path}: ${(err as Error).message}`);
        }
      } else if (issue.type === "outdated-journal-schema" && issue.path) {
        try {
          const { readJournal, writeJournal } = await import("./index.js");
          const pluginDir = dirname(issue.path);
          const journal = await readJournal(pluginDir);
          if (journal) {
            await writeJournal(pluginDir, journal);
            fixed.push(`rewrote journal at the current schema version: ${issue.path}`);
          }
        } catch (err) {
          unfixable.push(`could not rewrite ${issue.path}: ${(err as Error).message}`);
        }
      } else if (issue.type === "corrupt-journal") {
        unfixable.push(
          `corrupt journal needs manual repair: ${issue.path ?? "(unknown)"} — the journal records which bytes the plugin owns, so it is never auto-repaired`,
        );
      }
    }
  }

  // Output results
  if (values.json) {
    console.log(
      JSON.stringify(
        { command: "doctor", issues, fixed, unfixable, timestamp: new Date().toISOString() },
        null,
        2,
      ),
    );
  } else {
    console.log("anyplugin doctor — runtime diagnostics");
    console.log("=".repeat(50));
    if (issues.length === 0) {
      console.log("✓ No issues detected");
    } else {
      const errors = issues.filter(i => i.severity === "error");
      const warnings = issues.filter(i => i.severity === "warning");
      const infos = issues.filter(i => i.severity === "info");
      
      if (errors.length > 0) {
        console.log(`\n❌ Errors (${errors.length}):`);
        for (const e of errors) console.log(`  [${e.type}] ${e.message}${e.path ? ` (${e.path})` : ""}`);
      }
      if (warnings.length > 0) {
        console.log(`\n⚠ Warnings (${warnings.length}):`);
        for (const w of warnings) console.log(`  [${w.type}] ${w.message}${w.path ? ` (${w.path})` : ""}`);
      }
      if (infos.length > 0) {
        console.log(`\nℹ Info (${infos.length}):`);
        for (const i of infos) console.log(`  [${i.type}] ${i.message}${i.path ? ` (${i.path})` : ""}`);
      }
    }
    if (fixed.length > 0) {
      console.log(`\n🔧 Fixed (${fixed.length}):`);
      for (const f of fixed) console.log(`  ${f}`);
    }
    if (unfixable.length > 0) {
      console.log(`\n⛔ Needs manual attention (${unfixable.length}):`);
      for (const u of unfixable) console.log(`  ${u}`);
    }
    console.log("\nRun with --json for machine-readable output, --fix to auto-remediate safe issues.");
  }
  
  // Exit with error code if there are errors that remain after remediation.
  const remainingErrors = issues.filter(
    (i) => i.severity === "error" && !fixed.some((f) => f.includes(i.path ?? "\u0000")),
  );
  if (remainingErrors.length > 0) {
    process.exitCode = 1;
  }
}

/**
 * Load the backend registry.
 *
 * The registry is DATA, and it is loaded strictly: an unknown apiVersion is
 * refused whole, and an unreadable registry is an ERROR, not an empty one.
 * "No backends configured" and "could not read the registry" must never look
 * alike, or a typo in a path silently disables the wrapper.
 */
async function loadBackendCatalog(
  registryPath: string,
): Promise<{ catalog: BackendCatalog } | { error: string }> {
  let raw: string;
  try {
    raw = await readFile(registryPath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { error: `no backend registry at ${registryPath} — create one, or pass --registry` };
    }
    return { error: `cannot read backend registry ${registryPath}: ${(err as Error).message}` };
  }
  // A UTF-8 BOM is what many Windows editors and shells write by default, and
  // `JSON.parse` rejects it. Stripping it is the difference between "the
  // registry works" and "the registry mysteriously does not".
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: `backend registry ${registryPath} is not valid JSON: ${(err as Error).message}` };
  }
  try {
    return { catalog: BackendCatalog.parse(parsed) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

/** `anyplugin backends list|probe` — inspect the declared backends. */
async function runBackends(values: ParsedFlags, positionals: string[]): Promise<void> {
  const sub = positionals[0] ?? "list";
  const registryPath = resolve(values.registry ?? join(process.cwd(), "anyplugin.backends.json"));
  const loaded = await loadBackendCatalog(registryPath);
  if ("error" in loaded) {
    if (values.json) {
      console.log(JSON.stringify({ command: "backends", error: loaded.error }, null, 2));
    } else {
      console.error(`anyplugin backends: ${loaded.error}`);
    }
    process.exitCode = 1;
    return;
  }
  const catalog = loaded.catalog;

  if (sub === "list") {
    const backends = catalog.all().map((b) => ({
      id: b.id,
      label: b.label || b.id,
      kind: b.kind,
      command: b.command ?? null,
      enabled: b.enabled,
      capabilities: b.capabilities,
      domains: b.domains,
      timeoutMs: b.timeoutMs,
    }));
    if (values.json) {
      console.log(JSON.stringify({ command: "backends.list", registry: registryPath, count: backends.length, backends }, null, 2));
      return;
    }
    if (backends.length === 0) {
      console.log(`No backends declared in ${registryPath}`);
      return;
    }
    console.log(`Backends (${registryPath}):\n`);
    for (const b of backends) {
      const caps = Object.entries(b.capabilities)
        .map(([c, s]) => `${c}=${s}`)
        .join(" ");
      console.log(`  ${b.id}${b.enabled ? "" : " (disabled)"}  kind=${b.kind}  ${b.command ?? "(no command)"}`);
      if (caps) console.log(`      capabilities: ${caps}`);
      if (b.domains.length) console.log(`      domains: ${b.domains.join(", ")}`);
    }
    return;
  }

  if (sub === "probe") {
    const results = [];
    for (const backend of catalog.enabled()) {
      const probe = await probeBackend(backend);
      results.push(probe);
    }
    if (values.json) {
      console.log(JSON.stringify({ command: "backends.probe", registry: registryPath, results }, null, 2));
      const anyMissing = results.some((r) => !r.available);
      if (anyMissing) process.exitCode = 1;
      return;
    }
    console.log("Backend availability:\n");
    for (const r of results) {
      const mark = r.available ? "OK  " : "MISS";
      console.log(`  [${mark}] ${r.backendId}${r.version ? `  ${r.version}` : ""}${r.reason ? `  (${r.reason})` : ""}`);
    }
    return;
  }

  throw new Error(`unknown backends subcommand: ${sub} (expected list or probe)`);
}

/** `anyplugin delegate` — run a request through the wrapper. */
async function runDelegate(values: ParsedFlags, positionals: string[]): Promise<void> {
  const registryPath = resolve(values.registry ?? join(process.cwd(), "anyplugin.backends.json"));
  const loaded = await loadBackendCatalog(registryPath);
  if ("error" in loaded) {
    if (values.json) {
      console.log(JSON.stringify({ command: "delegate", error: loaded.error }, null, 2));
    } else {
      console.error(`anyplugin delegate: ${loaded.error}`);
    }
    process.exitCode = 1;
    return;
  }

  // Arguments after `--` are the backend's own; everything before is ours.
  const sep = positionals.indexOf("--");
  const backendArgs = sep >= 0 ? positionals.slice(sep + 1) : [];

  // The timeout is a number the user typed. `Number("abc")` is NaN, and
  // `setTimeout(fn, NaN)` fires IMMEDIATELY — so an unvalidated timeout
  // would kill every backend instantly and report it as a timeout.
  let timeoutMs: number | undefined;
  if (values.timeout !== undefined) {
    const parsed = Number(values.timeout);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const message = `anyplugin delegate: --timeout must be a positive number of milliseconds (got ${JSON.stringify(values.timeout)})`;
      if (values.json) console.log(JSON.stringify({ command: "delegate", error: message }, null, 2));
      else console.error(message);
      process.exitCode = 4; // invalid input
      return;
    }
    timeoutMs = parsed;
  }

  // The chain-wide budget. Same discipline as the timeout: `Number("abc")`
  // is NaN, and a NaN deadline compares false against everything, so an
  // unvalidated budget would be a budget that never fires.
  let budgetMs: number | undefined;
  if (values.budget !== undefined) {
    const parsed = Number(values.budget);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      const message = `anyplugin delegate: --budget must be a positive number of milliseconds (got ${JSON.stringify(values.budget)})`;
      if (values.json) console.log(JSON.stringify({ command: "delegate", error: message }, null, 2));
      else console.error(message);
      process.exitCode = 4; // invalid input
      return;
    }
    budgetMs = parsed;
  }

  const result = await delegate({
    catalog: loaded.catalog,
    args: backendArgs,
    request: {
      ...(values.backend ? { backendId: values.backend } : {}),
      ...(values.capability ? { capability: values.capability } : {}),
      ...(values.domain ? { domain: values.domain } : {}),
    },
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(budgetMs !== undefined ? { budgetMs } : {}),
    ...(values["re-runnable"] === true ? { reRunnable: true } : {}),
  });

  // The telemetry is PERSISTED, not printed. It used to be printed by
  // `--json` and otherwise dropped, which made the wrapper's own account of
  // what it did invisible — and the OKF bundle's claim that the telemetry
  // goes to the worker-runtime event log was false while that was the case.
  const telemetry = persistDelegationTelemetry(result.events, process.cwd());

  if (values.json) {
    console.log(
      JSON.stringify(
        {
          command: "delegate",
          ok: result.ok,
          selected: result.selected?.id ?? null,
          reason: result.reason ?? null,
          telemetry: { written: telemetry.written, error: telemetry.error ?? null },
          attempts: result.attempts.map((a) => ({
            backendId: a.backendId,
            attempt: a.attempt,
            exitCode: a.exitCode,
            durationMs: a.durationMs,
            timedOut: a.timedOut,
            truncated: a.truncated,
            failureClass: a.failureClass ?? null,
            effectState: a.effectState,
            fallbackLegal: a.fallbackLegal,
          })),
          events: result.events,
        },
        null,
        2,
      ),
    );
  } else {
    // ONE answer on stdout. The LAST attempt is the answer; every earlier
    // attempt failed, and its output is DIAGNOSTICS.
    //
    // Printing them all on stdout hands the host two answers to one request
    // — the exact harm the fallback rule exists to prevent. It is a
    // PRESENTATION problem, so it is solved here, rather than by making the
    // chain refuse to fall back whenever a backend printed anything (which
    // would stop the chain from ever falling back, because nearly every
    // backend prints something).
    const answer = result.attempts[result.attempts.length - 1];
    for (const attempt of result.attempts) {
      const status = attempt.failureClass ? `FAILED (${attempt.failureClass})` : "ok";
      const line = `[${attempt.backendId}] attempt ${attempt.attempt}: ${status} in ${attempt.durationMs}ms`;
      if (attempt === answer) {
        console.log(line);
        if (attempt.stdout.trim()) console.log(attempt.stdout.trimEnd());
      } else {
        console.error(`${line} — output withheld: it was not the answer`);
        if (attempt.stdout.trim()) console.error(attempt.stdout.trimEnd());
      }
      if (attempt.stderr.trim()) console.error(attempt.stderr.trimEnd());
    }
    if (!result.ok && result.reason) console.error(`anyplugin delegate: ${result.reason}`);
    // A telemetry failure is REPORTED, not silent. The delegation's answer
    // matters more than its telemetry, so this does not fail the command —
    // but an operator who cannot record what happened must be told.
    if (telemetry.error) {
      console.error(`anyplugin delegate: the telemetry could not be persisted: ${telemetry.error}`);
    }
  }

  if (!result.ok) {
    // 69 (EX_UNAVAILABLE): no backend could serve the request. A distinct
    // code from the runner's 1-4 range, so a script can tell "the wrapper
    // could not reach a backend" from "the wrapper itself is broken".
    process.exitCode = 69;
  }
}

async function main(): Promise<void> {
  const [rawCommand] = process.argv.slice(2);
  if (!rawCommand || rawCommand === "help" || rawCommand === "--help" || rawCommand === "-h") {
    process.stdout.write(HELP);
    return;
  }
  // Strict CLI contract: every command parses through its Zod schema
  // (flags AND positionals); unknown flags and misplaced flags are errors.
  const { command, values, positionals } = parseCliArgv(process.argv.slice(2)) as unknown as {
    command: CommandName;
    values: ParsedFlags;
    positionals: string[];
  };

  const home = values.home ?? homedir();
  const projectDir = resolve(values.project ?? process.cwd());
  const agents = parseAgents(values.agents);

  if (command === "init") {
    if (!values.name) throw new Error("init requires --name (kebab-case plugin name)");
    const targetDir = resolve(values.dir ?? join(process.cwd(), values.name));
    const result = await scaffoldPlugin(values.name, targetDir);
    if (values.json) {
      console.log(JSON.stringify({ command: "init", ...result }, null, 2));
    } else {
      console.log(`scaffolded ${result.name} → ${result.dir} (${result.files.length} files)`);
      for (const f of result.files) console.log(`  ${f}`);
      console.log(`\nnext: implement hooks/, then run anyplugin build --plugin ${result.dir}`);
    }
    return;
  }

  if (command === "intensity") {
    const pluginRoot = requireDir(resolve(values.plugin ?? "."), "--plugin");
    const manifest = await loadPluginSafe(pluginRoot);
    const mode = values.mode as "conservative" | "balanced" | "aggressive";
    // The runtime (runner.js) reads .anyplugin-mode from the INSTALLED root
    // at hook-execution time, not the source --plugin dir a developer points
    // this at — so the flag has to be written into each agent's actual
    // installed root for it to have any effect, not just the source tree.
    const codexHome = process.env["CODEX_HOME"] ?? join(home, ".codex");
    const ctx = { home, projectDir, codexHome };
    const targets = agents ?? [...ALL_AGENTS];
    const written: { agent: AgentId; root: string; file: string }[] = [];
    for (const agent of targets) {
      const root = installedRoot(agent, { ...ctx, pluginName: manifest.name });
      if (!(await pathExists(root))) continue;
      const file = await setIntensityMode(root, mode, { pluginId: manifest.name, version: manifest.version });
      written.push({ agent, root, file });
    }
    if (written.length === 0) {
      throw new Error(
        `"${manifest.name}" is not installed for any of: ${targets.join(", ")} — run "anyplugin install" first, then set intensity`,
      );
    }
    if (values.json) {
      console.log(JSON.stringify({ command: "intensity", plugin: manifest.name, mode, written: written.map((w) => ({ agent: w.agent, file: w.file })) }, null, 2));
    } else {
      console.log(`${manifest.name}: intensity mode → ${mode}`);
      for (const w of written) {
        console.log(`  ${w.agent}: ${w.file}`);
        const current = await getActivePlugin(w.root);
        if (current) console.log(`    active: ${current.pluginId} v${current.version} mode=${current.mode}`);
      }
    }
    return;
  }

  if (command === "detect") {
    const detection = detectAgent(process.env, home);
    const env = detectEnvironment(process.env, projectDir);
    const installed = await detectInstalledAgentsSafe(home);
    if (values.json) {
      console.log(JSON.stringify({ command: "detect", agent: detection.agent ?? null, confidence: detection.confidence, signals: detection.signals, environment: env, installed }, null, 2));
      return;
    }
    console.log(`running agent : ${detection.agent ?? "none"} (${detection.confidence})${detection.signals.length ? ` via ${detection.signals.join(", ")}` : ""}`);
    console.log(`environment   : ${env.os} / ${env.shell} / node ${env.nodeVersion}`);
    console.log(`network blocked: ${env.networkBlocked} | permission mode: ${env.permissionMode ?? "n/a"}`);
    console.log(`installed     : ${installed.join(", ") || "none"}`);
    return;
  }

  if (command === "run") {
    await runCommand(values);
    return;
  }

  if (command === "doctor") {
    await runDoctor(values);
    return;
  }

  if (command === "backends") {
    await runBackends(values, positionals);
    return;
  }

  if (command === "delegate") {
    await runDelegate(values, positionals);
    return;
  }

  if (command === "okf-validate" || command === "okf-reindex") {
    const dir = requireDir(resolve(positionals[0] ?? values.plugin ?? "./knowledge"), "bundle dir");
    if (command === "okf-validate") {
      const issues = await validateBundle(dir);
      const errors = issues.filter((i) => i.level === "error");
      if (values.json) {
        console.log(JSON.stringify({ command: "okf-validate", bundle: dir, issues, errorCount: errors.length, conformant: errors.length === 0 }, null, 2));
        if (errors.length > 0) process.exitCode = 1;
        return;
      }
      for (const issue of issues) {
        console.log(`${issue.level.toUpperCase().padEnd(7)} ${issue.file} [${issue.rule}] ${issue.message}`);
      }
      console.log(`\n${issues.length} issue(s), ${errors.length} error(s) — bundle ${errors.length === 0 ? "CONFORMANT" : "NON-CONFORMANT"} with OKF v0.2`);
      if (errors.length > 0) process.exitCode = 1;
      return;
    }
    // The root index is often HAND-CURATED. Regenerating it destroys work no
    // generator can reproduce, so it needs an explicit opt-in.
    const written = await regenerateIndexes(dir, { includeRoot: values["include-root"] === true });
    if (values.json) console.log(JSON.stringify({ command: "okf-reindex", bundle: dir, written }, null, 2));
    else {
      console.log(`regenerated ${written.length} index.md file(s) in ${dir}`);
      if (values["include-root"] !== true) {
        console.log("(the root index.md is left alone — it may be hand-curated; pass --include-root to replace it)");
      }
    }
    return;
  }

  if (command === "build" || command === "install" || command === "uninstall") {
    const pluginRoot = requireDir(resolve(values.plugin ?? "."), "--plugin");

    // Instruction-tier installs bypass bundle emission entirely: the plugin's
    // contract is injected as a marked AGENTS.md section (ponytail pattern).
    if (values.tier === "instruction" && (command === "install" || command === "uninstall")) {
      const dryRun = values["dry-run"] === true;
      if (command === "install") {
        const result = await installInstructions({ pluginRoot, projectDir, dryRun });
        if (values.json) {
          console.log(JSON.stringify({ command: "install", tier: "instruction", plugin: pluginRoot, dryRun, ...result }, null, 2));
          return;
        }
        console.log(`\n[instruction] ${dryRun ? "dry-run install" : "install"}\n  ${dryRun ? "would append" : "appended"} → ${result.agentsMd}`);
        for (const n of result.notes) console.log(`  note: ${n}`);
      } else {
        const touched = await uninstallInstructions({ pluginRoot, projectDir, dryRun });
        if (values.json) {
          console.log(JSON.stringify({ command: "uninstall", tier: "instruction", plugin: pluginRoot, dryRun, touched }, null, 2));
          return;
        }
        console.log(`\n[instruction] ${dryRun ? "dry-run uninstall" : "uninstalled"}`);
        for (const t of touched) console.log(`  ${dryRun ? "" : "cleaned "}${t}`);
      }
      return;
    }

    const manifest = await loadPluginSafe(pluginRoot);
    const dryRun = values["dry-run"] === true;
    let outRoot = resolve(values.out ?? join(pluginRoot, ".anyplugin-build"));
    // A dry run must not leave a build tree inside the user's plugin dir:
    // render bundles into a throwaway temp dir and remove it afterwards.
    let sandbox: string | undefined;
    if (dryRun && !values.out) {
      sandbox = await mkdtemp(join(tmpdir(), "anyplugin-dryrun-"));
      outRoot = sandbox;
    }
    const runnerAbsPath = values.runner ? resolve(values.runner) : defaultRunnerPath();
    try {
    const bundles = await buildAll({
      pluginRoot,
      outRoot,
      agents,
      runnerAbsPath,
      mcpRuntimeAbsDir: values["mcp-runtime"] ? resolve(values["mcp-runtime"]) : undefined,
    });

    if (command === "build") {
      if (values.json) {
        const payload: Record<string, unknown> = {};
        for (const [agent, bundle] of Object.entries(bundles)) payload[agent] = { dir: bundle.dir, fileCount: bundle.files.length, warnings: bundle.warnings };
        console.log(JSON.stringify({ command: "build", plugin: manifest.name, out: outRoot, agents: payload }, null, 2));
        return;
      }
      for (const [agent, bundle] of Object.entries(bundles)) {
        console.log(`\n[${agent}] → ${bundle.dir} (${bundle.files.length} files)`);
        for (const w of bundle.warnings) console.log(`  warning: ${w}`);
      }
      return;
    }

    const opts = { home, projectDir, pluginName: manifest.name, version: manifest.version, dryRun };
    if (values.json) {
      const payload: Record<string, unknown> = {};
      for (const [agentKey, bundle] of Object.entries(bundles)) {
        const agent = agentKey as AgentId;
        if (command === "install") payload[agent] = await executeInstall(agent, bundle, opts);
        else payload[agent] = { cleaned: await executeUninstall(agent, bundle, opts), dryRun };
      }
      console.log(JSON.stringify({ command, plugin: manifest.name, agents: payload }, null, 2));
      return;
    }
    for (const [agentKey, bundle] of Object.entries(bundles)) {
      const agent = agentKey as AgentId;
      if (command === "install") {
        const result = await executeInstall(agent, bundle, opts);
        console.log(`\n[${agent}]`);
        for (const d of result.copiedDirs) console.log(`  copied → ${d}`);
        for (const f of result.mergedFiles) console.log(`  merged → ${f}`);
        for (const n of result.notes) console.log(`  note: ${n}`);
      } else {
        const touched = await executeUninstall(agent, bundle, opts);
        console.log(`\n[${agent}] ${dryRun ? "dry-run uninstall" : "uninstalled"} (${touched.length} location(s) ${dryRun ? "to clean" : "cleaned"})`);
        for (const t of touched) console.log(`  ${dryRun ? "" : "cleaned "}${t}`);
      }
    }
    return;
    } finally {
      if (sandbox) await removeTree(sandbox);
    }
  }

  // strict-args rejects unknown commands before we get here
  process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
  process.exitCode = 1;
}

function parseAgents(list?: string): AgentId[] | undefined {
  if (!list) return undefined;
  const wanted = list.split(",").map((s) => s.trim()).filter(Boolean);
  for (const w of wanted) {
    if (!(ALL_AGENTS as readonly string[]).includes(w)) {
      throw new Error(`unknown agent "${w}" (valid: ${ALL_AGENTS.join(", ")})`);
    }
  }
  return wanted as AgentId[];
}

/** Validate a user-supplied directory argument before any file access through it. */
function requireDir(absPath: string, what: string): string {
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    throw new Error(`${what}: directory not found: ${absPath}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${what}: not a directory: ${absPath}`);
  }
  return absPath;
}

function defaultRunnerPath(): string {
  // Default: the anyplugin-knowledge plugin's self-contained runner.
  return resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "knowledge", "runtime", "runner.js"));
}

async function detectInstalledAgentsSafe(home: string): Promise<string[]> {
  try {
    return await Promise.resolve(detectInstalledAgents(home, process.env));
  } catch {
    return [];
  }
}

main().catch((err: Error) => {
  process.stderr.write(`anyplugin: ${err.message}\n`);
  process.exitCode = 1;
});
