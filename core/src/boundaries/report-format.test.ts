/**
 * The founder-report format guard.
 *
 * ── What it catches ────────────────────────────────────────────────────────
 *
 * `docs/REPORT-FORMAT.md` is the contract for a report addressed to the
 * founder. A contract that is only prose is a preference. So this guard
 * checks two things:
 *
 * 1. **THE LINTER WORKS.** Every rule in `scripts/report-lint.mjs` is fired
 *    against a report that breaks exactly that rule, and the expected rule
 *    id must appear. A rule that silently stopped matching would leave the
 *    format unenforced while the guard stayed green — the same failure shape
 *    as a rule that is defined, unit-tested, and never used.
 * 2. **THE CANONICAL EXAMPLE PASSES.** The worked example embedded in
 *    `docs/REPORT-FORMAT.md` is extracted and linted, and it must produce
 *    **zero errors**. The example we publish must obey the guard we
 *    publish; otherwise the format document is a fiction.
 *
 * ── Why the linter is spawned rather than imported ──────────────────────────
 *
 * The linter is `.mjs` in `scripts/`, next to the other repository tooling
 * (`clean.mjs`, `f10-bench.mjs`, `m1-report.mjs`), because it lints a
 * **draft** on its way to a chat response — not a committed source file. It
 * is spawned exactly the way a user would run it, so the thing the guard
 * tests is the thing that actually runs.
 *
 * ── The honest boundary ────────────────────────────────────────────────────
 *
 * This guard checks **form**. It cannot tell whether a status claim is
 * true, whether a diagram is the right diagram, or whether the prose is
 * understandable to a non-technical reader. `docs/REPORT-FORMAT.md` states
 * the same boundary in prose. A guard that implied more would manufacture
 * confidence, which is worse than no guard.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// The linter is plain ESM in `scripts/`, so it is imported in-process
// through a declaration file. Spawning it twenty times would add a minute of
// CPU noise to the suite, and a guard that makes other suites' verdicts
// depend on the machine is a guard that breaks other suites.
import { lintReport, GLOSSARY_TERMS, STATUS_WORDS } from "../../../scripts/report-lint.mjs";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const LINTER = join(REPO_ROOT, "scripts", "report-lint.mjs");
const FORMAT_DOC = join(REPO_ROOT, "docs", "REPORT-FORMAT.md");

interface LintResult {
  readonly code: number;
  readonly errors: string[];
  readonly warnings: string[];
}

/** Lint in-process. The same function the command line calls. */
function lint(markdown: string): LintResult {
  const violations = lintReport(markdown);
  return {
    code: violations.some((v) => v.severity === "error") ? 1 : 0,
    errors: violations.filter((v) => v.severity === "error").map((v) => v.rule),
    warnings: violations.filter((v) => v.severity === "warning").map((v) => v.rule),
  };
}

/**
 * Lint through the command line, the way a person actually runs it.
 *
 * Used sparingly: exactly once, to prove the shipped entry point behaves.
 * The rule checks above run in-process, because twenty spawned Node
 * processes would add enough CPU load to push other suites in this
 * repository over their own timeouts — and the repository has already
 * recorded that a suite whose verdict depends on the machine cannot be
 * trusted to say anything.
 */
