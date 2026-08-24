/**
 * Gate 3 acceptance tests: the durable event substrate.
 *
 * These test the invariants, not the implementation. Each is written so it
 * fails if the property is removed — a test that cannot fail is not evidence,
 * which is the lesson the F10 harness taught when its first draft ran its
 * "concurrent" writers sequentially.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRACT_VERSION, type WorkerEvent } from "../contracts/index.js";
import { OwnershipError } from "../ownership.js";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import { EventLog, EventLogError, LOG_FILENAME, WRITER_LOCK_FILENAME, frameOf } from "./event-log.js";
import { REPLAY_ANOMALIES, isClean, replay, replayDigest } from "./replay.js";
import { foldFromReplay, foldWorkerState, stateHash } from "./worker-state.js";

const TAB = "\t";
const roots: string[] = [];

function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "m2-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const EVENTS_DIR = `${STORAGE_ROOT_DIRNAME}/events`;
const logDirOf = (root: string) => join(root, EVENTS_DIR);
const logFileOf = (root: string) => join(logDirOf(root), LOG_FILENAME);
const framesOf = (root: string) =>
  readFileSync(logFileOf(root), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);

/** A valid event minus its sequence, which only the log may assign. */
function transition(n: number, to: string, contract = "WC-alpha"): Omit<WorkerEvent, "sequence"> {
  return {
    id: `EVT-${n}`,
    contractVersion: CONTRACT_VERSION,
    at: "2026-08-24T20:00:00Z",
    actor: "worker-runtime/1.0.0",
    kind: "STATE_TRANSITION",
    subject: contract,
    payload: { to },
  };
}

/** Drive one contract along a legal path: NEW→PLANNING→EXECUTING→VERIFYING→COMPLETED. */
function writeLegalHistory(root: string): EventLog {
  const log = EventLog.open(root);
  ["PLANNING", "EXECUTING", "VERIFYING", "COMPLETED"].forEach((phase, i) => log.append(transition(i, phase)));
  return log;
}

describe("ownership — the log cannot be opened outside kernel storage", () => {
  it("refuses a foreign-owned or traversing path before touching the filesystem", () => {
    const root = workspace();
    for (const bad of [".anyplugin", "notes", `${STORAGE_ROOT_DIRNAME}/events/../../escape`]) {
      expect(() => EventLog.open(root, bad), bad).toThrow(OwnershipError);
    }
  });

  it("accepts the declared events subdirectory", () => {
    const log = EventLog.open(workspace());
    expect(log.nextSequence).toBe(0);
    log.close();
  });
});

describe("single writer — a second writer is refused, never tolerated", () => {
  it("refuses a second open while the first holds the log", () => {
    const root = workspace();
    const first = EventLog.open(root);
    try {
      expect(() => EventLog.open(root)).toThrow(EventLogError);
      expect(() => EventLog.open(root)).toThrow(/already claimed/);
    } finally {
      first.close();
    }
  });

  it("refuses a second writer in a genuinely separate process", () => {
    // In-process, the refusal could be an artifact of shared state. A real
    // second process proves the filesystem is what refuses.
    const root = workspace();
    const first = EventLog.open(root);
    try {
      const script = join(root, "second.mjs");
      const distUrl = new URL("../../dist/log/event-log.js", import.meta.url).href;
      writeFileSync(
        script,
        `import { EventLog } from ${JSON.stringify(distUrl)};\n` +
          `try { EventLog.open(${JSON.stringify(root)}); console.log("ACQUIRED"); }\n` +
          `catch { console.log("REFUSED"); }\n`,
        "utf8",
      );
      const out = spawnSync(process.execPath, [script], { encoding: "utf8" });
      expect(out.stdout.trim(), "a separate process must not acquire the held log").toBe("REFUSED");
    } finally {
      first.close();
    }
  });

  it("releases the claim on close, so a later writer may take it", () => {
    const root = workspace();
    EventLog.open(root).close();
    const second = EventLog.open(root);
    expect(second.nextSequence).toBe(0);
    second.close();
  });

  it("never auto-breaks a stale lock", () => {
    // Breaking it would be indistinguishable from creating a second writer:
    // from here, a stale lock and a live one look identical.
    const root = workspace();
    EventLog.open(root).close();
    writeFileSync(
      join(logDirOf(root), WRITER_LOCK_FILENAME),
      '{"pid":999999,"host":"gone","claimedAt":"2026-01-01T00:00:00Z"}\n',
    );
    expect(() => EventLog.open(root)).toThrow(/refusing to become a second writer/);
    // ...and it names the deliberate resolution.
    expect(() => EventLog.open(root)).toThrow(new RegExp(WRITER_LOCK_FILENAME));
  });

  it("still refuses when the lock file is unreadable garbage", () => {
    const root = workspace();
    EventLog.open(root).close();
    writeFileSync(join(logDirOf(root), WRITER_LOCK_FILENAME), " not json");
    expect(() => EventLog.open(root)).toThrow(/unidentified writer/);
  });
});

