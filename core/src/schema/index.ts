import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertSafeRelative, resolveAuthorizedPath } from "../fs/safe-path.js";
import { INTENSITY_MODES } from "../tiers/intensity.js";

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
 * A hook `match` pattern must not be able to hang the agent.
 *
 * The pattern is compiled with `new RegExp(...)` and tested against a tool
 * name. A group that can match its own text in MORE THAN ONE WAY, under a
 * quantifier, backtracks exponentially. The tool name is not under the
 * plugin author's control (an MCP server can register any tool name), so a
 * careless pattern plus a hostile tool name freezes the agent's hook
 * process with no error and no timeout.
 *
 * Measured on this repository's own runtime, against a 24-character input:
 * `(a+)+$` and `(a|a)+$` both ran past a 5-second cap.
 *
 * There are two shapes of the same hazard, and the check has to catch BOTH:
 *
 *   - a nested quantifier — `(a+)+` — the body matches "aaa" many ways;
 *   - overlapping alternation — `(a|a)+`, `(a|a?)+`, `(a|ab)+` — the
 *     branches are not mutually exclusive, so the same text splits many ways.
 *
 * A regex cannot tell the second case from the safe one: `^(Read|Write)$`
 * has an alternation too, and it is fine because the group is not
 * QUANTIFIED. So the check walks the pattern and looks at quantified groups
 * only.
 *
 * The check is at MANIFEST PARSE time, not in the adapter, because the
 * pattern reaches the agent's own regex engine in three of the four
 * adapters — refusing it once, here, covers all of them.
 *
 * Deliberately narrow: it refuses the two shapes above and nothing else. It
 * is not a general ReDoS analyser, and it does not try to be one.
 */

/** The bodies of every top-level QUANTIFIED group in the pattern. */
function quantifiedGroupBodies(pattern: string): string[] {
  const bodies: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== "(") continue;
    let depth = 0;
    let inClass = false;
    let close = -1;
    for (let j = i; j < pattern.length; j++) {
      const c = pattern[j];
      if (c === "\\") { j++; continue; }
      if (inClass) { if (c === "]") inClass = false; continue; }
      if (c === "[") { inClass = true; continue; }
      if (c === "(") depth++;
      else if (c === ")") { depth--; if (depth === 0) { close = j; break; } }
    }
    if (close < 0) break;
    const after = pattern[close + 1];
    if (after === "*" || after === "+" || after === "{") bodies.push(pattern.slice(i + 1, close));
    i = close;
  }
  return bodies;
}

/** Split a group body on its top-level "|" only. */
function alternationBranches(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inClass = false;
  let current = "";
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === "\\") { current += c + (body[++i] ?? ""); continue; }
    if (inClass) { current += c; if (c === "]") inClass = false; continue; }
    if (c === "[") { inClass = true; current += c; continue; }
    if (c === "(") depth++;
    if (c === ")") depth--;
    if (c === "|" && depth === 0) { parts.push(current); current = ""; continue; }
    current += c;
  }
  parts.push(current);
  return parts;
}

/**
 * Can these two branch texts match the same string? "a" and "ab" can (on
 * "a"), "a" and "a?" can (on the empty string), "Read" and "Write" cannot.
 */
function branchesOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(b) || b.startsWith(a)) return true;
  const withoutOptional = (s: string) => s.replace(/\?$/, "");
  if (withoutOptional(a) === withoutOptional(b)) return true;
  if (a === "" || b === "") return true;
  return false;
}

/** True iff the pattern contains a quantified group that can match its own text more than one way. */
export function isAmbiguousMatcher(pattern: string): boolean {
  for (const body of quantifiedGroupBodies(pattern)) {
    // A quantifier anywhere in the body — including inside a nested group.
    if (/[+*]|\{\d+/.test(body)) return true;
    // Branches that are not mutually exclusive.
    const branches = alternationBranches(body);
    for (let i = 0; i < branches.length; i++) {
      for (let j = i + 1; j < branches.length; j++) {
        const a = branches[i];
        const b = branches[j];
        if (a !== undefined && b !== undefined && branchesOverlap(a, b)) return true;
      }
    }
  }
  return false;
}

/** True iff the pattern is a plain tool name rather than a regex. */
function looksLikePlainName(pattern: string): boolean {
  return /^[A-Za-z0-9_.:-]+$/.test(pattern);
}

export const HookSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z][a-z0-9-]{0,63}$/, "hook ID must match ^[a-z][a-z0-9-]{0,63}$"),
  event: CanonicalEvent,
  handler: z.string().min(1),
  /** Tool-name matcher (regex or plain name); omitted = all tools. */
  match: z
    .string()
    .max(200, "hook match pattern must be at most 200 characters")
    .refine((p) => looksLikePlainName(p) || !isAmbiguousMatcher(p), {
      message:
        'hook match pattern must not contain an ambiguous quantified group (e.g. "(a+)+" or "(a|a)+"): it can freeze the agent on a long tool name',
    })
    .optional(),
  timeoutSec: z.number().int().positive().max(600).optional(),
  /** Failure policy: "blocking" — handler throws result in exit 2 (host denied);
   * "non-blocking" — handler throws result in exit 0 (host continues). Default: non-blocking. */
  failurePolicy: z.enum(["blocking", "non-blocking"]).default("non-blocking"),
}).strict();
export type Hook = z.infer<typeof HookSchema>;

