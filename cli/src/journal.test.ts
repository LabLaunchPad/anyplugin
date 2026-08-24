import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll, executeInstall, executeUninstall } from "./index.js";
import { pathExists } from "@lablaunchpad/core";
import type { AgentId, EmittedBundle } from "@lablaunchpad/core";

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


async function makePlugin(): Promise<{ root: string; home: string; project: string; bundles: Record<string, EmittedBundle>; opts: { home: string; projectDir: string; pluginName: string; version: string } }> {
  const root = await mkdtemp(join(tmpdir(), "journal-"));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    join(root, "anyplugin.plugin.yaml"),
    `name: journaled-plugin
version: 0.2.0
description: journal test plugin
skills: ["./skills/demo"]
hooks:
  - id: guard
    event: before-tool-use
    handler: ./hooks/guard.mjs
mcp:
  servers:
    okf:
      transport: stdio
      command: node
      args: ["{{PLUGIN_ROOT}}/mcp/server.js"]
`,
  );
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\nbody\n");
  await writeFile(join(root, "hooks", "guard.mjs"), "export async function run() { return {}; }\n");
  await writeFile(join(root, "hooks", "runner.js"), "// runner\n");
  const bundles = await buildAll({ pluginRoot: root, outRoot: join(root, "build"), runnerAbsPath: join(root, "hooks", "runner.js") });
  return { root, home, project, bundles, opts: { home, projectDir: project, pluginName: "journaled-plugin", version: "0.2.0" } };
}

describe("install journal — conflict-safe uninstall", () => {
  it("aborts uninstall and preserves edits when a marker file was modified after install", async () => {
    const f = await makePlugin();
    await executeInstall("opencode", f.bundles["opencode"]!, f.opts);
    const agentsMd = join(f.project, "AGENTS.md");
    await writeFile(agentsMd, (await readFile(agentsMd, "utf8")) + "\nMY OWN NOTES\n");

    await expect(executeUninstall("opencode", f.bundles["opencode"]!, f.opts)).rejects.toThrow(/aborted.*modified after install|modified after install/s);

    const after = await readFile(agentsMd, "utf8");
    expect(after).toContain("MY OWN NOTES");
    expect(after).toContain("anyplugin:journaled-plugin"); // plugin block still intact — nothing was stripped
  });

  it("aborts uninstall when a json-merged config gained user keys after install", async () => {
    const f = await makePlugin();
    await executeInstall("opencode", f.bundles["opencode"]!, f.opts);
    const ocJson = join(f.project, "opencode.json");
    const parsed = JSON.parse(await readFile(ocJson, "utf8")) as Record<string, unknown>;
    parsed["userKey"] = 1;
    await writeFile(ocJson, JSON.stringify(parsed, null, 2));

    await expect(executeUninstall("opencode", f.bundles["opencode"]!, f.opts)).rejects.toThrow(/modified after install/);
    expect(JSON.parse(await readFile(ocJson, "utf8")).userKey).toBe(1);
  });

  it("dry-run uninstall reports the conflict without aborting or touching files", async () => {
    const f = await makePlugin();
    await executeInstall("opencode", f.bundles["opencode"]!, f.opts);
    const ocJson = join(f.project, "opencode.json");
    const before = await readFile(ocJson, "utf8");
    const parsed = JSON.parse(before) as Record<string, unknown>;
    parsed["userKey"] = 1;
    await writeFile(ocJson, JSON.stringify(parsed, null, 2));

    const touched = await executeUninstall("opencode", f.bundles["opencode"]!, { ...f.opts, dryRun: true });
    expect(touched.some((t) => t.startsWith("CONFLICT:"))).toBe(true);
    expect(await readFile(ocJson, "utf8")).not.toBe(before); // unchanged since our own edit
    expect(await pathExists(join(f.project, ".opencode", "plugins", "journaled-plugin"))).toBe(true);
  });

  it("clean uninstall restores pre-existing files byte-exact and deletes created configs", async () => {
    const f = await makePlugin();
    const originalAgents = "# Existing project instructions\n\nKeep me.\n";
    await writeFile(join(f.project, "AGENTS.md"), originalAgents);
    const originalToml = "# my codex config\n";
    await mkdir(join(f.home, ".codex"), { recursive: true });
    await writeFile(join(f.home, ".codex", "config.toml"), originalToml);

    for (const agent of ["claude-code", "opencode", "codex", "antigravity"] as AgentId[]) {
      await executeInstall(agent, f.bundles[agent]!, f.opts);
    }
    for (const agent of ["claude-code", "opencode", "codex", "antigravity"] as AgentId[]) {
      await executeUninstall(agent, f.bundles[agent]!, f.opts);
    }

    expect(await readFile(join(f.project, "AGENTS.md"), "utf8")).toBe(originalAgents);
    expect(await readFile(join(f.home, ".codex", "config.toml"), "utf8")).toBe(originalToml);
    // configs that only existed because of the install are removed entirely
    expect(await pathExists(join(f.project, "opencode.json"))).toBe(false);
    expect(await pathExists(join(f.project, ".agents", "mcp_config.json"))).toBe(false);
    // journal lives inside the plugin root, which is removed with it
    for (const agent of ["claude-code", "opencode", "codex", "antigravity"] as AgentId[]) {
      expect(await pathExists(join(f.root, "build", agent))).toBe(true); // emitted bundle untouched
    }
    expect(await pathExists(join(f.home, ".claude", "plugins", "journaled-plugin", ".anyplugin-state.json"))).toBe(false);
  });

  it("reinstall then uninstall never resurrects stale marker blocks", async () => {
    const f = await makePlugin();
    const originalToml = "# my codex config\n";
    await mkdir(join(f.home, ".codex"), { recursive: true });
    await writeFile(join(f.home, ".codex", "config.toml"), originalToml);

    await executeInstall("codex", f.bundles["codex"]!, f.opts);
    await executeInstall("codex", f.bundles["codex"]!, f.opts); // reinstall
    await executeUninstall("codex", f.bundles["codex"]!, f.opts);

    expect(await readFile(join(f.home, ".codex", "config.toml"), "utf8")).toBe(originalToml);
  });

  it("install refuses to merge into an unparseable JSON config", async () => {
    const f = await makePlugin();
    await writeFile(join(f.project, "opencode.json"), "{ not valid json");
    await expect(executeInstall("opencode", f.bundles["opencode"]!, f.opts)).rejects.toThrow(/unparseable JSON config/);
    expect(await readFile(join(f.project, "opencode.json"), "utf8")).toBe("{ not valid json");
  });
});
