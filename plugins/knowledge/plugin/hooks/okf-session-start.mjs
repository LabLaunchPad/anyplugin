/**
 * okf-session-start — injects a pointer to the OKF knowledge bundle into the session
 * so the agent knows prior knowledge exists before answering.
 *
 * This handler ships in an EMITTED bundle, which must run with no
 * node_modules at all. So it imports nothing but node builtins: the SafePath
 * validation of the untrusted `cwd` / `pluginRoot` happens in the RUNNER, at
 * the single point where untrusted input enters the runtime, and this handler
 * consumes the already-validated `payload.cwd` and `payload.pluginRoot`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function run(payload) {
  // Already validated by the runner (spec §1.1): an untrusted cwd that
  // escaped would have been refused there, not here.
  const safeCwd = payload.cwd ?? process.cwd();
  const safePluginRoot = payload.pluginRoot ?? process.cwd();

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
