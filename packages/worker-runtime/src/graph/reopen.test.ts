/**
 * The invalidation engine — the acceptance criterion, end to end.
 *
 * The criterion, verbatim from `ROADMAP.md`:
 *
 * > E1→Claim→Decision→Work: Decision `STALE`, Work `REOPENED`, unrelated
 * > decisions untouched; replacement evidence restores validity
 *
 * These tests drive the WHOLE chain — the cascade, the event producer, and
 * the projections — because the criterion is stated over the chain's
 * behaviour, not over any one function.
 *
 * ── A note on the phases ──────────────────────────────────────────────────
 *
 * The state fold derives the current phase from the LOG, not from a payload.
 * So a test that wants to see `COMPLETED → REOPENED` has to replay the
 * history that brought the work to `COMPLETED` — which is the honest way
 * round: the fold is the authority on what phase a contract is in, and a
 * payload that merely claims it is not.
 */
import { describe, it, expect } from "vitest";
import {
  CONTRACT_VERSION,
  DecisionSchema,
  GraphSnapshotSchema,
  WorkerStateSchema,
  type Decision,
  type WorkerEvent,
  type WorkerPhase,
  type WorkerState,
} from "../contracts/index.js";
import { foldDecisions, invalidatedEvidenceIds } from "../log/decisions.js";
import { foldWorkerState } from "../log/worker-state.js";
import { computeInvalidation } from "./invalidation.js";
import { planInvalidationEvents, planRestoration, type WorkerEventDraft } from "./reopen.js";

const AT = "2026-10-20T00:00:00Z";
const ACTOR = "process:invalidation-engine";

/**
 * The chain: E1 → Claim → Decision → Work, plus an unrelated decision on
 * unrelated evidence, and an unrelated work contract.
 */
const CHAIN = GraphSnapshotSchema.parse({
  contractVersion: CONTRACT_VERSION,
  at: AT,
  nodes: [
    { id: "ND-E1", kind: "EVIDENCE", ref: "EV-1" },
    { id: "ND-C1", kind: "CLAIM", ref: "CLAIM-1" },
    { id: "ND-D1", kind: "DECISION", ref: "DEC-1" },
    { id: "ND-W1", kind: "WORK_ITEM", ref: "WC-1" },
    { id: "ND-E2", kind: "EVIDENCE", ref: "EV-2" },
    { id: "ND-D2", kind: "DECISION", ref: "DEC-2" },
    { id: "ND-W2", kind: "WORK_ITEM", ref: "WC-2" },
  ],
  edges: [
    { from: "ND-C1", kind: "SUPPORTS", to: "ND-E1" },
    { from: "ND-D1", kind: "SUPPORTS", to: "ND-C1" },
    { from: "ND-W1", kind: "DEPENDS_ON", to: "ND-D1" },
    { from: "ND-D2", kind: "SUPPORTS", to: "ND-E2" },
    { from: "ND-W2", kind: "DEPENDS_ON", to: "ND-D2" },
  ],
});

/** The decision that rests on E1. */
const DECISION_1 = DecisionSchema.parse({
  id: "DEC-1",
  contractVersion: CONTRACT_VERSION,
  contractId: "WC-1",
  selected: "option-a",
  supportingEvidence: ["EV-1"],
  assumptions: [],
  provenance: { by: ACTOR, at: AT },
  validity: "VALID",
});

/** The decision that rests on E2 — unrelated to the invalidation. */
const DECISION_2 = DecisionSchema.parse({
  id: "DEC-2",
  contractVersion: CONTRACT_VERSION,
  contractId: "WC-2",
  selected: "option-b",
  supportingEvidence: ["EV-2"],
  assumptions: [],
  provenance: { by: ACTOR, at: AT },
  validity: "VALID",
});

/** A work contract in a phase. */
function state(contractId: string, phase: WorkerPhase): WorkerState {
  return WorkerStateSchema.parse({
    id: `WS-${contractId.replace(/^WC-/, "")}`,
    contractVersion: CONTRACT_VERSION,
    contractId,
    phase,
    assumptions: [],
    revision: 3,
    updatedAt: AT,
  });
}

