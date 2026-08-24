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
import { basename, dirname, join } from "node:path";
import { copyFile, mkdir } from "node:fs/promises";

/**
 * OpenCode adapter. OpenCode loads TS plugins in-process (v1 function API on released
 * builds; v2 dev core only accepts {id, setup} modules). We therefore emit BOTH:
 *  - plugin.ts: v1 shim bridging OpenCode hooks to the canonical stdio runner
 *    (works on released builds; silently dropped by v2 without side effects)
 *  - v2-safe artifacts: skills/, commands/, agents/ markdown + opencode.json merge
 *    fragment (skills paths + mcp) that work regardless of plugin API version.
 */
export async function emitOpencode(plugin: ParsedPlugin, opts: EmitOptions): Promise<EmittedBundle> {
  const files: string[] = [];
  const warnings: string[] = [];
  const out = opts.outDir;
  const track = (abs: string) => files.push(toPosix(abs.slice(out.length + 1)));

  // Canonical hook id → OpenCode native hook/event name.
  const bridge: { id: string; opencode: string; kind: "tool-before" | "tool-after" | "chat" | "permission" | "event" }[] = [];
  for (const hook of plugin.hooks) {
    const native = NATIVE_EVENT_MAP["opencode"][hook.event];
    if (!native) {
      warnings.push(`hook ${hook.id}: canonical event ${hook.event} has no OpenCode mapping; skipped`);
      continue;
    }
    const kind = native === "tool.execute.before" ? "tool-before"
      : native === "tool.execute.after" ? "tool-after"
      : native === "permission.asked" ? "permission"
      : "event";
    bridge.push({ id: hook.id, opencode: native, kind });
  }

  if (bridge.length > 0) {
    await copyOne(opts.runnerAbsPath, join(out, "hooks", opts.runnerRelPath));
    track(join(out, "hooks", opts.runnerRelPath));
    for (const hook of plugin.hooks) {
      await copyOne(join(opts.pluginRoot, hook.handler), join(out, "hooks", "handlers", `${hook.id}.mjs`));
      track(join(out, "hooks", "handlers", `${hook.id}.mjs`));
    }
    const shim = renderShim(plugin.name, bridge);
    await writeIfChanged(join(out, "plugin.ts"), shim);
    track(join(out, "plugin.ts"));
  }

  for (const skillDir of plugin.skills) {
    for (const f of await copyDir(join(opts.pluginRoot, skillDir), join(out, "skills", basename(skillDir)))) track(f);
  }
  for (const cmd of plugin.commands) {
    await copyOne(join(opts.pluginRoot, cmd), join(out, "commands", basename(cmd)));
    track(join(out, "commands", basename(cmd)));
  }
  for (const agentFile of plugin.agents) {
    await copyOne(join(opts.pluginRoot, agentFile), join(out, "agent", basename(agentFile)));
    track(join(out, "agent", basename(agentFile)));
  }
  if (plugin.knowledge) {
    for (const f of await copyDir(join(opts.pluginRoot, plugin.knowledge), join(out, "knowledge"))) track(f);
  }

  // opencode.json merge fragment: mcp servers (command as argv array!) + explicit skills paths (v2).
  const patch: Record<string, unknown> = {};
  const serverNames = Object.keys(plugin.mcp.servers);
  if (serverNames.length > 0) {
    if (opts.mcpRuntimeAbsDir) {
      for (const f of await copyDir(opts.mcpRuntimeAbsDir, join(out, "mcp"))) track(f);
    }
    const mcp: Record<string, unknown> = {};
    for (const [name, server] of Object.entries(plugin.mcp.servers)) {
      if (server.transport === "http") {
        mcp[name] = { type: "remote", url: server.url ?? "" };
      } else {
        mcp[name] = {
          type: "local",
          command: [server.command ?? "node", ...server.args],
          ...(Object.keys(server.env).length ? { environment: server.env } : {}),
        };
      }
    }
    patch["mcp"] = mcp;
  }
  if (plugin.skills.length > 0) {
    patch["skills"] = plugin.skills.map((s) => `{{PLUGIN_ROOT}}/${s.replace(/^\.\//, "")}`);
  }
  await writeIfChanged(join(out, "opencode.merge.json"), jsonStable(patch));
  track(join(out, "opencode.merge.json"));

  const actions: InstallAction[] = [];
  if (bridge.length > 0) {
    actions.push({ kind: "copy", srcRel: ".", destAbs: "{{PROJECT}}/.opencode/plugins/{{PLUGIN_NAME}}", role: "root" });
  }
  for (const skillDir of plugin.skills) {
    actions.push({ kind: "copy", srcRel: `skills/${basename(skillDir)}`, destAbs: "{{PROJECT}}/.opencode/skills", destFile: basename(skillDir) });
  }
  for (const cmd of plugin.commands) {
    actions.push({ kind: "copy", srcRel: `commands/${basename(cmd)}`, destAbs: "{{PROJECT}}/.opencode/commands", destFile: basename(cmd) });
  }
  for (const agentFile of plugin.agents) {
    actions.push({ kind: "copy", srcRel: `agent/${basename(agentFile)}`, destAbs: "{{PROJECT}}/.opencode/agent", destFile: basename(agentFile) });
  }
  if (Object.keys(patch).length > 0) {
    actions.push({ kind: "json-merge", file: "{{PROJECT}}/opencode.json", patch });
  }
  actions.push({
    kind: "md-append",
    file: "{{PROJECT}}/AGENTS.md",
    marker: plugin.name,
    content: `\n<!-- anyplugin:${plugin.name} begin -->\n# ${plugin.name}\n\n${plugin.description}\n<!-- anyplugin:${plugin.name} end -->\n`,
  });

  return {
    agent: "opencode",
    dir: out,
    files: [...new Set(files)],
    warnings,
    install: {
      actions,
      summary: "copy plugin.ts into .opencode/plugins/, skills/commands/agents into .opencode/, merge opencode.json",
    },
  };
}

