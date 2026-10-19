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
  type InvalidationResult,
} from "../contracts/index.js";
import {
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

  const trigger = input.trigger;
  if (!index.nodes.has(trigger)) {
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
    anomalies.sort((a, b) => (a.classification < b.classification ? -1 : a.classification > b.classification ? 1 : 0));
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
    const prefix = NODE_REF_PREFIX[node.kind];
    if (prefix === undefined) return;
    if (!node.ref.startsWith(prefix)) {
      anomalies.push({
        classification: "DANGLING_ENDPOINT",
        reason: `node "${node.id}" is a ${node.kind} but its ref "${node.ref}" does not carry the required "${prefix}" prefix`,
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

  anomalies.sort((a, b) => {
    if (a.classification !== b.classification) return a.classification < b.classification ? -1 : 1;
    const ai = a.nodeIds.join(",");
    const bi = b.nodeIds.join(",");
    if (ai !== bi) return ai < bi ? -1 : 1;
    return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
  });

  return { result, anomalies };
}
