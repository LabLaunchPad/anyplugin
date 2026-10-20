/**
 * The delegation telemetry audit — the telemetry must actually LAND.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * The delegation telemetry used to have nowhere to live. `toLogRecords()`
 * existed and had **zero call sites**; the events were printed by `--json`
 * and otherwise dropped. So the wrapper's own account of what it did was
 * invisible, and the OKF bundle's claim that *"the telemetry goes to the
 * worker-runtime event log, not a log file"* was **false** — it was a
 * statement about an intent, and the intent had no implementation.
 *
 * Now the telemetry is in the event log, and the test that matters is the
 * one that reads it **back**: an event that is written and never read is
 * barely better than an event that is never written.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendCatalog } from "@lablaunchpad/core";
import { replay } from "@lablaunchpad/worker-runtime";
import { delegate, persistDelegationTelemetry } from "./delegate.js";

async function scriptBackend(
  dir: string,
  id: string,
  body: string,
): Promise<Record<string, unknown>> {
  const file = join(dir, `${id}.mjs`);
  await writeFile(file, body, "utf8");
  return {
    id,
    label: id,
    kind: "cli",
    command: process.execPath,
    args: [file],
    capabilities: {},
    domains: [],
    timeoutMs: 5_000,
    enabled: true,
    circuit: { failureThreshold: 3, cooldownMs: 1_000, successThreshold: 1 },
    env: {},
  };
}

describe("the delegation telemetry is persisted", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "delegate-telemetry-"));
  });

  afterEach(async () => {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("writes the delegation events into the worker-runtime event log", async () => {
    const backend = await scriptBackend(workDir, "one", `process.stdout.write("ok");`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [backend] });

    const result = await delegate({ catalog, cwd: workDir, args: [] });
    const written = persistDelegationTelemetry(result.events, workDir);

    expect(written.error, `the telemetry must be written: ${written.error}`).toBeUndefined();
    expect(written.written).toBe(result.events.length);

    // And it is READABLE — the test that matters.
    const report = replay(join(workDir, ".worker-runtime", "events"));
    expect(report.anomalies, "the log must be clean").toEqual([]);
    expect(report.events.length).toBe(result.events.length);
    expect(
      report.events.every((e) => e.kind === "DELEGATION_RECORDED"),
      "every persisted event must be a delegation record",
    ).toBe(true);
  });

  it("persists the FAILURE too, with its classification", async () => {
    const backend = await scriptBackend(workDir, "one", `process.exit(3);`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [backend] });

    const result = await delegate({ catalog, cwd: workDir, args: [] });
    persistDelegationTelemetry(result.events, workDir);

    const report = replay(join(workDir, ".worker-runtime", "events"));
    const delegation = report.events
      .map((e) => e.payload["delegation"] as { type?: string; failureClass?: string } | undefined)
      .filter((d): d is { type?: string; failureClass?: string } => d !== undefined);
    expect(delegation.some((d) => d.type === "DELEGATION_FAILED")).toBe(true);
    expect(delegation.some((d) => d.failureClass === "backend_failed")).toBe(true);
  });

  it("reports a telemetry failure instead of failing the delegation", async () => {
    // A log that cannot be claimed — another writer holds it — must not
    // fail the work, and must not be silent either.
    const backend = await scriptBackend(workDir, "one", `process.stdout.write("ok");`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [backend] });
    const result = await delegate({ catalog, cwd: workDir, args: [] });

    // Claim the log with a second writer, so the telemetry cannot be written.
    const { EventLog } = await import("@lablaunchpad/worker-runtime");
    const holder = EventLog.open(workDir, ".worker-runtime/events");
    try {
      const written = persistDelegationTelemetry(result.events, workDir);
      expect(written.written, "nothing could be written").toBe(0);
      expect(written.error, "the failure must be reported, not swallowed").toBeTruthy();
    } finally {
      holder.close();
    }
  });

  it("writes nothing when there is nothing to write", async () => {
    const written = persistDelegationTelemetry([], workDir);
    expect(written.written).toBe(0);
    expect(written.error).toBeUndefined();
  });
});
