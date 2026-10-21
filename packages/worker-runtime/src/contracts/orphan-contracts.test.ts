/**
 * The orphan-contract guard.
 *
 * ── What it catches ────────────────────────────────────────────────────────
 *
 * A frozen contract with **no consumer outside its own file** is a shape
 * nothing depends on. It parses, it has a JSON Schema mirror, it passes the
 * drift test — and it is invisible: nothing notices when the thing it was
 * written for never arrives.
 *
 * That is exactly how milestone **M5** stayed undone for months with
 * `GraphSnapshotSchema` sitting in the contracts file and
 * `InvalidationResultSchema` declaring four fields that **cannot be computed
 * without traversal**. Neither was referenced anywhere else in the
 * repository. They are bound now — by the graph engine this cycle added.
 *
 * ── Why this is a guard and not a promise ──────────────────────────────────
 *
 * A promise that "the contracts are used" decays silently. A test fails the
 * build. The escape hatch is explicit: a contract with no consumer must be
 * **named here, with the milestone that will bind it** — so a NEW unbound
 * contract fails, and the KNOWN ones stay visible with their reasons.
 *
 * ── What counts as a consumer ───────────────────────────────────────────────
 *
 * A **non-test** file outside `packages/worker-runtime/src/contracts/` that
 * **imports** the contract's type or its schema constant from the contracts
 * module.
 *
 * The test is deliberately syntactic rather than textual. A substring search
 * for a contract's name matches its own definition, the barrel that
 * re-exports it, and — worst of all — **a comment that mentions it**. All
 * three are noise, and a guard built on noise flags everything, which is the
 * same as flagging nothing.
 *
 * The barrel (`src/index.ts`) is excluded: it re-exports every contract, so
 * counting it would prove nothing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { CONTRACTS } from "./index.js";

const SRC_DIR = resolve(import.meta.dirname, "..");

/**
 * The contracts with no consumer outside `contracts/`, and the milestone
 * that will bind each one.
 *
 * **Every entry is a debt with an owner.** An entry here means the contract
 * exists, is frozen, is mirrored, and is not yet part of anything. Removing
 * an entry fails the build — so the list cannot silently grow, and cannot
 * silently shrink either.
 *
 * **What this guard does and does not claim.** It tracks whether a contract
 * is *consumed* — whether anything outside the contracts file reads or
 * writes it. It does not track whether the feature the contract describes is
 * *complete*. `Decision` left this list when the invalidation engine began
 * reading and re-recording decisions; the **Decision Ledger** of M4 — the
 * full record, its provenance, its alternatives, its supersession, and the
 * experience ledger beside it — is still not built, and M3's Evidence Ledger
 * is still not built either.
 */
const UNBOUND_CONTRACTS: Readonly<Record<string, string>> = {};

/** Every source file under `src/`, absolute. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/**
 * The files that may hold a consumer.
 *
 * Excludes `contracts/` (a contract does not consume itself), every test
 * file (a round-trip test proves the schema parses, not that the contract is
 * part of anything), and the barrel (it re-exports everything).
 */
function consumerFiles(): string[] {
  return sourceFiles(SRC_DIR).filter((file) => {
    const rel = relative(SRC_DIR, file).split("\\").join("/");
    if (rel.startsWith("contracts/")) return false;
    if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)) return false;
    if (rel === "index.ts") return false;
    return true;
  });
}

