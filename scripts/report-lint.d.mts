/**
 * Type declarations for `scripts/report-lint.mjs`.
 *
 * The linter is plain ESM in `scripts/`, beside the other repository tooling
 * (`clean.mjs`, `f10-bench.mjs`, `m1-report.mjs`), because it lints a
 * **draft** on its way to a chat response rather than a committed source
 * file. It is not part of any TypeScript project, so this declaration is
 * what lets `core/src/boundaries/report-format.test.ts` import the real
 * implementation in-process instead of spawning twenty Node processes — a
 * guard that adds a minute of CPU noise to the suite is a guard that makes
 * other suites' verdicts depend on the machine.
 *
 * There is exactly ONE implementation. This file declares it; it does not
 * restate it.
 */

export interface ReportViolation {
  /** The rule id, e.g. `R-SECTIONS-ORDER`. Stable, and what the guard asserts on. */
  readonly rule: string;
  /** `error` fails the lint; `warning` is printed and does not. */
  readonly severity: "error" | "warning";
  /** What is wrong, in one sentence. */
  readonly message: string;
  /** The 1-based line, or 0 when the violation is about the document as a whole. */
  readonly line: number;
}

/** Lint a founder report against `docs/REPORT-FORMAT.md`. */
export declare function lintReport(markdown: string): ReportViolation[];

/**
 * The closed status vocabulary, in the order the legend lists it.
 *
 * Exported so the guard can compare it with the legend in
 * `docs/REPORT-FORMAT.md` in **both** directions: every legend word must be
 * here, and every word here must be in the legend. A document and a linter
 * that drift apart is two contracts, and the reader only knows one.
 */
export declare const STATUS_WORDS: readonly string[];

/** One entry of the project's closed vocabulary. */
export interface GlossaryTerm {
  /** The term as `docs/REPORT-FORMAT.md` writes it. */
  readonly term: string;
  /** What the linter looks for in prose — sometimes the article is dropped. */
  readonly match: string;
  /** The canonical plain-language meaning. */
  readonly gloss: string;
}

/**
 * The project's eight unavoidable words.
 *
 * Exported for the same reason as {@link STATUS_WORDS}: the guard compares
 * this list with the "Words this project cannot avoid" table in the
 * document, in both directions.
 */
export declare const GLOSSARY_TERMS: readonly GlossaryTerm[];
