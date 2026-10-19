import {
  type ParsedPlugin,
  type EmitOptions,
  type EmittedBundle,
  type Adapter,
  type InstallAction,
  NATIVE_EVENT_MAP,
  HOOK_POLICIES_FILENAME,
  renderHookPolicies,
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
  const bridge: { id: string; opencode: string; kind: "tool-before" | "tool-after" | "chat" | "permission" | "event"; match?: string }[] = [];
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
    bridge.push({ id: hook.id, opencode: native, kind, ...(hook.match ? { match: hook.match } : {}) });
  }

  if (bridge.length > 0) {
    await copyOne(opts.runnerAbsPath, join(out, "hooks", opts.runnerRelPath));
    track(join(out, "hooks", opts.runnerRelPath));
    for (const hook of plugin.hooks) {
      await copyOne(join(opts.pluginRoot, hook.handler), join(out, "hooks", "handlers", `${hook.id}.mjs`));
      track(join(out, "hooks", "handlers", `${hook.id}.mjs`));
    }
    // Runtime policy (timeout + failure policy) for the dependency-free runner.
    await writeIfChanged(join(out, "hooks", HOOK_POLICIES_FILENAME), renderHookPolicies(plugin.hooks));
    track(join(out, "hooks", HOOK_POLICIES_FILENAME));
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
  /** Tool-name matcher (regex or plain name); undefined = all tools. */
  match?: string;
}

