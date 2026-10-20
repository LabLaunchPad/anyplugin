/**
 * The contract migration.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * The contract version moved from `1.0.0` to `1.1.0` so the delegation
 * telemetry could live in the same log as the work events. A frozen
 * contract is frozen because Certificates bind records by content hash, so
 * the old records must stay exactly as they were written — and a reader has
 * to be able to read them.
 *
 * The migration is a **widening**: the record's shape did not change, only
 * the vocabulary of event kinds. So the migration is the version string, and
 * nothing else.
 *
 * The end-to-end test is the one that matters: a `1.0.0` record written to
 * a log by an older build, and read by this one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../canonical.js";
import { CONTRACT_VERSION } from "./index.js";
import { migrateRecord } from "./migration.js";
import { replay } from "../log/replay.js";
import { recordHash } from "../log/write-contract.js";

const AT = "2024-01-01T00:00:00Z";

/** A record exactly as a `1.0.0` build would have written it. */
const LEGACY = {
  id: "EVT-legacy-1",
  contractVersion: "1.0.0",
  sequence: 0,
  at: AT,
  actor: "process:legacy-build",
  kind: "STATE_TRANSITION",
  subject: "WC-1",
  payload: { to: "PLANNING" },
};

/** Frame a record the way the log does. */
function frameOf(record: Record<string, unknown>): string {
  const body = canonicalJson(record);
  const hash = recordHash({ id: record["id"] as string, payload: record });
  return `${hash}\t${Buffer.byteLength(body, "utf8")}\t${body}\n`;
}

describe("the contract migration", () => {
  it("upgrades a 1.0.0 record", () => {
    const result = migrateRecord(LEGACY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.value as { contractVersion: string }).contractVersion).toBe(CONTRACT_VERSION);
  });

  it("changes NOTHING but the version", () => {
    const result = migrateRecord(LEGACY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const upgraded = result.value as Record<string, unknown>;
    expect({ ...upgraded, contractVersion: "1.0.0" }).toEqual(LEGACY);
  });

  it("leaves a current record exactly as it is", () => {
    const current = { ...LEGACY, contractVersion: CONTRACT_VERSION };
    const result = migrateRecord(current);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(current);
  });

  it("refuses an unknown FUTURE version rather than guessing at it", () => {
    const result = migrateRecord({ ...LEGACY, contractVersion: "2.0.0" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe("UNKNOWN_VERSION");
      expect(result.reason).toMatch(/unknown contract version/);
    }
  });

  it("does not treat a record with no version as a migratable record", () => {
    // The schema check diagnoses that better, so the migration steps aside.
    const result = migrateRecord({ not: "an event" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.kind).toBe("NOT_A_RECORD");
  });

  it("does not mutate the record it was given", () => {
    const input = { ...LEGACY };
    migrateRecord(input);
    expect(input).toEqual(LEGACY);
  });
});

describe("a log written by an older build", () => {
  let root: string;
  let logDir: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "contract-migration-"));
    logDir = join(root, ".worker-runtime", "events");
    await mkdir(logDir, { recursive: true });
  });

  afterAll(async () => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("REPLAYS a 1.0.0 record, upgraded on the way in", async () => {
    // The end-to-end proof: the bytes on disk are untouched, and the reader
    // understands them.
    const dir = join(root, "legacy");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.log"), frameOf(LEGACY), "utf8");

    const report = replay(dir);
    expect(report.anomalies, "a legacy record must not be an anomaly").toEqual([]);
    expect(report.events).toHaveLength(1);
    expect(report.events[0]?.id).toBe("EVT-legacy-1");
    expect(report.events[0]?.contractVersion, "the record is read at the current version").toBe(
      CONTRACT_VERSION,
    );
    expect(report.events[0]?.payload["to"], "and it still says what it said").toBe("PLANNING");
  });

  it("does not report a migrated record as TAMPERED", async () => {
    // The hash covers the bytes as they were written, so it is checked
    // against the raw body. Checking it after the migration would report
    // every legacy record as tampered — which is a false positive that
    // would make the tamper detection worthless.
    const dir = join(root, "legacy-hash");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.log"), frameOf(LEGACY), "utf8");
    const report = replay(dir);
    expect(report.anomalies.map((a) => a.reason)).not.toContain(
      "record content hash does not match the frame header",
    );
  });

  it("REFUSES a record from a FUTURE build", async () => {
    // Fail closed: a future version may have changed the shape, and reading
    // it as if it had not would be inventing a record.
    const dir = join(root, "future");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "events.log"), frameOf({ ...LEGACY, contractVersion: "2.0.0" }), "utf8");

    const report = replay(dir);
    expect(report.events).toHaveLength(0);
    expect(report.anomalies).toHaveLength(1);
    expect(report.anomalies[0]?.reason).toMatch(/contract version/);
  });

  it("still detects a TAMPERED legacy record", async () => {
    // The migration must not become a hole in the tamper detection. The
    // frame keeps the ORIGINAL hash and the body is changed — which is what
    // tampering is.
    const dir = join(root, "tampered");
    await mkdir(dir, { recursive: true });
    const originalHash = recordHash({ id: LEGACY.id, payload: LEGACY });
    const tamperedBody = canonicalJson({ ...LEGACY, payload: { to: "COMPLETED" } });
    await writeFile(
      join(dir, "events.log"),
      `${originalHash}\t${Buffer.byteLength(tamperedBody)}\t${tamperedBody}\n`,
      "utf8",
    );
    const report = replay(dir);
    expect(report.events).toHaveLength(0);
    expect(report.anomalies[0]?.reason).toMatch(/hash/);
  });

  it("writes no files of its own — a reader must not mutate history", async () => {
    const dir = join(root, "legacy-readonly");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "events.log");
    await writeFile(path, frameOf(LEGACY), "utf8");
    const before = await import("node:fs").then((fs) => fs.readFileSync(path, "utf8"));
    replay(dir);
    const after = await import("node:fs").then((fs) => fs.readFileSync(path, "utf8"));
    expect(after).toBe(before);
    expect(existsSync(path)).toBe(true);
  });
});
