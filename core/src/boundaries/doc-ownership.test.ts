import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Document ownership, the decision record's integrity, and cross-references.
 *
 * The repository's own rule (ARCHITECTURE.md §7) is that one document owns
 * each question and every other document LINKS rather than restates. That
 * rule is only worth anything if it is checked: seven documents describing
 * the architecture slightly differently is a defect with a test count attached.
 *
 * So this file enforces what a reviewer would otherwise check by hand:
 *
 *   1. COMPLETENESS — every markdown file under `docs/` has an OWNER ROW in
 *      the ownership table. A document nobody owns is a document nobody
 *      maintains, and it fails the build.
 *   2. CONSISTENCY — every `docs/` path the table names exists; every
 *      decision carries a Status, Context, Decision and Consequences; every
 *      `D-nnn` reference resolves; every `§N` section pointer resolves.
 *   3. EVIDENCE — every evidence row carries a verdict, a source URL and an
 *      access date; every UNKNOWN is registered with what would resolve it.
 *
 * The last clause in each list matters more than the rest: **a guard that
 * can pass vacuously is worse than no guard**, because it manufactures
 * confidence. The "the guard can fail" test at the end exists to prove it.
 */

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DOCS_DIR = join(REPO_ROOT, "docs");
const ARCHITECTURE = join(REPO_ROOT, "ARCHITECTURE.md");
const DECISIONS = join(DOCS_DIR, "DECISIONS.md");
const EVIDENCE = join(DOCS_DIR, "EVIDENCE.md");

/** The documents this guard knows how to check. */
const DOC_FILES = [
  "docs/DECISIONS.md",
  "docs/PERSONAS.md",
  "docs/EVIDENCE.md",
  "docs/FAILURE-MODES.md",
  "docs/BACKLOG.md",
  "docs/SESSION-LEARNINGS.md",
  "docs/agent-sdk/README.md",
  "docs/agent-sdk/trust.md",
  "docs/agent-sdk/optimization.md",
  "docs/agent-sdk/economics.md",
  "ARCHITECTURE.md",
  "AGENTS.md",
];

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
      if (entry.endsWith(".md")) out.push(relative(REPO_ROOT, full).split("\\").join("/"));
    }
  };
  walk(DOCS_DIR);
  return out.sort();
}

/**
 * The `docs/...md` paths named by ROWS of the ownership table.
 *
 * Not every mention: the table is the contract, and a document named only in
 * prose has no owner. The section is located by its heading, and only the
 * table rows inside it are read.
 */
