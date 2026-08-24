/**
 * Workspace package-boundary guards (ROADMAP.md §2, "Package boundary").
 *
 * The Worker Runtime kernel must own its truth and must never depend on
 * AnyPlugin. The locked dependency direction is:
 *
 *     Worker Runtime kernel  (knows nothing about any agent)
 *              ↑
 *     CLI/MCP · agent adapters · integrations  (AnyPlugin is one of these)
 *
 * Never `AnyPlugin → kernel → AnyPlugin`, and never `adapter → kernel internals`.
 *
 * THREE STATES, and ARMED must NEVER be reported as PASSED:
 *
 *   ARMED  — enforcement exists, but the target package does not exist yet, so
 *            the invariant has NOT been exercised. Proves nothing about the code.
 *   PASSED — the target exists and the invariant was actually checked against it.
 *   FAILED — the invariant is violated.
 *
 * A vacuously-green check is worse than no check: it manufactures confidence.
 * Guards whose target is absent therefore assert only that they are correctly
 * ARMED, and say so loudly.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const RUNTIME_PKG = join(REPO_ROOT, "packages", "worker-runtime");

type GuardState = "ARMED" | "PASSED" | "FAILED";

interface GuardResult {
  guard: string;
  state: GuardState;
  detail: string;
}

/**
 * Packages the Worker Runtime kernel may never depend on.
 *
 * This is an ALLOWLIST-style rule expressed as a scope: the kernel may not
 * reference ANY `@lablaunchpad/*` workspace package — `@lablaunchpad/core`
 * emphatically included, since it carries agent-specific knowledge
 * (NATIVE_EVENT_MAP, agent detection, the adapter contract). Enumerating
 * packages individually was the original form of this guard and it silently
 * missed `core`; a scope rule cannot be outgrown by adding a new package.
 */
const FORBIDDEN_SCOPE = "@lablaunchpad/";

function isForbiddenSpecifier(spec: string): boolean {
  if (spec.startsWith(FORBIDDEN_SCOPE)) return true;
  // relative escape out of the package into a sibling workspace package
  return spec.startsWith(".") && /(^|\/)(cli|adapters|core|plugins)\//.test(spec);
}

function readPackageJson(dir: string): { name?: string; dependencies?: Record<string, string> } | null {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { name?: string; dependencies?: Record<string, string> };
  } catch {
    return null;
  }
}

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectSourceFiles(full, acc);
    else if (/\.(ts|mts|js|mjs)$/.test(entry)) acc.push(full);
  }
  return acc;
}

/** Module specifiers in static imports, re-exports, dynamic imports, and require(). */
function moduleSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const patterns = [
    /(?:^|\s)(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g,
    /(?:^|\s)import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) if (m[1]) specs.push(m[1]);
  }
  return specs;
}

// ── Guards whose target does not exist yet: ARMED ────────────────────────────

function guardRuntimeImports(): GuardResult {
  const guard = "worker-runtime: no import of cli/ or adapters/";
  if (!existsSync(RUNTIME_PKG)) {
    return { guard, state: "ARMED", detail: "packages/worker-runtime/ does not exist; invariant NOT exercised" };
  }
  const violations: string[] = [];
  for (const file of collectSourceFiles(RUNTIME_PKG)) {
    for (const spec of moduleSpecifiers(readFileSync(file, "utf8"))) {
      if (isForbiddenSpecifier(spec)) violations.push(`${file.slice(REPO_ROOT.length + 1)} → ${spec}`);
    }
  }
  return violations.length > 0
    ? { guard, state: "FAILED", detail: violations.join("; ") }
    : { guard, state: "PASSED", detail: "no forbidden module specifier found" };
}

function guardRuntimeDependencies(): GuardResult {
  const guard = "worker-runtime: no AnyPlugin package dependency";
  const pkg = readPackageJson(RUNTIME_PKG);
  if (!pkg) {
    return { guard, state: "ARMED", detail: "packages/worker-runtime/package.json does not exist; invariant NOT exercised" };
  }
  const forbidden = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith(FORBIDDEN_SCOPE));
  return forbidden.length > 0
    ? { guard, state: "FAILED", detail: `declares ${forbidden.join(", ")}` }
    : { guard, state: "PASSED", detail: "declares no AnyPlugin package" };
}

