import { join } from "node:path";
import { z } from "zod";
import { readText, writeText, pathExists, removeTree, IntensityModeSchema, type IntensityMode } from "@lablaunchpad/core";

/**
 * Runtime mode state (ponytail's `.ponytail-active` pattern, adapted): a tiny
 * flag file recording which intensity mode is active, written into the
 * plugin's INSTALLED root for each agent (the same directory runner.js
 * resolves at hook-execution time) — not the developer's source --plugin
 * tree, which the runtime never reads from. This is RUNTIME state only —
 * install/uninstall reversibility is owned by the transactional journal
 * (journal.ts), which this file deliberately does not touch.
 */
export const STATE_BASENAME = ".anyplugin-mode";

export type { IntensityMode };

export interface PluginRuntimeState {
  pluginId: string;
  version: string;
  mode: IntensityMode;
  timestamp: number;
}

const PluginRuntimeStateSchema = z.object({
  pluginId: z.string(),
  version: z.string(),
  mode: IntensityModeSchema,
  timestamp: z.number(),
});

function statePath(pluginRoot: string): string {
  return join(pluginRoot, STATE_BASENAME);
}

export async function setActivePlugin(pluginRoot: string, state: PluginRuntimeState): Promise<string> {
  const file = statePath(pluginRoot);
  await writeText(file, JSON.stringify(state, null, 2) + "\n");
  return file;
}

/**
 * Reads back a previously written state file. Returns null for anything
 * that isn't a well-formed PluginRuntimeState — absent, unreadable, invalid
 * JSON, or (validated via PluginRuntimeStateSchema) a shape/mode that
 * doesn't match, e.g. a hand-edited or forward-incompatible file. This file
 * persists and travels with a plugin, so it's untrusted the same way any
 * other persisted input in this codebase is.
 */
export async function getActivePlugin(pluginRoot: string): Promise<PluginRuntimeState | null> {
  try {
    const parsed: unknown = JSON.parse(await readText(statePath(pluginRoot)));
    const result = PluginRuntimeStateSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export async function setIntensityMode(
  pluginRoot: string,
  mode: IntensityMode,
  base: { pluginId: string; version: string },
): Promise<string> {
  return setActivePlugin(pluginRoot, { ...base, mode, timestamp: Date.now() });
}

export async function clearActivePlugin(pluginRoot: string): Promise<boolean> {
  const file = statePath(pluginRoot);
  if (!(await pathExists(file))) return false;
  await removeTree(file);
  return true;
}