function ownershipTablePaths(): string[] {
  const text = readFileSync(ARCHITECTURE, "utf8");
  const lines = text.split(/\r?\n/);

  // Find the "## 7. Which document owns what" section.
  const start = lines.findIndex((l) => /^##\s+\d+\.\s+Which document owns what/.test(l));
  if (start < 0) return [];

  // It ends at the next `## ` heading.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i]!)) {
      end = i;
      break;
    }
  }

  const paths = new Set<string>();
  for (const line of lines.slice(start, end)) {
    // A table row, and a `docs/….md` path inside it.
    if (!/^\s*\|/.test(line)) continue;
    for (const m of line.matchAll(/`(docs\/[^`]*\.md)`/g)) {
      paths.add(m[1]!);
    }
  }
  return [...paths].sort();
}

/** The section numbers a document defines, e.g. "3.6" from "### 3.6 Foo". */
function sectionNumbers(text: string): Set<string> {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^#{2,4}\s+(\d+(?:\.\d+)*)\b/.exec(line);
    if (m) out.add(m[1]!);
  }
  return out;
}

const sectionCache = new Map<string, Set<string>>();
/**
 * The sections a repository-relative document defines.
 *
 * Always resolved against REPO_ROOT, never against the process CWD — the
 * guard must behave the same whether it is run from the repo root, from a
 * package directory, or from an IDE test runner.
 */
function sectionsOf(repoRelativePath: string): Set<string> {
  const key = resolve(REPO_ROOT, repoRelativePath);
  if (!sectionCache.has(key)) {
    sectionCache.set(key, existsSync(key) ? sectionNumbers(readFileSync(key, "utf8")) : new Set());
  }
  return sectionCache.get(key)!;
}

/** Resolve a referenced path relative to the referring document. */
function resolveTarget(referrer: string, target: string): string {
  if (target.startsWith("docs/") || target === "ARCHITECTURE.md" || target === "AGENTS.md") {
    return target;
  }
  return join(dirname(referrer), target).split("\\").join("/");
}

describe("document ownership — ARCHITECTURE.md §7", () => {
  const owned = ownershipTablePaths();
  const actual = docsMarkdownFiles();

  it("gives every markdown file under docs/ an OWNER ROW", () => {
    // The point of the guard: a new document with no owner fails the build.
    // It is an OWNER ROW, not a mention — a document named only in prose has
    // no owner, and the review proved a prose mention used to pass.
    const orphans = actual.filter((f) => !owned.includes(f));
    expect(
      orphans,
      `these documents have no row in the ARCHITECTURE.md §7 ownership table:\n${orphans.join("\n")}`,
    ).toEqual([]);
  });

  it("names only documents that exist", () => {
    const missing = owned.filter((f) => !existsSync(join(REPO_ROOT, f)));
    expect(
      missing,
      `ARCHITECTURE.md §7 names documents that do not exist:\n${missing.join("\n")}`,
    ).toEqual([]);
  });

  it("is not vacuous — the table and the file set are both substantial", () => {
    // A floor, not a proof: it stops a wholesale deletion from passing.
    expect(actual.length).toBeGreaterThanOrEqual(10);
    expect(owned.length).toBeGreaterThanOrEqual(10);
    // And the two sets overlap almost exactly, so the guard is doing work.
    expect(owned.filter((f) => actual.includes(f)).length).toBe(actual.length);
  });
});

describe("the decision record", () => {
  const decisions = readFileSync(DECISIONS, "utf8");

  /** The decision blocks, with the body bounded by the NEXT HEADING of any level. */
  function decisionBlocks(text: string): Array<{ id: string; body: string }> {
    const headingRe = /^###\s+(D-\d{3})\b[^\n]*$/gm;
    const headings = [...text.matchAll(headingRe)];
    return headings.map((match, i) => {
      const start = match.index! + match[0].length;
      // The body ends at the next heading of ANY level, so a marker in a
      // sibling section cannot satisfy a decision's own requirement.
      const rest = text.slice(start);
      const nextAny = /^\#{1,6}\s+\S/m.exec(rest);
      const end = nextAny ? start + nextAny.index : text.length;
      return { id: match[1]!, body: text.slice(start, end) };
    });
  }

  it("defines every decision id exactly once", () => {
    const ids = decisionBlocks(decisions).map((b) => b.id);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const id of ids) {
      if (seen.has(id)) duplicates.push(id);
      seen.add(id);
    }
    expect(duplicates, "a decision id is defined twice").toEqual([]);
    expect(ids.length).toBeGreaterThanOrEqual(20);
  });

  it("gives every decision a status, a context, a decision and consequences", () => {
    // A decision without a context has no reason to exist; one without
    // consequences is a rule nobody will follow.
    const incomplete: string[] = [];
    for (const { id, body } of decisionBlocks(decisions)) {
      if (!/\*\*Status:\*\*/.test(body)) incomplete.push(`${id}: no Status`);
      if (!/\*\*Context:\*\*/.test(body)) incomplete.push(`${id}: no Context`);
      if (!/\*\*Decision:\*\*/.test(body)) incomplete.push(`${id}: no Decision`);
      if (!/\*\*Consequences:\*\*/.test(body)) incomplete.push(`${id}: no Consequences`);
    }
    expect(incomplete, `decisions missing a required section:\n${incomplete.join("\n")}`).toEqual([]);
  });

  it("CAN FAIL — a decision with no decision statement is caught", () => {
    // The guard's own proof that it is not vacuous. Deleting a decision's
    // `**Decision:**` line must be detected, even when another decision
    // elsewhere in the file still carries the marker.
    const mutated = decisions.replace(
      /(\*\*Decision:\*\*[^\n]*\n)/,
      "",
    );
    expect(mutated).not.toBe(decisions);
    const incomplete = decisionBlocks(mutated).filter(
      ({ body }) => !/\*\*Decision:\*\*/.test(body),
    );
    expect(
      incomplete.map((b) => b.id),
      "the guard must notice a decision that lost its Decision line",
    ).not.toEqual([]);
  });

  it("resolves every decision reference from every document", () => {
    const defined = new Set(decisionBlocks(decisions).map((b) => b.id));
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

describe("section cross-references", () => {
  it("resolves every `§N` pointer to a section that exists", () => {
    // The `**Evidence:**` line is the machine-checkable handle for a
    // decision, and a pointer that does not take the reader to the claim it
    // supports is worse than no pointer at all.
    const broken: string[] = [];
    for (const file of DOC_FILES) {
      const abs = join(REPO_ROOT, file);
      if (!existsSync(abs)) continue;
      const text = readFileSync(abs, "utf8");
      for (const m of text.matchAll(/`([^`]*\.md)`\s*§\s*(\d+(?:\.\d+)*)/g)) {
        const target = resolveTarget(file, m[1]!);
        if (!existsSync(join(REPO_ROOT, target))) continue;
        if (!sectionsOf(target).has(m[2]!)) {
          broken.push(`${file} → ${m[1]} §${m[2]}`);
        }
      }
      // A bare `§N` refers to the document it appears in.
      for (const m of text.matchAll(/(?<![\w.]§)\b§\s*(\d+(?:\.\d+)*)/g)) {
        if (!sectionsOf(abs).has(m[1]!)) {
          broken.push(`${file} → §${m[1]} (this document)`);
        }
      }
    }
    expect(
      [...new Set(broken)],
      "a section pointer does not resolve to a section that exists",
    ).toEqual([]);
  });
});

