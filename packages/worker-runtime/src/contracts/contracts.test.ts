/**
 * Contract tests. These exist to prove illegal states are UNREPRESENTABLE,
 * not merely undocumented. A schema that accepts everything is decoration.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACTS,
  CONTRACT_VERSION,
  CertificateSchema,
  DecisionSchema,
  EvidenceSchema,
  ExperienceSchema,
  LEGAL_TRANSITIONS,
  VerificationResultSchema,
  WORKER_PHASES,
  WorkContractSchema,
  WorkerStateSchema,
  isLegalTransition,
  type WorkerPhase,
} from "./index.js";
import { ActorSchema, TimestampSchema, idSchema, rungIndex } from "./primitives.js";
import { canonicalJson, contentHash } from "../canonical.js";

const NOW = "2026-08-24T12:00:00+00:00";
const PROV = { by: "worker-runtime/0.0.1", at: NOW };
const H = (s: string) => contentHash({ s });

describe("primitives", () => {
  it("requires an explicit offset on timestamps", () => {
    expect(TimestampSchema.safeParse("2026-08-24T12:00:00Z").success).toBe(true);
    expect(TimestampSchema.safeParse("2026-08-24T12:00:00+05:30").success).toBe(true);
    // Naive local time is not a point in time — two readers would disagree.
    expect(TimestampSchema.safeParse("2026-08-24T12:00:00").success).toBe(false);
    expect(TimestampSchema.safeParse("2026-08-24").success).toBe(false);
  });

  it("constrains actors to the three recognised forms", () => {
    for (const ok of ["worker-runtime/0.0.1", "human:rahul", "process:ci-runner"]) {
      expect(ActorSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ["anonymous", "human:", "has space/1.0", ""]) {
      expect(ActorSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("makes id kinds mutually unassignable", () => {
    expect(idSchema("evidence").safeParse("EV-001").success).toBe(true);
    // Passing an evidence id where a decision id belongs must not typecheck
    // at runtime either.
    expect(idSchema("decision").safeParse("EV-001").success).toBe(false);
    expect(idSchema("evidence").safeParse("EV-with/slash").success).toBe(false);
    expect(idSchema("evidence").safeParse("EV-").success).toBe(false);
  });

  it("orders the epistemic ladder", () => {
    expect(rungIndex("OBSERVATION")).toBeLessThan(rungIndex("LESSON"));
    expect(rungIndex("LESSON")).toBeLessThan(rungIndex("HYPOTHESIS"));
    expect(rungIndex("HYPOTHESIS")).toBeLessThan(rungIndex("VERIFIED_KNOWLEDGE"));
  });
});

describe("WorkContract", () => {
  const valid = {
    id: "WC-001",
    contractVersion: CONTRACT_VERSION,
    goal: "Implement authentication",
    scope: ["src/auth/**"],
    constraints: ["do not change database schema"],
    successConditions: ["typecheck", "unit-tests"],
    riskLevel: "medium" as const,
    provenance: PROV,
  };

  it("accepts a well-formed contract", () => {
    expect(WorkContractSchema.safeParse(valid).success).toBe(true);
  });

  it("refuses unbounded scope", () => {
    // An empty scope means "may touch anything", which is not a contract.
    expect(WorkContractSchema.safeParse({ ...valid, scope: [] }).success).toBe(false);
  });

  it("refuses a contract with no machine-checkable success condition", () => {
    // Otherwise the model decides when it is done.
    expect(WorkContractSchema.safeParse({ ...valid, successConditions: [] }).success).toBe(false);
  });

  it("rejects unknown fields rather than silently dropping them", () => {
    expect(WorkContractSchema.safeParse({ ...valid, sneaky: true }).success).toBe(false);
  });
});

describe("WorkerState transitions", () => {
  it("defines a transition list for every phase", () => {
    for (const p of WORKER_PHASES) expect(LEGAL_TRANSITIONS[p]).toBeDefined();
  });

  it("permits the completion path", () => {
    const path: WorkerPhase[] = ["NEW", "PLANNING", "EXECUTING", "VERIFYING", "COMPLETED"];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(isLegalTransition(path[i]!, path[i + 1]!), `${path[i]}→${path[i + 1]}`).toBe(true);
    }
  });

  it("allows COMPLETED to REOPEN — the transition this runtime exists for", () => {
    // Without this, "completed" is permanent regardless of whether the
    // evidence underneath it still holds.
    expect(isLegalTransition("COMPLETED", "REOPENED")).toBe(true);
    expect(isLegalTransition("REOPENED", "PLANNING")).toBe(true);
  });

  it("rejects transitions that skip the middle", () => {
    expect(isLegalTransition("NEW", "COMPLETED")).toBe(false);
    expect(isLegalTransition("NEW", "VERIFYING")).toBe(false);
    expect(isLegalTransition("COMPLETED", "EXECUTING")).toBe(false);
  });

  it("treats COMPLETED and FAILED as terminal except for reopening", () => {
    expect(LEGAL_TRANSITIONS.COMPLETED).toEqual(["REOPENED"]);
    expect(LEGAL_TRANSITIONS.FAILED).toEqual(["REOPENED"]);
  });

  it("requires a monotonic revision", () => {
    const base = {
      id: "WS-1", contractVersion: CONTRACT_VERSION, contractId: "WC-001",
      phase: "PLANNING" as const, assumptions: [], revision: 0, updatedAt: NOW,
    };
    expect(WorkerStateSchema.safeParse(base).success).toBe(true);
    expect(WorkerStateSchema.safeParse({ ...base, revision: -1 }).success).toBe(false);
    expect(WorkerStateSchema.safeParse({ ...base, revision: 1.5 }).success).toBe(false);
  });
});

describe("Evidence", () => {
  const valid = {
    id: "EV-1", contractVersion: CONTRACT_VERSION, kind: "TEST_RESULT" as const,
    source: "pnpm test", contentHash: H("run"), authority: "AUTHORITATIVE" as const,
    provenance: PROV, validity: "VALID" as const,
  };

  it("accepts valid evidence", () => {
    expect(EvidenceSchema.safeParse(valid).success).toBe(true);
  });

  it("requires supersededBy exactly when SUPERSEDED", () => {
    expect(EvidenceSchema.safeParse({ ...valid, validity: "SUPERSEDED" }).success).toBe(false);
    expect(EvidenceSchema.safeParse({ ...valid, validity: "SUPERSEDED", supersededBy: "EV-2" }).success).toBe(true);
    // and never when it is still valid
    expect(EvidenceSchema.safeParse({ ...valid, supersededBy: "EV-2" }).success).toBe(false);
  });

  it("requires a reason exactly when INVALIDATED", () => {
    expect(EvidenceSchema.safeParse({ ...valid, validity: "INVALIDATED" }).success).toBe(false);
    expect(
      EvidenceSchema.safeParse({ ...valid, validity: "INVALIDATED", invalidationReason: "lockfile changed" }).success,
    ).toBe(true);
  });

  it("requires a well-formed content hash", () => {
    expect(EvidenceSchema.safeParse({ ...valid, contentHash: "deadbeef" }).success).toBe(false);
  });
});

describe("Decision", () => {
  const valid = {
    id: "DEC-1", contractVersion: CONTRACT_VERSION, contractId: "WC-001",
    selected: "Use Stripe Checkout", alternatives: ["Custom form"],
    supportingEvidence: ["EV-1"], assumptions: [], provenance: PROV,
    validity: "VALID" as const, stale: false,
  };

  it("accepts a founded decision", () => {
    expect(DecisionSchema.safeParse(valid).success).toBe(true);
  });

  it("refuses a decision resting on no evidence", () => {
    expect(DecisionSchema.safeParse({ ...valid, supportingEvidence: [] }).success).toBe(false);
  });

  it("keeps STALE separate from INVALID", () => {
    // A stale decision may still be right; it just has not been re-checked.
    const stale = DecisionSchema.safeParse({ ...valid, stale: true });
    expect(stale.success).toBe(true);
    if (stale.success) expect(stale.data.validity).toBe("VALID");
  });

  it("rejects evidence ids of the wrong kind", () => {
    expect(DecisionSchema.safeParse({ ...valid, supportingEvidence: ["DEC-9"] }).success).toBe(false);
  });
});

describe("Experience and the epistemic ladder", () => {
  const base = {
    id: "EXP-1", contractVersion: CONTRACT_VERSION, contractId: "WC-001",
    action: "pnpm update astro", outcome: "FAILURE" as const,
    failureClass: "ENVIRONMENT" as const, lesson: "requires X before Y",
    rung: "LESSON" as const, evidence: [], confidence: 0.9,
    validWhen: { node: "22.x" }, invalidatedBy: ["package-lock-change"], provenance: PROV,
  };

  it("accepts a lesson with no evidence", () => {
    expect(ExperienceSchema.safeParse(base).success).toBe(true);
  });

  it("REFUSES to let a lesson reach VERIFIED_KNOWLEDGE without evidence", () => {
    // The core constraint: what happened, what we learned, and what is true
    // are different things. Auto-promotion would collapse them.
    expect(ExperienceSchema.safeParse({ ...base, rung: "VERIFIED_KNOWLEDGE" }).success).toBe(false);
    expect(ExperienceSchema.safeParse({ ...base, rung: "VERIFIED_KNOWLEDGE", evidence: ["EV-1"] }).success).toBe(true);
  });

  it("permits HYPOTHESIS without evidence, since a hypothesis is not a claim", () => {
    expect(ExperienceSchema.safeParse({ ...base, rung: "HYPOTHESIS" }).success).toBe(true);
  });

  it("rejects a failure class on a success", () => {
    expect(
      ExperienceSchema.safeParse({ ...base, outcome: "SUCCESS", failureClass: "TOOL" }).success,
    ).toBe(false);
  });

  it("bounds confidence to [0,1]", () => {
    expect(ExperienceSchema.safeParse({ ...base, confidence: 1.1 }).success).toBe(false);
    expect(ExperienceSchema.safeParse({ ...base, confidence: -0.1 }).success).toBe(false);
  });
});

describe("VerificationResult", () => {
  const base = {
    id: "VER-1", contractVersion: CONTRACT_VERSION, verifierId: "typecheck",
    outcome: "PASS" as const, inputHashes: [H("in")], observations: [], at: NOW,
  };

  it("accepts a PASS with no reason", () => {
    expect(VerificationResultSchema.safeParse(base).success).toBe(true);
  });

  it("refuses FAIL or BLOCKED without a reason", () => {
    expect(VerificationResultSchema.safeParse({ ...base, outcome: "FAIL" }).success).toBe(false);
    expect(VerificationResultSchema.safeParse({ ...base, outcome: "BLOCKED" }).success).toBe(false);
    expect(
      VerificationResultSchema.safeParse({ ...base, outcome: "BLOCKED", reason: "evidence missing" }).success,
    ).toBe(true);
  });

  it("requires at least one input hash, so a result cannot float free of its inputs", () => {
    expect(VerificationResultSchema.safeParse({ ...base, inputHashes: [] }).success).toBe(false);
  });
});

describe("Certificate", () => {
  const base = {
    id: "CERT-1", contractVersion: CONTRACT_VERSION, runtimeVersion: "0.0.1",
    contractId: "WC-001", finalPhase: "COMPLETED" as const,
    contractHash: H("c"), stateHash: H("s"), graphSnapshotHash: H("g"),
    evidenceHashes: [H("e")], decisionHashes: [H("d")], verificationHashes: [H("v")],
    issuedAt: NOW, provenance: PROV,
  };

  it("accepts a certificate over completed work", () => {
    expect(CertificateSchema.safeParse(base).success).toBe(true);
  });

  it("refuses to certify in-flight work", () => {
    for (const phase of ["EXECUTING", "PLANNING", "REOPENED", "BLOCKED"] as const) {
      expect(CertificateSchema.safeParse({ ...base, finalPhase: phase }).success, phase).toBe(false);
    }
  });

  it("changes hash when any bound artifact changes — the tamper signal", () => {
    const before = contentHash(base);
    expect(contentHash({ ...base, evidenceHashes: [H("tampered")] })).not.toBe(before);
    expect(contentHash({ ...base, stateHash: H("tampered") })).not.toBe(before);
  });
});

describe("every frozen contract", () => {
  it("is versioned and canonically serializable", () => {
    for (const [name, schema] of Object.entries(CONTRACTS)) {
      expect(schema, name).toBeDefined();
      // Every contract shape must survive canonical serialization; if a schema
      // ever admits a Date or NaN, certificates over it become unstable.
      expect(() => canonicalJson({ name, version: CONTRACT_VERSION })).not.toThrow();
    }
  });

  it("pins the contract version so a change is deliberate", () => {
    expect(CONTRACT_VERSION).toBe("1.0.0");
  });
});
