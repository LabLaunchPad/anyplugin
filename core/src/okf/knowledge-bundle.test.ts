import { describe, it, expect } from "vitest";
import { validateBundle, regenerateIndexes, readBundle } from "./index.js";
import { join, dirname } from "node:path";
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

  it("regenerates indexes idempotently without touching concepts", async () => {
    const before = await readBundle(knowledgeDir);
    await regenerateIndexes(knowledgeDir);
    const after = await readBundle(knowledgeDir);
    expect(after.documents.map((d) => d.id).sort()).toEqual(before.documents.map((d) => d.id).sort());
    const issues = await validateBundle(knowledgeDir);
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
  });
});
