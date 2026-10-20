/**
 * The decision projection.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * `DecisionSchema.stale` is documented as a **derived** status: *"STALE is
 * not a validity — it is a derived status meaning 'supporting evidence
 * changed, re-verify before relying on this'."* A derived status is not
 * flipped by an event; it is **computed** from the records it depends on.
 * So something has to compute it, or "the decision is STALE" is not
 * observable in the form the milestone states it.
 *
 * The existing fold, `foldWorkerState`, projects only `STATE_TRANSITION`
 * events; every other kind is counted as `ignored`. That is right for the
 * worker state — it is a fold over one kind of event — and it is why the
 * decision projection did not exist.
 *
 * ── What this is NOT ───────────────────────────────────────────────────────
 *
 * This is **not** the Decision Ledger. M4 owns that: the full record, its
 * provenance, its alternatives, its supersession, the experience ledger
 * beside it. This is the minimum needed to observe M6's acceptance
 * criterion — *"the dependent decision to `STALE` … and leaves unrelated
 * decisions untouched"* — and it is deliberately narrow.
 *
 * ── The rule that makes the projection correct ────────────────────────────
 *
 * A decision is stale **iff** at least one of its supporting evidence
 * records is currently `INVALIDATED`. A **superseded** record is not
 * invalidated: it may still have been true when it was written, and it has
 * been replaced by a newer one. That distinction is the whole reason
 * `ValiditySchema` separates the two, and it is what makes "replacement
 * evidence restores validity" implementable rather than mystical.
 */
import {
  DecisionSchema,
  type Decision,
  type Validity,
  type WorkerEvent,
} from "../contracts/index.js";

/** The decision, as the log projects it. */
export interface DecisionProjection {
  readonly id: string;
  readonly contractId: string;
  readonly validity: Validity;
  /**
   * The derived staleness.
   *
   * Set by a `DECISION_STALED` event, and cleared by a `DECISION_RECORDED`
   * event that carries the decision re-grounded on valid support.
   */
  readonly stale: boolean;
  readonly supportingEvidence: readonly string[];
  readonly supersededBy?: string;
}

export interface DecisionFoldResult {
  /** One projection per decision, keyed by decision id. */
  readonly decisions: Map<string, DecisionProjection>;
  /** Events whose kind this fold does not interpret. Not an error. */
  readonly ignored: number;
  /**
   * The decisions whose `DECISION_RECORDED` payload could not be read.
   *
   * Recorded, never coerced: a malformed record is a broken writer, and
   * pretending it said something else would make the log unreadable in a
   * way nothing could detect.
   */
  readonly rejected: readonly string[];
}

/** Fold the decision events into decision projections. */
export function foldDecisions(events: readonly WorkerEvent[]): DecisionFoldResult {
  const decisions = new Map<string, DecisionProjection>();
  const rejected: string[] = [];
  let ignored = 0;

  for (const event of events) {
    if (event.kind === "DECISION_RECORDED") {
      const payload = event.payload["decision"];
      const parsed = DecisionSchema.safeParse(payload);
      if (!parsed.success) {
        rejected.push(event.subject);
        continue;
      }
      const decision: Decision = parsed.data;
      decisions.set(decision.id, {
        id: decision.id,
        contractId: decision.contractId,
        validity: decision.validity,
        // A re-recorded decision carries its own derived staleness. The
        // record is the authority: a decision re-grounded on valid support
        // is not stale, and a decision re-recorded as stale is.
        stale: decision.stale,
        supportingEvidence: [...decision.supportingEvidence],
        ...(decision.supersededBy ? { supersededBy: decision.supersededBy } : {}),
      });
      continue;
    }

    if (event.kind === "DECISION_STALED") {
      const current = decisions.get(event.subject);
      decisions.set(event.subject, {
        id: event.subject,
        contractId: current?.contractId ?? String(event.payload["contractId"] ?? ""),
        validity: current?.validity ?? "VALID",
        stale: true,
        supportingEvidence: current?.supportingEvidence ?? [],
      });
      continue;
    }

    ignored += 1;
  }

  return { decisions, ignored, rejected };
}

/**
 * The evidence that is currently `INVALIDATED`.
 *
 * Derived from the event stream alone: an `EVIDENCE_INVALIDATED` event
 * invalidates, and an `EVIDENCE_SUPERSEDED` event **replaces** it — the
 * record was superseded, so it is no longer one to rely on *as invalid*; it
 * is one that was true when written and has been replaced.
 *
 * This is what lets the restoration plan know whether a re-grounded decision
 * is genuinely un-stale, without the evidence ledger of M3.
 */
export function invalidatedEvidenceIds(events: readonly WorkerEvent[]): Set<string> {
  const invalidated = new Set<string>();
  for (const event of events) {
    if (event.kind === "EVIDENCE_INVALIDATED") invalidated.add(event.subject);
    else if (event.kind === "EVIDENCE_SUPERSEDED") invalidated.delete(event.subject);
  }
  return invalidated;
}

/** The evidence that has been replaced, and by what. */
export function supersededEvidence(events: readonly WorkerEvent[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "EVIDENCE_SUPERSEDED") continue;
    const by = event.payload["supersededBy"];
    if (typeof by === "string" && by !== "") out.set(event.subject, by);
  }
  return out;
}
