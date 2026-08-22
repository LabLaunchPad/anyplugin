import { describe, it, expect, beforeAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, copyFile } from "node:fs/promises";
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
