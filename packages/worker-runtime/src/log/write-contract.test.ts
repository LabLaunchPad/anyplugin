/**
 * F10 — EVENT_WRITE_CONTRACT v1 conformance harness.
 *
 * Runs every candidate mechanism against every property that can be tested
 * reliably, on every cell of the CI matrix. The point is not to show that a
 * mechanism works; it is to find the record that comes back *plausibly wrong*.
 *
 * Two rules govern what is asserted here:
 *
 *  1. A property is asserted only where it is guaranteed by the mechanism, not
 *     where it merely happened to hold on the machine that ran the measurement.
 *     Concurrent appends of records larger than PIPE_BUF survived intact on
 *     Linux; POSIX does not promise that above PIPE_BUF and Windows promises
 *     nothing at all. So the *outcome* is recorded per platform and only the
 *     platform-independent guarantee — "nothing silently wrong" — is asserted.
 *     Asserting the observed-but-unpromised behaviour would convert UNKNOWN
 *     into VERIFIED, which is the one move this harness exists to prevent.
 *
 *  2. Candidate A's failure is pinned by a test rather than deleted. It is the
 *     evidence for why a checksum is mandatory; if someone later proposes a
 *     plain append, this test is the answer.
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CANDIDATES, CHECKSUMMED, ORDER_PRESERVING, plainAppend } from "./candidates.js";
import type { EventLogWriter, LogRecord } from "./write-contract.js";
import { PIPE_BUF } from "./write-contract.js";

/** Above PIPE_BUF on purpose: below it, a broken mechanism looks correct. */
const BIG = "x".repeat(PIPE_BUF * 2);

const dirs: string[] = [];
function fresh(w: EventLogWriter): string {
  const d = mkdtempSync(join(tmpdir(), "f10-"));
  dirs.push(d);
  w.init(d);
  return d;
}
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function rec(id: string, pad = ""): LogRecord {
  return { id, payload: { n: id, pad } };
}

/** The log file or event file a given candidate wrote `id` into. */
function targetOf(w: EventLogWriter, dir: string, id: string): string {
  return w.id.includes("per-event") ? join(dir, `${id}.event`) : join(dir, "events.log");
}

describe.each(CANDIDATES.map((c) => [c.id, c] as const))("EVENT_WRITE_CONTRACT v1 — %s", (_id, w) => {
  it("G1/G2 — recovers every committed event and accounts for every byte", () => {
    const dir = fresh(w);
    for (let i = 0; i < 8; i += 1) w.append(dir, rec(`E-${i}`, i % 2 ? BIG : ""));
    const r = w.replay(dir);
    expect(r.committed.map((c) => c.id).sort()).toEqual(["E-0", "E-1", "E-2", "E-3", "E-4", "E-5", "E-6", "E-7"]);
    expect(r.anomalies).toEqual([]);
    // G2: replay's own accounting must agree with what is on disk. A mismatch
    // means some region was neither committed nor classified — silently dropped.
    expect(r.bytesAccounted).toBe(r.bytesTotal);
  });

  it("G2 — a record cut off mid-write is classified, and earlier records survive", () => {
    const dir = fresh(w);
    for (let i = 0; i < 5; i += 1) w.append(dir, rec(`E-${i}`, BIG));
    const target = targetOf(w, dir, "E-4");
    truncateSync(target, statSync(target).size - 3000);

    const r = w.replay(dir);
    expect(r.anomalies.length, "the truncation must be detected, not ignored").toBeGreaterThan(0);
    expect(r.committed.length, "records written before the truncation must survive").toBe(4);
    // Nothing that survived may be damaged: a partial write must not shorten a
    // *previous* record.
    for (const c of r.committed) expect((c.payload as { pad: string }).pad).toBe(BIG);
  });

  it("G5 — appending a committed id twice never commits it twice", () => {
    const dir = fresh(w);
    w.append(dir, rec("E-dup"));
    w.append(dir, rec("E-dup"));
    expect(w.replay(dir).committed.filter((c) => c.id === "E-dup")).toHaveLength(1);
  });

  it("G4 — replaying identical bytes twice is identical, anomalies included", () => {
    const dir = fresh(w);
    for (let i = 0; i < 6; i += 1) w.append(dir, rec(`E-${i}`, i % 2 ? BIG : ""));
    truncateSync(targetOf(w, dir, "E-5"), statSync(targetOf(w, dir, "E-5")).size - 200);
    expect(JSON.stringify(w.replay(dir))).toBe(JSON.stringify(w.replay(dir)));
  });

  it("orders recovered events deterministically", () => {
    const dir = fresh(w);
    const appended = ["E-3", "E-1", "E-2"]; // deliberately not sorted
    for (const id of appended) w.append(dir, rec(id));
    const got = w.replay(dir).committed.map((c) => c.id);

    if (ORDER_PRESERVING.has(w.id)) {
      expect(got, "an append log must return events in the order they arrived").toEqual(appended);
    } else {
      // File-per-event candidates recover a deterministic total order but NOT
      // arrival order — a filename carries identity, not sequence. This is a
      // real cost of those mechanisms, recorded rather than glossed over.
      expect(got).toEqual([...appended].sort());
    }
  });
});

