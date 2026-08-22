import {
  type AgentId,
  type EmittedBundle,
  type InstallPlan,
  loadPluginManifest,
  detectAgent,
  detectInstalledAgents,
  detectEnvironment,
  ALL_AGENTS,
  copyDir,
  validateBundle,
  regenerateIndexes,
  readText,
  writeText,
  removeTree,
  listDir,
  pathExists,
} from "@agent-prism/core";
import { emitClaude } from "@agent-prism/adapter-claude";
import { emitOpencode } from "@agent-prism/adapter-opencode";
import { emitCodex } from "@agent-prism/adapter-codex";
import { emitAntigravity } from "@agent-prism/adapter-antigravity";
import { join, dirname } from "node:path";

export interface BuildOptions {
  pluginRoot: string;
  outRoot: string;
  agents?: AgentId[];
  runnerAbsPath: string;
  runnerRelPath?: string;
  mcpRuntimeAbsDir?: string;
}

/** Emit native bundles for every (or selected) agent. */
export async function buildAll(opts: BuildOptions): Promise<Record<string, EmittedBundle>> {
  const plugin = await loadPluginManifest(opts.pluginRoot);
  const agents = opts.agents ?? [...ALL_AGENTS];
  const runnerRelPath = opts.runnerRelPath ?? "runner.js";
  const common = {
    pluginRoot: opts.pluginRoot,
    runnerRelPath,
    runnerAbsPath: opts.runnerAbsPath,
    mcpRuntimeAbsDir: opts.mcpRuntimeAbsDir,
  };
  const results: Record<string, EmittedBundle> = {};
  for (const agent of agents) {
    const outDir = join(opts.outRoot, agent);
    if (agent === "claude-code") results[agent] = await emitClaude(plugin, { ...common, outDir });
    else if (agent === "opencode") results[agent] = await emitOpencode(plugin, { ...common, outDir });
    else if (agent === "codex") results[agent] = await emitCodex(plugin, { ...common, outDir });
    else if (agent === "antigravity") results[agent] = await emitAntigravity(plugin, { ...common, outDir });
  }
  return results;
}

export interface InstallOptions {
  home: string;
  projectDir: string;
  pluginName: string;
  dryRun?: boolean;
}