describe("sequence — assigned by the owning writer", () => {
  it("assigns monotonically from zero with no gaps", () => {
    const root = workspace();
    writeLegalHistory(root).close();
    const report = replay(logDirOf(root));
    expect(report.events.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
    expect(report.gaps).toEqual([]);
  });

  it("resumes after the highest committed sequence rather than restarting", () => {
    // Restarting would emit duplicates — the contract's "broken writer" signal.
    // The log would corrupt itself merely by being reopened.
    const root = workspace();
    writeLegalHistory(root).close();
    const reopened = EventLog.open(root);
    expect(reopened.nextSequence).toBe(4);
    reopened.close();
  });

  it("does not let a damaged tail raise the resume point", () => {
    // If it did, corruption would become a permanent gap.
    const root = workspace();
    writeLegalHistory(root).close();
    truncateSync(logFileOf(root), statSync(logFileOf(root)).size - 20);
    const reopened = EventLog.open(root);
    expect(reopened.nextSequence).toBe(3);
    reopened.close();
  });

  it("does not burn a sequence number when the append is rejected", () => {
    const root = workspace();
    const log = EventLog.open(root);
    try {
      expect(() => log.append({ ...transition(0, "PLANNING"), id: "not-an-event-id" } as never)).toThrow();
      expect(log.nextSequence, "a rejected append must not manufacture a gap").toBe(0);
      log.append(transition(0, "PLANNING"));
      expect(log.nextSequence).toBe(1);
    } finally {
      log.close();
    }
  });
});

describe("gaps and duplicates are distinct failures", () => {
  it("reports a gap as loss, not as a writer error", () => {
    const root = workspace();
    writeLegalHistory(root).close();
    const kept = framesOf(root);
    writeFileSync(logFileOf(root), `${[kept[0], kept[2], kept[3]].join("\n")}\n`);

    const report = replay(logDirOf(root));
    expect(report.gaps, "the missing sequence must be named").toEqual([1]);
    expect(report.anomalies, "a gap is loss, not a rejected frame").toEqual([]);
    expect(isClean(report)).toBe(false);
  });

  it("reports a duplicate sequence as a broken writer, not as a gap", () => {
    const root = workspace();
    writeLegalHistory(root).close();
    appendFileSync(logFileOf(root), `${framesOf(root)[1]}\n`);

    const report = replay(logDirOf(root));
    expect(report.gaps).toEqual([]);
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]!.reason).toContain(REPLAY_ANOMALIES.DUPLICATE_SEQUENCE);
    expect(report.anomalies[0]!.classification).toBe("REJECTED");
  });

  it("does not invent gaps beyond the highest recovered event", () => {
    // Events after the last survivor are indistinguishable from events never
    // written; reporting them would manufacture losses.
    const root = workspace();
    writeLegalHistory(root).close();
    const lines = framesOf(root);
    writeFileSync(logFileOf(root), `${lines[0]}\n${lines[1]}\n`);
    expect(replay(logDirOf(root)).gaps).toEqual([]);
  });
});

