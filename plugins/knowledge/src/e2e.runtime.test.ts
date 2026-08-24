import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, copyFile, unlink as removeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const RUNNER = join(REPO_ROOT, "plugins", "knowledge", "runtime", "runner.js");
const MCP_SERVER = join(REPO_ROOT, "plugins", "knowledge", "runtime", "mcp-server.js");
const DIST_BIN = join(REPO_ROOT, "cli", "dist", "bin.js");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runNode(args: string[], opts: { input?: string; env?: Record<string, string>; cwd?: string } = {}): Promise<RunResult> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", rejectP);
    child.on("close", (code) => resolveP({ code, stdout, stderr }));
    child.stdin.end(opts.input ?? "");
  });
}

/** The universal runner is the ONE process all four agents execute. */
describe("runner.js E2E (real process, real handler)", () => {
  it("rejects a path-traversal hook id without attempting to load it", async () => {
    for (const badId of ["../../etc/passwd", "a/b", "..\\evil", "hook id!"]) {
      const r = await runNode([RUNNER, badId], { input: "{}" });
      expect(r.code, `hookId ${badId}`).toBe(1);
      expect(r.stderr, `hookId ${badId}`).toMatch(/invalid hook id/);
    }
  }, 30000);

  it("claude-code: additionalContext → hookSpecificOutput", async () => {
    const r = await runNode([RUNNER, "okf-session-start"], {
      input: JSON.stringify({ cwd: REPO_ROOT, session_id: "s1" }),
      env: { ANYPLUGIN_HOST: "claude-code" },
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.additionalContext).toMatch(/OKF v0\.2 knowledge bundle/);
  }, 30000);

  it("antigravity: additionalContext → injectSteps (camelCase protocol)", async () => {
    const r = await runNode([RUNNER, "okf-session-start"], {
      input: JSON.stringify({ cwd: REPO_ROOT, conversationId: "c1" }),
      env: { ANYPLUGIN_HOST: "antigravity" },
    });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.injectSteps[0].type).toBe("userMessage");
    expect(out.injectSteps[0].content).toMatch(/OKF v0\.2 knowledge bundle/);
  }, 30000);

  it("codex host marker is detected (payload.platform)", async () => {
    const r = await runNode([RUNNER, "okf-session-start"], {
      input: JSON.stringify({ cwd: REPO_ROOT }),
      env: { ANYPLUGIN_HOST: "codex" },
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toMatch(/OKF/);
  }, 30000);

  it("blocking handler exits 2 with decision=block", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "runner-block-"));
    const runnerCopy = join(tmp, "runner.js");
    await copyFile(RUNNER, runnerCopy);
    await mkdir(join(tmp, "handlers"), { recursive: true });
    await writeFile(join(tmp, "handlers", "block-check.mjs"), "export async function run() { return { block: true, reason: 'blocked by test' }; }\n");
    const r = await runNode([runnerCopy, "block-check"], {
      input: "{}",
      env: { ANYPLUGIN_HOST: "claude-code" },
      cwd: tmp,
    });
    expect(r.code).toBe(2);
    expect(JSON.parse(r.stdout).decision).toBe("block");
    expect(JSON.parse(r.stdout).reason).toBe("blocked by test");
  }, 30000);

  it("handler failure is non-blocking (exit 0, stderr note)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "runner-fail-"));
    const runnerCopy = join(tmp, "runner.js");
    await copyFile(RUNNER, runnerCopy);
    await mkdir(join(tmp, "handlers"), { recursive: true });
    await writeFile(join(tmp, "handlers", "boom.mjs"), "export async function run() { throw new Error('boom'); }\n");
    const r = await runNode([runnerCopy, "boom"], { input: "{}", cwd: tmp });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/failed: boom/);
  }, 30000);

  it("intensityMode reaches the handler payload — valid, missing, and corrupt .anyplugin-mode", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "runner-mode-"));
    const runnerCopy = join(tmp, "runner.js");
    await copyFile(RUNNER, runnerCopy);
    await mkdir(join(tmp, "handlers"), { recursive: true });
    await writeFile(
      join(tmp, "handlers", "echo-mode.mjs"),
      "export async function run(payload) { return { additionalContext: JSON.stringify({ intensityMode: payload.intensityMode }) }; }\n",
    );
    const pluginRoot = join(tmp, "plugin-root");
    await mkdir(pluginRoot, { recursive: true });

    // valid flag → mode reaches the payload
    await writeFile(join(pluginRoot, ".anyplugin-mode"), JSON.stringify({ pluginId: "p", version: "1.0.0", mode: "aggressive", timestamp: 1 }));
    let r = await runNode([runnerCopy, "echo-mode"], { input: "{}", env: { ANYPLUGIN_HOST: "claude-code", ANYPLUGIN_PLUGIN_ROOT: pluginRoot } });
    expect(r.code).toBe(0);
    expect(JSON.parse(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).intensityMode).toBe("aggressive");

    // missing flag file → fails open to null, hook still runs, exit 0
    await removeFile(join(pluginRoot, ".anyplugin-mode"));
    r = await runNode([runnerCopy, "echo-mode"], { input: "{}", env: { ANYPLUGIN_HOST: "claude-code", ANYPLUGIN_PLUGIN_ROOT: pluginRoot } });
    expect(r.code).toBe(0);
    expect(JSON.parse(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).intensityMode).toBe(null);

    // corrupt JSON → same fail-open guarantee, never surfaced as an error
    await writeFile(join(pluginRoot, ".anyplugin-mode"), "{ not valid json");
    r = await runNode([runnerCopy, "echo-mode"], { input: "{}", env: { ANYPLUGIN_HOST: "claude-code", ANYPLUGIN_PLUGIN_ROOT: pluginRoot } });
    expect(r.code).toBe(0);
    expect(JSON.parse(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).intensityMode).toBe(null);
  }, 30000);

  it("turn-stop appends a session heartbeat to the bundle's log.md", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "runner-turn-"));
    await mkdir(join(tmp, "knowledge"), { recursive: true });
    await writeFile(join(tmp, "knowledge", "index.md"), "# index\n");
    await writeFile(join(tmp, "knowledge", "log.md"), "# Log\n\n## 2020-01-01\n\n- old entry\n");
    const r = await runNode([RUNNER, "okf-turn-stop"], {
      input: JSON.stringify({ cwd: tmp }),
      env: {
        ANYPLUGIN_HOST: "claude-code",
        ANYPLUGIN_OKF_BUNDLE: join(tmp, "knowledge"),
        ANYPLUGIN_PLUGIN_ROOT: join(REPO_ROOT, "plugins", "knowledge", "plugin"),
      },
      cwd: tmp,
    });
    expect(r.code).toBe(0);
    const log = await readFile(join(tmp, "knowledge", "log.md"), "utf8");
    expect(log).toContain("- session on claude-code (");
    expect(log).toContain("- old entry");
  }, 30000);
});