describe("the evidence ledger", () => {
  const evidence = readFileSync(EVIDENCE, "utf8");

  it("gives every evidence row a verdict, a source and an access date", () => {
    // A claim without a source is an opinion, and opinions do not belong in
    // an evidence ledger.
    const rows = evidence.split("\n").filter((l) => /^\|\s*E\d+\s*\|/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(15);

    const incomplete: string[] = [];
    for (const row of rows) {
      const id = row.match(/^\|\s*(E\d+)\s*\|/)?.[1] ?? "?";
      const cells = row.split("|").map((c) => c.trim());
      const verdict = cells[3] ?? "";
      const source = cells[5] ?? "";
      const date = cells[6] ?? "";
      // All four verdicts are first-class, and the check is ANCHORED after
      // stripping the markdown emphasis: a bare substring match would accept
      // "UNVERIFIED" and reject "REFUTED".
      const bare = verdict.replace(/[`*_]/g, "").trim();
      if (!/^(VERIFIED|PARTLY VERIFIED|CONTRADICTED|UNKNOWN)\b/.test(bare)) {
        incomplete.push(`${id}: verdict "${verdict}"`);
      }
      if (!/https?:\/\//.test(source)) incomplete.push(`${id}: no source URL`);
      if (!/\d{4}-\d{2}-\d{2}/.test(date)) incomplete.push(`${id}: no access date`);
    }
    expect(incomplete, `evidence rows missing a verdict, source or date:\n${incomplete.join("\n")}`).toEqual([]);
  });

  it("registers every unknown rather than filling it by inference", () => {
    const unknownRows = evidence.split("\n").filter((l) => /^\|\s*U\d+\s*\|/.test(l));
    expect(unknownRows.length).toBeGreaterThanOrEqual(3);
    // Each one must name what would resolve it — the LAST column is that
    // column, and the header is asserted so a reordering is caught.
    const header = evidence
      .split("\n")
      .find((l) => /^\|\s*#\s*\|/.test(l) && /would resolve/i.test(l));
    expect(header, "the UNKNOWN register must have a 'what would resolve it' column").toBeDefined();
    // The resolution column must be the LAST one.
    const headerCells = header!.split("|").map((c) => c.trim()).filter((c) => c !== "");
    expect(
      headerCells[headerCells.length - 1]!.toLowerCase(),
      "the 'what would resolve it' column must be last, so the cell index below is right",
    ).toMatch(/what would resolve it/);
    for (const line of unknownRows) {
      const cells = line.split("|").map((c) => c.trim());
      // cells[0] is empty, cells[1] is the id, and the last is the resolution.
      const resolution = cells[cells.length - 2] ?? "";
      expect(resolution.length, `an unknown row must state what would resolve it: ${line}`).toBeGreaterThan(10);
    }
  });
});
