/**
 * U1a — PROCESS-CRASH RESILIENCE. Not durability.
 *
 * The property, stated narrowly on purpose:
 *
 *   An abrupt process termination during an event-log write may lose work or
 *   leave a detectably incomplete record. It must NEVER leave a record that
 *   replay silently accepts as valid.
 *
 * What this does NOT establish, and must never be cited for: fsync durability,
 * OS-crash survival, power-loss safety, or storage-device failure. Those are
 * U1b and remain UNKNOWN. A SIGKILL removes the *process*; the kernel page
 * cache is untouched and the filesystem is never asked to lose anything. Using
 * a process kill as evidence about power loss would be exactly the
 * observation-boundary error F18 was about.
 *
 * ── Why this harness classifies instead of asserting ───────────────────────
 *
 * `EventLog.append` issues a SINGLE `appendFileSync`. A kill therefore lands in
 * one of three places: before the syscall (nothing written), inside it (a torn
 * tail is possible), or after it (a complete record). The middle case is the
 * only one that exercises tear handling, and it is the RAREST.
 *
 * So a naive version of this test — kill, replay, assert no corruption — passes
 * overwhelmingly often by landing on a clean boundary, having torn nothing. It
 * would report "crash-resilient" while never once exercising the property. That
 * is the F16/F18 class, and this time it was predicted before the code was
 * written rather than discovered afterwards.
 *
 * Every trial is therefore classified and counted, and the outcome distribution
 * is reported. Universal invariants are asserted on every trial; the claim about
 * *tear handling specifically* is only as strong as the number of torn tails
 * actually observed, which the report states rather than assumes.
 *
 * Deterministic tear handling is separately and non-probabilistically proven by
 * the truncation tests in `event-log.test.ts`. This file adds the missing half:
 * that a real abrupt kill produces states inside that already-handled set.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import { LOG_FILENAME, WRITER_LOCK_FILENAME } from "./event-log.js";
import { REPLAY_ANOMALIES, replay, replayDigest } from "./replay.js";
import { foldFromReplay, stateHash } from "./worker-state.js";

/** Spawn-heavy and concurrent with the rest of the workspace (F17). */
vi.setConfig({ testTimeout: 30_000 });

const DIST_DIR = join(import.meta.dirname, "..", "..", "dist", "log");
const distBuilt = existsSync(join(DIST_DIR, "event-log.js"));

const roots: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "u1a-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const logDirOf = (root: string) => join(root, `${STORAGE_ROOT_DIRNAME}/events`);
const logFileOf = (root: string) => join(logDirOf(root), LOG_FILENAME);

/**
 * How a killed writer left the log.
 *
 * CLEAN_BOUNDARY is deliberately NOT called a success: it means the kill landed
 * between records and the trial exercised nothing.
 */
type Outcome = "NO_WRITES" | "CLEAN_BOUNDARY" | "TORN_TAIL" | "CORRUPTED";

interface Trial {
  outcome: Outcome;
  committed: number;
  anomalies: string[];
  bytesAccounted: boolean;
}

/** Child writes big records continuously until killed. Never closes cleanly. */
function writerScript(dir: string): string {
  return (
    `import { EventLog } from ${JSON.stringify(pathToFileURL(join(DIST_DIR, "event-log.js")).href)};\n` +
    `const log = EventLog.open(${JSON.stringify(dir)});\n` +
    // Record size is NOT arbitrary. Measured on Linux: a 256KB write completes
    // atomically with respect to SIGKILL, while writes at and above ~1MB tear.
    // The first version of this harness used 256KB and produced ZERO torn tails
    // in six trials — it passed while exercising nothing. 2MB is above the
    // measured threshold with margin.
    `const pad = "x".repeat(2 * 1024 * 1024);\n` +
    `process.stdout.write("READY\\n");\n` +
    `for (let i = 0; i < 100000; i += 1) {\n` +
    `  log.append({ id: "EVT-" + i, contractVersion: "1.0.0", at: "2026-08-24T20:00:00Z",\n` +
    `    actor: "worker-runtime/1.0.0", kind: "STATE_TRANSITION", subject: "WC-alpha",\n` +
    `    payload: { to: i === 0 ? "PLANNING" : "EXECUTING", pad } });\n` +
    `}\n`
  );
}

