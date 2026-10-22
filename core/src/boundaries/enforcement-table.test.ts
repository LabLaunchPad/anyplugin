/**
 * The enforcement-table guard.
 *
 * ── What it catches ────────────────────────────────────────────────────────
 *
 * `docs/FAILURE-MODES.md` §11 is a table of the form *"this rule is enforced
 * here, by this test"*. It is the right artefact — and it was the reason
 * PM-001's defect survived: the row for *"Fallback is illegal after a
 * commit"* pointed only at `delegation.test.ts`, a **unit test on the module
 * that defines the rule**, while the rule's only production consumer,
 * `cli/src/delegate.ts`, passed it a **constant**. The rule was correct,
 * tested, and inert.
 *
 * A table that names only the *definition* cannot see that. So the table now
 * names the **live consumer** too, and this guard checks it mechanically:
 *
 * 1. every named test file must **exist** (a renamed file is a silent lie);
 * 2. every row's live consumer must **exist**;
 * 3. at least one of the row's named tests must **touch** that consumer — by
 *    importing it, by naming its path, or by naming its file.
 *
 * Rule 3 is the one that matters. It is the check the table failed before.
 *
 * ── Why "touch" rather than "test the consumer's behaviour" ───────────────
 *
 * A guard cannot know what a test *asserts* about another module. What it
 * can know is whether the test is capable of failing when the consumer
 * misbehaves — and a test that never mentions the consumer is not. So the
 * check is a **necessary** condition, not a sufficient one, and the table's
 * curation is what makes it sufficient. The guard stops the *gap*; the
 * humans keep the *precision*.
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * This guard SCANS the repository: it reads every source file under the
 * worker-runtime and the CLI to check that each rule's live consumer is
 * touched by one of its named tests.
 *
 * The scan gets slower as the repository grows, and vitest's default 5s bound
 * is calibrated for unit tests. Measured: two of these took 9.4s and 10.4s
 * on a loaded machine and failed on the timeout while the code was correct —
 * the same F17 class the other spawn-heavy suites carry an explicit bound
 * for. The bound is stated rather than left to the default.
 *
 * This changes no assertion: a genuine gap in the table still fails.
 */
vi.setConfig({ testTimeout: 120_000 });

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const TABLE_DOC = join(REPO_ROOT, "docs", "FAILURE-MODES.md");

interface EnforcementRow {
  readonly rule: string;
  readonly enforcedBy: string;
  readonly liveConsumer: string;
  readonly tests: string[];
}

/** The §11 table's rows, parsed from the markdown. */
export function parseEnforcementTable(markdown: string): EnforcementRow[] {
  const start = markdown.indexOf("## 11. Where each rule is enforced");
  if (start < 0) return [];
  const section = markdown.slice(start);
  const rows: EnforcementRow[] = [];
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    if (cells[0] === "Rule" || cells[0] === "---") continue;
    if (/^-+$/.test(cells[0] ?? "")) continue;
    const backticked = (cell: string): string[] =>
      [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    rows.push({
      rule: cells[0]!,
      enforcedBy: backticked(cells[1] ?? "").join(" "),
      liveConsumer: backticked(cells[2] ?? "").join(" "),
      tests: backticked(cells[3] ?? ""),
    });
  }
  return rows;
}

/** Expand a path that may contain `*` into the files it matches. */
function expand(pattern: string): string[] {
  if (!pattern.includes("*")) return existsSync(join(REPO_ROOT, pattern)) ? [pattern] : [];
  const regex = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      const rel = relative(REPO_ROOT, full).split("\\").join("/");
      if (regex.test(rel)) out.push(rel);
    }
  };
  walk(REPO_ROOT);
  return out.sort();
}

/**
 * A named test may be written as a full repo-relative path.
 *
 * A bare file name is **rejected**, not resolved by search: the table is
 * read by people, and a name that only works because the guard guessed
 * where it lives is a name two people will read differently. Every path in
 * the table is explicit.
 */
function resolveTestPath(pattern: string): string[] {
  if (pattern.includes("*")) return expand(pattern);
  if (pattern.includes("/")) return existsSync(join(REPO_ROOT, pattern)) ? [pattern] : [];
  return [];
}

/**
 * Does a test file touch a consumer?
 *
 * Three acceptable forms, in descending strength:
 * 1. it **imports** the consumer's module;
 * 2. it names the consumer's **repo-relative path**;
 * 3. it names the consumer's **file** (e.g. `delegate.js`).
 */
