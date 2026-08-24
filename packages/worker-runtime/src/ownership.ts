/**
 * Write ownership — the single chokepoint through which every kernel mutation
 * must pass, established BEFORE the kernel has any mutations to guard.
 *
 * The order is deliberate. A boundary added after the code it constrains has to
 * argue with existing call sites, and it loses: each violation arrives with a
 * reason it is the exception. A boundary that exists first is simply the way
 * writing is done. `storage.ts` declares *where* kernel state lives; this file
 * decides *whether a given mutation is allowed at all*, and is the place the
 * SafePath question returns if M2 ever accepts a caller-supplied path.
 *
 * The failure this prevents is specific and has already nearly happened once.
 * AnyPlugin's installer journals every destination it writes and restores it to
 * pre-install bytes on uninstall. If the kernel's ledger ever sat inside a
 * journaled destination, `anyplugin uninstall` would revert or delete the
 * authoritative evidence store — silently, and with a clean exit code. The
 * kernel would then be a control plane whose own state needs reconciling.
 *
 * Ownership is expressed as two disjoint sets, never as one list with
 * exceptions:
 *
 *   KERNEL-OWNED   `.worker-runtime/**` — the kernel is the only writer.
 *   FOREIGN-OWNED  AnyPlugin's journal, mode flag, agent configs, OKF bundle.
 *                  The kernel does not write these. Not "should not" — the
 *                  predicate refuses.
 *
 * Anything in neither set is refused too. Defaulting to allowed is how a
 * boundary erodes: it makes every new path a silent grant.
 */
import { STORAGE_ROOT_DIRNAME, STORAGE_SUBDIRS, isForeignOwned, isKernelOwned } from "./storage.js";

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnershipError";
  }
}

/**
 * Storage subdirectories holding AUTHORITATIVE state: the record of what
 * happened. Append-mostly, never rewritten to reflect a newer opinion. A
 * contradiction supersedes an earlier record with provenance; it does not erase
 * it.
 */
export const AUTHORITATIVE_SUBDIRS = ["contracts", "events", "evidence", "decisions", "experience", "certificates"] as const;

/**
 * Storage subdirectories holding DERIVED state: indexes, caches, materialised
 * views. Every byte here must be reconstructible from the authoritative
 * subdirectories alone.
 *
 * This is the R7 boundary, and it is load-bearing rather than tidy-minded. The
 * moment a derived store holds something that cannot be rebuilt, it has quietly
 * become a second source of truth — and the two sources will disagree, because
 * that is what two sources of truth do. Deleting the whole derived directory
 * must always be a safe, recoverable operation.
 */
export const DERIVED_SUBDIRS = ["graph"] as const;

/** Every subdirectory is exactly one of authoritative or derived — never both, never neither. */
export function classifySubdir(sub: string): "AUTHORITATIVE" | "DERIVED" | "UNKNOWN" {
  if ((AUTHORITATIVE_SUBDIRS as readonly string[]).includes(sub)) return "AUTHORITATIVE";
  if ((DERIVED_SUBDIRS as readonly string[]).includes(sub)) return "DERIVED";
  return "UNKNOWN";
}

/** Normalize to forward slashes so one path has one spelling on every platform. */
function normalize(relPath: string): string {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Reasons a path may be refused. Enumerated so a refusal can be tested for its
 * actual cause: a test that only checks "it threw" would still pass if the
 * traversal check were removed and the ownership check happened to catch it.
 */
export type RefusalReason =
  | "absolute path"
  | "path traversal"
  | "foreign-owned"
  | "outside kernel storage"
  | "unknown subdirectory";

export interface OwnershipVerdict {
  readonly allowed: boolean;
  readonly reason?: RefusalReason;
}

/**
 * Decide whether the kernel may create or modify `relPath`, interpreted
 * relative to the workspace root.
 *
 * Ordered most-hostile-first so a refusal names the real problem. A traversing
 * path that also lands outside kernel storage should be reported as traversal,
 * because that is the fact worth acting on.
 */
export function checkWritable(relPath: string): OwnershipVerdict {
  const p = normalize(relPath);

  // Absolute paths are refused outright rather than resolved. Resolving them
  // would mean deciding what they resolve *to*, and every path-confusion bug
  // starts with that decision.
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.startsWith("//")) {
    return { allowed: false, reason: "absolute path" };
  }
  // Segment-wise, not substring: a file legitimately named `..foo` is fine.
  if (p.split("/").some((seg) => seg === "..")) {
    return { allowed: false, reason: "path traversal" };
  }
  if (isForeignOwned(p)) return { allowed: false, reason: "foreign-owned" };
  if (!isKernelOwned(p)) return { allowed: false, reason: "outside kernel storage" };

  // Inside the storage root, but is it a subdirectory the kernel declared? An
  // undeclared one is a hidden writer: state nobody reviewed and nothing
  // rebuilds.
  const rest = p === STORAGE_ROOT_DIRNAME ? "" : p.slice(STORAGE_ROOT_DIRNAME.length + 1);
  if (rest === "") return { allowed: true }; // the root itself, for mkdir
  const sub = rest.split("/")[0]!;
  if (!(STORAGE_SUBDIRS as readonly string[]).includes(sub)) {
    return { allowed: false, reason: "unknown subdirectory" };
  }
  return { allowed: true };
}

/** `checkWritable`, as an assertion. The form M2 write paths call. */
export function assertWritable(relPath: string): void {
  const verdict = checkWritable(relPath);
  if (!verdict.allowed) {
    throw new OwnershipError(`kernel may not write ${relPath}: ${verdict.reason}`);
  }
}

/**
 * Decide whether the kernel may DELETE `relPath`.
 *
 * Strictly narrower than writing, because the blast radius is different: a bad
 * write damages one record and is detectable by replay, while a bad delete
 * removes the evidence that it happened. Authoritative records are therefore
 * not deletable at all — supersession is how the ledger changes its mind, and
 * it preserves history by construction. Only derived state may be removed,
 * which is safe precisely because it can be rebuilt.
 */
export function checkDeletable(relPath: string): OwnershipVerdict & { readonly authoritative?: boolean } {
  const verdict = checkWritable(relPath);
  if (!verdict.allowed) return verdict;

  const p = normalize(relPath);
  if (p === STORAGE_ROOT_DIRNAME) {
    // Deleting the root would take the authoritative ledger with it.
    return { allowed: false, reason: "outside kernel storage", authoritative: true };
  }
  const sub = p.slice(STORAGE_ROOT_DIRNAME.length + 1).split("/")[0]!;
  if (classifySubdir(sub) !== "DERIVED") {
    return { allowed: false, reason: "outside kernel storage", authoritative: true };
  }
  return { allowed: true };
}

/** `checkDeletable`, as an assertion. */
export function assertDeletable(relPath: string): void {
  const verdict = checkDeletable(relPath);
  if (!verdict.allowed) {
    const why = verdict.authoritative ? "authoritative state is superseded, never deleted" : verdict.reason;
    throw new OwnershipError(`kernel may not delete ${relPath}: ${why}`);
  }
}

/**
 * Modules permitted to call filesystem mutation APIs directly.
 *
 * Everything else must route through this file. The list is short on purpose
 * and every entry states why it is exempt — an exemption without a reason is
 * how the chokepoint stops being one.
 */
export const DIRECT_FS_WRITERS: ReadonlyArray<{ readonly module: string; readonly why: string }> = [
  {
    module: "log/candidates.ts",
    why: "F10 evaluation harness: candidate mechanisms under measurement, not the kernel's write path. Writes only into caller-supplied temporary directories.",
  },
];
