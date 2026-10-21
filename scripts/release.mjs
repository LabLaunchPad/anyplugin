#!/usr/bin/env node
/**
 * The guarded release.
 *
 * ── Why this is not `npm publish` ──────────────────────────────────────────
 *
 * Two tools, because each is good at one thing and bad at the other.
 *
 * **`pnpm` packs.** It understands `workspace:*`, and it rewrites those
 * specs to the concrete version the consumer will install. `npm pack` does
 * NOT: it leaves `"@lablaunchpad/core": "workspace:*"` in the published
 * manifest, and npm cannot resolve a `workspace:` spec for a consumer — the
 * package installs and then fails on its first `require`, in the CONSUMER's
 * project, which is the worst place for it to fail.
 *
 * **`npm` publishes.** `pnpm publish` has no provenance support, and npm's
 * provenance is the attestation that says which workflow published which
 * bytes. npm can publish a tarball, so: **pnpm packs, npm publishes the
 * tarball.** The published manifest is pnpm's, and the attestation is npm's.
 *
 * ── What it refuses to do ──────────────────────────────────────────────────
 *
 * - It refuses to publish a version that already exists on the registry.
 *   npm versions are IMMUTABLE; "fixing" a bad release means a new version,
 *   not a re-publish.
 * - It refuses to publish a package whose workspace dependencies are not
 *   themselves published. That is the failure mode that produces a CLI
 *   whose dependencies 404.
 * - It refuses to publish when the packed tarball leaks source, compiled
 *   tests, or build bookkeeping.
 * - It refuses to publish when the published manifest still carries a
 *   `workspace:` spec.
 * - It refuses to publish a version with no changelog entry.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/release.mjs --check      verify everything; publish nothing
 *   node scripts/release.mjs --publish    verify, then publish
 *   node scripts/release.mjs --inspect <dir>   print what a package would ship
 *
 * Exit codes: 0 = fine, 1 = a check failed, 2 = the command was wrong.
 */
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * THE RELEASE SET, in dependency order.
 *
 * The order is the point: a package is published only after everything it
 * depends on. The CLI depends on the core AND on four adapters, so
 * publishing the CLI without the adapters would ship a package whose
 * dependencies cannot be installed.
 */
const RELEASE_SET = [
  { dir: "core", name: "@lablaunchpad/core" },
  { dir: "adapters/claude", name: "@lablaunchpad/adapter-claude" },
  { dir: "adapters/opencode", name: "@lablaunchpad/adapter-opencode" },
  { dir: "adapters/codex", name: "@lablaunchpad/adapter-codex" },
  { dir: "adapters/antigravity", name: "@lablaunchpad/adapter-antigravity" },
  { dir: "packages/worker-runtime", name: "@lablaunchpad/worker-runtime" },
  { dir: "cli", name: "@lablaunchpad/cli" },
];

/* ── the tools ───────────────────────────────────────────────────────────── */

const { runPnpm, runNpm } = await import("./tooling.mjs");

/* ── a dependency-free tar reader ─────────────────────────────────────────── */

/**
 * Read one file out of a gzipped tar.
 *
 * The tar format is a sequence of 512-byte headers, each followed by the
 * file's bytes, padded to a 512-byte boundary. That is enough to read
 * `package/package.json` out of an npm tarball, and it costs thirty lines
 * instead of a dependency.
 */
function readFromTgz(tgzPath, wanted) {
  const tar = gunzipSync(readFileSync(tgzPath));
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (name === "") break;
    const sizeField = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = parseInt(sizeField, 8) || 0;
    const bodyStart = offset + 512;
    if (name === wanted) {
      return tar.subarray(bodyStart, bodyStart + size).toString("utf8");
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return undefined;
}

/* ── inspecting what a package would ship ────────────────────────────────── */

/** Pack a package with pnpm and report exactly what is in the tarball. */
function inspect(dir) {
  const abs = resolve(REPO_ROOT, dir);
  const stage = mkdtempSync(join(tmpdir(), "anyplugin-release-"));
  try {
    const out = runPnpm(["pack", "--pack-destination", stage], abs);
    // pnpm prints the tarball's ABSOLUTE path as the last line. Joining it
    // onto the stage directory would produce nonsense, because `path.join`
    // treats an absolute second argument as a segment, not a root.
    const filename = out.trim().split("\n").filter(Boolean).pop();
    const tgz = isAbsolute(filename) ? filename : join(stage, filename);
    if (!existsSync(tgz)) throw new Error(`pnpm pack did not produce a tarball in ${stage}`);

    const manifestText = readFromTgz(tgz, "package/package.json");
    const manifest = manifestText ? JSON.parse(manifestText) : undefined;

    // The file list, from the tarball itself rather than from a directory
    // walk: what the tarball holds is the thing that matters.
    const tar = gunzipSync(readFileSync(tgz));
    const files = [];
    let offset = 0;
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512);
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      if (name === "") break;
      const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim(), 8) || 0;
      files.push(name);
      offset = offset + 512 + Math.ceil(size / 512) * 512;
    }

    return { dir, tgz, filename, files, manifest };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** What a tarball must never contain. */
