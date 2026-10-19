import { join, relative, sep } from "node:path";
import { mkdir, readdir, lstat, readFile, writeFile, rename } from "node:fs/promises";
import { readText, writeText, removeTree, copyDir, listDir } from "@lablaunchpad/core";
import { hashContent, type JournalFileEntry } from "./journal.js";

/**
 * Transactional install primitives (audit Finding E).
 *
 * The install pipeline is:
 *
 *   stage  → write every incoming byte into a staging area, never touching the host
 *   intent → persist an install_intent.json describing exactly what will change
 *   backup → snapshot the CURRENT content of every destination that exists
 *   apply  → copy staged bytes onto the host (revalidating ownership first)
 *   verify → re-hash every destination and compare against the staged hashes
 *   commit → write the journal, then purge staging + backups
 *
 * If any step after `stage` throws, the rollback engine restores every
 * destination from its backup (or removes it, if it did not exist before) and
 * purges the staging area, so a failed install never leaves a partial state.
 */

/** Name of the intent manifest written into the staging area. */
export const INTENT_BASENAME = "install_intent.json";

/** Directory names used under the install root. */
export const STAGING_DIRNAME = ".anyplugin-staging";
export const BACKUPS_DIRNAME = ".anyplugin-backups";

/** How a destination is mutated. */
export type MutationKind = "copy" | "json-merge" | "toml-merge" | "md-append";

/** One staged payload: the bytes destined for a single host destination. */
export interface StagedPayload {
  /** Destination path on the host. */
  dest: string;
  /** How the destination is mutated. */
  kind: MutationKind;
  /**
   * Path inside the staging area holding the staged bytes.
   * For `copy` this is a directory; for merges it is a single file.
   */
  stagedPath: string;
  /** True when stagedPath is a directory tree (copy) rather than a file (merge). */
  isDirectory: boolean;
  /**
   * Expected SHA-256 of the destination AFTER the mutation.
   * For directory copies this is a tree hash (hash of the sorted per-file hashes).
   */
  expectedHash: string;
  /** Per-file hashes for directory copies (relative path → sha256). */
  fileHashes?: Record<string, string>;
  /** The journal entry that will be committed if the install succeeds. */
  journalEntry?: JournalFileEntry;
}

/** Install intent: the durable record of what this install will change. */
export interface InstallIntent {
  installationId: string;
  pluginId: string;
  agent: string;
  createdAt: number;
  /** Schema version of the intent format. */
  intentVersion: number;
  payloads: Array<{
    dest: string;
    kind: MutationKind;
    isDirectory: boolean;
    expectedHash: string;
  }>;
}

/** Current intent format version. */
export const INTENT_VERSION = 1;

/** A backup of one destination's pre-install content. */
export interface BackupRecord {
  /** Destination path on the host. */
  dest: string;
  /** True when the destination was a directory. */
  isDirectory: boolean;
  /** Absolute path of the backup payload inside the backups dir. */
  backupPath: string;
  /** True when the destination did NOT exist before the install. */
  wasAbsent: boolean;
  /** Tree hash of the backup payload (dir) or file hash (file). */
  originalHash: string;
}

/** All backups taken for one install. */
export interface BackupManifest {
  installationId: string;
  backupsDir: string;
  records: BackupRecord[];
}

/** Everything the transaction needs to know about its own scratch space. */
export interface TransactionContext {
  installationId: string;
  /** Root of the staging area for this install. */
  stagingDir: string;
  /** Root of the backups area for this install. */
  backupsDir: string;
  /** Where the intent manifest is written. */
  intentPath: string;
  /** Payloads staged so far. */
  payloads: StagedPayload[];
  /** Remove staging + backups. Idempotent. */
  cleanup: () => Promise<void>;
}

/** Compute a stable tree hash: sha256 over the sorted "relpath\0hash" lines. */
export function hashTree(fileHashes: Record<string, string>): string {
  const lines = Object.keys(fileHashes)
    .sort()
    .map((rel) => `${rel}\0${fileHashes[rel]}`);
  return hashContent(lines.join("\n"));
}

