/**
 * The Verification Engine (M7).
 *
 * ── Deliberately boring, and deliberately NOT the model ───────────────────
 *
 * The kernel doc's words: *"Deliberately boring, and deliberately not the
 * model."* A verifier is a **pure function** over the ledgers and the
 * graph. It reads records and it decides `PASS`, `FAIL` or `BLOCKED`. It
 * never asks a model, and it never infers.
 *
 * ── The one rule that matters ──────────────────────────────────────────────
 *
 * > **A verifier must never convert missing evidence into `PASS`.**
 * > `BLOCKED` exists precisely so absence of evidence has somewhere to go
 * > that is not success.
 *
 * So the engine has three gates, in this order:
 *
 * 1. **The required evidence must be PRESENT.** Absent ⇒ `BLOCKED`, with
 *    the missing ids named. Never `PASS`, never `FAIL` — a check that could
 *    not run is not a check that failed.
 * 2. **The required evidence must be USABLE** — that is, `VALID`.
 *    Invalidated or superseded evidence cannot support a claim, so the
 *    claim cannot be checked ⇒ `BLOCKED` again.
 * 3. **Only then does the check run**, and it may say `PASS` or `FAIL`.
 *
 * Gates 1 and 2 are the *false-positive resistance* M7's acceptance test
 * asks for, and gate 2 is what makes the invalidation engine interlock with
 * the verifier: invalidating the evidence a decision rests on makes the
 * decision's verification `BLOCKED`, which is exactly the
 * `requiresReverification` the cascade computes. **The two halves of the
 * kernel are one mechanism.**
 *
 * ── What a result binds ───────────────────────────────────────────────────
 *
 * `inputHashes` are the content hashes of the evidence the verifier USED.
 * A `PASS` must bind them, so a result cannot be replayed against different
 * inputs. A `BLOCKED` result with no evidence binds nothing — and cannot be
 * reused, because it is not a success.
 */
import { canonicalJson, contentHash } from "../canonical.js";
import {
  CONTRACT_VERSION,
  VerificationResultSchema,
  type VerificationResult,
  type WorkerEvent,
} from "../contracts/index.js";
import { eventIdOf, type WorkerEventDraft } from "../log/event-id.js";
import type { EvidenceProjection } from "../log/evidence.js";
import type { DecisionProjection } from "../log/decisions.js";
import type { GraphSnapshot } from "../contracts/index.js";

/** What a verifier is asked to check. */
export interface VerificationClaim {
  /**
   * The evidence the claim needs.
   *
   * Missing evidence ⇒ `BLOCKED`. It is never defaulted to "fine".
   */
  readonly requires: readonly string[];
  /**
   * The hashes of any OTHER artefact the check consumed.
   *
   * A check that reads a graph, a set of decisions, or a file has consumed
   * something, and a `PASS` that binds nothing could be replayed against
   * different inputs — which is the opposite of what `inputHashes` are for.
   * The engine binds these alongside the evidence's own hashes.
   */
  readonly inputHashes?: readonly string[];
  /** The check, run with the evidence that was found. */
  readonly check: (evidence: ReadonlyMap<string, EvidenceProjection>) => {
    readonly holds: boolean;
    readonly observations?: readonly string[];
    readonly reason?: string;
  };
}

export interface VerificationInput {
  readonly id: string;
  readonly verifierId: string;
  readonly claim: VerificationClaim;
  /** The evidence the log holds. */
  readonly evidence: ReadonlyMap<string, EvidenceProjection>;
  readonly at: string;
  readonly actor: string;
}

export interface VerificationOutcome {
  readonly result: VerificationResult;
  /** The required evidence that was missing or unusable. */
  readonly blockedBy: readonly string[];
  /** The event that records this verification, for the log. */
  readonly event: WorkerEventDraft;
}

/**
 * Run one verification.
 *
 * The order of the gates is the whole design, so it is written out rather
 * than factored away: presence, then usability, then the check.
 */
export function verify(input: VerificationInput): VerificationOutcome {
  const required = [...input.claim.requires];

  // ── Gate 1: the evidence must be there ──────────────────────────────────
  const missing = required.filter((id) => !input.evidence.has(id));
  if (missing.length > 0) {
    return blocked(input, missing, `the evidence this check needs is absent: ${missing.join(", ")}`);
  }

  // ── Gate 2: the evidence must be usable ─────────────────────────────────
  // Invalidated evidence should no longer be relied on; superseded evidence
  // has been replaced. Neither can support a claim.
  const unusable = required.filter((id) => {
    const record = input.evidence.get(id);
    return record !== undefined && record.validity !== "VALID";
  });
  if (unusable.length > 0) {
    const detail = unusable
      .map((id) => `${id} (${input.evidence.get(id)?.validity})`)
      .join(", ");
    return blocked(input, unusable, `the evidence this check needs is no longer usable: ${detail}`);
  }

  // ── Gate 3: the check runs ──────────────────────────────────────────────
  const usable = new Map<string, EvidenceProjection>();
  for (const id of required) {
    const record = input.evidence.get(id);
    if (record) usable.set(id, record);
  }
  const outcome = input.claim.check(usable);
  const inputHashes = [
    ...[...usable.values()].map((record) => record.contentHash),
    ...(input.claim.inputHashes ?? []),
  ].sort();

  const result = VerificationResultSchema.parse({
    id: input.id,
    contractVersion: CONTRACT_VERSION,
    verifierId: input.verifierId,
    outcome: outcome.holds ? "PASS" : "FAIL",
    inputHashes,
    observations: outcome.observations ?? [],
    at: input.at,
    ...(outcome.holds ? {} : { reason: outcome.reason ?? "the check did not hold" }),
  });

  const draft: Omit<WorkerEvent, "id" | "sequence"> = {
    contractVersion: CONTRACT_VERSION,
    at: input.at,
    actor: input.actor,
    kind: "VERIFICATION_RUN",
    subject: input.id,
    payload: { verification: result },
  };
  return { result, blockedBy: [], event: { ...draft, id: eventIdOf(draft) } };
}

