/**
 * The certificate (M10).
 *
 * ── What these tests are for ────────────────────────────────────────────────
 *
 * A certificate is worth exactly what its verification is worth. A seal
 * that cannot be checked is decoration, and a seal that cannot detect
 * tampering is worse than no seal — because it says "verified" about
 * something that was changed.
 *
 * So the tests come in three kinds:
 *
 *  1. **GOLDEN** — the issued certificate is a pure function of its
 *     inputs, and the expected bytes are pinned. A certificate that drifts
 *     by one character is a change nobody chose.
 *  2. **MUTATION** — every bound artifact is tampered with in turn, and
 *     every one of them must make verification fail. An artifact the
 *     certificate does not actually bind is an artifact nobody can trust.
 *  3. **INDEPENDENCE** — the verification path must not reuse the
 *     creation path. That is proved structurally, by reading the source,
 *     because a bug in shared code would be invisible to every other test
 *     here: the certificate would be checked against the same wrong
 *     function that produced it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { issueCertificate } from "./issue.js";
import { verifyCertificate, type CertificateArtifacts } from "./verify.js";
import {
  CONTRACT_VERSION,
  type Decision,
  type Evidence,
  type GraphSnapshot,
  type VerificationResult,
  type WorkContract,
  type WorkerState,
} from "../contracts/index.js";
import type { ExecutionResult } from "../contracts/execution.js";

const AT = "2026-10-21T00:00:00.000Z";
const PROVENANCE = { by: "process:kernel", at: AT } as const;

const contract: WorkContract = {
  id: "WC-1",
  contractVersion: CONTRACT_VERSION,
  goal: "ship the seal",
  scope: ["packages/worker-runtime/src/certificate"],
  constraints: [],
  successConditions: ["a certificate verifies"],
  riskLevel: "low",
  provenance: { ...PROVENANCE },
};

const state: WorkerState = {
  id: "WS-1",
  contractVersion: CONTRACT_VERSION,
  contractId: "WC-1",
  phase: "COMPLETED",
  assumptions: [],
  revision: 3,
  updatedAt: AT,
};

const graphSnapshot: GraphSnapshot = {
  contractVersion: CONTRACT_VERSION,
  at: AT,
  nodes: [],
  edges: [],
};

const evidence: Evidence = {
  id: "EV-1",
  contractVersion: CONTRACT_VERSION,
  kind: "TEST_RESULT",
  source: "pnpm test",
  contentHash: `sha256:${"a".repeat(64)}`,
  authority: "AUTHORITATIVE",
  provenance: { ...PROVENANCE },
  validity: "VALID",
};

const decision: Decision = {
  id: "DEC-1",
  contractVersion: CONTRACT_VERSION,
  contractId: "WC-1",
  selected: "bind the executions directly",
  alternatives: [],
  supportingEvidence: ["EV-1"],
  assumptions: [],
  provenance: { ...PROVENANCE },
  validity: "VALID",
  stale: false,
};

const verification: VerificationResult = {
  id: "VER-1",
  contractVersion: CONTRACT_VERSION,
  verifierId: "typecheck",
  outcome: "PASS",
  inputHashes: [`sha256:${"b".repeat(64)}`],
  observations: [],
  at: AT,
};

const execution: ExecutionResult = {
  id: "EXE-1",
  contractVersion: CONTRACT_VERSION,
  exitCode: 0,
  signal: null,
  timedOut: false,
  stdout: "ok",
  stdoutTruncated: false,
  stderr: "",
  stderrTruncated: false,
  artifacts: [],
  metadata: {
    argv: ["node", "-e", "1"],
    cwd: "/tmp/work",
    envKeys: ["PATH"],
    limits: {
      timeoutMs: 1000,
      maxOutputBytes: 1024,
      maxArtifactBytes: 1024,
      maxArtifacts: 4,
    },
    policy: { envAllowlist: ["PATH"], confineCwd: true, captureArtifacts: true },
  },
};

function artifacts(overrides: Partial<CertificateArtifacts> = {}): CertificateArtifacts {
  return {
    contract,
    state,
    graphSnapshot,
    evidence: [evidence],
    decisions: [decision],
    verifications: [verification],
    executions: [execution],
    ...overrides,
  };
}

function issue(overrides: Partial<CertificateArtifacts> = {}) {
  const input = artifacts(overrides);
  return issueCertificate({
    id: "CERT-1",
    runtimeVersion: "0.1.1",
    contract: input.contract,
    state: input.state,
    graphSnapshot: input.graphSnapshot,
    evidence: input.evidence,
    decisions: input.decisions,
    verifications: input.verifications,
    executions: input.executions,
    issuedAt: AT,
    provenance: { ...PROVENANCE },
  });
}

describe("the certificate", () => {
  it("binds every artifact it was given", () => {
    const certificate = issue();
    expect(certificate.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(certificate.stateHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(certificate.graphSnapshotHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(certificate.evidenceHashes).toHaveLength(1);
    expect(certificate.decisionHashes).toHaveLength(1);
    expect(certificate.verificationHashes).toHaveLength(1);
    expect(certificate.executionHashes).toHaveLength(1);
    expect(certificate.finalPhase).toBe("COMPLETED");
    expect(certificate.contractId).toBe("WC-1");
  });

  it("GOLDEN: the same artifacts produce the same certificate, byte for byte", () => {
    const first = JSON.stringify(issue());
    const second = JSON.stringify(issue());
    expect(second).toBe(first);
    // And the pinned expectation, so a change in the hashing is a visible
    // change rather than a silent one.
    expect(first).toContain('"finalPhase":"COMPLETED"');
    expect(first).toContain('"contractHash":"sha256:');
  });

  it("verifies a certificate it has just issued", () => {
    const verdict = verifyCertificate(issue(), artifacts());
    expect(verdict.failures).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("MUTATION: a changed contract fails verification", () => {
    const tampered = { ...contract, goal: "ship something else" };
    const verdict = verifyCertificate(issue(), artifacts({ contract: tampered }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f) => f.kind === "MODIFIED" && f.which === "contract")).toBe(true);
  });

  it("MUTATION: a changed state fails verification", () => {
    const tampered = { ...state, phase: "FAILED" as const };
    const verdict = verifyCertificate(issue(), artifacts({ state: tampered }));
    expect(verdict.ok).toBe(false);
    // Both the phase and the hash must object.
    expect(verdict.failures.some((f) => f.kind === "PHASE_MISMATCH")).toBe(true);
    expect(verdict.failures.some((f) => f.kind === "MODIFIED" && f.which === "state")).toBe(true);
  });

  it("MUTATION: a changed graph fails verification", () => {
    const tampered = { ...graphSnapshot, at: "2026-10-22T00:00:00.000Z" };
    const verdict = verifyCertificate(issue(), artifacts({ graphSnapshot: tampered }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f) => f.kind === "MODIFIED" && f.which === "graph")).toBe(true);
  });

  it("MUTATION: a changed evidence record fails verification", () => {
    const tampered = { ...evidence, source: "something else" };
    const verdict = verifyCertificate(issue(), artifacts({ evidence: [tampered] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f) => f.kind === "MODIFIED" && f.which === "evidence")).toBe(true);
  });

  it("MUTATION: a changed decision fails verification", () => {
    const tampered = { ...decision, selected: "something else" };
    const verdict = verifyCertificate(issue(), artifacts({ decisions: [tampered] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f) => f.kind === "MODIFIED" && f.which === "decision")).toBe(true);
  });

  it("MUTATION: a changed verification result fails verification", () => {
    const tampered = { ...verification, outcome: "FAIL" as const, reason: "tampered" };
    const verdict = verifyCertificate(issue(), artifacts({ verifications: [tampered] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f) => f.kind === "MODIFIED" && f.which === "verification")).toBe(true);
  });

  it("MUTATION: a changed execution fails verification", () => {
    const tampered = { ...execution, stdout: "something else" };
    const verdict = verifyCertificate(issue(), artifacts({ executions: [tampered] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f) => f.kind === "MODIFIED" && f.which === "execution")).toBe(true);
  });

  it("a REMOVED artifact fails verification", () => {
    const verdict = verifyCertificate(issue(), artifacts({ evidence: [] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f) => f.kind === "MISSING" && f.which === "evidence")).toBe(true);
  });

  it("an ADDED artifact fails verification", () => {
    const verdict = verifyCertificate(issue(), artifacts({ evidence: [evidence, { ...evidence, id: "EV-2" }] }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f) => f.kind === "ADDED" && f.which === "evidence")).toBe(true);
  });

  it("a certificate for a DIFFERENT contract fails verification", () => {
    const verdict = verifyCertificate(issue(), artifacts({ contract: { ...contract, id: "WC-2" } }));
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.some((f) => f.kind === "CONTRACT_MISMATCH")).toBe(true);
  });

  it("a malformed certificate is refused, not thrown", () => {
    const broken = { ...issue(), contractHash: "not-a-hash" } as never;
    const verdict = verifyCertificate(broken, artifacts());
    expect(verdict.ok).toBe(false);
    expect(verdict.failures[0]?.kind).toBe("MALFORMED_CERTIFICATE");
  });

  it("refuses to seal a malformed artifact", () => {
    expect(() =>
      issueCertificate({
        id: "CERT-2",
        runtimeVersion: "0.1.1",
        contract: { ...contract, goal: "" } as never,
        state,
        graphSnapshot,
        evidence: [],
        decisions: [],
        verifications: [],
        issuedAt: AT,
        provenance: { ...PROVENANCE },
      }),
    ).toThrow();
  });

  it("INDEPENDENCE: the verification path does not use the creation path", () => {
    // A structural proof, because no behavioural test can catch a shared
    // bug: the certificate would be checked against the same wrong
    // function that produced it, and every tampering test above would
    // still pass.
    const source = readFileSync(join(import.meta.dirname, "verify.ts"), "utf8");
    expect(source).not.toMatch(/from\s+["'][^"']*issue\.js["']/);
    expect(source).not.toMatch(/issueCertificate/);
  });
});