/** The names a file IMPORTS from the contracts module. */
function importedContractNames(source: string): Set<string> {
  const names = new Set<string>();
  const re = /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'][^"']*contracts\/index\.js["']/g;
  for (const match of source.matchAll(re)) {
    for (const part of (match[1] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        ?.trim();
      if (name) names.add(name);
    }
  }
  return names;
}

/** The contracts that have at least one consumer, and where. */
function boundContracts(files: string[]): Map<string, string[]> {
  const sources = files.map((file) => ({
    rel: relative(SRC_DIR, file).split("\\").join("/"),
    names: importedContractNames(readFileSync(file, "utf8")),
  }));
  const bound = new Map<string, string[]>();
  for (const name of Object.keys(CONTRACTS)) {
    const users: string[] = [];
    for (const source of sources) {
      if (source.names.has(name) || source.names.has(`${name}Schema`)) users.push(source.rel);
    }
    bound.set(name, users);
  }
  return bound;
}

describe("the orphan-contract guard", () => {
  const files = consumerFiles();

  it("has consumer files to look at — the guard is not vacuous", () => {
    // A guard that scans nothing passes everything. This asserts the scan
    // saw real files, so the other assertions in this file mean something.
    expect(files.length, "no non-test files outside contracts/ were found").toBeGreaterThan(3);
  });

  it("names every contract in the registry", () => {
    // The registry and the unbound list must agree on the universe.
    for (const name of Object.keys(UNBOUND_CONTRACTS)) {
      expect(
        Object.keys(CONTRACTS),
        `"${name}" is listed as unbound but is not in the CONTRACTS registry`,
      ).toContain(name);
    }
  });

  it("binds every contract, or names the one that binds it", () => {
    const bound = boundContracts(files);
    const unbound = Object.keys(CONTRACTS).filter((name) => (bound.get(name) ?? []).length === 0);

    // Every unbound contract must be accounted for, with a written reason.
    const unexplained = unbound.filter((name) => !(name in UNBOUND_CONTRACTS));
    expect(
      unexplained,
      `these frozen contracts have no consumer outside contracts/ and no recorded reason - either bind one or name the milestone that will:\n${unexplained.join("\n")}`,
    ).toEqual([]);

    // And every NAMED contract must still be unbound — otherwise the entry
    // is stale, and a stale entry is a lie that hides the next orphan.
    const stale = Object.keys(UNBOUND_CONTRACTS).filter((name) => (bound.get(name) ?? []).length > 0);
    expect(
      stale,
      `these contracts now HAVE a consumer outside contracts/, so their entry in the unbound list is stale - remove it:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("gives every unbound contract a reason that names a milestone", () => {
    for (const [name, reason] of Object.entries(UNBOUND_CONTRACTS)) {
      expect(reason.length, `${name} has no reason`).toBeGreaterThan(20);
      expect(reason, `${name}'s reason must name the milestone that binds it`).toMatch(/M\d/);
    }
  });

  it("reports the state of every contract on every run", () => {
    // Rendered, so the list cannot be mistaken for a passing guard. The
    // whole point is that the unbound contracts are VISIBLE.
    const bound = boundContracts(files);
    const rendered = Object.keys(CONTRACTS)
      .map((name) => {
        const users = bound.get(name) ?? [];
        return `  [${users.length === 0 ? "UNBOUND" : "BOUND"}] ${name.padEnd(20)} ${users.join(", ")}`;
      })
      .join("\n");
    console.info(`\nfrozen contracts:\n${rendered}\n`);
    expect(Object.keys(CONTRACTS).length).toBeGreaterThan(0);
  });
});

describe("the guard itself", () => {
  it("is not vacuous — an unbound contract the registry gained would fail", () => {
    // The guard's own mutation test: it must be able to fail.
    //
    // It used to assert that the registry really did contain an unbound
    // contract, so that the detection was not a tautology. **Every contract
    // is BOUND now** — the seal bound the last two — so that precondition
    // is gone, and the proof has to be direct: take a contract that IS
    // bound, take its consumer away, and the rule must reject it.
    //
    // A guard whose own proof depended on the repository being in a
    // particular state was a guard that would have started failing for the
    // wrong reason the moment that state changed.
    const bound = boundContracts(consumerFiles());
    const names = Object.keys(CONTRACTS);
    const candidate = names.find((name) => (bound.get(name) ?? []).length > 0);
    expect(candidate, "the registry must contain a bound contract to remove").toBeDefined();

    // With its consumer, the contract is explained.
    const withConsumer = names.filter(
      (name) => (bound.get(name) ?? []).length === 0 && !(name in UNBOUND_CONTRACTS),
    );
    expect(withConsumer).not.toContain(candidate!);

    // Without one, it is not — and that is the rule the guard enforces.
    const withoutConsumer = new Map(bound);
    withoutConsumer.set(candidate!, []);
    const unexplained = names.filter(
      (name) => (withoutConsumer.get(name) ?? []).length === 0 && !(name in UNBOUND_CONTRACTS),
    );
    expect(unexplained).toContain(candidate!);
  });

  it("would flag a contract the registry gained without a consumer", () => {
    // Simulate the registry gaining a contract: the guard's rule is that an
    // unnamed contract fails, so a new one has no way in unnoticed.
    const hypothetical = "HypotheticalContract";
    expect(Object.keys(CONTRACTS)).not.toContain(hypothetical);
    expect(hypothetical in UNBOUND_CONTRACTS).toBe(false);
    const unexplained = [hypothetical].filter((name) => !(name in UNBOUND_CONTRACTS));
    expect(unexplained).not.toEqual([]);
  });

  it("does not count a mention in a comment as a consumer", () => {
    // The substring approach this guard replaced flagged every contract,
    // because their names appear in prose. A comment must not bind a
    // contract.
    const commentOnly = [
      "import { z } from \"zod\";",
      "// DecisionSchema.supportingEvidence encodes the link.",
      "/** EvidenceSchema and CertificateSchema are mentioned here. */",
    ].join("\n");
    expect(importedContractNames(commentOnly).size, "a comment must not count as an import").toBe(0);
  });
});
