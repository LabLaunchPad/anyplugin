import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { NATIVE_EVENT_MAP } from "./index.js";
import { ALL_AGENTS } from "../detect/index.js";

/**
 * Drift guard: knowledge/adapters/event-mapping.md mirrors NATIVE_EVENT_MAP.
 * Every mapping the code emits must be present in the documented table, so an
 * agent reading the knowledge bundle never learns a stale native event name.
 */
describe("knowledge event-mapping drift guard", () => {
  it("documents every NATIVE_EVENT_MAP entry", async () => {
    const md = await readFile(fileURLToPath(new URL("../../../knowledge/adapters/event-mapping.md", import.meta.url)), "utf8");
    for (const agent of ALL_AGENTS) {
      const map = NATIVE_EVENT_MAP[agent];
      for (const [canonical, native] of Object.entries(map)) {
        if (native === undefined) continue; // no native equivalent — dropped at emit time
        expect(md, `${agent}: ${canonical} → ${native}`).toContain(native);
      }
    }
  });
});
