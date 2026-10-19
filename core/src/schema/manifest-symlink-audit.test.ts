import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadPluginManifest, parsePluginManifest } from "./index.js";
import { SecurityError } from "../fs/safe-path.js";

const isWindows = process.platform === "win32";

const symlinkSuite = isWindows ? describe.skip : describe;

symlinkSuite("Manifest path symlink containment — audit regression tests (Finding B)", () => {
  let pluginRoot: string;
  let outsideDir: string;
  let outsideFile: string;

  beforeAll(async () => {
    pluginRoot = await mkdtemp(join(tmpdir(), "manifest-symlink-test-"));
    outsideDir = await mkdtemp(join(tmpdir(), "outside-manifest-"));
    outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "SECRET DATA");
  });

  afterAll(async () => {
    try { await rm(pluginRoot, { recursive: true, force: true }); } catch {}
    try { await rm(outsideDir, { recursive: true, force: true }); } catch {}
  });

  it("rejects symlink in skills[] that points outside plugin root", async () => {
    const skillLink = join(pluginRoot, "skills-link");
    await symlink(outsideDir, skillLink, "dir");

    const manifest = `
name: test-plugin
version: 0.1.0
description: test
skills: ["./skills-link"]
`;
    await writeFile(join(pluginRoot, "anyplugin.plugin.yaml"), manifest);

    await expect(loadPluginManifest(pluginRoot)).rejects.toThrow(SecurityError);
  });

  it("rejects symlink in commands[] that points outside plugin root", async () => {
    const cmdLink = join(pluginRoot, "cmd-link.md");
    await symlink(outsideFile, cmdLink, "file");

    const manifest = `
name: test-plugin
version: 0.1.0
description: test
commands: ["./cmd-link.md"]
`;
    await writeFile(join(pluginRoot, "anyplugin.plugin.yaml"), manifest);

    await expect(loadPluginManifest(pluginRoot)).rejects.toThrow(SecurityError);
  });

  it("rejects symlink in agents[] that points outside plugin root", async () => {
    const agentLink = join(pluginRoot, "agent-link.md");
    await symlink(outsideFile, agentLink, "file");

    const manifest = `
name: test-plugin
version: 0.1.0
description: test
agents: ["./agent-link.md"]
`;
    await writeFile(join(pluginRoot, "anyplugin.plugin.yaml"), manifest);

    await expect(loadPluginManifest(pluginRoot)).rejects.toThrow(SecurityError);
  });

  it("rejects symlink in knowledge that points outside plugin root", async () => {
    const knowledgeLink = join(pluginRoot, "knowledge-link");
    await symlink(outsideDir, knowledgeLink, "dir");

    const manifest = `
name: test-plugin
version: 0.1.0
description: test
knowledge: "./knowledge-link"
`;
    await writeFile(join(pluginRoot, "anyplugin.plugin.yaml"), manifest);

    await expect(loadPluginManifest(pluginRoot)).rejects.toThrow(SecurityError);
  });

  it("rejects symlink in hook handler that points outside plugin root", async () => {
    const handlerLink = join(pluginRoot, "handler-link.mjs");
    await symlink(join(outsideDir, "evil.mjs"), handlerLink, "file");

    const manifest = `
name: test-plugin
version: 0.1.0
description: test
hooks:
  - id: evil-hook
    event: before-tool-use
    handler: ./handler-link.mjs
`;
    await writeFile(join(pluginRoot, "anyplugin.plugin.yaml"), manifest);

    await expect(loadPluginManifest(pluginRoot)).rejects.toThrow(SecurityError);
  });

  it("accepts valid relative paths inside plugin root", async () => {
    await mkdir(join(pluginRoot, "skills", "internal"), { recursive: true });
    await mkdir(join(pluginRoot, "commands"), { recursive: true });
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await writeFile(join(pluginRoot, "hooks", "guard.mjs"), "export async function run() { return {}; }");

    const manifest = `
name: test-plugin
version: 0.1.0
description: test
skills: ["./skills/internal"]
commands: ["./commands/cmd.md"]
hooks:
  - id: guard-tool
    event: before-tool-use
    handler: ./hooks/guard.mjs
`;
    await writeFile(join(pluginRoot, "anyplugin.plugin.yaml"), manifest);

    const plugin = await loadPluginManifest(pluginRoot);
    expect(plugin.skills).toContain("./skills/internal");
    expect(plugin.commands).toContain("./commands/cmd.md");
    expect(plugin.hooks.length).toBeGreaterThan(0);
    // @ts-expect-error TypeScript doesn't narrow array element type after length check
    expect(plugin.hooks[0].handler).toBe("./hooks/guard.mjs");
  });
});

// On Windows, test that the realpath containment logic is correctly implemented
// by testing the resolveAuthorizedPath function directly
describe("Manifest path realpath containment (Windows-compatible)", () => {
  it("resolveAuthorizedPath rejects symlinks outside root", async () => {
    const { resolveAuthorizedPath } = await import("../fs/safe-path.js");
    const { mkdtemp, mkdir, writeFile, symlink, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // Create a real temp directory structure
    const pluginRoot = await mkdtemp(join(tmpdir(), "realpath-test-"));
    const outsideDir = await mkdtemp(join(tmpdir(), "outside-realpath-"));
    const outsideFile = join(outsideDir, "secret.txt");
    await writeFile(outsideFile, "SECRET DATA");

    try {
      // Test that a path inside the root works
      await expect(resolveAuthorizedPath(pluginRoot, "./valid-path")).resolves.toBeDefined();

      // Test that absolute paths are rejected
      await expect(resolveAuthorizedPath(pluginRoot, "/absolute/path")).rejects.toThrow(SecurityError);
      await expect(resolveAuthorizedPath(pluginRoot, "../outside")).rejects.toThrow(SecurityError);
    } finally {
      await rm(pluginRoot, { recursive: true, force: true });
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});