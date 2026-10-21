#!/usr/bin/env node
/**
 * Regenerate the committed JSON Schema mirror.
 *
 * The zod schemas in `contracts/` are the SOURCE OF TRUTH. This writes the
 * mirror beside them, and `schema-sync.test.ts` fails if the two ever
 * disagree — so the mirror is generated, never edited.
 *
 * Run it after changing a contract:
 *
 *   node scripts/export-schemas.mjs
 *
 * ── Why this is a script and not a test ────────────────────────────────────
 *
 * A test that regenerates the file would hide the drift it exists to catch:
 * the suite would go green by rewriting the evidence. The test compares;
 * this script writes. They are deliberately separate.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = join(REPO_ROOT, "packages", "worker-runtime");
const SCHEMA_DIR = join(PACKAGE, "schemas");
const BUILT = join(PACKAGE, "dist", "schema-export.js");

if (!BUILT) throw new Error("unreachable");

const { exportSchemas } = await import(pathToFileURL(BUILT).href);

mkdirSync(SCHEMA_DIR, { recursive: true });

const exported = exportSchemas();
const wanted = new Set();
for (const schema of exported) {
  const path = join(SCHEMA_DIR, schema.file);
  writeFileSync(path, schema.content, "utf8");
  wanted.add(schema.file);
  console.log(`  wrote ${schema.file}`);
}

// A schema file for a contract that no longer exists is an orphan, and the
// drift test fails on one. Removing it here keeps the mirror honest.
for (const file of readdirSync(SCHEMA_DIR)) {
  if (!file.endsWith(".schema.json")) continue;
  if (wanted.has(file)) continue;
  rmSync(join(SCHEMA_DIR, file));
  console.log(`  removed the orphan ${file}`);
}

console.log(`\n${exported.length} schema(s) written to ${SCHEMA_DIR}`);
