/**
 * okf-turn-stop — records that a session turn touched the project by appending a
 * newest-first line to the bundle's log.md. Kept intentionally cheap: no LLM, no
 * transcript parsing; the agent (via the okf-reader skill or curator) writes
 * rich concepts — this hook only maintains the heartbeat so staleness is visible.
 * Untrusted input (payload.cwd) is validated through resolveAuthorizedPath
 * (spec §1.1) before any filesystem operation.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAuthorizedPath } from "@lablaunchpad/core";

export async function run(payload) {
  // Validate cwd through SafePath before joining it into a filesystem path.
  // This is the ONE way untrusted input becomes a path (CORE-INVARIANTS-V2 §1.1).
  const safeCwd = payload.cwd
    ? await resolveAuthorizedPath(process.cwd(), payload.cwd).catch(() => process.cwd())
    : process.cwd();

  const candidates = [
    process.env["ANYPLUGIN_OKF_BUNDLE"],
    join(safeCwd, "knowledge"),
  ].filter(Boolean);
  const dir = candidates.find((d) => existsSync(join(d, "log.md")));
  if (!dir) return {};

  const logPath = join(dir, "log.md");
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## ${date}`;
  let text = readFileSync(logPath, "utf8");
  const marker = `- session on ${payload.platform} (${date}); see transcript for details`;

  const idx = text.indexOf(heading);
  if (idx >= 0) {
    const insertAt = idx + heading.length;
    text = text.slice(0, insertAt) + `\n${marker}` + text.slice(insertAt);
  } else {
    const firstH2 = text.indexOf("\n## ");
    const block = `\n${heading}\n\n${marker}\n`;
    text =
      firstH2 >= 0
        ? text.slice(0, firstH2 + 1) + block.trimEnd() + "\n" + text.slice(firstH2 + 1)
        : text.trimEnd() + "\n" + block;
  }
  writeFileSync(logPath, text, "utf8");
  return {};
}