describe("G3 — a committed event must not silently become a different event", () => {
  /**
   * The decisive test. A single byte is changed inside a committed record so
   * that the result is still well-formed, still parseable, still the right
   * length — just not what was written. Nothing except a recorded checksum can
   * tell the difference.
   */
  function tamper(w: EventLogWriter): { rejected: boolean; silentlyAccepted: boolean } {
    const dir = fresh(w);
    for (let i = 0; i < 3; i += 1) w.append(dir, rec(`E-${i}`));
    const target = targetOf(w, dir, "E-1");
    const raw = readFileSync(target, "utf8");
    const flipped = raw.replace('"n":"E-1"', '"n":"E-9"');
    expect(flipped, "the tamper must actually change the bytes").not.toBe(raw);
    writeFileSync(target, flipped, "utf8");

    const r = w.replay(dir);
    return {
      rejected: r.anomalies.some((a) => a.classification === "REJECTED"),
      silentlyAccepted: r.committed.some((c) => (c.payload as { n: string }).n === "E-9"),
    };
  }

  it.each(CANDIDATES.filter((c) => CHECKSUMMED.has(c.id)).map((c) => [c.id, c] as const))(
    "%s rejects a tampered record",
    (_id, w) => {
      const out = tamper(w);
      expect(out.rejected).toBe(true);
      expect(out.silentlyAccepted, "a changed record must never be committed").toBe(false);
    },
  );

  it("plain append silently accepts a tampered record — the reason candidate A is rejected", () => {
    // This asserts a DEFECT, deliberately. It is the evidence for the rule that
    // every frame carries a checksum. If a future change makes this test fail
    // because plain append started detecting tampering, that is a welcome
    // surprise that must be investigated, not a test to delete.
    const out = tamper(plainAppend);
    expect(out.rejected).toBe(false);
    expect(out.silentlyAccepted).toBe(true);
  });
});

/**
 * Multi-process concurrency. Real OS processes, not worker threads: the
 * question is what the kernel does with interleaved writes to one inode, and
 * threads inside one process would not exercise it the same way.
 */
const DIST = join(import.meta.dirname, "..", "..", "dist", "log", "candidates.js");
const distBuilt = existsSync(DIST);

it("the concurrency harness is not silently skipped in CI", () => {
  // A skipped guard that reads as a pass is the exact ARMED-vs-PASSED failure.
  // Locally a missing dist/ means "you forgot to build"; in CI it is a defect.
  if (process.env["CI"]) expect(distBuilt, `built kernel missing at ${DIST}`).toBe(true);
  else expect(true).toBe(true);
});

describe.skipIf(!distBuilt)("concurrent writers (4 processes, records > PIPE_BUF)", () => {
  const WRITERS = 4;
  const PER_WRITER = 25;

  /**
   * Launches every writer with `spawn` and only then awaits them. `spawnSync`
   * would run them one after another, and a sequential "concurrency" test is
   * vacuous — it would pass for a mechanism with no concurrency safety at all.
   */
  async function runConcurrent(w: EventLogWriter) {
    const dir = fresh(w);
    const child = join(dir, "child.mjs");
    writeFileSync(
      child,
      `import { CANDIDATES } from ${JSON.stringify(pathToFileURL(DIST).href)};
const [, , id, dir, idx, count, pad] = process.argv;
const w = CANDIDATES.find((c) => c.id === id);
for (let i = 0; i < Number(count); i += 1) w.append(dir, { id: \`W\${idx}-E\${i}\`, payload: { n: \`W\${idx}-E\${i}\`, pad } });
`,
      "utf8",
    );
    const running = Array.from(
      { length: WRITERS },
      (_, i) =>
        new Promise<number>((resolve, reject) => {
          const p = spawn(process.execPath, [child, w.id, dir, String(i), String(PER_WRITER), BIG], { stdio: "ignore" });
          p.on("error", reject);
          p.on("exit", (code) => resolve(code ?? -1));
        }),
    );
    for (const code of await Promise.all(running)) {
      expect(code, "every writer process must exit cleanly").toBe(0);
    }
    return w.replay(dir);
  }

  it.each(CANDIDATES.map((c) => [c.id, c] as const))("%s never commits a silently wrong record", async (_id, w) => {
    const r = await runConcurrent(w);

    // The platform-independent guarantee. Whatever interleaving the OS chose,
    // no record may come back well-formed and wrong.
    for (const c of r.committed) {
      const p = c.payload as { n: string; pad: string };
      expect(p.n, `committed record ${c.id} carries another record's id`).toBe(c.id);
      expect(p.pad.length, `committed record ${c.id} has a damaged payload`).toBe(BIG.length);
    }
    expect(new Set(r.committed.map((c) => c.id)).size, "no id may be committed twice").toBe(r.committed.length);
    expect(r.bytesAccounted).toBe(r.bytesTotal);

    // Recorded, not asserted, for the append-based candidates: POSIX bounds
    // O_APPEND atomicity at PIPE_BUF and Windows makes no promise, so a loss
    // here is a property of the platform. The CI log carries the per-platform
    // number so the choice of mechanism rests on measurement.
    // eslint-disable-next-line no-console
    console.log(
      `[F10] ${process.platform} node${process.versions.node} ${w.id}: ` +
        `${r.committed.length}/${WRITERS * PER_WRITER} committed, ${r.anomalies.length} anomalies`,
    );
  });

  it.each(CANDIDATES.filter((c) => c.id.includes("per-event")).map((c) => [c.id, c] as const))(
    "%s loses nothing, because it never appends to a shared file",
    async (_id, w) => {
      // These candidates do not depend on append atomicity at any record size,
      // so completeness IS guaranteed here and is asserted rather than logged.
      const r = await runConcurrent(w);
      expect(r.committed).toHaveLength(WRITERS * PER_WRITER);
      expect(r.anomalies).toEqual([]);
    },
  );
});
