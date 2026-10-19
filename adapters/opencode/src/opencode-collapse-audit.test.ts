import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitOpencode } from "./index.js";
import { loadPluginManifest } from "@lablaunchpad/core";

describe("OpenCode shim multi-hook dispatch — audit regression tests (Finding H)", () => {
  let root: string;
  let pluginRoot: string;
  let out: string;
  let shim: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "opencode-collapse-test-"));
    pluginRoot = join(root, "test-plugin");
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await writeFile(
      join(pluginRoot, "hooks", "guard1.mjs"),
      "export async function run() { return { additionalContext: 'guard1' }; }",
    );
    await writeFile(
      join(pluginRoot, "hooks", "guard2.mjs"),
      "export async function run() { return { additionalContext: 'guard2' }; }",
    );
    await writeFile(
      join(pluginRoot, "hooks", "guard3.mjs"),
      "export async function run() { return { additionalContext: 'guard3' }; }",
    );
    await writeFile(join(pluginRoot, "hooks", "runner.js"), "// runner\n");

    await writeFile(
      join(pluginRoot, "anyplugin.plugin.yaml"),
      `
name: collapse-test
version: 0.1.0
description: test hook collapse
hooks:
  - id: guard-tool-1
    event: before-tool-use
    handler: ./hooks/guard1.mjs
  - id: guard-tool-2
    event: before-tool-use
    handler: ./hooks/guard2.mjs
  - id: guard-tool-3
    event: before-tool-use
    handler: ./hooks/guard3.mjs
`,
    );

    const plugin = await loadPluginManifest(pluginRoot);
    out = join(root, "dist");
    await emitOpencode(plugin, {
      pluginRoot,
      outDir: out,
      runnerRelPath: "runner.js",
      runnerAbsPath: join(pluginRoot, "hooks", "runner.js"),
    });
    shim = await readFile(join(out, "plugin.ts"), "utf8");
  });

  afterAll(async () => {
    try {
      await rm(root, { recursive: true, force: true });
    } catch {}
  });

  it("keeps EVERY hook that shares a native event", () => {
    // The old shim used Object.fromEntries, so only the last hook survived.
    for (const id of ["guard-tool-1", "guard-tool-2", "guard-tool-3"]) {
      expect(shim).toContain(id);
    }
  });

  it("maps a native event to an ORDERED LIST of hooks", () => {
    const match = shim.match(/"tool\.execute\.before":\s*\[([\s\S]*?)\]/);
    expect(match).toBeTruthy();
    const block = match![1]!;
    const ids = [...block.matchAll(/"id":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["guard-tool-1", "guard-tool-2", "guard-tool-3"]);
  });

  it("dispatches every hook of the event, not just one", () => {
    // The shim must iterate the list rather than looking up a single id.
    expect(shim).toContain("for (const entry of entries)");
    expect(shim).toContain("await runAll(");
    expect(shim).not.toContain("Object.fromEntries(bridge");
  });

  it("merges the results of every hook", () => {
    // Context from all hooks is concatenated, not overwritten.
    expect(shim).toContain("merged.context.join");
    expect(shim).toContain("merged.output[\"additionalContext\"]");
  });

  it("preserves the tool-name matcher", async () => {
    const pluginRoot2 = join(root, "matcher-plugin");
    await mkdir(join(pluginRoot2, "hooks"), { recursive: true });
    await writeFile(join(pluginRoot2, "hooks", "g.mjs"), "export async function run() { return {}; }");
    await writeFile(join(pluginRoot2, "hooks", "runner.js"), "// runner\n");
    await writeFile(
      join(pluginRoot2, "anyplugin.plugin.yaml"),
      `
name: matcher-test
version: 0.1.0
description: matcher preservation
hooks:
  - id: only-read
    event: before-tool-use
    handler: ./hooks/g.mjs
    match: "^(Read|Glob)$"
`,
    );

    const plugin = await loadPluginManifest(pluginRoot2);
    const out2 = join(root, "dist2");
    await emitOpencode(plugin, {
      pluginRoot: pluginRoot2,
      outDir: out2,
      runnerRelPath: "runner.js",
      runnerAbsPath: join(pluginRoot2, "hooks", "runner.js"),
    });
    const shim2 = await readFile(join(out2, "plugin.ts"), "utf8");
    expect(shim2).toContain("match");
    expect(shim2).toContain("^(Read|Glob)$");
    expect(shim2).toContain("function matches(");
  });

  it("reads the permission decision from wherever the runner put it", () => {
    // The runner nests permissionDecision under hookSpecificOutput for
    // non-Antigravity platforms; the old shim only looked at the top level.
    expect(shim).toContain("function decisionOf(");
    expect(shim).toContain("hookSpecificOutput");
    expect(shim).toContain("injectSteps");
  });

  it("emits the runtime policy file the runner reads", async () => {
    const policies = JSON.parse(await readFile(join(out, "hooks", "policies.json"), "utf8")) as Record<
      string,
      { failurePolicy: string }
    >;
    expect(policies["guard-tool-1"]).toBeDefined();
    expect(policies["guard-tool-1"]!.failurePolicy).toBe("non-blocking");
  });
});