/** The event history that brings a work contract to a phase. */
function historyTo(contractId: string, phase: WorkerPhase): WorkerEvent[] {
  const path: WorkerPhase[] =
    phase === "COMPLETED"
      ? ["PLANNING", "EXECUTING", "VERIFYING", "COMPLETED"]
      : phase === "FAILED"
        ? ["PLANNING", "FAILED"]
        : [phase];
  return path.map((to, i) => ({
    contractVersion: CONTRACT_VERSION,
    at: AT,
    actor: ACTOR,
    kind: "STATE_TRANSITION" as const,
    id: `EVT-history-${contractId.replace(/[^A-Za-z0-9]/g, "")}-${i}`,
    sequence: i,
    subject: contractId,
    payload: { to },
  }));
}

/** Give the log's sequence to a plan's drafts. */
function sequenced(drafts: readonly WorkerEventDraft[], start = 0): WorkerEvent[] {
  return drafts.map((d, i) => ({ ...d, sequence: start + i }));
}

/** The events the whole chain produces, from an invalidation of E1. */
function invalidateE1(phase: WorkerPhase = "COMPLETED") {
  const { result } = computeInvalidation(CHAIN, {
    trigger: "ND-E1",
    at: AT,
    decisions: [
      { id: "DEC-1", contractId: "WC-1", supportingEvidence: ["EV-1"] },
      { id: "DEC-2", contractId: "WC-2", supportingEvidence: ["EV-2"] },
    ],
  });
  const plan = planInvalidationEvents({
    result,
    decisions: [DECISION_1, DECISION_2],
    states: new Map([
      ["WC-1", state("WC-1", phase)],
      ["WC-2", state("WC-2", "COMPLETED")],
    ]),
    at: AT,
    actor: ACTOR,
    reason: "the upstream evidence no longer holds",
  });
  return { result, plan };
}

describe("the invalidation engine — M6's acceptance criterion", () => {
  it("marks the dependent decision STALE", () => {
    const { plan } = invalidateE1();
    const folded = foldDecisions(sequenced(plan.events));
    expect(folded.decisions.get("DEC-1")?.stale, "the dependent decision must be stale").toBe(true);
  });

  it("reopens the dependent work", () => {
    const { plan } = invalidateE1();
    // The fold derives the phase from the log, so the history has to be
    // replayed — a payload that merely claims COMPLETED is not a phase.
    const events = [...historyTo("WC-1", "COMPLETED"), ...sequenced(plan.events, 4)];
    const folded = foldWorkerState(events);
    expect(folded.states.get("WC-1")?.phase, "the dependent work must be reopened").toBe("REOPENED");
    expect(folded.rejected, "nothing may be rejected").toEqual([]);
  });

  it("leaves unrelated decisions and work untouched", () => {
    // The negative half of the criterion, and the half a "flood the whole
    // component" bug would fail.
    const { plan } = invalidateE1();
    const decisions = foldDecisions(sequenced(plan.events));
    const states = foldWorkerState([...historyTo("WC-2", "COMPLETED"), ...sequenced(plan.events, 4)]);
    expect(decisions.decisions.get("DEC-2"), "the unrelated decision must not appear at all").toBeUndefined();
    expect(
      states.states.get("WC-2")?.phase,
      "the unrelated work must be left where it was — not reopened",
    ).toBe("COMPLETED");
  });

  it("produces the events in a deterministic order", () => {
    const { plan } = invalidateE1();
    expect(plan.events.map((e) => `${e.kind}:${e.subject}`)).toEqual([
      "DECISION_STALED:DEC-1",
      "STATE_TRANSITION:WC-1",
    ]);
  });

  it("is byte-identical for identical input", () => {
    const a = invalidateE1();
    const b = invalidateE1();
    expect(JSON.stringify(b.plan.events)).toBe(JSON.stringify(a.plan.events));
  });

  it("re-planning produces the SAME event ids, so appending is idempotent", () => {
    const a = invalidateE1();
    const b = invalidateE1();
    expect(b.plan.events.map((e) => e.id)).toEqual(a.plan.events.map((e) => e.id));
  });
});

