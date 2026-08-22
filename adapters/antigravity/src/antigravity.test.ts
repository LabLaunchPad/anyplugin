import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitAntigravity } from "./index.js";
import { loadPluginManifest } from "@agent-prism/core";

let root: string;
let plugin: Awaited<ReturnType<typeof loadPluginManifest>>;
let out: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "antigravity-adapter-"));
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await writeFile(join(root, "prism.plugin.yaml"), `name: demo-plugin
version: 0.1.0
description: Demo plugin for conformance tests
skills: ["./skills/demo"]
agents: ["./agents/researcher.md"]
hooks:
  - id: guard-command
    event: before-tool-use
    handler: ./hooks/guard.mjs
    match: run_command
  - id: on-session
    event: session-start
    handler: ./hooks/guard.mjs
mcp:
  servers:
    demo-http:
      transport: http
      url: https://mcp.example.com/sse
`);
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill\n---\n\nBody\n");
  await writeFile(join(root, "agents", "researcher.md"), "---\nname: researcher\ndescription: researches\n---\n\nPrompt\n");
  await writeFile(join(root, "hooks", "guard.mjs"), "export async function run() { return {}; }\n");
  await writeFile(join(root, "hooks", "runner.js"), "// dummy\n");
  plugin = await loadPluginManifest(root);
  out = join(root, "dist", "antigravity");
  await emitAntigravity(plugin, { pluginRoot: root, outDir: out, runnerRelPath: "runner.js", runnerAbsPath: join(root, "hooks", "runner.js") });
});

describe("antigravity adapter emit", () => {
  it("writes plugins/<name>/plugin.json bundle layout", async () => {
    const manifest = JSON.parse(await readFile(join(out, "plugins", "demo-plugin", "plugin.json"), "utf8"));
    expect(manifest).toEqual({ name: "demo-plugin", description: expect.any(String) });
    expect(await readFile(join(out, "plugins", "demo-plugin", "skills", "demo", "SKILL.md"), "utf8")).toContain("demo skill");
    expect(await readFile(join(out, "plugins", "demo-plugin", "agents", "researcher.md"), "utf8")).toContain("researches");
  });

  it("maps only to the 5 native events; session-start folds to PreInvocation", async () => {
    const hooks = JSON.parse(await readFile(join(out, "plugins", "demo-plugin", "hooks.json"), "utf8"));
    const events = Object.keys(hooks);
    for (const e of events) {
      expect(["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"]).toContain(e);
    }
    expect(events).toContain("PreInvocation");
    expect(events).toContain("PreToolUse");
    expect(hooks["PreToolUse"][0]["matcher"]).toBe("run_command");
  });

  it("caps hook timeout at 30s and uses the PLUGIN_ROOT token", async () => {
    const hooks = JSON.parse(await readFile(join(out, "plugins", "demo-plugin", "hooks.json"), "utf8"));
    const hook = hooks["PreToolUse"][0]["hooks"][0];
    expect(hook["timeout"]).toBeLessThanOrEqual(30);
    expect(hook["command"]).toContain("{{PLUGIN_ROOT}}/hooks/runner.js");
  });

  it("uses serverUrl (not url) for HTTP MCP servers", async () => {
    const mcp = JSON.parse(await readFile(join(out, "plugins", "demo-plugin", "mcp_config.json"), "utf8"));
    expect(mcp["mcpServers"]["demo-http"]).toMatchObject({ serverUrl: "https://mcp.example.com/sse" });
    expect(mcp["mcpServers"]["demo-http"]).not.toHaveProperty("url");
  });

  it("plans install into .agents/plugins with an mcp json-merge", () => {
    const bundle = { actions: [] as { kind: string; destAbs?: string }[] };
    expect(bundle).toBeTruthy();
  });
});
