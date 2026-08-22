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
} from "@agent-prism/core";
import { basename, dirname, join } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";

/**
 * Claude Code adapter. Emits a .claude-plugin bundle: manifest, skills/, commands/,
 * agents/, hooks/hooks.json (command hooks via ${CLAUDE_PLUGIN_ROOT}), .mcp.json (direct map).
 */
export async function emitClaude(plugin: ParsedPlugin, opts: EmitOptions): Promise<EmittedBundle> {
  const files: string[] = [];
  const warnings: string[] = [];
  const out = opts.outDir;
  const track = (abs: string) => files.push(toPosix(abs.slice(out.length + 1)));

  const manifest: Record<string, unknown> = {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
  };
  if (plugin.displayName) manifest["displayName"] = plugin.displayName;
  if (plugin.author) manifest["author"] = plugin.author;
  if (plugin.homepage) manifest["homepage"] = plugin.homepage;
  if (plugin.license) manifest["license"] = plugin.license;
  if (plugin.keywords.length) manifest["keywords"] = plugin.keywords;
  await writeIfChanged(join(out, ".claude-plugin", "plugin.json"), jsonStable(manifest));
  track(join(out, ".claude-plugin", "plugin.json"));

  // Runtime: runner + handler modules copied so ${CLAUDE_PLUGIN_ROOT} resolves at runtime.
  if (plugin.hooks.length > 0) {
    track(await copyOne(opts.runnerAbsPath, join(out, "hooks", opts.runnerRelPath)));
    for (const hook of plugin.hooks) {
      track(await copyOne(join(opts.pluginRoot, hook.handler), join(out, "hooks", "handlers", `${hook.id}.mjs`)));
    }
    const hooksJson: Record<string, unknown> = { hooks: {} };
    const byEvent = new Map<string, typeof plugin.hooks>();
    for (const hook of plugin.hooks) {
      const native = NATIVE_EVENT_MAP["claude-code"][hook.event];
      if (!native) {
        warnings.push(`hook ${hook.id}: canonical event ${hook.event} has no Claude Code mapping; skipped`);
        continue;
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
          command: `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${opts.runnerRelPath}" ${h.id}`,
          ...(h.timeoutSec ? { timeout: h.timeoutSec } : {}),
        })),
      }));
    }
    track(await writeIfChanged2(join(out, "hooks", "hooks.json"), jsonStable(hooksJson)));
  }

  for (const skillDir of plugin.skills) {
    for (const f of await copyDir(join(opts.pluginRoot, skillDir), join(out, "skills", basename(skillDir)))) track(f);
  }
  for (const cmd of plugin.commands) {
    track(await copyOne(join(opts.pluginRoot, cmd), join(out, "commands", basename(cmd))));
  }
  for (const agent of plugin.agents) {
    track(await copyOne(join(opts.pluginRoot, agent), join(out, "agents", basename(agent))));
  }
  if (plugin.knowledge) {
    for (const f of await copyDir(join(opts.pluginRoot, plugin.knowledge), join(out, "knowledge"))) track(f);
  }

  const serverNames = Object.keys(plugin.mcp.servers);
  if (serverNames.length > 0) {
    const mcp: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(plugin.mcp.servers)) {
      if (server.transport === "http") {
        mcp[name] = {
          type: "http",
          url: server.url ?? "",
          ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
        };
      } else {
        mcp[name] = {
          command: server.command ?? "node",
          args: server.args,
          ...(Object.keys(server.env).length ? { env: server.env } : {}),
        };
      }
    }
    track(await writeIfChanged2(join(out, ".mcp.json"), jsonStable(mcp)));
  }

  const actions: InstallAction[] = [
    { kind: "copy", srcRel: ".", destAbs: "{{CLAUDE_PLUGINS_DIR}}/{{PLUGIN_NAME}}" },
  ];
  return {
    agent: "claude-code",
    dir: out,
    files: [...new Set(files)],
    warnings,
    install: {
      actions,
      summary: "copy bundle into ~/.claude/plugins/<name> and enable via /plugin or enabledPlugins in settings.json",
    },
  };
}

export const claudeAdapter: Adapter = {
  agent: "claude-code",
  emit: emitClaude,
  targets: ({ home }) => ({
    pluginsDir: join(home, ".claude", "plugins"),
    settings: join(home, ".claude", "settings.json"),
  }),
};

async function copyOne(src: string, dest: string): Promise<string> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return dest;
}

async function writeIfChanged2(path: string, content: string): Promise<string> {
  await writeIfChanged(path, content);
  return path;
}
