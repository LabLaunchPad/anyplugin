import type { ParsedPlugin } from "../schema/index.js";

/**
 * Instruction-Tier Fallback (ponytail pattern): for agents with NO plugin API,
 * the plugin's behavioral contract is injected as a marked AGENTS.md section —
 * one markdown surface every coding agent already reads. Pure markdown, no
 * code execution; the install/uninstall marker machinery treats it exactly
 * like any other managed block.
 */
export function generateInstructionTier(plugin: ParsedPlugin): string {
  const lines: string[] = [];
  lines.push(`# ${plugin.displayName ?? plugin.name} (v${plugin.version}) — installed via AnyPlugin`, "");
  lines.push(plugin.description, "");

  lines.push("## What is installed", "");
  const installed: string[] = [];
  if (plugin.skills.length > 0) installed.push(`- Skills: ${plugin.skills.length} (${plugin.skills.join(", ")})`);
  if (plugin.commands.length > 0) installed.push(`- Commands: ${plugin.commands.length} (${plugin.commands.join(", ")})`);
  if (plugin.agents.length > 0) installed.push(`- Subagents: ${plugin.agents.length} (${plugin.agents.join(", ")})`);
  if (plugin.hooks.length > 0) installed.push(`- Hooks: ${plugin.hooks.length} (${[...new Set(plugin.hooks.map((h) => h.event))].join(", ")})`);
  if (Object.keys(plugin.mcp.servers).length > 0) installed.push(`- MCP servers: ${Object.keys(plugin.mcp.servers).join(", ")}`);
  if (plugin.knowledge !== undefined) installed.push(`- OKF knowledge bundle: ${plugin.knowledge}`);
  lines.push(...(installed.length > 0 ? installed : ["- (no runtime payload declared — this plugin is instructions-only)"]), "");

  if (plugin.ladder !== undefined && plugin.ladder.length > 0) {
    lines.push("## Behavioral ladder", "");
    lines.push("Stop at the first rung that holds:", "");
    plugin.ladder.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push("");
  }

  if (plugin.intensity !== undefined) {
    lines.push("## Intensity modes", "");
    for (const [mode, description] of Object.entries(plugin.intensity)) {
      if (description !== undefined) lines.push(`- **${mode}**: ${description}`);
    }
    lines.push("", "Active mode is read from `.anyplugin-mode` in each agent's installed plugin root; switch it with `anyplugin intensity --mode <mode> --plugin <dir>` (writes to every currently-installed root for this plugin).", "");
  }

  if (plugin.extra !== undefined && typeof plugin.extra["instructions"] === "string") {
    lines.push("## Additional instructions", "", plugin.extra["instructions"], "");
  }

  lines.push("---", "Managed by AnyPlugin. Remove this block with `anyplugin uninstall`.", "");
  return lines.join("\n");
}
