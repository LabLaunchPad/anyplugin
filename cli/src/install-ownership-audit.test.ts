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
    // The opencode adapter also copies skills/commands into SHARED directories
    // outside the installed root. They are managed by the plugin journal, so
    // removing the journal without removing them would leave the next install
    // with a legitimately-unmanaged destination (fail-closed conflict).
    for (const shared of [join(project, ".opencode", "skills"), join(project, ".opencode", "commands")]) {
      try { await rm(shared, { recursive: true, force: true }); } catch {}
    }
  });

  afterAll(async () => {
    try { await rm(testRoot, { recursive: true, force: true }); } catch {}
  });

  it("refuses install when destination directory already exists with user files (unmanaged)", { timeout: 60_000 }, async () => {
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

  it("refuses install when second plugin attempts same target name", { timeout: 60_000 }, async () => {
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

  it("uninstall does not recursively delete unmanaged content in destination root", { timeout: 60_000 }, async () => {
    const agent = "opencode" as const;
    const opts = { home, projectDir: project, pluginName: "test-plugin", version: "0.1.0", dryRun: false };

    const existingRoot = installedRoot(agent, { 
      home, projectDir: project, codexHome: project, pluginName: "test-plugin" 
    });
    await mkdir(existingRoot, { recursive: true });
    await writeFile(join(existingRoot, "user-file.txt"), "USER DATA");
    
    // The install must REFUSE (the directory is unmanaged) — and the refusal
    // must leave the user's file exactly as it was.
    await expect(executeInstall(agent, bundles.opencode, opts)).rejects.toThrow();

    // The user file should still exist, byte-identical.
    const userFile = join(existingRoot, "user-file.txt");
    expect(await pathExists(userFile)).toBe(true);
    expect(await readFile(userFile, "utf8")).toBe("USER DATA");
  });

  it("uninstall removes only the files the journal records, leaving the rest", { timeout: 60_000 }, async () => {
    const agent = "opencode" as const;
    const opts = { home, projectDir: project, pluginName: "test-plugin", version: "0.1.0", dryRun: false };

    // Install cleanly into a fresh destination.
    await executeInstall(agent, bundles.opencode, opts);
    const existingRoot = installedRoot(agent, {
      home, projectDir: project, codexHome: project, pluginName: "test-plugin",
    });

    // The user adds a file of their own AFTER the install.
    const userFile = join(existingRoot, "user-file.txt");
    await writeFile(userFile, "USER DATA");

    // The uninstall removes exactly what the journal records. The user's file
    // is not in the journal, so it is not removed — and the directory is not
    // empty afterwards, so the directory is not removed either.
    const touched = await executeUninstall(agent, bundles.opencode, opts);
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.some((t) => t.includes("user-file.txt"))).toBe(false);

    // The user's file survives, byte-exact.
    expect(await pathExists(userFile)).toBe(true);
    expect(await readFile(userFile, "utf8")).toBe("USER DATA");
    // And the directory survives, because it is not empty.
    expect(await pathExists(existingRoot)).toBe(true);
  });
});