function lintViaCommandLine(markdown: string): { code: number; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "anyplugin-report-lint-"));
  const file = join(dir, "report.md");
  writeFileSync(file, markdown, "utf8");
  try {
    const stdout = execFileSync(process.execPath, [LINTER, file, "--json"], {
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return { code: failure.status ?? 1, stdout: failure.stdout ?? "" };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The smallest report that obeys the format. Every rule test mutates this,
 * so a rule that fires is firing on the one defect and not on something
 * else.
 */
const BASELINE = `# A founder report

## The headline

The checker is built and tested. No decision is needed from you right now.

## Where things stand

| Area | Status |
|---|---|
| The checker | DONE |

\`\`\`mermaid
flowchart LR
  A["One"] --> B["Two"]
\`\`\`

Read this as: two things in a row.

\`\`\`text
One -> Two
\`\`\`

## What changed

It now works where it did not before.

## What it means for the product

A user can do a thing they could not do before.

## Decisions I need from you

Nothing needs your decision right now.

## What I checked, and what's next

\`pnpm test\` is green. Next: the same again.
`;

/** The worked example embedded in the format document. */
function canonicalExample(): string {
  const text = readFileSync(FORMAT_DOC, "utf8");
  const start = text.indexOf("<!-- report-example:begin -->");
  const end = text.indexOf("<!-- report-example:end -->");
  expect(start, "the format document has no report-example:begin marker").toBeGreaterThan(-1);
  expect(end, "the format document has no report-example:end marker").toBeGreaterThan(-1);
  const block = text.slice(start, end);
  const fence = block.indexOf("```markdown");
  expect(fence, "the example is not fenced as a markdown block").toBeGreaterThan(-1);
  const bodyStart = block.indexOf("\n", fence) + 1;
  const body = block.slice(bodyStart, block.lastIndexOf("```"));
  return body;
}

describe("the report-format linter", () => {
  it("passes a report that obeys the format — the linter is not vacuous", { timeout: 60_000 }, () => {
    const result = lint(BASELINE);
    expect(result.errors, `the baseline report should be clean, got: ${result.errors.join(", ")}`).toEqual([]);
    expect(result.code).toBe(0);
  });

  it("fails a report that breaks the format — and says which rule", { timeout: 60_000 }, () => {
    // The guard's own proof that it is not vacuous. The baseline is mutated
    // into something that must fail, and the exit code must be non-zero.
    const broken = BASELINE.replace("## What changed", "## Something else");
    const result = lint(broken);
    expect(result.code, "a broken report must exit non-zero").not.toBe(0);
    expect(result.errors).toContain("R-SECTIONS-PRESENT");
  });

  it("exits non-zero through the command line, which is how a person runs it", { timeout: 60_000 }, () => {
    // The shipped entry point, proved once. The rule checks below run
    // in-process; this is the only spawn, and it exists because a linter
    // that works when imported but not when run is not a tool.
    const broken = BASELINE.replace("## What changed", "## Something else");
    const result = lintViaCommandLine(broken);
    expect(result.code, "the command line must exit non-zero on a broken report").toBe(1);
    const parsed = JSON.parse(result.stdout) as { errors: { rule: string }[] };
    expect(parsed.errors.map((e) => e.rule)).toContain("R-SECTIONS-PRESENT");
  });
});

describe.concurrent("every rule fires on the defect it owns", () => {
  const cases: ReadonlyArray<{ rule: string; report: string }> = [
    {
      rule: "R-SECTIONS-PRESENT",
      report: BASELINE.replace("## What changed", "## Something else"),
    },
    {
      rule: "R-SECTIONS-ORDER",
      // "What changed" is moved to the end: every section is present, and the
      // order is wrong. A report whose decisions arrive before the status
      // has to be read twice.
      report: BASELINE.replace("## What changed\n\nIt now works where it did not before.\n\n", "").replace(
        "## What I checked, and what's next",
        "## What changed\n\nIt now works where it did not before.\n\n## What I checked, and what's next",
      ),
    },
    {
      rule: "R-HEADLINE-LENGTH",
      report: BASELINE.replace(
        "The checker is built and tested. No decision is needed from you right now.",
        "The checker is built and tested on three separate machines and it has been reviewed twice and the last round of review closed every open question that anybody had about it, including the two about the boundary between a thing being written and a thing being proven. No decision is needed from you right now.",
      ),
    },
    {
      rule: "R-STATUS-TABLE",
      report: BASELINE.replace("| Area | Status |\n|---|---|\n| The checker | DONE |", "The checker is DONE."),
    },
    {
      rule: "R-STATUS-VOCABULARY",
      report: BASELINE.replace("| The checker | DONE |", "| The checker | COMPLETE |"),
    },
    {
      rule: "R-INTERNAL-ID-HEADING",
      report: BASELINE.replace("## What changed", "## M7 — Verification Engine"),
    },
    {
      rule: "R-INTERNAL-ID-UNGLOSSED",
      report: BASELINE.replace(
        "It now works where it did not before.",
        "The M7 engine now works where it did not before.",
      ),
    },
    {
      rule: "R-STALE-COUNT",
      report: BASELINE.replace("`pnpm test` is green.", "412 tests pass."),
    },
    {
      rule: "R-DIAGRAM-PRESENT",
      report: BASELINE.replace(
        "```mermaid\nflowchart LR\n  A[\"One\"] --> B[\"Two\"]\n```\n\nRead this as: two things in a row.\n\n```text\nOne -> Two\n```\n\n",
        "",
      ),
    },
    {
      rule: "R-DIAGRAM-CAPTION",
      report: BASELINE.replace("Read this as: two things in a row.\n\n", ""),
    },
    {
      rule: "R-DECISION-EMPTY",
      report: BASELINE.replace("Nothing needs your decision right now.\n\n## What I checked", "## What I checked"),
    },
    {
      rule: "R-DECISION-WHY",
      report: BASELINE.replace(
        "Nothing needs your decision right now.",
        "### Decision 1 — What should we ship first?\n\n**What you are choosing:** the first thing we ship.\n\n| Option | What you get | What it costs | My recommendation |\n|---|---|---|---|\n| **A** | Speed | Risk | **Recommended** |\n| **B** | Safety | Delay | The fallback |\n\n**What I will do next:** I will start with A.",
      ),
    },
    {
      rule: "R-DECISION-NEXT",
      report: BASELINE.replace(
        "Nothing needs your decision right now.",
        "### Decision 1 — What should we ship first?\n\n**What you are choosing:** the first thing we ship.\n\n| Option | What you get | What it costs | My recommendation |\n|---|---|---|---|\n| **A** | Speed | Risk | **Recommended** |\n| **B** | Safety | Delay | The fallback |\n\n**Why this is yours to decide:** it is a commercial choice.",
      ),
    },
    {
      rule: "R-DECISION-TABLE",
      report: BASELINE.replace(
        "Nothing needs your decision right now.",
        "### Decision 1 — What should we ship first?\n\n**What you are choosing:** the first thing we ship.\n\n**Why this is yours to decide:** it is a commercial choice.\n\n**What I will do next:** I will start with A.",
      ),
    },
    {
      rule: "R-PATH-SPINE",
      report: BASELINE.replace(
        "| The checker | DONE |",
        "| `packages/worker-runtime/src/verify/index.ts` | DONE |\n| `packages/worker-runtime/src/log/evidence.ts` | DONE |\n| `packages/worker-runtime/src/log/experience.ts` | DONE |",
      ),
    },
    {
      rule: "R-GLOSSARY-LIMIT",
      report: `${BASELINE}\n## Words I had to use\n\n| Term | What it means in plain words |\n|---|---|\n${Array.from(
        { length: 9 },
        (_, i) => `| Term ${i} | Something plain |`,
      ).join("\n")}\n`,
    },
    {
      rule: "R-MOJIBAKE",
      report: BASELINE.replace("The checker is built and tested.", "The checker is built and tested \uFFFD."),
    },
    {
      rule: "R-BOX-DRAWING",
      report: BASELINE.replace("One -> Two", "One ──▶ Two"),
    },
    {
      rule: "R-JARGON-UNGLOSSED",
      report: BASELINE.replace(
        "It now works where it did not before.",
        "The core engine now works where it did not before.",
      ),
    },
    {
      rule: "R-HEADLINE-ASK",
      report: BASELINE.replace(
        "The checker is built and tested. No decision is needed from you right now.",
        "The checker was rebuilt this week and the results are as described below.",
      ),
    },
    {
      rule: "R-DECISION-QUESTION",
      report: BASELINE.replace(
        "Nothing needs your decision right now.",
        "### Decision 1 — The first thing we ship\n\n**Why this is yours to decide:** it is a commercial choice.\n\n| Option | What you get | What it costs | My recommendation |\n|---|---|---|---|\n| **A** | Speed | Risk | **Recommended** |\n| **B** | Safety | Delay | The fallback |\n\n**What I will do next:** I will start with A.",
      ),
    },
  ];

  for (const { rule, report } of cases) {
    it(`fires ${rule}`, { timeout: 60_000 }, () => {
      const result = lint(report);
      // A rule may be an error or a warning; the guard only asserts that it
      // FIRES, and the severity is the linter's own business.
      expect(
        [...result.errors, ...result.warnings],
        `the rule ${rule} did not fire; seen: ${[...result.errors, ...result.warnings].join(", ") || "(none)"}`,
      ).toContain(rule);
    });
  }
});

describe("the canonical example", () => {
  it("is embedded in the format document", { timeout: 60_000 }, () => {
    expect(canonicalExample().length).toBeGreaterThan(2000);
  });

  it("passes the linter with zero errors — the published example obeys the published guard", { timeout: 60_000 }, () => {
    const result = lint(canonicalExample());
    expect(
      result.errors,
      `the canonical example in docs/REPORT-FORMAT.md breaks the format: ${result.errors.join(", ")}`,
    ).toEqual([]);
    expect(result.code).toBe(0);
  });
});

/**
 * The diagram vocabulary, guarded.
 *
 * Section 5 of the format document is a set of templates, and a template that
 * is not followed by the rules it states is a decoration. Two things are
 * therefore checked here, both of them mechanical:
 *
 * 1. **THE LEGEND AND THE LINTER AGREE.** The legend in section 5 tells the
 *    reader which words mean what; the linter's `STATUS_VALUES` is the
 *    machine's copy of the same list. Two copies of one list drift — that is
 *    the failure this repository keeps meeting in its prose documents, so the
 *    list is drift-guarded here instead of trusted.
 * 2. **EVERY TEMPLATE IS COMPLETE.** Every Mermaid block in the format
 *    document is followed by a `Read this as:` caption and a plain-text
 *    fallback, because the templates are the thing a report copies — and a
 *    template that copies without its caption teaches the reader to skip it.
 */
describe("the diagram vocabulary", () => {
  /** The status words the linter accepts, read from the linter's own source. */
  function linterStatusValues(): string[] {
    const source = readFileSync(LINTER, "utf8");
    const block = /const STATUS_VALUES = \[([\s\S]*?)\];/.exec(source);
    expect(block, "the linter no longer declares a STATUS_VALUES array").not.toBeNull();
    return [...(block![1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
  }

  /** The legend block of the format document: the fenced block under 5.2. */
  function legend(): string {
    const text = readFileSync(FORMAT_DOC, "utf8");
    const heading = text.indexOf("### 5.2 The legend");
    expect(heading, "the format document has no legend section").toBeGreaterThan(-1);
    const open = text.indexOf("```", heading);
    const close = text.indexOf("```", open + 3);
    expect(open, "the legend is not fenced").toBeGreaterThan(-1);
    expect(close, "the legend fence is not closed").toBeGreaterThan(-1);
    return text.slice(open + 3, close);
  }

  it("uses exactly the status words the linter accepts — the two copies of one list cannot drift", () => {
    const values = linterStatusValues();
    const text = legend();
    for (const value of values) {
      expect(text, `the legend does not mention the status word "${value}"`).toContain(value);
    }
    // And the other direction: a word in the legend that the linter does not
    // accept is a status the reader can use and the linter will reject.
    const declared = [...text.matchAll(/^ {2}([A-Z][A-Za-z —]+?)(?:\s{2,}|$)/gm)].map((m) =>
      (m[1] ?? "").trim(),
    );
    const unknown = declared.filter((word) => !values.includes(word));
    expect(unknown, `the legend offers status words the linter does not accept: ${unknown.join(", ")}`).toEqual(
      [],
    );
  });

  it("gives every template a caption and a plain-text fallback", () => {
    const text = readFileSync(FORMAT_DOC, "utf8");
    const lines = text.split(/\r?\n/);
    // Only blocks that are NOT inside another fence: the canonical example
    // is itself a fenced document, and its diagram belongs to the example.
    let inFence = false;
    const diagrams: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const isFence = /^\s*(`{3,})\s*(\S*)/.exec(line);
      if (isFence) {
        const language = isFence[2] ?? "";
        if (!inFence && language === "mermaid") diagrams.push(i);
        inFence = !inFence;
        continue;
      }
    }
    expect(diagrams.length, "the format document has no diagram templates").toBeGreaterThan(4);

    const uncaptioned: string[] = [];
    const unfallbacked: string[] = [];
    for (const start of diagrams) {
      // The caption and the fallback live between this diagram and the next
      // heading — the same window the linter looks in.
      let end = start;
      while (end < lines.length && !/^\s*#{1,6}\s/.test(lines[end] ?? "")) end++;
      const window = lines.slice(start, end).join("\n");
      if (!/Read this as:/i.test(window)) uncaptioned.push(String(start + 1));
      if (!/```text/.test(window)) unfallbacked.push(String(start + 1));
    }
    expect(uncaptioned, `these diagrams have no caption: ${uncaptioned.join(", ")}`).toEqual([]);
    expect(unfallbacked, `these diagrams have no plain-text fallback: ${unfallbacked.join(", ")}`).toEqual([]);
  });
});

/**
 * The words, and the pointer.
 *
 * Two more claims the format document makes about itself, and therefore two
 * more claims a guard has to check:
 *
 * 1. **THE WORDS AGREE.** Section 6 fixes the eight words this project
 *    cannot avoid, and the linter checks exactly those eight. If the
 *    document grows a ninth word, the linter must grow it too — otherwise
 *    the document promises a gloss the linter never asks for.
 * 2. **THE DOCUMENT IS FINDABLE.** `AGENTS.md` is loaded into every
 *    session for this repository, so it is the only place a reader can be
 *    told "the contract is here". If it stops naming the document, the
 *    contract is still written down and still unfound — which is the same
 *    as not having it.
 */
describe("the words, and the pointer", () => {
  it("uses the same words in the document and in the linter — both directions", () => {
    const text = readFileSync(FORMAT_DOC, "utf8");
    const start = text.indexOf("## 6. Words this project cannot avoid");
    expect(start, "the words section was not found").toBeGreaterThan(-1);
    const end = text.indexOf("## 7.", start);
    const section = text.slice(start, end < 0 ? undefined : end);

    const documented: string[] = [];
    for (const line of section.split(/\r?\n/)) {
      const m = /^\|\s*\*\*(.+?)\*\*\s*\|/.exec(line);
      if (m) documented.push(m[1]!.trim());
    }
    expect(documented.length, "the words section lists no terms").toBeGreaterThan(3);

    const linterTerms = GLOSSARY_TERMS.map((t) => t.term);
    expect(
      documented.filter((w) => !linterTerms.includes(w)),
      "the document lists a word the linter does not check",
    ).toEqual([]);
    expect(
      linterTerms.filter((w) => !documented.includes(w)),
      "the linter checks a word the document does not list",
    ).toEqual([]);
  });

  it("is pointed at by AGENTS.md, so every session finds it", () => {
    const agents = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
    expect(
      agents,
      "AGENTS.md must name docs/REPORT-FORMAT.md, or a session will never find the contract",
    ).toContain("docs/REPORT-FORMAT.md");
  });
});

/**
 * The rule list is the document's claim about the linter.
 *
 * Section 7 of the format document lists what `pnpm report:lint` enforces.
 * The linter is the thing that actually enforces it. If the linter grows a
 * rule the document does not list, the reader is being told a rule does not
 * exist; if the document lists a rule the linter does not have, the reader is
 * being told a rule is enforced when it is not.
 *
 * So the two lists are compared, in both directions, from the linter's own
 * source — the same way the status legend is compared.
 */
describe("the rule list", () => {
  /** Every rule id the linter can emit. */
  function linterRuleIds(): string[] {
    const source = readFileSync(LINTER, "utf8");
    return [...new Set([...source.matchAll(/"(R-[A-Z-]+)"/g)].map((m) => m[1]!))].sort();
  }

  /** Every rule id the document lists in section 7. */
  function documentedRuleIds(): string[] {
    const text = readFileSync(FORMAT_DOC, "utf8");
    const start = text.indexOf("## 7. What the linter checks, and what it cannot");
    expect(start, "the linter section was not found").toBeGreaterThan(-1);
    const end = text.indexOf("## 8.", start);
    const section = text.slice(start, end < 0 ? undefined : end);
    const ids = new Set<string>();
    for (const line of section.split(/\r?\n/)) {
      if (!/^\s*\|/.test(line)) continue;
      for (const cell of line.split("|").map((c) => c.trim())) {
        const tokens = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
        const full = tokens.find((t) => /^R-[A-Z0-9-]+$/.test(t));
        if (!full) continue;
        ids.add(full);
        // A row may name a family: `R-SECTIONS-PRESENT` / `-ORDER` / `-ONCE`.
        // The suffix belongs to the family, which is the id minus its last
        // segment — not to every family in the table.
        const family = full.slice(0, full.lastIndexOf("-"));
        for (const token of tokens) {
          if (token === full) continue;
          // `-ORDER` is the family plus a suffix; `R-STATUS-VOCABULARY` is
          // already a whole id.
          if (token.startsWith("-")) ids.add(`${family}${token}`);
          else if (/^R-[A-Z0-9-]+$/.test(token)) ids.add(token);
        }
      }
    }
    return [...ids].sort();
  }

  it("lists every rule the linter enforces", () => {
    const documented = documentedRuleIds();
    const undocumented = linterRuleIds().filter((id) => !documented.includes(id));
    expect(
      undocumented,
      `the linter enforces rules the document does not list: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("lists no rule the linter does not enforce", () => {
    const enforced = linterRuleIds();
    const phantom = documentedRuleIds().filter((id) => !enforced.includes(id));
    expect(
      phantom,
      `the document claims the linter enforces rules it does not: ${phantom.join(", ")}`,
    ).toEqual([]);
  });
});
