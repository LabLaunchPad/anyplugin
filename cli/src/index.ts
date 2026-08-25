import {
  type AgentId,
  type EmittedBundle,
  type InstallPlan,
  type ParsedPlugin,
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
  assertSafeRelative,
  resolveAuthorizedPath,
  type Capability,
  supports,
  rationale,
  DEFAULT_VARIANTS,
  generateInstructionTier,
} from "@lablaunchpad/core";
import { SecurityError } from "@lablaunchpad/core";
import { emitClaude } from "@lablaunchpad/adapter-claude";
import { emitOpencode } from "@lablaunchpad/adapter-opencode";
import { emitCodex } from "@lablaunchpad/adapter-codex";
import { emitAntigravity } from "@lablaunchpad/adapter-antigravity";
import {
  type JournalFileEntry,
  hashContent,
  readCurrent,
  readJournal,
  writeJournal,
  classifyJournalEntry,
  applyJournalEntry,
} from "./journal.js";
import { setRuntimePolicy, type RuntimePolicy } from "./runtime-policy.js";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface BuildOptions {
  pluginRoot: string;
  outRoot: string;
  agents?: AgentId[];
  runnerAbsPath: string;
  runnerRelPath?: string;
  mcpRuntimeAbsDir?: string;
  /** Capability-matrix variant pin per agent (default: DEFAULT_VARIANTS). */
  variants?: Partial<Record<AgentId, string>>;
}

/** Derive the capabilities a manifest REQUIRES (spec §2.2 negotiation input). */
function requiredCapabilities(plugin: ParsedPlugin): Capability[] {
  const caps = new Set<Capability>();
  for (const hook of plugin.hooks) caps.add(`hooks.${hook.event}` as Capability);
  for (const server of Object.values(plugin.mcp.servers)) {
    caps.add(server.transport === "http" ? "mcp.http" : "mcp.stdio");
  }
  if (plugin.skills.length > 0) caps.add("skills");
  if (plugin.commands.length > 0) caps.add("commands");
  if (plugin.agents.length > 0) caps.add("agents.subagent");
  if (plugin.knowledge !== undefined) caps.add("knowledge");
  return [...caps];
}

/**
 * Capability gate (spec §2.2): UNSUPPORTED and UNKNOWN are hard build errors
 * (fail closed); DEGRADED emits the documented fallback plus a build warning —
 * never silence.
 */
function enforceCapabilities(agent: AgentId, variant: string, caps: Capability[]): string[] {
  const warnings: string[] = [];
  for (const cap of caps) {
    const level = supports(agent, variant, cap);
    if (level === "UNSUPPORTED") {
      throw new Error(
        `build for ${agent}@${variant} aborted: capability "${cap}" is UNSUPPORTED (${rationale(agent, variant, cap)}). ` +
          `Drop this capability for the target, drop the target, or accept a documented DEGRADED path.`,
      );
    }
    if (level === "UNKNOWN") {
      throw new Error(
        `build for ${agent}@${variant} aborted: support for capability "${cap}" is UNKNOWN — failing closed. ` +
          `Pin a known target variant or extend the capability matrix (core/src/capabilities/matrix.ts).`,
      );
    }
    if (level === "DEGRADED") {
      warnings.push(`capability DEGRADED on ${agent}@${variant}: ${cap} — ${rationale(agent, variant, cap)}`);
    }
  }
  return warnings;
}

/** Emit native bundles for every (or selected) agent. */
export async function buildAll(opts: BuildOptions): Promise<Record<string, EmittedBundle>> {
  const plugin = await loadPluginManifest(opts.pluginRoot);
  const agents = opts.agents ?? [...ALL_AGENTS];
  const runnerRelPath = opts.runnerRelPath ?? "runner.js";
  const caps = requiredCapabilities(plugin);
  const common = {
    pluginRoot: opts.pluginRoot,
    runnerRelPath,
    runnerAbsPath: opts.runnerAbsPath,
    mcpRuntimeAbsDir: opts.mcpRuntimeAbsDir,
  };
  const results: Record<string, EmittedBundle> = {};
  for (const agent of agents) {
    const variant = opts.variants?.[agent] ?? DEFAULT_VARIANTS[agent];
    const warnings = enforceCapabilities(agent, variant, caps);
    const outDir = join(opts.outRoot, agent);
    let bundle: EmittedBundle;
    if (agent === "claude-code") bundle = await emitClaude(plugin, { ...common, outDir });
    else if (agent === "opencode") bundle = await emitOpencode(plugin, { ...common, outDir });
    else if (agent === "codex") bundle = await emitCodex(plugin, { ...common, outDir });
    else bundle = await emitAntigravity(plugin, { ...common, outDir });
    bundle.warnings.push(...warnings);
    results[agent] = bundle;
  }
  return results;
}

