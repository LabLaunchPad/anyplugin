import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

/**
 * The runner's batch mode.
 *
 * It had NO test, and it was broken in three ways at once: it called
 * `require()` inside an ES module, it read `env` before `env` was declared
 * (a temporal-dead-zone ReferenceError), and it called `process.exit(0)`
 * immediately after scheduling the children — so the combined result was
 * never written. A documented feature that could not work.
 */
function runNode(
  args: string[],
  opts: { input?: string; env?: Record<string, string>; cwd?: string } = {},
  timeoutMs = 20_000,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rejectP);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });
}

describe("runner batch mode", () => {
  let testRoot: string;
  let runnerPath: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "runner-batch-test-"));
    runnerPath = join(testRoot, "runner.js");
    const { copyFile } = await import("node:fs/promises");
    await copyFile(join(resolve("."), "plugins", "knowledge", "runtime", "runner.js"), runnerPath);
    await mkdir(join(testRoot, "handlers"), { recursive: true });
  });

  afterAll(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  it("runs every hook and writes a combined result", async () => {
    await writeFile(
      join(testRoot, "handlers", "one.mjs"),
      `export async function run() { return { additionalContext: "one" }; }`,
    );
    await writeFile(
      join(testRoot, "handlers", "two.mjs"),
      `export async function run() { return { additionalContext: "two" }; }`,
    );

    const result = await runNode([runnerPath, "--batch", JSON.stringify({ hookIds: ["one", "two"] })], {
      env: { ANYPLUGIN_HOST: "claude-code" },
    });

    expect(result.code).toBe(0);
    // The combined result must actually be written — the old code exited
    // before the promise resolved, so stdout was empty.
    const combined = JSON.parse(result.stdout) as {
      hookResults: Array<{ hookId: string; code: number; stdout: string }>;
      summary: { total: number; success: number; blocked: number; errors: number };
    };
    expect(combined.hookResults).toHaveLength(2);
    expect(combined.summary.total).toBe(2);
    expect(combined.summary.success).toBe(2);
    expect(combined.summary.errors).toBe(0);
    // Each child's own output is captured.
    const ids = combined.hookResults.map((r) => r.hookId).sort();
    expect(ids).toEqual(["one", "two"]);
    for (const r of combined.hookResults) {
      expect(r.stdout).toContain("additionalContext");
    }
  });

  it("counts a blocking hook as blocked", async () => {
    await writeFile(
      join(testRoot, "handlers", "blocker.mjs"),
      `export async function run() { return { block: true, reason: "nope" }; }`,
    );

    const result = await runNode([runnerPath, "--batch", JSON.stringify({ hookIds: ["blocker"] })], {
      env: { ANYPLUGIN_HOST: "claude-code" },
    });
    const combined = JSON.parse(result.stdout) as { summary: { blocked: number; success: number } };
    expect(combined.summary.blocked).toBe(1);
    expect(combined.summary.success).toBe(0);
  });

  it("rejects a batch payload with no hookIds", async () => {
    const result = await runNode([runnerPath, "--batch", JSON.stringify({})], {
      env: { ANYPLUGIN_HOST: "claude-code" },
    });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("hookIds");
  });

  it("rejects a malformed batch payload", async () => {
    const result = await runNode([runnerPath, "--batch", "{ not json"], {
      env: { ANYPLUGIN_HOST: "claude-code" },
    });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("not valid JSON");
  });

  it("reports a missing handler as an error, not a crash", async () => {
    const result = await runNode([runnerPath, "--batch", JSON.stringify({ hookIds: ["nope"] })], {
      env: { ANYPLUGIN_HOST: "claude-code" },
    });
    expect(result.code).toBe(0);
    const combined = JSON.parse(result.stdout) as { summary: { errors: number } };
    expect(combined.summary.errors).toBe(1);
  });
});