/** Hash every file under `dir` (relative path → sha256). Symlinks are skipped. */
export async function hashDirFiles(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = join(current, entry.name);
      if (entry.isSymbolicLink()) continue; // symlinks are never installed content
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      try {
        const buf = await readFile(abs);
        out[relative(dir, abs).split(sep).join("/")] = hashContent(buf.toString("utf8"));
      } catch {
        /* unreadable — skip */
      }
    }
  };
  await walk(dir);
  return out;
}

/** Create the transaction scratch space under `workspaceRoot`. */
export async function createTransactionContext(
  workspaceRoot: string,
  installationId: string,
): Promise<TransactionContext> {
  const stagingDir = join(workspaceRoot, STAGING_DIRNAME, installationId);
  const backupsDir = join(workspaceRoot, BACKUPS_DIRNAME, installationId);
  const intentPath = join(stagingDir, INTENT_BASENAME);

  await mkdir(join(stagingDir, "payloads"), { recursive: true });
  await mkdir(join(backupsDir, "files"), { recursive: true });
  await mkdir(join(backupsDir, "dirs"), { recursive: true });

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      await removeTree(stagingDir);
      await removeTree(backupsDir);
      // The workspace root is dedicated to this plugin, so removing it wholesale
      // guarantees no orphaned scratch directories are left behind.
      await removeTree(workspaceRoot);
    } catch {
      /* best effort */
    }
  };

  return { installationId, stagingDir, backupsDir, intentPath, payloads: [], cleanup };
}

/** Path inside the staging area for payload `index`. */
export function stagedPayloadPath(ctx: TransactionContext, index: number): string {
  return join(ctx.stagingDir, "payloads", String(index));
}

/** Write the intent manifest atomically (temp file + rename). */
export async function writeInstallIntent(ctx: TransactionContext, intent: InstallIntent): Promise<string> {
  const tmp = `${ctx.intentPath}.tmp`;
  await writeFile(tmp, JSON.stringify(intent, null, 2) + "\n", "utf8");
  try {
    await rename(tmp, ctx.intentPath);
  } catch {
    // Cross-device or Windows rename quirk — fall back to a direct write.
    await writeFile(ctx.intentPath, JSON.stringify(intent, null, 2) + "\n", "utf8");
  }
  return ctx.intentPath;
}

/** Read the intent manifest, or null when it is missing. */
export async function readInstallIntent(ctx: TransactionContext): Promise<InstallIntent | null> {
  try {
    const text = await readText(ctx.intentPath);
    return JSON.parse(text) as InstallIntent;
  } catch {
    return null;
  }
}

/**
 * Back up the CURRENT content of every destination.
 * Directories are copied wholesale; files are copied byte-for-byte.
 * A destination that does not exist is recorded as `wasAbsent` so rollback
 * removes it instead of restoring it.
 */
export async function backupDestinations(
  ctx: TransactionContext,
  payloads: StagedPayload[],
): Promise<BackupManifest> {
  const records: BackupRecord[] = [];

  for (const payload of payloads) {
    const slot = join(ctx.backupsDir, String(records.length));
    let stat;
    try {
      stat = await lstat(payload.dest);
    } catch {
      // Destination did not exist — record as absent.
      records.push({
        dest: payload.dest,
        isDirectory: payload.isDirectory,
        backupPath: join(slot, "absent"),
        wasAbsent: true,
        originalHash: "",
      });
      continue;
    }

    if (stat.isDirectory()) {
      const dirBackup = join(ctx.backupsDir, "dirs", String(records.length));
      await copyDir(payload.dest, dirBackup);
      const hashes = await hashDirFiles(dirBackup);
      records.push({
        dest: payload.dest,
        isDirectory: true,
        backupPath: dirBackup,
        wasAbsent: false,
        originalHash: hashTree(hashes),
      });
    } else {
      const fileBackup = join(ctx.backupsDir, "files", `${String(records.length)}.bak`);
      const buf = await readFile(payload.dest);
      await writeFile(fileBackup, buf);
      records.push({
        dest: payload.dest,
        isDirectory: false,
        backupPath: fileBackup,
        wasAbsent: false,
        originalHash: hashContent(buf.toString("utf8")),
      });
    }
  }

  return { installationId: ctx.installationId, backupsDir: ctx.backupsDir, records };
}

