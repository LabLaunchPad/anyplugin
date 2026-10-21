/**
 * Verifying a certificate (M10).
 *
 * ── The rule that makes this file separate from `issue.ts` ──────────────────
 *
 * > **Verification is implemented independently of creation.**
 *
 * If the verifier reused the issuer's code, a bug in that code would be
 * invisible: the certificate would be checked against the same wrong
 * function that produced it, and every tampering test would pass. So this
 * file recomputes every hash itself, and compares the results by a
 * **different method** — as a sorted multiset, rather than as the ordered
 * list the issuer built.
 *
 * The shared parts are the shared *primitive* (`contentHash`) and the
 * shared *shape* (the contract's schema). Neither is a shared decision.
 *
 * ── What it refuses ────────────────────────────────────────────────────────
 *
 * It does not throw for a bad certificate. A certificate that fails to
 * parse, an artifact that was changed, an artifact that is missing, an
 * artifact that was added — every one of them is a **verdict**, with the
 * reason, because the caller asked "can this still be trusted?" and the
 * answer has to be readable by whoever has to act on it.
 *
 * ── The pattern this copies ─────────────────────────────────────────────────
 *
 * The install journal classifies a file as untouched, already-removed, or
 * **modified — and aborts on the third**. The certificate classifies the
 * same way, over a whole run instead of one file, and refuses on any
 * modification.
 */
import { contentHash } from "../canonical.js";
import {
  CertificateSchema,
  DecisionSchema,
  EvidenceSchema,
  GraphSnapshotSchema,
  VerificationResultSchema,
  WorkContractSchema,
  WorkerStateSchema,
  type Certificate,
  type Decision,
  type Evidence,
  type GraphSnapshot,
  type VerificationResult,
  type WorkContract,
  type WorkerState,
} from "../contracts/index.js";
import { ExecutionResultSchema, type ExecutionResult } from "../contracts/execution.js";

/** Why a certificate did not verify. */
export type CertificateFailureKind =
  /** The certificate does not satisfy its own schema. */
  | "MALFORMED_CERTIFICATE"
  /** A bound artifact is not a record at all. */
  | "MALFORMED_ARTIFACT"
  /** A bound artifact's content is not what was certified. */
  | "MODIFIED"
  /** The certificate names an artifact that was not supplied. */
  | "MISSING"
  /** An artifact was supplied that the certificate does not name. */
  | "ADDED"
  /** The certificate names a different contract than the one supplied. */
  | "CONTRACT_MISMATCH"
  /** The certificate's final phase disagrees with the state supplied. */
  | "PHASE_MISMATCH";

export interface CertificateFailure {
  readonly kind: CertificateFailureKind;
  /** Which binding failed: "evidence", "contract", "state", and so on. */
  readonly which: string;
  /** What the certificate said. */
  readonly expected?: string;
  /** What the artifact actually is now. */
  readonly actual?: string;
}

export interface CertificateVerdict {
  /** True only when there are no failures at all. */
  readonly ok: boolean;
  readonly failures: readonly CertificateFailure[];
}

/** The artifacts a certificate is checked against. */
export interface CertificateArtifacts {
  readonly contract: WorkContract;
  readonly state: WorkerState;
  readonly graphSnapshot: GraphSnapshot;
  readonly evidence: readonly Evidence[];
  readonly decisions: readonly Decision[];
  readonly verifications: readonly VerificationResult[];
  readonly executions?: readonly ExecutionResult[];
}

/**
 * Compare two hash lists as MULTISETS.
 *
 * Order is not the property that matters — the same artifacts hashed in a
 * different order are the same artifacts — but COUNT is: a removed record
 * must fail, and an added one must too. So the lists are sorted and
 * compared element by element, and the first difference is reported.
 */
function compareHashes(
  which: string,
  expected: readonly string[],
  actual: readonly string[],
): CertificateFailure[] {
  if (expected.length !== actual.length) {
    return [
      {
        kind: actual.length < expected.length ? "MISSING" : "ADDED",
        which,
        expected: `${expected.length} record(s)`,
        actual: `${actual.length} record(s)`,
      },
    ];
  }
  const left = [...expected].sort();
  const right = [...actual].sort();
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return [
        {
          kind: "MODIFIED",
          which,
          expected: left[index],
          actual: right[index],
        },
      ];
    }
  }
  return [];
}

/**
 * The hash of an artifact, in its SEALED form.
 *
 * The sealed form is the PARSED form — the record as its own schema
 * produces it. Six of the seven bound contracts have defaulted fields, so
 * the raw input and the parsed record are different objects with
 * different hashes, and the kernel's own ledgers store and return the
 * PARSED one. Hashing the raw input would make the seal report an
 * untouched artifact as tampered, in the one pipeline that matters.
 *
 * And it is TOTAL: an artifact that is not a record at all produces a
 * verdict, not an exception. The verifier's contract says it never throws
 * for a bad certificate, and an artifact it cannot even canonicalise is
 * exactly such a case.
 */
