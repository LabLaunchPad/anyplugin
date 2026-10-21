#!/usr/bin/env node
/**
 * The founder-report linter.
 *
 * ── What it is for ───────────────────────────────────────────────────────────
 *
 * `docs/REPORT-FORMAT.md` states how a report addressed to the founder must
 * look. A stated rule that nobody checks is a preference. This is the check:
 * a report is written, linted, and the violations are fixed before it is
 * sent. The model does not have to *remember* the format; the linter tells
 * it.
 *
 * Usage:
 *   node scripts/report-lint.mjs <file.md> [--json]
 *
 * Exit codes:
 *   0  no errors (warnings may still be printed)
 *   1  at least one error
 *   2  the file could not be read
 *
 * ── Why it is a script and not a test ────────────────────────────────────────
 *
 * Because the thing being linted is **a chat response**, not a source file.
 * A vitest guard can only check what is committed to the repository; this
 * runs against a draft on its way out. The companion guard
 * (`core/src/boundaries/report-format.test.ts`) checks the linter itself and
 * the canonical example, so the tool cannot rot into a no-op.
 *
 * ── The honest boundary ──────────────────────────────────────────────────────
 *
 * This linter checks **form**, never **truth and never comprehension**. It
 * cannot tell whether a status claim is accurate, whether a diagram is a good
 * diagram, or whether the prose is actually understandable to a
 * non-technical founder. Those are review, not mechanics, and this file
 * does not pretend otherwise. `docs/REPORT-FORMAT.md` says so too.
 */
import { readFileSync } from "node:fs";

/* ── the vocabulary ───────────────────────────────────────────────────────── */

/** The report skeleton. Order is checked; the glossary section is optional. */
const REQUIRED_SECTIONS = [
  "The headline",
  "Where things stand",
  "What changed",
  "What it means for the product",
  "Decisions I need from you",
  "What I checked, and what's next",
];

const OPTIONAL_SECTIONS = ["Words I had to use"];

/**
 * The closed status vocabulary. A status outside this list is not a status.
 *
 * Six values, because the report column has to carry two things at once:
 * **how far along** something is, and **whether it is proven**. Collapsing
 * them is how "built" ends up reading as "working".
 *
 * Declared as a literal array on purpose: the guard in
 * `core/src/boundaries/report-format.test.ts` compares this list against the
 * legend in `docs/REPORT-FORMAT.md`, and a literal is what it reads.
 */
const STATUS_VALUES = [
  "DONE",
  "BUILT — NOT YET VERIFIED",
  "IN PROGRESS",
  "NOT STARTED",
  "BLOCKED — waiting on you",
  "BLOCKED — waiting on something else",
];

/**
 * The status vocabulary, exported so a guard can compare it with the
 * legend in `docs/REPORT-FORMAT.md` in both directions.
 */
export const STATUS_WORDS = STATUS_VALUES;

/**
 * The project's closed vocabulary.
 *
 * These eight are the words this repository cannot avoid, and they are the
 * words a report has to explain. The list is the **same list** as the
 * "Words this project cannot avoid" table in `docs/REPORT-FORMAT.md` — and
 * the guard checks that the two agree, in both directions, so the document
 * and the linter cannot drift apart.
 *
 * `term` is what the document says; `match` is what the linter looks for in
 * prose (sometimes the report drops the article); `gloss` is the canonical
 * plain-language meaning.
 */
export const GLOSSARY_TERMS = [
  {
    term: "the core engine",
    match: "core engine",
    gloss: "the part of the system that survives the agent — it records, decides, and verifies",
  },
  {
    term: "the record",
    match: "the record",
    gloss: "the append-only log of everything that happened; the only authority",
  },
  {
    term: "a view",
    match: "a view",
    gloss: "something computed from the record; never an authority itself",
  },
  {
    term: "the cascade",
    match: "the cascade",
    gloss: "what gets marked out-of-date when the evidence beneath it changes",
  },
  {
    term: "the ladder",
    match: "the ladder",
    gloss: "how much confidence a lesson is allowed to carry",
  },
  {
    term: "capability matrix",
    match: "capability matrix",
    gloss: "what each agent platform can actually do",
  },
  {
    term: "journal",
    match: "journal",
    gloss: "the record of what an install changed, so an uninstall can undo it exactly",
  },
  {
    term: "certificate",
    match: "certificate",
    gloss: "a signature over finished work and everything it rests on",
  },
];

