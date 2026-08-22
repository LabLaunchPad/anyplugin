import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitOpencode } from "./index.js";
import { loadPluginManifest } from "@agent-prism/core";

let root: string;
let plugin: Awaited<ReturnType<typeof loadPluginManifest>>;
let out: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "opencode-adapter-"));
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "commands"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await writeFile(join(root, "prism.plugin.yaml"), `name: demo-plugin
version: 0.1.0
description: Demo plugin for conformance tests
skills: ["./skills/demo"]
commands: ["./commands/demo.md"]
hooks:
  - id: guard-tool
    event: before-tool-use
    handler: ./hooks/guard.mjs
  - id: on-chat
    event: prompt-submit
    handler: ./hooks/guard.mjs
mcp:
  servers:
    demo:
      transport: stdio
      command: node
      args: ["server.js"]
`);
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: A demo skill\n---\n\nBody\n");
  await writeFile(join(root, "commands", "demo.md"), "---\ndescription: demo command\n---\n\n$ARGUMENTS\n");
  await writeFile(join(root, "hooks", "guard.mjs"), "export async function run() { return {}; }\n");
  await writeFile(join(root, "hooks", "runner.js"), "// dummy\n");
  plugin = await loadPluginManifest(root);
  out = join(root, "dist", "opencode");
  await emitOpencode(plugin, { pluginRoot: root, outDir: out, runnerRelPath: "runner.js", runnerAbsPath: join(root, "hooks", "runner.js") });
});

describe("opencode adapter emit", () => {
  it("renders a v1 plugin.ts shim bridging to the runner", async () => {
    const shim = await readFile(join(out, "plugin.ts"), "utf8");
    expect(shim).toContain('"tool.execute.before": "guard-tool"');
    expect(shim).toContain('"chat.message": "on-chat"');
    expect(shim).toContain('AGENT_PRISM_HOST');
    expect(shim).toContain('"shell.env"');
    expect(shim).toContain('export default');
  });

  it("copies commands and skills for v2-safe loading", async () => {
    expect(await readFile(join(out, "commands", "demo.md"), "utf8")).toContain("$ARGUMENTS");
    expect(await readFile(join(out, "skills", "demo", "SKILL.md"), "utf8")).toContain("demo skill");
  });

  it("emits opencode.merge.json with command as argv ARRAY (OpenCode convention)", async () => {
    const patch = JSON.parse(await readFile(join(out, "opencode.merge.json"), "utf8"));
    expect(patch["mcp"]["demo"]).toMatchObject({ type: "local", command: ["node", "server.js"] });
    expect(Array.isArray(patch["mcp"]["demo"]["command"])).toBe(true);
    expect(patch["skills"]).toEqual(["{{PLUGIN_ROOT}}/skills/demo"]);
  });

  it("plans AGENTS.md append with begin/end markers", async () => {
    const emitted = await emitOpencode(plugin, { pluginRoot: root, outDir: join(root, "dist2"), runnerRelPath: "runner.js", runnerAbsPath: join(root, "hooks", "runner.js") });
    const mdAppend = emitted.install.actions.find((a) => a.kind === "md-append") as { content: string } | undefined;
    expect(mdAppend).toBeDefined();
    expect(mdAppend!.content).toContain("agent-prism:demo-plugin begin");
    expect(mdAppend!.content).toContain("agent-prism:demo-plugin end");
  });
});