/** The MCP server speaks real JSON-RPC 2.0 over stdio. */
describe("mcp-server.js E2E (JSON-RPC over stdio)", () => {
  it("initialize → tools/list → okf_index against the repo bundle", async () => {
    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "okf_index", arguments: { bundle: join(REPO_ROOT, "knowledge") } } }),
    ].join("\n");
    const r = await runNode([MCP_SERVER], { input: lines, env: { ANYPLUGIN_OKF_BUNDLE: join(REPO_ROOT, "knowledge") } });
    expect(r.code).toBe(0);
    const responses = r.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    const byId = Object.fromEntries(responses.map((res) => [res.id, res]));

    expect(byId[1].result.serverInfo).toEqual({ name: "anyplugin-okf", version: "0.1.1" });
    const toolNames = byId[2].result.tools.map((t: { name: string }) => t.name).sort();
    expect(toolNames).toEqual(["okf_index", "okf_read", "okf_search"]);
    const index = JSON.parse(byId[3].result.content[0].text);
    expect(Array.isArray(index)).toBe(true);
    expect(index.some((c: { id: string }) => c.id === "agents/claude-code")).toBe(true);
  }, 30000);

  it("okf_read returns frontmatter + body for a known concept", async () => {
    const lines = [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "okf_read", arguments: { concept: "agents/claude-code", bundle: join(REPO_ROOT, "knowledge") } } }),
    ].join("\n");
    const r = await runNode([MCP_SERVER], { input: lines });
    const first = r.stdout.trim().split(/\r?\n/)[0] ?? "";
    const res = JSON.parse(first);
    const concept = JSON.parse(res.result.content[0].text);
    expect(concept.id).toBe("agents/claude-code");
    expect(concept.frontmatter["type"]).toBeDefined();
    expect(concept.body.length).toBeGreaterThan(0);
  }, 30000);
});

