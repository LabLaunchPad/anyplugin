import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regenerateIndexes } from "./index.js";

describe("regenerateIndexes — nested bundles", () => {
  it("renders # Subdirectories in the root index and per-directory indexes at every depth", async () => {
    const root = await mkdtemp(join(tmpdir(), "okf-nested-"));
    await mkdir(join(root, "agents"), { recursive: true });
    await mkdir(join(root, "formats", "deep"), { recursive: true });
    await writeFile(join(root, "agents", "claude.md"), "---\ntype: Reference\ntitle: Claude\ndescription: claude docs\n---\nbody\n");
    await writeFile(join(root, "formats", "skill.md"), "---\ntype: Reference\ntitle: Skill\ndescription: skill docs\n---\nbody\n");
    await writeFile(join(root, "formats", "deep", "inner.md"), "---\ntype: Guide\ntitle: Inner\ndescription: inner\n---\nbody\n");

    const written = await regenerateIndexes(root);

    const rootIndex = await readFile(join(root, "index.md"), "utf8");
    expect(rootIndex).toContain("# Subdirectories");
    expect(rootIndex).toContain("[agents](agents/index.md)");
    expect(rootIndex).toContain("[formats](formats/index.md)");

    // non-root directories with their own children also list subdirectories
    const formatsIndex = await readFile(join(root, "formats", "index.md"), "utf8");
    expect(formatsIndex).toContain("# Subdirectories");
    expect(formatsIndex).toContain("[deep](deep/index.md)");
    expect(formatsIndex).toContain("[Skill](skill.md)");

    expect(written.some((w) => w.includes("deep"))).toBe(true);
  });
});