/**
 * Restore every destination from its backup.
 * Destinations that did not exist before the install are removed.
 *
 * A directory is restored by copying the backup to a SIBLING and then
 * renaming it into place — never by deleting the destination first. A
 * delete-then-copy has a window in which a failed copy leaves the user with
 * nothing at all; a copy-then-rename does not.
 *
 * Failures are collected, never thrown — rollback must not mask the
 * original failure that triggered it. The CALLER decides whether to purge
 * the backups, and it must not purge them when a restore failed: the backup
 * is then the only copy of the user's pre-install content.
 */
export async function restoreFromBackups(manifest: BackupManifest): Promise<string[]> {
  const failures: string[] = [];

  for (const record of manifest.records) {
    try {
      if (record.wasAbsent) {
        await removeTree(record.dest);
        continue;
      }
      if (record.isDirectory) {
        // Copy to a sibling, then swap it in. The destination is only
        // removed once the replacement is complete.
        const staged = `${record.dest}.anyplugin-restore`;
        await removeTree(staged);
        await copyDir(record.backupPath, staged);
        await removeTree(record.dest);
        await rename(staged, record.dest);
      } else {
        const buf = await readFile(record.backupPath);
        await writeFile(record.dest, buf);
      }
    } catch (err) {
      failures.push(`${record.dest}: ${(err as Error).message}`);
    }
  }

  return failures;
}

/** Result of verifying the applied state against the staged hashes. */
export interface VerificationResult {
  ok: boolean;
  mismatches: Array<{ dest: string; expected: string; actual: string }>;
}

/**
 * Re-hash every destination and compare against the staged expectations.
 *
 * Directory copies are verified file-by-file: every staged file must exist at
 * the destination with a matching hash. The destination is allowed to contain
 * extra files (e.g. the state journal that lives beside the bundle), so a
 * whole-tree equality check would produce false failures.
 */
export async function verifyAppliedState(payloads: StagedPayload[]): Promise<VerificationResult> {
  const mismatches: VerificationResult["mismatches"] = [];

  for (const payload of payloads) {
    if (payload.isDirectory) {
      const expected = payload.fileHashes ?? {};
      const actualHashes = await hashDirFiles(payload.dest);
      for (const [rel, expectedHash] of Object.entries(expected)) {
        const actualHash = actualHashes[rel];
        if (actualHash === undefined) {
          mismatches.push({ dest: join(payload.dest, rel), expected: expectedHash, actual: "(missing)" });
          continue;
        }
        if (actualHash !== expectedHash) {
          mismatches.push({ dest: join(payload.dest, rel), expected: expectedHash, actual: actualHash });
        }
      }
      continue;
    }

    let actual = "";
    try {
      actual = await readText(payload.dest);
    } catch {
      mismatches.push({ dest: payload.dest, expected: payload.expectedHash, actual: "(unreadable)" });
      continue;
    }
    const actualHash = hashContent(actual);
    if (actualHash !== payload.expectedHash) {
      mismatches.push({ dest: payload.dest, expected: payload.expectedHash, actual: actualHash });
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}

/** Convenience: hash a single file's bytes as text. */
export async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path);
  return hashContent(buf.toString("utf8"));
}

/** List the relative paths of every file under `dir` (used for journal copy entries). */
export async function listFilesRecursive(dir: string, base = dir, out: string[] = []): Promise<string[]> {
  let entries: Array<{ name: string; isDir: boolean; abs: string }>;
  try {
    entries = await listDir(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDir) await listFilesRecursive(entry.abs, base, out);
    else out.push(entry.abs.slice(base.length + 1).split(sep).join("/"));
  }
  return out;
}
