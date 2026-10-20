/**
 * The detection-matrix drift tripwire.
 *
 * ── Why this is an EXPECTED failure ───────────────────────────────────────
 *
 * P1-5: \`knowledge/adapters/detection-matrix.md\` lists
 * \`CLAUDE_CODE_CHILD_SESSION\` and \`CLAUDE_PID\` as Claude Code detection
 * signals; the code checks only \`CLAUDE_CODE_SESSION_ID\`. The backlog says
 * *"The CODE is the source of truth. The document is stale and should either
 * be corrected or drift-guarded."*
 *
 * This is that drift guard, written under the expected-failure convention
 * (\`docs/BACKLOG.md\` §6.1): it is written with \`it.fails\`, so it is a
 * **tripwire**. The suite stays green, and the moment the document and the
 * code agree — by correcting the document OR by teaching the code to check
 * the signal — the tripwire fires and says so.
 *
 * A red test that is allowed to be red is a test that reports the truth. A
 * green test that asserts a bug is a test that hides it.
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
  it.fails(
    "every Claude Code signal the matrix documents is one the detector checks [P1-5]",
    () => {
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
    },
  );
});
