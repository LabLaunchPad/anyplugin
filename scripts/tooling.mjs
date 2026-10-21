import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve the npm and pnpm CLIs and run them WITHOUT a shell.
 *
 * ── Why not `execFileSync("pnpm", ...)` ────────────────────────────────────
 *
 * On Windows the shim is `pnpm.cmd`, and Windows cannot execute a `.cmd`
 * without a shell. The obvious workaround, `shell: true`, hands an argv to
 * a shell — and this repository's own rule is that a spawn never goes
 * through a shell.
 *
 * On POSIX there is no shim: the tool is a plain executable on PATH, and
 * running it DIRECTLY is both correct and faster.
 *
 * ── The two layouts that broke it ──────────────────────────────────────────
 *
 * The first version of this looked for npm in ONE place, and it was the
 * Windows place. The GitHub runners use the POSIX layout, where npm sits
 * one level up from the node binary rather than beside it, and the guard
 * failed there — which is the good kind of failure, because it was caught
 * by CI rather than by a consumer's install.
 *
 * And pnpm itself may have NO JavaScript entry point at all: the CI action
 * installs it as a standalone binary. So the JavaScript route is a
 * FALLBACK, and the direct route is the primary one.
 */
const RUN_OPTIONS = {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  maxBuffer: 64 * 1024 * 1024,
  // A registry call that hangs must fail the release rather than hang it.
  // npm versions are immutable: a half-published release is worse than no
  // release, so the tool must never wait forever.
  timeout: 300_000,
};

/** npm's JavaScript entry point, in either of its two layouts. */
export function npmCli() {
  const candidates = [
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    join(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new Error(`npm's CLI could not be located near ${process.execPath}`);
}

/** The global npm root, resolved by npm itself. */
export function globalRoot() {
  return execFileSync(process.execPath, [npmCli(), "root", "-g"], RUN_OPTIONS).trim();
}

/**
 * pnpm's JavaScript entry point, when it has one.
 *
 * `npm_execpath` points at the CLI that launched the current process, which
 * is pnpm when the script is run under pnpm. It is only usable when it is
 * a JavaScript file: a standalone pnpm binary is not one.
 */
export function pnpmCli() {
  const candidates = [];
  const execPath = process.env.npm_execpath;
  // The BASENAME must be pnpm's entry point. A loose match on the whole
  // path would treat `C:\projects\pnpm-tools\anything.js` as pnpm itself.
  if (execPath && /(^|[\\/])pnpm(\.[cm]?js)?$/i.test(execPath)) {
    candidates.push(execPath);
  }
  candidates.push(join(dirname(process.execPath), "node_modules", "pnpm", "bin", "pnpm.cjs"));
  try {
    candidates.push(join(globalRoot(), "pnpm", "bin", "pnpm.cjs"));
  } catch {
    // npm's CLI could not be found; the candidates above may still work.
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return undefined;
}

/**
 * Run a tool, preferring its JavaScript entry point and falling back to the
 * plain executable.
 *
 * The fallback is not a fallback for convenience: on POSIX the plain
 * executable is the RIGHT way to run a standalone pnpm, and on Windows the
 * JavaScript entry point is the only way to run pnpm at all without a
 * shell.
 */
function run(command, cli, args, cwd) {
  if (!cli) return execFileSync(command, args, { ...RUN_OPTIONS, cwd });
  try {
    return execFileSync(process.execPath, [cli, ...args], { ...RUN_OPTIONS, cwd });
  } catch (error) {
    // ENOENT means the JavaScript route is not usable here — not that the
    // tool failed. Any other error is the tool's own failure and is
    // re-thrown.
    if (error.code !== "ENOENT") throw error;
    // The fallback runs the tool as a plain executable. On POSIX that is a
    // real binary and no shell is involved. On Windows it would be a `.cmd`
    // shim, which Windows can only run THROUGH cmd.exe — and this file
    // exists to avoid exactly that. So on Windows the fallback is refused
    // rather than taken.
    if (process.platform === "win32") {
      throw new Error(
        `${command} could not be run through its JavaScript entry point, and on Windows the command shim would need a shell.`,
      );
    }
    return execFileSync(command, args, { ...RUN_OPTIONS, cwd });
  }
}

/** Run pnpm in a directory and return its stdout. */
export function runPnpm(args, cwd) {
  return run("pnpm", pnpmCli(), args, cwd);
}

/** Run npm in a directory and return its stdout. */
export function runNpm(args, cwd) {
  return run("npm", npmCli(), args, cwd);
}
