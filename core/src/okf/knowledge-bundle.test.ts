import { describe, it, expect } from "vitest";
import { validateBundle, regenerateIndexes, readBundle } from "./index.js";
import { join, dirname } from "node:path";
import { mkdtemp, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const knowledgeDir = join(repoRoot, "knowledge");

describe("repo knowledge bundle (dogfood)", () => {
  it("validates with zero errors per OKF v0.2", async () => {
    const issues = await validateBundle(knowledgeDir);
    const errors = issues.filter((i) => i.level === "error");
    expect(errors).toEqual([]);
  });

  it("has all four agent concepts and required frontmatter", async () => {
    const bundle = await readBundle(knowledgeDir);
    const ids = bundle.documents.map((d) => d.id);
    for (const agent of ["claude-code", "opencode", "codex", "antigravity"]) {
      expect(ids).toContain(`agents/${agent}`);
    }
    for (const doc of bundle.documents) {
      expect(typeof doc.frontmatter["type"]).toBe("string");
    }
  });

  it("regenerates indexes idempotently on a temp copy — never mutates the repo bundle", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "okf-dogfood-"));
    const dir = join(tmp, "knowledge");
    await cp(knowledgeDir, dir, { recursive: true });

    const before = await readBundle(dir);
    await regenerateIndexes(dir);
    await regenerateIndexes(dir); // second run must be a no-op (idempotent)
    const after = await readBundle(dir);
    expect(after.documents.map((d) => d.id).sort()).toEqual(before.documents.map((d) => d.id).sort());
    const issues = await validateBundle(dir);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);

    // the committed root index is hand-curated and must survive every test run
    const rootIndex = await readFile(join(knowledgeDir, "index.md"), "utf8");
    expect(rootIndex).toContain("# AnyPlugin Knowledge Index");
  });
});