describe("the phase machine is not coerced", () => {
  it("rejects a transition the machine forbids, and records it", () => {
    // `EXECUTING -> REOPENED` is not legal: a work item is reopened from a
    // TERMINAL phase, because "it was finished" is what the reopen undoes.
    const { result } = computeInvalidation(CHAIN, { trigger: "ND-E1", at: AT });
    const plan = planInvalidationEvents({
      result,
      decisions: [DECISION_1],
      states: new Map([["WC-1", state("WC-1", "EXECUTING")]]),
      at: AT,
      actor: ACTOR,
    });
    expect(
      plan.events.filter((e) => e.kind === "STATE_TRANSITION"),
      "an illegal transition must not be proposed",
    ).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toMatch(/illegal transition/);
  });

  it("refuses a transition whose current phase is unknown", () => {
    // An unverifiable transition is refused, not assumed. "Probably legal"
    // is not "legal".
    const { result } = computeInvalidation(CHAIN, { trigger: "ND-E1", at: AT });
    const plan = planInvalidationEvents({
      result,
      decisions: [DECISION_1],
      states: new Map(),
      at: AT,
      actor: ACTOR,
    });
    expect(plan.events.filter((e) => e.kind === "STATE_TRANSITION")).toEqual([]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toMatch(/unknown/);
  });

  it("reopens a FAILED work contract, which the machine also permits", () => {
    const { result } = computeInvalidation(CHAIN, { trigger: "ND-E1", at: AT });
    const plan = planInvalidationEvents({
      result,
      decisions: [DECISION_1],
      states: new Map([["WC-1", state("WC-1", "FAILED")]]),
      at: AT,
      actor: ACTOR,
    });
    expect(plan.reopenedWork).toEqual(["WC-1"]);
  });
});

describe("the restore step — replacement evidence restores validity", () => {
  /** The events the whole chain produces, from an invalidation then a replacement. */
  function invalidateThenReplace() {
    const { plan } = invalidateE1();
    const invalidationEvent: WorkerEvent = {
      contractVersion: CONTRACT_VERSION,
      at: AT,
      actor: ACTOR,
      kind: "EVIDENCE_INVALIDATED",
      id: "EVT-invalidated-ev1",
      sequence: 0,
      subject: "EV-1",
      payload: { reason: "the upstream evidence no longer holds" },
    };
    const restoration = planRestoration({
      superseded: "EV-1",
      replacement: "EV-9",
      decisions: [DECISION_1, DECISION_2],
      invalidatedEvidence: invalidatedEvidenceIds([invalidationEvent]),
      at: AT,
      actor: ACTOR,
      reason: "EV-9 supersedes EV-1",
    });
    return { plan, restoration, invalidationEvent };
  }

  it("re-grounds the decision on the replacement, and it is no longer stale", () => {
    const { plan, restoration, invalidationEvent } = invalidateThenReplace();
    const events = [
      ...sequenced(plan.events),
      invalidationEvent,
      ...sequenced(restoration.events, 10),
    ];
    const folded = foldDecisions(events);
    expect(folded.decisions.get("DEC-1")?.stale, "the decision must no longer be stale").toBe(false);
    expect(folded.decisions.get("DEC-1")?.supportingEvidence).toEqual(["EV-9"]);
  });

  it("records the supersession on the OLD evidence", () => {
    const { restoration } = invalidateThenReplace();
    const supersession = restoration.events.find((e) => e.kind === "EVIDENCE_SUPERSEDED");
    expect(supersession?.subject, "the subject is the evidence that was replaced").toBe("EV-1");
    expect(supersession?.payload["supersededBy"]).toBe("EV-9");
  });

  it("leaves an unrelated decision alone, and says so", () => {
    const { restoration } = invalidateThenReplace();
    expect(restoration.regrounded).toEqual(["DEC-1"]);
    expect(restoration.untouched.some((u) => u.id === "DEC-2")).toBe(true);
  });

  it("does NOT clear the staleness when other evidence is still invalidated", () => {
    // The decision rests on E1 AND E3, and E3 is still invalidated. The
    // replacement fixes one of them, not the decision.
    const decision = DecisionSchema.parse({
      ...DECISION_1,
      supportingEvidence: ["EV-1", "EV-3"],
    });
    const restoration = planRestoration({
      superseded: "EV-1",
      replacement: "EV-9",
      decisions: [decision],
      invalidatedEvidence: new Set(["EV-3"]),
      at: AT,
      actor: ACTOR,
    });
    expect(restoration.regrounded, "the decision must NOT be re-grounded").toEqual([]);
    expect(restoration.untouched[0]?.reason).toMatch(/invalidated evidence/);
  });

  it("is byte-identical for identical input", () => {
    const a = invalidateThenReplace();
    const b = invalidateThenReplace();
    expect(JSON.stringify(b.restoration.events)).toBe(JSON.stringify(a.restoration.events));
  });
});
