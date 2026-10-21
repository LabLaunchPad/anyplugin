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
export {
  READABLE_CONTRACT_VERSIONS,
  migrateRecord,
  type MigrationResult,
} from "./contracts/migration.js";
export { canonicalJson, contentHash, isContentHash, CanonicalizationError } from "./canonical.js";
export { exportSchemas, schemaFileName, type ExportedSchema } from "./schema-export.js";
export {
  LocalProcessBackend,
  executionRootSize,
  type LocalProcessBackendOptions,
} from "./execution/local-process.js";
export type { ExecutionBackend } from "./execution/backend.js";

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
  CIRCUIT_STATES,
  DELEGATION_EVENT_TYPES,
  DEFAULT_CIRCUIT_POLICY,
  EFFECT_STATES,
  FAILURE_BEHAVIOUR,
  DELEGATION_FAILURE_CLASSES,
  FAILURE_SPECS,
  FAIL_POLICY,
  FALLBACKABLE_FAILURES,
  CircuitBreaker,
  canFallback,
  classifyAttempt,
  classifyErrorCode,
  classifyFailure,
  classifyHttpStatus,
  delegationEvent,
  delegationEventId,
  delegationEventToWorkerEvent,
  failureSpec,
  fallbackLegal,
  type AttemptObservation,
  type CircuitPolicy,
  type CircuitState,
  type DelegationErrorEnvelope,
  type DelegationEvent,
  type DelegationEventType,
  type EffectState,
  type FallbackState,
  type FailureBehaviour,
  type DelegationFailureClass,
  type FailureClassSpec,
} from "./telemetry/delegation.js";

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
  foldDecisions,
  invalidatedEvidenceIds,
  supersededEvidence,
  type DecisionFoldResult,
  type DecisionProjection,
} from "./log/decisions.js";
export {
  foldEvidence,
  invalidatedEvidence,
  usableEvidence,
  type EvidenceFoldResult,
  type EvidenceProjection,
} from "./log/evidence.js";
export {
  foldExperience,
  planPromotion,
  type ExperienceFoldResult,
  type ExperienceProjection,
  type PromotionInput,
  type PromotionPlan,
} from "./log/experience.js";
export {
  dependencyConsistencyClaim,
  evidenceIntegrityClaim,
  graphConsistencyClaim,
  verify,
  type VerificationClaim,
  type VerificationInput,
  type VerificationOutcome,
} from "./verify/index.js";
export {
  EDGE_SEMANTICS,
  NODE_REF_PREFIX,
  PROPAGATING_KINDS,
  components,
  computeInvalidation,
  deriveGraph,
  eventIdOf,
  findCycles,
  graphHash,
  indexGraph,
  planInvalidationEvents,
  planRestoration,
  propagatingReachable,
  reachable,
  reachableWithDistance,
  serializeGraphIndex,
  topologicalOrder,
  type DecisionSummary,
  type EdgeDirection,
  type EvidenceSummary,
  type GraphAnomaly,
  type GraphAnomalyClassification,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphIndex,
  type GraphNode,
  type GraphNodeKind,
  type InvalidationComputation,
  type InvalidationEventInput,
  type InvalidationEventPlan,
  type InvalidationInput,
  type RestorationInput,
  type RestorationPlan,
  type TopologicalOrder,
  type TraverseOptions,
  type VerificationSummary,
  type WorkerEventDraft,
} from "./graph/index.js";
export {
  foldFromReplay,
  foldWorkerState,
  stateHash,
  stateJson,
  type FoldResult,
  type RejectedTransition,
} from "./log/worker-state.js";
