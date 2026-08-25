#!/usr/bin/env node
import { homedir, tmpdir } from "node:os";
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
import { ALL_AGENTS, removeTree, pathExists } from "@lablaunchpad/core";
import { parseCliArgv, type CommandName } from "./strict-args.js";
import { setIntensityMode, getActivePlugin } from "./state.js";

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
  anyplugin help                     this help

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
    const written = await regenerateIndexes(dir);
    if (values.json) console.log(JSON.stringify({ command: "okf-reindex", bundle: dir, written }, null, 2));
    else console.log(`regenerated ${written.length} index.md file(s) in ${dir}`);
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

    const opts = { home, projectDir, pluginName: manifest.name, version: manifest.version, dryRun, runtime: manifest.runtime };
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
