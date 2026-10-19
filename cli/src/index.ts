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
import { randomBytes } from "node:crypto";
import { emitClaude } from "@lablaunchpad/adapter-claude";
import { emitOpencode } from "@lablaunchpad/adapter-opencode";
import { emitCodex } from "@lablaunchpad/adapter-codex";
import { emitAntigravity } from "@lablaunchpad/adapter-antigravity";
import {
  type JournalFileEntry,
  hashContent,
  readCurrentWithError,
  readJournal,
  writeJournal,
  classifyJournalEntry,
  applyJournalEntry,
  type ReadResult,
  JOURNAL_SCHEMA_VERSION,
} from "./journal.js";
import {
  createTransactionContext,
  stagedPayloadPath,
  writeInstallIntent,
  backupDestinations,
  restoreFromBackups,
  verifyAppliedState,
  hashDirFiles,
  hashTree,
  INTENT_VERSION,
  type BackupManifest,
} from "./transaction.js";
import { join, dirname, resolve, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { lstat, realpath, readdir } from "node:fs/promises";

/**
 * Generate a unique installation ID (ULID-like, 26 chars, sortable).
 * Uses timestamp (10 bytes) + randomness (16 bytes) encoded as base32.
 */
export function generateInstallationId(): string {
  const timestamp = Date.now();
  const timeBytes = Buffer.alloc(8);
  timeBytes.writeBigUInt64BE(BigInt(timestamp), 0);
  const random = randomBytes(10);
  const combined = Buffer.concat([timeBytes.slice(2), random]); // 16 bytes total
  // Crockford's base32 encoding
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let result = "";
  for (let i = 0; i < combined.length; i += 1) {
    const byte = combined[i]!;
    result += alphabet[byte >> 3];
    if (i + 1 < combined.length) {
      const nextByte = combined[i + 1]!;
      result += alphabet[((byte & 0x07) << 2) | (nextByte >> 6)];
    }
  }
  return result.slice(0, 26);
}

/** Destination classification result. */
export type DestinationClassification =
  | { kind: "ABSENT"; path: string; reason: string }
  | { kind: "OWNED"; path: string; installationId: string; reason: string }
  | { kind: "CONFLICTING"; path: string; reason: string; existingInstallationId?: string };

/**
 * Classify a destination path before install.
 * Resolves real paths and rejects symlink/junction/reparse-point escapes in destination parents.
 * A matching plugin name is NOT ownership — ownership is proven by installation ID + managed file hashes.
 */
export async function classifyDestination(
  dest: string,
  authorizedRoot: string,
  expectedInstallationId: string,
  expectedPluginId: string,
  /**
   * The installed root that holds the plugin's journal. Non-root copy
   * destinations (skills/, commands/, agent/) live OUTSIDE the installed root,
   * so their ownership is proven by the journal entry in the root — not by a
   * journal inside the destination itself. When omitted, only a journal at the
   * destination itself is consulted.
   */
  journalRoot?: string,
): Promise<DestinationClassification> {
  // First, resolve the authorized root's realpath
  // The authorized root itself may not exist yet (e.g., .claude, .opencode directories)
  // but its parent must exist and be valid.
  const authorizedRootResolved = resolve(authorizedRoot);
  let authorizedRootReal = await tryRealpath(authorizedRootResolved);
  if (authorizedRootReal === null) {
    // Authorized root doesn't exist yet - check if its parent exists and is valid
    const parentOfAuthorizedRoot = resolve(authorizedRootResolved, "..");
    const parentReal = await tryRealpath(parentOfAuthorizedRoot);
    if (parentReal === null) {
      throw new SecurityError(`unsafe destination: authorized root's parent does not exist: ${parentOfAuthorizedRoot}`);
    }
    // The authorized root will be created inside the valid parent
    authorizedRootReal = parentReal;
  }

  // Resolve the destination's realpath (handles symlinks, junctions, reparse points)
  const destReal = await tryRealpath(resolve(dest));
  
  // Check if the destination exists
  if (destReal === null) {
    // Destination does not exist — find the deepest existing ancestor
    // and verify it's contained in the authorized root.
    // This allows creating new directories (like .opencode/plugins/test-plugin)
    // as long as the path would be created inside the authorized root.
    const deepestExistingAncestor = await findDeepestExistingAncestor(dest);
    if (deepestExistingAncestor === null) {
      throw new SecurityError(`no existing ancestor found for destination: ${dest}`);
    }
    const ancestorReal = await tryRealpath(deepestExistingAncestor);
    if (ancestorReal === null) {
      throw new SecurityError(`cannot resolve deepest existing ancestor: ${deepestExistingAncestor}`);
    }
    if (!isContained(ancestorReal, authorizedRootReal)) {
      throw new SecurityError(`destination path escapes authorized root: ${dest} (ancestor: ${deepestExistingAncestor} → ${ancestorReal})`);
    }
    // Also check for unresolvable links in the path (dangling symlinks/junctions)
    await checkForUnresolvableLinks(dest, authorizedRootReal);
    return { kind: "ABSENT", path: dest, reason: "destination does not exist" };
  }

  // Destination exists — check containment
  if (!isContained(destReal, authorizedRootReal)) {
    throw new SecurityError(`destination escapes authorized root: ${dest} → ${destReal}`);
  }

  // Check for unresolvable links in the path
  await checkForUnresolvableLinks(dest, authorizedRootReal);

  // Check for existing journal to determine ownership
  // Check the realpath, the resolved path, and the original path (Windows paths may differ)
  let journal = await readJournal(destReal);
  if (!journal) {
    journal = await readJournal(resolve(dest));
  }
  if (!journal) {
    // Fallback: check the original destination path (same as root from installedRoot)
    journal = await readJournal(dest);
  }

  if (journal) {
    // Journal exists — check if it matches our installation ID
    if (journal.installationId === expectedInstallationId) {
      // Verify all managed files still match (not tampered)
      const managedFilesMatch = await verifyManagedFilesMatch(journal);
      if (managedFilesMatch) {
        return { kind: "OWNED", path: destReal, installationId: journal.installationId, reason: "owned by this installation" };
      }
      return { kind: "CONFLICTING", path: destReal, reason: "managed files modified since install", existingInstallationId: journal.installationId };
    }
    // Journal exists but belongs to a different installation
    return { kind: "CONFLICTING", path: destReal, reason: "owned by another installation", existingInstallationId: journal.installationId };
  }

  // No journal AT the destination. For destinations that live outside the
  // installed root (skills/, commands/, agent/), ownership is proven by the
  // journal in the installed root: it lists this exact path as a managed
  // copy entry. Without this, every reinstall would falsely conflict.
  if (journalRoot) {
    const rootJournal = await readJournal(journalRoot);
    const managed = rootJournal?.files.find((f) => f.kind === "copy" && samePath(f.file, dest));
    if (managed && rootJournal) {
      if (rootJournal.installationId === expectedInstallationId) {
        return { kind: "OWNED", path: destReal, installationId: rootJournal.installationId, reason: "owned by this installation (managed by the plugin journal)" };
      }
      return { kind: "CONFLICTING", path: destReal, reason: "owned by another installation", existingInstallationId: rootJournal.installationId };
    }
  }

  // No journal — destination exists but is unmanaged
  return { kind: "CONFLICTING", path: destReal, reason: "destination exists but is not managed by anyplugin" };
}

/** Compare two paths for equality, ignoring case and separator differences (Windows). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/\\/g, "/").toLowerCase();
  return norm(a) === norm(b);
}

/** Find the deepest existing ancestor of a path. */
async function findDeepestExistingAncestor(path: string): Promise<string | null> {
  let probe = resolve(path);
  for (;;) {
    try {
      await lstat(probe);
      return probe;
    } catch {
      // Doesn't exist, walk up
    }
    if (probe === parse(probe).root || probe.length <= 2) {
      return null;
    }
    const idx = probe.lastIndexOf(sep);
    if (idx < 0) return null;
    probe = probe.slice(0, idx);
  }
}

/** Verify that all managed files in the journal still match their post-install hashes. */
async function verifyManagedFilesMatch(journal: { files: Array<{ file: string; postInstallHash: string; kind: string }> }): Promise<boolean> {
  for (const entry of journal.files) {
    // Skip copy entries - ownership is proven by installationId in journal
    if (entry.kind === "copy") continue;
    try {
      const result = await readCurrentWithError(entry.file);
      if (result.content === null) return false;
      if (hashContent(result.content) !== entry.postInstallHash) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** Check for unresolvable symlinks/junctions in the path (dangling links = escape risk). */
async function checkForUnresolvableLinks(path: string, authorizedRootReal: string): Promise<void> {
  let probe = resolve(path);
  for (;;) {
    const probed = await tryRealpath(probe);
    if (probed !== null) {
      // Reached an existing ancestor — done
      return;
    }
    // realpath failed but entry EXISTS ⇒ unresolvable link (dangling symlink/junction)
    if (await entryExists(probe)) {
      throw new SecurityError(`destination path passes through unresolvable link: ${probe}`);
    }
    if (probe === parse(probe).root || probe.length <= 2) {
      return;
    }
    const idx = probe.lastIndexOf(sep);
    if (idx < 0) return;
    probe = probe.slice(0, idx);
  }
}

async function tryRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

async function entryExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

const sep = process.platform === "win32" ? "\\" : "/";

/** True iff `candidate` is `root` itself or lies strictly inside `root`. */
function isContained(candidate: string, root: string): boolean {
  const norm = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
  if (norm(candidate) === norm(root)) return true;
  const withSep = root.endsWith(sep) ? root : root + sep;
  return norm(candidate).startsWith(norm(withSep));
}

/** Validate a destination path for merge operations: check containment and symlink escapes, but allow existing files. */
async function validateDestinationPath(dest: string, authorizedRoot: string): Promise<DestinationClassification> {
  const authorizedRootResolved = resolve(authorizedRoot);
  let authorizedRootReal = await tryRealpath(authorizedRootResolved);
  if (authorizedRootReal === null) {
    const parentOfAuthorizedRoot = resolve(authorizedRootResolved, "..");
    const parentReal = await tryRealpath(parentOfAuthorizedRoot);
    if (parentReal === null) {
      throw new SecurityError(`unsafe destination: authorized root's parent does not exist: ${parentOfAuthorizedRoot}`);
    }
    authorizedRootReal = parentReal;
  }

  const destReal = await tryRealpath(resolve(dest));
  
  if (destReal === null) {
    // Destination does not exist — find the deepest existing ancestor
    const deepestExistingAncestor = await findDeepestExistingAncestor(dest);
    if (deepestExistingAncestor === null) {
      throw new SecurityError(`no existing ancestor found for destination: ${dest}`);
    }
    const ancestorReal = await tryRealpath(deepestExistingAncestor);
    if (ancestorReal === null) {
      throw new SecurityError(`cannot resolve deepest existing ancestor: ${deepestExistingAncestor}`);
    }
    if (!isContained(ancestorReal, authorizedRootReal)) {
      throw new SecurityError(`destination path escapes authorized root: ${dest} (ancestor: ${deepestExistingAncestor} → ${ancestorReal})`);
    }
    await checkForUnresolvableLinks(dest, authorizedRootReal);
    return { kind: "ABSENT", path: dest, reason: "destination does not exist" };
  }

  // Destination exists — check containment
  if (!isContained(destReal, authorizedRootReal)) {
    throw new SecurityError(`destination escapes authorized root: ${dest} → ${destReal}`);
  }

  // Check for unresolvable links in the path
  await checkForUnresolvableLinks(dest, authorizedRootReal);

  // For merge operations, existing files are OK — we'll merge into them and journal the original
  return { kind: "ABSENT", path: destReal, reason: "destination exists and will be merged" };
}

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
  /**
   * TEST-ONLY fault injection. Called after each destination is applied, with
   * the destination path. Throwing from this hook simulates a mid-install
   * failure and proves the rollback engine restores every destination.
   * Never set in production code paths.
   */
  __onApplied?: (dest: string) => void | Promise<void>;
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
 * Root of the transactional-install scratch space (staging + backups).
 *
 * It is deliberately a SIBLING of the installed plugin root, never a child:
 * the "root" copy destination is `installedRoot(...)` itself, so staging inside
 * it would make `copyDir(staged → dest)` copy a directory into its own
 * subtree. Keeping it as a sibling also keeps the scratch space out of the
 * bundle that gets installed.
 */
export function transactionWorkspaceRoot(
  agent: AgentId,
  ctx: { home: string; projectDir: string; codexHome: string },
  pluginName: string,
): string {
  const name = validatePluginName(pluginName);
  switch (agent) {
    case "claude-code":
      return join(ctx.home, ".claude", "plugins", `.anyplugin-tx-${name}`);
    case "codex":
      return join(ctx.codexHome, "plugins", `.anyplugin-tx-${name}`);
    case "antigravity":
      return join(ctx.projectDir, ".agents", "plugins", `.anyplugin-tx-${name}`);
    case "opencode":
      return join(ctx.projectDir, ".opencode", "plugins", `.anyplugin-tx-${name}`);
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
 *
 * Transactional pipeline (audit Finding E):
 *
 *   1. PREFLIGHT — classify every destination (ABSENT / OWNED / CONFLICTING);
 *                   refuse conflicting destinations BEFORE any mutation.
 *   2. STAGE     — render every incoming byte into a staging area. The host is
 *                   never touched during this phase.
 *   3. INTENT    — persist install_intent.json describing exactly what changes.
 *   4. BACKUP    — snapshot the current content of every destination.
 *   5. APPLY     — copy staged bytes onto the host, revalidating ownership
 *                   immediately before each write (TOCTOU protection).
 *   6. VERIFY    — re-hash every destination and compare against the staged
 *                   hashes. A mismatch aborts the install.
 *   7. COMMIT    — write the journal, then purge staging + backups.
 *
 * Any failure after STAGE triggers the rollback engine: every destination is
 * restored from its backup (or removed when it did not exist before) and the
 * staging area is purged. A failed install never leaves a partial state.
 */
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

  // Generate installation ID for this install invocation
  const installationId = generateInstallationId();

  /** Resolve the authorized root that bounds a given destination. */
  const authorizedRootFor = (action: typeof bundle.install.actions[0]): string => {
    switch (agent) {
      case "claude-code":
        return opts.home;
      case "codex":
        return process.env["CODEX_HOME"] ?? join(opts.home, ".codex");
      case "antigravity":
        return opts.projectDir;
      case "opencode":
        return opts.projectDir;
    }
  };

  // ── PHASE 1: PREFLIGHT ────────────────────────────────────────────────────
  // Classify all destinations before any mutations.
  const destinations = new Map<string, { action: typeof bundle.install.actions[0]; dest: string }>();
  for (const action of bundle.install.actions) {
    if (action.kind === "copy") {
      const srcRel = validateRelPath(action.srcRel, `${agent} copy srcRel`);
      if (srcRel !== ".") await resolveAuthorizedPath(bundle.dir, srcRel);
      const dest = copyDest(action, agent, ctx, opts.pluginName);
      if (destinations.has(dest)) {
        throw new Error(`duplicate destination in install plan: ${dest}`);
      }
      destinations.set(dest, { action, dest });
    } else if (action.kind === "json-merge" || action.kind === "toml-merge" || action.kind === "md-append") {
      const file = resolveFileTemplate(action.file, ctx);
      if (destinations.has(file)) {
        throw new Error(`duplicate destination in install plan: ${file}`);
      }
      destinations.set(file, { action, dest: file });
    }
  }

  const preflightResults: Array<{ dest: string; classification: DestinationClassification }> = [];
  for (const [dest, { action }] of destinations) {
    const authorizedRoot = authorizedRootFor(action);

    // For copy operations, apply full ownership classification.
    // For merge operations (json-merge, toml-merge, md-append), only validate path
    // containment and symlink escapes — we expect the file to exist and will merge
    // into it, tracking the original content in the journal for restore on uninstall.
    let classification: DestinationClassification;
    if (action.kind === "copy") {
      classification = await classifyDestination(dest, authorizedRoot, installationId, opts.pluginName, root);
    } else {
      classification = await validateDestinationPath(dest, authorizedRoot);
    }
    preflightResults.push({ dest, classification });
  }

  // Check for conflicts
  const conflicts = preflightResults.filter(
    (r): r is { dest: string; classification: Extract<DestinationClassification, { kind: "CONFLICTING" }> } =>
      r.classification.kind === "CONFLICTING",
  );
  if (conflicts.length > 0) {
    const conflictMessages = conflicts.map(
      (c) =>
        `${c.dest}: ${c.classification.reason}${
          c.classification.existingInstallationId ? ` (owned by ${c.classification.existingInstallationId})` : ""
        }`,
    );
    if (opts.dryRun) {
      for (const c of conflicts) {
        notes.push(
          `CONFLICT: ${c.dest}: ${c.classification.reason}${
            c.classification.existingInstallationId ? ` (owned by ${c.classification.existingInstallationId})` : ""
          }`,
        );
      }
    } else {
      throw new Error(
        `install aborted — destination ownership conflicts detected:\n` +
          conflictMessages.map((m) => `  ${m}`).join("\n") +
          "\nUse --dry-run to see conflicts without modifying files. " +
          "Resolve by removing unmanaged content, uninstalling the existing plugin, or choosing a different target.",
      );
    }
  }

  // ── DRY RUN ──────────────────────────────────────────────────────────────
  // Report what would happen without touching anything on disk.
  if (opts.dryRun) {
    for (const action of bundle.install.actions) {
      if (action.kind === "copy") {
        const srcRel = validateRelPath(action.srcRel, `${agent} copy srcRel`);
        const dest = copyDest(action, agent, ctx, opts.pluginName);
        notes.push(`would copy ${srcRel} → ${dest}`);
      } else if (action.kind === "json-merge") {
        const file = resolveFileTemplate(action.file, ctx);
        const patch = substValues(action.patch, root) as Record<string, unknown>;
        notes.push(`would merge ${JSON.stringify(patch)} into ${file}`);
      } else if (action.kind === "toml-merge") {
        const file = resolveFileTemplate(action.file, ctx);
        notes.push(`would append [mcp_servers] to ${file}`);
      } else if (action.kind === "md-append") {
        const file = resolveFileTemplate(action.file, ctx);
        notes.push(`would append ${opts.pluginName} section to ${file}`);
      }
    }
    return { agent, copiedDirs, mergedFiles, notes };
  }

  // ── PHASE 2: STAGE ────────────────────────────────────────────────────────
  // Render every incoming byte into the staging area. The host is untouched.
  //
  // The transaction workspace MUST live outside every destination path: the
  // "root" copy destination IS `root` itself, so staging inside it would make
  // copyDir(staged → dest) recurse into its own source.
  const tx = await createTransactionContext(transactionWorkspaceRoot(agent, ctx, opts.pluginName), installationId);
  let backups: BackupManifest | null = null;

  try {
    let payloadIndex = 0;
    for (const action of bundle.install.actions) {
      if (action.kind === "copy") {
        const srcRel = validateRelPath(action.srcRel, `${agent} copy srcRel`);
        const dest = copyDest(action, agent, ctx, opts.pluginName);

        // Stage the directory tree.
        const stagedPath = stagedPayloadPath(tx, payloadIndex++);
        await copyDir(join(bundle.dir, srcRel), stagedPath);
        // Substitute {{PLUGIN_ROOT}} in the staged copy so the staged bytes are
        // exactly the bytes that will land on the host. The token must resolve
        // to the FINAL destination path, never to the staging path.
        if (action.role === "root") {
          await substFilesIn(stagedPath, dest);
        }
        const fileHashes = await hashDirFiles(stagedPath);
        const expectedHash = hashTree(fileHashes);
        const copiedFiles = await listFilesRecursive(stagedPath);

        tx.payloads.push({
          dest,
          kind: "copy",
          stagedPath,
          isDirectory: true,
          expectedHash,
          fileHashes,
          journalEntry: {
            file: dest,
            kind: "copy",
            preInstallHash: null, // Directory didn't exist before
            postInstallHash: hashContent(installationId), // Use installation ID as proof of ownership
            backupContent: null,
            ownedKeys: null,
            copiedFiles,
          },
        });
      } else if (action.kind === "json-merge") {
        const file = resolveFileTemplate(action.file, ctx);
        const patch = substValues(action.patch, root) as Record<string, unknown>;

        const preResult = await readCurrentWithError(file);
        let base: Record<string, unknown>;
        if (preResult.content === null) {
          base = {};
        } else {
          try {
            base = JSON.parse(preResult.content) as Record<string, unknown>;
          } catch (err) {
            throw new Error(`refusing to merge into unparseable JSON config ${file}: ${(err as Error).message}`);
          }
        }
        const merged = deepMerge(base, patch);
        const finalText = JSON.stringify(merged, null, 2) + "\n";

        const stagedPath = stagedPayloadPath(tx, payloadIndex++);
        await writeText(stagedPath, finalText);
        const expectedHash = hashContent(finalText);

        tx.payloads.push({
          dest: file,
          kind: "json-merge",
          stagedPath,
          isDirectory: false,
          expectedHash,
          journalEntry: {
            file,
            kind: "json-merge",
            preInstallHash: preResult.content === null ? null : hashContent(preResult.content),
            postInstallHash: expectedHash,
            backupContent: preResult.content,
            ownedKeys: Object.keys(action.patch),
          },
        });
      } else if (action.kind === "toml-merge") {
        const file = resolveFileTemplate(action.file, ctx);
        const begin = `# BEGIN anyplugin:${opts.pluginName}`;
        const end = `# END anyplugin:${opts.pluginName}`;
        let text = "";
        try {
          text = await readText(file);
        } catch {
          text = "";
        }
        const stripped = text.includes(begin) ? stripBlock(text, begin, end) : text;
        const toml = substValues(action.append, root) as string;
        const finalText = stripped.trimEnd() + `\n\n${begin}\n${toml.trimEnd()}\n${end}\n`;

        const stagedPath = stagedPayloadPath(tx, payloadIndex++);
        await writeText(stagedPath, finalText);
        const expectedHash = hashContent(finalText);

        tx.payloads.push({
          dest: file,
          kind: "toml-merge",
          stagedPath,
          isDirectory: false,
          expectedHash,
          journalEntry: markerEntry(file, stripped, finalText),
        });
      } else if (action.kind === "md-append") {
        const file = resolveFileTemplate(action.file, ctx);
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

        const stagedPath = stagedPayloadPath(tx, payloadIndex++);
        await writeText(stagedPath, finalText);
        const expectedHash = hashContent(finalText);

        tx.payloads.push({
          dest: file,
          kind: "md-append",
          stagedPath,
          isDirectory: false,
          expectedHash,
          journalEntry: markerEntry(file, stripped, finalText),
        });
      }
    }

    // ── PHASE 3: INTENT ─────────────────────────────────────────────────────
    // Persist what this install is about to change.
    await writeInstallIntent(tx, {
      installationId,
      pluginId: opts.pluginName,
      agent,
      createdAt: Date.now(),
      intentVersion: INTENT_VERSION,
      payloads: tx.payloads.map((p) => ({
        dest: p.dest,
        kind: p.kind,
        isDirectory: p.isDirectory,
        expectedHash: p.expectedHash,
      })),
    });

    // ── PHASE 4: BACKUP ─────────────────────────────────────────────────────
    // Snapshot the current content of every destination before mutating it.
    backups = await backupDestinations(tx, tx.payloads);

    // ── PHASE 5: APPLY ──────────────────────────────────────────────────────
    for (const payload of tx.payloads) {
      const action = destinations.get(payload.dest)?.action;
      if (!action) continue;

      // Re-validate immediately before the write (TOCTOU protection).
      const authorizedRoot = authorizedRootFor(action);
      let classification: DestinationClassification;
      if (action.kind === "copy") {
        classification = await classifyDestination(payload.dest, authorizedRoot, installationId, opts.pluginName, root);
      } else {
        classification = await validateDestinationPath(payload.dest, authorizedRoot);
      }
      if (classification.kind === "CONFLICTING") {
        throw new Error(
          `TOCTOU protection: destination ${payload.dest} became conflicting between preflight and apply: ${classification.reason}`,
        );
      }

      if (payload.isDirectory) {
        // Replace the destination tree with the staged tree.
        await removeTree(payload.dest);
        await copyDir(payload.stagedPath, payload.dest);
        copiedDirs.push(payload.dest);
      } else {
        const content = await readText(payload.stagedPath);
        await writeText(payload.dest, content);
        mergedFiles.push(payload.dest);
      }
      if (payload.journalEntry) journalFiles.push(payload.journalEntry);

      // TEST-ONLY fault injection point (see InstallOptions.__onApplied).
      if (opts.__onApplied) await opts.__onApplied(payload.dest);
    }

    // ── PHASE 6: VERIFY ─────────────────────────────────────────────────────
    // Re-hash every destination and compare against the staged expectations.
    const verification = await verifyAppliedState(tx.payloads);
    if (!verification.ok) {
      const details = verification.mismatches
        .map((m) => `  ${m.dest}: expected ${m.expected}, got ${m.actual}`)
        .join("\n");
      throw new Error(`install aborted — post-install verification failed:\n${details}`);
    }

    // ── PHASE 7: COMMIT ─────────────────────────────────────────────────────
    const journalPath = await writeJournal(root, {
      installationId,
      pluginId: opts.pluginName,
      version: opts.version ?? "0.0.0",
      agent,
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      files: journalFiles,
    });
    notes.push(`state journal: ${journalPath}`);

    // Purge the scratch space only after the journal is durably written.
    await tx.cleanup();
  } catch (err) {
    // ── ROLLBACK ────────────────────────────────────────────────────────────
    // Restore every destination to its pre-install state, then purge staging.
    const rollbackFailures: string[] = [];
    if (backups) {
      rollbackFailures.push(...(await restoreFromBackups(backups)));
    }
    await tx.cleanup();

    if (rollbackFailures.length > 0) {
      throw new Error(
        `install failed and rollback was incomplete:\n` +
          rollbackFailures.map((f) => `  ${f}`).join("\n") +
          `\nOriginal error: ${(err as Error).message}`,
      );
    }
    throw err;
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
    const journalPath = join(root, ".anyplugin-state.json");
    const journalExists = (await pathExists(journalPath)) !== undefined;
    // If journal file exists but couldn't parse, abort (fail-closed)
    if (journalExists && !journal) {
      if (opts.dryRun) {
        return touched.concat(["CONFLICT: .anyplugin-state.json is corrupt — uninstall would abort"]);
      }
      throw new Error(
        `uninstall aborted — ${opts.pluginName}'s state journal is corrupt (cannot parse ${".anyplugin-state.json"}); remove or repair the journal file manually, then re-run install to regenerate it.`,
      );
    }
  } else {
    const journalPath = join(root, ".anyplugin-state.json");
    const journalExists = (await pathExists(journalPath)) !== undefined;
    // If journal file exists but couldn't parse, abort (fail-closed)
    if (journalExists && !journal) {
      if (opts.dryRun) {
        return touched.concat(["CONFLICT: .anyplugin-state.json is corrupt — uninstall would abort"]);
      }
      throw new Error(
        `uninstall aborted — ${opts.pluginName}'s state journal is corrupt (cannot parse ${".anyplugin-state.json"}); remove or repair the journal file manually, then re-run install to regenerate it.`,
      );
    }
  }
  if (journal) {
    // Verify ownership: journal must belong to this plugin
    if (journal.pluginId !== opts.pluginName) {
      throw new Error(
        `uninstall aborted — journal at ${root} belongs to plugin "${journal.pluginId}", not "${opts.pluginName}"`,
      );
    }

    // Phase A: classify every journaled file before modifying anything.
    const statuses: { entry: JournalFileEntry; status: ReturnType<typeof classifyJournalEntry> }[] = [];
    for (const entry of journal.files) {
      statuses.push({ entry, status: classifyJournalEntry(entry, await readCurrentWithError(entry.file)) });
    }
    const conflicts = statuses.filter((s) => s.status.action === "conflict" || s.status.action === "unreadable");
    if (conflicts.length > 0) {
      if (opts.dryRun) {
        for (const c of conflicts) {
          if (c.status.action === "unreadable") {
            touched.push(`CONFLICT: ${c.entry.file} is unreadable (${c.status.error}) — uninstall would abort`);
          } else {
            touched.push(`CONFLICT: ${c.entry.file} was modified after install — uninstall would abort`);
          }
        }
      } else {
        const unreadable = conflicts.filter((c) => c.status.action === "unreadable");
        const modified = conflicts.filter((c) => c.status.action === "conflict");
        const messages: string[] = [];
        if (unreadable.length > 0) {
          messages.push(...unreadable.map((c) => `${c.entry.file} is unreadable (${(c.status as { action: "unreadable"; error: "EACCES" | "EPERM" | "OTHER" }).error})`));
        }
        if (modified.length > 0) {
          messages.push(...modified.map((c) => `${c.entry.file} was modified after install`));
        }
        throw new Error(
          `uninstall aborted — ${opts.pluginName} config has issues:\n` +
          messages.map((m) => `  ${m}`).join("\n") +
          "\nReview those issues, or re-run install to refresh the plugin's state journal, then uninstall again.",
        );
      }
    }
    // Phase B: apply restores only when nothing conflicts.
    for (const { entry, status } of statuses) {
      if (opts.dryRun) {
        switch (status.action) {
          case "restore":
            touched.push(`would restore ${entry.file} to pre-install content`);
            break;
          case "delete":
            touched.push(`would delete ${entry.file} (created by install)`);
            break;
          case "missing":
            touched.push(`note: ${entry.file} already deleted by user`);
            break;
          case "unreadable":
            touched.push(`note: ${entry.file} is unreadable (${status.error as "EACCES" | "EPERM" | "OTHER"})`);
            break;
        }
      } else if (status.action !== "conflict" && status.action !== "unreadable") {
        if (await applyJournalEntry(entry, status)) touched.push(entry.file);
      }
    }
    // Copies: only remove files/directories explicitly tracked in the journal.
    // For copy entries, we track the specific files that were copied.
    // Remove only the managed files, then remove empty directories bottom-up.
    const copyEntries = journal.files.filter((e) => e.kind === "copy");
    for (const entry of copyEntries) {
      const destDir = entry.file;
      const managedFiles = entry.copiedFiles ?? [];
      
      // Remove managed files in reverse order (deepest first)
      for (const relPath of [...managedFiles].sort((a, b) => b.length - a.length)) {
        const filePath = join(destDir, relPath);
        if (await pathExists(filePath)) {
          if (opts.dryRun) {
            touched.push(`would remove ${filePath}`);
          } else {
            try {
              await removeTree(filePath);
              touched.push(filePath);
            } catch {
              // File might be a directory or already gone
            }
          }
        }
      }
      
      // Remove the journal file itself (it's in the plugin root copy) BEFORE
      // cleaning up empty directories, so the parent directory can be removed.
      const journalFile = join(root, ".anyplugin-state.json");
      if (await pathExists(journalFile)) {
        if (opts.dryRun) {
          touched.push(`would remove ${journalFile}`);
        } else {
          try {
            await removeTree(journalFile);
            touched.push(journalFile);
          } catch {
            // Already gone
          }
        }
      }
      
      // After removing managed files and journal, remove empty directories bottom-up
      // but only if they're empty (contain no unmanaged content)
      if (!opts.dryRun) {
        await removeEmptyManagedDirs(destDir, touched);
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
          // In legacy mode, we still shouldn't blindly remove unmanaged content.
          // Only remove if the directory appears to be entirely managed (no extra files).
          const isManaged = await isLikelyManaged(dest, bundle, agent, ctx, opts.pluginName);
          if (isManaged) {
            await removeTree(dest);
            touched.push(dest);
          } else {
            touched.push(`SKIPPED: ${dest} contains unmanaged content — refusing to remove`);
          }
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

/** Recursively remove empty directories that were part of the managed copy. */
async function removeEmptyManagedDirs(dir: string, touched: string[]): Promise<void> {
  try {
    const entries = await readdir(dir);
    // Recursively process subdirectories first
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      const stat = await lstat(entryPath);
      if (stat.isDirectory()) {
        await removeEmptyManagedDirs(entryPath, touched);
      }
    }
    // After processing children, check if this directory is now empty
    const remaining = await readdir(dir);
    if (remaining.length === 0) {
      await removeTree(dir);
      touched.push(dir);
    }
  } catch {
    // Directory might not exist or be unreadable
  }
}

/** Heuristic: check if a destination directory appears to be entirely managed by this plugin. */
async function isLikelyManaged(dest: string, bundle: EmittedBundle, agent: AgentId, ctx: { home: string; projectDir: string; codexHome: string }, pluginName: string): Promise<boolean> {
  try {
    const entries = await readdir(dest);
    // If directory is empty, it's likely managed
    if (entries.length === 0) return true;
    
    // Check if all entries are known managed files/dirs from the bundle
    const managedPaths = new Set<string>();
    for (const action of bundle.install.actions) {
      if (action.kind === "copy") {
        const srcRel = validateRelPath(action.srcRel, `${agent} copy srcRel`);
        if (srcRel === ".") {
          // Root copy - all files in bundle are managed
          const bundleEntries = await readdir(join(bundle.dir, srcRel));
          for (const e of bundleEntries) managedPaths.add(e);
        } else {
          const bundleEntries = await readdir(join(bundle.dir, srcRel));
          for (const e of bundleEntries) managedPaths.add(e);
        }
      }
    }
    
    // If all entries in dest are in managedPaths, it's likely fully managed
    for (const entry of entries) {
      if (!managedPaths.has(entry)) {
        return false; // Unmanaged content present
      }
    }
    return true;
  } catch {
    return false;
  }
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
export async function loadPluginSafe(pluginRoot: string): Promise<{ name: string; version: string }> {
  const manifest = await loadPluginManifest(pluginRoot);
  return { name: manifest.name, version: manifest.version };
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
    installationId: generateInstallationId(),
    pluginId: plugin.name,
    version: plugin.version,
    agent: "instruction",
    schemaVersion: JOURNAL_SCHEMA_VERSION,
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
    statuses.push({ entry, status: classifyJournalEntry(entry, await readCurrentWithError(entry.file)) });
  }
  const conflicts = statuses.filter((s) => s.status.action === "conflict" || s.status.action === "unreadable");
  if (conflicts.length > 0) {
    if (opts.dryRun) {
      for (const c of conflicts) {
        if (c.status.action === "unreadable") {
          touched.push(`CONFLICT: ${c.entry.file} is unreadable (${c.status.error}) — uninstall would abort`);
        } else {
          touched.push(`CONFLICT: ${c.entry.file} was modified after install — uninstall would abort`);
        }
      }
    } else {
      const unreadable = conflicts.filter((c) => c.status.action === "unreadable");
      const modified = conflicts.filter((c) => c.status.action === "conflict");
      const messages: string[] = [];
      if (unreadable.length > 0) {
        messages.push(...unreadable.map((c) => `${c.entry.file} is unreadable (${(c.status as { action: "unreadable"; error: "EACCES" | "EPERM" | "OTHER" }).error})`));
      }
      if (modified.length > 0) {
        messages.push(...modified.map((c) => `${c.entry.file} was modified after install`));
      }
      throw new Error(
        `uninstall aborted — ${plugin.name} instructions have issues:\n` +
        messages.map((m) => `  ${m}`).join("\n") +
        "\nReview those issues, or re-run install to refresh the journal, then uninstall again.",
      );
    }
  }
  for (const { entry, status } of statuses) {
    if (opts.dryRun) {
      switch (status.action) {
        case "restore":
          touched.push(`would restore ${entry.file} to pre-install content`);
          break;
        case "delete":
          touched.push(`would delete ${entry.file} (created by install)`);
          break;
        case "missing":
          touched.push(`note: ${entry.file} already deleted by user`);
          break;
        case "unreadable":
          touched.push(`note: ${entry.file} is unreadable (${status.error as "EACCES" | "EPERM" | "OTHER"})`);
          break;
      }
    } else if (status.action !== "conflict" && status.action !== "unreadable") {
      if (await applyJournalEntry(entry, status)) touched.push(entry.file);
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

export {
  loadPluginManifest,
  detectAgent,
  detectInstalledAgents,
  detectEnvironment,
  validateBundle,
  regenerateIndexes,
  readJournal,
  writeJournal,
};
export type { InstallPlan };
