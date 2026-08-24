/**
 * Storage contract — where the kernel's authoritative state lives, and who owns it.
 *
 * SINGLE OWNERSHIP is the invariant this file exists to protect. If both
 * AnyPlugin and the kernel could mutate the same authoritative ledger, the
 * invalidation engine could not trust its own inputs — which is precisely the
 * class of reconciliation problem this runtime is built to solve. A control
 * plane whose own state needs reconciling is not a control plane.
 *
 * Concretely:
 *   - The kernel owns everything under STORAGE_ROOT_DIRNAME, exclusively.
 *   - AnyPlugin's installer must never target it (no TEMPLATES entry), because
 *     TEMPLATES destinations are journaled and *restored to pre-install bytes*
 *     on uninstall — which would revert or delete the ledger.
 *   - The kernel never writes AnyPlugin-owned state: the install journal
 *     (.anyplugin-state.json), the runtime mode flag (.anyplugin-mode), agent
 *     config files, or the OKF knowledge bundle.
 *
 * The directory is deliberately NOT named under `.anyplugin/`. The kernel is
 * agent-agnostic and AnyPlugin-agnostic; naming its authoritative state after
 * the distribution layer invites exactly the shared-ownership mistake above
 * (note `.anyplugin/instruction` IS an install destination, so a sibling under
 * `.anyplugin/` would sit one careless whitelist entry away from being wiped).
 */

/** Root directory name for all kernel state, relative to the workspace root. */
export const STORAGE_ROOT_DIRNAME = ".worker-runtime";

/** Subdirectories of the storage root. One concern each; all kernel-owned. */
export const STORAGE_SUBDIRS = [
  "contracts",
  "events",
  "evidence",
  "decisions",
  "experience",
  "graph",
  "certificates",
] as const;

export type StorageSubdir = (typeof STORAGE_SUBDIRS)[number];

/**
 * Paths this kernel must never read or write, because another component owns
 * them. Relative to the workspace root; matched as path prefixes.
 *
 * This list is asserted against AnyPlugin's real TEMPLATES table by
 * `boundary.test.ts` — it is not decorative.
 */
export const FOREIGN_OWNED_PATHS = [
  ".anyplugin",
  ".anyplugin-state.json",
  ".anyplugin-mode",
  ".claude",
  ".codex",
  ".opencode",
  ".agents",
  "opencode.json",
  "AGENTS.md",
] as const;

/** True iff `relPath` lies inside the kernel's exclusively-owned storage root. */
export function isKernelOwned(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return norm === STORAGE_ROOT_DIRNAME || norm.startsWith(`${STORAGE_ROOT_DIRNAME}/`);
}

/** True iff `relPath` belongs to a component other than the kernel. */
export function isForeignOwned(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  return FOREIGN_OWNED_PATHS.some((owned) => norm === owned || norm.startsWith(`${owned}/`));
}
