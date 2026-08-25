import { join } from "node:path";
import { z } from "zod";
import { readText, writeText, pathExists, removeTree } from "@lablaunchpad/core";

/**
 * Runtime failure-policy state (CORE-INVARIANTS-V2.md §1.3): a tiny flag file
 * written into each agent's INSTALLED root at install time, read by
 * `runner.js` at hook-execution time — the same mechanism `.anyplugin-mode`
 * uses for intensity, kept as a SIBLING file rather than folded into it,
 * because the two have different lifecycles: intensity is a mode the user
 * toggles after install (`anyplugin intensity --mode`), while the runtime
 * policy is fixed by the manifest at install time and does not change until
 * the next install. This is RUNTIME state only, same as `.anyplugin-mode` —
 * install/uninstall reversibility stays owned by the transactional journal,
 * which this file deliberately does not touch.
 */
export const RUNTIME_POLICY_BASENAME = ".anyplugin-runtime.json";

export const RuntimePolicySchema = z.object({
  failurePolicy: z.enum(["non-blocking", "blocking"]).default("non-blocking"),
  hookTimeoutSec: z.number().int().positive().max(600).optional(),
});
export type RuntimePolicy = z.infer<typeof RuntimePolicySchema>;

function statePath(pluginRoot: string): string {
  return join(pluginRoot, RUNTIME_POLICY_BASENAME);
}

/** Written unconditionally at install time — absence of a manifest `runtime` block is the non-blocking default, made explicit here rather than left implicit. */
export async function setRuntimePolicy(pluginRoot: string, runtime: Partial<RuntimePolicy> | undefined): Promise<string> {
  const file = statePath(pluginRoot);
  const policy = RuntimePolicySchema.parse(runtime ?? {});
  await writeText(file, JSON.stringify(policy, null, 2) + "\n");
  return file;
}

/**
 * Best-effort read: absent, unreadable, invalid JSON, or a shape that
 * doesn't match all resolve to the safe non-blocking default — never throws,
 * matching `.anyplugin-mode`'s "missing/corrupt flag never breaks a hook".
 */
export async function getRuntimePolicy(pluginRoot: string): Promise<RuntimePolicy> {
  try {
    const parsed: unknown = JSON.parse(await readText(statePath(pluginRoot)));
    const result = RuntimePolicySchema.safeParse(parsed);
    return result.success ? result.data : RuntimePolicySchema.parse({});
  } catch {
    return RuntimePolicySchema.parse({});
  }
}

export async function clearRuntimePolicy(pluginRoot: string): Promise<boolean> {
  const file = statePath(pluginRoot);
  if (!(await pathExists(file))) return false;
  await removeTree(file);
  return true;
}
