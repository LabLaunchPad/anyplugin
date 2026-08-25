import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * M7a / F7: CORE-INVARIANTS-V2.md §1.3's two-mode failure policy.
 *
 * Each case is written to fail if the policy branch were removed — a
 * thrown-handler test that passes under both policies without asserting a
 * DIFFERENT exit code per policy would be exactly the non-discriminating
 * harness ANTI_VACUITY_ANALYSIS exists to catch, so the core test here
 * (`same handler, both policies, different outcome`) is the load-bearing one.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RUNNER = join(REPO_ROOT, "plugins", "knowledge", "runtime", "runner.js");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNode(args: string[], opts: { input?: string; env?: Record<string, string> } = {}): Promise<RunResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rejectP);
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

const dirs: string[] = [];
async function fixturePluginRoot(policy?: "non-blocking" | "blocking"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "anyplugin-failurepolicy-"));
  dirs.push(dir);
  await mkdir(join(dir, "hooks"), { recursive: true });
  await writeFile(
    join(dir, "hooks", "throws.mjs"),
    `export async function run() { throw new Error("boom"); }\n`,
  );
  await writeFile(
    join(dir, "hooks", "no-run-export.mjs"),
    `export const notRun = 1;\n`,
  );
  await writeFile(
    join(dir, "hooks", "blocks.mjs"),
    `export async function run() { return { block: true, reason: "policy says no" }; }\n`,
  );
  await writeFile(
    join(dir, "hooks", "ok.mjs"),
    `export async function run() { return {}; }\n`,
  );
  if (policy) {
    await writeFile(join(dir, ".anyplugin-runtime.json"), JSON.stringify({ failurePolicy: policy }, null, 2));
  }
  return dir;
}

afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

describe("runner.js failure policy — non-blocking (default, no config file)", () => {
  it("a thrown handler exits 0 with a stderr diagnostic", async () => {
    const root = await fixturePluginRoot();
    const r = await runNode([RUNNER, "throws"], { input: "{}", env: { ANYPLUGIN_PLUGIN_ROOT: root } });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/failed/);
    expect(r.stdout.trim()).toBe("");
  });

  it("a handler with no run() export exits 0 with a stderr diagnostic", async () => {
    const root = await fixturePluginRoot();
    const r = await runNode([RUNNER, "no-run-export"], { input: "{}", env: { ANYPLUGIN_PLUGIN_ROOT: root } });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/exports no run/);
  });
});

describe("runner.js failure policy — blocking (explicit opt-in)", () => {
  it("the SAME thrown handler now exits 2 with a deterministic block decision", async () => {
    // The discriminating case: identical handler, only the policy config differs.
    const root = await fixturePluginRoot("blocking");
    const r = await runNode([RUNNER, "throws"], { input: "{}", env: { ANYPLUGIN_PLUGIN_ROOT: root } });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/failed/); // the diagnostic is never dropped, only the exit code changes
    const out = JSON.parse(r.stdout);
    expect(out).toEqual({ decision: "block", reason: "hook failed" });
  });

  it("a handler with no run() export also exits 2 under blocking", async () => {
    const root = await fixturePluginRoot("blocking");
    const r = await runNode([RUNNER, "no-run-export"], { input: "{}", env: { ANYPLUGIN_PLUGIN_ROOT: root } });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ decision: "block", reason: "hook failed" });
  });

  it("a genuine block: true decision is unaffected — reason is the handler's own, not the policy's", async () => {
    const root = await fixturePluginRoot("blocking");
    const r = await runNode([RUNNER, "blocks"], { input: "{}", env: { ANYPLUGIN_PLUGIN_ROOT: root } });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ decision: "block", reason: "policy says no" });
  });

  it("a successful handler is unaffected", async () => {
    const root = await fixturePluginRoot("blocking");
    const r = await runNode([RUNNER, "ok"], { input: "{}", env: { ANYPLUGIN_PLUGIN_ROOT: root } });
    expect(r.code).toBe(0);
  });
});

describe("runner.js failure policy — protocol violations are unaffected by policy", () => {
  it("an invalid hook id still exits 1, even with blocking configured", async () => {
    const root = await fixturePluginRoot("blocking");
    const r = await runNode([RUNNER, "../../etc/passwd"], { input: "{}", env: { ANYPLUGIN_PLUGIN_ROOT: root } });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid hook id/);
  });
});

describe("runner.js failure policy — a corrupt or absent config file is the safe default", () => {
  it("no config file at all behaves as non-blocking", async () => {
    const root = await fixturePluginRoot(); // no .anyplugin-runtime.json written
    const r = await runNode([RUNNER, "throws"], { input: "{}", env: { ANYPLUGIN_PLUGIN_ROOT: root } });
    expect(r.code).toBe(0);
  });

  it("a malformed config file behaves as non-blocking, never throws the runner itself", async () => {
    const root = await fixturePluginRoot();
    await writeFile(join(root, ".anyplugin-runtime.json"), "{ not valid json");
    const r = await runNode([RUNNER, "throws"], { input: "{}", env: { ANYPLUGIN_PLUGIN_ROOT: root } });
    expect(r.code).toBe(0); // must not crash or hang on bad JSON
  });
});
