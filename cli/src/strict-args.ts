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
  "okf-reindex": z.object({ plugin: dir.optional(), json: flag.optional(), "include-root": flag.optional() }).strict(),
  doctor: z
    .object({
      home: dir.optional(),
      project: dir.optional(),
      json: flag.optional(),
      fix: flag.optional(),
    })
    .strict(),
  backends: z
    .object({
      registry: dir.optional(),
      json: flag.optional(),
    })
    .strict(),
  delegate: z
    .object({
      registry: dir.optional(),
      backend: z.string().optional(),
      capability: z.string().optional(),
      domain: z.string().optional(),
      timeout: z.string().optional(),
      budget: z.string().optional(),
      "re-runnable": flag.optional(),
      json: flag.optional(),
    })
    .strict(),
  run: z
    .object({
      // The hook id is a POSITIONAL — `anyplugin run <hook-id>` — and it may
      // also be given as a flag. Node's parseArgs puts a bare word in
      // `positionals` and NEVER in `values`, so a required string option
      // could never be satisfied by the documented form: `run` always failed
      // with "run requires hook-id argument". The value is filled in from
      // the positional below, and the requirement is re-checked there.
      hookId: z.string().optional(),
      plugin: dir.optional(),
      event: z.string().optional(),
      payload: z.string().optional(),
    })
    .strict(),
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
  "fix",
  "registry",
  "backend",
  "capability",
  "domain",
  "timeout",
  "budget",
  "include-root",
  "re-runnable",
  "hookId",
  "event",
  "payload",
] as const;

/** The options that take no value. Everything else takes a string. */
const BOOLEAN_OPTIONS = new Set<string>(["dry-run", "json", "fix", "include-root", "re-runnable"]);

export interface ParsedCommand<T extends CommandName> {
  command: T;
  values: z.infer<(typeof CommandArgs)[T]>;
  positionals: string[];
}

/**
 * How many positionals each command accepts.
 *
 * Positionals are part of the contract: silently ignoring them (e.g.
 * `build my-plugin` instead of `build --plugin my-plugin`) is a silent
 * no-op, and accepting more than a command understands is a silent no-op in
 * the other direction. Each command declares its own policy here.
 *
 * - `none`         the command takes no positional arguments
 * - `at-most-one`  one optional positional (a bundle directory, a subcommand)
 * - `any`          the positionals ARE the payload (the backend's own argv)
 */
type PositionalPolicy = "none" | "at-most-one" | "any";

const POSITIONAL_POLICY: Record<string, PositionalPolicy> = {
  "okf-validate": "at-most-one",
  "okf-reindex": "at-most-one",
  // `backends list` / `backends probe` — the subcommand is the positional.
  backends: "at-most-one",
  // `run <hook-id>` — the hook id is the positional, exactly as it is for
  // `node runner.js <hook-id>`.
  run: "at-most-one",
  // `delegate -- <args>` — everything after `--` is the BACKEND's argv, and
  // it is the payload rather than a silent no-op.
  delegate: "any",
};

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
      options: Object.fromEntries(ALL_OPTIONS.map((o) => [o, { type: BOOLEAN_OPTIONS.has(o) ? "boolean" : "string" }])),
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    throw new Error(`invalid arguments for ${String(command)}: ${(err as Error).message}`);
  }
  // Positionals are part of the contract too: silently ignoring them (e.g.
  // `build my-plugin` instead of `build --plugin my-plugin`) is a silent no-op.
  const policy = POSITIONAL_POLICY[command] ?? "none";
  if (policy === "at-most-one" && parsed.positionals.length > 1) {
    throw new Error(`invalid arguments for ${String(command)}: expected at most one positional argument, got ${parsed.positionals.length} (${parsed.positionals.join(" ")})`);
  }
  if (policy === "none" && parsed.positionals.length > 0) {
    throw new Error(`invalid arguments for ${String(command)}: this command takes no positional arguments (got: ${parsed.positionals.join(" ")}) — use flags, see anyplugin help`);
  }

  // `run <hook-id>` — the hook id is the POSITIONAL, and it is filled in
  // BEFORE the schema is checked, because a schema cannot require a value
  // that arrives as a positional.
  const values: Record<string, unknown> = { ...(parsed.values as Record<string, unknown>) };
  if (command === "run") {
    if (parsed.positionals.length > 0) values["hookId"] = parsed.positionals[0];
    if (typeof values["hookId"] !== "string" || values["hookId"] === "") {
      throw new Error("invalid arguments for run: run requires hook-id argument");
    }
  }

  const checked = schema.safeParse(values);
  if (!checked.success) {
    const issues = checked.error.issues.map((i: z.ZodIssue) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`invalid arguments for ${String(command)}: ${issues}`);
  }

  return { command, values: checked.data as z.infer<(typeof CommandArgs)[T]>, positionals: parsed.positionals };
}
