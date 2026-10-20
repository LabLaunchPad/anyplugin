/**
 * The Verification Engine (M7).
 *
 * M7's acceptance criterion, verbatim: *"Every verifier returns
 * `PASS`/`FAIL`/`BLOCKED`; false-positive-resistance test proves missing
 * evidence never becomes `PASS`."*
 */
import { describe, it, expect } from "vitest";
import { CONTRACT_VERSION, EvidenceSchema, type Evidence, type WorkerEvent } from "../contracts/index.js";
import { foldEvidence, type EvidenceProjection } from "../log/evidence.js";
import {
  dependencyConsistencyClaim,
  evidenceIntegrityClaim,
  graphConsistencyClaim,
  verify,
  type VerificationClaim,
} from "./index.js";

const AT = "2026-10-20T00:00:00Z";
const ACTOR = "process:test";

function evidence(id: string, validity: Evidence["validity"] = "VALID"): Evidence {
  return EvidenceSchema.parse({
    id,
    contractVersion: CONTRACT_VERSION,
    kind: "TEST_RESULT",
    source: "pnpm test",
    // The content hash must be lowercase hex, so the id is hex-encoded
    // rather than used directly.
    contentHash: `sha256:${Buffer.from(id, "utf8").toString("hex").padEnd(64, "0").slice(0, 64)}`,
    authority: "AUTHORITATIVE",
    provenance: { by: ACTOR, at: AT },
    validity,
    // The contract's own refinements: a record is INVALIDATED exactly when
    // it says why, and SUPERSEDED exactly when it names its replacement.
    ...(validity === "INVALIDATED" ? { invalidationReason: "the run was on a stale checkout" } : {}),
    ...(validity === "SUPERSEDED" ? { supersededBy: "EV-9" } : {}),
  });
}

function ledger(records: Evidence[]): Map<string, EvidenceProjection> {
  const events: WorkerEvent[] = records.map((record, i) => ({
    contractVersion: CONTRACT_VERSION,
    at: AT,
    actor: ACTOR,
    kind: "EVIDENCE_ADDED",
    id: `EVT-added-${record.id}`,
    sequence: i,
    subject: record.id,
    payload: { evidence: record },
  }));
  return foldEvidence(events).evidence;
}

/** A claim that needs `EV-1` and holds when the evidence is present. */
const needsEvidence: VerificationClaim = {
  requires: ["EV-1"],
  check: (found) => ({ holds: found.has("EV-1"), observations: ["checked"] }),
};

describe("M7 — the Verification Engine", () => {
  it("returns PASS when the evidence is present and the check holds", () => {
    const { result } = verify({
      id: "VER-1",
      verifierId: "test",
      claim: needsEvidence,
      evidence: ledger([evidence("EV-1")]),
      at: AT,
      actor: ACTOR,
    });
    expect(result.outcome).toBe("PASS");
  });

  it("returns FAIL when the check does not hold, and states why", () => {
    const { result } = verify({
      id: "VER-1",
      verifierId: "test",
      claim: { requires: ["EV-1"], check: () => ({ holds: false, reason: "the suite failed" }) },
      evidence: ledger([evidence("EV-1")]),
      at: AT,
      actor: ACTOR,
    });
    expect(result.outcome).toBe("FAIL");
    expect(result.reason, "a FAIL must state a reason").toBe("the suite failed");
  });

  it("NEVER converts missing evidence into PASS", () => {
    // THE false-positive-resistance test. A check that could not run is not
    // a check that passed.
    const { result, blockedBy } = verify({
      id: "VER-1",
      verifierId: "test",
      claim: needsEvidence,
      evidence: ledger([]),
      at: AT,
      actor: ACTOR,
    });
    expect(result.outcome).toBe("BLOCKED");
    expect(result.outcome).not.toBe("PASS");
    expect(blockedBy).toEqual(["EV-1"]);
    expect(result.reason, "a BLOCKED must state a reason").toMatch(/absent/);
  });

  it("NEVER converts INVALIDATED evidence into PASS", () => {
    // The interlock with the invalidation engine: the evidence is there,
    // but it should no longer be relied on, so the claim cannot be checked.
    const { result, blockedBy } = verify({
      id: "VER-1",
      verifierId: "test",
      claim: needsEvidence,
      evidence: ledger([evidence("EV-1", "INVALIDATED")]),
      at: AT,
      actor: ACTOR,
    });
    expect(result.outcome).toBe("BLOCKED");
    expect(result.outcome).not.toBe("PASS");
    expect(blockedBy).toEqual(["EV-1"]);
  });

  it("NEVER converts SUPERSEDED evidence into PASS", () => {
    const { result } = verify({
      id: "VER-1",
      verifierId: "test",
      claim: needsEvidence,
      evidence: ledger([evidence("EV-1", "SUPERSEDED")]),
      at: AT,
      actor: ACTOR,
    });
    expect(result.outcome).toBe("BLOCKED");
  });

  it("binds the inputs it checked on a PASS", () => {
    const { result } = verify({
      id: "VER-1",
      verifierId: "test",
      claim: needsEvidence,
      evidence: ledger([evidence("EV-1")]),
      at: AT,
      actor: ACTOR,
    });
    expect(result.inputHashes.length, "a PASS must bind its inputs").toBe(1);
  });

  it("binds NOTHING on a BLOCKED — there was nothing to check against", () => {
    const { result } = verify({
      id: "VER-1",
      verifierId: "test",
      claim: needsEvidence,
      evidence: ledger([]),
      at: AT,
      actor: ACTOR,
    });
    expect(result.inputHashes).toEqual([]);
  });

  it("records the verification as an event, so it is replayable", () => {
    const { event } = verify({
      id: "VER-1",
      verifierId: "test",
      claim: needsEvidence,
      evidence: ledger([evidence("EV-1")]),
      at: AT,
      actor: ACTOR,
    });
    expect(event.kind).toBe("VERIFICATION_RUN");
    expect(event.subject).toBe("VER-1");
    expect(event.payload["verification"]).toBeDefined();
  });

  it("is deterministic: the same input produces the same result", () => {
    const input = {
      id: "VER-1",
      verifierId: "test",
      claim: needsEvidence,
      evidence: ledger([evidence("EV-1")]),
      at: AT,
      actor: ACTOR,
    };
    const a = verify(input);
    const b = verify(input);
    expect(b.result).toEqual(a.result);
    expect(b.event.id).toBe(a.event.id);
  });
});

