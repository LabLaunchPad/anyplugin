import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NATIVE_EVENT_MAP } from "./index.js";
import { ALL_AGENTS, type AgentId } from "../detect/index.js";

/** Column index of each agent in the mapping table (cells[1] = canonical name). */
const AGENT_COLUMN: Record<AgentId, number> = { "claude-code": 2, opencode: 3, codex: 4, antigravity: 5 };

function tableRow(md: string, canonical: string): string[] | null {
  for (const line of md.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length >= 6 && cells[1] === canonical) return cells;
  }
  return null;
}

/**
 * Drift guard: knowledge/adapters/event-mapping.md mirrors NATIVE_EVENT_MAP.
 * The mapping must appear in the correct agent's COLUMN of the canonical row —
 * a name that merely exists somewhere else in the doc does not count — and
 * events dropped at emit time (undefined) must be documented as "—".
 */
describe("knowledge event-mapping drift guard", () => {
  it("documents every NATIVE_EVENT_MAP entry in the correct agent column", async () => {
    const md = await readFile(fileURLToPath(new URL("../../../knowledge/adapters/event-mapping.md", import.meta.url)), "utf8");
    for (const agent of ALL_AGENTS) {
      for (const [canonical, native] of Object.entries(NATIVE_EVENT_MAP[agent])) {
        const cells = tableRow(md, canonical);
        expect(cells, `table row for "${canonical}"`).not.toBeNull();
        const cell = cells![AGENT_COLUMN[agent]] ?? "";
        if (native === undefined) {
          expect(cell, `${agent} ${canonical}: dropped event should be documented as "—"`).toBe("—");
        } else {
          expect(cell, `${agent}: ${canonical} → ${native}`).toContain(native);
        }
      }
    }
  });
});