export const McpServerSchema = z
  .object({
    transport: z.enum(["stdio", "http"]).default("stdio"),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    url: z.string().optional(),
    headers: z.record(z.string(), z.string()).default({}),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((server, ctx) => {
    // The transport decides WHICH fields are meaningful, so a server that
    // does not carry them is not a server — it is a config that would emit a
    // broken native artifact. The adapters branch on `transport` exactly
    // here, so an http server with no url emits a `.mcp.json` that points at
    // nothing.
    if (server.transport === "http") {
      if (!server.url) {
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "an http MCP server must name a url",
        });
      }
      return;
    }
    if (!server.command) {
      ctx.addIssue({
        code: "custom",
        path: ["command"],
        message: "a stdio MCP server must name a command",
      });
    }
  });
export type McpServer = z.infer<typeof McpServerSchema>;

/**
 * The universal plugin manifest (anyplugin.plugin.yaml). One source of truth compiled
 * by adapters into each agent's native artifacts. See knowledge/ for per-agent targets.
 */
export const AnyPluginManifestSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, "kebab-case, starts with a letter"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
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
  mcp: z.object({ servers: z.record(z.string(), McpServerSchema) }).default({ servers: {} }),
  /** OKF v0.2 knowledge bundle directory shipped inside the plugin. */
  knowledge: z.string().optional(),
  /** Behavioral decision ladder injected into instructions ("stop at the first rung that holds"). */
  ladder: z.array(z.string().min(1)).min(1).max(12).optional(),
  /** Named intensity modes the plugin distinguishes at runtime (ponytail pattern). */
  intensity: z
    .object({
      conservative: z.string().optional(),
      balanced: z.string().optional(),
      aggressive: z.string().optional(),
    })
    .refine((v) => INTENSITY_MODES.some((mode) => v[mode] !== undefined), {
      message: "intensity requires at least one mode description (conservative, balanced, or aggressive)",
    })
    .optional(),
  /** Free-form capability gates evaluated against detectEnvironment() by adapters. */
  capabilities: z.record(z.string(), z.unknown()).optional(),
  /** Extra keys are preserved verbatim for adapter-specific needs (like OKF unknown-key preservation). */
});
export type AnyPluginManifest = z.infer<typeof AnyPluginManifestSchema>;
export type AnyPluginManifestInput = z.input<typeof AnyPluginManifestSchema>;

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
    throw new Error(`no anyplugin.plugin.{yaml,yml,json} found in ${pluginRoot}`);
  }
  const raw = used.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  return parsePluginManifest(raw, pluginRoot);
}

/** Parsed manifest: validated fields + unknown top-level keys preserved verbatim. */
export type ParsedPlugin = AnyPluginManifest & { extra: Record<string, unknown> };

export async function parsePluginManifest(raw: unknown, pluginRoot: string): Promise<ParsedPlugin> {
  const known = AnyPluginManifestSchema.safeParse(raw);
  if (!known.success) {
    const issues = known.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid anyplugin manifest: ${issues}`);
  }
  const extra: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
  for (const key of Object.keys(known.data)) delete extra[key];
  const plugin: ParsedPlugin = { ...known.data, extra };
  // SafePath boundary (spec §1.1): every manifest-declared path is lexically
  // validated relative to the plugin root, AND realpath containment is verified.
  for (const s of plugin.skills) {
    assertSafeRelative(s, "manifest skills[] entry");
    await resolveAuthorizedPath(pluginRoot, s);
  }
  for (const c of plugin.commands) {
    assertSafeRelative(c, "manifest commands[] entry");
    await resolveAuthorizedPath(pluginRoot, c);
  }
  for (const a of plugin.agents) {
    assertSafeRelative(a, "manifest agents[] entry");
    await resolveAuthorizedPath(pluginRoot, a);
  }
  if (plugin.knowledge !== undefined) {
    assertSafeRelative(plugin.knowledge, "manifest knowledge path");
    await resolveAuthorizedPath(pluginRoot, plugin.knowledge);
  }
  for (const hook of plugin.hooks) {
    assertSafeRelative(hook.handler, `manifest hooks[${hook.id}].handler`);
    await resolveAuthorizedPath(pluginRoot, hook.handler);
  }
  return plugin;
}
