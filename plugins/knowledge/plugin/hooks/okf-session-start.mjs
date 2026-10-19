/**
 * okf-session-start — injects a pointer to the OKF knowledge bundle into the session
 * so the agent knows prior knowledge exists before answering.
 * Untrusted input (payload.cwd, payload.pluginRoot) is validated through
 * resolveAuthorizedPath (spec §1.1) before any filesystem operation.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAuthorizedPath } from "@lablaunchpad/core";

export async function run(payload) {
  // Validate cwd through SafePath before using it in a filesystem path
  const safeCwd = payload.cwd
    ? await resolveAuthorizedPath(process.cwd(), payload.cwd).catch(() => process.cwd())
    : process.cwd();
  // Validate pluginRoot through SafePath before using it in a filesystem path
  const safePluginRoot = payload.pluginRoot
    ? await resolveAuthorizedPath(process.cwd(), payload.pluginRoot).catch(() => process.cwd())
    : process.cwd();

  const candidates = [
    process.env["ANYPLUGIN_OKF_BUNDLE"],
    join(safePluginRoot, "knowledge"),
    join(safeCwd, "knowledge"),
  ].filter(Boolean);

  for (const dir of candidates) {
    const index = join(dir, "index.md");
    if (existsSync(index)) {
      let concepts = 0;
      try {
        // cheap count: non-reserved .md mentions in the index
        const text = readFileSync(index, "utf8");
        concepts = (text.match(/\]\([^)]+\.md\)/g) ?? []).length;
      } catch {
        /* index unreadable — still point at the dir */
      }
      return {
        additionalContext:
          `An OKF v0.2 knowledge bundle exists at ${dir} (${concepts}+ indexed concepts). ` +
          `Before answering project questions, consult it via the okf-reader skill or okf_* MCP tools ` +
          `(read index.md first, then only relevant concept files).`,
      };
    }
  }
  return {};
}
