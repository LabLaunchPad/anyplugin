import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAll, executeInstall, executeUninstall, installedRoot, transactionWorkspaceRoot } from "./index.js";
import {
  createTransactionContext,
  stagedPayloadPath,
  writeInstallIntent,
  readInstallIntent,
  backupDestinations,
  restoreFromBackups,
  verifyAppliedState,
  hashDirFiles,
  hashTree,
  INTENT_VERSION,
  type StagedPayload,
} from "./transaction.js";
import { readJournal } from "./journal.js";

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Transactional install — audit regression tests (Finding E).
 *
 * These tests prove the guarantees the transaction engine makes:
 *  - a failure during mutation rolls every destination back to its pre-install state
 *  - a hash mismatch during verification rolls back and aborts
 *  - a failed install leaves ZERO partial files and ZERO orphaned scratch dirs
 *  - a successful install leaves ZERO scratch dirs behind
 */
// The timeout is explicit because every test in this file drives a real
// install/uninstall transaction against the filesystem, and vitest's 5 s
// default is genuinely marginal for that: under any real load the suite
// crosses it and fails, so the verdict would depend on the machine rather
// than on the code. The assertions are unchanged; only the budget is
// stated. See `docs/BACKLOG.md` P2-28.
// The suite is SEQUENTIAL by default: vitest runs the tests in a file in
// order unless they opt into concurrency. The explicit \describe.sequential\
// modifier was removed in vitest 5, and the default it named is the default.
describe("Transactional install - audit regression tests (Finding E)", { timeout: 60_000 }, () => {
  let testRoot: string;
  let home: string;
  let project: string;
  let pluginRoot: string;
  let bundles: Record<string, any>;

  const agent = "opencode" as const;
  const pluginName = "tx-plugin";

  const opts = () => ({ home, projectDir: project, pluginName, version: "0.1.0", dryRun: false });

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "tx-install-test-"));
    home = join(testRoot, "home");
    project = join(testRoot, "project");
    await mkdir(home, { recursive: true });
    await mkdir(project, { recursive: true });

    pluginRoot = join(testRoot, "tx-plugin");
    await mkdir(join(pluginRoot, "hooks"), { recursive: true });
    await mkdir(join(pluginRoot, "skills", "demo"), { recursive: true });
    await writeFile(
      join(pluginRoot, "anyplugin.plugin.yaml"),
      `name: ${pluginName}
version: 0.1.0
description: transactional test plugin
skills: ["./skills/demo"]
hooks:
  - id: guard
    event: before-tool-use
    handler: ./hooks/guard.mjs
`,
    );
    await writeFile(join(pluginRoot, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: demo\n---\nbody\n");
    await writeFile(join(pluginRoot, "hooks", "guard.mjs"), "export async function run() { return {}; }\n");
    await writeFile(join(pluginRoot, "hooks", "runner.js"), "// runner\n");

    bundles = await buildAll({
      pluginRoot,
      outRoot: join(testRoot, "build"),
      runnerAbsPath: join(pluginRoot, "hooks", "runner.js"),
    });
  });

  afterEach(async () => {
    for (const a of ["claude-code", "opencode", "codex", "antigravity"] as const) {
      const root = installedRoot(a, { home, projectDir: project, codexHome: project, pluginName });
      try {
        await rm(root, { recursive: true, force: true });
      } catch {}
      const ws = transactionWorkspaceRoot(a, { home, projectDir: project, codexHome: project }, pluginName);
      try {
        await rm(ws, { recursive: true, force: true });
      } catch {}
    }
    // The opencode adapter also copies skills/commands into SHARED directories
    // outside the installed root. Those are managed by the plugin journal, so
    // removing the journal without removing them would leave the next install
    // with a legitimately-unmanaged destination (fail-closed conflict).
    for (const shared of [join(project, ".opencode", "skills"), join(project, ".opencode", "commands")]) {
      try {
        await rm(shared, { recursive: true, force: true });
      } catch {}
    }
  });

  afterAll(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  // ── Transaction primitives ────────────────────────────────────────────────

  it("staging workspace is created outside the install root", async () => {
    const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName });
    const ws = transactionWorkspaceRoot(agent, { home, projectDir: project, codexHome: project }, pluginName);

    // The workspace must NOT be inside the install root, otherwise copying the
    // staged tree onto the root would recurse into its own source.
    expect(ws.startsWith(root + "\\") || ws.startsWith(root + "/")).toBe(false);
    // It must be a sibling of the install root.
    expect(ws.replace(/[\\/][^\\/]+$/, "")).toBe(root.replace(/[\\/][^\\/]+$/, ""));
  });

  it("backup + restore round-trips file content exactly", async () => {
    const ctx = await createTransactionContext(join(testRoot, "ws"), "01TEST");
    const dest = join(testRoot, "target.json");
    await writeFile(dest, '{"a":1}\n');

    const payload: StagedPayload = {
      dest,
      kind: "json-merge",
      stagedPath: join(ctx.stagingDir, "payloads", "0"),
      isDirectory: false,
      expectedHash: "irrelevant",
    };

    const manifest = await backupDestinations(ctx, [payload]);
    expect(manifest.records).toHaveLength(1);
    expect(manifest.records[0]!.wasAbsent).toBe(false);

    // Mutate the destination, then roll back.
    await writeFile(dest, '{"a":999}\n');
    const failures = await restoreFromBackups(manifest);
    expect(failures).toEqual([]);
    expect(await readFile(dest, "utf8")).toBe('{"a":1}\n');

    await ctx.cleanup();
  });

  it("backup records a missing destination as absent and rollback removes it", async () => {
    const ctx = await createTransactionContext(join(testRoot, "ws2"), "01TEST2");
    const dest = join(testRoot, "not-there.json");

    const payload: StagedPayload = {
      dest,
      kind: "json-merge",
      stagedPath: join(ctx.stagingDir, "payloads", "0"),
      isDirectory: false,
      expectedHash: "irrelevant",
    };

    const manifest = await backupDestinations(ctx, [payload]);
    expect(manifest.records[0]!.wasAbsent).toBe(true);

    // The install "created" the file — rollback must delete it again.
    await writeFile(dest, "created by install\n");
    const failures = await restoreFromBackups(manifest);
    expect(failures).toEqual([]);
    expect(await pathExists(dest)).toBe(false);

    await ctx.cleanup();
  });

  it("backup + restore round-trips a directory tree", async () => {
    const ctx = await createTransactionContext(join(testRoot, "ws3"), "01TEST3");
    const dest = join(testRoot, "tree");
    await mkdir(join(dest, "nested"), { recursive: true });
    await writeFile(join(dest, "a.txt"), "A\n");
    await writeFile(join(dest, "nested", "b.txt"), "B\n");

    const payload: StagedPayload = {
      dest,
      kind: "copy",
      stagedPath: join(ctx.stagingDir, "payloads", "0"),
      isDirectory: true,
      expectedHash: "irrelevant",
    };

    const manifest = await backupDestinations(ctx, [payload]);
    expect(manifest.records[0]!.isDirectory).toBe(true);
    expect(manifest.records[0]!.wasAbsent).toBe(false);

    // Wipe + replace the tree, then roll back.
    await rm(dest, { recursive: true, force: true });
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "other.txt"), "OTHER\n");

    const failures = await restoreFromBackups(manifest);
    expect(failures).toEqual([]);
    expect(await readFile(join(dest, "a.txt"), "utf8")).toBe("A\n");
    expect(await readFile(join(dest, "nested", "b.txt"), "utf8")).toBe("B\n");

    await ctx.cleanup();
  });

  it("verify detects a hash mismatch on a written file", async () => {
    const ctx = await createTransactionContext(join(testRoot, "ws4"), "01TEST4");
    const dest = join(testRoot, "verify.json");
    await writeFile(dest, "actual\n");

    const payload: StagedPayload = {
      dest,
      kind: "json-merge",
      stagedPath: join(ctx.stagingDir, "payloads", "0"),
      isDirectory: false,
      expectedHash: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    const result = await verifyAppliedState([payload]);
    expect(result.ok).toBe(false);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]!.dest).toBe(dest);

    await ctx.cleanup();
  });

  it("verify detects a partially-copied directory", async () => {
    const ctx = await createTransactionContext(join(testRoot, "ws5"), "01TEST5");
    const dest = join(testRoot, "partial");
    await mkdir(dest, { recursive: true });
    await writeFile(join(dest, "present.txt"), "x\n");
    // "missing.txt" was never written — a partial copy.

    const payload: StagedPayload = {
      dest,
      kind: "copy",
      stagedPath: join(ctx.stagingDir, "payloads", "0"),
      isDirectory: true,
      expectedHash: "unused",
      fileHashes: { "present.txt": "aaa", "missing.txt": "bbb" },
    };

    const result = await verifyAppliedState([payload]);
    expect(result.ok).toBe(false);
    expect(result.mismatches.some((m) => m.dest.endsWith("missing.txt"))).toBe(true);

    await ctx.cleanup();
  });

  it("intent manifest round-trips through disk", async () => {
    const ctx = await createTransactionContext(join(testRoot, "ws6"), "01TEST6");
    await writeInstallIntent(ctx, {
      installationId: "01TEST6",
      pluginId: "tx-plugin",
      agent: "opencode",
      createdAt: 1234,
      intentVersion: INTENT_VERSION,
      payloads: [{ dest: "C:/x", kind: "copy", isDirectory: true, expectedHash: "h" }],
    });

    const intent = await readInstallIntent(ctx);
    expect(intent).not.toBeNull();
    expect(intent!.installationId).toBe("01TEST6");
    expect(intent!.intentVersion).toBe(INTENT_VERSION);
    expect(intent!.payloads).toHaveLength(1);

    await ctx.cleanup();
    // Cleanup purges the whole workspace.
    expect(await pathExists(ctx.stagingDir)).toBe(false);
    expect(await pathExists(ctx.backupsDir)).toBe(false);
  });

  it("tree hash is stable and order-independent", () => {
    const a = hashTree({ "b.txt": "2", "a.txt": "1" });
    const b = hashTree({ "a.txt": "1", "b.txt": "2" });
    expect(a).toBe(b);
    expect(hashTree({ "a.txt": "1" })).not.toBe(hashTree({ "a.txt": "2" }));
  });

  // ── End-to-end install behaviour ──────────────────────────────────────────

  it("successful install leaves no scratch directories behind", async () => {
    await executeInstall(agent, bundles[agent], opts());

    const ws = transactionWorkspaceRoot(agent, { home, projectDir: project, codexHome: project }, pluginName);
    expect(await pathExists(ws)).toBe(false);

    // And the journal was committed.
    const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName });
    const journal = await readJournal(root);
    expect(journal).not.toBeNull();
    expect(journal!.pluginId).toBe(pluginName);
  });

  it("successful install purges the staging area of the workspace parent", async () => {
    await executeInstall(agent, bundles[agent], opts());
    const pluginsDir = join(project, ".opencode", "plugins");
    const entries = await readdir(pluginsDir);
    // No leftover .anyplugin-tx-* scratch directory.
    expect(entries.filter((e) => e.startsWith(".anyplugin-tx-"))).toEqual([]);
  });

  it("dry-run install creates no scratch directories and no files", async () => {
    const result = await executeInstall(agent, bundles[agent], { ...opts(), dryRun: true });
    expect(result.notes.some((n) => n.startsWith("would "))).toBe(true);

    const ws = transactionWorkspaceRoot(agent, { home, projectDir: project, codexHome: project }, pluginName);
    expect(await pathExists(ws)).toBe(false);

    const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName });
    expect(await pathExists(root)).toBe(false);
  });

  it("install aborts on conflict and leaves no scratch directories", async () => {
    const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName });
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "user-file.txt"), "USER DATA");

    await expect(executeInstall(agent, bundles[agent], opts())).rejects.toThrow();

    const ws = transactionWorkspaceRoot(agent, { home, projectDir: project, codexHome: project }, pluginName);
    expect(await pathExists(ws)).toBe(false);
    // The user's file is untouched.
    expect(await readFile(join(root, "user-file.txt"), "utf8")).toBe("USER DATA");
  });

  it("pre-existing config is preserved byte-exact when install succeeds", async () => {
    const ocJson = join(project, "opencode.json");
    const original = '{"keep":"me"}\n';
    await writeFile(ocJson, original);

    await executeInstall(agent, bundles[agent], opts());

    const after = JSON.parse(await readFile(ocJson, "utf8")) as Record<string, unknown>;
    expect(after["keep"]).toBe("me");
  });

  it("uninstall after a transactional install restores the original config byte-exact", async () => {
    const ocJson = join(project, "opencode.json");
    const original = '{"keep":"me"}\n';
    await writeFile(ocJson, original);

    await executeInstall(agent, bundles[agent], opts());
    await executeUninstall(agent, bundles[agent], opts());

    expect(await readFile(ocJson, "utf8")).toBe(original);
  });

  // ── Rollback engine ───────────────────────────────────────────────────────

  it("a failure during apply rolls every destination back", async () => {
    const ocJson = join(project, "opencode.json");
    const originalJson = '{"keep":"me"}\n';
    const agentsMd = join(project, "AGENTS.md");
    const originalAgents = "# My project\n\nkeep me\n";
    await writeFile(ocJson, originalJson);
    await writeFile(agentsMd, originalAgents);

    const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName });
    const skillsDir = join(project, ".opencode", "skills", "demo");

    // Fail on the SECOND applied destination so at least one destination has
    // already been mutated when the failure hits.
    let applied = 0;
    await expect(
      executeInstall(agent, bundles[agent], {
        ...opts(),
        __onApplied: () => {
          applied += 1;
          if (applied === 2) throw new Error("INJECTED FAILURE");
        },
      }),
    ).rejects.toThrow("INJECTED FAILURE");

    // Every destination is back to its pre-install state.
    expect(await readFile(ocJson, "utf8")).toBe(originalJson);
    expect(await readFile(agentsMd, "utf8")).toBe(originalAgents);
    // The plugin root was removed (it did not exist before the install).
    expect(await pathExists(root)).toBe(false);
    // The copied skill dir was removed too.
    expect(await pathExists(skillsDir)).toBe(false);
  });

  it("a failure during apply leaves NO scratch directories and NO journal", async () => {
    let applied = 0;
    await expect(
      executeInstall(agent, bundles[agent], {
        ...opts(),
        __onApplied: () => {
          applied += 1;
          if (applied === 2) throw new Error("INJECTED FAILURE");
        },
      }),
    ).rejects.toThrow("INJECTED FAILURE");

    const ws = transactionWorkspaceRoot(agent, { home, projectDir: project, codexHome: project }, pluginName);
    expect(await pathExists(ws)).toBe(false);

    const pluginsDir = join(project, ".opencode", "plugins");
    const entries = await readdir(pluginsDir).catch(() => [] as string[]);
    expect(entries.filter((e) => e.startsWith(".anyplugin-tx-"))).toEqual([]);

    // No journal was committed for the failed install.
    const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName });
    expect(await pathExists(join(root, ".anyplugin-state.json"))).toBe(false);
  });

  it("a failure during apply leaves ZERO partial files in a fresh destination", async () => {
    const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName });
    const skillsDir = join(project, ".opencode", "skills", "demo");

    let applied = 0;
    await expect(
      executeInstall(agent, bundles[agent], {
        ...opts(),
        __onApplied: () => {
          applied += 1;
          if (applied === 2) throw new Error("INJECTED FAILURE");
        },
      }),
    ).rejects.toThrow("INJECTED FAILURE");

    // No partial plugin tree survives.
    expect(await pathExists(root)).toBe(false);
    expect(await pathExists(join(root, "anyplugin.plugin.yaml"))).toBe(false);
    // No partial skill copy survives.
    expect(await pathExists(skillsDir)).toBe(false);
    expect(await pathExists(join(skillsDir, "SKILL.md"))).toBe(false);
  });

  it("rollback restores a pre-existing config that the failed install would have merged", async () => {
    const ocJson = join(project, "opencode.json");
    const originalJson = '{"keep":"me"}\n';
    await writeFile(ocJson, originalJson);

    let applied = 0;
    await expect(
      executeInstall(agent, bundles[agent], {
        ...opts(),
        __onApplied: () => {
          applied += 1;
          if (applied === 2) throw new Error("INJECTED FAILURE");
        },
      }),
    ).rejects.toThrow("INJECTED FAILURE");

    // Byte-exact restoration, not a re-serialization.
    expect(await readFile(ocJson, "utf8")).toBe(originalJson);
  });

  it("a failure on the FIRST applied destination still rolls back cleanly", async () => {
    const ocJson = join(project, "opencode.json");
    const originalJson = '{"keep":"me"}\n';
    await writeFile(ocJson, originalJson);

    await expect(
      executeInstall(agent, bundles[agent], {
        ...opts(),
        __onApplied: () => {
          throw new Error("INJECTED FAILURE");
        },
      }),
    ).rejects.toThrow("INJECTED FAILURE");

    expect(await readFile(ocJson, "utf8")).toBe(originalJson);
    const ws = transactionWorkspaceRoot(agent, { home, projectDir: project, codexHome: project }, pluginName);
    expect(await pathExists(ws)).toBe(false);
  });

  it("the staged payload is byte-identical to what lands on the host", async () => {
    await executeInstall(agent, bundles[agent], opts());
    const root = installedRoot(agent, { home, projectDir: project, codexHome: project, pluginName });

    // The {{PLUGIN_ROOT}} token resolves to the FINAL destination, never the
    // staging path (which no longer exists after the install). JSON escapes the
    // backslashes, so compare against the escaped form too.
    const raw = await readFile(join(project, "opencode.json"), "utf8");
    const escapedRoot = root.replace(/\\/g, "\\\\");
    expect(raw.includes(root) || raw.includes(escapedRoot)).toBe(true);
    expect(raw).not.toContain(".anyplugin-tx-");
    expect(raw).not.toContain(".anyplugin-staging");

    // And the copied bundle on disk carries the same substituted path.
    const bundleConfig = join(root, "opencode.json");
    if (await pathExists(bundleConfig)) {
      const bundleRaw = await readFile(bundleConfig, "utf8");
      expect(bundleRaw).not.toContain(".anyplugin-tx-");
      expect(bundleRaw).not.toContain(".anyplugin-staging");
    }
  });
});