export interface InstallOptions {
  home: string;
  projectDir: string;
  pluginName: string;
  /** Plugin version (recorded in the install journal). */
  version?: string;
  dryRun?: boolean;
  /** Manifest's `runtime` block (CORE-INVARIANTS-V2.md §1.3); absent = non-blocking default. */
  runtime?: Partial<RuntimePolicy>;
}

export interface ScaffoldResult {
  dir: string;
  name: string;
  files: string[];
}

/** Location of the bundled starter template (repo layout: templates/starter). */
function starterTemplateDir(): string {
  return resolve(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates", "starter"));
}

async function listFilesRecursive(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  for (const entry of await listDir(dir)) {
    if (entry.isDir) await listFilesRecursive(entry.abs, base, out);
    else out.push(entry.abs.slice(base.length + 1).split("\\").join("/"));
  }
  return out;
}

/**
 * Scaffold a new canonical plugin from templates/starter into targetDir.
 * Only the manifest name is rewritten; every other file is copied verbatim.
 */
export async function scaffoldPlugin(name: string, targetDir: string): Promise<ScaffoldResult> {
  validatePluginName(name);
  const templateDir = starterTemplateDir();
  if (!(await pathExists(templateDir))) {
    throw new Error(`starter template not found: ${templateDir}`);
  }
  if (await pathExists(targetDir)) {
    throw new Error(`target directory already exists: ${targetDir}`);
  }
  const parent = dirname(targetDir);
  if (!(await pathExists(parent))) {
    throw new Error(`parent directory not found: ${parent}`);
  }
  await copyDir(templateDir, targetDir);
  const manifestPath = join(targetDir, "anyplugin.plugin.yaml");
  const text = await readText(manifestPath);
  await writeText(manifestPath, text.replace(/^name: my-plugin$/m, `name: ${name}`));
  return { dir: targetDir, name, files: await listFilesRecursive(targetDir) };
}

/** Plugin names are the only user-controlled path segment; lock them to kebab-case. */
export function validatePluginName(name: string): string {
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`unsafe plugin name: ${JSON.stringify(name)}`);
  }
  return name;
}

/**
 * Relative paths from install plans pass the SafePath boundary (spec §1.1):
 * lexical rejection of traversal/absolute/UNC/drive forms, then containment.
 * `.` is the legitimate whole-bundle root copy (role: "root") and is allowed.
 */
export function validateRelPath(rel: string, what: string): string {
  if (rel === ".") return rel;
  return assertSafeRelative(rel, `relative path in ${what}`);
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
  "{{PROJECT}}/.anyplugin/instruction": (o) => join(o.projectDir, ".anyplugin", "instruction"),
};

/** Minimal template context for CLI paths that only ever vary by project dir. */
function projectTemplateCtx(projectDir: string): { home: string; projectDir: string; codexHome: string } {
  return { home: projectDir, projectDir, codexHome: projectDir };
}

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
  if (segment.includes("/") || segment.includes("\\")) {
    throw new SecurityError(`unsafe path segment in ${what}: separators are not allowed (${JSON.stringify(segment)})`);
  }
  return assertSafeRelative(segment, `path segment in ${what}`);
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

/** Journal entry for a marker-delimited edit; an empty stripped file counts as "did not exist". */
function markerEntry(file: string, stripped: string, finalText: string): JournalFileEntry {
  const backup = stripped.trim() === "" ? null : stripped;
  return {
    file,
    kind: "marker",
    preInstallHash: backup === null ? null : hashContent(backup),
    postInstallHash: hashContent(finalText),
    backupContent: backup,
    ownedKeys: null,
  };
}