/** Run one crash trial: spawn a writer, kill it abruptly, classify the log. */
async function crashTrial(killAfterMs: number): Promise<Trial> {
  const root = workspace();
  const script = join(root, "writer.mjs");
  writeFileSync(script, writerScript(root), "utf8");

  const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
  await new Promise<void>((resolve) => {
    let seen = false;
    child.stdout.on("data", () => {
      if (!seen) {
        seen = true;
        resolve();
      }
    });
    child.on("exit", () => resolve());
  });
  await new Promise((r) => setTimeout(r, killAfterMs));
  // SIGKILL: no handler, no flush, no cleanup. On Windows this maps to
  // TerminateProcess, which is equally abrupt.
  child.kill("SIGKILL");
  await new Promise<void>((resolve) => child.on("exit", () => resolve()));

  if (!existsSync(logFileOf(root))) {
    return { outcome: "NO_WRITES", committed: 0, anomalies: [], bytesAccounted: true };
  }

  const report = replay(logDirOf(root));
  const reasons = report.anomalies.map((a) => a.reason);
  const bytesAccounted = report.bytesAccounted === report.bytesTotal;

  // Every committed record must be exactly what a writer would have produced.
  // This is the invariant that matters: a torn tail is acceptable, a plausible
  // wrong record is not.
  const silentlyWrong = report.events.some((e) => {
    const p = e.payload as { to?: unknown; pad?: unknown };
    return typeof p.pad !== "string" || p.pad.length !== 2 * 1024 * 1024;
  });

  let outcome: Outcome;
  if (silentlyWrong || reasons.some((r) => r.includes(REPLAY_ANOMALIES.HASH_MISMATCH) || r.includes(REPLAY_ANOMALIES.DUPLICATE_SEQUENCE))) {
    outcome = "CORRUPTED";
  } else if (report.anomalies.length > 0) {
    outcome = "TORN_TAIL";
  } else if (report.events.length === 0) {
    outcome = "NO_WRITES";
  } else {
    outcome = "CLEAN_BOUNDARY";
  }

  return { outcome, committed: report.events.length, anomalies: reasons, bytesAccounted };
}

it("the U1a harness is not silently skipped in CI", () => {
  if (process.env["CI"]) expect(distBuilt, `built kernel missing at ${DIST_DIR}`).toBe(true);
  else expect(true).toBe(true);
});

describe.skipIf(!distBuilt)("U1a — a killed writer never leaves a plausibly-wrong record", () => {
  const TRIALS = [10, 25, 45, 70, 100, 140];

  it("every trial leaves a state replay classifies correctly", async () => {
    const results: Trial[] = [];
    for (const ms of TRIALS) results.push(await crashTrial(ms));

    for (const [i, t] of results.entries()) {
      // The universal invariants — true regardless of where the kill landed.
      expect(t.outcome, `trial ${i} (${TRIALS[i]}ms): ${t.anomalies.join("; ")}`).not.toBe("CORRUPTED");
      expect(t.bytesAccounted, `trial ${i}: every byte must be accounted for`).toBe(true);
    }

    const dist = results.reduce<Record<string, number>>((acc, t) => {
      acc[t.outcome] = (acc[t.outcome] ?? 0) + 1;
      return acc;
    }, {});
    // Reported, not asserted. How often a kill lands mid-write is a property of
    // the platform's scheduler and write path, not of this code — asserting a
    // distribution would make the suite fail for reasons unrelated to the
    // invariant (F17's class applied to a probability).
    // eslint-disable-next-line no-console
    console.log(
      `[U1a] ${process.platform} node${process.versions.node} outcomes=${JSON.stringify(dist)} ` +
        `committed=${results.map((r) => r.committed).join(",")}`,
    );
  });

  it("replay after an abrupt kill is deterministic", async () => {
    // A crashed log must not replay differently on each attempt, or two
    // operators recovering it reach different conclusions about what survived.
    const root = workspace();
    const script = join(root, "writer.mjs");
    writeFileSync(script, writerScript(root), "utf8");
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => {
      child.stdout.on("data", () => resolve());
      child.on("exit", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 30));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    if (!existsSync(logFileOf(root))) return; // nothing was written; nothing to assert
    expect(replayDigest(replay(logDirOf(root)))).toBe(replayDigest(replay(logDirOf(root))));
    expect(stateHash(foldFromReplay(replay(logDirOf(root))))).toBe(
      stateHash(foldFromReplay(replay(logDirOf(root)))),
    );
  });

  it("a crashed writer leaves its lock held — recovery needs a deliberate act", async () => {
    // A real consequence of "never auto-break a stale lock", recorded rather
    // than discovered later: after a crash the log cannot be REOPENED FOR
    // WRITING without someone removing writer.lock. Recovery by REPLAY is
    // unaffected, because replay reads a directory and takes no lock — which is
    // what makes the strict lock policy affordable.
    const root = workspace();
    const script = join(root, "writer.mjs");
    writeFileSync(script, writerScript(root), "utf8");
    const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "ignore"] });
    await new Promise<void>((resolve) => {
      child.stdout.on("data", () => resolve());
      child.on("exit", () => resolve());
    });
    await new Promise((r) => setTimeout(r, 25));
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));

    expect(existsSync(join(logDirOf(root), WRITER_LOCK_FILENAME)), "the dead writer's lock remains").toBe(true);
    const { EventLog } = await import("./event-log.js");
    expect(() => EventLog.open(root)).toThrow(/refusing to become a second writer/);
    // ...but the evidence is still fully readable.
    expect(() => replay(logDirOf(root))).not.toThrow();
  });
});

