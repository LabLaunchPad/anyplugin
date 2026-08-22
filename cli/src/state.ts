import { join } from "node:path";
import { readText, writeText, pathExists, removeTree } from "@lablaunchpad/core";

/**
 * Runtime mode state (ponytail's `.ponytail-active` pattern, adapted): a tiny
 * flag file INSIDE the plugin root recording which intensity mode is active.
 * The flag travels with the plugin (bundles copy the root; uninstall removes
 * it with the root). This is RUNTIME state only — install/uninstall
 * reversibility is owned by the transactional journal (journal.ts), which
 * this file deliberately does not touch.
 */
export const STATE_BASENAME = ".anyplugin-mode";

export type IntensityMode = "conservative" | "balanced" | "aggressive";

export interface PluginRuntimeState {
  pluginId: string;
  version: string;
  mode: IntensityMode;
  timestamp: number;
}

function statePath(pluginRoot: string): string {
  return join(pluginRoot, STATE_BASENAME);
}

export async function setActivePlugin(pluginRoot: string, state: PluginRuntimeState): Promise<string> {
  const file = statePath(pluginRoot);
  await writeText(file, JSON.stringify(state, null, 2) + "\n");
  return file;
}

export async function getActivePlugin(pluginRoot: string): Promise<PluginRuntimeState | null> {
  try {
    return JSON.parse(await readText(statePath(pluginRoot))) as PluginRuntimeState;
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
