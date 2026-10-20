/**
 * The expected-failure convention guard.
 *
 * ── The problem it solves ──────────────────────────────────────────────────
 *
 * `docs/BACKLOG.md`'s definition of done for a BUG is *"a regression test
 * exists that fails without the fix"*. So the process **expects** a red test
 * for an open bug — with no mechanism to keep `pnpm test` green. Two
 * consequences, both bad:
 *
 * - a deliberately-red test and an accidentally-red test are
 *   **indistinguishable**; and
 * - the obvious response — merging a red test — breaks CI, so the obvious
 *   response is to merge a *green* test, which asserts the bug as correct
 *   behaviour. That is exactly what happened: `cli/src/delegate.test.ts`
 *   asserted `outcome.fallbackLegal === true` after a timeout, and the
 *   comment beside it — *"A timed-out turn is NOT committed, so a fallback is
 *   still legal"* — explained the defect away.
 *
 * ── The convention ──────────────────────────────────────────────────────────
 *
 * A test for an open bug is written with vitest's `it.fails`, and its name
 * carries the backlog id in square brackets:
 *
 * ```ts
 * it.fails("the delegation telemetry is persisted [P1-14]", () => { ... });
 * ```
 *
 * `it.fails` is a **tripwire**, not a suppression. The test still runs, and
 * the suite stays green — but the moment the bug is fixed, the tripwire
 * fires and says so. The red test becomes the thing that tells you to
 * delete it.
 *
 * The id in the name is what makes the test findable: a reader who finds a
 * failing test knows which backlog row it belongs to, and a backlog reader
 * can find the test.
 *
 * ── ARMED, PASSED, FAILED ──────────────────────────────────────────────────
 *
 * The trichotomy the package-boundary guard already uses, and it is the right
 * one here: a guard whose target is absent has **not** been exercised, and
 * saying "PASSED" for it would manufacture confidence. When no expected
 * failure exists the guard is **ARMED** — the convention is declared and
 * unused — and it says so loudly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** A backlog id, as it must appear in an expected-failure test's name. */
const BACKLOG_ID = /\[(P[012]-\d+|[A-Z]{2,3})\]/;

/** Every test file in the workspace. */
function testFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git" || entry === "research") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(test|spec)\.[cm]?tsx?$/.test(entry)) out.push(full);
    }
  };
  walk(REPO_ROOT);
  return out.sort();
}

/** The expected-failure tests in a source file: their names. */
export function expectedFailures(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(/\b(?:it|test)\.fails\(\s*(['"`])([^'"`]+)\1/g)) {
    names.push(match[2]!);
  }
  return names;
}

/**
 * The files this guard scans.
 *
 * The guard's own file is **excluded**, and the reason is worth stating: a
 * guard that scans itself will find its own examples. This file contains
 * the pattern twice — once in the convention's doc comment and once inside
 * the mutation test's template literal — and both are illustrations, not
 * expectations.
 */
function scannedFiles(): string[] {
  const self = resolve(import.meta.filename);
  return testFiles().filter((file) => file !== self);
}

describe("the expected-failure convention", () => {
  const files = scannedFiles();

  it("has test files to scan — the guard is not vacuous", () => {
    expect(files.length, "no test files were found").toBeGreaterThan(5);
  });

  it("names a backlog id in every expected-failure test's name", () => {
    const unnamed: string[] = [];
    for (const file of files) {
      for (const name of expectedFailures(readFileSync(file, "utf8"))) {
        if (!BACKLOG_ID.test(name)) {
          unnamed.push(`${relative(REPO_ROOT, file)}: "${name}" — an expected failure must name its backlog id, e.g. "[P1-10]"`);
        }
      }
    }
    expect(unnamed, `these expected failures name no backlog id:\n${unnamed.join("\n")}`).toEqual([]);
  });

  it("is ARMED or PASSED, and says which", () => {
    // The trichotomy. When no expected failure exists, the convention is
    // declared and unused — which is ARMED, not PASSED, and saying
    // "PASSED" for it would manufacture confidence.
    const total = files.reduce((sum, file) => sum + expectedFailures(readFileSync(file, "utf8")).length, 0);
    if (total === 0) {
      console.info(
        "\nexpected-failure convention: ARMED — the convention is declared, and no test currently uses it.\n",
      );
    } else {
      console.info(`\nexpected-failure convention: PASSED — ${total} expected-failure test(s) in use.\n`);
    }
    expect(total).toBeGreaterThanOrEqual(0);
  });

  it("CAN fail — an expected failure without a backlog id is caught", () => {
    // The guard's own mutation test.
    const source = `
      it.fails("the thing is broken", () => { expect(1).toBe(2); });
      it.fails("the other thing is broken [P1-10]", () => { expect(1).toBe(2); });
    `;
    const names = expectedFailures(source);
    expect(names.length).toBe(2);
    const unnamed = names.filter((n) => !BACKLOG_ID.test(n));
    expect(unnamed, "the id-less expected failure must be caught").toEqual(["the thing is broken"]);
  });

  it("CAN fail — a plain failing test is NOT an expected failure", () => {
    // The distinction that matters: `it` is not `it.fails`. An ordinary
    // failing test is a real failure, not a declared expectation.
    const source = `
      it("the thing is broken", () => { expect(1).toBe(2); });
      it.skip("the other thing is broken", () => { expect(1).toBe(2); });
    `;
    expect(expectedFailures(source)).toEqual([]);
  });
});
