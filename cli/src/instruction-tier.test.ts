import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installInstructions, uninstallInstructions } from "./index.js";
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
    expect(after).toContain("anyplugin:tier-plugin begin");
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
    expect(text.match(/anyplugin:tier-plugin begin/g)?.length).toBe(1);
  });
});