/** Plugin names are the only user-controlled path segment; lock them to kebab-case. */
export function validatePluginName(name: string): string {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`unsafe plugin name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Relative paths from install plans must be plain relative segments:
 * letters, digits, dot, dash, underscore, slash. No traversal, no drive
 * letters, no backslashes, not absolute.
 */
export function validateRelPath(rel: string, what: string): string {
  if (!/^[A-Za-z0-9._\-/]+$/.test(rel) || rel.indexOf("..") >= 0 || rel.startsWith("/")) {
    throw new Error(`unsafe relative path in ${what}: ${JSON.stringify(rel)}`);
  }
  return rel;
}

/** Per-agent root where the emitted bundle physically lands after install. */
export function installedRoot(
  agent: AgentId,
  opts: { home: string; projectDir: string; pluginName: string; codexHome: string },
): string {
  const name = validatePluginName(opts.pluginName);
  switch (agent) {
    case "claude-code":
      return join(opts.home, ".claude", "plugins", name);
    case "codex":
      return join(opts.codexHome, "plugins", name);
    case "antigravity":
      return join(opts.projectDir, ".agents", "plugins", name);
    case "opencode":
      return join(opts.projectDir, ".opencode", "plugins", name);
  }
}

/**
 * Whitelist of destination templates install plans may target. Paths are
 * constructed ONLY from these exact keys plus validated single segments —
 * never from token substitution into free-form paths.
 */
const TEMPLATES: Record<string, (o: { home: string; projectDir: string; codexHome: string }) => string> = {
  "{{PROJECT}}/opencode.json": (o) => join(o.projectDir, "opencode.json"),
  "{{PROJECT}}/AGENTS.md": (o) => join(o.projectDir, "AGENTS.md"),
  "{{PROJECT}}/.agents/mcp_config.json": (o) => join(o.projectDir, ".agents", "mcp_config.json"),
  "{{CODEX_HOME}}/config.toml": (o) => join(o.codexHome, "config.toml"),
  "{{PROJECT}}/.opencode/skills": (o) => join(o.projectDir, ".opencode", "skills"),
  "{{PROJECT}}/.opencode/commands": (o) => join(o.projectDir, ".opencode", "commands"),
  "{{PROJECT}}/.opencode/agent": (o) => join(o.projectDir, ".opencode", "agent"),
};

function resolveFileTemplate(
  template: string,
  ctx: { home: string; projectDir: string; codexHome: string },
): string {
  const build = TEMPLATES[template];
  if (!build) {
    throw new Error(`install plan targets unknown config template: ${JSON.stringify(template)}`);
  }
  return build(ctx);
}

/** Single path segment: one directory/file name, no separators, no traversal. */
export function validateSegment(segment: string, what: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === ".." || segment === ".") {
    throw new Error(`unsafe path segment in ${what}: ${JSON.stringify(segment)}`);
  }
  return segment;
}

/** Destination for a copy action: root role → installed root; otherwise template dir + validated segment. */
function copyDest(
  action: { role?: string; destAbs: string; srcRel: string; destFile?: string },
  agent: AgentId,
  ctx: { home: string; projectDir: string; codexHome: string },
  pluginName: string,
): string {
  if (action.role === "root") {
    return installedRoot(agent, { ...ctx, pluginName });
  }
  const base = resolveFileTemplate(action.destAbs, ctx);
  const segment = action.destFile ?? action.srcRel.split("/").pop() ?? "";
  return join(base, validateSegment(segment, `${agent} copy destFile`));
}

export interface InstallResult {
  agent: AgentId;
  copiedDirs: string[];
  mergedFiles: string[];
  notes: string[];
}

export function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    if (
      prev && typeof prev === "object" && !Array.isArray(prev) &&
      value && typeof value === "object" && !Array.isArray(value)
    ) {
      out[key] = deepMerge(prev as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Substitute {{PLUGIN_ROOT}} (the only token allowed inside VALUES, never paths). */
function substValues(value: unknown, pluginRoot: string): unknown {
  if (typeof value === "string") return value.split("{{PLUGIN_ROOT}}").join(pluginRoot);
  if (Array.isArray(value)) return value.map((v) => substValues(v, pluginRoot));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = substValues(v, pluginRoot);
    }
    return out;
  }
  return value;
}

async function readJsonOrDefault(file: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readText(file)) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Execute one agent's install plan. Returns what happened for reporting. */
export async function executeInstall(
  agent: AgentId,
  bundle: EmittedBundle,
  opts: InstallOptions,
): Promise<InstallResult> {
  validatePluginName(opts.pluginName);
  const codexHome = process.env["CODEX_HOME"] ?? join(opts.home, ".codex");
  const ctx = { home: opts.home, projectDir: opts.projectDir, codexHome };
  const root = installedRoot(agent, { ...ctx, pluginName: opts.pluginName });
  const copiedDirs: string[] = [];
  const mergedFiles: string[] = [];
  const notes: string[] = [];

  for (const action of bundle.install.actions) {
    if (action.kind === "copy") {
      const srcRel = validateRelPath(action.srcRel, `${agent} copy srcRel`);
      const dest = copyDest(action, agent, ctx, opts.pluginName);
      if (opts.dryRun) {
        notes.push(`would copy ${srcRel} → ${dest}`);
        continue;
      }
      await copyDir(join(bundle.dir, srcRel), dest);
      copiedDirs.push(dest);
      if (action.role === "root") {
        await substFilesIn(dest, dest);
      }
    } else if (action.kind === "json-merge") {
      const file = resolveFileTemplate(action.file, ctx);
      const patch = substValues(action.patch, root) as Record<string, unknown>;
      if (opts.dryRun) {
        notes.push(`would merge ${JSON.stringify(patch)} into ${file}`);
        continue;
      }
      const merged = deepMerge(await readJsonOrDefault(file), patch);
      await writeText(file, JSON.stringify(merged, null, 2) + "\n");
      mergedFiles.push(file);
    } else if (action.kind === "toml-merge") {
      const file = resolveFileTemplate(action.file, ctx);
      if (opts.dryRun) {
        notes.push(`would append [mcp_servers] to ${file}`);
        continue;
      }
      const begin = `# BEGIN agent-prism:${opts.pluginName}`;
      const end = `# END agent-prism:${opts.pluginName}`;
      let text = "";
      try {
        text = await readText(file);
      } catch {
        text = "";
      }
      text = stripBlock(text, begin, end);
      const toml = substValues(action.append, root) as string;
      await writeText(file, text.trimEnd() + `\n\n${begin}\n${toml.trimEnd()}\n${end}\n`);
      mergedFiles.push(file);
    } else if (action.kind === "md-append") {
      const file = resolveFileTemplate(action.file, ctx);
      if (opts.dryRun) {
        notes.push(`would append ${opts.pluginName} section to ${file}`);
        continue;
      }
      const begin = `<!-- agent-prism:${action.marker} begin -->`;
      const end = `<!-- agent-prism:${action.marker} end -->`;
      let text = "";
      try {
        text = await readText(file);
      } catch {
        text = "";
      }
      text = stripBlock(text, begin, end);
      await writeText(file, text.trimEnd() + "\n" + action.content.trimEnd() + "\n");
      mergedFiles.push(file);
    }
  }

  if (agent === "claude-code") {
    notes.push("restart Claude Code and enable via /plugin (or enabledPlugins in settings.json)");
  } else if (agent === "codex") {
    notes.push(`if not auto-discovered: codex plugin marketplace add ${root} (hooks require /hooks trust)`);
  } else if (agent === "antigravity") {
    notes.push("restart Antigravity / reload workspace; verify in Settings → Customizations");
  } else if (agent === "opencode") {
    notes.push("restart opencode; skills also load via config skills[] paths (v2-safe)");
  }
  return { agent, copiedDirs, mergedFiles, notes };
}

