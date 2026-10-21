/**
 * The publish-readiness guard.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * The SDK is a SEPARATE repository, and it consumes
 * `@lablaunchpad/worker-runtime` **from npm**. Nothing under
 * `@lablaunchpad/*` has ever been published — the registry returns 404 for
 * every one of them. So until they are publishable, the entire SDK half of
 * the product has no substrate to build on, and the starter template's own
 * instruction to run the tool with npx is a promise the registry cannot keep.
 *
 * One root cause. Several unlocks. This guard is the root cause's closure.
 *
 * ── The publisher is pnpm, and the proof is in the tarball ─────────────────
 *
 * The single most important thing this guard checks is that the PUBLISHED
 * MANIFEST carries no `workspace:` spec.
 *
 * `pnpm` rewrites `workspace:*` to the concrete version a consumer will
 * install. `npm` does not — it leaves the spec, and npm cannot resolve one
 * for a consumer, so the package installs and then fails on its first
 * `require`, in the CONSUMER's project. Publishing the CLI with `npm pack`
 * would have shipped exactly that, and the guard that checked `npm`'s
 * tarball would have said everything was fine.
 *
 * So the guard checks **pnpm's** tarball, because that is the artifact that
 * ships. And it reads the tarball's own `package.json`, not the manifest in
 * the working tree, because the working tree is not what is published.
 *
 * ── What it does and does not claim ───────────────────────────────────────
 *
 * It checks that the packages are **publishable and publish the right
 * thing**. It does NOT publish anything, and it does not check that the
 * registry is reachable, that the npm account is authenticated, or that a
 * release happened. Those are a human's actions, and a guard that claimed
 * them would be claiming to verify something it cannot see.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const RELEASE_TOOL = join(REPO_ROOT, "scripts", "release.mjs");

interface ReleasePackage {
  readonly dir: string;
  readonly name: string;
}

/** The release set, read from the tool that publishes it. One owner. */
function releaseSet(): ReleasePackage[] {
  const out = execFileSync(process.execPath, [RELEASE_TOOL, "--release-set"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(out) as ReleasePackage[];
}

interface InspectResult {
  readonly dir: string;
  readonly files: readonly string[];
  readonly manifest?: {
    readonly dependencies?: Record<string, string>;
  };
  readonly problems: readonly string[];
}

/**
 * What the release tool says a package would ship.
 *
 * MEMOIZED, because packing is not free: `pnpm pack` runs the package's
 * `prepack` hook, which is the build, and seven packages packed twice is
 * seventy seconds of the suite's time. The pack is a pure function of the
 * working tree, so one pack per package is enough — and the assertions
 * that use it are still independent.
 */
const packed = new Map<string, InspectResult>();

function inspect(dir: string): InspectResult {
  const cached = packed.get(dir);
  if (cached) return cached;
  const out = execFileSync(process.execPath, [RELEASE_TOOL, "--inspect", dir, "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  const result = JSON.parse(out) as InspectResult;
  packed.set(dir, result);
  return result;
}

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
    problems.push(at("a prepack script is required — the tarball must never be built from a stale build"));
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

describe("publish readiness", () => {
  const packages = releaseSet();

  it("the release set is not empty, and every package exists", () => {
    expect(packages.length, "the release set must not be empty").toBeGreaterThan(0);
    for (const pkg of packages) {
      expect(existsSync(join(REPO_ROOT, pkg.dir, "package.json")), `${pkg.dir} has no manifest`).toBe(true);
    }
  });

  it("every package in the release set declares its identity, licence and allowlist", () => {
    const problems: string[] = [];
    for (const pkg of packages) {
      problems.push(...problemsIn(pkg.dir, readManifest(pkg.dir)));
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it(
    "the tarball ships the built package and nothing else",
    // `pnpm pack` is the packer that produces the published artifact, and
    // it is the one that rewrites the workspace specs. Checking npm's
    // tarball instead would validate the wrong bytes.
    { timeout: 120_000 },
    () => {
      for (const pkg of packages) {
        const result = inspect(pkg.dir);
        const files = result.files.map((f) => f.replace(/^package\//, ""));

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

        expect(
          result.problems,
          `${pkg.name}: the release tool found problems:\n  ${result.problems.join("\n  ")}`,
        ).toEqual([]);
      }
    },
  );

  it(
    "the published manifest carries NO workspace spec",
    // P2-28 again: this packs seven packages, and packing runs the build.
    // A timeout here is a FALSE ALARM about the guard, which is worse than
    // no guard.
    { timeout: 120_000 },
    () => {
    // THE decisive check. `npm pack` leaves `"@lablaunchpad/core":
    // "workspace:*"` in the manifest, and npm cannot resolve a `workspace:`
    // spec for a consumer — the package installs and then fails on its
    // first `require`, in the CONSUMER's project. pnpm rewrites it; this
    // proves the rewrite happened in the artifact that ships.
    for (const pkg of packages) {
      const result = inspect(pkg.dir);
      const deps = result.manifest?.dependencies ?? {};
      const workspace = Object.entries(deps).filter(([, spec]) => String(spec).startsWith("workspace:"));
      expect(
        workspace,
        `${pkg.name}: the published manifest still carries ${JSON.stringify(workspace)}`,
      ).toEqual([]);
    }
  });

  it("every workspace dependency is itself in the release set", () => {
    // A package published before its dependencies would ship a package
    // whose dependencies 404 on install.
    const known = new Set<string>(packages.map((p) => p.name));
    for (const pkg of packages) {
      const manifest = readManifest(pkg.dir);
      for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
        if (!String(spec).startsWith("workspace:")) continue;
        expect(
          known.has(dep),
          `${pkg.name} depends on ${dep}, which is not in the release set — it would 404 for a consumer`,
        ).toBe(true);
      }
    }
  });

  it("no package is left half-published", () => {
    // Every package in the workspace that is NOT private must be one of the
    // ones we know how to publish. A new package cannot appear without a
    // decision about how it ships.
    const known = new Set<string>(packages.map((p) => p.name));
    const found: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const manifestPath = join(dir, entry.name, "package.json");
        if (!existsSync(manifestPath)) {
          walk(join(dir, entry.name));
          continue;
        }
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest & { private?: boolean };
        if (manifest.private) continue;
        found.push(manifest.name ?? manifestPath);
        walk(join(dir, entry.name));
      }
    };
    walk(join(REPO_ROOT, "packages"));
    walk(join(REPO_ROOT, "adapters"));
    walk(join(REPO_ROOT, "core"));
    walk(join(REPO_ROOT, "cli"));
    const unhandled = found.filter((n) => !known.has(n));
    expect(unhandled, `unhandled publishable packages: ${unhandled.join(", ")}`).toEqual([]);
  });

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
});
