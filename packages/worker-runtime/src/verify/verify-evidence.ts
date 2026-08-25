/**
 * M7 (minimal scope): verify one Evidence record's content hash against an
 * independently supplied observation.
 *
 * ── Ground truth (decision M7-GT-001) ───────────────────────────────────────
 *
 * `Evidence.contentHash` is documented as "hash of the observed content," but
 * `EvidenceSchema` never stores that content — only its hash and a `source`
 * string. A verifier that derives what it compares against from the `Evidence`
 * record itself would be checking the record's internal consistency, not
 * whether the claim is true (`RULE: A VERIFIER MUST HAVE AN INDEPENDENT GROUND
 * TRUTH`, `docs/ai-native/reusable-procedures.md`). Of the four candidate
 * models that preflight identified, only one requires no change to anything
 * already closed:
 *
 *   A. verification-time supplied observation   — no contract/storage change
 *   B. re-execute Evidence.source                — pulls in M9 (not built)
 *   C. persist the original observation           — reopens M3's closed store
 *   D. content-addressed artifactRef field        — a frozen-contract change
 *
 * This module implements A. `observedContent` is supplied by the caller at
 * verification time and is never derived from `evidence` — enforced by
 * construction (the function has no other source to read a hash from) and
 * proven in `verify-evidence.test.ts` by showing the outcome is NOT a pure
 * function of `evidence` alone: two different `observedContent` values against
 * the same `evidence` produce different outcomes.
 *
 * ── Explicitly out of scope (deferred, not solved here) ─────────────────────
 *
 * - `Evidence.validity` (VALID/INVALIDATED/SUPERSEDED) is not inspected. What
 *   a direct verification of non-VALID evidence should return is UNKNOWN —
 *   no schema field or roadmap text decides it (M7 preflight, HITL item).
 *   Re-verification triggered by invalidation is M6's job, not this module's.
 * - No persistence: `VerificationResult` is a computed return value, matching
 *   `WorkerState`'s precedent (folded, never itself an authoritative store) —
 *   `verification` has no entry in `STORAGE_SUBDIRS`.
 * - Does not execute `evidence.source`, create a content store, modify
 *   `EvidenceSchema`, or touch M9/AP-017.
 */
import { CanonicalizationError, contentHash } from "../canonical.js";
import { VerificationResultSchema, type Evidence } from "../contracts/index.js";
import type { z } from "zod";

export type VerificationOutcome = "PASS" | "FAIL" | "BLOCKED";
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export interface VerifyEvidenceInput {
  /** Caller-supplied, same convention as every other kernel record id. */
  readonly id: string;
  readonly verifierId: string;
  readonly evidence: Evidence;
  /**
   * The independent ground truth: content obtained by the caller from
   * somewhere other than `evidence` itself. Never read from `evidence` by
   * this function — that is the property `verify-evidence.test.ts` proves.
   */
  readonly observedContent: unknown;
  readonly at: string;
}

/**
 * PASS iff a hash of `observedContent` matches `evidence.contentHash`.
 * FAIL if it was hashable but does not match — a real comparison happened
 * and disagreed. BLOCKED if `observedContent` could not be canonicalized at
 * all — a verifier must never fabricate a hash for something it could not
 * establish, and it must never fabricate a comparison result either (the
 * same reasoning `VerificationOutcomeSchema`'s own comment states BLOCKED
 * exists for: absence of a usable observation is not evidence of failure,
 * nor of success).
 */
export function verifyEvidence(input: VerifyEvidenceInput): VerificationResult {
  let observedHash: string;
  try {
    observedHash = contentHash(input.observedContent);
  } catch (err) {
    if (!(err instanceof CanonicalizationError)) throw err;
    return VerificationResultSchema.parse({
      id: input.id,
      contractVersion: input.evidence.contractVersion,
      verifierId: input.verifierId,
      outcome: "BLOCKED",
      // Nothing new was computed; the only real hash on hand is the claim
      // itself, cited so this result is still traceable to what it concerns.
      inputHashes: [input.evidence.contentHash],
      observations: [`observedContent could not be canonicalized: ${err.message}`],
      at: input.at,
      reason: `observed content could not be hashed: ${err.message}`,
    });
  }

  const outcome: VerificationOutcome = observedHash === input.evidence.contentHash ? "PASS" : "FAIL";

  return VerificationResultSchema.parse({
    id: input.id,
    contractVersion: input.evidence.contractVersion,
    verifierId: input.verifierId,
    outcome,
    // What was actually checked — the observation, not the claim it's
    // checked against. A result cannot be reused for a different observation.
    inputHashes: [observedHash],
    observations: [`evidence.contentHash=${input.evidence.contentHash}`, `observedHash=${observedHash}`],
    at: input.at,
    reason:
      outcome === "FAIL"
        ? `observed content hash ${observedHash} does not match Evidence.contentHash ${input.evidence.contentHash} for ${input.evidence.id}`
        : undefined,
  });
}
