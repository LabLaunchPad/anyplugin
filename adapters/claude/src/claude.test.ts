import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitClaude } from "./index.js";
import { loadPluginManifest } from "@lablaunchpad/core";
import { readFile } from "node:fs/promises";

let root: string;
let plugin: Awaited<ReturnType<typeof loadPluginManifest>>;
let out: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "agents"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await mkdir(join(root, "knowledge", "agents"), { recursive: true });
  await writeFile(join(root, "prism.plugin.yaml"), `name: demo-plugin
version: 0.1.0
description: Demo plugin for conformance tests
skills: ["./skills/demo"]
commands: ["./commands/demo.md"]
agents: ["./agents/helper.md"]
hooks:
  - id: guard-bash
    event: before-tool-use
    handler: ./hooks/guard.mjs
    match: Bash
  - id: on-start
    event: session-start
    handler: ./hooks/start.mjs
mcp:
  servers:
    demo:
      transport: stdio
      command: node
      args: ["server.js"]
knowledge: ./knowledge
`);
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill\n---\n\nBody\n");
  await writeFile(join(root, "commands", "demo.md"), "---\ndescription: demo command\n---\n\n$ARGUMENTS\n");
  await writeFile(join(root, "agents", "helper.md"), "---\nname: helper\ndescription: helps\n---\n\nPrompt body\n");
  await writeFile(join(root, "hooks", "guard.mjs"), "export async function run() { return {}; }\n");
  await writeFile(join(root, "hooks", "start.mjs"), "export async function run() { return {}; }\n");
  await writeFile(join(root, "knowledge", "agents", "x.md"), "---\ntype: Reference\ntitle: X\n---\n\nok\n");
  await writeFile(join(root, "hooks", "runner.js"), "// dummy runner\n");
  plugin = await loadPluginManifest(root);
  out = join(root, "dist", "claude");
  await emitClaude(plugin, { pluginRoot: root, outDir: out, runnerRelPath: "runner.js", runnerAbsPath: join(root, "hooks", "runner.js") });
});

describe("claude adapter emit", () => {
  it("writes a conformant .claude-plugin/plugin.json", async () => {
    const manifest = JSON.parse(await readFile(join(out, ".claude-plugin", "plugin.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "demo-plugin", version: "0.1.0" });
    expect(manifest["name"]).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  it("maps canonical events to native Claude events with matcher groups", async () => {
    const hooks = JSON.parse(await readFile(join(out, "hooks", "hooks.json"), "utf8"));
    expect(Object.keys(hooks["hooks"])).toEqual(expect.arrayContaining(["PreToolUse", "SessionStart"]));
    const pre = hooks["hooks"]["PreToolUse"];
    expect(pre[0]["matcher"]).toBe("Bash");
    expect(pre[0]["hooks"][0]["type"]).toBe("command");
    expect(pre[0]["hooks"][0]["command"]).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/runner.js');
    expect(pre[0]["hooks"][0]["command"]).toContain("guard-bash");
  });

  it("copies runner + handlers into hooks/", async () => {
    expect(JSON.parse(await readFile(join(out, "hooks", "hooks.json"), "utf8"))).toBeTruthy();
    const runner = await readFile(join(out, "hooks", "runner.js"), "utf8");
    expect(runner).toContain("dummy runner");
    const handler = await readFile(join(out, "hooks", "handlers", "guard-bash.mjs"), "utf8");
    expect(handler).toContain("run");
  });

  it("copies skills, commands, agents, knowledge", async () => {
    expect(await readFile(join(out, "skills", "demo", "SKILL.md"), "utf8")).toContain("demo skill");
    expect(await readFile(join(out, "commands", "demo.md"), "utf8")).toContain("$ARGUMENTS");
    expect(await readFile(join(out, "agents", "helper.md"), "utf8")).toContain("helps");
    expect(await readFile(join(out, "knowledge", "agents", "x.md"), "utf8")).toContain("type: Reference");
  });

  it("emits a direct-map .mcp.json for stdio servers", async () => {
    const mcp = JSON.parse(await readFile(join(out, ".mcp.json"), "utf8"));
    expect(mcp).toEqual({ demo: { command: "node", args: ["server.js"] } });
  });
});