describe("the U1a classifier can fail", () => {
  /**
   * Anti-vacuity for the classifier itself.
   *
   * The first version of this section corrupted a CRASHED log — and at 2MB
   * records a crashed log frequently contains no committed record at all, so
   * the mutation found nothing to alter and the classifier was handed a clean
   * input. A probabilistic check of a detector is worthless: it has to be
   * deterministic, or it is testing the scheduler.
   *
   * So these build the corrupt state directly from a cleanly-written log. The
   * crash trials above establish what a kill produces; these establish that the
   * classifier would have reported CORRUPTED had a kill produced it.
   */
  async function writeCleanLog(): Promise<string> {
    const { EventLog } = await import("./event-log.js");
    const root = workspace();
    const log = EventLog.open(root);
    try {
      for (const [i, to] of ["PLANNING", "EXECUTING", "VERIFYING"].entries()) {
        log.append({
          id: `EVT-${i}`,
          contractVersion: "1.0.0",
          at: "2026-08-24T20:00:00Z",
          actor: "worker-runtime/1.0.0",
          kind: "STATE_TRANSITION",
          subject: "WC-alpha",
          payload: { to },
        });
      }
    } finally {
      log.close();
    }
    return root;
  }

  it("reports a hash mismatch when a committed record is altered", async () => {
    const root = await writeCleanLog();
    const before = readFileSync(logFileOf(root), "utf8");
    const after = before.replace('"to":"EXECUTING"', '"to":"COMPLETED"');
    expect(after, "the mutation must actually change bytes").not.toBe(before);
    writeFileSync(logFileOf(root), after);

    const reasons = replay(logDirOf(root)).anomalies.map((a) => a.reason);
    expect(reasons.some((r) => r.includes(REPLAY_ANOMALIES.HASH_MISMATCH))).toBe(true);
  });

  it("reports a duplicate sequence when a record is replayed into the log", async () => {
    const root = await writeCleanLog();
    const frames = readFileSync(logFileOf(root), "utf8").split("\n").filter((l) => l.length > 0);
    expect(frames.length).toBeGreaterThan(0);
    writeFileSync(logFileOf(root), `${[...frames, frames[0]!].join("\n")}\n`);

    const reasons = replay(logDirOf(root)).anomalies.map((a) => a.reason);
    expect(reasons.some((r) => r.includes(REPLAY_ANOMALIES.DUPLICATE_SEQUENCE))).toBe(true);
  });

  it("reports a torn tail when a record is cut mid-write", async () => {
    // The exact state a crash produces, constructed deterministically — so the
    // classifier's TORN_TAIL path is proven even on a platform or run where no
    // kill happens to tear anything.
    const root = await writeCleanLog();
    const file = logFileOf(root);
    truncateSync(file, statSync(file).size - 40);

    const report = replay(logDirOf(root));
    expect(report.anomalies.map((a) => a.reason)).toContain(REPLAY_ANOMALIES.TRUNCATED);
    expect(report.bytesAccounted).toBe(report.bytesTotal);
    expect(report.events.length, "records before the tear survive").toBe(2);
  });
});