export function touchesConsumer(testSource: string, consumer: string): boolean {
  const base = consumer.split("/").pop()!;
  const stem = base.replace(/\.[cm]?[jt]s$/, "");
  // (1) an import that resolves to the consumer.
  for (const match of testSource.matchAll(/from\s+["']([^"']+)["']/g)) {
    const spec = match[1]!;
    if (spec.endsWith(`/${base}`) || spec.endsWith(`/${base.replace(/\.js$/, ".ts")}`)) return true;
    if (spec === `./${base}` || spec === `./${base.replace(/\.js$/, ".ts")}`) return true;
    if (spec.endsWith(`/${stem}.js`) || spec.endsWith(`/${stem}.ts`)) return true;
  }
  // (2) the repo-relative path.
  if (testSource.includes(consumer)) return true;
  // (3) the file name — the ESM specifier form, which is what an import uses.
  if (testSource.includes(base)) return true;
  if (base.endsWith(".js") && testSource.includes(base.replace(/\.js$/, ".ts"))) return true;
  return false;
}

describe("the enforcement table", () => {
  const markdown = readFileSync(TABLE_DOC, "utf8");
  const rows = parseEnforcementTable(markdown);

  it("has rows to check — the guard is not vacuous", () => {
    expect(rows.length, "the §11 table was not found or is empty").toBeGreaterThan(5);
  });

  it("names a live consumer for every rule", () => {
    for (const row of rows) {
      expect(row.liveConsumer, `the rule "${row.rule}" names no live consumer`).not.toBe("");
    }
  });

  it("names only tests that exist", () => {
    const missing: string[] = [];
    for (const row of rows) {
      for (const pattern of row.tests) {
        if (resolveTestPath(pattern).length === 0) {
          missing.push(`${row.rule}: ${pattern} — a named test must be a full repo-relative path that exists`);
        }
      }
    }
    expect(missing, `these named tests do not exist:\n${missing.join("\n")}`).toEqual([]);
  });

  it("names only live consumers that exist", () => {
    const missing: string[] = [];
    for (const row of rows) {
      for (const consumer of row.liveConsumer.split(/\s+/).filter((c) => c.includes("/"))) {
        if (!existsSync(join(REPO_ROOT, consumer))) missing.push(`${row.rule}: ${consumer}`);
      }
    }
    expect(missing, `these live consumers do not exist:\n${missing.join("\n")}`).toEqual([]);
  });

  it("has every rule's live consumer touched by one of its tests", () => {
    // THE CHECK THAT MATTERS. A rule whose live consumer is never touched
    // by any named test is the shape PM-001 found: a rule that is defined,
    // unit-tested, and never exercised where it is used.
    const untouched: string[] = [];
    for (const row of rows) {
      const consumers = row.liveConsumer.split(/\s+/).filter((c) => c.includes("/"));
      if (consumers.length === 0) continue;
      const sources: string[] = [];
      for (const pattern of row.tests) {
        for (const file of resolveTestPath(pattern)) {
          sources.push(readFileSync(join(REPO_ROOT, file), "utf8"));
        }
      }
      const touched = consumers.some((consumer) => sources.some((s) => touchesConsumer(s, consumer)));
      if (!touched) {
        untouched.push(`${row.rule}: no named test touches ${consumers.join(" or ")}`);
      }
    }
    expect(untouched, `these rules are not exercised at their live consumer:\n${untouched.join("\n")}`).toEqual(
      [],
    );
  });

  it("CAN fail — a table whose live consumer is untested is caught", () => {
    // The guard's own mutation test.
    const row: EnforcementRow = {
      rule: "A rule nobody exercises",
      enforcedBy: "`packages/worker-runtime/src/telemetry/delegation.ts`",
      liveConsumer: "`cli/src/delegate.ts`",
      tests: ["`packages/worker-runtime/src/telemetry/delegation.test.ts`"],
    };
    const source = readFileSync(
      join(REPO_ROOT, "packages", "worker-runtime", "src", "telemetry", "delegation.test.ts"),
      "utf8",
    );
    // The kernel's unit test does NOT touch the CLI's consumer.
    expect(touchesConsumer(source, "cli/src/delegate.ts"), "the kernel's unit test must not touch the CLI").toBe(
      false,
    );
    // And the CLI's own test does.
    const cliSource = readFileSync(join(REPO_ROOT, "cli", "src", "delegate.test.ts"), "utf8");
    expect(touchesConsumer(cliSource, "cli/src/delegate.ts")).toBe(true);
    expect(row.tests.length).toBe(1);
  });
});
