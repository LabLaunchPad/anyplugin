import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffoldPlugin, buildAll, executeInstall, executeUninstall, loadPluginManifest } from "./index.js";
import { pathExists } from "@lablaunchpad/core";

describe("scaffoldPlugin (anyplugin init)", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "scaffold-"));
  });

  it("scaffolds a starter plugin that loads and builds for all four agents", async () => {
    const dir = join(root, "fresh-plugin");
    const result = await scaffoldPlugin("fresh-plugin", dir);
    expect(result.name).toBe("fresh-plugin");
    expect(result.files).toContain("anyplugin.plugin.yaml");
    expect(result.files).toContain("hooks/before-tool.mjs");

    const manifest = await loadPluginManifest(dir);
    expect(manifest.name).toBe("fresh-plugin");

    await writeFile(join(root, "runner.js"), "// runner\n");
    const bundles = await buildAll({ pluginRoot: dir, outRoot: join(root, "build"), runnerAbsPath: join(root, "runner.js") });
    expect(Object.keys(bundles).sort()).toEqual(["antigravity", "claude-code", "codex", "opencode"]);
    for (const b of Object.values(bundles)) expect(b.files.length).toBeGreaterThan(0);
  });

  it("rejects unsafe plugin names", async () => {
    await expect(scaffoldPlugin("../evil", join(root, "a"))).rejects.toThrow(/unsafe/);
    await expect(scaffoldPlugin("Bad_Name", join(root, "b"))).rejects.toThrow(/unsafe/);
  });

  it("refuses to overwrite an existing target directory", async () => {
    await mkdir(join(root, "exists"), { recursive: true });
    await expect(scaffoldPlugin("dupe-plugin", join(root, "exists"))).rejects.toThrow(/already exists/);
  });

  it("refuses a target whose parent does not exist", async () => {
    await expect(scaffoldPlugin("orphan-plugin", join(root, "missing", "child"))).rejects.toThrow(/parent directory not found/);
  });
});

describe("executeUninstall --dry-run", () => {
  it("reports what would be cleaned without touching anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "dryrun-"));
    const home = join(root, "home");
    const project = join(root, "project");
    await mkdir(join(root, "skills", "demo"), { recursive: true });
    await mkdir(join(root, "hooks"), { recursive: true });
    await writeFile(
      join(root, "anyplugin.plugin.yaml"),
      `name: dry-plugin
version: 0.1.0
description: dry run test
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
    const opts = { home, projectDir: project, pluginName: "dry-plugin" };
    for (const [key, bundle] of Object.entries(bundles)) {
      await executeInstall(key as never, bundle, opts);
    }
    const codexToml = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(codexToml).toContain("# BEGIN anyplugin:dry-plugin");

    // dry-run: everything reported as "would", nothing actually removed
    for (const [key, bundle] of Object.entries(bundles)) {
      const touched = await executeUninstall(key as never, bundle, { ...opts, dryRun: true });
      expect(touched.length).toBeGreaterThan(0);
      for (const t of touched) expect(t).toMatch(/^would /);
    }
    expect(await pathExists(join(home, ".claude", "plugins", "dry-plugin"))).toBe(true);
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).toContain("# BEGIN anyplugin:dry-plugin");
    expect(await readFile(join(project, "AGENTS.md"), "utf8")).toContain("anyplugin:dry-plugin begin");

    // real uninstall still reverses everything afterwards
    for (const [key, bundle] of Object.entries(bundles)) {
      await executeUninstall(key as never, bundle, opts);
    }
    expect(await pathExists(join(home, ".claude", "plugins", "dry-plugin"))).toBe(false);
    expect(await readFile(join(home, ".codex", "config.toml"), "utf8")).not.toContain("anyplugin:dry-plugin");
    expect(await readFile(join(project, "AGENTS.md"), "utf8")).not.toContain("anyplugin:");
  });
});
