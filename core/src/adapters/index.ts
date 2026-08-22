import type { ParsedPlugin } from "../schema/index.js";
import type { AgentId } from "../detect/index.js";

/**
 * Adapter contract: adapters are PURE — emit() renders a native bundle into outDir and
 * returns an install plan; the CLI executes plans. This keeps adapters testable and
 * side-effect free.
 */

export interface EmitOptions {
  /** Canonical plugin source root (contains prism.plugin.yaml). */
  pluginRoot: string;
  /** Directory to render the native bundle into. */
  outDir: string;
  /** Path (as resolved inside the emitted bundle) to the hooks runner entry, e.g. "hooks/runner.js". */
  runnerRelPath: string;
  /** Absolute path to a compiled runner script copied into every emitted bundle. */
  runnerAbsPath: string;
  /** Absolute dir of compiled MCP server runtime (containing server.js + deps), copied to <bundle>/mcp when the plugin declares servers. */
  mcpRuntimeAbsDir?: string;
}

export interface EmittedBundle {
  agent: AgentId;
  /** Root of the emitted native bundle (== opts.outDir). */
  dir: string;
  /** Every file written, posix paths relative to outDir. */
  files: string[];
  warnings: string[];
  /** How the bundle becomes active on a machine. */
  install: InstallPlan;
}

export interface CopyAction {
  kind: "copy";
  /** Relative to emitted bundle dir. */
  srcRel: string;
  /** Absolute destination on the target machine. */
  destAbs: string;
  /** "root" marks the action that installs the plugin's main directory (uninstall removes it). */
  role?: "root";
  /** For non-root actions: the single path segment appended to the whitelisted destination dir. */
  destFile?: string;
}

export interface JsonMergeAction {
  kind: "json-merge";
  /** Absolute destination config file. */
  file: string;
  /** Deep-merged JSON value. */
  patch: Record<string, unknown>;
}

export interface TomlMergeAction {
  kind: "toml-merge";
  file: string;
  /** TOML text appended inside the right tables; must be pre-rendered. */
  append: string;
}

export interface MdAppendAction {
  kind: "md-append";
  file: string;
  /** Appended once; removal tracked by begin/end markers. */
  content: string;
  marker: string;
}

export type InstallAction = CopyAction | JsonMergeAction | TomlMergeAction | MdAppendAction;

export interface InstallPlan {
  actions: InstallAction[];
  /** Human summary of what install does. */
  summary: string;
}

export interface Adapter {
  agent: AgentId;
  emit(plugin: ParsedPlugin, opts: EmitOptions): Promise<EmittedBundle>;
  /** Absolute destinations on this machine for install planning (given user home). */
  targets(opts: { home: string; projectDir: string }): Record<string, string>;
}
