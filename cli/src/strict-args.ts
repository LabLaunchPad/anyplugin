import { parseArgs } from "node:util";
import { z } from "zod";
import { INTENSITY_MODES } from "@lablaunchpad/core";

/**
 * Strict CLI contract (spec CORE-INVARIANTS-V2, Pattern C): every command
 * parses through an explicit Zod schema — flags AND positionals. Unknown
 * flags and flags meaningless for the command are hard errors, never silent
 * no-ops. This module is the ONLY place argv is parsed.
 */

const flag = z.boolean();
const dir = z.string();

export const CommandArgs = {
  init: z
    .object({
      name: z.string({ error: "init requires --name (kebab-case plugin name)" }),
      dir: dir.optional(),
      json: flag.optional(),
    })
    .strict(),
  detect: z.object({ json: flag.optional() }).strict(),
  build: z
    .object({
      plugin: dir.optional(),
      out: dir.optional(),
      agents: z.string().optional(),
      runner: dir.optional(),
      "mcp-runtime": dir.optional(),
      json: flag.optional(),
    })
    .strict(),
  install: z
    .object({
      plugin: dir.optional(),
      out: dir.optional(),
      agents: z.string().optional(),
      home: dir.optional(),
      project: dir.optional(),
      runner: dir.optional(),
      "mcp-runtime": dir.optional(),
      "dry-run": flag.optional(),
      tier: z.enum(["native", "instruction"]).optional(),
      json: flag.optional(),
    })
    .strict(),
  uninstall: z
    .object({
      plugin: dir.optional(),
      out: dir.optional(),
      agents: z.string().optional(),
      home: dir.optional(),
      project: dir.optional(),
      runner: dir.optional(),
      "mcp-runtime": dir.optional(),
      "dry-run": flag.optional(),
      tier: z.enum(["native", "instruction"]).optional(),
      json: flag.optional(),
    })
    .strict(),
  "okf-validate": z.object({ plugin: dir.optional(), json: flag.optional() }).strict(),
  "okf-reindex": z.object({ plugin: dir.optional(), json: flag.optional() }).strict(),
  intensity: z
    .object({
      mode: z.enum(INTENSITY_MODES, {
        error: "intensity requires --mode conservative|balanced|aggressive",
      }),
      plugin: dir.optional(),
      agents: z.string().optional(),
      home: dir.optional(),
      project: dir.optional(),
      json: flag.optional(),
    })
    .strict(),
} as const;

export type CommandName = keyof typeof CommandArgs;

/** The union of every option key any command accepts (for the strict parser). */
const ALL_OPTIONS = [
  "plugin",
  "out",
  "agents",
  "home",
  "project",
  "dry-run",
  "runner",
  "mcp-runtime",
  "name",
  "dir",
  "mode",
  "tier",
  "json",
] as const;

export interface ParsedCommand<T extends CommandName> {
  command: T;
  values: z.infer<(typeof CommandArgs)[T]>;
  positionals: string[];
}

/** Commands that accept exactly one optional positional (the bundle directory). */
const POSITIONAL_COMMANDS = new Set<string>(["okf-validate", "okf-reindex"]);

export function parseCliArgv<T extends CommandName>(argv: string[]): ParsedCommand<T> {
  const [rawCommand, ...rest] = argv;
  const command = rawCommand as T;
  const schema = CommandArgs[command];
  if (!schema) {
    throw new Error(`unknown command: ${String(command)}`);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: rest,
      options: Object.fromEntries(ALL_OPTIONS.map((o) => [o, { type: o === "dry-run" || o === "json" ? "boolean" : "string" }])),
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new Error(`invalid arguments for ${String(command)}: ${(err as Error).message}`);
  }
  const checked = schema.safeParse(parsed.values);
  if (!checked.success) {
    const issues = checked.error.issues.map((i: z.ZodIssue) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid arguments for ${String(command)}: ${issues}`);
  }
  // Positionals are part of the contract too: silently ignoring them (e.g.
  // `build my-plugin` instead of `build --plugin my-plugin`) is a silent no-op.
  if (POSITIONAL_COMMANDS.has(command)) {
    if (parsed.positionals.length > 1) {
      throw new Error(`invalid arguments for ${String(command)}: expected at most one bundle directory, got ${parsed.positionals.length} (${parsed.positionals.join(" ")})`);
    }
  } else if (parsed.positionals.length > 0) {
    throw new Error(`invalid arguments for ${String(command)}: this command takes no positional arguments (got: ${parsed.positionals.join(" ")}) — use flags, see anyplugin help`);
  }
  return { command, values: checked.data as z.infer<(typeof CommandArgs)[T]>, positionals: parsed.positionals };
}