function guardRuntimeStandalone(): GuardResult {
  const guard = "worker-runtime: wired into the workspace and the test globs";
  if (!existsSync(RUNTIME_PKG)) {
    return { guard, state: "ARMED", detail: "packages/worker-runtime/ does not exist; nothing to execute" };
  }
  const workspace = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const vitest = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
  const missing: string[] = [];
  if (!/^\s*-\s*packages\/\*\s*$/m.test(workspace)) missing.push("pnpm-workspace.yaml lacks a packages/* glob");
  if (!/packages/.test(vitest)) missing.push("vitest include glob omits packages");
  return missing.length > 0
    ? { guard, state: "FAILED", detail: missing.join("; ") }
    : { guard, state: "PASSED", detail: "declared in pnpm-workspace.yaml and covered by the vitest include glob" };
}

/**
 * Single-ownership guard. The kernel's authoritative state must never be an
 * AnyPlugin install destination: TEMPLATES targets are journaled and restored
 * to pre-install bytes on uninstall, which would revert or delete the ledger.
 * Exercised against the REAL TEMPLATES table in cli/src/index.ts.
 */
function guardStorageOwnershipDisjoint(): GuardResult {
  const guard = "single ownership: kernel storage root is not an AnyPlugin install destination";
  const cliSource = join(REPO_ROOT, "cli", "src", "index.ts");
  if (!existsSync(cliSource)) return { guard, state: "FAILED", detail: "cli/src/index.ts missing" };

  const source = readFileSync(cliSource, "utf8");
  const block = /const TEMPLATES[\s\S]*?\n\};/.exec(source);
  if (!block) return { guard, state: "FAILED", detail: "could not locate the TEMPLATES table in cli/src/index.ts" };

  const destinations = [...block[0].matchAll(/"([^"]+)":\s*\(o\)/g)].map((m) => m[1] ?? "");
  if (destinations.length === 0) return { guard, state: "FAILED", detail: "TEMPLATES table parsed but yielded no destinations" };

  // Read the kernel's declared storage root from its own source, so the two
  // sides cannot silently drift apart.
  const storageFile = join(RUNTIME_PKG, "src", "storage.ts");
  if (!existsSync(storageFile)) {
    return { guard, state: "ARMED", detail: `TEMPLATES parsed (${destinations.length} destinations) but the kernel declares no storage root yet` };
  }
  const rootMatch = /STORAGE_ROOT_DIRNAME\s*=\s*"([^"]+)"/.exec(readFileSync(storageFile, "utf8"));
  if (!rootMatch?.[1]) return { guard, state: "FAILED", detail: "STORAGE_ROOT_DIRNAME not found in the kernel's storage.ts" };
  const kernelRoot = rootMatch[1];

  const collisions = destinations.filter((d) => {
    const tail = d.replace(/^\{\{[A-Z_]+\}\}\//, "");
    return tail === kernelRoot || tail.startsWith(`${kernelRoot}/`);
  });
  return collisions.length > 0
    ? { guard, state: "FAILED", detail: `TEMPLATES targets kernel-owned storage: ${collisions.join(", ")}` }
    : {
        guard,
        state: "PASSED",
        detail: `${destinations.length} install destinations checked; none touch "${kernelRoot}"`,
      };
}

// ── Guards exercisable today against real packages: PASSED/FAILED ────────────

function guardCoreIsLeaf(): GuardResult {
  const guard = "core: depends on no other workspace package";
  const pkg = readPackageJson(join(REPO_ROOT, "core"));
  if (!pkg) return { guard, state: "FAILED", detail: "core/package.json unreadable" };
  const workspaceDeps = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@lablaunchpad/"));
  return workspaceDeps.length > 0
    ? { guard, state: "FAILED", detail: `core depends on ${workspaceDeps.join(", ")}` }
    : { guard, state: "PASSED", detail: "core is a dependency leaf" };
}

