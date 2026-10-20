/**
 * The invalidation engine's event producer.
 *
 * ── Why this is a producer and not a fold ─────────────────────────────────
 *
 * The roadmap said the `STALE` and `REOPENED` transitions are *"the state
 * fold's job"*. That is architecturally impossible, and the kernel says so
 * itself: `log/worker-state.ts` opens with *"State is derived, never
 * authoritative. The log is the record of what happened; this is a
 * projection of it"* — and **a projection cannot append**. A fold that
 * emitted events would be the second source of truth the kernel's own
 * invariant forbids.
 *
 * So the causal chain is:
 *
 * ```
 * EVIDENCE_INVALIDATED      (appended by whoever invalidated the evidence)
 *        ↓
 * computeInvalidation()     (the cascade — computes the affected ids)
 *        ↓
 * planInvalidationEvents()  (THIS MODULE — the writer; proposes the events)
 *        ↓
 * DECISION_STALED            (appended)
 * STATE_TRANSITION→REOPENED (appended)
 *        ↓
 * foldWorkerState() / foldDecisions()  (the projections — read the events)
 * ```
 *
 * ── The rules ──────────────────────────────────────────────────────────────
 *
 * 1. **Pure.** No clock, no I/O, no randomness: the caller supplies `at`
 *    and `actor`. The same input always produces the same events.
 * 2. **Deterministic order.** Stale decisions first, sorted by id; then the
 *    reopened work, sorted by id. A decision is staled *because* its evidence
 *    changed; the work is reopened *because* the decision is stale. The
 *    order is the causal order, and it is the same every time.
 * 3. **An illegal transition is rejected and recorded, never coerced.**
 *    `LEGAL_TRANSITIONS` permits `COMPLETED → REOPENED` and
 *    `FAILED → REOPENED` and nothing else, so a work item can only be
 *    reopened from a terminal phase. A phase the caller does not know is
 *    **not** assumed to be reopenable: an unverifiable transition is
 *    refused, and the refusal is reported.
 * 4. **The event id is a content hash.** Two identical events get identical
 *    ids, so re-appending one is idempotent — the same property the
 *    delegation telemetry has.
 */
import {
  CONTRACT_VERSION,
  DecisionSchema,
  isLegalTransition,
  type Decision,
  type InvalidationResult,
  type WorkerEvent,
  type WorkerPhase,
  type WorkerState,
} from "../contracts/index.js";
import { eventIdOf } from "../log/event-id.js";
import type { RejectedTransition } from "../log/worker-state.js";

/** An event the log has not yet sequenced. */
export type WorkerEventDraft = Omit<WorkerEvent, "sequence">;

// ── The invalidation consequences ─────────────────────────────────────────

export interface InvalidationEventInput {
  /** The cascade's result. */
  readonly result: InvalidationResult;
  /**
   * The decisions the cascade staled, with their records.
   *
   * The records are needed for the `DECISION_STALED` payload and for the
   * evidence ids the staleness names.
   */
  readonly decisions?: readonly Decision[];
  /**
   * The current worker states, keyed by work-contract id.
   *
   * **Required in practice.** A phase the caller does not know cannot be
   * verified as a legal predecessor of `REOPENED`, so the transition is
   * refused rather than assumed. The refusal is reported.
   */
  readonly states?: ReadonlyMap<string, WorkerState>;
  /** The instant the events carry. */
  readonly at: string;
  /** Who produced them. */
  readonly actor: string;
  /** Why the trigger changed. */
  readonly reason?: string;
}

export interface InvalidationEventPlan {
  /** The events to append, in order. */
  readonly events: readonly WorkerEventDraft[];
  /** Transitions the phase machine refused. Never coerced. */
  readonly rejected: readonly RejectedTransition[];
  /** The decisions that were marked stale. */
  readonly staleDecisions: readonly string[];
  /** The work contracts that were reopened. */
  readonly reopenedWork: readonly string[];
}

/**
 * Propose the events that follow an invalidation.
 *
 * The cascade computed *which* records are affected; this computes *what
 * happens to them*, and the log records it.
 */
export function planInvalidationEvents(input: InvalidationEventInput): InvalidationEventPlan {
  const events: WorkerEventDraft[] = [];
  const rejected: RejectedTransition[] = [];
  const staleDecisions: string[] = [];

  const byId = new Map((input.decisions ?? []).map((d) => [d.id, d]));

  // ── The stale decisions ─────────────────────────────────────────────────
  // Sorted by id, so the event stream is the same whatever order the
  // cascade produced the ids in.
  for (const decisionId of [...input.result.staleDecisions].sort()) {
    const decision = byId.get(decisionId);
    const evidenceIds = decision?.supportingEvidence ?? [];
    const draft: Omit<WorkerEvent, "id" | "sequence"> = {
      contractVersion: CONTRACT_VERSION,
      at: input.at,
      actor: input.actor,
      kind: "DECISION_STALED",
      subject: decisionId,
      payload: {
        reason: input.reason ?? "the supporting evidence changed",
        trigger: input.result.trigger,
        ...(evidenceIds.length > 0 ? { evidenceIds: [...evidenceIds] } : {}),
        ...(decision ? { contractId: decision.contractId } : {}),
      },
    };
    events.push({ ...draft, id: eventIdOf(draft) });
    staleDecisions.push(decisionId);
  }

  // ── The reopened work ───────────────────────────────────────────────────
  const reopenedWork: string[] = [];
  for (const contractId of [...input.result.reopenedWork].sort()) {
    const state = input.states?.get(contractId);
    const from: WorkerPhase | undefined = state?.phase;
    if (from === undefined) {
      rejected.push({
        sequence: 0,
        from: "NEW",
        to: "REOPENED",
        reason: `the phase of "${contractId}" is unknown, so the transition to REOPENED cannot be verified as legal`,
      });
      continue;
    }
    if (!isLegalTransition(from, "REOPENED")) {
      rejected.push({
        sequence: 0,
        from,
        to: "REOPENED",
        reason: `illegal transition ${from} -> REOPENED`,
      });
      continue;
    }
    const draft: Omit<WorkerEvent, "id" | "sequence"> = {
      contractVersion: CONTRACT_VERSION,
      at: input.at,
      actor: input.actor,
      kind: "STATE_TRANSITION",
      subject: contractId,
      // `payload.to` is the convention the existing state fold reads.
      payload: { to: "REOPENED", from },
    };
    events.push({ ...draft, id: eventIdOf(draft) });
    reopenedWork.push(contractId);
  }

  return { events, rejected, staleDecisions, reopenedWork };
}