/** A `BLOCKED` result: the check could not run. */
function blocked(input: VerificationInput, blockedBy: readonly string[], reason: string): VerificationOutcome {
  const result = VerificationResultSchema.parse({
    id: input.id,
    contractVersion: CONTRACT_VERSION,
    verifierId: input.verifierId,
    outcome: "BLOCKED",
    // A blocked result binds nothing: there was nothing to check against.
    inputHashes: [],
    observations: [],
    at: input.at,
    reason,
  });
  const draft: Omit<WorkerEvent, "id" | "sequence"> = {
    contractVersion: CONTRACT_VERSION,
    at: input.at,
    actor: input.actor,
    kind: "VERIFICATION_RUN",
    subject: input.id,
    payload: { verification: result },
  };
  return { result, blockedBy: [...blockedBy], event: { ...draft, id: eventIdOf(draft) } };
}

// ── The initial verifiers ─────────────────────────────────────────────────
//
// The kernel doc names eight. Three of them are pure functions over the
// ledgers and the graph, and those are the ones a kernel can honestly
// implement: the others (git diff integrity, repository cleanliness, test
// result verification) need the repository, and belong to the execution
// backend of M9.

/** Every edge of the graph must name a node that exists. */
export function graphConsistencyClaim(snapshot: GraphSnapshot): VerificationClaim {
  const nodeIds = new Set(snapshot.nodes.map((n) => n.id));
  return {
    requires: [],
    // The graph IS the input, and a PASS that binds nothing could be
    // replayed against a different graph.
    inputHashes: [contentHash(canonicalJson(snapshot))],
    check: () => {
      const dangling = snapshot.edges.filter((edge) => !nodeIds.has(edge.from) || !nodeIds.has(edge.to));
      return {
        holds: dangling.length === 0,
        observations: dangling.map((e) => `${e.from} -${e.kind}-> ${e.to} names a node that does not exist`),
        reason: dangling.length === 0 ? undefined : `${dangling.length} edge(s) name a node that does not exist`,
      };
    },
  };
}

/** Every decision must rest on evidence that exists. */
export function dependencyConsistencyClaim(
  decisions: ReadonlyMap<string, DecisionProjection>,
): VerificationClaim {
  const requires = [...decisions.values()].flatMap((d) => d.supportingEvidence);
  return {
    requires: [...new Set(requires)],
    check: () => {
      const unfounded = [...decisions.values()].filter((d) => d.supportingEvidence.length === 0);
      return {
        holds: unfounded.length === 0,
        observations: unfounded.map((d) => `${d.id} rests on no evidence at all`),
        reason: unfounded.length === 0 ? undefined : `${unfounded.length} decision(s) rest on no evidence`,
      };
    },
  };
}

/**
 * The evidence a decision rests on must still be valid.
 *
 * This is the verifier that makes the invalidation engine bite: invalidate
 * the evidence, and the decision's verification becomes `BLOCKED` rather
 * than quietly staying `PASS`.
 */
export function evidenceIntegrityClaim(decisions: ReadonlyMap<string, DecisionProjection>): VerificationClaim {
  const requires = [...new Set([...decisions.values()].flatMap((d) => d.supportingEvidence))];
  return {
    requires,
    // The decisions are the other input, and they are bound.
    inputHashes: [contentHash(canonicalJson([...decisions.values()].sort((a, b) => (a.id < b.id ? -1 : 1))))],
    check: (evidence) => {
      const observations: string[] = [];
      for (const decision of decisions.values()) {
        for (const id of decision.supportingEvidence) {
          const record = evidence.get(id);
          if (!record) {
            observations.push(`${decision.id} rests on ${id}, which is absent`);
            continue;
          }
          if (record.validity !== "VALID") {
            observations.push(`${decision.id} rests on ${id}, which is ${record.validity}`);
          }
        }
      }
      return {
        holds: observations.length === 0,
        observations,
        reason: observations.length === 0 ? undefined : `${observations.length} decision-evidence link(s) are unusable`,
      };
    },
  };
}
