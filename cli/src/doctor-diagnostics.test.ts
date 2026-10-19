import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, access, readdir } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * `anyplugin doctor` must handle every negative scenario with bounded,
 * controlled error handling: it reports, it never crashes, and it never
 * auto-repairs a corrupt journal (the journal is the only record of which
 * bytes the plugin owns — guessing would risk deleting user data).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const DIST_BIN = join(HERE, "..", "dist", "bin.js");
const HAS_DIST = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("node:fs").existsSync(DIST_BIN);
  } catch {
    return false;
  }
})();

interface DoctorResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runDoctor(args: string[], home: string, project: string): Promise<DoctorResult> {
  return new Promise((resolve) => {
    const proc = spawn(
      process.execPath,
      [DIST_BIN, "doctor", "--json", "--home", home, "--project", project, ...args],
      {
        env: { ...process.env, HOME: home, USERPROFILE: home },
        cwd: project,
      },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!HAS_DIST)("doctor — negative scenario handling", () => {
  let testRoot: string;
  let home: string;
  let project: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "doctor-test-"));
    home = join(testRoot, "home");
    project = join(testRoot, "project");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });
  });

  afterEach(async () => {
    for (const dir of [join(home, ".claude"), join(project, ".opencode"), join(home, ".codex"), join(project, ".agents")]) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch {}
    }
  });

  afterAll(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it("exits 0 and reports no problems on a clean machine", async () => {
    const result = await runDoctor([], home, project);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as {
      issues: Array<{ type: string; severity: string }>;
      fixed: string[];
      unfixable: string[];
    };
    // Only informational findings (e.g. "no worker-runtime lock") may appear.
    expect(parsed.issues.filter((i) => i.severity !== "info")).toEqual([]);
    expect(parsed.fixed).toEqual([]);
    expect(parsed.unfixable).toEqual([]);
  });

  it("reports a corrupt journal as an error and exits non-zero", async () => {
    const pluginDir = join(project, ".opencode", "plugins", "broken-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(join(pluginDir, ".anyplugin-state.json"), "{ not json");

    const result = await runDoctor([], home, project);
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout) as { issues: Array<{ type: string; severity: string }> };
    const corrupt = parsed.issues.find((i) => i.type === "corrupt-journal");
    expect(corrupt).toBeDefined();
    expect(corrupt!.severity).toBe("error");
  });

  it("never auto-repairs a corrupt journal, even with --fix", async () => {
    const pluginDir = join(project, ".opencode", "plugins", "broken-plugin");
    await mkdir(pluginDir, { recursive: true });
    const journalPath = join(pluginDir, ".anyplugin-state.json");
    const corruptContent = "{ not json";
    await writeFile(journalPath, corruptContent);

    const result = await runDoctor(["--fix"], home, project);
    const parsed = JSON.parse(result.stdout) as { fixed: string[]; unfixable: string[] };
    expect(parsed.fixed).toEqual([]);
    expect(parsed.unfixable.length).toBe(1);
    expect(parsed.unfixable[0]).toMatch(/corrupt journal needs manual repair/);
    // The journal is untouched — byte-identical.
    expect(await require("node:fs/promises").readFile(journalPath, "utf8")).toBe(corruptContent);
  });

  it("detects an orphaned install transaction scratch space", async () => {
    const txRoot = join(project, ".opencode", "plugins", ".anyplugin-tx-orphan-plugin");
    await mkdir(join(txRoot, ".anyplugin-staging", "01ABC", "payloads"), { recursive: true });

    const result = await runDoctor([], home, project);
    const parsed = JSON.parse(result.stdout) as { issues: Array<{ type: string; severity: string }> };
    const orphan = parsed.issues.find((i) => i.type === "orphaned-transaction");
    expect(orphan).toBeDefined();
    expect(orphan!.severity).toBe("warning");
  });

  it("--fix removes an orphaned transaction scratch space", async () => {
    const txRoot = join(project, ".opencode", "plugins", ".anyplugin-tx-orphan-plugin");
    await mkdir(join(txRoot, ".anyplugin-staging", "01ABC", "payloads"), { recursive: true });

    const result = await runDoctor(["--fix"], home, project);
    const parsed = JSON.parse(result.stdout) as { fixed: string[] };
    expect(parsed.fixed.length).toBe(1);
    expect(parsed.fixed[0]).toMatch(/orphaned transaction scratch space/);
    expect(await pathExists(txRoot)).toBe(false);
  });

  it("does not crash when the agent plugin root is a file instead of a directory", async () => {
    const pluginsDir = join(project, ".opencode", "plugins");
    await mkdir(join(project, ".opencode"), { recursive: true });
    await writeFile(pluginsDir, "not a directory");

    const result = await runDoctor([], home, project);
    // The doctor must not crash; it reports whatever it can.
    expect(result.code).not.toBe(2);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
  });

  it("reports a plugin directory with no journal as a warning", async () => {
    const pluginDir = join(project, ".opencode", "plugins", "orphan-dir");
    await mkdir(pluginDir, { recursive: true });

    const result = await runDoctor([], home, project);
    const parsed = JSON.parse(result.stdout) as { issues: Array<{ type: string; severity: string }> };
    const missing = parsed.issues.find((i) => i.type === "missing-journal");
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("warning");
  });

  it("ignores the transaction scratch space when listing plugin directories", async () => {
    const pluginsDir = join(project, ".opencode", "plugins");
    await mkdir(join(pluginsDir, ".anyplugin-tx-something"), { recursive: true });
    await mkdir(join(pluginsDir, "real-plugin"), { recursive: true });

    const result = await runDoctor([], home, project);
    const parsed = JSON.parse(result.stdout) as { issues: Array<{ type: string; message: string }> };
    const messages = parsed.issues.map((i) => i.message).join("\n");
    // The scratch space is reported as a transaction, not as a missing journal.
    expect(messages).not.toMatch(/no journal found for opencode\/\.anyplugin-tx-something/);
  });

  it("detects a stale worker-runtime lock whose holder is gone", async () => {
    const eventsDir = join(project, ".worker-runtime", "events");
    await mkdir(eventsDir, { recursive: true });
    await writeFile(
      join(eventsDir, "writer.lock"),
      JSON.stringify({ pid: 99999, host: hostname(), claimedAt: new Date().toISOString() }) + "\n",
    );

    const result = await runDoctor([], home, project);
    const parsed = JSON.parse(result.stdout) as { issues: Array<{ type: string; severity: string; message: string }> };
    const stale = parsed.issues.find((i) => i.type === "stale-lock");
    expect(stale).toBeDefined();
    expect(stale!.severity).toBe("error");
    // The message names the holder and the deliberate remedy.
    expect(stale!.message).toMatch(/pid 99999/);
    expect(stale!.message).toMatch(/writer\.lock/);
    expect(result.code).toBe(1);
  });

  it("--fix releases a stale lock but never an active one", async () => {
    const eventsDir = join(project, ".worker-runtime", "events");
    await mkdir(eventsDir, { recursive: true });
    const lockPath = join(eventsDir, "writer.lock");

    // A lock held by THIS process is alive — it must not be broken.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: process.pid, host: hostname(), claimedAt: new Date().toISOString() }) + "\n",
    );
    const active = await runDoctor(["--fix"], home, project);
    const activeParsed = JSON.parse(active.stdout) as {
      issues: Array<{ type: string }>;
      fixed: string[];
    };
    expect(activeParsed.issues.some((i) => i.type === "active-lock")).toBe(true);
    expect(activeParsed.fixed).toEqual([]);
    expect(await pathExists(lockPath)).toBe(true);

    // A lock whose holder is gone is safe to release.
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 99999, host: hostname(), claimedAt: new Date().toISOString() }) + "\n",
    );
    const stale = await runDoctor(["--fix"], home, project);
    const staleParsed = JSON.parse(stale.stdout) as { fixed: string[] };
    expect(staleParsed.fixed.length).toBe(1);
    expect(staleParsed.fixed[0]).toMatch(/stale worker-runtime lock/);
    expect(await pathExists(lockPath)).toBe(false);
  });

  it("does not touch a lock held on another host", async () => {
    const eventsDir = join(project, ".worker-runtime", "events");
    await mkdir(eventsDir, { recursive: true });
    const lockPath = join(eventsDir, "writer.lock");
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 4242, host: "some-other-host", claimedAt: new Date().toISOString() }) + "\n",
    );

    const result = await runDoctor(["--fix"], home, project);
    const parsed = JSON.parse(result.stdout) as {
      issues: Array<{ type: string; message: string }>;
      fixed: string[];
    };
    // Liveness cannot be verified from another host, so the lock is reported
    // and left alone — the runtime refuses to auto-break for the same reason.
    expect(parsed.issues.some((i) => i.type === "unverifiable-lock")).toBe(true);
    expect(parsed.fixed).toEqual([]);
    expect(await pathExists(lockPath)).toBe(true);
  });

  it("--json output is always valid JSON even with many issues", async () => {
    for (let i = 0; i < 3; i++) {
      const pluginDir = join(project, ".opencode", "plugins", `broken-${i}`);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, ".anyplugin-state.json"), "{ broken");
    }

    const result = await runDoctor([], home, project);
    const parsed = JSON.parse(result.stdout) as { issues: Array<{ type: string }> };
    expect(parsed.issues.filter((i) => i.type === "corrupt-journal")).toHaveLength(3);
    expect(result.code).toBe(1);
  });
});
