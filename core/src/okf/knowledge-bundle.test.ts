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

  it(
    "regenerates indexes idempotently on a temp copy — never mutates the repo bundle",
    // P2-28: the generator walks the bundle and rewrites every index, which
    // is more than vitest's default 5 s when the machine is under load. A
    // timeout here is a FALSE ALARM about the bundle, which is worse than no
    // check at all.
    { timeout: 60_000 },
    async () => {
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
    },
  );

  it(
    "the COMMITTED indexes match the generator's output — drift is caught",
    // P1-4: the committed `knowledge/**/index.md` files were never compared
    // against the generator's output, so index drift was silent — a hand
    // edit to an index would sit in the repository and nobody would know.
    //
    // The comparison EXCLUDES the root index, which is hand-curated by
    // design (`regenerateIndexes` leaves it alone unless `includeRoot`).
    { timeout: 60_000 },
    async () => {
      const tmp = await mkdtemp(join(tmpdir(), "okf-drift-"));
      const dir = join(tmp, "knowledge");
      await cp(knowledgeDir, dir, { recursive: true });

      // The generator says exactly which files it wrote.
      const written = await regenerateIndexes(dir);
      expect(written.length, "the generator wrote no indexes at all").toBeGreaterThan(0);
      expect(written, "the root index is hand-curated and must not be generated").not.toContain("index.md");

      const drifted: string[] = [];
      for (const rel of written) {
        const generated = await readFile(join(dir, rel), "utf8");
        const committed = await readFile(join(knowledgeDir, rel), "utf8");
        if (generated !== committed) drifted.push(rel);
      }
      expect(
        drifted,
        `these committed indexes differ from the generator's output — run "anyplugin okf-reindex knowledge":\n${drifted.join("\n")}`,
      ).toEqual([]);
    },
  );
});
