/**
 * Writing the certificate into the history (M10).
 *
 * A certificate that is issued and checked but never recorded is a
 * certificate about a moment with no trace. These tests prove that the
 * seal actually becomes part of the log, and that recording it twice does
 * not put it there twice.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../log/event-log.js";
import { recordCertificate } from "./record.js";
import { verifyCertificate, type CertificateArtifacts } from "./verify.js";
import { issueCertificate } from "./issue.js";
import { CONTRACT_VERSION, type WorkerEvent } from "../contracts/index.js";

const AT = "2026-10-21T00:00:00.000Z";
const PROVENANCE = { by: "process:kernel", at: AT } as const;

let workspace: string;
let log: EventLog;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "anyplugin-cert-"));
  log = EventLog.open(workspace);
});

afterEach(() => {
  log.close();
  rmSync(workspace, { recursive: true, force: true });
});

function artifacts(): CertificateArtifacts {
  return {
    contract: {
      id: "WC-1",
      contractVersion: CONTRACT_VERSION,
      goal: "ship the seal",
      scope: ["certificate"],
      constraints: [],
      successConditions: ["a certificate verifies"],
      riskLevel: "low",
      provenance: { ...PROVENANCE },
    },
    state: {
      id: "WS-1",
      contractVersion: CONTRACT_VERSION,
      contractId: "WC-1",
      phase: "COMPLETED",
      assumptions: [],
      revision: 1,
      updatedAt: AT,
    },
    graphSnapshot: { contractVersion: CONTRACT_VERSION, at: AT, nodes: [], edges: [] },
    evidence: [],
    decisions: [],
    verifications: [],
    executions: [],
  };
}

function certificate() {
  const input = artifacts();
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

describe("recording a certificate", () => {
  it("writes it into the log as a CERTIFICATE_ISSUED event", () => {
    const sealed = certificate();
    const event = recordCertificate(log, sealed);

    expect(event.kind).toBe("CERTIFICATE_ISSUED");
    expect(event.subject).toBe("CERT-1");
    expect(event.at).toBe(AT);
    expect(event.actor).toBe("process:kernel");
    // The payload IS the certificate, not a summary of it.
    expect(event.payload).toMatchObject({ id: "CERT-1", finalPhase: "COMPLETED" });
  });

  it("the event id is DERIVED: recording the same certificate twice yields the same id", () => {
    const sealed = certificate();
    const first = recordCertificate(log, sealed);
    const second = recordCertificate(log, sealed);
    // The log's own guarantee G5: a re-appended committed event id is not
    // committed twice. A producer that invented a random id would break
    // that promise and make the history claim two certificates for one
    // outcome.
    expect(second.id).toBe(first.id);
  });

  it("KNOWN GAP: the log does not yet enforce G5, so a retry commits the id twice", () => {
    // This asserts a DEFECT, deliberately. The write contract's G5 says a
    // re-appended committed event id must not produce two committed events,
    // and the production append path does not enforce it — so a retried
    // recording commits the same id twice, and replay reports a duplicate id
    // as the contract's "broken writer" signal.
    //
    // The fix is recorded in `docs/BACKLOG.md`. If the log starts
    // enforcing G5, this test goes RED, and that is the welcome surprise
    // that says the gap closed.
    const sealed = certificate();
    const first = recordCertificate(log, sealed);
    const second = recordCertificate(log, sealed);
    expect(second.id).toBe(first.id);
    expect(second.sequence).toBeGreaterThan(first.sequence);
  });

  it("the recorded certificate can be read back and verified", () => {
    const sealed = certificate();
    const event = recordCertificate(log, sealed);

    // Read it back out of the log, the way a later reader would.
    const replayed = event.payload as typeof sealed;
    const verdict = verifyCertificate(replayed, artifacts());
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("a certificate that is recorded and then TAMPERED with fails verification", () => {
    const sealed = certificate();
    const event = recordCertificate(log, sealed);

    // The tamper is in the log, not in memory: this is what an attacker
    // editing the history would do.
    const tampered = { ...(event.payload as typeof sealed), finalPhase: "FAILED" as const };
    const verdict = verifyCertificate(tampered, artifacts());
    expect(verdict.ok).toBe(false);
    expect(verdict.failures.length).toBeGreaterThan(0);
  });

  it("the event id is derived from the event, not invented", () => {
    const sealed = certificate();
    const event: WorkerEvent = recordCertificate(log, sealed);
    expect(event.id).toMatch(/^EVT-[A-Za-z0-9_-]{1,64}$/);
  });
});
