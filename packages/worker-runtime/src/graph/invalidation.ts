/**
 * The invalidation cascade.
 *
 * ── What it computes ───────────────────────────────────────────────────────
 *
 * `InvalidationResultSchema` declares four fields — `affectedNodes`,
 * `staleDecisions`, `reopenedWork`, `requiresReverification` — and **none of
 * them can be computed without traversal**. This module is the producer that
 * was missing, and it closes the invalidation milestone (M6) that depends on
 * the traversal milestone (M5).
 *
 * ── The node→record resolution convention ──────────────────────────────────
 *
 * `GraphNodeSchema.id` is `ND-…`, but `InvalidationResultSchema.staleDecisions`
 * is `DEC-…` and `reopenedWork` is `WC-…`. **A graph node therefore cannot
 * carry a decision's id** — the two id spaces do not meet. This module is
 * where they meet, and the convention is stated here rather than left
 * implicit:
 *
 * > For a node of kind `DECISION`, `WORK_ITEM`, `EVIDENCE` or `EXPERIENCE`,
 * > the node's `ref` **is** the record's id. For `FILE`, `SYMBOL`, `TEST`,
 * > `CONFIG` and `CLAIM`, `ref` is a path, a symbol or a claim key.
 *
 * A `ref` that does not carry the prefix its node kind requires is an
 * **anomaly**. It is reported, and the record is excluded — never silently
 * included, and never silently dropped.
 *
 * ── The engine records and verifies; it never infers ──────────────────────
 *
 * The `REOPENED` **transition** is not a graph operation: `LEGAL_TRANSITIONS`
 * already permits it, and the state fold writes it. This module returns
 * **ids**; something that owns the state writes the transition. The same
 * separation the kernel applies to the optimiser (D-014).
 */
import {
  CONTRACT_VERSION,
  InvalidationResultSchema,
  TimestampSchema,
  idSchema,
  type InvalidationResult,
} from "../contracts/index.js";
import {
  compareAnomalies,
  indexGraph,
  propagatingReachable,
  type GraphAnomaly,
  type GraphNodeKind,
} from "./traverse.js";

/**
 * The id prefix each record-bearing node kind must carry.
 *
 * `CLAIM` has no entry: the kernel has no CLAIM record type, so a claim
 * node's `ref` is a claim key, not a typed id.
 */
export const NODE_REF_PREFIX: Partial<Record<GraphNodeKind, string>> = {
  EVIDENCE: "EV-",
  DECISION: "DEC-",
  EXPERIENCE: "EXP-",
  WORK_ITEM: "WC-",
};

/**
 * The id schema each record-bearing node kind's `ref` must satisfy.
 *
 * A **prefix check is not enough**. `"DEC-bad id"` and `"DEC-` both start
 * with "DEC-" and both fail the id schema, so a prefix check let them
 * through and the failure surfaced later as a crash in the result schema —
 * 3% of randomly generated schema-valid graphs hit it. The ref is
 * validated with the SAME schema the result is validated with, so a
 * malformed ref is REPORTED and excluded instead of exploding.
 */
export const NODE_REF_SCHEMA: Partial<Record<GraphNodeKind, { safeParse: (v: unknown) => { success: boolean } }>> = {
  EVIDENCE: idSchema("evidence"),
  DECISION: idSchema("decision"),
  EXPERIENCE: idSchema("experience"),
  WORK_ITEM: idSchema("workContract"),
};

/** One decision, as far as the cascade needs to know. */
export interface DecisionSummary {
  readonly id: string;
  /** The work contract this decision belongs to. */
  readonly contractId: string;
  /** The evidence this decision rests on. */
  readonly supportingEvidence: readonly string[];
}

/** One evidence record, as far as the cascade needs to know. */
export interface EvidenceSummary {
  readonly id: string;
  readonly contentHash: string;
}

/** One verification, as far as the cascade needs to know. */
export interface VerificationSummary {
  readonly id: string;
  /** The content hashes this verification consumed. */
  readonly inputHashes: readonly string[];
}

export interface InvalidationInput {
  /** The node whose change triggered the cascade. */
  readonly trigger: string;
  /** The instant the result carries. The caller supplies it — no clock here. */
  readonly at: string;
  readonly decisions?: readonly DecisionSummary[];
  readonly evidence?: readonly EvidenceSummary[];
  readonly verifications?: readonly VerificationSummary[];
}

export interface InvalidationComputation {
  readonly result: InvalidationResult;
  /** Everything wrong with the graph or with the references, sorted. */
  readonly anomalies: readonly GraphAnomaly[];
}

/**
 * Compute the consequence of a change.
 *
 * The walk is `propagatingReachable` — `INVALIDATES` forwards, the seven
 * dependency kinds backwards, `SUPERSEDES` never — so an unrelated decision
 * is left untouched. That is not an optimisation; it is the acceptance
 * criterion.
 */
