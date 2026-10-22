/**
 * G5 idempotency, and the resume point it must not break.
 *
 * G5 says: re-appending a committed event id does not commit it twice. The
 * write path did not enforce it, and this file is the regression guard for
 * the enforcement.
 *
 * The second half of this file is the guard for the OTHER thing the
 * enforcement touched: the writer's resume point. Reading the committed
 * events back on open() must not change WHICH records the writer counts when
 * it decides where to continue — and in particular it must not stop counting
 * a record written under an EARLIER contract version. A record that a reader
 * can still read (the migration upgrades it on the way in) is a record whose
 * sequence is already spent.
 */
import { describe, it, expect } from "vitest";
import { EventLog } from "./event-log.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../canonical.js";
import { recordHash } from "./write-contract.js";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import { replay } from "./replay.js";

const CURRENT = "1.3.0";

function event(over: { id?: string; kind?: "DELEGATION_RECORDED"; subject?: string; at?: string; payload?: Record<string, unknown> } = {}) {
  return {
    id: over.id ?? "EVT-1",
    contractVersion: CURRENT as typeof CURRENT,
    kind: over.kind ?? ("DELEGATION_RECORDED" as const),
    subject: over.subject ?? "WC-1",
    actor: "process:test",
    at: over.at ?? "2026-10-21T00:00:00.000Z",
    payload: over.payload ?? { test: 1 },
  };
}

describe("G5 idempotency", () => {
  it("re-appending a committed event id returns the existing event and writes no second frame", () => {
    const workspace = mkdtempSync(join(tmpdir(), "anyplugin-g5-"));
    const log = EventLog.open(workspace);
    try {
      const first = log.append(event());
      const second = log.append(event());

      expect(second.id).toBe(first.id);
      expect(second.sequence).toBe(first.sequence);
      expect(log.nextSequence).toBe(1);
    } finally {
      log.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("still writes a DIFFERENT event id to the log", () => {
    // The guard on the guard: an implementation that deduplicated everything
    // would pass the test above while committing nothing at all.
    const workspace = mkdtempSync(join(tmpdir(), "anyplugin-g5-"));
    const log = EventLog.open(workspace);
    try {
      const first = log.append(event({ id: "EVT-1" }));
      const second = log.append(event({ id: "EVT-2" }));
      expect(second.sequence).toBe(first.sequence + 1);
      expect(log.nextSequence).toBe(2);
    } finally {
      log.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("reopens with the committed event still known, so a retry after a crash is idempotent too", () => {
    // The retry that matters is the one where the PROCESS DIED between
    // committing and the caller learning about it. The next process must
    // still recognise the id.
    const workspace = mkdtempSync(join(tmpdir(), "anyplugin-g5-"));
    const first = EventLog.open(workspace);
    const committed = first.append(event());
    first.close();

    const second = EventLog.open(workspace);
    try {
      const retry = second.append(event());
      expect(retry.id).toBe(committed.id);
      expect(retry.sequence).toBe(committed.sequence);
      expect(second.nextSequence).toBe(1);
    } finally {
      second.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe("the resume point survives a log written under an earlier contract version", () => {
  /**
   * A record as it was WRITTEN under contract 1.0.0 — still readable, because
   * the migration upgrades it on the way in. Its sequence is SPENT: the
   * writer must continue past it, or it will write a second record with a
   * sequence that is already on disk, which replay reports as "broken
   * writer" and which invents gaps out of nothing.
   */
  function writeOldRecord(workspace: string, sequence: number): void {
    const dir = join(workspace, STORAGE_ROOT_DIRNAME, "events");
    mkdirSync(dir, { recursive: true });
    const record = {
      id: "EVT-OLD",
      contractVersion: "1.0.0",
      kind: "STATE_TRANSITION",
      subject: "WC-1",
      actor: "worker-runtime/1.0.0",
      at: "2026-01-01T00:00:00.000Z",
      sequence,
      payload: { to: "PLANNING" },
    };
    const body = canonicalJson(record);
    const frame = `${recordHash({ id: record.id, payload: record })}\t${Buffer.byteLength(body, "utf8")}\t${body}\n`;
    writeFileSync(join(dir, "events.log"), frame, "utf8");
  }

  it("resumes past an older-contract record instead of reusing its sequence", () => {
    const workspace = mkdtempSync(join(tmpdir(), "anyplugin-resume-"));
    try {
      writeOldRecord(workspace, 7);

      const log = EventLog.open(workspace);
      try {
        // 8, not 0: the old record's sequence is spent.
        expect(log.nextSequence).toBe(8);
      } finally {
        log.close();
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("does not manufacture gaps: a record written after an older-contract one replays without anomalies", () => {
    const workspace = mkdtempSync(join(tmpdir(), "anyplugin-resume-"));
    try {
      writeOldRecord(workspace, 7);

      const log = EventLog.open(workspace);
      let appended: { sequence: number };
      try {
        appended = log.append({
          id: "EVT-NEW",
          contractVersion: CURRENT,
          kind: "STATE_TRANSITION",
          subject: "WC-1",
          actor: "worker-runtime/1.0.0",
          at: "2026-10-21T00:00:00.000Z",
          payload: { to: "EXECUTING" },
        });
      } finally {
        log.close();
      }
      expect(appended.sequence).toBe(8);

      // The whole point: a log that is intact must replay as intact. A resume
      // that reuses a sequence produces phantom gaps, and "gaps mean loss" is
      // a signal an operator acts on.
      const report = replay(join(workspace, STORAGE_ROOT_DIRNAME, "events"));
      expect(report.gaps).toEqual([]);
      expect(report.anomalies).toEqual([]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
