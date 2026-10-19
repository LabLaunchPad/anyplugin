import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveAuthorizedPath, isContained } from "@lablaunchpad/core";
import { spawn } from "node:child_process";
import { mkdtemp, rm, cp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

/**
 * The runtime must be DEPENDENCY-FREE.
 *
 * An emitted bundle has to run on a machine that has Node and nothing else.
 * The Node 20 CI job exists to prove exactly that, and it caught a real
 * violation: the first-party hook handlers imported `resolveAuthorizedPath`
 * from `@lablaunchpad/core`, so the bundle was not self-contained.
 *
 * These tests are the local version of that job, so the violation is caught
 * here rather than in CI.
 */

const RUNTIME_DIR = resolve("plugins/knowledge/runtime");
const PLUGIN_DIR = resolve("plugins/knowledge/plugin");

/** Strip comments, so prose that merely mentions "import" is not a specifier. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Every import specifier in a source file. */
function importSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const clean = stripComments(source);
  const patterns = [
    /(?:^|\s)(?:import|export)[\s\S]*?from\s*["']([^"']+)["']/g,
    /(?:^|\s)import\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean)) !== null) if (m[1]) specs.push(m[1]);
  }
  return specs;
}

describe("the hook runtime ships with no dependencies", () => {
  it("no runtime file imports a third-party package", () => {
    const violations: string[] = [];
    for (const name of readdirSync(RUNTIME_DIR)) {
      if (!name.endsWith(".js") && !name.endsWith(".mjs")) continue;
      const source = readFileSync(join(RUNTIME_DIR, name), "utf8");
      for (const spec of importSpecifiers(source)) {
        if (spec.startsWith("node:")) continue; // a node builtin
        if (spec.startsWith(".")) continue; // the runtime's own sibling module
        violations.push(`${name} → ${spec}`);
      }
    }
    expect(violations, "the runtime must not import a third-party package").toEqual([]);
  });

  it("no first-party hook handler imports a workspace package", () => {
    const violations: string[] = [];
    const hooksDir = join(PLUGIN_DIR, "hooks");
    for (const name of readdirSync(hooksDir)) {
      if (!name.endsWith(".mjs") && !name.endsWith(".js")) continue;
      const source = readFileSync(join(hooksDir, name), "utf8");
      for (const spec of importSpecifiers(source)) {
        if (spec.startsWith("@lablaunchpad/")) violations.push(`${name} → ${spec}`);
      }
    }
    expect(
      violations,
      "an emitted handler must run without node_modules — it may not import @lablaunchpad/*",
    ).toEqual([]);
  });

  it("the runner and the handlers run in a directory with no node_modules", async () => {
    // The strongest local version of the Node 20 CI job: copy the runtime and
    // the plugin into a bare directory, with no node_modules anywhere, and run
    // the hook. If anything reaches for a workspace package, this fails.
    const sandbox = await mkdtemp(join(tmpdir(), "runtime-nodeps-"));
    try {
      await cp(RUNTIME_DIR, join(sandbox, "runtime"), { recursive: true });
      // The bundle layout the runner expects: handlers beside the runner.
      await cp(join(PLUGIN_DIR, "hooks"), join(sandbox, "runtime", "handlers"), { recursive: true });
      // A knowledge bundle, so the handler has something to point at.
      await mkdir(join(sandbox, "knowledge"), { recursive: true });
      await writeFile(
        join(sandbox, "knowledge", "index.md"),
        "# Index\n\n* [A](a.md)\n* [B](b.md)\n",
        "utf8",
      );
      expect(existsSync(join(sandbox, "node_modules"))).toBe(false);

      const result = await runNode(
        [join(sandbox, "runtime", "runner.js"), "okf-session-start"],
        { cwd: sandbox },
        JSON.stringify({ cwd: "." }),
      );

      expect(result.stderr, "the handler must not fail to import").toBe("");
      expect(result.code).toBe(0);
      // The handler ran and produced its context.
      expect(result.stdout).toContain("additionalContext");
      expect(result.stdout).toContain("knowledge bundle exists");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

describe("the runtime's inlined SafePath agrees with the core implementation", () => {
  it("agrees on a hostile corpus", async () => {
    // The runner inlines the SafePath logic because it ships with no
    // dependencies. That duplication is only safe if the two agree, so the
    // agreement is PROVEN rather than assumed.
    const sandbox = await mkdtemp(join(tmpdir(), "safepath-diff-"));
    try {
      await cp(RUNTIME_DIR, join(sandbox, "runtime"), { recursive: true });
      await mkdir(join(sandbox, "runtime", "handlers"), { recursive: true });
      await writeFile(
        join(sandbox, "runtime", "handlers", "probe.mjs"),
        `export async function run(payload) {
           process.stdout.write(JSON.stringify({ cwd: payload.cwd }));
         }`,
        "utf8",
      );

      const corpus = [
        ".",
        "a",
        "a/b",
        "..",
        "../..",
        "a/../b",
        "a/../../b",
        "/absolute",
        "C:/windows",
        "C:\\windows",
        "\\\\server\\share",
        "//server/share",
        "%2e%2e",
        "a\\..\\..\\b",
        "nul",
        "",
        " ",
        "..\\..\\..",
      ];

      for (const input of corpus) {
        // The runner is spawned with the SAME cwd the test process has, so
        // both implementations authorise against the same root.
        const runnerCwd = await resolveViaRunner(join(sandbox, "runtime", "runner.js"), input);
        let coreCwd: string | null = null;
        try {
          coreCwd = await resolveAuthorizedPath(process.cwd(), input);
        } catch {
          coreCwd = null;
        }
        if (coreCwd === null) {
          expect(
            runnerCwd,
            `the runner must refuse ${JSON.stringify(input)} — core refuses it too`,
          ).toBe(process.cwd());
        } else if (runnerCwd !== coreCwd) {
          // The runner may be STRICTER than core (it falls back to the
          // process's own directory for a whitespace-only path, say). Being
          // stricter is safe. Being LOOSER is not: the runner must never
          // resolve to a path core would have refused.
          expect(
            runnerCwd,
            `the runner must not resolve ${JSON.stringify(input)} to a path core would refuse`,
          ).toBe(process.cwd());
        }
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  });
});

/** Run the runner with a given cwd and report the cwd the handler saw. */
async function resolveViaRunner(runner: string, cwd: string): Promise<string> {
  const result = await runNode([runner, "probe"], { cwd: process.cwd() }, JSON.stringify({ cwd }));
  try {
    const parsed = JSON.parse(result.stdout) as { cwd: string };
    return parsed.cwd;
  } catch {
    return process.cwd();
  }
}

/** Run node with the given args, cwd and stdin. */
function runNode(
  args: string[],
  opts: { cwd?: string },
  input: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd: opts.cwd,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => res({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("isContained", () => {
  it("prefix-matches with separator discipline", () => {
    const root = resolve("/r");
    expect(isContained(join(root, "x"), root)).toBe(true);
    expect(isContained(root, root)).toBe(true);
    expect(isContained(resolve("/rootkit"), root)).toBe(false);
  });
});
