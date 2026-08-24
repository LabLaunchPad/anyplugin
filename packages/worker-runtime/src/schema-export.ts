/**
 * JSON Schema (Draft 2020-12) export of the frozen contracts.
 *
 * The zod schemas in `contracts/` are the SOURCE OF TRUTH; the JSON Schema
 * files under `schemas/` are a generated mirror, so external consumers (editor
 * validation, other languages, CI gates) can validate kernel records without
 * running TypeScript. `schema-sync.test.ts` fails if the two drift — the same
 * discipline AGENTS.md already applies to `anyplugin.plugin.schema.json`.
 *
 * Schemas are emitted with sorted keys via `canonicalJson` so regenerating on
 * a different machine cannot produce a spurious diff.
 */
import { z } from "zod";
import { CONTRACTS, CONTRACT_VERSION } from "./contracts/index.js";
import { canonicalJson } from "./canonical.js";

export interface ExportedSchema {
  /** File name under schemas/, e.g. "work-contract.schema.json". */
  file: string;
  /** Pretty-printed JSON Schema, key-sorted and newline-terminated. */
  content: string;
}

/**
 * Validation strength a consumer can claim. Emitted into every schema as
 * `x-validationMode` so no consumer can believe structural validation is
 * equivalent to kernel validation when it is not.
 */
export const VALIDATION_MODES = {
  /** JSON Schema alone: shapes plus the cross-field rules encoded below. */
  structural: "STRUCTURAL_SCHEMA_VALID",
  /** zod parse: everything structural, plus anything not expressible here. */
  semantic: "SEMANTIC_KERNEL_VALID",
} as const;

/**
 * Cross-field constraints that `z.toJSONSchema()` drops, re-expressed as
 * Draft 2020-12 `allOf`/`if`/`then`.
 *
 * Every zod `.refine()` in contracts/index.ts is mirrored here. An earlier
 * draft claimed these were inexpressible; that was wrong — all of them are
 * implications or enum narrowings, both of which Draft 2020-12 supports.
 * `schema-sync.test.ts` proves each augmented schema rejects the same records
 * zod rejects, so the claim is tested rather than asserted.
 */
const CROSS_FIELD_RULES: Record<string, unknown[]> = {
  Evidence: [
    {
      if: { properties: { validity: { const: "SUPERSEDED" } }, required: ["validity"] },
      then: { required: ["supersededBy"] },
      else: { not: { required: ["supersededBy"] } },
    },
    {
      if: { properties: { validity: { const: "INVALIDATED" } }, required: ["validity"] },
      then: { required: ["invalidationReason"] },
      else: { not: { required: ["invalidationReason"] } },
    },
  ],
  Decision: [
    {
      if: { properties: { validity: { const: "SUPERSEDED" } }, required: ["validity"] },
      then: { required: ["supersededBy"] },
      else: { not: { required: ["supersededBy"] } },
    },
  ],
  Experience: [
    {
      // failureClass is meaningful only on a FAILURE
      if: { required: ["failureClass"] },
      then: { properties: { outcome: { const: "FAILURE" } } },
    },
    {
      // VERIFIED_KNOWLEDGE requires supporting evidence — the epistemic ladder
      if: { properties: { rung: { const: "VERIFIED_KNOWLEDGE" } }, required: ["rung"] },
      then: { properties: { evidence: { minItems: 1 } }, required: ["evidence"] },
    },
  ],
  VerificationResult: [
    {
      if: { properties: { outcome: { enum: ["FAIL", "BLOCKED"] } }, required: ["outcome"] },
      then: { required: ["reason"] },
    },
  ],
  Certificate: [
    {
      // certificates may only be issued over terminal work
      properties: { finalPhase: { enum: ["COMPLETED", "FAILED"] } },
    },
  ],
};

/** kebab-cases a PascalCase contract name: WorkContract → work-contract. */
export function schemaFileName(contractName: string): string {
  const kebab = contractName.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return `${kebab}.schema.json`;
}

/** Generate the JSON Schema mirror for every frozen contract. */
export function exportSchemas(): ExportedSchema[] {
  return Object.entries(CONTRACTS).map(([name, schema]) => {
    const json = z.toJSONSchema(schema as z.ZodType, {
      target: "draft-2020-12",
      // Inline everything: a self-contained schema file is usable by consumers
      // that cannot resolve $refs across files.
      io: "input",
    }) as Record<string, unknown>;

    const crossField = CROSS_FIELD_RULES[name];
    const annotated = {
      ...json,
      $id: `https://lablaunchpad.dev/worker-runtime/${CONTRACT_VERSION}/${schemaFileName(name)}`,
      title: name,
      description: `Worker Runtime frozen contract: ${name} (contract version ${CONTRACT_VERSION}).`,
      /**
       * Validating against this file yields STRUCTURAL_SCHEMA_VALID only.
       * SEMANTIC_KERNEL_VALID additionally requires a zod parse. They coincide
       * for contracts with no zod-only constraints, but a consumer must not
       * assume that without checking this field.
       */
      "x-validationMode": VALIDATION_MODES.structural,
      "x-semanticAuthority": "@lablaunchpad/worker-runtime contracts (zod)",
      ...(crossField ? { allOf: crossField } : {}),
    };

    // canonicalJson sorts keys; re-indent for a readable committed artifact.
    const content = `${JSON.stringify(JSON.parse(canonicalJson(annotated)), null, 2)}\n`;
    return { file: schemaFileName(name), content };
  });
}
