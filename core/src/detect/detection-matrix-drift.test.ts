/**
 * The detection-matrix drift guard.
 *
 * ── What this file is ──────────────────────────────────────────────────────
 *
 * P1-5: \`knowledge/adapters/detection-matrix.md\` listed
 * \`CLAUDE_CODE_CHILD_SESSION\` and \`CLAUDE_PID\` as Claude Code detection
 * signals; the detector checked only \`CLAUDE_CODE_SESSION_ID\`. The backlog
 * said *"The CODE is the source of truth. The document is stale and should
 * either be corrected or drift-guarded."*
 *
 * It was **both**: the document was corrected — the two published-but-not-
 * relied-on signals moved out of the detection-signal row into a note that
 * says plainly they are not checked — and this guard now makes the drift
 * impossible to reintroduce.
 *
 * ── It was written as a tripwire, and it fired ─────────────────────────────
 *
 * The first version of this test was an **expected failure** (the new
 * \`it.fails\` convention): the drift was real, so the test failed, and the
 * suite stayed green. The moment the document was corrected the tripwire
 * fired — which is exactly what a tripwire is for.
 *
 * It is now an ordinary test. **A bug that has been fixed should leave
 * behind a guard, not a hole.**
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** The documented signals for one agent, as the matrix writes them. */
function documentedSignals(matrix: string, agent: string): string[] {
  const row = new RegExp(`^- ${agent}: (.+)$`, "m").exec(matrix)?.[1] ?? "";
  return [...row.matchAll(/`([A-Z][A-Z0-9_]*)`/g)].map((m) => m[1]!);
}

describe("the detection matrix and the detector agree", () => {
  it("every Claude Code signal the matrix documents is one the detector checks", () => {
    const matrix = readFileSync(
      join(REPO_ROOT, "knowledge", "adapters", "detection-matrix.md"),
      "utf8",
    );
    const detector = readFileSync(join(REPO_ROOT, "core", "src", "detect", "index.ts"), "utf8");

    const documented = documentedSignals(matrix, "Claude Code");
    expect(documented.length, "the matrix must document some Claude Code signals").toBeGreaterThan(0);

    const unchecked = documented.filter((name) => !detector.includes(name));
    expect(
      unchecked,
      `the matrix documents ${unchecked.join(", ")}, which the detector does not check — ` +
        "either the document is stale or the detector is missing a signal",
    ).toEqual([]);
  });
});
