import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

function runNode(
  args: string[],
  opts: { input?: string; env?: Record<string, string>; cwd?: string } = {},
  timeoutMs = 15_000,
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
    // A handler that ignores its deadline must not hang the test forever.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveP({ code, stdout, stderr });
    });
    child.stdin.end(opts.input ?? "");
  });
}

describe("Hook runner timeout enforcement — audit regression tests (Finding F)", () => {
  let testRoot: string;
  let runnerPath: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "runner-timeout-test-"));
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

  it("terminates a handler that exceeds timeoutSec (non-blocking policy)", async () => {
    await writeFile(
      join(testRoot, "handlers", "slow.mjs"),
      `
      export async function run(payload) {
        await new Promise(r => setTimeout(r, 10000));
        return {};
      }
    `,
    );

    const started = Date.now();
    const result = await runNode(
      [runnerPath, "slow"],
      {
        input: JSON.stringify({ cwd: testRoot, timeoutSec: 1 }),
        env: { ANYPLUGIN_HOST: "claude-code" },
      },
      8000,
    );
    const elapsed = Date.now() - started;

    // The handler's own 10s sleep never completed.
    expect(elapsed).toBeLessThan(8000);
    // Non-blocking policy: the host continues, exit 0.
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("timed out");
    expect(result.stderr).toContain("timeoutSec 1");
  });

  it("terminates a handler that exceeds timeoutSec under the blocking policy", async () => {
    await writeFile(
      join(testRoot, "handlers", "slow-blocking.mjs"),
      `
      export async function run(payload) {
        await new Promise(r => setTimeout(r, 10000));
        return {};
      }
    `,
    );

    const result = await runNode(
      [runnerPath, "slow-blocking"],
      {
        input: JSON.stringify({ cwd: testRoot, timeoutSec: 1, failurePolicy: "blocking" }),
        env: { ANYPLUGIN_HOST: "claude-code" },
      },
      8000,
    );

    // Blocking policy: the host is denied, exit 2.
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("timed out");
  });

  it("does NOT time out a handler that finishes inside the deadline", async () => {
    await writeFile(
      join(testRoot, "handlers", "fast.mjs"),
      `
      export async function run(payload) {
        await new Promise(r => setTimeout(r, 50));
        return { additionalContext: "done" };
      }
    `,
    );

    const result = await runNode(
      [runnerPath, "fast"],
      {
        input: JSON.stringify({ cwd: testRoot, timeoutSec: 5 }),
        env: { ANYPLUGIN_HOST: "claude-code" },
      },
      8000,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("timed out");
    expect(JSON.parse(result.stdout)["hookSpecificOutput"]["additionalContext"]).toBe("done");
  });

  it("does not impose a deadline when the manifest declares none", async () => {
    await writeFile(
      join(testRoot, "handlers", "slow-unbounded.mjs"),
      `
      export async function run(payload) {
        await new Promise(r => setTimeout(r, 1500));
        return { additionalContext: "slow but fine" };
      }
    `,
    );

    const result = await runNode(
      [runnerPath, "slow-unbounded"],
      {
        input: JSON.stringify({ cwd: testRoot }),
        env: { ANYPLUGIN_HOST: "claude-code" },
      },
      8000,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain("timed out");
    expect(JSON.parse(result.stdout)["hookSpecificOutput"]["additionalContext"]).toBe("slow but fine");
  });

  it("reads timeoutSec from the bundle's policies.json, not only the payload", async () => {
    await writeFile(
      join(testRoot, "handlers", "slow-policy.mjs"),
      `
      export async function run(payload) {
        await new Promise(r => setTimeout(r, 10000));
        return {};
      }
    `,
    );
    await mkdir(join(testRoot, "hooks"), { recursive: true });
    await writeFile(
      join(testRoot, "hooks", "policies.json"),
      JSON.stringify({ "slow-policy": { timeoutSec: 1, failurePolicy: "non-blocking" } }),
    );

    const result = await runNode(
      [runnerPath, "slow-policy"],
      {
        // No timeoutSec in the payload — it must come from the policy file.
        input: JSON.stringify({ cwd: testRoot }),
        env: { ANYPLUGIN_HOST: "claude-code" },
      },
      8000,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("timed out");
  });

  it("ignores a malformed policies.json instead of crashing", async () => {
    await writeFile(
      join(testRoot, "handlers", "ok.mjs"),
      `export async function run() { return { additionalContext: "ok" }; }`,
    );
    await mkdir(join(testRoot, "hooks"), { recursive: true });
    await writeFile(join(testRoot, "hooks", "policies.json"), "{ not json");

    const result = await runNode(
      [runnerPath, "ok"],
      { input: JSON.stringify({ cwd: testRoot }), env: { ANYPLUGIN_HOST: "claude-code" } },
      8000,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)["hookSpecificOutput"]["additionalContext"]).toBe("ok");
  });
});
