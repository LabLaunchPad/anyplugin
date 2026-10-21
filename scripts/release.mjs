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
 * (Verified against npm 11.21.1's own source: `libnpmpack` does not re-run
 * `prepack` for a file spec, and `libnpmpublish`'s `patchManifest` does not
 * rewrite dependency specs, so pnpm's rewrite survives.)
 *
 * ── The rules ─────────────────────────────────────────────────────────────
 *
 * It refuses to publish:
 *
 *   - a tarball that leaks source, compiled tests, or build bookkeeping;
 *   - a tarball whose published manifest cannot be READ — a check that
 *     silently inspects nothing is worse than no check, because it reports
 *     "no problems" about a package it never looked at;
 *   - a published manifest that still carries a `workspace:` spec;
 *   - a published manifest that points at a file which is not in the
 *     tarball — the package installs and then fails on its first import;
 *   - a package whose workspace dependency is not EARLIER in the release
 *     set, because a package published before its dependencies ships one
 *     whose dependencies 404;
 *   - a version that is not a clean semantic version, or is `0.0.x`;
 *   - a version with no changelog entry; and
 *   - a release whose seven packages disagree about the version.
 *
 * It does NOT refuse to publish a version that is already on the registry.
 * It SKIPS it, and says so — because npm versions are immutable, so a
 * half-finished release must be RESUMABLE. A tool that can only ever
 * publish once is a tool that cannot survive a failure halfway.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   node scripts/release.mjs --check      verify everything; publish nothing
 *   node scripts/release.mjs --publish    verify, then publish what is missing
 *   node scripts/release.mjs --inspect <dir>   print what a package would ship
 *   node scripts/release.mjs --release-set      print the release set as JSON
 *
 * Exit codes: 0 = fine, 1 = a check failed, 2 = the command was wrong.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { runPnpm, runNpm } = await import("./tooling.mjs");

/**
 * THE RELEASE SET, in dependency order.
 *
 * The order is load-bearing, and it is ENFORCED: the check compares
 * indices, so a package whose dependency comes later in this list is a
 * problem, not a preference. The CLI depends on the core AND on four
 * adapters, so publishing the CLI without them would ship a package whose
 * dependencies 404 on install.
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

/* ── the tarball ─────────────────────────────────────────────────────────── */

/**
 * Pack a package with pnpm, ONCE.
 *
 * The tarball this returns is the artifact that is checked AND the artifact
 * that is published. Packing twice and checking one of them is how a guard
 * ends up describing bytes that were never shipped.
 */
function pack(dir) {
  const abs = resolve(REPO_ROOT, dir);
  const stage = mkdtempSync(join(tmpdir(), "anyplugin-release-"));
  const out = runPnpm(["pack", "--pack-destination", stage], abs);
  // pnpm prints the tarball's ABSOLUTE path as the last line.
  const filename = out.trim().split("\n").filter(Boolean).pop();
  const tgz = isAbsolute(filename) ? filename : join(stage, filename);
  if (!existsSync(tgz)) throw new Error(`pnpm pack did not produce a tarball in ${stage}`);
  return { tgz, filename: basename(tgz), stage };
}

/**
 * The tarball's own file list, read by `tar`.
 *
 * NOT a hand-written tar parser. A parser that reads only the 100-byte name
 * field loses the `prefix` of a long path, and the leak rules here are
 * prefix-based — so a source file at a path over 100 characters would ship
 * unnoticed. The same parser turns a PAX extended header into a phantom
 * file entry, and reads a base-256 size field as zero, which desynchronises
 * everything after it.
 *
 * `tar` is a system tool, not a dependency: it ships with every platform
 * this repository's CI runs on, and it is a correct implementation of the
 * format for free.
 */
function listTarball(tgz) {
  // No `-z`: bsdtar (which is what Windows ships) auto-detects the gzip
  // compression, and GNU tar does too on read. Passing `-z` to bsdtar is an
  // error, not a no-op.
  const out = execFileSync("tar", ["-tf", tgz], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
  // Split on CRLF as well as LF. bsdtar on Windows writes carriage returns,
  // and a filename that ends in "\r" matches nothing — so every entry-point
  // check fails, and every required file reads as missing. A check that is
  // wrong on one platform and right on another is worse than no check.
  return out.split(/\r?\n/).filter(Boolean);
}

/** One file out of the tarball. */
function readFromTarball(tgz, path) {
  try {
    return execFileSync("tar", ["-xOf", tgz, path], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
}

/**
 * What each package's tarball MUST contain.
 *
 * The CLI's list is longer because the CLI needs two assets that live
 * outside it in the repository: the starter template, and the
 * dependency-free hook runtime. A published CLI without them installs
 * cleanly and then cannot `init`, `build` or `install` — which is the
 * exact failure the end-to-end check exists to catch.
 */
const REQUIRED_IN_TARBALL = {
  cli: [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/bin.js",
    "README.md",
    "LICENSE",
    "templates/starter/anyplugin.plugin.yaml",
    "runtime/runner.js",
    "runtime/mcp-server.js",
    "runtime/yaml-lite.js",
  ],
};

/* ── inspecting what a package would ship ────────────────────────────────── */

/**
 * What a tarball must never contain.
 *
 * The names are RELATIVE to the package root — the `package/` prefix has
 * already been stripped. The first version of the `source` rule checked
 * for the prefix as well, so it could never fire: the rule was looking for
 * a name that the code had just removed. It was dead, and nothing said so.
 *
 * The self-test below is what found it.
 */
const LEAKS = {
  source: (f) => f.startsWith("src/"),
  compiledTest: (f) => f.includes(".test."),
  buildBookkeeping: (f) => f.includes("tsbuildinfo"),
  typescriptSource: (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"),
};

/**
 * Every problem with one package's packed tarball.
 *
 * Takes the tarball's OWN file list and the manifest READ OUT OF THE
 * TARBALL — not the manifest in the working tree, because the working tree
 * is not what is published.
 */
function tarballProblems(packed) {
  const problems = [];
  const files = packed.files.map((f) => f.replace(/^package\//, ""));

  if (files.length === 0) {
    problems.push(`${packed.dir}: the tarball is EMPTY`);
    return problems;
  }

  for (const [name, isLeak] of Object.entries(LEAKS)) {
    const found = files.filter(isLeak);
    if (found.length > 0) {
      problems.push(
        `${packed.dir}: the tarball ships ${name} — ${found.slice(0, 3).join(", ")}${found.length > 3 ? ` (and ${found.length - 3} more)` : ""}`,
      );
    }
  }

  for (const required of REQUIRED_IN_TARBALL[packed.dir] ?? ["dist/index.js", "dist/index.d.ts", "README.md", "LICENSE"]) {
    if (!files.includes(required)) problems.push(`${packed.dir}: the tarball is missing ${required}`);
  }

  // The manifest is MANDATORY.
  //
  // A check that cannot read the manifest would otherwise report "no
  // problems" about a package it never looked at — and the two checks that
  // protect the consumer (no workspace spec, entry points exist) both live
  // inside the manifest. A silent pass here is the exact outcome this whole
  // design exists to prevent.
  if (!packed.manifest) {
    problems.push(
      `${packed.dir}: the tarball's package.json could not be READ. The checks that protect a consumer live in that file, so this package cannot be cleared.`,
    );
    return problems;
  }

  const deps = packed.manifest.dependencies ?? {};
  const workspace = Object.entries(deps).filter(([, spec]) => String(spec).startsWith("workspace:"));
  if (workspace.length > 0) {
    problems.push(
      `${packed.dir}: the published manifest still carries a workspace spec — ${workspace.map(([n, s]) => `${n}: ${s}`).join(", ")}. Consumers cannot resolve it.`,
    );
  }

  // Every entry point must actually BE in the tarball.
  //
  // The manifest can point anywhere inside the allowlist and still be
  // wrong: `"./detect": "./dist/detect/index.js"` passes every other check
  // and installs a package whose first import fails — in the CONSUMER's
  // project, which is the worst place for it to fail, and the hardest to
  // diagnose from here.
  const entryPoints = new Set();
  const exportsMap = packed.manifest.exports ?? {};
  for (const value of Object.values(exportsMap)) {
    if (typeof value === "string") entryPoints.add(value);
    else if (value) {
      if (value.types) entryPoints.add(value.types);
      if (value.default) entryPoints.add(value.default);
    }
  }
  if (packed.manifest.main) entryPoints.add(packed.manifest.main);
  if (packed.manifest.types) entryPoints.add(packed.manifest.types);
  for (const bin of Object.values(packed.manifest.bin ?? {})) entryPoints.add(bin);

  for (const target of entryPoints) {
    const bare = target.replace(/^\.\//, "");
    if (!files.includes(bare)) {
      problems.push(
        `${packed.dir}: the published manifest points at "${target}", which is not in the tarball — a consumer's install would fail on its first import`,
      );
    }
  }

  return problems;
}

/** Pack, list, read the manifest, and judge one package. */
function inspect(dir) {
  const packed = pack(dir);
  try {
    const files = listTarball(packed.tgz);
    const manifestText = readFromTarball(packed.tgz, "package/package.json");
    const manifest = manifestText ? safeJson(manifestText) : undefined;
    const result = { dir, tgz: packed.tgz, filename: packed.filename, files, manifest };
    result.problems = tarballProblems(result);
    return result;
  } finally {
    rmSync(packed.stage, { recursive: true, force: true });
  }
}

/** JSON that does not parse is not a manifest. */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/* ── the registry ────────────────────────────────────────────────────────── */

/** The versions of a package that already exist on the registry. */
const registryCache = new Map();

function publishedVersions(name) {
  const cached = registryCache.get(name);
  if (cached) return cached;
  try {
    const out = runNpm(["view", name, "versions", "--json"], REPO_ROOT);
    const parsed = JSON.parse(out);
    let versions;
    if (Array.isArray(parsed)) versions = parsed.map(String);
    else if (typeof parsed === "string") versions = [parsed];
    else {
      // An unexpected shape is NOT "never published". Failing open here
      // would let the tool believe a published package is absent.
      throw new Error(`unexpected registry response for ${name}: ${out.slice(0, 120)}`);
    }
    registryCache.set(name, versions);
    return versions;
  } catch (error) {
    const message = String(error.stderr ?? error.message ?? "");
    // A 404 means the package has never been published. That is not an
    // error - it is the normal first-release state.
    if (/E404|404 Not Found/i.test(message)) {
      registryCache.set(name, []);
      return [];
    }
    // A network failure is NOT a 404, and must not be read as one.
    throw error;
  }
}

/* ── the changelog ───────────────────────────────────────────────────────── */

function changelogVersions() {
  const path = join(REPO_ROOT, "CHANGELOG.md");
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return new Set([...text.matchAll(/^##\s+\[?(\d+\.\d+\.\d+)\]?/gm)].map((m) => m[1]));
}

/* ── the checks ──────────────────────────────────────────────────────────── */

function manifestOf(dir) {
  return JSON.parse(readFileSync(join(REPO_ROOT, dir, "package.json"), "utf8"));
}

/** A clean semantic version, and not a placeholder. */
const CLEAN_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Every problem with the release, across every package.
 *
 * `notes` are things worth knowing that are not problems — most
 * importantly, the packages that are ALREADY on the registry, which are
 * skipped rather than refused. That is what makes a half-finished release
 * resumable.
 */
function checkRelease() {
  const problems = [];
  const notes = [];
  const changelog = changelogVersions();

  if (changelog === null) {
    problems.push("CHANGELOG.md is missing — a release must say what it contains");
  }

  // One version for the whole release.
  const versions = new Set(RELEASE_SET.map((pkg) => manifestOf(pkg.dir).version));
  if (versions.size > 1) {
    problems.push(
      `the release set disagrees about the version — ${RELEASE_SET.map((p) => `${p.name}: ${manifestOf(p.dir).version}`).join(", ")}. One release, one version.`,
    );
  }
  const releaseVersion = [...versions][0];

  for (const pkg of RELEASE_SET) {
    const manifest = manifestOf(pkg.dir);
    const index = RELEASE_SET.indexOf(pkg);

    if (manifest.name !== pkg.name) {
      problems.push(`${pkg.dir}: the manifest says "${manifest.name}" but the release set says "${pkg.name}"`);
    }

    if (!CLEAN_SEMVER.test(manifest.version ?? "")) {
      problems.push(
        `${pkg.dir}: version "${manifest.version}" is not a clean semantic version — npm refuses one it cannot parse, and a prerelease needs an explicit tag`,
      );
    }
    if ((manifest.version ?? "").startsWith("0.0.")) {
      problems.push(
        `${pkg.dir}: version ${manifest.version} is a placeholder — npm versions are IMMUTABLE, so a placeholder burns a real version number`,
      );
    }
    if (changelog !== null && !changelog.has(manifest.version)) {
      problems.push(`${pkg.dir}: version ${manifest.version} has no CHANGELOG.md entry`);
    }

    const packed = inspect(pkg.dir);
    problems.push(...tarballProblems(packed));
    // What was inspected, not just that it was clean. A check that reports
    // only "no problems" leaves the reader with nothing to weigh.
    notes.push(
      `${pkg.name}@${manifest.version} — ${packed.files.length} files, ${packed.filename}`,
    );

    // The dependency ORDER, enforced by index.
    for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
      if (!String(spec).startsWith("workspace:")) continue;
      const depIndex = RELEASE_SET.findIndex((p) => p.name === dep);
      if (depIndex < 0) {
        problems.push(`${pkg.dir}: depends on ${dep}, which is not in the release set at all`);
        continue;
      }
      if (depIndex >= index) {
        problems.push(
          `${pkg.dir}: depends on ${dep}, which comes LATER in the release set — a package published before its dependencies ships one whose dependencies 404`,
        );
      }
    }

    // Already on the registry: a SKIP, not a problem. npm versions are
    // immutable, so a release that was interrupted halfway must be
    // resumable, and the only way it can be is if this is not an error.
    const existing = publishedVersions(pkg.name);
    if (existing.includes(manifest.version)) {
      notes.push(`${pkg.name}@${manifest.version} is already published — it will be SKIPPED`);
    } else if (existing.length > 0) {
      notes.push(`${pkg.name}: the registry already has ${existing.join(", ")}`);
    }
  }

  return { problems, notes, releaseVersion };
}

/* ── the command ─────────────────────────────────────────────────────────── */

function publishAll({ tag, allowUnprovenanced }) {
  // The tarball is packed ONCE, checked, and published. Checking one
  // artifact and publishing another is how a guard ends up describing bytes
  // that were never shipped.
  const stage = mkdtempSync(join(tmpdir(), "anyplugin-publish-"));
  const landed = [];
  const skipped = [];
  const failed = [];

  try {
    for (const pkg of RELEASE_SET) {
      const abs = resolve(REPO_ROOT, pkg.dir);
      const manifest = manifestOf(pkg.dir);
      const version = manifest.version;

      const existing = publishedVersions(pkg.name);
      if (existing.includes(version)) {
        skipped.push(`${pkg.name}@${version}`);
        console.log(`  SKIP     ${pkg.name}@${version} — already on the registry`);
        continue;
      }

      const out = runPnpm(["pack", "--pack-destination", stage], abs);
      const filename = out.trim().split("\n").filter(Boolean).pop();
      const tgz = isAbsolute(filename) ? filename : join(stage, filename);
      if (!existsSync(tgz)) throw new Error(`pnpm pack did not produce a tarball for ${pkg.name}`);

      // THE SAME TARBALL is checked and then published.
      const files = listTarball(tgz);
      const manifestText = readFromTarball(tgz, "package/package.json");
      const packed = { dir: pkg.dir, tgz, filename: basename(tgz), files, manifest: manifestText ? safeJson(manifestText) : undefined };
      const problems = tarballProblems(packed);
      if (problems.length > 0) {
        failed.push(`${pkg.name}@${version}`);
        for (const problem of problems) console.log(`  PROBLEM  ${problem}`);
        break;
      }

      console.log(`  publishing ${pkg.name}@${version} from ${basename(tgz)}`);
      const publishArgs = ["publish", "--access", "public"];
      if (tag) publishArgs.push("--tag", tag);
      if (process.env.CI && !allowUnprovenanced) publishArgs.push("--provenance");
      try {
        runNpm([...publishArgs, tgz], abs);
        landed.push(`${pkg.name}@${version}`);
      } catch (error) {
        failed.push(`${pkg.name}@${version}`);
        console.log(`  FAILED   ${pkg.name}@${version}`);
        console.log(String(error.stderr ?? error.message ?? "").split("\n").slice(0, 6).join("\n"));
        break;
      }
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }

  console.log("");
  console.log(`  landed:  ${landed.length ? landed.join(", ") : "(none)"}`);
  console.log(`  skipped: ${skipped.length ? skipped.join(", ") : "(none)"}`);
  console.log(`  failed:  ${failed.length ? failed.join(", ") : "(none)"}`);

  if (failed.length > 0) {
    console.log("");
    console.log("  The release is INCOMPLETE, and it is RESUMABLE: run it again and it");
    console.log("  skips what landed and publishes what did not. npm versions are");
    console.log("  immutable, so nothing needs to be taken back.");
  }
  return { landed, skipped, failed };
}

/**
 * The tarball rules, proved to be able to fail.
 *
 * Every rule here protects a consumer, and every one of them passed for a
 * release whose `init`, `build` and `install` all failed. A rule that has
 * never rejected anything is a rule nobody has seen work — so each one is
 * fired against a tarball that breaks exactly that rule, and the expected
 * problem must appear.
 *
 * It is cheap because it never packs anything: the rules take the tarball's
 * file list and its manifest, and both can be constructed.
 */
function selfTest() {
  const cases = [];
  const good = {
    dir: "example",
    files: [
      "package/dist/index.js",
      "package/dist/index.d.ts",
      "package/README.md",
      "package/LICENSE",
    ],
    manifest: {
      main: "./dist/index.js",
      types: "./dist/index.d.ts",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      dependencies: {},
    },
  };

  const expectProblem = (name, packed, pattern) => {
    const problems = tarballProblems(packed);
    const fired = problems.some((p) => pattern.test(p));
    cases.push({ name, fired, problems });
  };

  // A clean tarball has no problems.
  cases.push({ name: "a clean tarball has no problems", fired: tarballProblems(good).length === 0, problems: tarballProblems(good) });

  // The rule that protects the consumer's first import.
  expectProblem(
    "an entry point that is not in the tarball",
    { ...good, manifest: { ...good.manifest, main: "./dist/DOES_NOT_EXIST.js" } },
    /not in the tarball/,
  );

  // The rule that protects a consumer from a workspace spec.
  expectProblem(
    "a workspace spec in the published manifest",
    { ...good, manifest: { ...good.manifest, dependencies: { "@lablaunchpad/core": "workspace:*" } } },
    /workspace spec/,
  );

  // The rules that keep source out of the tarball.
  expectProblem("source in the tarball", { ...good, files: [...good.files, "package/src/index.ts"] }, /source/);
  expectProblem("a compiled test in the tarball", { ...good, files: [...good.files, "package/dist/index.test.js"] }, /compiledTest/);
  expectProblem("build bookkeeping in the tarball", { ...good, files: [...good.files, "package/tsconfig.tsbuildinfo"] }, /buildBookkeeping/);

  // A missing required file.
  expectProblem("a required file missing", { ...good, files: good.files.slice(0, 2) }, /missing/);

  // An empty tarball.
  expectProblem("an empty tarball", { ...good, files: [] }, /EMPTY/);

  // A manifest that cannot be read — the silent-pass case.
  expectProblem("a manifest that cannot be read", { ...good, manifest: undefined }, /could not be READ/);

  const failed = cases.filter((c) => !c.fired);
  for (const c of cases) {
    console.log(`  ${c.fired ? "fires  " : "SILENT"}  ${c.name}`);
  }
  if (failed.length > 0) {
    console.log(`\n${failed.length} rule(s) did not fire. A rule that cannot fail is worse than no rule.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nall ${cases.length} tarball rules fire.`);
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

  // The tarball rules, proved to be able to fail.
  if (args.includes("--self-test")) {
    selfTest();
    return;
  }

  if (args.includes("--inspect")) {
    const dir = args[args.indexOf("--inspect") + 1];
    if (!dir) {
      console.error("--inspect needs a package directory");
      process.exit(2);
    }
    const packed = inspect(dir);
    if (json) {
      console.log(
        JSON.stringify({ dir: packed.dir, files: packed.files, manifest: packed.manifest, problems: packed.problems }, null, 2),
      );
    } else {
      console.log(`${packed.dir}: ${packed.files.length} files`);
      for (const problem of packed.problems) console.log(`  PROBLEM  ${problem}`);
      if (packed.problems.length === 0) console.log("  no problems");
    }
    process.exit(packed.problems.length > 0 ? 1 : 0);
  }

  const check = args.includes("--check");
  const publish = args.includes("--publish");
  if (!check && !publish) {
    console.log("usage: node scripts/release.mjs --check | --publish [--tag <tag>] [--json]");
    process.exit(2);
  }

  console.log("checking the release...");
  const { problems, notes, releaseVersion } = checkRelease();
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

  // Provenance is the point of publishing from CI, and a release without it
  // is a release whose provenance is "somebody's laptop". The tool refuses
  // to do that by accident: it takes an explicit, named acknowledgement.
  const allowUnprovenanced = args.includes("--i-accept-no-provenance");
  if (!process.env.CI && !allowUnprovenanced) {
    console.log("");
    console.log("  REFUSING to publish outside CI: the artifact would carry no");
    console.log("  provenance attestation, and the whole reason the release runs in");
    console.log("  CI is that the registry can say which workflow published it.");
    console.log("");
    console.log("  If you mean it, run it again with --i-accept-no-provenance.");
    process.exit(1);
  }

  const tagIndex = args.indexOf("--tag");
  const tag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;

  // A tag that does not match the version publishes the wrong thing under
  // the right name.
  const gitTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
  if (gitTag) {
    const expected = `v${releaseVersion}`;
    if (gitTag !== expected) {
      console.log("");
      console.log(`  REFUSING to publish: the tag is "${gitTag}" and the packages are "${releaseVersion}".`);
      console.log(`  The tag must be "${expected}" — a mistyped tag publishes the wrong`);
      console.log("  version under a name that says otherwise.");
      process.exit(1);
    }
  }

  console.log(`\npublishing${tag ? ` under the "${tag}" tag` : ""}...`);
  const outcome = publishAll({ tag, allowUnprovenanced });
  if (outcome.failed.length > 0) process.exit(1);
  console.log("\npublished.");
}

main(process.argv);
