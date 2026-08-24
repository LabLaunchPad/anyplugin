/**
 * @lablaunchpad/worker-runtime — deterministic worker runtime kernel.
 *
 * M1 status: boundaries only. No domain behavior is implemented yet; the
 * contracts (WorkContract, WorkerState, Evidence, Decision, Experience,
 * Dependency, Invalidation, Verification, Certificate) are frozen in a
 * subsequent M1 commit, per ROADMAP.md §5.
 *
 * THE LOCKED DEPENDENCY DIRECTION (ROADMAP.md §2):
 *
 *   dependencies point INWARD at this kernel, never outward.
 *
 *   This package knows nothing about Claude Code, OpenCode, Codex,
 *   Antigravity, AnyPlugin, MCP transport, or hooks. Those are replaceable
 *   execution clients that sit ABOVE it. Enforced mechanically by
 *   core/src/boundaries/package-boundary.test.ts.
 *
 * Consequently this package depends on `zod` and nothing else in the
 * workspace — not even @lablaunchpad/core, which carries agent-specific
 * knowledge (NATIVE_EVENT_MAP, agent detection, the adapter contract).
 */

export const RUNTIME_VERSION = "0.0.1";

export {
  STORAGE_ROOT_DIRNAME,
  STORAGE_SUBDIRS,
  FOREIGN_OWNED_PATHS,
  isKernelOwned,
  isForeignOwned,
  type StorageSubdir,
} from "./storage.js";