describe("corruption is always detected and always accounted for", () => {
  const cases: [string, (logFile: string) => void, string][] = [
    [
      "a tampered payload",
      (f) => writeFileSync(f, readFileSync(f, "utf8").replace('"to":"EXECUTING"', '"to":"COMPLETED"')),
      REPLAY_ANOMALIES.HASH_MISMATCH,
    ],
    ["a truncated final record", (f) => truncateSync(f, statSync(f).size - 30), REPLAY_ANOMALIES.TRUNCATED],
    ["a frame with no header", (f) => appendFileSync(f, "garbage-without-separators\n"), REPLAY_ANOMALIES.FRAME_HEADER],
  ];

  for (const [name, corrupt, expectedReason] of cases) {
    it(`detects ${name} and accounts for every byte`, () => {
      const root = workspace();
      writeLegalHistory(root).close();
      corrupt(logFileOf(root));

      const report = replay(logDirOf(root));
      expect(report.anomalies.some((a) => a.reason.includes(expectedReason)), name).toBe(true);
      // G2: nothing silently dropped.
      expect(report.bytesAccounted, name).toBe(report.bytesTotal);
      expect(isClean(report)).toBe(false);
    });
  }

  it("never commits a tampered event, however well-formed it looks", () => {
    // The decisive property. The frame stays valid JSON, correct length and
    // schema-conformant — only the hash disagrees.
    const root = workspace();
    writeLegalHistory(root).close();
    writeFileSync(
      logFileOf(root),
      readFileSync(logFileOf(root), "utf8").replace('"to":"EXECUTING"', '"to":"COMPLETED"'),
    );

    const report = replay(logDirOf(root));
    expect(report.events.some((e) => e.sequence === 1 && e.payload["to"] === "COMPLETED")).toBe(false);
  });

  it("rejects a well-framed record that is not an Event", () => {
    const root = workspace();
    writeLegalHistory(root).close();
    const body = JSON.stringify({ not: "an event" });
    appendFileSync(logFileOf(root), `sha256:${"0".repeat(64)}${TAB}${Buffer.byteLength(body)}${TAB}${body}\n`);

    expect(replay(logDirOf(root)).anomalies.some((a) => a.reason === REPLAY_ANOMALIES.SCHEMA)).toBe(true);
  });

  it("accounts for every byte of an empty log", () => {
    const root = workspace();
    EventLog.open(root).close();
    const report = replay(logDirOf(root));
    expect(report).toMatchObject({ events: [], anomalies: [], gaps: [], bytesAccounted: 0, bytesTotal: 0 });
    expect(isClean(report)).toBe(true);
  });
});

describe("replay is deterministic", () => {
  it("produces an identical report twice, anomalies included", () => {
    const root = workspace();
    writeLegalHistory(root).close();
    truncateSync(logFileOf(root), statSync(logFileOf(root)).size - 25); // damage is part of the comparison
    expect(replayDigest(replay(logDirOf(root)))).toBe(replayDigest(replay(logDirOf(root))));
  });

  it("reconstructs byte-identical state from identical history", () => {
    const root = workspace();
    writeLegalHistory(root).close();
    const a = stateHash(foldFromReplay(replay(logDirOf(root))));
    const b = stateHash(foldFromReplay(replay(logDirOf(root))));
    expect(a).toBe(b);
  });

  it("reconstructs the same state in a different workspace from the same events", () => {
    // Determinism must not depend on where the log happens to live.
    const one = workspace();
    const two = workspace();
    writeLegalHistory(one).close();
    writeLegalHistory(two).close();
    expect(stateHash(foldFromReplay(replay(logDirOf(one))))).toBe(stateHash(foldFromReplay(replay(logDirOf(two)))));
  });

  it("orders recovered events by sequence regardless of byte order", () => {
    const root = workspace();
    writeLegalHistory(root).close();
    const lines = framesOf(root);
    writeFileSync(logFileOf(root), `${[lines[3], lines[1], lines[0], lines[2]].join("\n")}\n`);
    expect(replay(logDirOf(root)).events.map((e) => e.sequence)).toEqual([0, 1, 2, 3]);
  });
});