function sealedHash(
  schema: { parse: (value: unknown) => unknown },
  value: unknown,
  which: string,
): { hash?: string; failure?: CertificateFailure } {
  try {
    return { hash: contentHash(schema.parse(value)) };
  } catch (error) {
    return {
      failure: {
        kind: "MALFORMED_ARTIFACT",
        which,
        expected: "a record that satisfies its schema",
        actual: String((error as Error).message).slice(0, 200),
      },
    };
  }
}

/**
 * Verify a certificate against the artifacts it claims to bind.
 *
 * Never throws for a bad certificate: a refusal is a verdict, not an
 * exception, because the caller has to be able to report it.
 */
export function verifyCertificate(
  certificate: Certificate,
  artifacts: CertificateArtifacts,
): CertificateVerdict {
  const failures: CertificateFailure[] = [];

  // The certificate must satisfy its own schema before any of it is
  // believed. A malformed certificate is not a certificate.
  const parsed = CertificateSchema.safeParse(certificate);
  if (!parsed.success) {
    return {
      ok: false,
      failures: [
        {
          kind: "MALFORMED_CERTIFICATE",
          which: "certificate",
          expected: "a certificate that satisfies its own schema",
          actual: parsed.error.issues.map((issue) => issue.message).join("; "),
        },
      ],
    };
  }

  // The certificate must name the contract that was supplied, and the phase
  // it claims must be the phase the state is in. These are checked BEFORE
  // the hashes, because a certificate for a different contract is a
  // different certificate entirely, and hashing it against the wrong
  // artifacts would produce a confusing failure instead of a clear one.
  if (parsed.data.contractId !== artifacts.contract.id) {
    failures.push({
      kind: "CONTRACT_MISMATCH",
      which: "contract",
      expected: parsed.data.contractId,
      actual: artifacts.contract.id,
    });
  }
  if (parsed.data.finalPhase !== artifacts.state.phase) {
    failures.push({
      kind: "PHASE_MISMATCH",
      which: "state",
      expected: parsed.data.finalPhase,
      actual: artifacts.state.phase,
    });
  }

  // The artifacts must belong to EACH OTHER, not merely to the contract by
  // hash. A state or a decision from a different contract is a different
  // run's record, and a certificate that binds one while claiming the
  // other asserts something it does not describe.
  if (artifacts.state.contractId !== parsed.data.contractId) {
    failures.push({
      kind: "CONTRACT_MISMATCH",
      which: "state",
      expected: parsed.data.contractId,
      actual: artifacts.state.contractId,
    });
  }
  for (const decision of artifacts.decisions) {
    if (decision.contractId !== parsed.data.contractId) {
      failures.push({
        kind: "CONTRACT_MISMATCH",
        which: "decision",
        expected: parsed.data.contractId,
        actual: decision.contractId,
      });
    }
  }

  // The three single-artifact bindings.
  const singles: readonly [string, string, unknown, { parse: (value: unknown) => unknown }][] = [
    ["contract", parsed.data.contractHash, artifacts.contract, WorkContractSchema],
    ["state", parsed.data.stateHash, artifacts.state, WorkerStateSchema],
    ["graph", parsed.data.graphSnapshotHash, artifacts.graphSnapshot, GraphSnapshotSchema],
  ];
  for (const [which, expected, value, schema] of singles) {
    const { hash, failure } = sealedHash(schema, value, which);
    if (failure) {
      failures.push(failure);
      continue;
    }
    if (expected !== hash) {
      failures.push({ kind: "MODIFIED", which, expected, actual: hash });
    }
  }

  // The list bindings.
  const lists: readonly [
    string,
    readonly string[],
    readonly unknown[],
    { parse: (value: unknown) => unknown },
  ][] = [
    ["evidence", parsed.data.evidenceHashes, artifacts.evidence, EvidenceSchema],
    ["decision", parsed.data.decisionHashes, artifacts.decisions, DecisionSchema],
    ["verification", parsed.data.verificationHashes, artifacts.verifications, VerificationResultSchema],
    ["execution", parsed.data.executionHashes, artifacts.executions ?? [], ExecutionResultSchema],
  ];
  for (const [which, expected, values, schema] of lists) {
    const hashes: string[] = [];
    let malformed = false;
    for (const value of values) {
      const { hash, failure } = sealedHash(schema, value, which);
      if (failure) {
        failures.push(failure);
        malformed = true;
        continue;
      }
      hashes.push(hash!);
    }
    // A malformed record is the informative failure. The count comparison
    // would only add a confusing "missing" on top of it.
    if (malformed) continue;
    failures.push(...compareHashes(which, expected, hashes));
  }

  return { ok: failures.length === 0, failures };
}
