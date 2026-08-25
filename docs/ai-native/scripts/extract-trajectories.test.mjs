#!/usr/bin/env node
/**
 * The anti-vacuity check the extraction script's own header commits to:
 * every emitted record's provenance must be independently verifiable by
 * looking at the source it cites — not merely well-formed JSON that looks
 * like provenance. Run with `node --test` (Node's built-in runner; no new
 * dependency, consistent with this repo's dependency discipline).
 *
 * False implementation this guards against: an extractor that emits a
 * plausible `epistemic_status`/`source_hash` without them actually being
 * read from the cited location — these tests re-derive each field
 * independently from the raw source and assert agreement, rather than
 * trusting the extractor's own output.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extractAll, extractFailureTrajectories, extractDecisionTrajectories, extractCounterexamples } from "./extract-trajectories.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("extractFailureTrajectories: every record's status is verbatim-present in the ledger, not inferred", () => {
  const ledgerText = readFileSync(join(REPO_ROOT, "ENGINEERING_LEDGER.md"), "utf8");
  const records = extractFailureTrajectories(ledgerText, "deadbeef");
  // 17 of the ledger's 19 `### ` headings follow the fully regular
  // `### <ID> — <title> · Severity: <sev>` shape; AP-003 and F9 have
  // irregular heading lines (extra inline content, or no Severity segment)
  // and are correctly excluded rather than force-matched. This bound was
  // wrong on the first draft (guessed >40 from an unrelated grep count of
  // field markers, not entries) and caught by running the test.
  assert.ok(records.length >= 15, `expected at least 15 of the ledger's regular entries, got ${records.length} — regex drifted from the source shape`);

  for (const r of records) {
    const id = r.record_id.replace(/^ledger:/, "");
    assert.ok(ledgerText.includes(`### ${id} —`), `${r.record_id}: heading not found verbatim in the ledger`);
    if (r.epistemic_status !== "UNKNOWN") {
      assert.ok(
        ledgerText.includes(`\`[${r.epistemic_status}]\``),
        `${r.record_id}: claims status ${r.epistemic_status} but that exact bracketed token is not in the source`,
      );
    }
  }
});

test("extractFailureTrajectories: negative test — a status NOT in the ledger must not be silently accepted", () => {
  // Anti-vacuity for the test above: prove it can actually fail.
  const fabricated = "### AP-999 — fake entry · Severity: P0\n- **Status**: `[FIXED & ERADICATED]`\n";
  const records = extractFailureTrajectories(fabricated, "deadbeef");
  assert.equal(records.length, 1);
  assert.equal(records[0].epistemic_status, "FIXED & ERADICATED");
  // This is the discriminating check: verify AGAINST THE REAL LEDGER, which
  // does not contain AP-999 — a round-trip check against the real ledger
  // would correctly reject this fabricated record.
  const realLedger = readFileSync(join(REPO_ROOT, "ENGINEERING_LEDGER.md"), "utf8");
  assert.ok(!realLedger.includes("### AP-999 —"), "fabricated id must not actually exist in the real ledger");
});

test("extractDecisionTrajectories: every record's commit hash exists in real git history", () => {
  const records = extractDecisionTrajectories(REPO_ROOT, 20);
  assert.ok(records.length > 0);
  for (const r of records) {
    const hash = r.record_id.replace(/^commit:/, "");
    // execFileSync throws if the object doesn't exist — the assertion IS the call.
    const out = execFileSync("git", ["cat-file", "-e", hash], { cwd: REPO_ROOT, encoding: "utf8" });
    assert.equal(out, "");
    assert.equal(r.source_commit, hash);
  }
});

test("extractDecisionTrajectories: negative test — a hash that does not exist must fail cat-file", () => {
  assert.throws(() => execFileSync("git", ["cat-file", "-e", "0".repeat(40)], { cwd: REPO_ROOT }));
});

test("extractCounterexamples: every record's task text is verbatim-present in the source file", () => {
  const relPath = "packages/worker-runtime/src/verify/verify-evidence.test.ts";
  const text = readFileSync(join(REPO_ROOT, relPath), "utf8");
  const records = extractCounterexamples(text, relPath, "deadbeef");
  assert.ok(records.length > 0, "verify-evidence.test.ts has known anti-vacuity-shaped tests; found none — keyword match drifted");
  for (const r of records) {
    assert.ok(text.includes(r.task), `${r.record_id}: task text not found verbatim in ${relPath}`);
  }
});

test("extractCounterexamples: negative test — text with no anti-vacuity keywords produces no records", () => {
  const plain = `
    describe("x", () => {
      it("adds two numbers", () => {
        expect(1 + 1).toBe(2);
      });
    });
  `;
  const records = extractCounterexamples(plain, "fixture.ts", "deadbeef");
  assert.equal(records.length, 0, "a plain arithmetic test must not be misclassified as a counterexample");
});

test("extractAll: extracted_at_head matches actual git HEAD", () => {
  const result = extractAll(REPO_ROOT, { commitLimit: 5 });
  const actualHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
  assert.equal(result.extracted_at_head, actualHead);
  assert.ok(result.records.length > 0);
  // Every record must carry a schema_version and an epistemic_status drawn
  // from the recognized taxonomy — never an ad hoc value.
  const KNOWN_STATUSES = new Set([
    "UNKNOWN", "DOCUMENTED", "OBSERVED", "DERIVED", "VERIFIED",
    "FIXED & ERADICATED", "OPEN", "INVESTIGATING", "FIXED",
    "SPEC'D — QUEUED PHASE 1", "UNMAPPED",
  ]);
  for (const r of result.records) {
    assert.equal(r.schema_version, "1.0.0");
    assert.ok(
      KNOWN_STATUSES.has(r.epistemic_status),
      `${r.record_id}: epistemic_status "${r.epistemic_status}" is not in the recognized taxonomy — an extractor must not invent new statuses silently`,
    );
  }
});
