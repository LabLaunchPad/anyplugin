import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, DEFAULT_DURABILITY, type DurabilityLevel } from "./event-log.js";
import { replay } from "./replay.js";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import { CONTRACT_VERSION, type WorkerEvent } from "../contracts/index.js";

/**
 * Event log durability — audit regression tests (Finding K).
 *
 * The audit finding was that the log's durability was neither documented nor
 * tested: "Event log not crash-durable: no fsync, append hands bytes to OS
 * only." The fix is not to silently claim power-loss durability — it is to
 * make the level an explicit, stated, testable choice, so a caller knows
 * exactly what failure it is tolerating.
 */

const roots: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "durability-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const EVENTS_DIR = `${STORAGE_ROOT_DIRNAME}/events`;
const logDirOf = (root: string) => join(root, EVENTS_DIR);

function transition(n: number): Omit<WorkerEvent, "sequence"> {
  return {
    id: `EVT-${n}`,
    contractVersion: CONTRACT_VERSION,
    at: "2026-08-24T20:00:00Z",
    actor: "worker-runtime/1.0.0",
    kind: "STATE_TRANSITION",
    subject: "WC-alpha",
    payload: { to: "PLANNING" },
  };
}

describe("event log durability — audit regression tests (Finding K)", () => {
  it("defaults to best-effort and says so", () => {
    expect(DEFAULT_DURABILITY).toBe("best-effort");
    const log = EventLog.open(workspace());
    expect(log.durability).toBe("best-effort");
    log.close();
  });

  it("reports the durability level the caller asked for", () => {
    for (const level of ["best-effort", "process-crash", "power-loss"] as DurabilityLevel[]) {
      const log = EventLog.open(workspace(), EVENTS_DIR, { durability: level });
      expect(log.durability).toBe(level);
      log.close();
    }
  });

  it("writes and replays correctly at every durability level", () => {
    for (const level of ["best-effort", "process-crash", "power-loss"] as DurabilityLevel[]) {
      const root = workspace();
      const log = EventLog.open(root, EVENTS_DIR, { durability: level });
      log.append(transition(0));
      log.append(transition(1));
      log.close();

      const report = replay(logDirOf(root));
      expect(report.events.map((e) => e.sequence), level).toEqual([0, 1]);
      expect(report.gaps, level).toEqual([]);
      expect(report.anomalies, level).toEqual([]);
    }
  });

  it("keeps the frame format identical at every level", () => {
    // The F10 measurements were taken against this frame format. A durability
    // level must not change the bytes on the wire.
    const bytes: string[] = [];
    for (const level of ["best-effort", "process-crash", "power-loss"] as DurabilityLevel[]) {
      const root = workspace();
      const log = EventLog.open(root, EVENTS_DIR, { durability: level });
      log.append(transition(0));
      log.close();
      bytes.push(readFileSync(join(logDirOf(root), "events.log"), "utf8"));
    }
    expect(bytes[1]).toBe(bytes[0]);
    expect(bytes[2]).toBe(bytes[0]);
  });

  it("a stronger level still refuses a second writer", () => {
    // Durability must not weaken the single-writer invariant.
    const root = workspace();
    const first = EventLog.open(root, EVENTS_DIR, { durability: "power-loss" });
    try {
      expect(() => EventLog.open(root, EVENTS_DIR, { durability: "power-loss" })).toThrow(/already claimed/);
    } finally {
      first.close();
    }
  });

  it("a rejected append does not burn a sequence at any level", () => {
    for (const level of ["best-effort", "process-crash", "power-loss"] as DurabilityLevel[]) {
      const log = EventLog.open(workspace(), EVENTS_DIR, { durability: level });
      try {
        expect(() => log.append({ ...transition(0), id: "not-an-event-id" } as never)).toThrow();
        expect(log.nextSequence, level).toBe(0);
        log.append(transition(0));
        expect(log.nextSequence, level).toBe(1);
      } finally {
        log.close();
      }
    }
  });

  it("does not corrupt an existing log when reopened at a stronger level", () => {
    const root = workspace();
    const first = EventLog.open(root, EVENTS_DIR);
    first.append(transition(0));
    first.close();

    const second = EventLog.open(root, EVENTS_DIR, { durability: "power-loss" });
    expect(second.nextSequence).toBe(1);
    second.append(transition(1));
    second.close();

    const report = replay(logDirOf(root));
    expect(report.events.map((e) => e.sequence)).toEqual([0, 1]);
    expect(report.gaps).toEqual([]);
  });

  it("a truncated log is still detected as damaged at the strongest level", () => {
    // fsync does not make the log tamper-proof: framing and hashing do.
    const root = workspace();
    const log = EventLog.open(root, EVENTS_DIR, { durability: "power-loss" });
    log.append(transition(0));
    log.append(transition(1));
    log.close();

    const file = join(logDirOf(root), "events.log");
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace('"to":"PLANNING"', '"to":"COMPLETED"'));

    const report = replay(logDirOf(root));
    expect(report.events.some((e) => e.payload["to"] === "COMPLETED")).toBe(false);
    expect(report.anomalies.length).toBeGreaterThan(0);
  });

  it("the log file exists on disk after the first append at every level", () => {
    for (const level of ["best-effort", "process-crash", "power-loss"] as DurabilityLevel[]) {
      const root = workspace();
      const log = EventLog.open(root, EVENTS_DIR, { durability: level });
      log.append(transition(0));
      expect(existsSync(join(logDirOf(root), "events.log")), level).toBe(true);
      log.close();
    }
  });
});
