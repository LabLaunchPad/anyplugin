import { describe, it, expect, beforeAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll, executeInstall, executeUninstall, stripBlock, deepMerge, validateRelPath, validatePluginName } from "./index.js";
import { pathExists } from "@lablaunchpad/core";

let root: string;
let home: string;
let project: string;
let outRoot: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cli-"));
  home = join(root, "home");
  project = join(root, "project");
  outRoot = join(root, "build");
  await mkdir(join(root, "skills", "demo"), { recursive: true });
  await mkdir(join(root, "hooks"), { recursive: true });
  await mkdir(join(root, "knowledge"), { recursive: true });
  await writeFile(join(root, "anyplugin.plugin.yaml"), `name: demo-plugin
version: 0.1.0
description: CLI test plugin
skills: ["./skills/demo"]
hooks:
  - id: guard
    event: before-tool-use
    handler: ./hooks/guard.mjs
mcp:
  servers:
    okf:
      transport: stdio
      command: node
      args: ["{{PLUGIN_ROOT}}/mcp/server.js"]
knowledge: ./knowledge
`);
  await writeFile(join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\nbody\n");
  await writeFile(join(root, "hooks", "guard.mjs"), "export async function run() { return {}; }\n");
  await writeFile(join(root, "knowledge", "a.md"), "---\ntype: Reference\n---\nok\n");
  await writeFile(join(root, "hooks", "runner.js"), "// runner\n");
});

describe("buildAll", () => {
  it("emits all four agent bundles", async () => {
    const bundles = await buildAll({ pluginRoot: root, outRoot, runnerAbsPath: join(root, "hooks", "runner.js") });
    expect(Object.keys(bundles).sort()).toEqual(["antigravity", "claude-code", "codex", "opencode"]);
    for (const b of Object.values(bundles)) expect(b.files.length).toBeGreaterThan(0);
  });
});

describe("executeInstall / executeUninstall", () => {
  it("installs, merges configs, and fully reverses", async () => {
    const bundles = await buildAll({ pluginRoot: root, outRoot, runnerAbsPath: join(root, "hooks", "runner.js") });
    const opts = { home, projectDir: project, pluginName: "demo-plugin" };

    for (const [key, bundle] of Object.entries(bundles)) {
      const result = await executeInstall(key as never, bundle, opts);
      expect(result.copiedDirs.length + result.mergedFiles.length).toBeGreaterThan(0);
    }

    // claude bundle present
    expect(await pathExists(join(home, ".claude", "plugins", "demo-plugin", ".claude-plugin", "plugin.json"))).toBe(true);
    // codex config.toml got the marked mcp_servers block with absolute path substituted
    const codexToml = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(codexToml).toContain("# BEGIN anyplugin:demo-plugin");
    expect(codexToml).toContain("[mcp_servers.okf]");
    expect(codexToml).toContain(join(home, ".codex", "plugins", "demo-plugin"));
    // antigravity plugin + merged workspace mcp_config.json
    expect(await pathExists(join(project, ".agents", "plugins", "demo-plugin", "plugin.json"))).toBe(true);
    const agMcp = JSON.parse(await readFile(join(project, ".agents", "mcp_config.json"), "utf8"));
    expect(String(agMcp["mcpServers"]["okf"]["args"][0]).replace(/\//g, "\\")).toContain(
      join(project, ".agents", "plugins", "demo-plugin", "mcp", "server.js"),
    );
    // antigravity hooks.json had {{PLUGIN_ROOT}} substituted
    const agHooks = await readFile(join(project, ".agents", "plugins", "demo-plugin", "hooks.json"), "utf8");
    expect(agHooks).not.toContain("{{PLUGIN_ROOT}}");
    // opencode plugin.ts + opencode.json merge with absolute skill paths
    expect(await pathExists(join(project, ".opencode", "plugins", "demo-plugin", "plugin.ts"))).toBe(true);
    const ocJson = JSON.parse(await readFile(join(project, "opencode.json"), "utf8"));
    expect(ocJson["skills"][0]).toContain(join(project, ".opencode", "plugins", "demo-plugin"));
    expect(ocJson["mcp"]["okf"]["command"][0]).toBe("node");
    // AGENTS.md marker block
    const agentsMd = await readFile(join(project, "AGENTS.md"), "utf8");
    expect(agentsMd).toContain("anyplugin:demo-plugin begin");
    // pre-existing AGENTS.md content preserved
    expect(agentsMd).toContain("Existing project instructions");

    // --- uninstall reverses everything ---
    for (const [key, bundle] of Object.entries(bundles)) {
      await executeUninstall(key as never, bundle, opts);
    }
    expect(await pathExists(join(home, ".claude", "plugins", "demo-plugin"))).toBe(false);
    expect(await pathExists(join(home, ".codex", "plugins", "demo-plugin"))).toBe(false);
    expect(await pathExists(join(project, ".agents", "plugins", "demo-plugin"))).toBe(false);
    expect(await pathExists(join(project, ".opencode", "plugins", "demo-plugin"))).toBe(false);
    const codexAfter = await readFile(join(home, ".codex", "config.toml"), "utf8");
    expect(codexAfter).not.toContain("anyplugin:demo-plugin");
    const ocAfter = JSON.parse(await readFile(join(project, "opencode.json"), "utf8"));
    expect(ocAfter["skills"]).toBeUndefined();
    expect(ocAfter["mcp"]).toBeUndefined();
    const agMcpAfter = JSON.parse(await readFile(join(project, ".agents", "mcp_config.json"), "utf8"));
    expect(agMcpAfter["mcpServers"]).toBeUndefined();
    const agentsAfter = await readFile(join(project, "AGENTS.md"), "utf8");
    expect(agentsAfter).not.toContain("anyplugin:");
    expect(agentsAfter).toContain("Existing project instructions");
  });
});

describe("guards", () => {
  it("rejects traversal and unsafe names", () => {
    expect(() => validateRelPath("../escape", "test")).toThrow(/unsafe/);
    expect(() => validateRelPath("a/../../b", "test")).toThrow(/unsafe/);
    expect(() => validateRelPath("C:\\evil", "test")).toThrow(/unsafe/);
    expect(validateRelPath("skills/demo", "test")).toBe("skills/demo");
    expect(() => validatePluginName("../evil")).toThrow(/unsafe/);
    expect(() => validatePluginName("a/b")).toThrow(/unsafe/);
    expect(validatePluginName("demo-plugin")).toBe("demo-plugin");
  });
});

describe("stripBlock", () => {
  it("removes marked block and preserves surrounding text", () => {
    const text = "before\n# BEGIN x\njunk\n# END x\nafter";
    expect(stripBlock(text, "# BEGIN x", "# END x")).toMatch(/before[\s\S]*after/);
    expect(stripBlock("nothing", "# BEGIN x", "# END x")).toBe("nothing");
  });
});

describe("deepMerge", () => {
  it("merges nested objects, arrays replaced", () => {
    expect(deepMerge({ a: { b: 1 }, keep: true }, { a: { c: 2 } })).toEqual({ a: { b: 1, c: 2 }, keep: true });
    expect(deepMerge({ list: [1] }, { list: [2, 3] })).toEqual({ list: [2, 3] });
  });
});

// pre-existing AGENTS.md to prove marker-append preserves content
beforeAll(async () => {
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "# Existing project instructions\n\nKeep me.\n");
});