export function stripBlock(text: string, begin: string, end: string): string {
  const b = text.indexOf(begin);
  if (b < 0) return text;
  const e = text.indexOf(end, b);
  if (e < 0) return text.slice(0, b).trimEnd();
  const after = text.slice(e + end.length);
  return (text.slice(0, b).trimEnd() + "\n" + after.trimStart()).trim();
}

async function substFilesIn(dir: string, pluginRoot: string): Promise<void> {
  let entries;
  try {
    entries = await listDir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDir && entry.name !== "node_modules") {
      await substFilesIn(entry.abs, pluginRoot);
    } else if (entry.name.endsWith(".json") || entry.name.endsWith(".toml") || entry.name.endsWith(".ts")) {
      try {
        const text = await readText(entry.abs);
        if (text.includes("{{PLUGIN_ROOT}}")) {
          await writeText(entry.abs, text.split("{{PLUGIN_ROOT}}").join(pluginRoot));
        }
      } catch {
        /* unreadable — skip */
      }
    }
  }
}

/** Reverse an install: remove copied dirs, strip marker blocks, un-merge JSON keys. */
export async function executeUninstall(
  agent: AgentId,
  bundle: EmittedBundle,
  opts: InstallOptions,
): Promise<string[]> {
  validatePluginName(opts.pluginName);
  const codexHome = process.env["CODEX_HOME"] ?? join(opts.home, ".codex");
  const ctx = { home: opts.home, projectDir: opts.projectDir, codexHome };
  const root = installedRoot(agent, { ...ctx, pluginName: opts.pluginName });
  const touched: string[] = [];
  for (const action of bundle.install.actions) {
    if (action.kind === "copy") {
      validateRelPath(action.srcRel, `${agent} uninstall srcRel`);
      const dest = copyDest(action, agent, ctx, opts.pluginName);
      if (await pathExists(dest)) {
        await removeTree(dest);
        touched.push(dest);
      }
    } else if (action.kind === "json-merge") {
      const file = resolveFileTemplate(action.file, ctx);
      const patch = substValues(action.patch, root) as Record<string, unknown>;
      try {
        const current = await readJsonOrDefault(file);
        await writeText(file, JSON.stringify(removeKeys(current, patch), null, 2) + "\n");
        touched.push(file);
      } catch {
        /* file missing — nothing to undo */
      }
    } else if (action.kind === "toml-merge" || action.kind === "md-append") {
      const file = resolveFileTemplate(action.file, ctx);
      const begin = action.kind === "toml-merge" ? `# BEGIN agent-prism:${opts.pluginName}` : `<!-- agent-prism:${action.marker} begin -->`;
      const end = action.kind === "toml-merge" ? `# END agent-prism:${opts.pluginName}` : `<!-- agent-prism:${action.marker} end -->`;
      try {
        const text = await readText(file);
        await writeText(file, stripBlock(text, begin, end) + "\n");
        touched.push(file);
      } catch {
        /* file missing */
      }
    }
  }
  return touched;
}

function removeKeys(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    const prev = out[key];
    if (prev === undefined) continue;
    if (Array.isArray(prev) && Array.isArray(value)) {
      const removed = new Set(value.map((v) => JSON.stringify(v)));
      out[key] = prev.filter((v) => !removed.has(JSON.stringify(v)));
      if ((out[key] as unknown[]).length === 0) delete out[key];
    } else if (prev && typeof prev === "object" && value && typeof value === "object") {
      const cleaned = removeKeys(prev as Record<string, unknown>, value as Record<string, unknown>);
      if (Object.keys(cleaned).length > 0) out[key] = cleaned;
      else delete out[key];
    } else {
      delete out[key];
    }
  }
  return out;
}

export { loadPluginManifest, detectAgent, detectInstalledAgents, detectEnvironment, validateBundle, regenerateIndexes };
export type { InstallPlan };