function renderShim(name: string, bridge: Bridge[]): string {
  // Finding H: a native event can be claimed by SEVERAL hooks. The old shim
  // built `Object.fromEntries(...)`, so every hook but the last was silently
  // dropped — the plugin's guards simply never ran. The map is now
  // event → ORDERED LIST of hooks, and the shim dispatches all of them.
  const byEvent = new Map<string, Bridge[]>();
  for (const b of bridge) {
    const list = byEvent.get(b.opencode) ?? [];
    list.push(b);
    byEvent.set(b.opencode, list);
  }
  const map = JSON.stringify(
    Object.fromEntries([...byEvent.entries()].map(([event, list]) => [event, list.map((b) => ({ id: b.id, ...(b.match ? { match: b.match } : {}) }))])),
    null,
    2,
  );
  return `/**
 * ${name} — generated by AnyPlugin (OpenCode v1 shim).
 * Bridges OpenCode in-process hooks to the canonical stdio hook runner
 * (hooks/runner.js) so every platform executes identical handler code.
 * On v2 dev cores (which only load {id, setup} modules) this file is
 * silently ignored — skills/commands/agents artifacts carry the load there.
 *
 * Several hooks may share one native event; they are dispatched IN ORDER and
 * their results merged (context is concatenated, the most restrictive
 * permission decision wins, any block wins).
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(ROOT, "hooks", "runner.js");

interface HookEntry { id: string; match?: string }
const HOOKS: Record<string, HookEntry[]> = ${map};

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

/** Does this hook's matcher accept the tool about to run? */
function matches(entry: HookEntry, toolName: string | undefined): boolean {
  if (!entry.match) return true;
  if (!toolName) return true;
  try {
    return new RegExp(entry.match).test(toolName);
  } catch {
    // An invalid matcher must not silently disable the hook. A matcher that
    // is not a valid regex is treated as a plain tool name.
    return entry.match === toolName;
  }
}

/** Pull the permission decision out of the runner's output, wherever it sits. */
function decisionOf(out: Record<string, unknown>): string | undefined {
  const direct = out["permissionDecision"];
  if (typeof direct === "string") return direct;
  const specific = out["hookSpecificOutput"];
  if (specific && typeof specific === "object") {
    const nested = (specific as Record<string, unknown>)["permissionDecision"];
    if (typeof nested === "string") return nested;
  }
  const decision = out["decision"];
  if (typeof decision === "string") return decision;
  return undefined;
}

/** Pull the additional context out of the runner's output, wherever it sits. */
function contextOf(out: Record<string, unknown>): string | undefined {
  const direct = out["additionalContext"];
  if (typeof direct === "string") return direct;
  const specific = out["hookSpecificOutput"];
  if (specific && typeof specific === "object") {
    const nested = (specific as Record<string, unknown>)["additionalContext"];
    if (typeof nested === "string") return nested;
  }
  const steps = out["injectSteps"];
  if (Array.isArray(steps)) {
    const parts = steps
      .map((s) => (s && typeof s === "object" ? (s as Record<string, unknown>)["content"] : undefined))
      .filter((c): c is string => typeof c === "string");
    if (parts.length) return parts.join("\\n");
  }
  return undefined;
}

interface Merged {
  output: Record<string, unknown>;
  context: string[];
  decision?: string;
  blocked: boolean;
  reason?: string;
}

async function runAll(hookName: string, payload: unknown, toolName?: string): Promise<Merged> {
  const entries = HOOKS[hookName] ?? [];
  const merged: Merged = { output: {}, context: [] };
  for (const entry of entries) {
    if (!matches(entry, toolName)) continue;
    const result = await run(entry.id, payload);
    // The runner writes its payload to stdout BEFORE exiting, and a BLOCKING
    // hook exits 2 (Antigravity: "deny", exit 0). So a non-zero exit does
    // NOT mean "there is no output" — it very often means "the output is a
    // denial". Skipping a non-zero result would silently ignore a guard
    // plugin's refusal, which is the one thing a guard exists to do.
    if (!result.stdout.trim()) {
      // No payload at all. The exit code is then the only signal left, and a
      // blocking exit is still a denial.
      if (result.code === 2) {
        merged.blocked = true;
        merged.reason = merged.reason ?? ("hook " + entry.id + " blocked the tool");
      }
      continue;
    }
    let out: Record<string, unknown>;
    try {
      out = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      // Unparseable output: the runner's exit code is the only signal left.
      // A blocking exit (2) with no parseable payload is still a denial.
      if (result.code === 2) {
        merged.blocked = true;
        merged.reason = merged.reason ?? ("hook " + entry.id + " blocked the tool");
      }
      continue;
    }
    const ctx = contextOf(out);
    if (ctx) merged.context.push(ctx);
    const decision = decisionOf(out);
    if (decision) {
      // The most restrictive decision wins: deny > ask > allow.
      const rank = (d: string) => (d === "deny" ? 3 : d === "ask" ? 2 : d === "allow" ? 1 : 0);
      if (!merged.decision || rank(decision) > rank(merged.decision)) merged.decision = decision;
    }
    if (out["block"] === true || out["decision"] === "block" || out["decision"] === "deny" || result.code === 2) {
      merged.blocked = true;
      if (!merged.reason && typeof out["reason"] === "string") merged.reason = out["reason"];
    }
    for (const [key, value] of Object.entries(out)) {
      if (key === "hookSpecificOutput" || key === "injectSteps") continue;
      merged.output[key] = value;
    }
  }
  if (merged.context.length) merged.output["additionalContext"] = merged.context.join("\\n");
  if (merged.decision) merged.output["permissionDecision"] = merged.decision;
  if (merged.blocked) {
    merged.output["block"] = true;
    if (merged.reason) merged.output["reason"] = merged.reason;
  }
  return merged;
}

export const ${shimConstName(name)}Plugin = async () => ({
  "shell.env": async (_input: unknown, output: { env: Record<string, string> }) => {
    output.env["ANYPLUGIN_HOST"] = "opencode";
  },
  "tool.execute.before": async (input: Record<string, unknown>, output: { args: unknown }) => {
    const toolName = typeof input["tool"] === "string" ? input["tool"] : undefined;
    const merged = await runAll("tool.execute.before", { ...input, hook_event_name: "tool.execute.before" }, toolName);
    // The MERGED result is what the host must see. Copying only the context
    // would silently discard a denial: the merge computes "block" and the
    // reason, and then throws them away. A guard plugin that refuses a tool
    // would appear to succeed.
    const target = output as Record<string, unknown>;
    for (const [key, value] of Object.entries(merged.output)) {
      if (key === "updatedInput") continue;
      target[key] = value;
    }
    const updated = merged.output["updatedInput"];
    if (updated && typeof updated === "object") {
      const args = (updated as Record<string, unknown>)["args"];
      if (args !== undefined) target["args"] = args;
    }
  },
  "tool.execute.after": async (input: Record<string, unknown>, output: Record<string, unknown>) => {
    const toolName = typeof input["tool"] === "string" ? input["tool"] : undefined;
    const merged = await runAll("tool.execute.after", { ...input, hook_event_name: "tool.execute.after" }, toolName);
    if (Object.keys(merged.output).length) Object.assign(output, merged.output);
  },
  "permission.asked": async (input: Record<string, unknown>, output: { status: string }) => {
    const toolName = typeof input["tool"] === "string" ? input["tool"] : undefined;
    const merged = await runAll("permission.asked", { ...input, hook_event_name: "permission.asked" }, toolName);
    if (merged.decision) output.status = merged.decision;
  },
  "event": async ({ event }: { event: { name?: string; properties?: Record<string, unknown> } }) => {
    const name = event?.name ?? "";
    if (name === "session.created" || name === "session.idle") {
      await runAll(name, { ...(event.properties ?? {}), hook_event_name: name });
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
