import { createHash } from "node:crypto";
import { join } from "node:path";
import { readText, writeText, removeTree, jsonStable } from "@lablaunchpad/core";
import { readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { z } from "zod";

/**
 * Transactional install state. Every config file an installer touches is
 * journaled with its pre-install content (backup), pre/post hashes, and — for
 * JSON merges — the top-level keys the plugin owns. Uninstall uses the journal
 * to restore the exact pre-install bytes, and REFUSES (instead of
 * overwriting) when the user edited a file after install.
 * 
 * Installation ID (ULID) proves ownership — a matching plugin name is NOT ownership.
 * Copied directories are tracked as managed entries so uninstall removes ONLY what was installed.
 */
export const JOURNAL_BASENAME = ".anyplugin-state.json";

export interface JournalFileEntry {
  /** Absolute path of the journaled config file. */
  file: string;
  kind: "marker" | "json-merge" | "copy";
  /** sha256 of the pre-install content; null = the file did not exist. */
  preInstallHash: string | null;
  /** sha256 of the content as this install left it. */
  postInstallHash: string;
  /** Exact pre-install content (null = file did not exist). */
  backupContent: string | null;
  /** Top-level keys owned by the plugin (json-merge only). */
  ownedKeys: string[] | null;
  /** For copy operations: relative paths of files under the copied directory. */
  copiedFiles?: string[];
}

/** Current journal schema version. Increment when structure changes. */
export const JOURNAL_SCHEMA_VERSION = 1;

export interface InstallJournal {
  /** Unique installation ID (ULID) — one per install invocation, newest wins. */
  installationId: string;
  pluginId: string;
  version: string;
  agent: string;
  /** Schema version of this journal. Used for migration. */
  schemaVersion: number;
  files: JournalFileEntry[];
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Zod schema for strict journal validation. */
export const JournalFileEntrySchema = z.object({
  file: z.string(),
  kind: z.enum(["marker", "json-merge", "copy"]),
  preInstallHash: z.string().nullable(),
  postInstallHash: z.string(),
  backupContent: z.string().nullable(),
  ownedKeys: z.array(z.string()).nullable(),
  copiedFiles: z.array(z.string()).optional(),
});

export const InstallJournalSchema = z.object({
  installationId: z.string().min(1),
  pluginId: z.string().min(1),
  version: z.string().default("0.0.0"),
  agent: z.string().min(1),
  schemaVersion: z.number().int().positive().default(JOURNAL_SCHEMA_VERSION),
  files: z.array(JournalFileEntrySchema),
});

/** Compute SHA256 checksums of all files under a directory root. */
export async function generateEvidence(root: string): Promise<Record<string, { hash: string }>> {
  const evidence: Record<string, { hash: string }> = {};
  const entries = await readdir(root);
  for (const name of entries) {
    const filePath = join(root, name);
    try {
      const stat = await lstat(filePath);
      if (stat.isFile()) {
        const content = await readText(filePath);
        evidence[name] = { hash: hashContent(content) };
      }
    } catch {
      // Skip unreadable files
    }
  }
  return evidence;
}

/** Append an operation entry to the journal ledger. */
export async function appendLedger(root: string, plugin: string, version: string, operation: "install" | "uninstall", success: boolean): Promise<void> {
  const ledgerPath = join(root, "ledger.jsonl");
  const entry = { plugin, version, operation, success, timestamp: Date.now() };
  const entryLine = jsonStable(entry) + "\n";
  try {
    const existing = await readFile(ledgerPath, "utf8").catch(() => "");
    await writeFile(ledgerPath, existing + entryLine);
  } catch {
    // If ledger doesn't exist, create it with this entry
    await writeFile(ledgerPath, entryLine);
  }
}

/** Result of reading a file, distinguishing between missing and unreadable. */
export interface ReadResult {
  content: string | null;
  error?: "ENOENT" | "EACCES" | "EPERM" | "OTHER";
}

/** Read a file, distinguishing between missing (ENOENT) and unreadable (EACCES/EPERM/OTHER). */
export async function readCurrentWithError(file: string): Promise<ReadResult> {
  try {
    return { content: await readText(file), error: undefined };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { content: null, error: "ENOENT" };
    if (code === "EACCES") return { content: null, error: "EACCES" };
    if (code === "EPERM") return { content: null, error: "EPERM" };
    return { content: null, error: "OTHER" };
  }
}

/** Migrate a raw journal object to the current schema version. */
export function migrateJournal(raw: unknown): InstallJournal {
  if (!raw || typeof raw !== "object") {
    throw new Error("journal is not an object");
  }
  const obj = raw as Record<string, unknown>;
  
  // If schemaVersion is present and matches current, validate directly
  if (obj.schemaVersion === JOURNAL_SCHEMA_VERSION) {
    const result = InstallJournalSchema.safeParse(obj);
    if (!result.success) {
      throw new Error(`invalid journal (v${JOURNAL_SCHEMA_VERSION}): ${result.error.issues.map(i => i.message).join("; ")}`);
    }
    return result.data;
  }
  
  // Legacy journal (pre-schemaVersion) — infer v1 structure
  if (obj.schemaVersion === undefined) {
    // Validate required fields exist
    if (!obj.installationId || !obj.pluginId || !obj.agent || !Array.isArray(obj.files)) {
      throw new Error("legacy journal missing required fields (installationId, pluginId, agent, files)");
    }
    
    // Normalize files array to ensure all required fields
    const files = (obj.files as unknown[]).map((f: unknown) => {
      if (!f || typeof f !== "object") throw new Error("journal file entry is not an object");
      const fe = f as Record<string, unknown>;
      const kind = fe.kind;
      const validKind = (kind === "copy" || kind === "json-merge" || kind === "marker") ? kind : "marker";
      return {
        file: String(fe.file ?? ""),
        kind: validKind,
        preInstallHash: fe.preInstallHash ?? null,
        postInstallHash: String(fe.postInstallHash ?? ""),
        backupContent: fe.backupContent ?? null,
        ownedKeys: Array.isArray(fe.ownedKeys) ? fe.ownedKeys.map(String) : null,
        copiedFiles: Array.isArray(fe.copiedFiles) ? fe.copiedFiles.map(String) : undefined,
      } as JournalFileEntry;
    });
    
    const migrated: InstallJournal = {
      installationId: String(obj.installationId),
      pluginId: String(obj.pluginId),
      version: String(obj.version ?? "0.0.0"),
      agent: String(obj.agent),
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      files,
    };
    
    // Validate migrated structure
    const result = InstallJournalSchema.safeParse(migrated);
    if (!result.success) {
      throw new Error(`migrated journal invalid: ${result.error.issues.map(i => i.message).join("; ")}`);
    }
    return result.data;
  }
  
  // Future schema version — fail closed (don't attempt forward migration)
  throw new Error(`unsupported journal schema version: ${obj.schemaVersion} (current: ${JOURNAL_SCHEMA_VERSION})`);
}

/** Read and strictly validate an install journal. Returns null on ENOENT; throws on corrupt/invalid. */
export async function readJournal(root: string): Promise<InstallJournal | null> {
  try {
    const text = await readText(join(root, JOURNAL_BASENAME));
    const parsed = JSON.parse(text);
    return migrateJournal(parsed);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null; // No journal — absent, not corrupt
    }
    // Re-throw validation errors and other I/O errors
    throw err;
  }
}

export async function writeJournal(root: string, journal: InstallJournal): Promise<string> {
  // Ensure schemaVersion is set
  const journalWithVersion = {
    ...journal,
    schemaVersion: JOURNAL_SCHEMA_VERSION,
  };
  // Validate before writing
  const result = InstallJournalSchema.safeParse(journalWithVersion);
  if (!result.success) {
    throw new Error(`invalid journal data: ${result.error.issues.map(i => i.message).join("; ")}`);
  }
  const path = join(root, JOURNAL_BASENAME);
  await writeText(path, JSON.stringify(journalWithVersion, null, 2) + "\n");
  return path;
}

/* ── Transactional install primitives ───────────────────────────────────────
 * Staging, backup, rollback and verification live in ./transaction.ts.
 * This module owns journal format + migration only.
 */


export type JournalEntryStatus =
  | { action: "restore"; current: string }
  | { action: "delete" }
  | { action: "conflict"; current: string }
  | { action: "already-restored" }
  | { action: "missing" }
  | { action: "unreadable"; error: "EACCES" | "EPERM" | "OTHER" };

/**
 * Classify a journaled file against its current on-disk content:
 * - hash == postInstallHash → untouched since install → restore backup / delete
 * - hash == preInstallHash  → plugin content already removed by the user → nothing to do
 * - anything else           → the user modified it after install → conflict, abort
 * - unreadable (EACCES/EPERM) → cannot determine state, treat as conflict (fail-closed)
 * - copy entries (directories) → ownership proven by installationId, skip content check
 */
export function classifyJournalEntry(entry: JournalFileEntry, result: ReadResult): JournalEntryStatus {
  // Skip content check for copy entries (directories) - ownership proven by installationId
  if (entry.kind === "copy") {
    return { action: "missing" }; // Treat as "missing" for restore purposes; uninstall uses copiedFiles list
  }
  
  if (result.error === "ENOENT") return { action: "missing" };
  if (result.error === "EACCES" || result.error === "EPERM" || result.error === "OTHER") {
    return { action: "unreadable", error: result.error };
  }
  const current = result.content;
  if (current === null) return { action: "missing" };
  const h = hashContent(current);
  if (h === entry.postInstallHash) {
    return entry.backupContent === null ? { action: "delete" } : { action: "restore", current };
  }
  if (entry.preInstallHash !== null && h === entry.preInstallHash) return { action: "already-restored" };
  return { action: "conflict", current };
}

/** Apply one journaled entry (only valid for non-conflicting statuses). */
export async function applyJournalEntry(entry: JournalFileEntry, status: JournalEntryStatus): Promise<boolean> {
  if (status.action === "restore") {
    await writeText(entry.file, entry.backupContent ?? "");
    return true;
  }
  if (status.action === "delete") {
    await removeTree(entry.file);
    return true;
  }
  return false;
}
