import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll } from "./index.js";

/**
 * These tests run full install/uninstall cycles across four agents: many small
 * files, repeated JSON/TOML merges, and byte-exact restore checks. On Windows
 * that work is several times more expensive than on Linux, and vitest runs test
 * FILES concurrently — so this suite competes with the process-spawning suites
 * elsewhere in the workspace.
 *
 * vitest's default 5s bound is calibrated for unit tests, not for that. Two of
 * these crossed it on a loaded Windows runner while passing comfortably on a
 * quiet one, which makes the pass a property of runner speed rather than of the
 * code (F17). The bound is therefore stated explicitly, matching the 30s already
 * used by plugins/knowledge/src/e2e.runtime.test.ts for the same reason.
 *
 * This changes no assertion. A timeout is a liveness bound, not a correctness
 * claim: every behavioural check in this file is unchanged, and a genuine hang
 * still fails.
 */
vi.setConfig({ testTimeout: 30_000 });


async function makePlugin(manifestExtra: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "capgate-"));
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await writeFile(
    join(root, "anyplugin.plugin.yaml"),
    `name: cap-plugin\nversion: 0.1.0\ndescription: capability gate test\nskills: ["./skills/demo"]\n${manifestExtra}`,
  );
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\nbody\n");
  await writeFile(join(root, "hooks", "runner.js"), "// runner\n");
  return root;
}

describe("buildAll capability gate (spec §2.2)", () => {
  it("hard-errors when a required capability is UNSUPPORTED on the target", async () => {
    const root = await makePlugin(`hooks:\n  - id: end\n    event: session-end\n    handler: ./hooks/end.mjs\n`);
    await expect(
      buildAll({ pluginRoot: root, outRoot: join(root, "build"), agents: ["antigravity"], runnerAbsPath: join(root, "hooks", "runner.js") }),
    ).rejects.toThrow(/UNSUPPORTED.*session-end|session-end.*UNSUPPORTED/s);
  });

  it("hard-errors on opencode@v2 hooks (AP-004: never emit a broken V1 shim)", async () => {
    const root = await makePlugin(`hooks:\n  - id: stop\n    event: turn-stop\n    handler: ./hooks/stop.mjs\n`);
    await expect(
      buildAll({
        pluginRoot: root, outRoot: join(root, "build"), agents: ["opencode"], runnerAbsPath: join(root, "hooks", "runner.js"),
        variants: { opencode: "v2" },
      }),
    ).rejects.toThrow(/UNSUPPORTED/);
  });

  it("fails closed on UNKNOWN variants", async () => {
    const root = await makePlugin("");
    await expect(
      buildAll({
        pluginRoot: root, outRoot: join(root, "build"), agents: ["opencode"], runnerAbsPath: join(root, "hooks", "runner.js"),
        variants: { opencode: "v9" },
      }),
    ).rejects.toThrow(/UNKNOWN.*fail|failing closed/s);
  });

  it("emits a build WARNING (not silence) for DEGRADED capabilities", async () => {
    const root = await makePlugin(`commands: ["./commands/x.md"]\n`);
    await mkdir(join(root, "commands"), { recursive: true });
    await writeFile(join(root, "commands", "x.md"), "---\ndescription: x\n---\nbody\n");
    const bundles = await buildAll({
      pluginRoot: root, outRoot: join(root, "build"), runnerAbsPath: join(root, "hooks", "runner.js"),
    });
    expect(bundles["codex"]!.warnings.some((w) => /DEGRADED.*commands|commands.*DEGRADED/.test(w))).toBe(true);
    expect(bundles["antigravity"]!.warnings.some((w) => /commands/.test(w))).toBe(true);
    expect(bundles["claude-code"]!.warnings.some((w) => /commands/.test(w))).toBe(false);
  });

  it("builds the default four-agent set unchanged for fully-supported plugins", async () => {
    const root = await makePlugin(`hooks:\n  - id: before\n    event: before-tool-use\n    handler: ./hooks/before.mjs\n`);
    await writeFile(join(root, "hooks", "before.mjs"), "export async function run() { return {}; }\n");
    const bundles = await buildAll({ pluginRoot: root, outRoot: join(root, "build"), runnerAbsPath: join(root, "hooks", "runner.js") });
    expect(Object.keys(bundles).sort()).toEqual(["antigravity", "claude-code", "codex", "opencode"]);
  });
});
