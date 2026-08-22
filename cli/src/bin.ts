#!/usr/bin/env node
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { statSync } from "node:fs";
import {
  buildAll,
  executeInstall,
  executeUninstall,
  detectAgent,
  detectInstalledAgents,
  detectEnvironment,
  loadPluginSafe,
  validateBundle,
  regenerateIndexes,
} from "./index.js";
import type { AgentId } from "@lablaunchpad/core";
import { ALL_AGENTS } from "@lablaunchpad/core";

const HELP = `anyplugin — agent-agnostic plugin development for Claude Code, OpenCode, Codex, Antigravity

Every agent has plugin dev. AnyPlugin makes it agent-agnostic.

commands:
  anyplugin detect                   show detected agent + environment + installed agents
  anyplugin build [--plugin DIR] [--out DIR] [--agents LIST]
                                     emit native bundles per agent (default all four)
  anyplugin install [--plugin DIR] [--agents LIST] [--home DIR] [--project DIR] [--dry-run]
                                     install emitted bundles into agent locations
  anyplugin uninstall [--plugin DIR] [--agents LIST] [--home DIR] [--project DIR]
                                       reverse an install
  anyplugin okf-validate [DIR]       validate an OKF v0.2 bundle (default ./knowledge)
  anyplugin okf-reindex [DIR]        regenerate bundle index.md files
  anyplugin help                     this help

options:
  --plugin DIR     canonical plugin root containing anyplugin.plugin.yaml (default: .)
  --out DIR        build output root (default: .anyplugin-build)
  --agents LIST    comma subset of: claude-code,opencode,codex,antigravity
`;

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  const { values } = parseArgs({
    args: rest,
    options: {
      plugin: { type: "string" },
      out: { type: "string" },
      agents: { type: "string" },
      home: { type: "string" },
      project: { type: "string" },
      "dry-run": { type: "boolean" },
      runner: { type: "string" },
      "mcp-runtime": { type: "string" },
    },
    allowPositionals: true,
  });

  const home = values.home ?? homedir();
  const projectDir = resolve(values.project ?? process.cwd());
  const pluginRoot = requireDir(resolve(values.plugin ?? "."), "--plugin");
  const agents = parseAgents(values.agents);

  if (command === "detect") {
    const detection = detectAgent(process.env, home);
    const env = detectEnvironment(process.env, projectDir);
    console.log(`running agent : ${detection.agent ?? "none"} (${detection.confidence})${detection.signals.length ? ` via ${detection.signals.join(", ")}` : ""}`);
    console.log(`environment   : ${env.os} / ${env.shell} / node ${env.nodeVersion}`);
    console.log(`network blocked: ${env.networkBlocked} | permission mode: ${env.permissionMode ?? "n/a"}`);
    console.log(`installed     : ${(await detectInstalledAgentsSafe(home)).join(", ") || "none"}`);
    return;
  }

  if (command === "okf-validate" || command === "okf-reindex") {
    const dir = requireDir(resolve(rest[0] ?? values.plugin ?? "./knowledge"), "bundle dir");
    if (command === "okf-validate") {
      const issues = await validateBundle(dir);
      for (const issue of issues) {
        console.log(`${issue.level.toUpperCase().padEnd(7)} ${issue.file} [${issue.rule}] ${issue.message}`);
      }
      const errors = issues.filter((i) => i.level === "error");
      console.log(`\n${issues.length} issue(s), ${errors.length} error(s) — bundle ${errors.length === 0 ? "CONFORMANT" : "NON-CONFORMANT"} with OKF v0.2`);
      if (errors.length > 0) process.exitCode = 1;
      return;
    }
    const written = await regenerateIndexes(dir);
    console.log(`regenerated ${written.length} index.md file(s) in ${dir}`);
    return;
  }

  if (command === "build" || command === "install" || command === "uninstall") {
    const manifest = await loadPluginSafe(pluginRoot);
    const outRoot = resolve(values.out ?? join(pluginRoot, ".anyplugin-build"));
    const runnerAbsPath = values.runner ?? defaultRunnerPath();
    const bundles = await buildAll({
      pluginRoot,
      outRoot,
      agents,
      runnerAbsPath,
      mcpRuntimeAbsDir: values["mcp-runtime"],
    });

    if (command === "build") {
      for (const [agent, bundle] of Object.entries(bundles)) {
        console.log(`\n[${agent}] → ${bundle.dir} (${bundle.files.length} files)`);
        for (const w of bundle.warnings) console.log(`  warning: ${w}`);
      }
      return;
    }

    const opts = { home, projectDir, pluginName: manifest.name, dryRun: values["dry-run"] === true };
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
        console.log(`\n[${agent}] uninstalled (${touched.length} location(s) cleaned)`);
        for (const t of touched) console.log(`  cleaned ${t}`);
      }
    }
    return;
  }

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
  return resolve(join(import.meta.dirname ?? ".", "..", "..", "plugins", "knowledge", "runtime", "runner.js"));
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
