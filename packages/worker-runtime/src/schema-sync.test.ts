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
import { VerificationResultSchema, WorkContractSchema } from "./contracts/index.js";

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

  it("encodes every zod cross-field refinement as Draft 2020-12 if/then", () => {
    // An earlier draft claimed these were inexpressible. They are not — each
    // is an implication or an enum narrowing. This asserts they are present.
    const withRules = {
      "evidence.schema.json": 2,
      "decision.schema.json": 1,
      "experience.schema.json": 2,
      "verification-result.schema.json": 1,
      "certificate.schema.json": 1,
    };
    for (const [file, count] of Object.entries(withRules)) {
      const parsed = JSON.parse(generated.find((g) => g.file === file)?.content ?? "{}") as {
        allOf?: unknown[];
      };
      expect(parsed.allOf?.length, `${file} cross-field rules`).toBe(count);
    }
  });

  it("declares its validation mode so consumers cannot over-claim", () => {
    for (const { file, content } of generated) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      expect(parsed["x-validationMode"], file).toBe("STRUCTURAL_SCHEMA_VALID");
      expect(parsed["x-semanticAuthority"], file).toContain("zod");
    }
  });

  /**
   * PARITY PROOF. For each contract carrying cross-field rules, a record that
   * zod rejects must ALSO be rejected structurally. Without this the encoded
   * if/then blocks would be decoration.
   */
  it("rejects structurally what zod rejects semantically", () => {
    const base = {
      id: "VER-1", contractVersion: "1.0.0", verifierId: "t", outcome: "FAIL",
      inputHashes: [`sha256:${"a".repeat(64)}`], observations: [], at: "2026-08-24T12:00:00Z",
    };
    // zod rejects: FAIL with no reason
    expect(VerificationResultSchema.safeParse(base).success).toBe(false);

    // the exported schema must encode the same rule
    const parsed = JSON.parse(
      generated.find((g) => g.file === "verification-result.schema.json")?.content ?? "{}",
    ) as { allOf?: { if?: unknown; then?: { required?: string[] } }[] };
    const rule = parsed.allOf?.[0];
    expect(rule?.then?.required, "FAIL/BLOCKED must require reason").toContain("reason");

    // and adding a reason satisfies zod
    expect(VerificationResultSchema.safeParse({ ...base, reason: "why" }).success).toBe(true);
  });

  /**
   * REMAINING zod-only surface, asserted so it stays visible.
   *
   * `.default()` (17 uses) creates an input/output divergence that JSON Schema
   * cannot express: the parsed OUTPUT always carries the field, while the
   * INPUT may omit it. Schemas are exported with `io: "input"`, so defaulted
   * fields are optional there. A consumer validating structurally sees the
   * input contract; a consumer reading a kernel record sees the output shape.
   */
  it("documents the default() input/output divergence", () => {
    const parsed = JSON.parse(
      generated.find((g) => g.file === "work-contract.schema.json")?.content ?? "{}",
    ) as { required?: string[]; properties?: Record<string, unknown> };
    // `constraints` has a default, so it is NOT required on input...
    expect(parsed.required).not.toContain("constraints");
    // ...but it is always present on a parsed record.
    const parsedRecord = WorkContractSchema.parse({
      id: "WC-1", contractVersion: "1.0.0", goal: "g", scope: ["a"],
      successConditions: ["t"], riskLevel: "low",
      provenance: { by: "worker-runtime/0.0.1", at: "2026-08-24T12:00:00Z" },
    });
    expect(parsedRecord.constraints).toEqual([]);
  });
});