function guardAdaptersDoNotDependOnCli(): GuardResult {
  const guard = "adapters: never depend on cli";
  const adaptersDir = join(REPO_ROOT, "adapters");
  if (!existsSync(adaptersDir)) return { guard, state: "FAILED", detail: "adapters/ missing" };
  const violations: string[] = [];
  let checked = 0;
  for (const entry of readdirSync(adaptersDir)) {
    const pkg = readPackageJson(join(adaptersDir, entry));
    if (!pkg) continue;
    checked += 1;
    if (Object.keys(pkg.dependencies ?? {}).includes("@lablaunchpad/cli")) violations.push(entry);
  }
  return violations.length > 0
    ? { guard, state: "FAILED", detail: `${violations.join(", ")} depend on cli` }
    : { guard, state: "PASSED", detail: `${checked} adapters checked, none depend on cli` };
}

export function evaluateBoundaryGuards(): GuardResult[] {
  return [
    guardCoreIsLeaf(),
    guardAdaptersDoNotDependOnCli(),
    guardRuntimeImports(),
    guardRuntimeDependencies(),
    guardRuntimeStandalone(),
    guardStorageOwnershipDisjoint(),
  ];
}

describe("workspace package boundaries", () => {
  const results = evaluateBoundaryGuards();

  it("reports every guard's state without conflating ARMED with PASSED", () => {
    // Rendered on every run so an ARMED guard can never be mistaken for a
    // satisfied invariant by a reader scanning green test output.
    const rendered = results.map((r) => `  [${r.state}] ${r.guard} — ${r.detail}`).join("\n");
    console.info(`\nworkspace boundary guards:\n${rendered}\n`);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(["ARMED", "PASSED", "FAILED"]).toContain(r.state);
  });

  it("has no FAILED guard", () => {
    const failed = results.filter((r) => r.state === "FAILED");
    expect(failed.map((r) => `${r.guard}: ${r.detail}`)).toEqual([]);
  });

  it("core is a dependency leaf (exercised)", () => {
    const r = results.find((x) => x.guard.startsWith("core:"));
    expect(r?.state).toBe("PASSED");
  });

  it("no adapter depends on cli (exercised)", () => {
    const r = results.find((x) => x.guard.startsWith("adapters:"));
    expect(r?.state).toBe("PASSED");
  });

  it("worker-runtime guards are exercised, not ARMED (M1 created the package)", () => {
    // The ARMED/PASSED firewall, now on the far side. The package exists, so
    // every runtime guard must have actually run against real files. An ARMED
    // result here would mean an invariant silently stopped being checked.
    expect(existsSync(RUNTIME_PKG)).toBe(true);

    const runtimeGuards = results.filter((r) => r.guard.startsWith("worker-runtime:"));
    expect(runtimeGuards.length).toBe(3);
    for (const r of runtimeGuards) {
      expect(r.state, `${r.guard} must be exercised, got ${r.state}: ${r.detail}`).toBe("PASSED");
    }
  });

  it("kernel storage ownership is disjoint from AnyPlugin install destinations (exercised)", () => {
    const r = results.find((x) => x.guard.startsWith("single ownership:"));
    expect(r?.state, r?.detail).toBe("PASSED");
  });

  it("kernel declares no workspace dependency at all, not even core", () => {
    // core carries agent-specific knowledge (NATIVE_EVENT_MAP, agent
    // detection, the adapter contract). Depending on it would make the kernel
    // agent-aware, violating the locked dependency direction.
    const pkg = readPackageJson(RUNTIME_PKG);
    expect(pkg).not.toBeNull();
    const workspaceDeps = Object.keys(pkg?.dependencies ?? {}).filter((d) => d.startsWith("@lablaunchpad/"));
    expect(workspaceDeps).toEqual([]);
  });
});