/** Execute one agent's install plan. Returns what happened for reporting.
 * Every config edit is journaled so uninstall can restore exact pre-install bytes. */
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
  const journalFiles: JournalFileEntry[] = [];

  for (const action of bundle.install.actions) {
    if (action.kind === "copy") {
      const srcRel = validateRelPath(action.srcRel, `${agent} copy srcRel`);
      if (srcRel !== ".") await resolveAuthorizedPath(bundle.dir, srcRel); // containment: src lives inside the emitted bundle
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
      const preText = await readCurrent(file);
      let base: Record<string, unknown>;
      if (preText === null) {
        base = {};
      } else {
        try {
          base = JSON.parse(preText) as Record<string, unknown>;
        } catch (err) {
          throw new Error(`refusing to merge into unparseable JSON config ${file}: ${(err as Error).message}`);
        }
      }
      const merged = deepMerge(base, patch);
      await writeText(file, JSON.stringify(merged, null, 2) + "\n");
      mergedFiles.push(file);
      journalFiles.push({
        file,
        kind: "json-merge",
        preInstallHash: preText === null ? null : hashContent(preText),
        postInstallHash: hashContent(await readText(file)),
        backupContent: preText,
        ownedKeys: Object.keys(action.patch),
      });
    } else if (action.kind === "toml-merge") {
      const file = resolveFileTemplate(action.file, ctx);
      if (opts.dryRun) {
        notes.push(`would append [mcp_servers] to ${file}`);
        continue;
      }
      const begin = `# BEGIN anyplugin:${opts.pluginName}`;
      const end = `# END anyplugin:${opts.pluginName}`;
      let text = "";
      try {
        text = await readText(file);
      } catch {
        text = "";
      }
      // backup = file with any previous plugin block already stripped, so a
      // reinstall→uninstall cycle never resurrects stale markers.
      const stripped = text.includes(begin) ? stripBlock(text, begin, end) : text;
      const toml = substValues(action.append, root) as string;
      const finalText = stripped.trimEnd() + `\n\n${begin}\n${toml.trimEnd()}\n${end}\n`;
      await writeText(file, finalText);
      mergedFiles.push(file);
      journalFiles.push(markerEntry(file, stripped, finalText));
    } else if (action.kind === "md-append") {
      const file = resolveFileTemplate(action.file, ctx);
      if (opts.dryRun) {
        notes.push(`would append ${opts.pluginName} section to ${file}`);
        continue;
      }
      const begin = `<!-- anyplugin:${action.marker} begin -->`;
      const end = `<!-- anyplugin:${action.marker} end -->`;
      let text = "";
      try {
        text = await readText(file);
      } catch {
        text = "";
      }
      const stripped = text.includes(begin) ? stripBlock(text, begin, end) : text;
      const finalText = stripped.trimEnd() + "\n" + action.content.trimEnd() + "\n";
      await writeText(file, finalText);
      mergedFiles.push(file);
      journalFiles.push(markerEntry(file, stripped, finalText));
    }
  }

  if (!opts.dryRun) {
    const journalPath = await writeJournal(root, {
      pluginId: opts.pluginName,
      version: opts.version ?? "",
      agent,
      files: journalFiles,
    });
    notes.push(`state journal: ${journalPath}`);
    // Runtime state, same class as .anyplugin-mode — not journal-tracked
    // (reversibility is owned by the journal above; this is what runner.js
    // reads at hook-execution time, written fresh on every install).
    await setRuntimePolicy(root, opts.runtime);
  } else if (opts.runtime?.failurePolicy === "blocking") {
    notes.push(`would set runtime.failurePolicy=blocking at ${root}`);
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
  if (e < 0) {
    // A begin marker with no end marker means the block is corrupted; stripping
    // would silently delete everything after `begin`. Refuse and describe it.
    throw new Error(`corrupted marker block: missing end marker (found begin marker "${begin}") — refusing to strip`);
  }
  const after = text.slice(e + end.length);
  // Keep the trailing newline of the pre-block content so journal backups are
  // byte-exact; callers that append handle their own trimming.
  return text.slice(0, b).trimEnd() + "\n" + after.trimStart();
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

/** Reverse an install: restore journaled files byte-exact, remove copied dirs.
 * If a journaled file was modified after install, ABORT with a descriptive
 * error instead of overwriting the user's edits. With dryRun, report what
 * would happen (including conflicts) without touching anything. Falls back to
 * a conservative marker/keys cleanup for installs predating the journal. */
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

  const journal = await readJournal(root);
  if (journal) {
    // Phase A: classify every journaled file before modifying anything.
    const statuses: { entry: JournalFileEntry; status: ReturnType<typeof classifyJournalEntry> }[] = [];
    for (const entry of journal.files) {
      statuses.push({ entry, status: classifyJournalEntry(entry, await readCurrent(entry.file)) });
    }
    const conflicts = statuses.filter((s) => s.status.action === "conflict");
    if (conflicts.length > 0) {
      if (opts.dryRun) {
        for (const c of conflicts) touched.push(`CONFLICT: ${c.entry.file} was modified after install — uninstall would abort`);
      } else {
        throw new Error(
          `uninstall aborted — ${opts.pluginName} config was modified after install (outside its managed content): ` +
            conflicts.map((c) => c.entry.file).join(", ") +
            ". Review those edits, or re-run install to refresh the plugin's state journal, then uninstall again.",
        );
      }
    }
    // Phase B: apply restores only when nothing conflicts.
    for (const { entry, status } of statuses) {
      if (opts.dryRun) {
        if (status.action === "restore") touched.push(`would restore ${entry.file} to pre-install content`);
        else if (status.action === "delete") touched.push(`would delete ${entry.file} (created by install)`);
        else if (status.action === "missing") touched.push(`note: ${entry.file} already deleted by user`);
      } else if (status.action !== "conflict") {
        if (await applyJournalEntry(entry, status)) touched.push(entry.file);
      }
    }
    // Copies (including the plugin root, which holds the journal) still go
    // through the install plan; merge files were handled above.
    for (const action of bundle.install.actions) {
      if (action.kind !== "copy") continue;
      const srcRel = validateRelPath(action.srcRel, `${agent} uninstall srcRel`);
      if (srcRel !== ".") await resolveAuthorizedPath(bundle.dir, srcRel);
      const dest = copyDest(action, agent, ctx, opts.pluginName);
      if (await pathExists(dest)) {
        if (opts.dryRun) touched.push(`would remove ${dest}`);
        else {
          await removeTree(dest);
          touched.push(dest);
        }
      }
    }
    return touched;
  }

  // Legacy fallback (journal absent): conservative cleanup that never creates,
  // truncates, or reformats a config file.
  for (const action of bundle.install.actions) {
    if (action.kind === "copy") {
      const srcRel = validateRelPath(action.srcRel, `${agent} uninstall srcRel`);
      if (srcRel !== ".") await resolveAuthorizedPath(bundle.dir, srcRel);
      const dest = copyDest(action, agent, ctx, opts.pluginName);
      if (await pathExists(dest)) {
        if (opts.dryRun) touched.push(`would remove ${dest}`);
        else {
          await removeTree(dest);
          touched.push(dest);
        }
      }
    } else if (action.kind === "json-merge") {
      const file = resolveFileTemplate(action.file, ctx);
      const patch = substValues(action.patch, root) as Record<string, unknown>;
      let text: string;
      try {
        text = await readText(file);
      } catch {
        continue; // file missing — nothing to undo
      }
      let current: Record<string, unknown>;
      try {
        current = JSON.parse(text) as Record<string, unknown>;
      } catch {
        continue; // unparseable — never truncate; nothing we can safely revert
      }
      const cleaned = removeKeys(current, patch);
      if (JSON.stringify(cleaned) === JSON.stringify(current)) continue; // no owned keys present
      if (opts.dryRun) {
        touched.push(`would revert keys in ${file}`);
        continue;
      }
      await writeText(file, JSON.stringify(cleaned, null, 2) + "\n");
      touched.push(file);
    } else if (action.kind === "toml-merge" || action.kind === "md-append") {
      const file = resolveFileTemplate(action.file, ctx);
      const begin = action.kind === "toml-merge" ? `# BEGIN anyplugin:${opts.pluginName}` : `<!-- anyplugin:${action.marker} begin -->`;
      const end = action.kind === "toml-merge" ? `# END anyplugin:${opts.pluginName}` : `<!-- anyplugin:${action.marker} end -->`;
      let text: string;
      try {
        text = await readText(file);
      } catch {
        continue; // file missing — nothing to undo
      }
      if (!text.includes(begin)) continue;
      if (opts.dryRun) {
        touched.push(`would strip marker block in ${file}`);
        continue;
      }
      await writeText(file, stripBlock(text, begin, end).replace(/\n+$/, "") + "\n");
      touched.push(file);
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

/** Validated plugin manifest access for the CLI: root must exist, be a directory, contain no traversal. */
export async function loadPluginSafe(pluginRoot: string): Promise<{ name: string; version: string; runtime?: RuntimePolicy }> {
  const manifest = await loadPluginManifest(pluginRoot);
  return { name: manifest.name, version: manifest.version, runtime: manifest.runtime };
}

/**
 * Instruction-Tier Fallback (ponytail pattern): install a plugin as a marked
 * AGENTS.md section for agents with no plugin API. Uses the SAME journal
 * machinery as native installs — byte-exact restore and conflict-abort on
 * uninstall, no special cases.
 */
export async function installInstructions(opts: {
  pluginRoot: string;
  projectDir: string;
  dryRun?: boolean;
}): Promise<{ agentsMd: string; stateRoot: string; notes: string[] }> {
  const plugin = await loadPluginManifest(opts.pluginRoot);
  const name = validatePluginName(plugin.name);
  const ctx = projectTemplateCtx(opts.projectDir);
  const agentsMd = resolveFileTemplate("{{PROJECT}}/AGENTS.md", ctx);
  const stateRoot = join(resolveFileTemplate("{{PROJECT}}/.anyplugin/instruction", ctx), name);
  const notes: string[] = [];
  if (opts.dryRun) {
    notes.push(`would append instruction tier to ${agentsMd}`);
    return { agentsMd, stateRoot, notes };
  }
  // Namespaced with a `:instruction` suffix so this never collides with a
  // native install's own `anyplugin:<name>` marker in the same AGENTS.md
  // (e.g. OpenCode's md-append action) — each install owns an independent
  // block, and each can be installed/uninstalled without disturbing the other.
  const begin = `<!-- anyplugin:${plugin.name}:instruction begin -->`;
  const end = `<!-- anyplugin:${plugin.name}:instruction end -->`;
  let text = "";
  try {
    text = await readText(agentsMd);
  } catch {
    text = "";
  }
  const stripped = text.includes(begin) ? stripBlock(text, begin, end) : text;
  const section = `${begin}\n${generateInstructionTier(plugin).trimEnd()}\n${end}`;
  const finalText = stripped.trimEnd() + "\n\n" + section + "\n";
  await writeText(agentsMd, finalText);
  await writeJournal(stateRoot, {
    pluginId: plugin.name,
    version: plugin.version,
    agent: "instruction",
    files: [markerEntry(agentsMd, stripped, finalText)],
  });
  notes.push(`state journal: ${join(stateRoot, ".anyplugin-state.json")}`);
  return { agentsMd, stateRoot, notes };
}

/** Reverse an instruction-tier install using the journal (conflict-safe). */
export async function uninstallInstructions(opts: {
  pluginRoot: string;
  projectDir: string;
  dryRun?: boolean;
}): Promise<string[]> {
  const plugin = await loadPluginManifest(opts.pluginRoot);
  const name = validatePluginName(plugin.name);
  const ctx = projectTemplateCtx(opts.projectDir);
  const stateRoot = join(resolveFileTemplate("{{PROJECT}}/.anyplugin/instruction", ctx), name);
  const journal = await readJournal(stateRoot);
  if (!journal) return [];
  const touched: string[] = [];
  const statuses: { entry: JournalFileEntry; status: ReturnType<typeof classifyJournalEntry> }[] = [];
  for (const entry of journal.files) {
    statuses.push({ entry, status: classifyJournalEntry(entry, await readCurrent(entry.file)) });
  }
  const conflicts = statuses.filter((s) => s.status.action === "conflict");
  if (conflicts.length > 0) {
    if (opts.dryRun) {
      for (const c of conflicts) touched.push(`CONFLICT: ${c.entry.file} was modified after install — uninstall would abort`);
    } else {
      throw new Error(
        `uninstall aborted — ${plugin.name} instructions were modified after install: ${conflicts.map((c) => c.entry.file).join(", ")}. Review the edits or re-run install to refresh the journal, then uninstall again.`,
      );
    }
  }
  for (const { entry, status } of statuses) {
    if (opts.dryRun) {
      if (status.action === "restore") touched.push(`would restore ${entry.file} to pre-install content`);
      else if (status.action === "delete") touched.push(`would delete ${entry.file} (created by install)`);
    } else if (status.action !== "conflict" && (await applyJournalEntry(entry, status))) {
      touched.push(entry.file);
    }
  }
  if (!opts.dryRun) {
    await removeTree(stateRoot);
    touched.push(stateRoot);
  } else {
    touched.push(`would remove ${stateRoot}`);
  }
  return touched;
}

export { loadPluginManifest, detectAgent, detectInstalledAgents, detectEnvironment, validateBundle, regenerateIndexes };
export type { InstallPlan };
