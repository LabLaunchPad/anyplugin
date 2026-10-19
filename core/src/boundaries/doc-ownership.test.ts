import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Document ownership, and the decision record's internal integrity.
 *
 * The repository's own rule (ARCHITECTURE.md §7) is that one document owns
 * each question and every other document LINKS rather than restates. That
 * rule is only worth anything if it is checked: seven documents describing the
 * architecture slightly differently is a defect with a test count attached.
 *
 * So this test enforces two things a reviewer would otherwise have to check
 * by hand:
 *
 *   1. COMPLETENESS — every markdown file under `docs/` is named in the
 *      ownership map. A document nobody owns is a document nobody maintains,
 *      and it fails the build.
 *   2. CONSISTENCY — every `docs/` path the map names actually exists, and
 *      every decision id referenced anywhere resolves to a decision in
 *      DECISIONS.md.
 *
 * The second one is the cross-check: a doc that points at a decision which
 * does not exist is a broken claim, and the repo's discipline is that claims
 * are either backed or absent.
 */

const REPO_ROOT = resolve(".");
const DOCS_DIR = join(REPO_ROOT, "docs");
const ARCHITECTURE = join(REPO_ROOT, "ARCHITECTURE.md");
const DECISIONS = join(DOCS_DIR, "DECISIONS.md");

/** Every markdown file under `docs/`, relative to the repo root, POSIX-style. */
function docsMarkdownFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.endsWith(".md")) {
        out.push(relative(REPO_ROOT, full).split("\\").join("/"));
      }
    }
  };
  walk(DOCS_DIR);
  return out.sort();
}

/** All backtick-quoted paths that live under `docs/`. */
function referencedDocsPaths(text: string): string[] {
  const matches = text.match(/`docs\/[^`]+`/g) ?? [];
  return [...new Set(matches.map((m) => m.replace(/`/g, "")))].sort();
}

describe("document ownership — ARCHITECTURE.md §7", () => {
  const architecture = readFileSync(ARCHITECTURE, "utf8");
  const owned = referencedDocsPaths(architecture);
  const actual = docsMarkdownFiles();

  it("names every markdown file under docs/ in the ownership map", () => {
    // The point of the guard: a new document with no owner fails the build.
    const orphans = actual.filter((f) => !owned.includes(f));
    expect(
      orphans,
      `these documents are not owned by ARCHITECTURE.md §7 — add a row to the "which document owns what" table:\n${orphans.join("\n")}`,
    ).toEqual([]);
  });

  it("names only documents that exist", () => {
    const missing = owned.filter((f) => !existsSync(join(REPO_ROOT, f)));
    expect(
      missing,
      `ARCHITECTURE.md §7 names documents that do not exist:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("covers every document the repository actually ships", () => {
    // A spot-check that the guard is not vacuous: the set of docs is not
    // empty, and the map is not a single row.
    expect(actual.length).toBeGreaterThanOrEqual(5);
    expect(owned.length).toBeGreaterThanOrEqual(5);
  });
});

describe("the decision record", () => {
  const decisions = readFileSync(DECISIONS, "utf8");

  /** Every decision id defined in DECISIONS.md. */
  function definedDecisionIds(): string[] {
    const ids = new Set<string>();
    for (const m of decisions.matchAll(/^###\s+(D-\d{3})\b/gm)) ids.add(m[1]!);
    return [...ids].sort();
  }

  it("defines every decision id exactly once", () => {
    const headings = [...decisions.matchAll(/^###\s+(D-\d{3})\b/gm)].map((m) => m[1]!);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of headings) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    expect(duplicates, "a decision id is defined twice").toEqual([]);
    expect(headings.length).toBeGreaterThanOrEqual(20);
  });

  it("gives every decision a status, a context, a decision and consequences", () => {
    // A decision without a rejected alternative is a preference. A decision
    // without consequences is a rule nobody will follow.
    const headingRe = /^###\s+(D-\d{3})\b[^\n]*$/gm;
    const headings = [...decisions.matchAll(headingRe)];
    expect(headings.length).toBeGreaterThanOrEqual(20);

    const incomplete: string[] = [];
    for (let i = 0; i < headings.length; i++) {
      const match = headings[i]!;
      const id = match[1]!;
      const start = match.index! + match[0].length;
      const end = i + 1 < headings.length ? headings[i + 1]!.index! : decisions.length;
      const body = decisions.slice(start, end);
      if (!/\*\*Status:\*\*/.test(body)) incomplete.push(`${id}: no Status`);
      if (!/\*\*Context:\*\*/.test(body)) incomplete.push(`${id}: no Context`);
      if (!/\*\*Decision:\*\*/.test(body)) incomplete.push(`${id}: no Decision`);
      if (!/\*\*Consequences:\*\*/.test(body)) incomplete.push(`${id}: no Consequences`);
    }
    expect(incomplete, `decisions missing a required section:\n${incomplete.join("\n")}`).toEqual([]);
  });

  it("resolves every decision reference from every document", () => {
    const defined = new Set(definedDecisionIds());
    const broken: string[] = [];
    for (const file of [ARCHITECTURE, ...docsMarkdownFiles().map((f) => join(REPO_ROOT, f))]) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/\bD-(\d{3})\b/g)) {
        const id = `D-${m[1]}`;
        if (!defined.has(id)) broken.push(`${relative(REPO_ROOT, file)} → ${id}`);
      }
    }
    expect(
      [...new Set(broken)],
      "a document references a decision that DECISIONS.md does not define",
    ).toEqual([]);
  });
});

describe("the evidence ledger", () => {
  const evidence = readFileSync(join(DOCS_DIR, "EVIDENCE.md"), "utf8");

  it("gives every evidence row a verdict, a source and an access date", () => {
    // A claim without a source is an opinion, and opinions do not belong in
    // an evidence ledger.
    const rows = evidence
      .split("\n")
      .filter((l) => /^\|\s*E\d+\s*\|/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(15);

    const incomplete: string[] = [];
    for (const row of rows) {
      const id = row.match(/^\|\s*(E\d+)\s*\|/)?.[1] ?? "?";
      const cells = row.split("|").map((c) => c.trim());
      const verdict = cells[3] ?? "";
      const source = cells[5] ?? "";
      const date = cells[6] ?? "";
      // All four verdicts are first-class. `UNKNOWN` is the one that matters
      // most: it is a claim that is NOT established, and it is recorded
      // rather than filled in by inference.
      if (!/VERIFIED|CONTRADICTED|UNKNOWN/.test(verdict)) incomplete.push(`${id}: verdict "${verdict}"`);
      if (!/https?:\/\//.test(source)) incomplete.push(`${id}: no source URL`);
      if (!/\d{4}-\d{2}-\d{2}/.test(date)) incomplete.push(`${id}: no access date`);
    }
    expect(incomplete, `evidence rows missing a verdict, source or date:\n${incomplete.join("\n")}`).toEqual([]);
  });

  it("registers every unknown rather than filling it by inference", () => {
    const unknowns = [...evidence.matchAll(/^\|\s*(U\d+)\s*\|/gm)].map((m) => m[1]!);
    expect(unknowns.length).toBeGreaterThanOrEqual(3);
    // And each one states what would resolve it.
    for (const line of evidence.split("\n").filter((l) => /^\|\s*U\d+\s*\|/.test(l))) {
      expect(line, `an unknown row must state what would resolve it: ${line}`).toMatch(/\|\s*[^|]+\|\s*$/);
    }
  });
});
