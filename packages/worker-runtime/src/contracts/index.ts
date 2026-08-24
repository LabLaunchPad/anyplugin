/**
 * The M1 frozen contracts — the smallest executable domain model.
 *
 * Frozen means: changing a required field is a versioned migration, not a
 * refactor, because Certificates (M10) bind these records by content hash.
 *
 * Nothing here implements behavior. These are shapes plus the constraints that
 * make illegal states unrepresentable. Engines that act on them arrive in
 * M2–M10.
 */
import { z } from "zod";
import {
  ActorSchema,
  ConfidenceSchema,
  ContentHashSchema,
  EpistemicRungSchema,
  ProvenanceSchema,
  TimestampSchema,
  ValiditySchema,
  idSchema,
} from "./primitives.js";

export const CONTRACT_VERSION = "1.0.0";

// ── 1. Work Contract ─────────────────────────────────────────────────────────

/**
 * The frame every action is judged against, written BEFORE work begins.
 * Without it, "done" is whatever the model says it is.
 */
export const WorkContractSchema = z
  .object({
    id: idSchema("workContract"),
    contractVersion: z.literal(CONTRACT_VERSION),
    goal: z.string().min(1),
    /** Path globs the work may touch. Empty means unbounded, which is refused. */
    scope: z.array(z.string().min(1)).min(1),
    /** Invariants the work must preserve. */
    constraints: z.array(z.string().min(1)).default([]),
    /**
     * Verifier ids that decide completion — NOT prose. A success condition a
     * machine cannot evaluate is a wish, and would let the model self-certify.
     */
    successConditions: z.array(z.string().min(1)).min(1),
    riskLevel: z.enum(["low", "medium", "high"]),
    provenance: ProvenanceSchema,
  })
  .strict();
export type WorkContract = z.infer<typeof WorkContractSchema>;

// ── 2. Worker State ──────────────────────────────────────────────────────────

export const WORKER_PHASES = [
  "NEW",
  "PLANNING",
  "EXECUTING",
  "WAITING",
  "VERIFYING",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "REOPENED",
] as const;
export const WorkerPhaseSchema = z.enum(WORKER_PHASES);
export type WorkerPhase = z.infer<typeof WorkerPhaseSchema>;

/**
 * Legal transitions. Anything absent is rejected rather than coerced.
 *
 * REOPENED is the transition that matters: it is what the Invalidation Engine
 * (M6) drives when evidence underneath a COMPLETED decision changes. Without
 * it, "completed" is permanent regardless of whether it is still true — which
 * is precisely the failure this runtime exists to prevent.
 */
export const LEGAL_TRANSITIONS: Readonly<Record<WorkerPhase, readonly WorkerPhase[]>> = Object.freeze({
  NEW: ["PLANNING", "BLOCKED", "FAILED"],
  PLANNING: ["EXECUTING", "BLOCKED", "FAILED"],
  EXECUTING: ["WAITING", "VERIFYING", "BLOCKED", "FAILED"],
  WAITING: ["EXECUTING", "BLOCKED", "FAILED"],
  VERIFYING: ["COMPLETED", "EXECUTING", "BLOCKED", "FAILED"],
  BLOCKED: ["PLANNING", "EXECUTING", "FAILED"],
  COMPLETED: ["REOPENED"],
  FAILED: ["REOPENED"],
  REOPENED: ["PLANNING", "EXECUTING"],
});

export function isLegalTransition(from: WorkerPhase, to: WorkerPhase): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export const WorkerStateSchema = z
  .object({
    id: idSchema("workerState"),
    contractVersion: z.literal(CONTRACT_VERSION),
    contractId: idSchema("workContract"),
    phase: WorkerPhaseSchema,
    /** Beliefs held provisionally; each must be re-checkable, hence a string id. */
    assumptions: z.array(z.string().min(1)).default([]),
    /** Monotonic; every transition appends an event and increments this. */
    revision: z.number().int().nonnegative(),
    updatedAt: TimestampSchema,
  })
  .strict();