describe("state fold — the phase machine is enforced, never coerced", () => {
  it("folds a legal history to its final phase", () => {
    const root = workspace();
    writeLegalHistory(root).close();
    const folded = foldFromReplay(replay(logDirOf(root)));
    expect(folded.states.get("WC-alpha")?.phase).toBe("COMPLETED");
    expect(folded.states.get("WC-alpha")?.revision).toBe(3);
    expect(folded.rejected).toEqual([]);
  });

  it("rejects an illegal transition instead of applying it", () => {
    // NEW -> COMPLETED skips the entire lifecycle. Coercing it would let an
    // impossible log produce a plausible state.
    const folded = foldWorkerState([{ ...transition(0, "COMPLETED"), sequence: 0 } as WorkerEvent]);
    expect(folded.states.size).toBe(0);
    expect(folded.rejected).toHaveLength(1);
    expect(folded.rejected[0]!.reason).toContain("illegal transition NEW -> COMPLETED");
  });

  it("rejects a payload whose target is not a phase", () => {
    const folded = foldWorkerState([{ ...transition(0, "NOT_A_PHASE"), sequence: 0 } as WorkerEvent]);
    expect(folded.rejected[0]!.reason).toContain("not a worker phase");
  });

  it("counts revisions of applied transitions only", () => {
    const folded = foldWorkerState([
      { ...transition(0, "PLANNING"), sequence: 0 },
      { ...transition(1, "COMPLETED"), sequence: 1 }, // illegal from PLANNING
      { ...transition(2, "EXECUTING"), sequence: 2 },
    ] as WorkerEvent[]);
    expect(folded.states.get("WC-alpha")?.phase).toBe("EXECUTING");
    expect(folded.states.get("WC-alpha")?.revision, "the rejected transition must not count").toBe(1);
  });

  it("keeps separate contracts independent", () => {
    const folded = foldWorkerState([
      { ...transition(0, "PLANNING", "WC-alpha"), sequence: 0 },
      { ...transition(1, "PLANNING", "WC-beta"), sequence: 1 },
      { ...transition(2, "EXECUTING", "WC-alpha"), sequence: 2 },
    ] as WorkerEvent[]);
    expect(folded.states.get("WC-alpha")?.phase).toBe("EXECUTING");
    expect(folded.states.get("WC-beta")?.phase).toBe("PLANNING");
  });

  it("ignores event kinds it does not interpret, without failing", () => {
    const folded = foldWorkerState([
      { ...transition(0, "PLANNING"), sequence: 0 },
      { ...transition(1, "PLANNING"), kind: "EVIDENCE_ADDED", sequence: 1 },
    ] as WorkerEvent[]);
    expect(folded.ignored).toBe(1);
    expect(folded.rejected).toEqual([]);
  });

  it("hashes state independently of contract insertion order", () => {
    const a = foldWorkerState([
      { ...transition(0, "PLANNING", "WC-alpha"), sequence: 0 },
      { ...transition(1, "PLANNING", "WC-beta"), sequence: 1 },
    ] as WorkerEvent[]);
    const b = foldWorkerState([
      { ...transition(0, "PLANNING", "WC-beta"), sequence: 0 },
      { ...transition(1, "PLANNING", "WC-alpha"), sequence: 1 },
    ] as WorkerEvent[]);
    expect(stateHash(a)).toBe(stateHash(b));
  });
});

describe("frame format matches the measured F10 candidate", () => {
  it("emits hash, declared length, and canonical body", () => {
    // If this drifts, the F10 measurements no longer describe this code.
    const frame = frameOf({ ...transition(0, "PLANNING"), sequence: 0 } as WorkerEvent);
    const [hash, length, body] = frame.trimEnd().split(TAB);
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Number(length)).toBe(Buffer.byteLength(body!, "utf8"));
    expect(frame.endsWith("\n")).toBe(true);
  });
});