/**
 * Internal tracking ids. They are navigation aids for the team, and they are
 * meaningless to the reader — so they may only ever appear **in
 * parentheses, after a plain-language phrase**.
 */
const INTERNAL_ID = /\b(M\d{1,2}[a-z]?|P[012]-\d{1,2}|D-\d{3}|AP-\d{3}|PM-\d{3}|U\d{1,2}|F\d{1,2}|I\d{1,2}|L\d{1,2})\b/g;

/** A count that goes stale. The house rule: never quote it in prose. */
const STALE_COUNT = /\b\d{1,4}\s+(tests?|test files?|specs?|assertions?|test cases?)\b/i;

/** The glossary box holds at most this many entries. */
const GLOSSARY_LIMIT = 8;

/** The headline is a headline. */
const HEADLINE_MAX_SENTENCES = 2;
const HEADLINE_MAX_WORDS = 45;

/* ── the checker ──────────────────────────────────────────────────────────── */

/**
 * @typedef {{ rule: string, severity: "error" | "warning", message: string, line: number }} Violation
 */

/**
 * Split the report into lines and record which lines are inside a fenced
 * block. Fenced content is *code*, not prose, and a rule about prose must
 * not fire on a sample.
 */
function parseLines(markdown) {
  const lines = markdown.split(/\r?\n/);
  const inFence = new Array(lines.length).fill(false);
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (m) {
      if (fence === null) {
        fence = { marker: m[2][0], length: m[2].length, lang: m[3].trim() };
        inFence[i] = true;
        continue;
      }
      if (m[2][0] === fence.marker && m[2].length >= fence.length && m[3].trim() === "") {
        fence = null;
        inFence[i] = true;
        continue;
      }
    }
    inFence[i] = fence !== null;
  }
  return { lines, inFence };
}

/** The report with every fenced block removed — prose only. */
function proseOnly(markdown, inFence, lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) if (!inFence[i]) out.push(lines[i]);
  return out.join("\n");
}

/** Level-2 headings, with the line they start on. */
function sectionHeadings(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^##\s+(.+?)\s*$/.exec(lines[i]);
    if (m) out.push({ title: m[1].trim(), line: i });
  }
  return out;
}

/** The body of a level-2 section: from its heading to the next level-2 heading. */
function sectionBody(lines, heading) {
  const headings = sectionHeadings(lines);
  const next = headings.find((h) => h.line > heading.line);
  const end = next ? next.line : lines.length;
  return lines.slice(heading.line + 1, end).join("\n");
}

/** The line range of every level-2 section: { title, line, end }. */
function sectionRanges(lines) {
  const headings = sectionHeadings(lines);
  return headings.map((h, i) => ({
    ...h,
    end: i + 1 < headings.length ? headings[i + 1].line : lines.length,
  }));
}

/** The level-3 headings inside a level-2 section. */
function subsectionsIn(lines, range) {
  const out = [];
  for (let i = range.line + 1; i < range.end; i++) {
    const m = /^###\s+(.+?)\s*$/.exec(lines[i]);
    if (m) out.push({ title: m[1].trim(), line: i });
  }
  return out;
}

/** Every markdown table in the text, as { header: string[], rows: string[][] }. */
function tables(markdown) {
  const out = [];
  const lines = markdown.split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    const isRow = /^\s*\|.*\|\s*$/.test(line);
    if (!isRow) {
      if (current) out.push(current);
      current = null;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (current === null) {
      current = { header: cells, rows: [] };
    } else if (cells.every((c) => /^:?-{2,}:?$/.test(c))) {
      // the delimiter row: it confirms a table, it is not a row
    } else {
      current.rows.push(cells);
    }
  }
  if (current) out.push(current);
  return out;
}