interface Bridge {
  id: string;
  opencode: string;
  kind: "tool-before" | "tool-after" | "chat" | "permission" | "event";
}

function renderShim(name: string, bridge: Bridge[]): string {
  const map = JSON.stringify(
    Object.fromEntries(bridge.map((b) => [b.opencode, b.id])),
    null,
    2,
  );
  return `/**
 * ${name} — generated by AnyPlugin (OpenCode v1 shim).
 * Bridges OpenCode in-process hooks to the canonical stdio hook runner
 * (hooks/runner.js) so every platform executes identical handler code.
 * On v2 dev cores (which only load {id, setup} modules) this file is
 * silently ignored — skills/commands/agents artifacts carry the load there.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(ROOT, "hooks", "runner.js");

const HOOK_IDS: Record<string, string> = ${map};

function run(id: string, payload: unknown): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUNNER, id], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ANYPLUGIN_HOST: "opencode" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", () => resolve({ code: 1, stdout: "", stderr: "runner spawn failed" }));
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function maybeRun(hookName: string, payload: unknown): Promise<Record<string, unknown> | undefined> {
  const id = HOOK_IDS[hookName];
  if (!id) return undefined;
  const result = await run(id, payload);
  if (result.code === 0 && result.stdout.trim()) {
    try {
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export const ${shimConstName(name)}Plugin = async () => ({
  "shell.env": async (_input: unknown, output: { env: Record<string, string> }) => {
    output.env["ANYPLUGIN_HOST"] = "opencode";
  },
  "tool.execute.before": async (input: Record<string, unknown>, output: { args: unknown }) => {
    const out = await maybeRun("tool.execute.before", { ...input, hook_event_name: "tool.execute.before" });
    if (out && "updatedInput" in out) (output as Record<string, unknown>)["args"] = (out["updatedInput"] as Record<string, unknown>)["args"];
  },
  "tool.execute.after": async (input: Record<string, unknown>, output: Record<string, unknown>) => {
    const out = await maybeRun("tool.execute.after", { ...input, hook_event_name: "tool.execute.after" });
    if (out) Object.assign(output, out);
  },
  "permission.asked": async (input: Record<string, unknown>, output: { status: string }) => {
    const out = await maybeRun("permission.asked", { ...input, hook_event_name: "permission.asked" });
    if (out && typeof out["permissionDecision"] === "string") {
      output.status = out["permissionDecision"] as string;
    }
  },
  "event": async ({ event }: { event: { name?: string; properties?: Record<string, unknown> } }) => {
    const name = event?.name ?? "";
    if (name === "session.created" || name === "session.idle") {
      await maybeRun(name, { ...(event.properties ?? {}), hook_event_name: name });
    }
  },
});

export default ${shimConstName(name)}Plugin;
`;
}

function shimConstName(pluginName: string): string {
  return pluginName.split("-").map((p) => (p[0] ?? "").toUpperCase() + p.slice(1)).join("");
}

export const opencodeAdapter: Adapter = {
  agent: "opencode",
  emit: emitOpencode,
  targets: ({ home, projectDir }) => ({
    projectOpencode: join(projectDir, ".opencode"),
    projectConfig: join(projectDir, "opencode.json"),
    globalConfig: join(home, ".config", "opencode"),
  }),
};

async function copyOne(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}
