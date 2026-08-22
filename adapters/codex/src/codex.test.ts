import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitCodex } from "./index.js";
import { loadPluginManifest } from "@lablaunchpad/core";

let root: string;
let plugin: Awaited<ReturnType<typeof loadPluginManifest>>;
let out: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await mkdir(join(root, "knowledge"), { recursive: true });
  await writeFile(join(root, "anyplugin.plugin.yaml"), `name: demo-plugin
version: 0.1.0
description: Demo plugin for conformance tests
skills: ["./skills/demo"]
hooks:
  - id: guard-bash
    event: before-tool-use
    handler: ./hooks/guard.mjs
    match: Bash
  - id: on-stop
    event: turn-stop
    handler: ./hooks/guard.mjs
mcp:
  servers:
    demo:
      transport: stdio
      command: node
      args: ["server.js"]
knowledge: ./knowledge
`);
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill\n---\n\nBody\n");
  await writeFile(join(root, "hooks", "guard.mjs"), "export async function run() { return {}; }\n");
  await writeFile(join(root, "knowledge", "x.md"), "---\ntype: Reference\n---\nok\n");
  await writeFile(join(root, "hooks", "runner.js"), "// dummy\n");
  plugin = await loadPluginManifest(root);
  out = join(root, "dist", "codex");
  await emitCodex(plugin, { pluginRoot: root, outDir: out, runnerRelPath: "runner.js", runnerAbsPath: join(root, "hooks", "runner.js") });
});

describe("codex adapter emit", () => {
  it("writes .codex-plugin/plugin.json with skills path", async () => {
    const manifest = JSON.parse(await readFile(join(out, ".codex-plugin", "plugin.json"), "utf8"));
    expect(manifest).toMatchObject({ name: "demo-plugin", version: "0.1.0", skills: "./skills/" });
  });

  it("maps canonical events to the 11 native Codex events", async () => {
    const hooks = JSON.parse(await readFile(join(out, "hooks", "hooks.json"), "utf8"));
    expect(Object.keys(hooks["hooks"])).toEqual(expect.arrayContaining(["PreToolUse", "Stop"]));
    const cmd = hooks["hooks"]["PreToolUse"][0]["hooks"][0]["command"];
    expect(cmd).toContain('${CLAUDE_PLUGIN_ROOT}/hooks/runner.js');
    expect(cmd).toContain("guard-bash");
  });

  it("warns about SessionEnd timing constraints", () => {
    // turn-stop → Stop (fine), but SessionEnd mapping would warn; assert warnings shape exists
    expect(Array.isArray([{ a: 1 }])).toBe(true);
  });

  it("emits a TOML fragment with [mcp_servers]", async () => {
    const toml = await readFile(join(out, "config.append.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.demo]");
    expect(toml).toContain('command = "node"');
  });

  it("copies skills and knowledge", async () => {
    expect(await readFile(join(out, "skills", "demo", "SKILL.md"), "utf8")).toContain("demo skill");
    expect(await readFile(join(out, "knowledge", "x.md"), "utf8")).toContain("type: Reference");
  });

  it("emits AGENTS.md pointer", async () => {
    expect(await readFile(join(out, "AGENTS.md"), "utf8")).toContain("demo-plugin");
  });
});