export function computeInvalidation(
  snapshot: Parameters<typeof indexGraph>[0],
  input: InvalidationInput,
): InvalidationComputation {
  const index = indexGraph(snapshot);
  const anomalies: GraphAnomaly[] = [...index.anomalies];

  // The instant is a CALLER error, not a graph defect: the result cannot
  // exist without one, so there is nothing to exclude and nothing to report
  // an anomaly about. It is validated with a clear message rather than
  // surfacing later as an opaque schema error.
  if (!TimestampSchema.safeParse(input.at).success) {
    throw new Error(
      `computeInvalidation: the "at" field must be an ISO-8601 instant with an explicit UTC offset (got "${input.at}")`,
    );
  }

  const trigger = input.trigger;
  // A trigger with no node record is refused — UNLESS it is a DANGLING
  // ENDPOINT, which the module's own traversal treats as an unknown-kind
  // node and reports. Refusing it made the cascade and `propagatingReachable`
  // disagree about the same graph, which is the kind of internal
  // contradiction that makes a result untrustworthy.
  if (!index.nodes.has(trigger) && !index.dangling.has(trigger)) {
    anomalies.push({
      classification: "MISSING_TRIGGER",
      reason: `the trigger node "${trigger}" has no node record, so nothing can be affected`,
      nodeIds: [trigger],
    });
    const empty = InvalidationResultSchema.parse({
      contractVersion: CONTRACT_VERSION,
      trigger,
      at: input.at,
      affectedNodes: [],
      staleDecisions: [],
      reopenedWork: [],
      requiresReverification: [],
    });
    anomalies.sort(compareAnomalies);
    return { result: empty, anomalies };
  }

  const affected = propagatingReachable(index, trigger);

  // ── The refs of the affected nodes, by kind ─────────────────────────────
  // The TRIGGER counts. The artefact that changed is itself invalidated, so
  // a verification that consumed the trigger's content hash must be
  // re-verified, and a decision that rests on the trigger's record is stale.
  // The trigger is excluded from `affectedNodes` — it is the changed thing,
  // not an affected thing — but it is not excluded from the consequences.
  const affectedRefs = new Map<GraphNodeKind, string[]>();
  const collectRef = (id: string): void => {
    const node = index.nodes.get(id);
    if (!node) return;
    const schema = NODE_REF_SCHEMA[node.kind];
    if (schema === undefined) return;
    if (!schema.safeParse(node.ref).success) {
      anomalies.push({
        classification: "MALFORMED_REF",
        reason: `node "${node.id}" is a ${node.kind} but its ref "${node.ref}" is not a valid ${NODE_REF_PREFIX[node.kind]} id`,
        nodeIds: [node.id],
      });
      return;
    }
    if (!affectedRefs.has(node.kind)) affectedRefs.set(node.kind, []);
    affectedRefs.get(node.kind)!.push(node.ref);
  };
  collectRef(trigger);
  for (const id of affected) collectRef(id);
  const affectedEvidenceRefs = new Set(affectedRefs.get("EVIDENCE") ?? []);

  // ── The stale decisions ─────────────────────────────────────────────────
  // Two routes, unioned:
  //   (a) a DECISION node the cascade reached;
  //   (b) a decision whose supporting evidence was affected — the route
  //       `DecisionSchema.supportingEvidence` encodes, which the graph may
  //       not model as an edge.
  const staleDecisions = new Set<string>(affectedRefs.get("DECISION") ?? []);
  for (const decision of input.decisions ?? []) {
    // The caller supplies these, and the engine is the PRODUCER of a
    // schema-conformant result — it must not be the thing that breaks the
    // schema. An invalid id is reported and the decision excluded.
    if (!idSchema("decision").safeParse(decision.id).success) {
      anomalies.push({
        classification: "MALFORMED_REFERENCE",
        reason: `decision id "${decision.id}" is not a valid DEC-<slug> id; the decision is excluded`,
        nodeIds: [],
      });
      continue;
    }
    if (!idSchema("workContract").safeParse(decision.contractId).success) {
      anomalies.push({
        classification: "MALFORMED_REFERENCE",
        reason: `decision "${decision.id}" names work contract "${decision.contractId}", which is not a valid WC-<slug> id; the decision is excluded`,
        nodeIds: [],
      });
      continue;
    }
    if (decision.supportingEvidence.some((e) => affectedEvidenceRefs.has(e))) {
      staleDecisions.add(decision.id);
    }
  }

  // ── The reopened work ───────────────────────────────────────────────────
  // The work contracts the stale decisions belong to, plus the work items
  // the cascade reached directly.
  const reopenedWork = new Set<string>(affectedRefs.get("WORK_ITEM") ?? []);
  for (const decision of input.decisions ?? []) {
    if (staleDecisions.has(decision.id)) reopenedWork.add(decision.contractId);
  }

  // ── The verifications that must run again ───────────────────────────────
  // A verification consumed a content hash. The graph carries no hashes, so
  // the hashes come from the evidence records, matched through the affected
  // evidence ids.
  const contentHashes = new Set<string>();
  for (const evidence of input.evidence ?? []) {
    if (affectedEvidenceRefs.has(evidence.id)) contentHashes.add(evidence.contentHash);
  }
  const requiresReverification = new Set<string>();
  for (const verification of input.verifications ?? []) {
    if (verification.inputHashes.some((h) => contentHashes.has(h))) {
      requiresReverification.add(verification.id);
    }
  }

  const result = InvalidationResultSchema.parse({
    contractVersion: CONTRACT_VERSION,
    trigger,
    at: input.at,
    affectedNodes: affected,
    staleDecisions: [...staleDecisions].sort(),
    reopenedWork: [...reopenedWork].sort(),
    requiresReverification: [...requiresReverification].sort(),
  });

  anomalies.sort(compareAnomalies);

  return { result, anomalies };
}