// ── The restore step ───────────────────────────────────────────────────────

export interface RestorationInput {
  /** The evidence that was replaced. */
  readonly superseded: string;
  /** The evidence that replaces it. */
  readonly replacement: string;
  /**
   * The decisions to consider.
   *
   * Only those resting on the superseded evidence are re-grounded; the rest
   * are left exactly as they were.
   */
  readonly decisions?: readonly Decision[];
  /**
   * The evidence that is currently `INVALIDATED`.
   *
   * **Required.** A decision is stale iff some supporting evidence is
   * invalidated, so re-grounding it does not clear its staleness unless the
   * caller can show that nothing else is invalidated. An unknown set is not
   * an empty set.
   */
  readonly invalidatedEvidence: ReadonlySet<string>;
  /** The instant the events carry. */
  readonly at: string;
  /** Who produced them. */
  readonly actor: string;
  /** Why the replacement stands in. */
  readonly reason?: string;
}

export interface RestorationPlan {
  /** The events to append, in order. */
  readonly events: readonly WorkerEventDraft[];
  /** The decisions that were re-grounded on the replacement. */
  readonly regrounded: readonly string[];
  /**
   * The decisions that were NOT re-grounded, and why.
   *
   * Reported, never silently skipped: a decision that stays stale after a
   * replacement is a fact the operator needs.
   */
  readonly untouched: readonly { readonly id: string; readonly reason: string }[];
}

/**
 * Propose the events that follow a replacement.
 *
 * ── What "replacement evidence restores validity" means, precisely ───────
 *
 * The clause is eleven words long and the repository never defined it (see
 * `docs/DECISIONS.md` D-053). The reading this implements is the one the
 * **frozen contracts** permit, and no other:
 *
 * - A record's `validity` cannot be both `INVALIDATED` and `SUPERSEDED` —
 *   the `EvidenceSchema` refinement forbids it. So the replacement is a
 *   **flip**: the old evidence goes `INVALIDATED → SUPERSEDED` with
 *   `supersededBy` pointing at the new record, and the new record is
 *   `VALID` from birth.
 * - A decision's **validity** was never touched by the invalidation: what
 *   changed was its **derived staleness**, which is a separate axis and a
 *   separate field. So "restores validity" cannot mean the decision's
 *   validity, which was never invalidated.
 * - What is restored is therefore the decision's **support**: the decision
 *   is re-grounded on the replacement, and with no invalidated evidence left
 *   under it, its derived staleness is false again.
 *
 * The re-grounding is a `DECISION_RECORDED` event, because the event kind
 * enum is closed and `DECISION_RECORDED` already means *"here is the
 * decision"*. A new `DECISION_RESTORED` kind would widen a frozen contract
 * to say something the existing kind already says.
 */
export function planRestoration(input: RestorationInput): RestorationPlan {
  const events: WorkerEventDraft[] = [];
  const regrounded: string[] = [];
  const untouched: { id: string; reason: string }[] = [];

  // ── The supersession ────────────────────────────────────────────────────
  const supersession: Omit<WorkerEvent, "id" | "sequence"> = {
    contractVersion: CONTRACT_VERSION,
    at: input.at,
    actor: input.actor,
    kind: "EVIDENCE_SUPERSEDED",
    subject: input.superseded,
    payload: {
      supersededBy: input.replacement,
      reason: input.reason ?? "the evidence was replaced by a newer record",
    },
  };
  events.push({ ...supersession, id: eventIdOf(supersession) });

  // ── The re-grounded decisions ───────────────────────────────────────────
  for (const decision of [...(input.decisions ?? [])].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!decision.supportingEvidence.includes(input.superseded)) {
      untouched.push({ id: decision.id, reason: "it does not rest on the superseded evidence" });
      continue;
    }
    // Re-point the support: the replaced record gives way to its
    // replacement, and the history stays in the log rather than in the
    // record.
    const support = decision.supportingEvidence.map((e) => (e === input.superseded ? input.replacement : e));
    const remainingInvalidated = support.filter((e) => input.invalidatedEvidence.has(e));
    if (remainingInvalidated.length > 0) {
      untouched.push({
        id: decision.id,
        reason: `it still rests on invalidated evidence (${remainingInvalidated.join(", ")})`,
      });
      continue;
    }
    const updated = DecisionSchema.parse({
      ...decision,
      supportingEvidence: [...new Set(support)],
      stale: false,
    });
    const draft: Omit<WorkerEvent, "id" | "sequence"> = {
      contractVersion: CONTRACT_VERSION,
      at: input.at,
      actor: input.actor,
      kind: "DECISION_RECORDED",
      subject: decision.id,
      payload: { decision: updated },
    };
    events.push({ ...draft, id: eventIdOf(draft) });
    regrounded.push(decision.id);
  }

  return { events, regrounded, untouched };
}