export type WorkerState = z.infer<typeof WorkerStateSchema>;

// ── 3. Event ─────────────────────────────────────────────────────────────────

/** Append-only. Replaying the log must reconstruct byte-identical state (M2). */
export const EventSchema = z
  .object({
    id: idSchema("event"),
    contractVersion: z.literal(CONTRACT_VERSION),
    /** Monotonic per log; gaps mean loss, duplicates mean a broken writer. */
    sequence: z.number().int().nonnegative(),
    at: TimestampSchema,
    actor: ActorSchema,
    kind: z.enum([
      "STATE_TRANSITION",
      "EVIDENCE_ADDED",
      "EVIDENCE_INVALIDATED",
      "EVIDENCE_SUPERSEDED",
      "DECISION_RECORDED",
      "DECISION_STALED",
      "EXPERIENCE_RECORDED",
      "EXPERIENCE_PROMOTED",
      "VERIFICATION_RUN",
      "CERTIFICATE_ISSUED",
    ]),
    /** Id of the record this event concerns. */
    subject: z.string().min(1),
    /** Event-kind-specific payload; validated by the engine that emits it. */
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type WorkerEvent = z.infer<typeof EventSchema>;

// ── 4. Evidence ──────────────────────────────────────────────────────────────

export const EvidenceKindSchema = z.enum([
  "GIT_DIFF",
  "TEST_RESULT",
  "BUILD_RESULT",
  "API_RESPONSE",
  "DOCUMENTATION",
  "PACKAGE_METADATA",
  "HUMAN_APPROVAL",
  "SECURITY_SCAN",
  "RUNTIME_OBSERVATION",
]);

/**
 * A fact plus everything needed to decide whether to still trust it.
 * Immutable: invalidation appends an event and flips `validity`.
 */
export const EvidenceSchema = z
  .object({
    id: idSchema("evidence"),
    contractVersion: z.literal(CONTRACT_VERSION),
    kind: EvidenceKindSchema,
    /** Where it came from — a command, URL, or file path. */
    source: z.string().min(1),
    /** Hash of the observed content, so tampering is detectable. */
    contentHash: ContentHashSchema,
    /** How authoritative the source is for this claim. */
    authority: z.enum(["AUTHORITATIVE", "DERIVED", "REPORTED"]),
    provenance: ProvenanceSchema,
    validity: ValiditySchema,
    /** Set iff validity is SUPERSEDED. Enforced by the refinement below. */
    supersededBy: idSchema("evidence").optional(),
    /** Set iff validity is INVALIDATED — why it stopped being trustworthy. */
    invalidationReason: z.string().min(1).optional(),
  })
  .strict()
  .refine((e) => (e.validity === "SUPERSEDED") === (e.supersededBy !== undefined), {
    message: "supersededBy must be present exactly when validity is SUPERSEDED",
    path: ["supersededBy"],
  })
  .refine((e) => (e.validity === "INVALIDATED") === (e.invalidationReason !== undefined), {
    message: "invalidationReason must be present exactly when validity is INVALIDATED",
    path: ["invalidationReason"],
  });
export type Evidence = z.infer<typeof EvidenceSchema>;

// ── 5. Decision ──────────────────────────────────────────────────────────────

/**
 * `alternatives` and `assumptions` are what make a decision re-evaluable later
 * rather than merely re-readable. A decision recording only its outcome cannot
 * be revisited when its evidence changes — it can only be re-litigated.
 */
export const DecisionSchema = z
  .object({
    id: idSchema("decision"),
    contractVersion: z.literal(CONTRACT_VERSION),
    contractId: idSchema("workContract"),
    selected: z.string().min(1),
    alternatives: z.array(z.string().min(1)).default([]),
    /** Evidence this rests on. Empty means the decision is unfounded. */
    supportingEvidence: z.array(idSchema("evidence")).min(1),
    assumptions: z.array(z.string().min(1)).default([]),
    provenance: ProvenanceSchema,
    validity: ValiditySchema,
    /**
     * STALE is not a validity — it is a *derived* status meaning "supporting
     * evidence changed, re-verify before relying on this". Kept separate so a
     * stale decision is not confused with a wrong one.
     */
    stale: z.boolean().default(false),
    supersededBy: idSchema("decision").optional(),
  })
  .strict()
  .refine((d) => (d.validity === "SUPERSEDED") === (d.supersededBy !== undefined), {
    message: "supersededBy must be present exactly when validity is SUPERSEDED",
    path: ["supersededBy"],
  });
export type Decision = z.infer<typeof DecisionSchema>;

// ── 6. Experience ────────────────────────────────────────────────────────────

export const FAILURE_CLASSES = [
  "INFRASTRUCTURE",
  "TOOL",
  "ENVIRONMENT",
  "KNOWLEDGE",
  "REASONING",
  "EXECUTION",
  "VERIFICATION",
  "USER_CONSTRAINT",
] as const;
export const FailureClassSchema = z.enum(FAILURE_CLASSES);
export type FailureClass = z.infer<typeof FailureClassSchema>;

/**
 * What happened when the worker attempted X under conditions Y.
 *
 * `validWhen` and `invalidatedBy` are what make an experience *applicable*
 * rather than merely *recalled* — without them this is just a log line.
 */
export const ExperienceSchema = z
  .object({
    id: idSchema("experience"),
    contractVersion: z.literal(CONTRACT_VERSION),
    contractId: idSchema("workContract"),
    action: z.string().min(1),
    outcome: z.enum(["SUCCESS", "FAILURE"]),
    /** Present only for FAILURE, and never guessed — see the refinement below. */
    failureClass: FailureClassSchema.optional(),
    lesson: z.string().min(1),
    /** Where on the epistemic ladder this sits. Never auto-advances. */
    rung: EpistemicRungSchema,
    evidence: z.array(idSchema("evidence")).default([]),
    confidence: ConfidenceSchema,
    /** Conditions under which the lesson applies at all. */
    validWhen: z.record(z.string(), z.string()).default({}),
    /** Signals that retire the lesson. */
    invalidatedBy: z.array(z.string().min(1)).default([]),
    provenance: ProvenanceSchema,
  })
  .strict()
  .refine((e) => e.outcome === "FAILURE" || e.failureClass === undefined, {
    message: "failureClass is meaningful only when outcome is FAILURE",
    path: ["failureClass"],
  })
  .refine((e) => e.rung !== "VERIFIED_KNOWLEDGE" || e.evidence.length > 0, {
    // The epistemic ladder's load-bearing constraint, enforced in the schema:
    // a lesson cannot reach VERIFIED_KNOWLEDGE without evidence backing it.
    message: "VERIFIED_KNOWLEDGE requires at least one supporting evidence id",
    path: ["rung"],
  });
export type Experience = z.infer<typeof ExperienceSchema>;

// ── 7. Dependency graph ──────────────────────────────────────────────────────

export const NODE_KINDS = [
  "FILE",
  "SYMBOL",
  "TEST",
  "CONFIG",
  "EVIDENCE",
  "CLAIM",
  "DECISION",
  "EXPERIENCE",
  "WORK_ITEM",
] as const;
export const EDGE_KINDS = [
  "IMPORTS",
  "MODIFIES",
  "TESTS",
  "SUPPORTS",
  "DEPENDS_ON",
  "DERIVED_FROM",
  "LEARNED_FROM",
  "INVALIDATES",
  "SUPERSEDES",
] as const;

export const GraphNodeSchema = z
  .object({ id: idSchema("node"), kind: z.enum(NODE_KINDS), ref: z.string().min(1) })
  .strict();

export const GraphEdgeSchema = z
  .object({ from: idSchema("node"), to: idSchema("node"), kind: z.enum(EDGE_KINDS) })
  .strict();

/** A snapshot is hashable so a Certificate can bind the graph it reasoned over. */
export const GraphSnapshotSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    at: TimestampSchema,
    nodes: z.array(GraphNodeSchema),
    edges: z.array(GraphEdgeSchema),
  })
  .strict();
