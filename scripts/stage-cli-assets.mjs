#!/usr/bin/env node
/**
 * Stage the assets the published CLI needs.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * `anyplugin init` needs the starter template, and `anyplugin build` needs
 * the dependency-free hook runtime. In the repository they live at the repo
 * root, and the CLI reached them by walking two directories up from `dist/`.
 *
 * That works in the repository and fails in the tarball: from
 * `node_modules/@lablaunchpad/cli/dist/`, two directories up is
 * `node_modules/@lablaunchpad/` — and nothing is there.
 *
 * The proof that this was a real defect, not a theory: the published
 * tarball installed cleanly, `detect` ran, and then `init`, `build` and
 * `install` ALL failed with a missing file. A package that installs and
 * then cannot do its job is worse than a package that does not install.
 *
 * ── What it does ───────────────────────────────────────────────────────────
 *
 * It copies the two assets INTO the CLI package, at pack time, so they are
 * in the tarball. The repository layout does not change: the CLI resolves
 * the package-local copy first and the repository copy second, so both
 * work.
 *
 * These are BUILD ARTEFACTS. They are gitignored, and `pnpm clean` removes
 * them.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "cli");

/** The dependency-free runtime files — the three that RUN, not the tests. */
const RUNTIME_FILES = ["runner.js", "mcp-server.js", "yaml-lite.js"];

function log(message) {
  console.log(`  ${message}`);
}

/* ── the starter template ────────────────────────────────────────────────── */

const templateSource = join(REPO_ROOT, "templates", "starter");
const templateTarget = join(CLI, "templates", "starter");

if (!existsSync(templateSource)) {
  console.error(`the starter template is missing: ${templateSource}`);
  process.exit(1);
}
rmSync(join(CLI, "templates"), { recursive: true, force: true });
mkdirSync(templateTarget, { recursive: true });
cpSync(templateSource, templateTarget, { recursive: true });
const templateFiles = readdirSync(templateTarget, { recursive: true }).filter((f) =>
  statSync(join(templateTarget, f)).isFile(),
);
log(`starter template -> cli/templates/starter (${templateFiles.length} files)`);

/* ── the hook runtime ─────────────────────────────────────────────────────── */

const runtimeSource = join(REPO_ROOT, "plugins", "knowledge", "runtime");
const runtimeTarget = join(CLI, "runtime");

rmSync(runtimeTarget, { recursive: true, force: true });
mkdirSync(runtimeTarget, { recursive: true });
for (const name of RUNTIME_FILES) {
  const from = join(runtimeSource, name);
  if (!existsSync(from)) {
    console.error(`the hook runtime file is missing: ${from}`);
    process.exit(1);
  }
  cpSync(from, join(runtimeTarget, name));
}
log(`hook runtime -> cli/runtime (${RUNTIME_FILES.length} files: ${RUNTIME_FILES.join(", ")})`);

console.log("  staged.");
