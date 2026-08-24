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

/** Packages the Worker Runtime kernel may never depend on. */
const FORBIDDEN_FOR_RUNTIME = [
  "@lablaunchpad/cli",
  "@lablaunchpad/adapter-claude",
  "@lablaunchpad/adapter-opencode",
  "@lablaunchpad/adapter-codex",
  "@lablaunchpad/adapter-antigravity",
  "@lablaunchpad/plugin-knowledge",
];

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
      const escapesIntoForbiddenDir = /(^|\/)(cli|adapters)\//.test(spec) && spec.startsWith(".");
      if (FORBIDDEN_FOR_RUNTIME.includes(spec) || escapesIntoForbiddenDir) {
        violations.push(`${file.slice(REPO_ROOT.length + 1)} → ${spec}`);
      }
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
  const forbidden = Object.keys(pkg.dependencies ?? {}).filter((d) => FORBIDDEN_FOR_RUNTIME.includes(d));
  return forbidden.length > 0
    ? { guard, state: "FAILED", detail: `declares ${forbidden.join(", ")}` }
    : { guard, state: "PASSED", detail: "declares no AnyPlugin package" };
}

function guardRuntimeStandalone(): GuardResult {
  const guard = "worker-runtime: suite passes with no agent installed";
  return existsSync(RUNTIME_PKG)
    ? { guard, state: "ARMED", detail: "package exists but its standalone suite is not yet wired into vitest include globs" }
    : { guard, state: "ARMED", detail: "packages/worker-runtime/ does not exist; nothing to execute" };
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

  it("worker-runtime guards are ARMED until M1 creates the package", () => {
    // This test is the ARMED/PASSED firewall. When M1 creates
    // packages/worker-runtime/, these flip to PASSED and this expectation
    // fails — forcing a deliberate update rather than silently sliding from
    // "never checked" to "checked and fine".
    const runtimeGuards = results.filter((r) => r.guard.startsWith("worker-runtime:"));
    expect(runtimeGuards.length).toBe(3);

    if (existsSync(RUNTIME_PKG)) {
      throw new Error(
        "packages/worker-runtime/ now exists. The boundary guards are no longer ARMED — " +
          "update this test to assert PASSED, and wire the package into vitest include globs " +
          "and pnpm-workspace.yaml (see ROADMAP.md §2).",
      );
    }
    for (const r of runtimeGuards) expect(r.state).toBe("ARMED");
  });
});
