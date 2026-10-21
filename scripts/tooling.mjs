import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Resolve the npm and pnpm CLIs and run them WITHOUT a shell.
 *
 * `execFileSync("pnpm", ...)` fails on Windows: the shim is `pnpm.cmd`, and
 * Windows cannot execute a `.cmd` without a shell. The obvious workaround,
 * `shell: true`, hands an argv to a shell — and this repository's own rule
 * is that a spawn never goes through a shell.
 *
 * So both tools are resolved to their JavaScript entry points and run with
 * the SAME node binary that is running the script. No shell, no PATH
 * lookup, and the pnpm that packs the tarball is the pnpm that ships
 * alongside the node under test.
 */
export function npmCli() {
  return join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
}

/** The global npm root, resolved by npm itself. */
export function globalRoot() {
  return execFileSync(process.execPath, [npmCli(), "root", "-g"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** pnpm's JavaScript entry point, or undefined when pnpm is not installed. */
export function pnpmCli() {
  const candidates = [
    join(globalRoot(), "pnpm", "bin", "pnpm.cjs"),
    join(dirname(process.execPath), "node_modules", "pnpm", "bin", "pnpm.cjs"),
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  return undefined;
}

/**
 * Run pnpm in a directory and return its stdout.
 *
 * stderr is captured separately: pnpm's lifecycle scripts (`prepack`) write
 * their own output there, and it must not be mistaken for the command's
 * result.
 */
export function runPnpm(args, cwd) {
  const cli = pnpmCli();
  if (!cli) throw new Error("pnpm is not installed, or its CLI could not be located");
  return execFileSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Run npm in a directory and return its stdout. */
export function runNpm(args, cwd) {
  return execFileSync(process.execPath, [npmCli(), ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}
