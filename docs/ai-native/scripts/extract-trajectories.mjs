#!/usr/bin/env node
/**
 * Layer A/B extraction only: repository artifacts → provenance-preserving
 * dataset-candidate records. Read-only tooling, not kernel code — same role
 * as `scripts/f10-bench.mjs` (measurement outside the kernel), not a new
 * authoritative store. No STORAGE_SUBDIRS entry, no frozen contract touched.
 *
 * ── What this deliberately does NOT do ──────────────────────────────────
 *
 * Emits `DATASET_CANDIDATE` records only. Never an SFT example, a DPO pair,
 * or a benchmark score — those are Layer C/D/E (a labeling policy, a trial
 * population, a training decision), none of which this repository has made.
 * `docs/PATTERNS.md`'s benchmarking deferral stands; this script does not
 * relitigate it. Every `epistemic_status` field is copied VERBATIM from the
 * source — an `[OPEN]` ledger entry stays `UNKNOWN` here, never promoted.
 *
 * ── Anti-vacuity property this script is built to satisfy ──────────────
 *
 * Property: every emitted record's provenance is real, not fabricated
 * structure that merely looks like provenance. Discriminating check: for
 * every record, `source_hash`/status token must be independently verifiable
 * by grepping the source at that exact location — proven by
 * `extract-trajectories.test.mjs`'s round-trip test, not merely asserted
 * here.
 *
 * Output is regenerated on demand, never committed as a static artifact —
 * committing it would risk the exact `CURRENT_STATE.md` staleness class this
 * repository already found and fixed once.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SCHEMA_VERSION = "1.0.0";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function currentHead() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

/**
 * ENGINEERING_LEDGER.md's `### <ID> — <title> · Severity: <sev>` entries,
 * each followed by `- **Field**: value` bullets. Regular and load-bearing
 * enough to parse without a markdown library (no new dependency).
 */
export function extractFailureTrajectories(ledgerText, sourceCommit) {
  const records = [];
  const entryRe = /^### (\S+) — (.+?) · Severity: (\S+)\n((?:- .+\n?)*)/gm;
  let match;
  while ((match = entryRe.exec(ledgerText)) !== null) {
    const [, id, title, severity, body] = match;
    const fields = {};
    for (const line of body.split("\n")) {
      const fieldMatch = line.match(/^- \*\*([^*]+)\*\*:\s*(.*)$/);
      if (fieldMatch) fields[fieldMatch[1].trim()] = fieldMatch[2].trim();
    }
    const statusMatch = (fields["Status"] ?? "").match(/`\[([^\]]+)\]`/);
    records.push({
      record_id: `ledger:${id}`,
      record_type: "failure_trajectory",
      schema_version: SCHEMA_VERSION,
      source_artifact: "ENGINEERING_LEDGER.md",
      source_commit: sourceCommit,
      task: title,
      symptom: fields["Root Cause Analysis"] ?? null,
      action: fields["Fix + Evidence"] ?? null,
      generalization: fields["Systemic Guardrail"] ?? null,
      // Verbatim from source, never inferred — an [OPEN]/[UNMAPPED] entry
      // must not be silently upgraded by this extraction step.
      epistemic_status: statusMatch ? statusMatch[1] : "UNKNOWN",
      label_basis: fields["Status"] ?? null,
      severity,
      extraction_method: "ENGINEERING_LEDGER.md ### entry parse",
    });
  }
  return records;
}

/**
 * Git commit history: goal/evidence/decision already in the message body by
 * this repository's own convention (every commit this session follows it).
 * `--no-merges` and a bounded `-n` keep this from becoming a full-repo scan
 * by default; pass `limit` for more.
 */
export function extractDecisionTrajectories(repoRoot, limit = 200) {
  const raw = execFileSync(
    "git",
    ["log", "--no-merges", `-n${limit}`, "--format=%H%x00%at%x00%B%x03"],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return raw
    .split("\x03")
    .map((chunk) => chunk.replace(/^\n/, ""))
    .filter((chunk) => chunk.trim().length > 0)
    .map((chunk) => {
      const [hash, epochSec, ...rest] = chunk.split("\x00");
      const body = rest.join("\x00").trim();
      const subject = body.split("\n")[0] ?? "";
      return {
        record_id: `commit:${hash}`,
        record_type: "decision_trajectory",
        schema_version: SCHEMA_VERSION,
        source_artifact: "git log",
        source_commit: hash,
        timestamp: new Date(Number(epochSec) * 1000).toISOString(),
        task: subject,
        context: body,
        // A commit's own existence is the only claim this record makes —
        // whether its contents were later reverted/superseded is not
        // resolved here (Layer B does not adjudicate; it links).
        epistemic_status: "DOCUMENTED",
        label_basis: "commit message, as written by its author",
        extraction_method: "git log --format",
      };
    });
}

/**
 * Test files whose own doc comments already spell out an anti-vacuity
 * construction (property / false implementation / discrimination), rather
 * than only implying it in code. Heuristic on purpose — a keyword match, not
 * a parser — false negatives (a real counterexample this misses) are safe;
 * false positives are checked by the same round-trip test as everything else.
 */
export function extractCounterexamples(testText, sourceArtifact, sourceCommit) {
  const records = [];
  const blockRe = /it\(\s*(["'`])((?:(?!\1).)*)\1\s*,\s*\(\)\s*=>\s*\{/g;
  const keywordRe = /anti-vacuity|false.?(implementation|verifier)|negatively tests|discriminat/i;
  let match;
  let index = 0;
  while ((match = blockRe.exec(testText)) !== null) {
    const description = match[2];
    // Look at ~40 lines of leading context (the block's own comment, if any)
    // plus the description itself for the anti-vacuity keyword shape.
    const before = testText.slice(Math.max(0, match.index - 1200), match.index);
    if (!keywordRe.test(description) && !keywordRe.test(before)) continue;
    index += 1;
    records.push({
      record_id: `test:${sourceArtifact}:${index}`,
      record_type: "counterexample",
      schema_version: SCHEMA_VERSION,
      source_artifact: sourceArtifact,
      source_commit: sourceCommit,
      task: description,
      epistemic_status: "OBSERVED", // the test exists and runs; whether it currently passes is not checked here
      label_basis: "test description + surrounding comment, as written",
      extraction_method: "keyword match over it() blocks (heuristic, not a parser)",
    });
  }
  return records;
}

export function extractAll(repoRoot = REPO_ROOT, { commitLimit = 200 } = {}) {
  const head = currentHead();
  const ledgerText = readFileSync(join(repoRoot, "ENGINEERING_LEDGER.md"), "utf8");
  const testFiles = [
    "packages/worker-runtime/src/log/crash-resilience.test.ts",
    "packages/worker-runtime/src/log/evidence-state.test.ts",
    "packages/worker-runtime/src/verify/verify-evidence.test.ts",
  ];

  const records = [
    ...extractFailureTrajectories(ledgerText, head),
    ...extractDecisionTrajectories(repoRoot, commitLimit),
    ...testFiles.flatMap((relPath) => {
      try {
        return extractCounterexamples(readFileSync(join(repoRoot, relPath), "utf8"), relPath, head);
      } catch (err) {
        if (err.code === "ENOENT") return []; // file moved/renamed; not fatal, just fewer records
        throw err;
      }
    }),
  ];

  return { schema_version: SCHEMA_VERSION, extracted_at_head: head, extracted_at: new Date().toISOString(), records };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(JSON.stringify(extractAll(), null, 2) + "\n");
}