describe("the initial verifiers", () => {
  it("graph consistency: every edge must name a node that exists", () => {
    const { result } = verify({
      id: "VER-2",
      verifierId: "graph-consistency",
      claim: graphConsistencyClaim({
        contractVersion: CONTRACT_VERSION,
        at: AT,
        nodes: [{ id: "ND-A", kind: "FILE", ref: "a.ts" }],
        edges: [{ from: "ND-A", kind: "IMPORTS", to: "ND-GONE" }],
      }),
      evidence: new Map(),
      at: AT,
      actor: ACTOR,
    });
    expect(result.outcome).toBe("FAIL");
    expect(result.reason).toMatch(/does not exist/);
  });

  it("graph consistency: a consistent graph PASSES", () => {
    const { result } = verify({
      id: "VER-2",
      verifierId: "graph-consistency",
      claim: graphConsistencyClaim({
        contractVersion: CONTRACT_VERSION,
        at: AT,
        nodes: [
          { id: "ND-A", kind: "FILE", ref: "a.ts" },
          { id: "ND-B", kind: "FILE", ref: "b.ts" },
        ],
        edges: [{ from: "ND-A", kind: "IMPORTS", to: "ND-B" }],
      }),
      evidence: new Map(),
      at: AT,
      actor: ACTOR,
    });
    expect(result.outcome).toBe("PASS");
  });

  it("evidence integrity: a decision resting on invalidated evidence is BLOCKED", () => {
    // The mechanism that makes the invalidation engine bite: invalidate the
    // evidence, and the decision's verification stops being a PASS.
    const decisions = new Map([
      [
        "DEC-1",
        {
          id: "DEC-1",
          contractId: "WC-1",
          validity: "VALID" as const,
          stale: false,
          supportingEvidence: ["EV-1"],
        },
      ],
    ]);
    const { result } = verify({
      id: "VER-3",
      verifierId: "evidence-integrity",
      claim: evidenceIntegrityClaim(decisions),
      evidence: ledger([evidence("EV-1", "INVALIDATED")]),
      at: AT,
      actor: ACTOR,
    });
    expect(result.outcome).toBe("BLOCKED");
  });

  it("dependency consistency: a decision resting on no evidence FAILS", () => {
    const decisions = new Map([
      [
        "DEC-1",
        {
          id: "DEC-1",
          contractId: "WC-1",
          validity: "VALID" as const,
          stale: false,
          supportingEvidence: [],
        },
      ],
    ]);
    const { result } = verify({
      id: "VER-4",
      verifierId: "dependency-consistency",
      claim: dependencyConsistencyClaim(decisions),
      evidence: new Map(),
      at: AT,
      actor: ACTOR,
    });
    expect(result.outcome).toBe("FAIL");
  });
});
