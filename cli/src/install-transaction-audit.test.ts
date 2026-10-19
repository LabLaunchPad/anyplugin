import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAll, executeInstall, executeUninstall, scaffoldPlugin, installedRoot } from "./index.js";
import { loadPluginManifest } from "@lablaunchpad/core";

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe("Install transactional integrity — audit regression tests (Finding E)", () => {
  let testRoot: string;
  let home: string;
  let project: string;
  let pluginRoot: string;
  let bundles: Record<string, any>;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "install-transaction-test-"));
    home = join(testRoot, "home");
    project = join(testRoot, "project");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });

    pluginRoot = join(testRoot, "test-plugin");
    await scaffoldPlugin("test-plugin", pluginRoot);
    await writeFile(join(pluginRoot, "hooks", "guard.mjs"), "export async function run() { return {}; }");
    await writeFile(join(pluginRoot, "hooks", "runner.js"), "// runner\n");
    
    const manifest = await loadPluginManifest(pluginRoot);
    bundles = await buildAll({ 
      pluginRoot, 
      outRoot: join(testRoot, "build"), 
      runnerAbsPath: join(pluginRoot, "hooks", "runner.js") 
    });
  });

  afterAll(async () => {
    try { await rm(testRoot, { recursive: true, force: true }); } catch {}
  });

  it("journal is written AFTER mutations (current behavior - documents gap)", async () => {
    const agent = "opencode" as const;
    const opts = { home, projectDir: project, pluginName: "test-plugin", version: "0.1.0", dryRun: false };
    
    await executeInstall(agent, bundles.opencode, opts);
    
    // Verify journal exists
    const journalRoot = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName: "test-plugin" });
    const journalPath = join(journalRoot, ".anyplugin-state.json");
    expect(await pathExists(journalPath)).toBe(true);
    
    // This test documents the current gap: mutations happen at lines 334-419,
    // journal written at lines 421-429. A crash between them leaves partial install.
    
    // Clean up for next test
    const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName: "test-plugin" });
    try { await rm(root, { recursive: true, force: true }); } catch {}
  });

  it("dry-run does not write journal or modify files", async () => {
    const agent = "opencode" as const;
    const opts = { home, projectDir: project, pluginName: "test-plugin", version: "0.1.0", dryRun: true };
    
    await executeInstall(agent, bundles.opencode, opts);
    
    const journalRoot = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName: "test-plugin" });
    const journalPath = join(journalRoot, ".anyplugin-state.json");
    expect(await pathExists(journalPath)).toBe(false);
  });
});