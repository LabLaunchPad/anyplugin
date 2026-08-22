/**
 * okf-session-start — injects a pointer to the OKF knowledge bundle into the session
 * so the agent knows prior knowledge exists before answering.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export async function run(payload) {
  const candidates = [
    process.env["ANYPLUGIN_OKF_BUNDLE"],
    join(payload.pluginRoot ?? ".", "knowledge"),
    join(payload.cwd ?? process.cwd(), "knowledge"),
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
