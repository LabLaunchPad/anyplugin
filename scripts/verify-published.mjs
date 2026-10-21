#!/usr/bin/env node
/**
 * Verify the PUBLISHED artifact — by installing it and running it.
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * Every other check in this repository inspects **bytes**: the manifest's
 * shape, the tarball's file list, whether an entry point is present. And
 * every one of them passed for a release whose `init`, `build` and `install`
 * all failed — because the CLI reached two assets by walking two
 * directories up, which is the repository root and not the installed
 * package.
 *
 * The proof was simple and it should have been the first check: pack the
 * packages, install the tarballs into a throwaway directory OUTSIDE the
 * repository, and run the commands a consumer would run.
 *
 * > **The guard must install the tarball and run it.** Every check that
 * > inspects bytes will keep passing a broken release, and a guard that
 * > manufactures confidence is worse than no guard.
 *
 * ── What it does ───────────────────────────────────────────────────────────
 *
 *   1. packs every package in the release set, with pnpm;
 *   2. installs the tarballs into a temp directory outside the repository;
 *   3. runs `init`, `build`, `install` and `uninstall` from the INSTALLED
 *      package — no repository, no workspace, no local links;
 *   4. asserts each one exits 0; and
 *   5. leaves the temp directory behind on failure, with its path printed,
 *      because the failure is worth looking at.
 *
 * Exit codes: 0 = the published artifact works, 1 = it does not.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { runPnpm, runNpm } = await import("./tooling.mjs");

const RELEASE_SET = [
  { dir: "core", name: "@lablaunchpad/core" },
  { dir: "adapters/claude", name: "@lablaunchpad/adapter-claude" },
  { dir: "adapters/opencode", name: "@lablaunchpad/adapter-opencode" },
  { dir: "adapters/codex", name: "@lablaunchpad/adapter-codex" },
  { dir: "adapters/antigravity", name: "@lablaunchpad/adapter-antigravity" },
  { dir: "packages/worker-runtime", name: "@lablaunchpad/worker-runtime" },
  { dir: "cli", name: "@lablaunchpad/cli" },
];

/**
 * Run npm and report what it did, without throwing.
 *
 * Through the resolved CLI rather than the bare command: on Windows `npm`
 * is a `.cmd` shim, and a shim cannot be executed without a shell.
 */
function tryNpm(args, cwd) {
  try {
    const out = runNpm(args, cwd);
    return { ok: true, code: 0, output: out };
  } catch (error) {
    return {
      ok: false,
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}\n${error.stderr ?? error.message ?? ""}`,
    };
  }
}

/** Run a command and report what it did, without throwing. */
function tryRun(command, args, cwd) {
  try {
    const out = execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      timeout: 300_000,
    });
    return { ok: true, code: 0, output: out };
  } catch (error) {
    return {
      ok: false,
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
    };
  }
}

/** The installed CLI's entry point. */
function installedCli(home) {
  return join(home, "node_modules", "@lablaunchpad", "cli", "dist", "bin.js");
}

function main() {
  const stage = mkdtempSync(join(tmpdir(), "anyplugin-verify-stage-"));
  const consumer = mkdtempSync(join(tmpdir(), "anyplugin-verify-consumer-"));
  const failures = [];
  let keep = false;

  try {
    console.log("packing the release set...");
    const tarballs = [];
    for (const pkg of RELEASE_SET) {
      const out = runPnpm(["pack", "--pack-destination", stage], resolve(REPO_ROOT, pkg.dir));
      const filename = out.trim().split("\n").filter(Boolean).pop();
      tarballs.push(filename);
      console.log(`  ${pkg.name}`);
    }

    console.log(`\ninstalling ${tarballs.length} tarballs into a directory outside the repository...`);
    console.log(`  ${consumer}`);
    writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "consumer", private: true, version: "0.0.0" }, null, 2), "utf8");
    const install = tryNpm(["install", "--no-audit", "--no-fund", ...tarballs], consumer);
    if (!install.ok) {
      failures.push(`the tarballs did not install:\n${install.output.slice(-800)}`);
    } else {
      console.log("  installed");
    }

    const cli = installedCli(consumer);
    if (!existsSync(cli)) {
      failures.push(`the installed CLI has no entry point at ${cli}`);
    } else {
      console.log("\nrunning the INSTALLED package, the way a consumer runs it...");

      // 1. init — scaffolds a plugin from the bundled starter template.
      const init = tryRun("node", [cli, "init", "--name", "verify"], consumer);
      if (!init.ok) failures.push(`init failed:\n${init.output.slice(-800)}`);
      else console.log("  init      ok");

      const pluginDir = join(consumer, "verify");

      // 2. build — compiles the manifest into native bundles for every agent.
      const build = tryRun("node", [cli, "build", "--plugin", pluginDir], consumer);
      if (!build.ok) failures.push(`build failed:\n${build.output.slice(-800)}`);
      else console.log("  build     ok");

      // 3. install — installs into a throwaway home.
      const home = join(consumer, "home");
      const project = join(consumer, "project");
      const installCmd = tryRun(
        "node",
        [cli, "install", "--plugin", pluginDir, "--home", home, "--project", project],
        consumer,
      );
      if (!installCmd.ok) failures.push(`install failed:\n${installCmd.output.slice(-800)}`);
      else console.log("  install   ok");

      // 4. uninstall — restores the bytes.
      const uninstall = tryRun(
        "node",
        [cli, "uninstall", "--plugin", pluginDir, "--home", home, "--project", project],
        consumer,
      );
      if (!uninstall.ok) failures.push(`uninstall failed:\n${uninstall.output.slice(-800)}`);
      else console.log("  uninstall ok");
    }
  } catch (error) {
    failures.push(`the verification itself failed:\n${String(error.stderr ?? error.message).slice(-800)}`);
    keep = true;
  }

  console.log("");
  if (failures.length === 0) {
    rmSync(stage, { recursive: true, force: true });
    rmSync(consumer, { recursive: true, force: true });
    console.log("the PUBLISHED artifact works: init, build, install and uninstall all ran from an");
    console.log("installed tarball, outside the repository, with no workspace and no local links.");
    return;
  }

  keep = true;
  console.log("the PUBLISHED artifact does NOT work:");
  for (const failure of failures) console.log(`\n  ${failure}`);
  console.log(`\n  the install is left at ${consumer}`);
  console.log(`  the tarballs are left at ${stage}`);
  process.exitCode = 1;
}

main();
