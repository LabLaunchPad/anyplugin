import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Canonical hook events — the platform-neutral names every adapter maps FROM. */
export const CanonicalEvent = z.enum([
  "session-start",
  "before-tool-use",
  "after-tool-use",
  "prompt-submit",
  "turn-stop",
  "session-end",
  "permission-request",
]);
export type CanonicalEvent = z.infer<typeof CanonicalEvent>;

/**
 * A hook handler is ALWAYS executed as `node <runtime> <handler> <payload-json-on-stdin>`.
 * `handler` is a path (relative to plugin root) to a JS/MJS module exporting
 * `async function run(payload: HookPayload): Promise<HookResult>`.
 */
export const HookSchema = z.object({
  id: z.string().min(1),
  event: CanonicalEvent,
  handler: z.string().min(1),
  /** Tool-name matcher (regex or plain name); omitted = all tools. */
  match: z.string().optional(),
  timeoutSec: z.number().int().positive().max(600).optional(),
});
export type Hook = z.infer<typeof HookSchema>;

export const McpServerSchema = z.object({
  transport: z.enum(["stdio", "http"]).default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string()).default({}),
  timeoutMs: z.number().int().positive().optional(),
});
export type McpServer = z.infer<typeof McpServerSchema>;

/**
 * The universal plugin manifest (prism.plugin.yaml). One source of truth compiled
 * by adapters into each agent's native artifacts. See knowledge/ for per-agent targets.
 */
export const PrismPluginSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "kebab-case, starts with a letter"),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  description: z.string().min(1),
  displayName: z.string().optional(),
  author: z.object({ name: z.string(), email: z.string().optional(), url: z.string().optional() }).optional(),
  homepage: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  /** Skill directories (each containing SKILL.md), relative to plugin root. */
  skills: z.array(z.string()).default([]),
  /** Command markdown files, relative to plugin root (frontmatter: description, argument-hint, allowed-tools). */
  commands: z.array(z.string()).default([]),
  /** Subagent markdown files (frontmatter: name, description, model?, tools?, prompt in body). */
  agents: z.array(z.string()).default([]),
  hooks: z.array(HookSchema).default([]),
  mcp: z.object({ servers: z.record(McpServerSchema) }).default({ servers: {} }),
  /** OKF v0.2 knowledge bundle directory shipped inside the plugin. */
  knowledge: z.string().optional(),
  /** Free-form capability gates evaluated against detectEnvironment() by adapters. */
  capabilities: z.record(z.unknown()).optional(),
  /** Extra keys are preserved verbatim for adapter-specific needs (like OKF unknown-key preservation). */
});
export type PrismPlugin = z.infer<typeof PrismPluginSchema>;
export type PrismPluginInput = z.input<typeof PrismPluginSchema>;

export const MANIFEST_BASENAMES = [
  "anyplugin.plugin.yaml",
  "anyplugin.plugin.yml",
  "anyplugin.plugin.json",
] as const;

export async function loadPluginManifest(pluginRoot: string): Promise<ParsedPlugin> {
  let text: string | undefined;
  let used = "";
  for (const base of MANIFEST_BASENAMES) {
    try {
      text = await readFile(join(pluginRoot, base), "utf8");
      used = base;
      break;
    } catch {
      // try next
    }
  }
  if (text === undefined) {
    throw new Error(`no prism.plugin.{yaml,yml,json} found in ${pluginRoot}`);
  }
  const raw = used.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return parsePluginManifest(raw);
}

/** Parsed manifest: validated fields + unknown top-level keys preserved verbatim. */
export type ParsedPlugin = PrismPlugin & { extra: Record<string, unknown> };

export function parsePluginManifest(raw: unknown): ParsedPlugin {
  const known = PrismPluginSchema.safeParse(raw);
  if (!known.success) {
    const issues = known.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid prism plugin manifest: ${issues}`);
  }
  const extra: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of Object.keys(known.data)) delete extra[key];
  return { ...known.data, extra };
}
