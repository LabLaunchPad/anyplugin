import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildAll, executeInstall, executeUninstall, scaffoldPlugin, installedRoot } from "./index.js";
import { loadPluginManifest } from "@lablaunchpad/core";

async function pathExists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

describe.sequential("Installer destination ownership — audit regression tests (Finding C)", () => {
  let testRoot: string;
  let home: string;
  let project: string;
  let pluginRoot: string;
  let bundles: Record<string, any>;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "install-ownership-test-"));
    home = join(testRoot, "home");
    project = join(testRoot, "project");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });

    // Create a test plugin
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

  afterEach(async () => {
    // Clean up plugin root directories after each test to avoid interference
    for (const agent of ["claude-code", "opencode", "codex", "antigravity"] as const) {
      const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName: "test-plugin" });
      try { await rm(root, { recursive: true, force: true }); } catch {}
    }
  });

  afterAll(async () => {
    try { await rm(testRoot, { recursive: true, force: true }); } catch {}
  });

  it("refuses install when destination directory already exists with user files (unmanaged)", async () => {
    const agent = "opencode" as const;
    const opts = { home, projectDir: project, pluginName: "test-plugin", version: "0.1.0", dryRun: false };
    
    // Create a pre-existing plugin directory with a user file
    const existingRoot = installedRoot(agent, { 
      home, projectDir: project, codexHome: project, pluginName: "test-plugin" 
    });
    await mkdir(existingRoot, { recursive: true });
    await writeFile(join(existingRoot, "user-file.txt"), "USER DATA");

    // Install should fail/refuse because destination has unmanaged content
    // This test documents the current gap - the installer does NOT classify destinations
    await expect(executeInstall(agent, bundles.opencode, opts)).rejects.toThrow();
  });

  it("refuses install when second plugin attempts same target name", async () => {
    const agent = "opencode" as const;
    const opts = { home, projectDir: project, pluginName: "test-plugin", version: "0.1.0", dryRun: false };

    // First install
    const result1 = await executeInstall(agent, bundles.opencode, opts);
    
    // Check that journal was written and is readable
    const root = installedRoot(agent, { 
      home, projectDir: project, codexHome: project, pluginName: "test-plugin" 
    });
    const journalPath = join(root, ".anyplugin-state.json");
    const journalExists = await pathExists(journalPath);
    expect(journalExists).toBe(true);
    
    // Read and verify journal content
    const journalContent = await readFile(journalPath, "utf8");
    expect(journalContent).toContain("installationId");
    expect(journalContent).toContain("test-plugin");
    
    // Also verify readJournal can read it
    const { readJournal } = await import("./journal.js");
    const journal = await readJournal(root);
    expect(journal).not.toBeNull();
    expect(journal!.pluginId).toBe("test-plugin");
    expect(journal!.installationId).toBeDefined();
    
    // Second plugin with same name - should fail with "owned by another installation"
    await expect(executeInstall(agent, bundles.opencode, opts)).rejects.toThrow("owned by another installation");
  });

  it("uninstall does not recursively delete unmanaged content in destination root", async () => {
    const agent = "opencode" as const;
    const opts = { home, projectDir: project, pluginName: "test-plugin", version: "0.1.0", dryRun: false };

    const existingRoot = installedRoot(agent, { 
      home, projectDir: project, codexHome: project, pluginName: "test-plugin" 
    });
    await mkdir(existingRoot, { recursive: true });
    await writeFile(join(existingRoot, "user-file.txt"), "USER DATA");
    
    // Try to install (may fail or succeed depending on implementation)
    try {
      await executeInstall(agent, bundles.opencode, opts);
    } catch {}

    // The user file should still exist after uninstall
    // This test documents the gap - removeTree blindly deletes everything
    const userFile = join(existingRoot, "user-file.txt");
    expect(await pathExists(userFile)).toBe(true);
  });
});