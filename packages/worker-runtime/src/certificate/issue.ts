/**
 * Issuing a certificate (M10).
 *
 * ── What a certificate is ───────────────────────────────────────────────────
 *
 * A certificate binds an outcome to everything it rests on: the work
 * contract, the worker state, the graph, the evidence, the decisions, the
 * verification results and the executions. It is the answer to one
 * question — *can this outcome still be trusted?* — and the answer has to
 * be checkable by someone who was not there.
 *
 * ── The pattern this copies ─────────────────────────────────────────────────
 *
 * The kernel document is explicit: **copy the shape of
 * `cli/src/journal.ts`; do not import it.** The journal hashes a file before
 * it touches it, hashes it again after, and classifies the result as
 * untouched, already-removed, or **modified — and it aborts on the third**.
 * The certificate is the same discipline applied to a whole run.
 *
 * The package boundary forbids importing from the CLI, and it wins: the
 * runtime must not depend on AnyPlugin's installer. So the *shape* is
 * reimplemented here against the kernel's own contracts. The hashing
 * primitive is shared — `contentHash` — because a shared primitive is not
 * a shared decision.
 *
 * ── What issuance is, and what it is not ────────────────────────────────────
 *
 * Issuing is a **pure function** of its inputs: the same artifacts produce
 * the same certificate, byte for byte. It performs no I/O, reads no clock
 * (the caller supplies the timestamp) and consults no randomness. That is
 * what makes the golden test possible, and it is what makes a certificate
 * reproducible.
 *
 * Issuing does NOT decide whether the outcome is good. It records what the
 * outcome rests on. Whether that is enough is the verifier's question, and
 * the verifier is a separate file with a separate code path.
 */
import { contentHash } from "../canonical.js";
import {
  CONTRACT_VERSION,
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
  type Provenance,
  type VerificationResult,
  type WorkContract,
  type WorkerState,
} from "../contracts/index.js";
import { ExecutionResultSchema, type ExecutionResult } from "../contracts/execution.js";

/** Everything a certificate binds. */
export interface CertificateInputs {
  /** The certificate's own id: `CERT-<slug>`. */
  readonly id: string;
  /** The runtime that issued it. */
  readonly runtimeVersion: string;
  /** The contract the work was judged against. */
  readonly contract: WorkContract;
  /** The state the work ended in. */
  readonly state: WorkerState;
  /** The graph the outcome was reached over. */
  readonly graphSnapshot: GraphSnapshot;
  /** The evidence the outcome rests on. */
  readonly evidence: readonly Evidence[];
  /** The decisions that were taken. */
  readonly decisions: readonly Decision[];
  /** The verification results the outcome rests on. */
  readonly verifications: readonly VerificationResult[];
  /** The executions the outcome rests on. */
  readonly executions?: readonly ExecutionResult[];
  /** When it was issued. The caller supplies it: issuing reads no clock. */
  readonly issuedAt: string;
  /** Who issued it. */
  readonly provenance: Provenance;
}

/**
 * Issue a certificate.
 *
 * The certificate is built from the hashes of the artifacts, and then
 * **validated against its own schema** — so an issuance that would produce
 * an illegal certificate fails here, loudly, rather than at the point
 * somebody tries to verify it.
 */
export function issueCertificate(inputs: CertificateInputs): Certificate {
  // The artifacts are checked BEFORE they are sealed.
  //
  // A certificate that binds a malformed artifact binds nothing worth
  // anything: the verifier would later recompute the hash of a record that
  // is not a record, and the failure would be reported as "the artifact
  // was modified" — which is true and useless. So an illegal artifact is
  // refused HERE, where the reason is obvious.
  //
  // And what is hashed is the PARSED form, not the raw input. Six of the
  // seven bound contracts have defaulted fields, so the raw form and the
  // parsed form are different objects with different hashes — and the
  // kernel's own ledgers store and return the PARSED record. Hashing the
  // raw input would make the seal report an untouched artifact as
  // tampered, in the one pipeline that matters.
  const sealed = {
    contract: WorkContractSchema.parse(inputs.contract),
    state: WorkerStateSchema.parse(inputs.state),
    graphSnapshot: GraphSnapshotSchema.parse(inputs.graphSnapshot),
    evidence: inputs.evidence.map((record) => EvidenceSchema.parse(record)),
    decisions: inputs.decisions.map((record) => DecisionSchema.parse(record)),
    verifications: inputs.verifications.map((record) => VerificationResultSchema.parse(record)),
    executions: (inputs.executions ?? []).map((record) => ExecutionResultSchema.parse(record)),
  };

  const certificate = {
    id: inputs.id,
    contractVersion: CONTRACT_VERSION,
    runtimeVersion: inputs.runtimeVersion,
    contractId: sealed.contract.id,
    finalPhase: sealed.state.phase,
    contractHash: contentHash(sealed.contract),
    stateHash: contentHash(sealed.state),
    graphSnapshotHash: contentHash(sealed.graphSnapshot),
    evidenceHashes: sealed.evidence.map((record) => contentHash(record)),
    decisionHashes: sealed.decisions.map((record) => contentHash(record)),
    verificationHashes: sealed.verifications.map((record) => contentHash(record)),
    executionHashes: sealed.executions.map((record) => contentHash(record)),
    issuedAt: inputs.issuedAt,
    provenance: inputs.provenance,
  };

  return CertificateSchema.parse(certificate);
}