/** Does this cell look like a source path rather than an explanation? */
function looksLikePath(cell) {
  const c = cell.replace(/`/g, "").trim();
  if (!c.includes("/")) return false;
  if (/\s/.test(c)) return false;
  return /^[\w.\-/{}:]+$/.test(c);
}

/** Is the report's prose free of the replacement character? */
function hasMojibake(markdown) {
  return markdown.includes("\uFFFD");
}

/**
 * Is this internal id inside a parenthetical that contains **only** internal
 * ids?
 *
 * The rule is "an id may appear in parentheses after a plain-language
 * phrase". A group like `(M3, M4, M7)` satisfies that — it is still a
 * gloss, not a spine. A group like `(see the M3 row)` does not, because the
 * parenthesis is carrying the sentence rather than the id.
 */
function isInsideIdGroup(line, index, id) {
  const before = line.slice(0, index);
  const after = line.slice(index + id.length);
  const open = before.lastIndexOf("(");
  if (open < 0) return false;
  const close = after.indexOf(")");
  if (close < 0) return false;
  const inner = `${before.slice(open + 1)}${id}${after.slice(0, close)}`;
  const residue = inner
    .replace(INTERNAL_ID, "")
    .replace(/[,\s]/g, "")
    .replace(/\b(?:and|or)\b/gi, "");
  return residue === "";
}

/**
 * Lint a founder report.
 *
 * @param {string} markdown
 * @returns {Violation[]}
 */
export function lintReport(markdown) {
  /** @type {Violation[]} */
  const violations = [];
  const add = (rule, severity, message, line = 0) => violations.push({ rule, severity, message, line });

  const { lines, inFence } = parseLines(markdown);
  const prose = proseOnly(markdown, inFence, lines);

  /* 1. Mojibake. A broken character is a broken document. */
  if (hasMojibake(markdown)) {
    add("R-MOJIBAKE", "error", "the report contains a replacement character (U+FFFD) — the text is corrupted");
  }

  /* 2. The skeleton. */
  const headings = sectionHeadings(lines);
  const titles = headings.map((h) => h.title);
  const found = [];
  for (const required of REQUIRED_SECTIONS) {
    const idx = titles.indexOf(required);
    if (idx < 0) {
      add("R-SECTIONS-PRESENT", "error", `the report is missing the required section "## ${required}"`);
      continue;
    }
    found.push({ required, idx });
  }
  for (let i = 1; i < found.length; i++) {
    if (found[i].idx < found[i - 1].idx) {
      add(
        "R-SECTIONS-ORDER",
        "error",
        `"## ${found[i].required}" appears before "## ${found[i - 1].required}" — the sections are out of order`,
      );
    }
  }
  for (const optional of OPTIONAL_SECTIONS) {
    const count = titles.filter((t) => t === optional).length;
    if (count > 1) add("R-SECTIONS-ONCE", "error", `"## ${optional}" appears ${count} times`);
  }

  /* 3. The headline. */
  const headline = headings.find((h) => h.title === "The headline");
  if (headline) {
    const body = sectionBody(lines, headline).trim();
    // A standalone dash is punctuation, not a word.
    const words = body.split(/\s+/).filter((w) => w.length > 0 && /[\p{L}\p{N}]/u.test(w));
    const sentences = body.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim().length > 0);
    if (words.length > HEADLINE_MAX_WORDS) {
      add(
        "R-HEADLINE-LENGTH",
        "error",
        `the headline is ${words.length} words; it must be at most ${HEADLINE_MAX_WORDS} — the reader has 90 seconds`,
        headline.line + 1,
      );
    }
    if (sentences.length > HEADLINE_MAX_SENTENCES) {
      add(
        "R-HEADLINE-LENGTH",
        "error",
        `the headline is ${sentences.length} sentences; it must be at most ${HEADLINE_MAX_SENTENCES}`,
        headline.line + 1,
      );
    }
    if (body.length > 0 && !/\b(you|your|decide|decision|need|needs|asked)\b/i.test(body)) {
      add(
        "R-HEADLINE-ASK",
        "warning",
        "the headline does not say what the reader needs to do — name the ask, or say that nothing is needed",
        headline.line + 1,
      );
    }
  }

  /* 4. The status board: a table, with the closed vocabulary. */
  const board = headings.find((h) => h.title === "Where things stand");
  if (board) {
    const body = sectionBody(lines, board);
    const boardTables = tables(body);
    const withStatus = boardTables.find((t) => t.header.some((c) => /^status$/i.test(c.trim())));
    if (!withStatus) {
      add(
        "R-STATUS-TABLE",
        "error",
        '"## Where things stand" has no table with a "Status" column — the reader needs a status board',
        board.line + 1,
      );
    } else {
      const col = withStatus.header.findIndex((c) => /^status$/i.test(c.trim()));
      for (const row of withStatus.rows) {
        const cell = (row[col] ?? "").trim();
        if (!cell) continue;
        const ok = STATUS_VALUES.some((v) => cell === v || cell.startsWith(`${v} `));
        if (!ok) {
          add(
            "R-STATUS-VOCABULARY",
            "error",
            `"${cell}" is not one of: ${STATUS_VALUES.join(" / ")}`,
            board.line + 1,
          );
        }
      }
    }
  }

  /* 5. Internal ids: parentheses only, never a heading, never alone. */
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inFence[i]) continue;
    const isHeading = /^\s*#{1,6}\s/.test(line);
    for (const match of line.matchAll(INTERNAL_ID)) {
      const id = match[0];
      const parenthesised = isInsideIdGroup(line, match.index, id);
      if (isHeading) {
        add(
          "R-INTERNAL-ID-HEADING",
          "error",
          `the internal id "${id}" is in a heading — a heading must be understandable without it`,
          i + 1,
        );
      } else if (!parenthesised) {
        add(
          "R-INTERNAL-ID-UNGLOSSED",
          "error",
          `the internal id "${id}" is used without a plain-language phrase — write it as "the thing it names (${id})"`,
          i + 1,
        );
      }
    }
  }

  /* 6. A table of file paths is not evidence a founder can read. */
  for (const table of tables(prose)) {
    if (table.rows.length < 3) continue;
    const pathish = table.rows.filter((r) => looksLikePath(r[0] ?? "")).length;
    if (pathish / table.rows.length >= 0.6) {
      add(
        "R-PATH-SPINE",
        "error",
        "a table's first column is mostly file paths — explain what each part does instead of naming it",
      );
    }
  }

  /* 7. A count that goes stale. */
  for (let i = 0; i < lines.length; i++) {
    if (inFence[i]) continue;
    const m = STALE_COUNT.exec(lines[i]);
    if (m) {
      add(
        "R-STALE-COUNT",
        "error",
        `"${m[0]}" is a count that goes stale — say "pnpm test is green" instead of a number`,
        i + 1,
      );
    }
  }

  /* 8. A diagram: rendered, captioned, and with a plain-text fallback. */
  let mermaidCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*```mermaid\s*$/.exec(lines[i]);
    if (!m) continue;
    mermaidCount++;
    // find the closing fence
    let close = i + 1;
    while (close < lines.length && !/^\s*```\s*$/.test(lines[close])) close++;
    // the tail: everything after the diagram up to the next heading, including
    // the plain-text fallback block that follows the caption
    let tail = "";
    let sawFallback = false;
    for (let j = close + 1; j < lines.length; j++) {
      if (/^\s*#{1,6}\s/.test(lines[j])) break;
      tail += `${lines[j]}\n`;
      if (/```text/.test(lines[j])) sawFallback = true;
      if (sawFallback && /^\s*```\s*$/.test(lines[j])) break;
    }
    if (!/Read this as:/i.test(tail)) {
      add(
        "R-DIAGRAM-CAPTION",
        "error",
        "a diagram has no caption — add a line that starts with \"Read this as:\"",
        i + 1,
      );
    }
    if (!/```text/.test(tail)) {
      add(
        "R-DIAGRAM-FALLBACK",
        "warning",
        "a diagram has no plain-text fallback — add a ```text block for viewers that do not render Mermaid",
        i + 1,
      );
    }
  }
  if (mermaidCount === 0) {
    add("R-DIAGRAM-PRESENT", "error", "the report has no diagram — a rendered Mermaid block is required");
  }

  /* 9. Box-drawing characters. A diagram drawn in a fixed-width font
     misaligns in every proportional font and in every terminal that wraps,
     so a fallback is arrows and indentation, never boxes. */
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```/.test(lines[i])) continue;
    let close = i + 1;
    while (close < lines.length && !/^\s*```/.test(lines[close])) close++;
    const body = lines.slice(i + 1, close).join("\n");
    const box = body.match(/[─-╿▀-▟]/);
    if (box) {
      const code = box[0].codePointAt(0).toString(16).toUpperCase();
      add(
        "R-BOX-DRAWING",
        "warning",
        `a code block draws boxes with "${box[0]}" (U+${code}) — a plain-text fallback is arrows and indentation, never boxes`,
        i + 1,
      );
    }
  }

  /* 10. The decision blocks. */
  const decisions = headings.find((h) => h.title === "Decisions I need from you");
  if (decisions) {
    const range = sectionRanges(lines).find((r) => r.line === decisions.line);
    const body = sectionBody(lines, decisions);
    const decisionHeadings = range ? subsectionsIn(lines, range) : [];
    if (decisionHeadings.length === 0 && !/nothing (needs|requires) your decision/i.test(body)) {
      add(
        "R-DECISION-EMPTY",
        "error",
        'the decision section is empty — write "Nothing needs your decision right now." or add a decision block',
        decisions.line + 1,
      );
    }
    for (let k = 0; k < decisionHeadings.length; k++) {
      const d = decisionHeadings[k];
      const next = decisionHeadings[k + 1];
      const end = next ? next.line : range.end;
      const block = lines.slice(d.line + 1, end).join("\n");
      const found2 = tables(block);
      const shaped = found2.find((t) =>
        ["option", "what you get", "what it costs", "my recommendation"].every((need) =>
          t.header.some((c) => c.trim().toLowerCase() === need),
        ),
      );
      if (!shaped) {
        add(
          "R-DECISION-TABLE",
          "error",
          `the decision "${d.title}" has no options table with the columns: Option | What you get | What it costs | My recommendation`,
          d.line + 1,
        );
      } else if (shaped.rows.length < 2) {
        add("R-DECISION-TABLE", "error", `the decision "${d.title}" offers fewer than two options`, d.line + 1);
      }
      if (!/\*\*Why this is yours to decide:?\*\*/.test(block)) {
        add(
          "R-DECISION-WHY",
          "error",
          `the decision "${d.title}" does not say why it is the founder's to make`,
          d.line + 1,
        );
      }
      if (!/\*\*What I will do next:?\*\*/.test(block)) {
        add(
          "R-DECISION-NEXT",
          "error",
          `the decision "${d.title}" does not say what happens next`,
          d.line + 1,
        );
      }
      if (!/\?\s*$/.test(d.title)) {
        add(
          "R-DECISION-QUESTION",
          "warning",
          `the decision heading "${d.title}" is not a question`,
          d.line + 1,
        );
      }
    }
  }

  /* 11. The glossary box. */
  const glossary = headings.find((h) => h.title === "Words I had to use");
  if (glossary) {
    const body = sectionBody(lines, glossary);
    for (const table of tables(body)) {
      if (table.rows.length > GLOSSARY_LIMIT) {
        add(
          "R-GLOSSARY-LIMIT",
          "error",
          `the glossary has ${table.rows.length} entries; the limit is ${GLOSSARY_LIMIT} — rewrite the report instead of footnoting it`,
          glossary.line + 1,
        );
      }
    }
  }

  /* 12. Jargon on first use. */
  const glossaryBody = glossary ? sectionBody(lines, glossary) : "";
  for (const { term, match, gloss } of GLOSSARY_TERMS) {
    const escaped = match.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`, "i");
    const body = prose.replace(glossaryBody, "");
    const m = re.exec(body);
    if (!m) continue;
    const window = body.slice(m.index, m.index + 220);
    const paren = /\(([^)]*)\)/.exec(window);
    const glossed = paren !== null && paren[1].trim().split(/\s+/).length >= 3;
    const inGlossary = new RegExp(`\\b${escaped}\\b`, "i").test(glossaryBody);
    if (!glossed && !inGlossary) {
      add(
        "R-JARGON-UNGLOSSED",
        "warning",
        `"${term}" is used without a plain-language gloss — either expand it in place or add it to the glossary box (suggested gloss: "${gloss}")`,
      );
    }
  }

  return violations;
}

/* ── the command ──────────────────────────────────────────────────────────── */

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args.includes("--help")) {
    console.log("usage: node scripts/report-lint.mjs <file.md> [--json]");
    console.log("");
    console.log("Lints a founder report against docs/REPORT-FORMAT.md.");
    console.log("Exit 0 = no errors, 1 = errors found, 2 = file unreadable.");
    process.exit(args.length === 0 ? 2 : 0);
  }
  const json = args.includes("--json");
  const file = args.find((a) => !a.startsWith("--"));
  let markdown;
  try {
    markdown = readFileSync(file, "utf8");
  } catch (error) {
    console.error(`cannot read ${file}: ${error.message}`);
    process.exit(2);
  }
  const violations = lintReport(markdown);
  const errors = violations.filter((v) => v.severity === "error");
  const warnings = violations.filter((v) => v.severity === "warning");
  if (json) {
    console.log(JSON.stringify({ file, errors, warnings }, null, 2));
  } else {
    for (const v of violations) {
      const where = v.line ? ` (line ${v.line})` : "";
      console.log(`${v.severity === "error" ? "ERROR" : "WARN "} ${v.rule}${where}: ${v.message}`);
    }
    console.log("");
    console.log(`${errors.length} error(s), ${warnings.length} warning(s).`);
  }
  process.exit(errors.length > 0 ? 1 : 0);
}

const invokedDirectly =
  typeof process !== "undefined" && process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/report-lint.mjs");
if (invokedDirectly) main(process.argv);
