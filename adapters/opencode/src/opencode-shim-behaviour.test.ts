import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { emitOpencode } from "./index.js";
import { loadPluginManifest } from "@lablaunchpad/core";

/**
 * The OpenCode shim, BEHAVIOURALLY.
 *
 * The previous test asserted on the generated SOURCE TEXT, which cannot fail
 * for the reason it claims to test — and it did not catch the defect where
 * the shim discarded a blocking hook's denial, because a blocking hook exits
 * NON-ZERO and the shim skipped every non-zero exit.
 *
 * This test runs the emitted shim for real. Node strips the TypeScript types
 * natively, so the generated `plugin.ts` is imported by a child process that
 * has a stub runner next to it. The stub behaves the way the real runner
 * does: it writes its payload to stdout BEFORE exiting, and exits 2 for a
 * blocking hook. So the assertion is on what the shim DOES, not on what it
 * says.
 */

/** Run a child that imports the shim and reports what the plugin did. */
function runShimChild(driverPath: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [driverPath], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe("OpenCode shim — behaviour, not source text (Finding H / B2)", () => {
  let testRoot: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "opencode-shim-behaviour-"));
  });

  afterAll(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  /**
   * Emit a shim for a plugin whose single hook does what `runner` says, run
   * the emitted shim, and return what the plugin did.
   */
  async function runShim(
    hookId: string,
    runnerBehaviour: { exitCode: number; stdout: string },
    canonicalEvent = "before-tool-use",
  ): Promise<Record<string, unknown>> {
    const dir = join(testRoot, `${hookId}-${runnerBehaviour.exitCode}-${runnerBehaviour.stdout.length}`);
    await mkdir(join(dir, "hooks"), { recursive: true });

    // A stub runner that behaves the way the REAL runner does: it writes its
    // payload to stdout BEFORE exiting, and a BLOCKING hook exits 2.
    const stub = `process.stdout.write(${JSON.stringify(runnerBehaviour.stdout)});
process.exit(${runnerBehaviour.exitCode});`;
    await writeFile(join(dir, "hooks", "runner.js"), stub, "utf8");

    const pluginRoot = join(dir, "plugin");
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await writeFile(join(pluginRoot, "hooks", `${hookId}.mjs`), "export async function run() { return {}; }\n");
    await writeFile(join(pluginRoot, "hooks", "runner.js"), "// stub\n");
    await writeFile(
      join(pluginRoot, "anyplugin.plugin.yaml"),
      `name: shim-test
version: 0.1.0
description: shim behaviour test
hooks:
  - id: ${hookId}
    event: ${canonicalEvent}
    handler: ./hooks/${hookId}.mjs
`,
    );

    const manifest = await loadPluginManifest(pluginRoot);
    const out = join(dir, "dist");
    await emitOpencode(manifest, {
      pluginRoot,
      outDir: out,
      runnerRelPath: "runner.js",
      runnerAbsPath: join(pluginRoot, "hooks", "runner.js"),
    });

    // The emitted shim is TypeScript. Node strips the types natively.
    const shimTs = await readFile(join(out, "plugin.ts"), "utf8");
    await writeFile(join(dir, "plugin.ts"), shimTs, "utf8");

    // A driver that imports the shim and exercises BOTH hooks the plugin
    // exposes, so the merged result is observable wherever it lands.
    const driver = join(dir, "driver.mjs");
    await writeFile(
      driver,
      `import plugin from "./plugin.ts";
const instance = await plugin();
const output = { args: { original: true } };
await instance["tool.execute.before"]({ tool: "Bash" }, output);
const permission = { status: "allow" };
await instance["permission.asked"]({ tool: "Bash" }, permission);
process.stdout.write(JSON.stringify({ ...output, status: permission.status }));
`,
      "utf8",
    );

    const result = await runShimChild(driver);
    expect(result.stderr, `shim failed: ${result.stderr}`).toBe("");
    return JSON.parse(result.stdout) as Record<string, unknown>;
  }

  it("carries a hook's context through to the tool call", async () => {
    const output = await runShim("ctx-hook", {
      exitCode: 0,
      stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "guard says hello" } }),
    });
    expect(output["additionalContext"]).toBe("guard says hello");
  });

  it("does NOT swallow a BLOCKING hook's denial (the hook exits 2)", async () => {
    // The defect: the shim skipped every non-zero exit, so a guard plugin's
    // refusal was silently ignored and the tool ran anyway.
    const output = await runShim("block-hook", {
      exitCode: 2,
      stdout: JSON.stringify({ decision: "block", reason: "denied by policy" }),
    });
    expect(output["block"]).toBe(true);
    expect(output["reason"]).toBe("denied by policy");
  });

  it("treats a blocking exit with no parseable payload as a denial too", async () => {
    // A blocking hook whose payload could not be parsed is still a denial.
    // Silently continuing would be the worst possible answer.
    const output = await runShim("block-nopayload-hook", {
      exitCode: 2,
      stdout: "",
    });
    expect(output["block"]).toBe(true);
  });

  it("records the most restrictive permission decision", async () => {
    // A hook that says "deny" must not be overridden by one that says "allow".
    // The permission-request event maps to OpenCode's "permission.asked".
    const output = await runShim(
      "deny-hook",
      {
        exitCode: 0,
        stdout: JSON.stringify({ hookSpecificOutput: { permissionDecision: "deny" } }),
      },
      "permission-request",
    );
    // The permission hook's own status reflects the decision — that is the
    // field OpenCode's plugin API reads.
    expect(output["status"]).toBe("deny");
  });
});
