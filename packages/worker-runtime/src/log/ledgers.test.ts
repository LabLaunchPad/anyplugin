/**
 * The ledgers — M3 (Evidence) and M4 (Decision + Experience).
 *
 * The acceptance criteria, verbatim:
 *
 * - **M3:** *"Invalidating E1 preserves history *and* flips current validity;
 *   immutability test"*
 * - **M4:** *"the `OBSERVATION` / `LESSON` / `HYPOTHESIS` / `VERIFIED_KNOWLEDGE`
 *   distinction proven by test — a lesson must **never** auto-promote to
 *   authoritative evidence"*
 */
import { describe, it, expect } from "vitest";
import {
  CONTRACT_VERSION,
  DecisionSchema,
  EvidenceSchema,
  ExperienceSchema,
  type WorkerEvent,
} from "../contracts/index.js";
import { foldDecisions } from "./decisions.js";
import { foldEvidence, invalidatedEvidence, usableEvidence } from "./evidence.js";
import { foldExperience, planPromotion } from "./experience.js";

const AT = "2026-10-20T00:00:00Z";
const ACTOR = "process:test";

/** An evidence record. */
const EVIDENCE = EvidenceSchema.parse({
  id: "EV-1",
  contractVersion: CONTRACT_VERSION,
  kind: "TEST_RESULT",
  source: "pnpm test",
  contentHash: `sha256:${"a".repeat(64)}`,
  authority: "AUTHORITATIVE",
  provenance: { by: ACTOR, at: AT },
  validity: "VALID",
});

/** An experience, at the OBSERVATION rung. */
const EXPERIENCE = ExperienceSchema.parse({
  id: "EXP-1",
  contractVersion: CONTRACT_VERSION,
  contractId: "WC-1",
  action: "pnpm test",
  outcome: "FAILURE",
  failureClass: "TOOL",
  lesson: "the test command needs the dist build first",
  rung: "OBSERVATION",
  evidence: ["EV-1"],
  confidence: 0.4,
  provenance: { by: ACTOR, at: AT },
});

function added(kind: WorkerEvent["kind"], subject: string, payload: Record<string, unknown>, sequence = 0): WorkerEvent {
  return {
    contractVersion: CONTRACT_VERSION,
    at: AT,
    actor: ACTOR,
    kind,
    id: `EVT-${kind}-${subject}-${sequence}`,
    sequence,
    subject,
    payload,
  };
}

describe("M3 — the Evidence Ledger", () => {
  it("projects a record that was added", () => {
    const { evidence } = foldEvidence([added("EVIDENCE_ADDED", "EV-1", { evidence: EVIDENCE })]);
    expect(evidence.get("EV-1")?.validity).toBe("VALID");
    expect(evidence.get("EV-1")?.contentHash).toBe(EVIDENCE.contentHash);
  });

  it("flips the CURRENT validity when the record is invalidated", () => {
    const { evidence } = foldEvidence([
      added("EVIDENCE_ADDED", "EV-1", { evidence: EVIDENCE }),
      added("EVIDENCE_INVALIDATED", "EV-1", { reason: "the run was on a stale checkout" }, 1),
    ]);
    expect(evidence.get("EV-1")?.validity).toBe("INVALIDATED");
    expect(evidence.get("EV-1")?.invalidationReason).toBe("the run was on a stale checkout");
  });

  it("PRESERVES THE HISTORY: only the validity changes", () => {
    // The M3 acceptance criterion, in one test. A record is immutable: the
    // source, the hash and the authority are the same before and after, and
    // only `validity` moved.
    const before = foldEvidence([added("EVIDENCE_ADDED", "EV-1", { evidence: EVIDENCE })]).evidence.get("EV-1")!;
    const after = foldEvidence([
      added("EVIDENCE_ADDED", "EV-1", { evidence: EVIDENCE }),
      added("EVIDENCE_INVALIDATED", "EV-1", { reason: "stale" }, 1),
    ]).evidence.get("EV-1")!;

    expect(after.source).toBe(before.source);
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.authority).toBe(before.authority);
    expect(after.kind).toBe(before.kind);
    expect(after.validity).not.toBe(before.validity);
  });

  it("flips to SUPERSEDED when a newer record replaces it", () => {
    const { evidence } = foldEvidence([
      added("EVIDENCE_ADDED", "EV-1", { evidence: EVIDENCE }),
      added("EVIDENCE_SUPERSEDED", "EV-1", { supersededBy: "EV-2" }, 1),
    ]);
    expect(evidence.get("EV-1")?.validity).toBe("SUPERSEDED");
    expect(evidence.get("EV-1")?.supersededBy).toBe("EV-2");
  });

  it("never invents a record it has not seen", () => {
    // An invalidation for a record the log never held. The fold does not
    // conjure the record it cannot see.
    const { evidence, rejected } = foldEvidence([
      added("EVIDENCE_INVALIDATED", "EV-9", { reason: "stale" }),
    ]);
    expect(evidence.has("EV-9")).toBe(false);
    expect(rejected).toEqual(["EV-9"]);
  });

  it("records a malformed record rather than coercing it", () => {
    const { rejected } = foldEvidence([added("EVIDENCE_ADDED", "EV-1", { evidence: { id: "EV-1" } })]);
    expect(rejected).toEqual(["EV-1"]);
  });

  it("separates the usable evidence from the unusable", () => {
    const { evidence } = foldEvidence([
      added("EVIDENCE_ADDED", "EV-1", { evidence: EVIDENCE }),
      added("EVIDENCE_INVALIDATED", "EV-1", { reason: "stale" }, 1),
    ]);
    expect([...usableEvidence(evidence).keys()]).toEqual([]);
    expect([...invalidatedEvidence(evidence)]).toEqual(["EV-1"]);
  });
});

