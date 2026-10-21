/**
 * The publish-readiness guard.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The SDK is a SEPARATE repository, and it consumes
 * `@lablaunchpad/worker-runtime` **from npm**. Nothing under
 * `@lablaunchpad/*` has ever been published — the registry returns 404 for
 * all three packages. So until they are publishable, the entire SDK half of
 * the product has no substrate to build on, and the starter template's own
 * instruction to run `npx anyplugin` is a promise the registry cannot keep.
 *
 * One root cause. Three unlocks. This guard is the root cause's closure.
 *
 * ── What it does and does not claim ───────────────────────────────────────
 *
 * It checks that the packages are **publishable and publish the right
 * thing**. It does NOT publish anything, and it does not check that the
 * registry is reachable, that the npm account is authenticated, or that a
 * release happened. Those are a human's actions, and a guard that claimed
 * them would be claiming to verify something it cannot see.
 *
 * The decisive check is the **tarball**: `npm pack --dry-run --json` is the
 * registry's own packing logic, so what it lists is what npm would publish.
 * A manifest can look perfect and still ship the wrong bytes; the tarball
 * cannot lie about them.
 *
 * ── The rule this repository holds ─────────────────────────────────────────
 *
 * > A guard that can pass vacuously is worse than no guard, because it
 * > manufactures confidence.
 *
 * So the last test here proves the guard **can fail**: a deliberately broken
 * manifest must be rejected by the same predicate. A guard nobody has seen
 * reject anything is a guard nobody has seen work.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** The packages that will ever be installed from npm, in dependency order. */
const PUBLISHABLE = [
  { dir: "packages/worker-runtime", name: "@lablaunchpad/worker-runtime" },
  { dir: "core", name: "@lablaunchpad/core" },
  { dir: "cli", name: "@lablaunchpad/cli" },
] as const;

interface Manifest {
  name?: string;
  version?: string;
  description?: string;
  license?: string;
  repository?: { type?: string; url?: string; directory?: string };
  homepage?: string;
  bugs?: { url?: string };
  main?: string;
  types?: string;
  bin?: Record<string, string>;
  exports?: Record<string, { types?: string; default?: string } | string>;
  files?: string[];
  sideEffects?: unknown;
  publishConfig?: { access?: string };
  scripts?: Record<string, string>;
  engines?: { node?: string };
  dependencies?: Record<string, string>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8")) as Manifest;
}

/**
 * Every way a publishable package can be wrong.
 *
 * Returns the problems, so the same predicate serves the real check AND the
 * "the guard can fail" test. A predicate that only the real manifests pass
 * is a predicate that proves nothing.
 */
