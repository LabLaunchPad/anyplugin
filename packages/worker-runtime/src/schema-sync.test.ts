/**
 * Drift guard: the committed JSON Schema files must match what the zod
 * contracts generate. Same discipline AGENTS.md applies to
 * anyplugin.plugin.schema.json — a mirror nobody checks is a lie waiting.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CONTRACTS } from "./contracts/index.js";
import { exportSchemas, schemaFileName } from "./schema-export.js";
import { VerificationResultSchema } from "./contracts/index.js";

const SCHEMA_DIR = join(import.meta.dirname, "..", "schemas");

describe("JSON Schema mirror", () => {
  const generated = exportSchemas();

  it("emits one schema per frozen contract", () => {
    expect(generated.length).toBe(Object.keys(CONTRACTS).length);
    for (const name of Object.keys(CONTRACTS)) {
      expect(generated.some((g) => g.file === schemaFileName(name)), name).toBe(true);
    }
  });

  it("matches the committed files byte for byte", () => {
    for (const { file, content } of generated) {
      const path = join(SCHEMA_DIR, file);
      expect(existsSync(path), `${file} is missing — regenerate schemas/`).toBe(true);
      expect(readFileSync(path, "utf8"), `${file} is stale — regenerate schemas/`).toBe(content);
    }
  });

  it("has no orphaned schema files from renamed contracts", () => {
    const expected = new Set(generated.map((g) => g.file));
    for (const file of readdirSync(SCHEMA_DIR).filter((f) => f.endsWith(".schema.json"))) {
      expect(expected.has(file), `${file} has no corresponding contract`).toBe(true);
    }
  });

  it("targets Draft 2020-12 and is self-identifying", () => {
    for (const { file, content } of generated) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(parsed["$schema"], file).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(String(parsed["$id"]), file).toContain(file);
      expect(parsed["title"], file).toBeTruthy();
    }
  });

  it("is deterministic across regenerations", () => {
    const again = exportSchemas();
    for (let i = 0; i < generated.length; i += 1) {
      expect(again[i]?.content).toBe(generated[i]?.content);
    }
  });

  /**
   * KNOWN AND DELIBERATE GAP — asserted so it cannot be quietly forgotten.
   *
   * zod `.refine()` expresses cross-field constraints (e.g. "FAIL and BLOCKED
   * must state a reason") that JSON Schema export cannot represent. The mirror
   * is therefore STRUCTURAL ONLY: it validates field shapes, not relationships
   * between fields.
   *
   * Consequence for consumers: JSON Schema validation is necessary but NOT
   * sufficient. The zod contracts remain the authority. If this ever becomes a
   * problem, the fix is hand-authored `if/then` or `dependentRequired` clauses
   * — not pretending the gap does not exist.
   */
  it("documents that cross-field refinements do NOT survive export", () => {
    const verification = generated.find((g) => g.file === "verification-result.schema.json");
    const parsed = JSON.parse(verification?.content ?? "{}") as { required?: string[] };

    // zod rejects a FAIL with no reason...
    expect(
      VerificationResultSchema.safeParse({
        id: "VER-1", contractVersion: "1.0.0", verifierId: "t", outcome: "FAIL",
        inputHashes: [`sha256:${"a".repeat(64)}`], observations: [], at: "2026-08-24T12:00:00Z",
      }).success,
    ).toBe(false);

    // ...but the exported JSON Schema does not mark `reason` required at all,
    // because the constraint is conditional. Asserting this keeps the
    // limitation visible instead of assumed away.
    expect(parsed.required).not.toContain("reason");
  });
});
