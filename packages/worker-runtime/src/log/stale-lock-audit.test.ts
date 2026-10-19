import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { EventLog } from "./event-log.js";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("Worker Runtime stale lock — audit regression tests (Finding L)", () => {
  let testRoot: string;
  let logDir: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "stale-lock-test-"));
    logDir = join(testRoot, ".worker-runtime", "events");
    await mkdir(logDir, { recursive: true });
  });

  afterAll(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    // Clean up any lock file between tests
    const lockPath = join(logDir, "writer.lock");
    try {
      await rm(lockPath, { force: true });
    } catch {}
  });

  it("second writer is refused with diagnostic info (no auto-break)", () => {
    // First writer claims the log
    const log1 = EventLog.open(testRoot);
    expect(log1.nextSequence).toBe(0);

    // Try to open second writer - should fail with diagnostic
    // EventLog.open throws synchronously, so use expect(() => ...).toThrow()
    expect(() => EventLog.open(testRoot)).toThrow(/already claimed/);

    // The error message should include PID, host, and timestamp of holder
    try {
      EventLog.open(testRoot);
    } catch (err: any) {
      expect(err.message).toContain("pid");
      expect(err.message).toContain("refusing to become a second writer");
      // Should mention the lock file path
      expect(err.message).toContain("writer.lock");
    }

    // Clean up first writer
    log1.close();
  });

  it("stale lock requires manual removal (no auto-recovery)", async () => {
    const log1 = EventLog.open(testRoot);
    const lockPath = join(logDir, "writer.lock");
    expect(await pathExists(lockPath)).toBe(true);

    // Get lock info
    const lockContent = await readFile(lockPath, "utf8");
    const lockInfo = JSON.parse(lockContent.trim());
    expect(lockInfo.pid).toBeDefined();
    expect(lockInfo.host).toBeDefined();
    expect(lockInfo.claimedAt).toBeDefined();

    // Close first writer
    log1.close();
    expect(await pathExists(lockPath)).toBe(false);

    // Now simulate stale lock by creating a lock file manually
    await writeFile(
      lockPath,
      JSON.stringify({
        pid: 99999,
        host: "test-host",
        claimedAt: new Date().toISOString(),
      }) + "\n",
    );

    // Second writer should still be refused (stale lock not auto-broken)
    expect(() => EventLog.open(testRoot)).toThrow(/already claimed/);
  });

  it("the lock records the holder's identity so a doctor can diagnose it", async () => {
    const log = EventLog.open(testRoot);
    const lockPath = join(logDir, "writer.lock");
    const lockInfo = JSON.parse((await readFile(lockPath, "utf8")).trim()) as {
      pid: number;
      host: string;
      claimedAt: string;
    };
    // The doctor decides "stale" by checking whether this pid is still alive,
    // so the lock must name the pid and the host it was claimed on.
    expect(lockInfo.pid).toBe(process.pid);
    expect(lockInfo.host).toBe(hostname());
    expect(Number.isNaN(Date.parse(lockInfo.claimedAt))).toBe(false);
    log.close();
  });

  it("a lock claiming a dead pid is diagnosable as stale", async () => {
    const lockPath = join(logDir, "writer.lock");
    // pid 99999 is above the default Windows/Linux pid_max on most systems,
    // and the doctor's liveness probe (signal 0) will find nothing.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99999, host: hostname(), claimedAt: new Date().toISOString() }) + "\n",
    );
    // The runtime still refuses (it never auto-breaks) — but the lock now
    // carries everything the doctor needs to name it as stale.
    expect(() => EventLog.open(testRoot)).toThrow(/already claimed/);
    const lockInfo = JSON.parse((await readFile(lockPath, "utf8")).trim()) as { pid: number; host: string };
    expect(lockInfo.pid).toBe(99999);
    expect(lockInfo.host).toBe(hostname());
  });
});
