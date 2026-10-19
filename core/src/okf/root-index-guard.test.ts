import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regenerateIndexes } from "@lablaunchpad/core";

/**
 * Regenerating a bundle's indexes must never destroy a hand-curated root.
 *
 * The root `index.md` of a bundle is a NAVIGATION MAP, not a generated
 * listing: it groups concepts by intent and says things a generator cannot
 * infer. Overwriting it with generated content destroys work that cannot be
 * reproduced, and the engineering ledger records a past incident of exactly
 * this class. The fix is that the root is only written when it does not
 * exist, or when the caller explicitly asks for it.
 */
describe("okf-reindex — a hand-curated root index is not overwritten", () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "okf-root-guard-"));
    await mkdir(join(root, "agents"), { recursive: true });
    await writeFile(
      join(root, "agents", "claude-code.md"),
      `---
type: Agent
title: Claude Code
description: The Claude Code plugin surface
---
Body`,
    );
    await writeFile(
      join(root, "agents", "codex.md"),
      `---
type: Agent
title: Codex
description: The Codex plugin surface
---
Body`,
    );
  });

  afterAll(async () => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {}
  });

  it("creates the root index when there is none", async () => {
    const written = await regenerateIndexes(root);
    expect(written).toContain("index.md");
    // The root was created, because it did not exist.
    const text = await readFile(join(root, "index.md"), "utf8");
    expect(text).toContain("Claude Code");
  });

  it("leaves an existing hand-curated root index ALONE", async () => {
    const curated = `---
okf_version: "0.2"
---

# Hand-Curated Navigation

This text is prose a generator could never produce. If it disappears, the
bundle lost information that no regeneration can bring back.
`;
    await writeFile(join(root, "index.md"), curated, "utf8");

    const written = await regenerateIndexes(root);
    // The root is NOT in the written list.
    expect(written).not.toContain("index.md");
    // And the curated content is byte-identical afterwards.
    expect(await readFile(join(root, "index.md"), "utf8")).toBe(curated);
  });

  it("still regenerates the SUB-directory indexes", async () => {
    const written = await regenerateIndexes(root);
    expect(written).toContain("agents/index.md");
    const agentsIndex = await readFile(join(root, "agents", "index.md"), "utf8");
    expect(agentsIndex).toContain("Claude Code");
    expect(agentsIndex).toContain("Codex");
  });

  it("replaces the root index only when explicitly asked", async () => {
    const curated = "# Hand-Curated Navigation\n";
    await writeFile(join(root, "index.md"), curated, "utf8");

    const written = await regenerateIndexes(root, { includeRoot: true });
    expect(written).toContain("index.md");
    const after = await readFile(join(root, "index.md"), "utf8");
    expect(after).not.toBe(curated);
    expect(after).toContain("Claude Code");
  });

  it("the repo's own bundle keeps its curated root across a reindex", async () => {
    // The real bundle: this is the exact hazard the guard exists for.
    //
    // The reindex is run against a COPY, never against the tracked tree. A
    // test that rewrites tracked files is a test that can fail the build by
    // accident — and, worse, one that leaves the working tree dirty.
    const repoBundle = join(process.cwd(), "knowledge");
    const before = await readFile(join(repoBundle, "index.md"), "utf8");

    const copy = await mkdtemp(join(tmpdir(), "okf-repo-copy-"));
    try {
      await cp(repoBundle, copy, { recursive: true });
      await regenerateIndexes(copy);
      const after = await readFile(join(copy, "index.md"), "utf8");
      expect(after).toBe(before);
      expect(after).toContain("AnyPlugin Knowledge Index");
    } finally {
      await rm(copy, { recursive: true, force: true });
    }

    // And the tracked file is still exactly as it was.
    expect(await readFile(join(repoBundle, "index.md"), "utf8")).toBe(before);
  });
});