export type GraphSnapshot = z.infer<typeof GraphSnapshotSchema>;

// ── 8. Invalidation ──────────────────────────────────────────────────────────

/** The computed consequence of a change. Produced by rules, never by a model. */
export const InvalidationResultSchema = z
  .object({
    contractVersion: z.literal(CONTRACT_VERSION),
    trigger: z.string().min(1),
    at: TimestampSchema,
    affectedNodes: z.array(idSchema("node")).default([]),
    staleDecisions: z.array(idSchema("decision")).default([]),
    reopenedWork: z.array(idSchema("workContract")).default([]),
    requiresReverification: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type InvalidationResult = z.infer<typeof InvalidationResultSchema>;

// ── 9. Verification ──────────────────────────────────────────────────────────

/**
 * BLOCKED exists so that absence of evidence has somewhere to go that is not
 * success. A verifier must never convert missing evidence into PASS.
 */
export const VerificationOutcomeSchema = z.enum(["PASS", "FAIL", "BLOCKED"]);

export const VerificationResultSchema = z
  .object({
    id: idSchema("verification"),
    contractVersion: z.literal(CONTRACT_VERSION),
    verifierId: z.string().min(1),
    outcome: VerificationOutcomeSchema,
    /** Hashes of what was checked, so a result cannot be reused for other inputs. */
    inputHashes: z.array(ContentHashSchema).min(1),
    observations: z.array(z.string()).default([]),
    at: TimestampSchema,
    /** Required for BLOCKED and FAIL: why. Silence is not a result. */
    reason: z.string().min(1).optional(),
  })
  .strict()
  .refine((v) => v.outcome === "PASS" || v.reason !== undefined, {
    message: "FAIL and BLOCKED must state a reason",
    path: ["reason"],
  });
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

// ── 10. Certificate ──────────────────────────────────────────────────────────

/**
 * Binds an outcome to everything it rests on. Verification is implemented
 * independently of creation (M10), and tampering with ANY referenced artifact
 * must fail that verification.
 */
export const CertificateSchema = z
  .object({
    id: idSchema("certificate"),
    contractVersion: z.literal(CONTRACT_VERSION),
    runtimeVersion: z.string().min(1),
    contractId: idSchema("workContract"),
    finalPhase: WorkerPhaseSchema,
    contractHash: ContentHashSchema,
    stateHash: ContentHashSchema,
    graphSnapshotHash: ContentHashSchema,
    evidenceHashes: z.array(ContentHashSchema).default([]),
    decisionHashes: z.array(ContentHashSchema).default([]),
    verificationHashes: z.array(ContentHashSchema).default([]),
    issuedAt: TimestampSchema,
    provenance: ProvenanceSchema,
  })
  .strict()
  .refine((c) => c.finalPhase === "COMPLETED" || c.finalPhase === "FAILED", {
    // A certificate over in-flight work would assert something not yet true.
    message: "certificates may only be issued for COMPLETED or FAILED work",
    path: ["finalPhase"],
  });
export type Certificate = z.infer<typeof CertificateSchema>;

/** Every frozen contract, for schema-export and drift tests. */
export const CONTRACTS = {
  WorkContract: WorkContractSchema,
  WorkerState: WorkerStateSchema,
  Event: EventSchema,
  Evidence: EvidenceSchema,
  Decision: DecisionSchema,
  Experience: ExperienceSchema,
  GraphSnapshot: GraphSnapshotSchema,
  InvalidationResult: InvalidationResultSchema,
  VerificationResult: VerificationResultSchema,
  Certificate: CertificateSchema,
} as const;

export * from "./primitives.js";
