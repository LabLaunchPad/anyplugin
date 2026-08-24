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

export * from "./contracts/index.js";
export { canonicalJson, contentHash, isContentHash, CanonicalizationError } from "./canonical.js";
export { exportSchemas, schemaFileName, type ExportedSchema } from "./schema-export.js";

export {
  STORAGE_ROOT_DIRNAME,
  STORAGE_SUBDIRS,
  FOREIGN_OWNED_PATHS,
  isKernelOwned,
  isForeignOwned,
  type StorageSubdir,
} from "./storage.js";

export {
  OwnershipError,
  assertWritable,
  assertDeletable,
  checkWritable,
  checkDeletable,
  classifySubdir,
  AUTHORITATIVE_SUBDIRS,
  DERIVED_SUBDIRS,
  type OwnershipVerdict,
  type RefusalReason,
} from "./ownership.js";

export {
  EVENT_WRITE_CONTRACT_VERSION,
  GUARANTEES,
  PIPE_BUF,
  recordHash,
  type Anomaly,
  type Classification,
  type CommittedEntry,
  type EventLogWriter,
  type LogRecord,
  type ReplayResult,
} from "./log/write-contract.js";

export {
  RESOURCE_MEASUREMENT_VERSION,
  ResourceMeasurementSchema,
  coverageOf,
  type Coverage,
  type ResourceMeasurement,
} from "./resource/measurement.js";
export {
  KNOWN_BY,
  MEASURABLE_FIELDS,
  TELEMETRY_INVENTORY,
  UNOBSERVABLE_FIELDS,
  measure,
  type KernelSample,
  type KnownBy,
  type TelemetryCapability,
} from "./resource/telemetry.js";

export {
  EventLog,
  EventLogError,
  EVENT_LOG_RELPATH,
  LOG_FILENAME,
  WRITER_LOCK_FILENAME,
  frameOf,
  type WriterIdentity,
} from "./log/event-log.js";
export { REPLAY_ANOMALIES, isClean, replay, replayDigest, type ReplayReport } from "./log/replay.js";
export {
  foldFromReplay,
  foldWorkerState,
  stateHash,
  stateJson,
  type FoldResult,
  type RejectedTransition,
} from "./log/worker-state.js";
