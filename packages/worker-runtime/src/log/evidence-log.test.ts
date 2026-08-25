/**
 * M3 acceptance tests: the durable evidence substrate.
 *
 * Same discipline as Gate 3 (`event-log.test.ts`): every test is written so it
 * fails if the property is removed. Where M3's preflight explicitly declined
 * to claim something "by analogy" to the event log (ordering, gap/duplicate
 * detection, replay determinism), this file proves it independently rather
 * than assuming EventLog's proof carries over.
 */
import { afterEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, type Evidence } from "../contracts/index.js";
import { OwnershipError } from "../ownership.js";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import {
  EVIDENCE_LOG_FILENAME,
  EVIDENCE_WRITER_LOCK_FILENAME,
  EvidenceLog,
  EvidenceLogError,
  frameOfEntry,
} from "./evidence-log.js";
import { EVIDENCE_REPLAY_ANOMALIES, evidenceReplayDigest, isEvidenceReplayClean, replayEvidence } from "./evidence-replay.js";
import { foldEvidenceFromReplay, foldEvidenceState } from "./evidence-state.js";

const roots: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "m3-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const EVIDENCE_DIR = `${STORAGE_ROOT_DIRNAME}/evidence`;
const dirOf = (root: string) => join(root, EVIDENCE_DIR);
const logFileOf = (root: string) => join(dirOf(root), EVIDENCE_LOG_FILENAME);
const framesOf = (root: string) =>
  readFileSync(logFileOf(root), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);

function evidence(n: number, overrides: Partial<Evidence> = {}): Evidence {
  return {
    id: `EV-${n}`,
    contractVersion: CONTRACT_VERSION,
    kind: "TEST_RESULT",
    source: "pnpm test",
    contentHash: "sha256:" + "a".repeat(64),
    authority: "AUTHORITATIVE",
    provenance: { by: "worker-runtime/1.0.0", at: "2026-08-24T20:00:00Z" },
    validity: "VALID",
    ...overrides,
  };
}

describe("EvidenceLog.open — single writer (I1)", () => {
  it("claims a fresh directory and creates the log lazily", () => {
    const root = workspace();
    const log = EvidenceLog.open(root);
    expect(log.nextSequence).toBe(0);
    log.close();
  });

  it("refuses a second writer while the first holds the lock", () => {
    const root = workspace();
    const first = EvidenceLog.open(root);
    expect(() => EvidenceLog.open(root)).toThrow(EvidenceLogError);
    first.close();
  });

  it("the refusal is real: a second open succeeds once the lock is released", () => {
    // Anti-vacuity: proves the guard above can pass for the right reason, not
    // merely that EvidenceLog.open can throw for any reason.
    const root = workspace();
    const first = EvidenceLog.open(root);
    first.close();
    const second = EvidenceLog.open(root);
    second.close();
  });

  it("resumes entrySequence from what is already on disk rather than restarting at 0", () => {
    const root = workspace();
    const first = EvidenceLog.open(root);
    first.appendBase(evidence(1));
    first.appendBase(evidence(2));
    first.close();

    const second = EvidenceLog.open(root);
    expect(second.nextSequence).toBe(2);
    second.close();
  });
});

describe("appendBase — identity is write-once", () => {
  it("assigns entrySequence starting at 0", () => {
    const root = workspace();
    const log = EvidenceLog.open(root);
    const e0 = log.appendBase(evidence(1));
    const e1 = log.appendBase(evidence(2));
    expect(e0.entrySequence).toBe(0);
    expect(e1.entrySequence).toBe(1);
    log.close();
  });

  it("refuses a second BASE for an id already known in-process", () => {
    const root = workspace();
    const log = EvidenceLog.open(root);
    log.appendBase(evidence(1));
    expect(() => log.appendBase(evidence(1))).toThrow(EvidenceLogError);
    log.close();
  });

  it("refuses a second BASE for an id already committed by a prior writer", () => {
    const root = workspace();
    const first = EvidenceLog.open(root);
    first.appendBase(evidence(1));
    first.close();

    const second = EvidenceLog.open(root);
    expect(() => second.appendBase(evidence(1))).toThrow(EvidenceLogError);
    second.close();
  });

  it("refuses a BASE record that is not VALID — a record cannot be born already invalidated", () => {
    const root = workspace();
    const log = EvidenceLog.open(root);
    expect(() => log.appendBase(evidence(1, { validity: "INVALIDATED", invalidationReason: "x" }))).toThrow(
      EvidenceLogError,
    );
    log.close();
  });
});

describe("frameOfEntry — same integrity envelope EventLog measured", () => {
  it("produces hash\\tlength\\tbody, and the length matches the body's actual byte length", () => {
    const root = workspace();
    const log = EvidenceLog.open(root);
    log.appendBase(evidence(1));
    log.close();
    const [frame] = framesOf(root);
    const [hash, len, ...rest] = frame!.split("\t");
    const body = rest.join("\t");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Number(len)).toBe(Buffer.byteLength(body, "utf8"));
  });
});

describe("ownership — evidence log routes through assertWritable (I1/I2 parity)", () => {
  it("refuses a directory outside kernel-owned storage", () => {
    expect(() => EvidenceLog.open("/tmp/whatever", "../escape")).toThrow(OwnershipError);
  });
});
