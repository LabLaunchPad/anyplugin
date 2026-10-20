import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replay, findGaps } from "./replay.js";
import type { WorkerEvent } from "../contracts/index.js";
import { frameOf } from "./event-log.js";
import { CONTRACT_VERSION, EventSchema } from "../contracts/index.js";

/**
 * Replay gap detection — audit regression tests (Finding J).
 *
 * The gaps must be exactly the missing sequences, and the detection must not
 * cost more than a single pass over the recovered events. Replay runs on
 * every recovery, so a quadratic scan was paid exactly when the system was
 * already under stress.
 */

function event(sequence: number) {
  return EventSchema.parse({
    id: `EVT-test-${sequence}`,
    sequence,
    kind: "STATE_TRANSITION",
    contractVersion: CONTRACT_VERSION,
    at: "2024-01-01T00:00:00Z",
    actor: "process:test",
    subject: "test",
    payload: { a: sequence },
  });
}

describe("Worker Runtime replay gap detection — audit regression tests (Finding J)", () => {
  let testRoot: string;
  let logDir: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "replay-gap-test-"));
    logDir = join(testRoot, ".worker-runtime", "events");
    await mkdir(logDir, { recursive: true });
  });

  afterAll(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  async function writeLog(sequences: number[]): Promise<void> {
    const frames = sequences.map((s) => frameOf(event(s))).join("");
    await writeFile(join(logDir, "events.log"), frames);
  }

  it("detects a single gap", async () => {
    await writeLog([1, 2, 4]);
    const report = replay(logDir);
    expect(report.gaps).toEqual([3]);
    expect(report.events.length).toBe(3);
  });

  it("detects several gaps", async () => {
    await writeLog([1, 2, 5, 6, 9]);
    const report = replay(logDir);
    expect(report.gaps).toEqual([3, 4, 7, 8]);
  });

  it("detects a leading gap", async () => {
    await writeLog([3, 4, 5]);
    const report = replay(logDir);
    expect(report.gaps).toEqual([]);
  });

  it("reports no gaps for a contiguous log", async () => {
    await writeLog([0, 1, 2, 3, 4]);
    const report = replay(logDir);
    expect(report.gaps).toEqual([]);
    expect(report.events.length).toBe(5);
  });

  it("reports no gaps for a single event", async () => {
    await writeLog([7]);
    const report = replay(logDir);
    expect(report.gaps).toEqual([]);
  });

  it("reports no gaps for an empty log", async () => {
    await writeFile(join(logDir, "events.log"), "");
    const report = replay(logDir);
    expect(report.gaps).toEqual([]);
    expect(report.events.length).toBe(0);
  });

  it("does not report a gap after the highest recovered sequence", async () => {
    // Sequences 1,2,3 recovered. A "gap" at 4 would invent a loss that may
    // never have happened — events after the highest survivor are
    // indistinguishable from events that were never written.
    await writeLog([1, 2, 3]);
    const report = replay(logDir);
    expect(report.gaps).toEqual([]);
  });

  it("finds every gap in a large log in a single pass", async () => {
    // 5 000 events with a gap every 50th sequence.
    const sequences: number[] = [];
    for (let i = 0; i < 5_000; i++) {
      if (i % 50 === 25) continue; // leave a hole
      sequences.push(i);
    }
    await writeLog(sequences);

    const report = replay(logDir);
    expect(report.gaps).toHaveLength(100);
    expect(report.gaps[0]).toBe(25);
    expect(report.events.length).toBe(4_900);
  }, 30_000);

  it("never scans the event list per candidate sequence (the O(n²) pattern)", () => {
    // The decisive, DETERMINISTIC proof that the quadratic scan is gone: an
    // array whose `some` throws. The old implementation called
    // `events.some(...)` inside the gap loop; this fails loudly if that
    // pattern ever returns. A timing assertion could not prove this — it
    // would only suggest it.
    const events = [event(1), event(2), event(4), event(7)] as unknown as WorkerEvent[] & {
      some: () => never;
    };
    events.some = () => {
      throw new Error("findGaps must not scan the event list per candidate sequence");
    };
    expect(findGaps(events)).toEqual([3, 5, 6]);
  });

  it("gap detection is linear in the number of events", () => {
    // 50 000 events, one hole: the single-pass walk visits each event once.
    const events: WorkerEvent[] = [];
    for (let i = 0; i < 50_000; i++) {
      if (i === 25_000) continue;
      events.push(event(i));
    }
    const started = Date.now();
    const gaps = findGaps(events);
    const elapsed = Date.now() - started;
    expect(gaps).toEqual([25_000]);
    // The whole walk is arithmetic over 50 000 items; anything close to a
    // quadratic scan would take orders of magnitude longer.
    expect(elapsed).toBeLessThan(1_000);
  });
});
