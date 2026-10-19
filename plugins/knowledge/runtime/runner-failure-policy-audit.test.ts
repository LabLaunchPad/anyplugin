import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

function runNode(
  args: string[],
  opts: { input?: string; env?: Record<string, string>; cwd?: string } = {},
  timeoutMs = 10_000,
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

describe("Hook runner failurePolicy — audit regression tests (Finding G)", () => {
  let testRoot: string;
  let runnerPath: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "runner-failure-policy-test-"));
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

  it("exits 2 when the handler throws under the blocking policy", async () => {
    await writeFile(
      join(testRoot, "handlers", "throw-blocking.mjs"),
      `
      export async function run(payload) {
        throw new Error("intentional failure");
      }
    `,
    );

    const result = await runNode(
      [runnerPath, "throw-blocking"],
      {
        input: JSON.stringify({ cwd: testRoot, failurePolicy: "blocking" }),
        env: { ANYPLUGIN_HOST: "claude-code" },
      },
      5000,
    );

    // Blocking policy: the host is denied, exit 2.
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("failed: intentional failure");
  });

  it("exits 0 on throw with the non-blocking policy (default)", async () => {
    await writeFile(
      join(testRoot, "handlers", "throw-nonblocking.mjs"),
      `
      export async function run(payload) {
        throw new Error("intentional failure");
      }
    `,
    );

    const result = await runNode(
      [runnerPath, "throw-nonblocking"],
      {
        input: JSON.stringify({ cwd: testRoot, failurePolicy: "non-blocking" }),
        env: { ANYPLUGIN_HOST: "claude-code" },
      },
      5000,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("failed: intentional failure");
  });

  it("exits 0 on throw when no policy is declared (fail-open by default)", async () => {
    await writeFile(
      join(testRoot, "handlers", "throw-default.mjs"),
      `
      export async function run(payload) {
        throw new Error("intentional failure");
      }
    `,
    );

    const result = await runNode(
      [runnerPath, "throw-default"],
      { input: JSON.stringify({ cwd: testRoot }), env: { ANYPLUGIN_HOST: "claude-code" } },
      5000,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toContain("failed: intentional failure");
  });

  it("reads failurePolicy from the bundle's policies.json", async () => {
    await writeFile(
      join(testRoot, "handlers", "throw-from-file.mjs"),
      `
      export async function run(payload) {
        throw new Error("from policy file");
      }
    `,
    );
    await mkdir(join(testRoot, "hooks"), { recursive: true });
    await writeFile(
      join(testRoot, "hooks", "policies.json"),
      JSON.stringify({ "throw-from-file": { failurePolicy: "blocking" } }),
    );

    const result = await runNode(
      [runnerPath, "throw-from-file"],
      { input: JSON.stringify({ cwd: testRoot }), env: { ANYPLUGIN_HOST: "claude-code" } },
      5000,
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("failed: from policy file");
  });

  it("uses Antigravity's deny protocol for a blocking failure", async () => {
    await writeFile(
      join(testRoot, "handlers", "throw-antigravity.mjs"),
      `
      export async function run(payload) {
        throw new Error("antigravity failure");
      }
    `,
    );

    const result = await runNode(
      [runnerPath, "throw-antigravity"],
      {
        input: JSON.stringify({ cwd: testRoot, failurePolicy: "blocking" }),
        env: { ANYPLUGIN_HOST: "antigravity" },
      },
      5000,
    );

    // Antigravity expresses a denial as decision: "deny" with exit 0.
    expect(result.code).toBe(0);
    const out = JSON.parse(result.stdout);
    expect(out["decision"]).toBe("deny");
    expect(result.stderr).toContain("failed: antigravity failure");
  });

  it("exits 2 when handler returns block: true", async () => {
    await writeFile(
      join(testRoot, "handlers", "block.mjs"),
      `
      export async function run(payload) {
        return { block: true, reason: "blocked by test" };
      }
    `,
    );

    const result = await runNode(
      [runnerPath, "block"],
      { input: JSON.stringify({ cwd: testRoot }), env: { ANYPLUGIN_HOST: "claude-code" } },
      5000,
    );

    expect(result.code).toBe(2);
    const out = JSON.parse(result.stdout);
    expect(out["decision"]).toBe("block");
  });

  it("a missing handler is a failure, and obeys the failure policy", async () => {
    const result = await runNode(
      [runnerPath, "does-not-exist"],
      {
        input: JSON.stringify({ cwd: testRoot, failurePolicy: "blocking" }),
        env: { ANYPLUGIN_HOST: "claude-code" },
      },
      5000,
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("failed:");
  });

  it("exposes the resolved policy to the handler", async () => {
    await writeFile(
      join(testRoot, "handlers", "echo-policy.mjs"),
      `
      export async function run(payload) {
        return { additionalContext: JSON.stringify(payload.policy) };
      }
    `,
    );

    const result = await runNode(
      [runnerPath, "echo-policy"],
      {
        input: JSON.stringify({ cwd: testRoot, timeoutSec: 7, failurePolicy: "blocking" }),
        env: { ANYPLUGIN_HOST: "claude-code" },
      },
      5000,
    );

    const policy = JSON.parse(JSON.parse(result.stdout)["hookSpecificOutput"]["additionalContext"]);
    expect(policy.timeoutSec).toBe(7);
    expect(policy.failurePolicy).toBe("blocking");
  });
});
