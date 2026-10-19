/**
 * okf-turn-stop — records that a session turn touched the project by appending a
 * newest-first line to the bundle's log.md. Kept intentionally cheap: no LLM, no
 * transcript parsing; the agent (via the okf-reader skill or curator) writes
 * rich concepts — this hook only maintains the heartbeat so staleness is visible.
 *
 * This handler ships in an EMITTED bundle, which must run with no
 * node_modules at all. So it imports nothing but node builtins: the SafePath
 * validation of the untrusted `cwd` happens in the RUNNER, at the single
 * point where untrusted input enters the runtime, and this handler consumes
 * the already-validated `payload.cwd`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function run(payload) {
  // Already validated by the runner (spec §1.1).
  const safeCwd = payload.cwd ?? process.cwd();

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
