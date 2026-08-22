import {
  type ParsedPlugin,
  type EmitOptions,
  type EmittedBundle,
  type Adapter,
  type InstallAction,
  NATIVE_EVENT_MAP,
  copyDir,
  writeIfChanged,
  toPosix,
  jsonStable,
} from "@lablaunchpad/core";
import { join } from "node:path";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { dirname, basename } from "node:path";
import { stringify as stringifyToml } from "smol-toml";

/**
 * Codex CLI adapter. Emits a .codex-plugin bundle (plugin.json + skills/ + hooks/hooks.json,
 * hooks enabled by default since ~0.147 and CLAUDE_PLUGIN_ROOT injected for plugin hooks)
 * plus a config.append.toml fragment for [mcp_servers] registration.
 */
export async function emitCodex(plugin: ParsedPlugin, opts: EmitOptions): Promise<EmittedBundle> {
  const files: string[] = [];
  const warnings: string[] = [];
  const out = opts.outDir;
  const track = (abs: string) => files.push(toPosix(abs.slice(out.length + 1)));

  const manifest: Record<string, unknown> = {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
  };
  if (plugin.author) manifest["author"] = plugin.author;
  if (plugin.license) manifest["license"] = plugin.license;
  if (plugin.homepage) manifest["homepage"] = plugin.homepage;
  if (plugin.skills.length > 0) manifest["skills"] = "./skills/";
  await writeIfChanged(join(out, ".codex-plugin", "plugin.json"), jsonStable(manifest));
  track(join(out, ".codex-plugin", "plugin.json"));

  // Skills land in .agents/skills search paths via the plugin's skills/ dir.
  for (const skillDir of plugin.skills) {
    for (const f of await copyDir(join(opts.pluginRoot, skillDir), join(out, "skills", basename(skillDir)))) track(f);
  }

  // Knowledge bundle ships as sibling dir; referenced from skill bodies.
  if (plugin.knowledge) {
    for (const f of await copyDir(join(opts.pluginRoot, plugin.knowledge), join(out, "knowledge"))) track(f);
  }

  // Hooks: hooks/hooks.json in plugin root is auto-registered for trusted plugins.
  if (plugin.hooks.length > 0) {
    await copyOne(opts.runnerAbsPath, join(out, "hooks", opts.runnerRelPath));
    track(join(out, "hooks", opts.runnerRelPath));
    for (const hook of plugin.hooks) {
      await copyOne(join(opts.pluginRoot, hook.handler), join(out, "hooks", "handlers", `${hook.id}.mjs`));
      track(join(out, "hooks", "handlers", `${hook.id}.mjs`));
    }
    const hooksJson: Record<string, unknown> = { hooks: {} };
    const byEvent = new Map<string, typeof plugin.hooks>();
    for (const hook of plugin.hooks) {
      const native = NATIVE_EVENT_MAP["codex"][hook.event];
      if (!native) {
        warnings.push(`hook ${hook.id}: canonical event ${hook.event} has no Codex mapping; skipped`);
        continue;
      }
      if (native === "SessionEnd") {
        warnings.push(`hook ${hook.id}: Codex SessionEnd timeout is forced to 1-3s; keep handlers instant`);
      }
      const list = byEvent.get(native) ?? [];
      list.push(hook);
      byEvent.set(native, list);
    }
    for (const [native, hooks] of byEvent) {
      const groups = new Map<string, typeof hooks>();
      for (const hook of hooks) {
        const matcher = hook.match ?? "*";
        const list = groups.get(matcher) ?? [];
        list.push(hook);
        groups.set(matcher, list);
      }
      (hooksJson["hooks"] as Record<string, unknown>)[native] = [...groups.entries()].map(([matcher, list]) => ({
        ...(matcher !== "*" ? { matcher } : {}),
        hooks: list.map((h) => ({
          type: "command",
          // Codex sets PLUGIN_ROOT + CLAUDE_PLUGIN_ROOT for plugin hooks.
          command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${opts.runnerRelPath}" ${h.id}`,
          ...(h.timeoutSec ? { timeout: h.timeoutSec } : {}),
        })),
      }));
    }
    await writeIfChanged(join(out, "hooks", "hooks.json"), jsonStable(hooksJson));
    track(join(out, "hooks", "hooks.json"));
  }

  // MCP: rendered as a config.toml fragment the CLI appends under [mcp_servers].
  const serverNames = Object.keys(plugin.mcp.servers);
  if (serverNames.length > 0) {
    if (opts.mcpRuntimeAbsDir) {
      for (const f of await copyDir(opts.mcpRuntimeAbsDir, join(out, "mcp"))) track(f);
    }
    // Nested objects so smol-toml renders [mcp_servers.<name>] table headers, not quoted dotted keys.
    const serversTable: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(plugin.mcp.servers)) {
      if (server.transport === "http") {
        serversTable[name] = {
          url: server.url ?? "",
          ...(Object.keys(server.headers).length ? { http_headers: server.headers } : {}),
        };
      } else {
        serversTable[name] = {
          command: server.command ?? "node",
          args: server.args,
          ...(Object.keys(server.env).length ? { env: server.env } : {}),
        };
      }
    }
    const toml = stringifyToml({ mcp_servers: serversTable });
    await writeIfChanged(join(out, "config.append.toml"), toml);
    track(join(out, "config.append.toml"));
  }

  // AGENTS.md pointer so Codex picks up plugin guidance from the repo's AGENTS.md.
  const agentsMd = `# ${plugin.name}\n\n${plugin.description}\n\nSee the \`${plugin.name}\` skills ($${plugin.name}) for capabilities.\n`;
  await writeIfChanged(join(out, "AGENTS.md"), agentsMd);
  track(join(out, "AGENTS.md"));

  const actions: InstallAction[] = [
    {
      kind: "copy",
      srcRel: ".",
      destAbs: "{{CODEX_PLUGIN_DIR}}",
      role: "root",
    },
  ];
  const configActions: InstallAction[] = serverNames.length
    ? [{ kind: "toml-merge", file: "{{CODEX_HOME}}/config.toml", append: await readTomlFragment(out) }]
    : [];
  return {
    agent: "codex",
    dir: out,
    files: [...new Set(files)],
    warnings,
    install: {
      actions: [...actions, ...configActions],
      summary: "copy bundle into the Codex plugin directory (codex plugin add / local marketplace) and merge [mcp_servers] into config.toml",
    },
  };
}

async function readTomlFragment(out: string): Promise<string> {
  try {
    return await readFile(join(out, "config.append.toml"), "utf8");
  } catch {
    return "";
  }
}

export const codexAdapter: Adapter = {
  agent: "codex",
  emit: emitCodex,
  targets: ({ home, projectDir }) => ({
    codexHome: process.env["CODEX_HOME"] ?? join(home, ".codex"),
    config: join(process.env["CODEX_HOME"] ?? join(home, ".codex"), "config.toml"),
    skillsDir: join(home, ".agents", "skills"),
    projectAgentsMd: join(projectDir, "AGENTS.md"),
  }),
};

async function copyOne(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}