const LEAKS = {
  source: (f) => f.startsWith("package/src/"),
  compiledTest: (f) => f.includes(".test."),
  buildBookkeeping: (f) => f.includes("tsbuildinfo"),
  typescriptSource: (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
};

/** Every problem with one package's packed tarball. */
function tarballProblems(packed) {
  const problems = [];
  const files = packed.files.map((f) => f.replace(/^package\//, ""));

  for (const [name, isLeak] of Object.entries(LEAKS)) {
    const found = files.filter(isLeak);
    if (found.length > 0) {
      problems.push(`${packed.dir}: the tarball ships ${name} — ${found.slice(0, 3).join(", ")}${found.length > 3 ? ` (and ${found.length - 3} more)` : ""}`);
    }
  }

  for (const required of ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE"]) {
    if (!files.includes(required)) problems.push(`${packed.dir}: the tarball is missing ${required}`);
  }

  const deps = packed.manifest?.dependencies ?? {};
  const workspace = Object.entries(deps).filter(([, spec]) => String(spec).startsWith("workspace:"));
  if (workspace.length > 0) {
    problems.push(
      `${packed.dir}: the published manifest still carries a workspace spec — ${workspace.map(([n, s]) => `${n}: ${s}`).join(", ")}. Consumers cannot resolve it.`,
    );
  }

  return problems;
}

/* ── the registry ────────────────────────────────────────────────────────── */

/** The versions of a package that already exist on the registry. */
function publishedVersions(name) {
  try {
    const out = runNpm(["view", name, "versions", "--json"], REPO_ROOT);
    const parsed = JSON.parse(out);
    if (Array.isArray(parsed)) return parsed.map(String);
    if (typeof parsed === "string") return [parsed];
    return [];
  } catch (error) {
    // A 404 means the package has never been published. That is not an
    // error - it is the normal first-release state.
    const message = String(error.stderr ?? error.message ?? "");
    if (/E404|404 Not Found/i.test(message)) return [];
    throw error;
  }
}

/* ── the changelog ───────────────────────────────────────────────────────── */

function changelogVersions() {
  const text = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  return new Set([...text.matchAll(/^##\s+\[?(\d+\.\d+\.\d+)\]?/gm)].map((m) => m[1]));
}

/* ── the checks ──────────────────────────────────────────────────────────── */

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"));
}

/** Every problem with the release, across every package. */
function checkRelease() {
  const problems = [];
  const notes = [];
  const changelog = changelogVersions();
  const seen = new Set();

  for (const pkg of RELEASE_SET) {
    const manifest = manifestOf(pkg.dir);

    if (manifest.name !== pkg.name) {
      problems.push(`${pkg.dir}: the manifest says "${manifest.name}" but the release set says "${pkg.name}"`);
    }
    if (seen.has(manifest.name)) problems.push(`${pkg.dir}: "${manifest.name}" appears twice in the release set`);
    seen.add(manifest.name);

    if (!changelog.has(manifest.version)) {
      problems.push(`${pkg.dir}: version ${manifest.version} has no CHANGELOG.md entry`);
    }

    const packed = inspect(pkg.dir);
    problems.push(...tarballProblems(packed));
    notes.push(`${pkg.name}@${manifest.version} — ${packed.files.length} files, ${packed.filename}`);

    // The dependency order, checked against what is ALREADY published and
    // against what this release publishes before it.
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!String(spec).startsWith("workspace:")) continue;
      const earlier = RELEASE_SET.find((p) => p.name === dep);
      if (!earlier) {
        problems.push(`${pkg.dir}: depends on ${dep}, which is not in the release set at all`);
        continue;
      }
      const depVersion = manifestOf(earlier.dir).version;
      const already = publishedVersions(dep);
      if (already.length > 0 && !already.includes(depVersion)) {
        problems.push(
          `${pkg.dir}: depends on ${dep}@${depVersion}, but the registry has ${already.join(", ")} — the published version is what consumers will install`,
        );
      }
    }
  }

  // Every version must be new. npm versions are immutable.
  for (const pkg of RELEASE_SET) {
    const version = manifestOf(pkg.dir).version;
    const existing = publishedVersions(pkg.name);
    if (existing.includes(version)) {
      problems.push(`${pkg.name}: version ${version} is already on the registry, and npm versions are immutable`);
    } else if (existing.length > 0) {
      notes.push(`${pkg.name}: the registry already has ${existing.join(", ")}`);
    }
  }

  return { problems, notes };
}

/* ── the command ─────────────────────────────────────────────────────────── */

function publishAll(tag) {
  const args = ["publish", "--access", "public"];
  if (tag) args.push("--tag", tag);
  if (process.env.CI) {
    // In CI the git checks are not meaningful: the checkout is detached and
    // the commit is already merged.
    args.push("--no-git-checks");
  }
  for (const pkg of RELEASE_SET) {
    const abs = resolve(REPO_ROOT, pkg.dir);
    const stage = mkdtempSync(join(tmpdir(), "anyplugin-publish-"));
    try {
      const out = runPnpm(["pack", "--pack-destination", stage], abs);
      const filename = out.trim().split("\n").filter(Boolean).pop();
      const tgz = isAbsolute(filename) ? filename : join(stage, filename);
      if (!existsSync(tgz)) throw new Error(`pnpm pack did not produce a tarball in ${stage}`);
      console.log(`  publishing ${pkg.name} from ${basename(tgz)}`);
      // npm publishes the TARBALL, so the manifest pnpm rewrote is the one
      // that ships, and npm's provenance is the attestation.
      const publishArgs = [...args, tgz];
      if (process.env.CI && process.env.NPM_CONFIG_PROVENANCE !== "false") {
        publishArgs.push("--provenance");
      }
      runNpm(publishArgs, abs);
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");

  // The release set, as JSON. The publishing guard reads THIS, so the set
  // has one owner and cannot drift between the script that publishes and
  // the test that checks the publishing.
  if (args.includes("--release-set")) {
    console.log(JSON.stringify(RELEASE_SET, null, 2));
    return;
  }

  if (args.includes("--inspect")) {
    const dir = args[args.indexOf("--inspect") + 1];
    if (!dir) {
      console.error("--inspect needs a package directory");
      process.exit(2);
    }
    const packed = inspect(dir);
    const problems = tarballProblems(packed);
    if (json) {
      console.log(JSON.stringify({ dir: packed.dir, files: packed.files, manifest: packed.manifest, problems }, null, 2));
    } else {
      console.log(`${packed.dir}: ${packed.files.length} files`);
      for (const problem of problems) console.log(`  PROBLEM  ${problem}`);
      if (problems.length === 0) console.log("  no problems");
    }
    process.exit(problems.length > 0 ? 1 : 0);
  }

  const check = args.includes("--check");
  const publish = args.includes("--publish");
  if (!check && !publish) {
    console.log("usage: node scripts/release.mjs --check | --publish [--tag <tag>] [--json]");
    process.exit(2);
  }

  console.log("checking the release...");
  const { problems, notes } = checkRelease();
  for (const note of notes) console.log(`  ${note}`);
  if (problems.length > 0) {
    console.log("");
    for (const problem of problems) console.log(`  PROBLEM  ${problem}`);
    console.log(`\n${problems.length} problem(s). Nothing was published.`);
    process.exit(1);
  }
  console.log("\nno problems.");
  if (!publish) {
    console.log("run with --publish to publish");
    return;
  }

  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
  console.log(`\npublishing${tag ? ` under the "${tag}" tag` : ""}...`);
  publishAll(tag);
  console.log("\npublished.");
}

main(process.argv);