describe("M4 — the Experience Ledger", () => {
  it("projects a record that was added", () => {
    const { experiences } = foldExperience([
      added("EXPERIENCE_RECORDED", "EXP-1", { experience: EXPERIENCE }),
    ]);
    expect(experiences.get("EXP-1")?.rung).toBe("OBSERVATION");
    expect(experiences.get("EXP-1")?.lesson).toBe(EXPERIENCE.lesson);
  });

  it("NEVER auto-promotes: the fold alone cannot advance a rung", () => {
    // THE M4 acceptance criterion. Nothing in the fold moves a rung. The
    // only way up is an EXPERIENCE_PROMOTED event, which requires an actor
    // and a justification.
    const { experiences } = foldExperience([
      added("EXPERIENCE_RECORDED", "EXP-1", { experience: EXPERIENCE }),
    ]);
    expect(experiences.get("EXP-1")?.rung).toBe("OBSERVATION");
    // And a record that arrives already high is projected where it arrived —
    // the fold does not promote it further, and it does not demote it.
    const high = ExperienceSchema.parse({ ...EXPERIENCE, rung: "LESSON" });
    const projected = foldExperience([
      added("EXPERIENCE_RECORDED", "EXP-1", { experience: high }),
    ]).experiences.get("EXP-1");
    expect(projected?.rung).toBe("LESSON");
  });

  it("promotes by exactly one rung", () => {
    const observation = foldExperience([
      added("EXPERIENCE_RECORDED", "EXP-1", { experience: EXPERIENCE }),
    ]).experiences.get("EXP-1")!;

    const up = planPromotion({
      experience: observation,
      to: "LESSON",
      justification: "the same failure recurred three times",
      at: AT,
      actor: ACTOR,
    });
    expect(up.refused).toBeUndefined();
    expect(up.event?.kind).toBe("EXPERIENCE_PROMOTED");
    expect(up.event?.payload["to"]).toBe("LESSON");
  });

  it("REFUSES a promotion that skips a rung", () => {
    const observation = foldExperience([
      added("EXPERIENCE_RECORDED", "EXP-1", { experience: EXPERIENCE }),
    ]).experiences.get("EXP-1")!;

    const skip = planPromotion({
      experience: observation,
      to: "HYPOTHESIS",
      justification: "it felt right",
      at: AT,
      actor: ACTOR,
    });
    expect(skip.refused).toMatch(/exactly one rung/);
    expect(skip.event).toBeUndefined();
  });

  it("REFUSES a demotion and a lateral move", () => {
    const observation = foldExperience([
      added("EXPERIENCE_RECORDED", "EXP-1", { experience: EXPERIENCE }),
    ]).experiences.get("EXP-1")!;

    const down = planPromotion({
      experience: observation,
      to: "OBSERVATION",
      justification: "changed my mind",
      at: AT,
      actor: ACTOR,
    });
    expect(down.refused).toMatch(/must go UP/);
  });

  it("REFUSES VERIFIED_KNOWLEDGE without evidence", () => {
    // The core constraint: a lesson never auto-promotes to authoritative
    // knowledge, and authoritative knowledge cites its evidence.
    const observation = foldExperience([
      added("EXPERIENCE_RECORDED", "EXP-1", { experience: EXPERIENCE }),
    ]).experiences.get("EXP-1")!;

    const noEvidence = planPromotion({
      experience: { ...observation, rung: "HYPOTHESIS" },
      to: "VERIFIED_KNOWLEDGE",
      justification: "I am confident",
      at: AT,
      actor: ACTOR,
    });
    expect(noEvidence.refused).toMatch(/requires supporting evidence/);
    expect(noEvidence.event).toBeUndefined();
  });

  it("REFUSES a promotion without a justification", () => {
    const observation = foldExperience([
      added("EXPERIENCE_RECORDED", "EXP-1", { experience: EXPERIENCE }),
    ]).experiences.get("EXP-1")!;

    const unjustified = planPromotion({
      experience: observation,
      to: "LESSON",
      justification: "   ",
      at: AT,
      actor: ACTOR,
    });
    expect(unjustified.refused).toMatch(/justification/);
  });

  it("applies a promotion when it is replayed", () => {
    const promotion = planPromotion({
      experience: foldExperience([
        added("EXPERIENCE_RECORDED", "EXP-1", { experience: EXPERIENCE }),
      ]).experiences.get("EXP-1")!,
      to: "LESSON",
      justification: "the same failure recurred three times",
      at: AT,
      actor: ACTOR,
    });
    const { experiences } = foldExperience([
      added("EXPERIENCE_RECORDED", "EXP-1", { experience: EXPERIENCE }),
      { ...promotion.event!, sequence: 1 },
    ]);
    expect(experiences.get("EXP-1")?.rung).toBe("LESSON");
  });
});

describe("the Decision Ledger", () => {
  it("projects a decision and its staleness", () => {
    const decision = DecisionSchema.parse({
      id: "DEC-1",
      contractVersion: CONTRACT_VERSION,
      contractId: "WC-1",
      selected: "option-a",
      supportingEvidence: ["EV-1"],
      provenance: { by: ACTOR, at: AT },
      validity: "VALID",
    });
    const { decisions } = foldDecisions([
      added("DECISION_RECORDED", "DEC-1", { decision }),
      added("DECISION_STALED", "DEC-1", { reason: "the evidence changed" }, 1),
    ]);
    expect(decisions.get("DEC-1")?.stale).toBe(true);
    expect(decisions.get("DEC-1")?.supportingEvidence).toEqual(["EV-1"]);
  });
});
