import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installInstructions, uninstallInstructions, buildAll, executeInstall, executeUninstall } from "./index.js";
import { pathExists } from "@lablaunchpad/core";

async function makePlugin(): Promise<{ root: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), "tier-"));
  const project = join(root, "project");
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(
    join(root, "anyplugin.plugin.yaml"),
    `name: tier-plugin
version: 0.3.0
description: instruction tier test
skills: ["./skills/demo"]
ladder:
  - "Check the pattern first"
  - "Only then intercept"
intensity:
  conservative: "Explicit violations only"
`,
  );
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\nbody\n");
  return { root, project };
}

describe("instruction-tier install/uninstall (ponytail pattern, journaled)", () => {
  it("installs a marked AGENTS.md section and reverses it byte-exact", async () => {
    const { root, project } = await makePlugin();
    const original = "# Project instructions\n\nKeep me.\n";
    await writeFile(join(project, "AGENTS.md"), original);

    const result = await installInstructions({ pluginRoot: root, projectDir: project });
    const after = await readFile(join(project, "AGENTS.md"), "utf8");
    expect(after).toContain("anyplugin:tier-plugin:instruction begin");
    expect(after).toContain("# tier-plugin (v0.3.0)");
    expect(after).toContain("## Behavioral ladder");
    expect(after).toContain("1. Check the pattern first");
    expect(after).toContain("**conservative**: Explicit violations only");
    expect(after).toContain("Keep me.");

    const touched = await uninstallInstructions({ pluginRoot: root, projectDir: project });
    expect(touched.length).toBeGreaterThan(0);
    expect(await readFile(join(project, "AGENTS.md"), "utf8")).toBe(original);
    expect(await pathExists(join(project, ".anyplugin", "instruction", "tier-plugin"))).toBe(false);
  });

  it("creates AGENTS.md when absent and deletes it on uninstall", async () => {
    const { root, project } = await makePlugin();
    await installInstructions({ pluginRoot: root, projectDir: project });
    expect(await pathExists(join(project, "AGENTS.md"))).toBe(true);
    await uninstallInstructions({ pluginRoot: root, projectDir: project });
    expect(await pathExists(join(project, "AGENTS.md"))).toBe(false);
  });

  it("aborts uninstall and preserves edits when AGENTS.md changed after install", async () => {
    const { root, project } = await makePlugin();
    await installInstructions({ pluginRoot: root, projectDir: project });
    await writeFile(join(project, "AGENTS.md"), (await readFile(join(project, "AGENTS.md"), "utf8")) + "\nMY NOTES\n");
    await expect(uninstallInstructions({ pluginRoot: root, projectDir: project })).rejects.toThrow(/modified after install/);
    expect(await readFile(join(project, "AGENTS.md"), "utf8")).toContain("MY NOTES");
  });

  it("dry-run reports without touching anything", async () => {
    const { root, project } = await makePlugin();
    const r = await installInstructions({ pluginRoot: root, projectDir: project, dryRun: true });
    expect(r.notes.some((n) => n.startsWith("would"))).toBe(true);
    expect(await pathExists(join(project, "AGENTS.md"))).toBe(false);
  });

  it("reinstall never duplicates or resurrects stale sections", async () => {
    const { root, project } = await makePlugin();
    await installInstructions({ pluginRoot: root, projectDir: project });
    await installInstructions({ pluginRoot: root, projectDir: project });
    const text = await readFile(join(project, "AGENTS.md"), "utf8");
    expect(text.match(/anyplugin:tier-plugin:instruction begin/g)?.length).toBe(1);
  });

  it("coexists with a native OpenCode install in the same AGENTS.md — no clobber, independent marker blocks", async () => {
    const { root, project } = await makePlugin();
    const home = join(root, "home");
    const bundles = await buildAll({ pluginRoot: root, outRoot: join(root, "build"), agents: ["opencode"], runnerAbsPath: join(root, "runner.js") });
    const opts = { home, projectDir: project, pluginName: "tier-plugin" };

    await executeInstall("opencode", bundles["opencode"]!, opts);
    await installInstructions({ pluginRoot: root, projectDir: project });

    const agentsMd = await readFile(join(project, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("<!-- anyplugin:tier-plugin begin -->"); // opencode's native block
    expect(agentsMd).toContain("<!-- anyplugin:tier-plugin:instruction begin -->"); // instruction tier's block — distinct marker, no collision

    // Uninstalling the instruction tier (installed second) restores the file
    // to exactly what OpenCode's install left it as — no clobber of OpenCode's
    // block, no corruption, byte-exact for the part it doesn't own.
    await uninstallInstructions({ pluginRoot: root, projectDir: project });
    const afterInstructionUninstall = await readFile(join(project, "AGENTS.md"), "utf8");
    expect(afterInstructionUninstall).toContain("<!-- anyplugin:tier-plugin begin -->");
    expect(afterInstructionUninstall).not.toContain(":instruction");

    await executeUninstall("opencode", bundles["opencode"]!, opts);
    expect(await pathExists(join(project, "AGENTS.md"))).toBe(false);
  });

  it("uninstalling the earlier-installed writer first hits a safe conflict-abort, never data loss (pre-existing journal limitation, not new in this PR)", async () => {
    // The journal's whole-file hash check (classifyJournalEntry, journal.ts)
    // is shared by every marker/json-merge writer, not scoped per-marker.
    // Any second writer into the same file — regardless of what it is or
    // which marker it uses — changes the file's bytes and invalidates the
    // first writer's journal, so uninstalling the first writer first always
    // conflict-aborts today. Reproduced independently against origin/main
    // with two unrelated plugins sharing one opencode.json/AGENTS.md, so
    // this is a pre-existing, systemic limitation of shared-file journaling
    // — not something this PR introduces or is in scope to fix. What this
    // PR's marker-rename fix guarantees is that the abort is SAFE (an error,
    // recoverable by reinstalling) rather than the prior silent clobber.
    const { root, project } = await makePlugin();
    const home = join(root, "home");
    const bundles = await buildAll({ pluginRoot: root, outRoot: join(root, "build"), agents: ["opencode"], runnerAbsPath: join(root, "runner.js") });
    const opts = { home, projectDir: project, pluginName: "tier-plugin" };

    await executeInstall("opencode", bundles["opencode"]!, opts);
    await installInstructions({ pluginRoot: root, projectDir: project });

    await expect(executeUninstall("opencode", bundles["opencode"]!, opts)).rejects.toThrow(/modified after install/);
    // Nothing was deleted or corrupted by the failed attempt — both blocks intact.
    const agentsMd = await readFile(join(project, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("<!-- anyplugin:tier-plugin begin -->");
    expect(agentsMd).toContain("<!-- anyplugin:tier-plugin:instruction begin -->");
  });
});
