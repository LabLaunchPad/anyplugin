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
 * Antigravity adapter. Emits a plugins/<name>/ bundle for .agents/plugins/ auto-scan:
 * plugin.json, skills/, hooks.json (command hooks, camelCase JSON protocol),
 * mcp_config.json ({mcpServers: ...}, serverUrl for HTTP). Hook commands need absolute
 * paths at install time → emitted as {{PLUGIN_ROOT}} placeholder, substituted by the CLI.
 */
export const PLUGIN_ROOT_TOKEN = "{{PLUGIN_ROOT}}";

export async function emitAntigravity(plugin: ParsedPlugin, opts: EmitOptions): Promise<EmittedBundle> {
  const files: string[] = [];
  const warnings: string[] = [];
  const out = join(opts.outDir, "plugins", plugin.name);
  const track = (abs: string) => files.push(toPosix(abs.slice(opts.outDir.length + 1)));

  await writeIfChanged(join(out, "plugin.json"), jsonStable({ name: plugin.name, description: plugin.description }));
  track(join(out, "plugin.json"));

  for (const skillDir of plugin.skills) {
    for (const f of await copyDir(join(opts.pluginRoot, skillDir), join(out, "skills", basename(skillDir)))) track(f);
  }
  for (const agentFile of plugin.agents) {
    await copyOne(join(opts.pluginRoot, agentFile), join(out, "agents", basename(agentFile)));
    track(join(out, "agents", basename(agentFile)));
  }
  if (plugin.knowledge) {
    for (const f of await copyDir(join(opts.pluginRoot, plugin.knowledge), join(out, "knowledge"))) track(f);
  }

  // hooks.json — 5 events; session-start folds into PreInvocation.
  if (plugin.hooks.length > 0) {
    await copyOne(opts.runnerAbsPath, join(out, "hooks", opts.runnerRelPath));
    track(join(out, "hooks", opts.runnerRelPath));
    for (const hook of plugin.hooks) {
      await copyOne(join(opts.pluginRoot, hook.handler), join(out, "hooks", "handlers", `${hook.id}.mjs`));
      track(join(out, "hooks", "handlers", `${hook.id}.mjs`));
    }
    const hooksJson: Record<string, unknown> = {};
    const byEvent = new Map<string, typeof plugin.hooks>();
    for (const hook of plugin.hooks) {
      const native = NATIVE_EVENT_MAP["antigravity"][hook.event];
      if (!native) {
        warnings.push(`hook ${hook.id}: canonical event ${hook.event} has no Antigravity mapping; skipped`);
        continue;
      }
      const list = byEvent.get(native) ?? [];
      list.push(hook);
      byEvent.set(native, list);
    }
    for (const [native, hooks] of byEvent) {
      const groups = new Map<string, typeof hooks>();
      for (const hook of hooks) {
        const matcher = hook.match ?? ".*";
        const list = groups.get(matcher) ?? [];
        list.push(hook);
        groups.set(matcher, list);
      }
      hooksJson[native] = [...groups.entries()].map(([matcher, list]) => ({
        matcher,
        hooks: list.map((h) => ({
          type: "command",
          command: `node "${PLUGIN_ROOT_TOKEN}/hooks/${opts.runnerRelPath}" ${h.id}`,
          timeout: Math.min(h.timeoutSec ?? 30, 30),
        })),
      }));
    }
    await writeIfChanged(join(out, "hooks.json"), jsonStable(hooksJson));
    track(join(out, "hooks.json"));
  }

  // mcp_config.json — mcpServers map; HTTP MUST use serverUrl (camelCase), not url.
  const serverNames = Object.keys(plugin.mcp.servers);
  let mcpPatch: Record<string, unknown> | undefined;
  if (serverNames.length > 0) {
    if (opts.mcpRuntimeAbsDir) {
      for (const f of await copyDir(opts.mcpRuntimeAbsDir, join(out, "mcp"))) track(f);
    }
    const mcpServers: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(plugin.mcp.servers)) {
      if (server.transport === "http") {
        mcpServers[name] = {
          serverUrl: server.url ?? "",
          ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
        };
      } else {
        mcpServers[name] = {
          command: server.command ?? "node",
          args: server.args,
          ...(Object.keys(server.env).length ? { env: server.env } : {}),
        };
      }
    }
    await writeIfChanged(join(out, "mcp_config.json"), jsonStable({ mcpServers }));
    track(join(out, "mcp_config.json"));
    mcpPatch = { mcpServers };
  }

  const actions: InstallAction[] = [
    { kind: "copy", srcRel: `plugins/${plugin.name}`, destAbs: "{{PROJECT}}/.agents/plugins/{{PLUGIN_NAME}}", role: "root" },
  ];
  const configActions: InstallAction[] = mcpPatch
    ? [{ kind: "json-merge", file: "{{PROJECT}}/.agents/mcp_config.json", patch: mcpPatch }]
    : [];
  return {
    agent: "antigravity",
    dir: opts.outDir,
    files: [...new Set(files)],
    warnings,
    install: {
      actions: [...actions, ...configActions],
      summary: "copy plugins/<name> into workspace .agents/plugins/ (auto-scanned) and merge mcp_config.json",
    },
  };
}

export const antigravityAdapter: Adapter = {
  agent: "antigravity",
  emit: emitAntigravity,
  targets: ({ home, projectDir }) => ({
    workspaceAgents: join(projectDir, ".agents"),
    globalConfig: join(home, ".gemini", "config"),
    globalMcp: join(home, ".gemini", "config", "mcp_config.json"),
  }),
};

async function copyOne(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}
