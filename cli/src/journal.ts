import { createHash } from "node:crypto";
import { join } from "node:path";
import { readText, writeText, removeTree } from "@lablaunchpad/core";

/**
 * Transactional install state. Every config file an installer touches is
 * journaled with its pre-install content (backup), pre/post hashes, and — for
 * JSON merges — the top-level keys the plugin owns. Uninstall uses the journal
 * to restore the exact pre-install bytes, and REFUSES (instead of
 * overwriting) when the user edited a file after install.
 */
export const JOURNAL_BASENAME = ".anyplugin-state.json";

export interface JournalFileEntry {
  /** Absolute path of the journaled config file. */
  file: string;
  kind: "marker" | "json-merge";
  /** sha256 of the pre-install content; null = the file did not exist. */
  preInstallHash: string | null;
  /** sha256 of the content as this install left it. */
  postInstallHash: string;
  /** Exact pre-install content (null = file did not exist). */
  backupContent: string | null;
  /** Top-level keys owned by the plugin (json-merge only). */
  ownedKeys: string[] | null;
}

export interface InstallJournal {
  pluginId: string;
  version: string;
  agent: string;
  files: JournalFileEntry[];
}

export function hashContent(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Current content of a file, or null when it does not exist / is unreadable. */
export async function readCurrent(file: string): Promise<string | null> {
  try {
    return await readText(file);
  } catch {
    return null;
  }
}

export async function readJournal(root: string): Promise<InstallJournal | null> {
  try {
    return JSON.parse(await readText(join(root, JOURNAL_BASENAME))) as InstallJournal;
  } catch {
    return null;
  }
}

export async function writeJournal(root: string, journal: InstallJournal): Promise<string> {
  const path = join(root, JOURNAL_BASENAME);
  await writeText(path, JSON.stringify(journal, null, 2) + "\n");
  return path;
}

export type JournalEntryStatus =
  | { action: "restore"; current: string }
  | { action: "delete" }
  | { action: "conflict"; current: string }
  | { action: "already-restored" }
  | { action: "missing" };

/**
 * Classify a journaled file against its current on-disk content:
 * - hash == postInstallHash → untouched since install → restore backup / delete
 * - hash == preInstallHash  → plugin content already removed by the user → nothing to do
 * - anything else           → the user modified it after install → conflict, abort
 */
export function classifyJournalEntry(entry: JournalFileEntry, current: string | null): JournalEntryStatus {
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