function problemsIn(dir: string, manifest: Manifest): string[] {
  const problems: string[] = [];
  const at = (field: string): string => `${manifest.name ?? dir}: ${field}`;

  if (!manifest.name?.startsWith("@lablaunchpad/")) problems.push(at("name must be scoped to @lablaunchpad"));
  if (!manifest.description) problems.push(at("description is required — it is the npm search result"));
  if (!manifest.license) problems.push(at("license is required — npm shows it on the package page"));
  if (!manifest.repository?.url) problems.push(at("repository is required — the package must point at its source"));
  if (!manifest.homepage) problems.push(at("homepage is required"));
  if (!manifest.bugs?.url) problems.push(at("bugs.url is required"));
  if (manifest.publishConfig?.access !== "public") {
    problems.push(at("publishConfig.access must be \"public\" — a scoped package is private by default"));
  }
  if (manifest.sideEffects !== false) {
    problems.push(at("sideEffects must be false — the package is pure, and bundlers need to know"));
  }
  if (manifest.version === "0.0.1") {
    problems.push(at("version 0.0.1 is a placeholder — npm versions are IMMUTABLE, so a placeholder would burn a real version"));
  }
  if (!manifest.version || !/^\d+\.\d+\.\d+/.test(manifest.version)) {
    problems.push(at("version must be a semantic version"));
  }

  const files = manifest.files ?? [];
  if (!files.includes("dist")) {
    problems.push(at("files must allow \"dist\" — the exports map points there"));
  }
  if (files.some((f) => f === "src" || f.startsWith("src/"))) {
    problems.push(at("files must NOT allow \"src\" — the sources are not the published artifact"));
  }
  if (!files.includes("README.md") || !files.includes("LICENSE")) {
    problems.push(at("files must allow README.md and LICENSE"));
  }
  if (!manifest.scripts?.["prepack"]) {
    problems.push(at("a prepack script is required — the tarball must never be built from a stale dist"));
  }
  if (!manifest.engines?.node) {
    problems.push(at("engines.node is required — the runtime surface has a floor"));
  }

  // The exports map must point inside the allowlist, or the published
  // package imports to nowhere.
  const targets: string[] = [];
  for (const value of Object.values(manifest.exports ?? {})) {
    if (typeof value === "string") targets.push(value);
    else if (value) {
      if (value.types) targets.push(value.types);
      if (value.default) targets.push(value.default);
    }
  }
  for (const target of targets) {
    const bare = target.replace(/^\.\//, "");
    const top = bare.split("/")[0]!;
    if (!files.includes(top)) {
      problems.push(at(`exports target "${target}" is not inside the files allowlist`));
    }
  }

  // The licence and the readme must sit IN the package directory: npm only
  // auto-includes a LICENSE that is next to the manifest.
  for (const required of ["LICENSE", "README.md"]) {
    if (!existsSync(join(REPO_ROOT, dir, required))) {
      problems.push(at(`${required} must exist in the package directory`));
    }
  }

  return problems;
}

/** The tarball npm would publish, straight from npm's own packing logic. */
/**
 * npm's own CLI, run with the SAME node binary that is running this test.
 *
 * A bare "npm" does not resolve through `execFileSync` on Windows — it is
 * `npm.cmd` — and the obvious workaround, `shell: true`, would hand an
 * argv to a shell. Running npm's CLI script with `process.execPath` avoids
 * both: no shell, no PATH lookup, and the npm that packs the tarball is the
 * npm that ships with the node under test.
 */
const NPM_CLI = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

function packedFiles(dir: string): string[] {
  const args = ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const raw = existsSync(NPM_CLI)
    ? execFileSync(process.execPath, [NPM_CLI, ...args], {
        cwd: join(REPO_ROOT, dir),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      })
    : execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
        cwd: join(REPO_ROOT, dir),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
  const parsed = JSON.parse(raw) as { files?: { path: string }[] }[];
  return (parsed[0]?.files ?? []).map((f) => f.path);
}

describe("publish readiness", () => {
  it("every publishable package declares its identity, licence and allowlist", () => {
    const problems: string[] = [];
    for (const pkg of PUBLISHABLE) {
      problems.push(...problemsIn(pkg.dir, readManifest(pkg.dir)));
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it(
    "the tarball ships the built package and nothing else",
    // P2-28 again: `npm pack` runs the registry's packing logic three
    // times here, and three subprocesses exceed vitest's default five
    // seconds on a loaded machine. A timeout there is a FALSE ALARM about
    // the guard, which is worse than no guard.
    { timeout: 120000 },
    () => {
      // `npm pack --dry-run` IS the registry's packing logic, so this is what
      // npm would publish — not an approximation of it.
      for (const pkg of PUBLISHABLE) {
        const files = packedFiles(pkg.dir);

        expect(files, `${pkg.name}: the tarball is empty`).not.toEqual([]);
        expect(files, `${pkg.name}: dist/index.js must ship`).toContain("dist/index.js");
        expect(files, `${pkg.name}: the type declarations must ship`).toContain("dist/index.d.ts");
        expect(files, `${pkg.name}: the README must ship`).toContain("README.md");
        expect(files, `${pkg.name}: the LICENSE must ship`).toContain("LICENSE");

        const leaks = files.filter(
          (f) =>
            f.startsWith("src/") ||
            f.includes(".test.") ||
            f.includes("tsbuildinfo") ||
            (f.endsWith(".ts") && !f.endsWith(".d.ts")),
        );
        expect(
          leaks,
          `${pkg.name}: the tarball ships source or compiled tests:\n  ${leaks.join("\n  ")}`,
        ).toEqual([]);
      }
    },
  );

  it("the guard CAN fail", () => {
    // A guard nobody has seen reject anything is a guard nobody has seen
    // work. A deliberately broken manifest must be rejected by the same
    // predicate that passes the real ones.
    const broken: Manifest = {
      name: "@lablaunchpad/broken",
      version: "0.0.1",
      files: ["src"],
      scripts: {},
    };
    const problems = problemsIn("core", broken);
    expect(problems.length, "a broken manifest must produce problems").toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/license/);
    expect(problems.join("\n")).toMatch(/publishConfig/);
    expect(problems.join("\n")).toMatch(/prepack/);
    expect(problems.join("\n")).toMatch(/0\.0\.1/);
  });

  it("no package is left half-published", () => {
    // Every package in the workspace that is NOT private must be one of the
    // three we know how to publish. A new package cannot appear without a
    // decision about how it ships.
    const workspaceRoot = join(REPO_ROOT, "packages");
    const known = new Set<string>(PUBLISHABLE.map((p) => p.name));
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestPath = join(dir, entry.name, "package.json");
        if (!existsSync(manifestPath)) continue;
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest & { private?: boolean };
        if (manifest.private) continue;
        found.push(manifest.name ?? manifestPath);
        walk(join(dir, entry.name));
      }
    };
    walk(workspaceRoot);
    expect(found.every((name) => known.has(name)), `unhandled publishable packages: ${found.filter((n) => !known.has(n)).join(", ")}`).toBe(true);
  });
});
