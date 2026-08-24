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

    const annotated = {
      ...json,
      $id: `https://lablaunchpad.dev/worker-runtime/${CONTRACT_VERSION}/${schemaFileName(name)}`,
      title: name,
      description: `Worker Runtime frozen contract: ${name} (contract version ${CONTRACT_VERSION}).`,
    };

    // canonicalJson sorts keys; re-indent for a readable committed artifact.
    const content = `${JSON.stringify(JSON.parse(canonicalJson(annotated)), null, 2)}\n`;
    return { file: schemaFileName(name), content };
  });
}
