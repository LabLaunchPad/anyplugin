/**
 * M7 acceptance tests: content-hash verification against an independently
 * supplied observation.
 *
 * Case C (per the M7 preflight) is the load-bearing one: a verifier that
 * derives its ground truth from `evidence` itself would be fooled by a
 * record whose content and stored hash were doctored together. This file
 * proves `verifyEvidence` cannot do that — not by asserting it doesn't, but
 * by constructing the false verifier the ground-truth rule warns against and
 * showing it disagrees with the real one exactly where it should.
 */
import { describe, expect, it } from "vitest";
import { contentHash, isContentHash } from "../canonical.js";
import { CONTRACT_VERSION, type Evidence } from "../contracts/index.js";
import { verifyEvidence } from "./verify-evidence.js";

function evidence(content: unknown, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: "EV-1",
    contractVersion: CONTRACT_VERSION,
    kind: "TEST_RESULT",
    source: "pnpm test",
    contentHash: contentHash(content),
    authority: "AUTHORITATIVE",
    provenance: { by: "worker-runtime/1.0.0", at: "2026-08-24T20:00:00Z" },
    validity: "VALID",
    ...overrides,
  };
}

const AT = "2026-08-24T21:00:00Z";

describe("verifyEvidence — case A: untouched content", () => {
  it("PASSes when the observed content hashes to the claimed contentHash", () => {
    const content = { tests: 442, passed: 442 };
    const result = verifyEvidence({
      id: "VER-1",
      verifierId: "worker-runtime/1.0.0",
      evidence: evidence(content),
      observedContent: content,
      at: AT,
    });
    expect(result.outcome).toBe("PASS");
    expect(result.reason).toBeUndefined();
    expect(result.inputHashes).toEqual([contentHash(content)]);
  });
});

describe("verifyEvidence — case B: content mutated, original hash kept", () => {
  it("FAILs, with a reason, when observed content does not match the claim", () => {
    const original = { tests: 442, passed: 442 };
    const mutated = { tests: 442, passed: 441 }; // one test now failing
    const result = verifyEvidence({
      id: "VER-2",
      verifierId: "worker-runtime/1.0.0",
      evidence: evidence(original), // contentHash reflects the ORIGINAL content
      observedContent: mutated, // but this is what's observed now
      at: AT,
    });
    expect(result.outcome).toBe("FAIL");
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("does not match");
  });
});

describe("verifyEvidence — case C: the ground-truth proof (anti-vacuity)", () => {
  it("the outcome is NOT a pure function of `evidence` alone", () => {
    // Constructive proof of the ground-truth rule: hold `evidence` fixed and
    // vary only `observedContent`. If the real verifier secretly derived its
    // comparison value from `evidence` (the false implementation the ground-
    // truth rule warns against), both calls would agree regardless of
    // observedContent. They must NOT agree here.
    const original = { tests: 442, passed: 442 };
    const fixedEvidence = evidence(original);

    const matching = verifyEvidence({
      id: "VER-3a",
      verifierId: "worker-runtime/1.0.0",
      evidence: fixedEvidence,
      observedContent: original,
      at: AT,
    });
    const mismatching = verifyEvidence({
      id: "VER-3b",
      verifierId: "worker-runtime/1.0.0",
      evidence: fixedEvidence,
      observedContent: { tests: 442, passed: 0 },
      at: AT,
    });

    expect(matching.outcome).toBe("PASS");
    expect(mismatching.outcome).toBe("FAIL");
  });

  it("negatively tests itself: a verifier that trusts the record's own hash format WOULD wrongly PASS the doctored case", () => {
    // The false implementation the ground-truth rule exists to rule out:
    // a "verifier" that only checks Evidence.contentHash is a well-formed
    // hash, never touching independently observed content at all. This is
    // exactly what a record that doctored its content AND its stored hash
    // together would sail through.
    function falseVerifierTrustsStoredHash(record: Evidence): "PASS" | "FAIL" {
      return isContentHash(record.contentHash) ? "PASS" : "FAIL";
    }

    const tamperedContent = { tests: 442, passed: 0 }; // real state: mass failure
    const recordWithDoctoredHash = evidence(tamperedContent); // hash recomputed to match — internally "consistent"

    // The false verifier is fooled: format is fine, so it PASSes silently.
    expect(falseVerifierTrustsStoredHash(recordWithDoctoredHash)).toBe("PASS");

    // The real verifier, given the GENUINE prior observation as ground truth
    // (what was actually true before whatever produced this record), catches it.
    const genuinePriorObservation = { tests: 442, passed: 442 };
    const real = verifyEvidence({
      id: "VER-3c",
      verifierId: "worker-runtime/1.0.0",
      evidence: recordWithDoctoredHash,
      observedContent: genuinePriorObservation,
      at: AT,
    });
    expect(real.outcome).toBe("FAIL");
  });
});

describe("verifyEvidence — contract conformance", () => {
  it("PASS never carries a reason; FAIL always does (schema-enforced, asserted directly)", () => {
    const content = "x";
    const pass = verifyEvidence({
      id: "VER-4",
      verifierId: "v/1",
      evidence: evidence(content),
      observedContent: content,
      at: AT,
    });
    const fail = verifyEvidence({
      id: "VER-5",
      verifierId: "v/1",
      evidence: evidence(content),
      observedContent: "y",
      at: AT,
    });
    expect(pass.reason).toBeUndefined();
    expect(fail.reason).toBeDefined();
  });

  it("is deterministic: identical inputs produce an identical result", () => {
    const content = { a: 1, b: [1, 2, 3] };
    const params = {
      id: "VER-6",
      verifierId: "v/1",
      evidence: evidence(content),
      observedContent: content,
      at: AT,
    };
    expect(verifyEvidence(params)).toEqual(verifyEvidence(params));
  });

  it("inputHashes reflects the OBSERVATION, not the claim — they differ when evidence is wrong", () => {
    const claimed = "original";
    const observed = "different";
    const result = verifyEvidence({
      id: "VER-7",
      verifierId: "v/1",
      evidence: evidence(claimed),
      observedContent: observed,
      at: AT,
    });
    expect(result.inputHashes).toEqual([contentHash(observed)]);
    expect(result.inputHashes).not.toEqual([contentHash(claimed)]);
  });
});
