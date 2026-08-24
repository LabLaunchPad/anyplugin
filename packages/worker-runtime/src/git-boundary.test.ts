/**
 * Git boundary guard: runtime state must never become tracked source, and
 * tracked artifacts must never become accidentally ignored.
 *
 * Both directions matter. Ignoring too little commits a user's evidence ledger
 * into version control by accident; ignoring too much silently drops the
 * generated schemas whose hashes the M1 report records, which would make a
 * drift test unable to see a change.
 *
 * Uses `git check-ignore`, so it tests the REAL resolved ignore rules rather
 * than a re-implementation of them.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { STORAGE_ROOT_DIRNAME, STORAGE_SUBDIRS } from "./storage.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** True iff git would ignore `relPath`. Uses git's own resolution. */
function isIgnored(relPath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", "--no-index", relPath], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true; // exit 0 = ignored
  } catch {
    return false; // exit 1 = not ignored
  }
}

const gitAvailable = existsSync(join(REPO_ROOT, ".git"));

describe.skipIf(!gitAvailable)("git boundary for runtime state", () => {
  it("ignores the runtime storage root and every ledger subdirectory", () => {
    expect(isIgnored(`${STORAGE_ROOT_DIRNAME}/`), STORAGE_ROOT_DIRNAME).toBe(true);
    for (const sub of STORAGE_SUBDIRS) {
      const p = `${STORAGE_ROOT_DIRNAME}/${sub}/record.json`;
      expect(isIgnored(p), p).toBe(true);
    }
  });

  it("does NOT ignore the generated schemas — their hashes must be diff-reviewable", () => {
    // If these were ignored, a schema change would vanish from review while
    // the drift test still passed locally.
    expect(isIgnored("packages/worker-runtime/schemas/certificate.schema.json")).toBe(false);
    expect(isIgnored("packages/worker-runtime/schemas/")).toBe(false);
  });

  it("does NOT ignore kernel source, contracts, or tests", () => {
    for (const p of [
      "packages/worker-runtime/src/index.ts",
      "packages/worker-runtime/src/storage.ts",
      "packages/worker-runtime/src/contracts/index.ts",
      "packages/worker-runtime/src/contracts/primitives.ts",
      "packages/worker-runtime/src/storage.test.ts",
      "packages/worker-runtime/package.json",
      "packages/worker-runtime/tsconfig.json",
    ]) {
      expect(isIgnored(p), p).toBe(false);
    }
  });

  it("ignores build output but not the package itself", () => {
    expect(isIgnored("packages/worker-runtime/dist/index.js")).toBe(true);
    expect(isIgnored("packages/worker-runtime/")).toBe(false);
  });

  it("does not ignore a NESTED .worker-runtime, which would be a deliberate fixture", () => {
    // The rule is root-anchored (`/.worker-runtime/`). A fixture directory
    // deep in the tree must stay visible rather than disappearing silently.
    expect(isIgnored(`packages/worker-runtime/src/__fixtures__/${STORAGE_ROOT_DIRNAME}/x.json`)).toBe(false);
  });

  it("has no runtime-state file currently tracked", () => {
    const tracked = execFileSync("git", ["ls-files"], { cwd: REPO_ROOT, encoding: "utf8" });
    const offenders = tracked
      .split("\n")
      .filter((f) => f.startsWith(`${STORAGE_ROOT_DIRNAME}/`) || f.includes(`/${STORAGE_ROOT_DIRNAME}/`));
    expect(offenders).toEqual([]);
  });
});