/** CLI machine-readable output, exercised through the built binary. */
describe.skipIf(!existsSync(DIST_BIN))("CLI --json E2E (cli/dist/bin.js)", () => {
  it("okf-validate handles flags without/before positionals (default ./knowledge)", async () => {
    for (const args of [["--json"], ["--json", "knowledge"]]) {
      const r = await runNode([DIST_BIN, "okf-validate", ...args], { cwd: REPO_ROOT });
      expect(r.code, `args: ${args.join(" ")}`).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.conformant).toBe(true);
      expect(out.errorCount).toBe(0);
    }
  }, 30000);

  it("uninstall --dry-run leaves no .anyplugin-build in the plugin dir", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "dryrun-e2e-"));
    const pluginDir = join(tmp, "preview-plugin");
    const initR = await runNode([DIST_BIN, "init", "--name", "preview-plugin", "--dir", pluginDir, "--json"]);
    expect(initR.code).toBe(0);
    const r = await runNode([
      DIST_BIN, "uninstall", "--plugin", pluginDir,
      "--home", join(tmp, "home"), "--project", join(tmp, "proj"), "--dry-run",
    ]);
    expect(r.code).toBe(0);
    expect(existsSync(join(pluginDir, ".anyplugin-build"))).toBe(false);
  }, 30000);

  it("detect --json emits parseable detection state", async () => {
    const r = await runNode([DIST_BIN, "detect", "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.command).toBe("detect");
    expect(out.environment.os).toBeDefined();
    expect(Array.isArray(out.installed)).toBe(true);
  }, 30000);

  it("okf-validate --json reports conformance for the repo bundle", async () => {
    const r = await runNode([DIST_BIN, "okf-validate", "knowledge", "--json"], { cwd: REPO_ROOT });
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.conformant).toBe(true);
    expect(out.errorCount).toBe(0);
  }, 30000);

  it("init --json scaffolds a loadable plugin", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cli-init-"));
    const r = await runNode([DIST_BIN, "init", "--name", "json-init-plugin", "--dir", join(tmp, "json-init-plugin"), "--json"]);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.command).toBe("init");
    expect(out.name).toBe("json-init-plugin");
    expect(out.files).toContain("anyplugin.plugin.yaml");
    const manifestText = await readFile(join(out.dir, "anyplugin.plugin.yaml"), "utf8");
    expect(manifestText).toContain("name: json-init-plugin");
  }, 30000);

  it("install --tier instruction honors --json and reports dry-run accurately", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "tier-e2e-"));
    const pluginDir = join(tmp, "tier-plugin");
    const project = join(tmp, "project");
    const initR = await runNode([DIST_BIN, "init", "--name", "tier-plugin", "--dir", pluginDir, "--json"]);
    expect(initR.code).toBe(0);

    // --dry-run must not write AGENTS.md, and must say "would append", not "appended".
    const dryRunText = await runNode([DIST_BIN, "install", "--plugin", pluginDir, "--project", project, "--tier", "instruction", "--dry-run"]);
    expect(dryRunText.code).toBe(0);
    expect(dryRunText.stdout).toMatch(/would append/);
    expect(dryRunText.stdout).not.toMatch(/\bappended →/);
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);

    // --json must actually emit JSON, not the human-readable text.
    const jsonR = await runNode([DIST_BIN, "install", "--plugin", pluginDir, "--project", project, "--tier", "instruction", "--json"]);
    expect(jsonR.code, jsonR.stderr).toBe(0);
    const out = JSON.parse(jsonR.stdout);
    expect(out.command).toBe("install");
    expect(out.tier).toBe("instruction");
    expect(out.dryRun).toBe(false);
    expect(out.agentsMd).toBe(join(project, "AGENTS.md"));
    expect(existsSync(out.agentsMd)).toBe(true);

    const uninstallJsonR = await runNode([DIST_BIN, "uninstall", "--plugin", pluginDir, "--project", project, "--tier", "instruction", "--json"]);
    expect(uninstallJsonR.code, uninstallJsonR.stderr).toBe(0);
    const uOut = JSON.parse(uninstallJsonR.stdout);
    expect(uOut.command).toBe("uninstall");
    expect(uOut.tier).toBe("instruction");
    expect(Array.isArray(uOut.touched)).toBe(true);
    expect(existsSync(join(project, "AGENTS.md"))).toBe(false);
  }, 30000);

  it("intensity writes .anyplugin-mode into the INSTALLED root, not the source --plugin dir", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "intensity-e2e-"));
    const pluginDir = join(tmp, "intensity-plugin");
    const home = join(tmp, "home");
    const project = join(tmp, "project");
    const initR = await runNode([DIST_BIN, "init", "--name", "intensity-plugin", "--dir", pluginDir, "--json"]);
    expect(initR.code).toBe(0);

    const installR = await runNode([
      DIST_BIN, "install", "--plugin", pluginDir, "--agents", "claude-code",
      "--home", home, "--project", project,
    ]);
    expect(installR.code).toBe(0);

    const installedRoot = join(home, ".claude", "plugins", "intensity-plugin");
    expect(existsSync(join(installedRoot, ".anyplugin-mode"))).toBe(false);
    expect(existsSync(join(pluginDir, ".anyplugin-mode"))).toBe(false);

    const intensityR = await runNode([
      DIST_BIN, "intensity", "--mode", "aggressive", "--plugin", pluginDir, "--agents", "claude-code",
      "--home", home, "--project", project, "--json",
    ]);
    expect(intensityR.code, intensityR.stderr).toBe(0);
    const out = JSON.parse(intensityR.stdout);
    expect(out.written).toEqual([{ agent: "claude-code", file: join(installedRoot, ".anyplugin-mode") }]);

    // The flag landed where the runtime actually reads it from...
    const state = JSON.parse(await readFile(join(installedRoot, ".anyplugin-mode"), "utf8"));
    expect(state.mode).toBe("aggressive");
    expect(state.pluginId).toBe("intensity-plugin");
    // ...and NOT in the developer's source tree, which the runtime never reads.
    expect(existsSync(join(pluginDir, ".anyplugin-mode"))).toBe(false);
  }, 30000);

  it("intensity errors clearly when the plugin isn't installed anywhere yet", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "intensity-uninstalled-"));
    const pluginDir = join(tmp, "never-installed");
    const initR = await runNode([DIST_BIN, "init", "--name", "never-installed", "--dir", pluginDir, "--json"]);
    expect(initR.code).toBe(0);
    const r = await runNode([
      DIST_BIN, "intensity", "--mode", "balanced", "--plugin", pluginDir,
      "--home", join(tmp, "home"), "--project", join(tmp, "project"),
    ]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/not installed for any of/);
  }, 30000);

  it("invalid manifest error names the failing field", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "cli-bad-"));
    await mkdir(tmp, { recursive: true });
    await writeFile(join(tmp, "anyplugin.plugin.yaml"), "name: BAD_NAME\nversion: not-a-version\ndescription: x\n");
    const r = await runNode([DIST_BIN, "build", "--plugin", tmp]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/name: kebab-case/);
    expect(r.stderr).toMatch(/version: Invalid/);
  }, 30000);
});
