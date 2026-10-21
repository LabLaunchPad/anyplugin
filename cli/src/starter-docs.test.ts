/**
 * The starter template's documentation must not name a command that does
 * not exist.
 *
 * ── Why this is a guard and not a fix ──────────────────────────────────────
 *
 * The starter template is what every user gets when they scaffold a plugin,
 * and it ships INSIDE every plugin they build. Its readme is not the
 * repository's readme — it is the user's first contact with the tool.
 *
 * So when it told users to run `npx anyplugin okf-validate`, it told them
 * to run a command that does not exist, and every scaffolded plugin
 * inherited the instruction. The names were corrected by hand; nothing
 * stopped them from coming back.
 *
 * This test is the thing that stops them coming back. It reads the
 * template's readme, extracts every command it names, and asks the CLI
 * whether it has one.
 *
 * ── Why it lives in the CLI's package ──────────────────────────────────────
 *
 * Because the CLI is what owns the command list. A guard that kept its own
 * copy of the names would be a second answer to the same question, and
 * would go stale the moment a command was renamed — which is exactly the
 * failure this repository keeps paying for.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandArgs } from "./strict-args.js";

const TEMPLATE_README = join(import.meta.dirname, "..", "..", "templates", "starter", "README.md");

/** The commands the CLI actually has. */
const KNOWN = new Set(Object.keys(CommandArgs));

describe("the starter template's documentation", () => {
  const text = readFileSync(TEMPLATE_README, "utf8");

  it("names only commands that exist", () => {
    // Both ways a user is told to run one: the package form and the
    // installed binary's form.
    const named = new Set<string>();
    for (const match of text.matchAll(/(?:npx\s+@lablaunchpad\/cli|anyplugin)\s+([a-z][a-z-]*)/g)) {
      named.add(match[1]!);
    }

    // The template must actually name some commands, or this test is
    // vacuous — the exact failure this repository keeps guarding against.
    expect(named.size, "the starter template names no commands at all").toBeGreaterThan(0);

    const unknown = [...named].filter((command) => !KNOWN.has(command));
    expect(
      unknown,
      `the starter template names commands the CLI does not have: ${unknown.join(", ")}. ` +
        `Every scaffolded plugin ships this file, so a command that does not exist here is an ` +
        `instruction that fails in the user's project.`,
    ).toEqual([]);
  });

  it("never tells a user to run a command from a repository-relative path", () => {
    // `node ../../../anyplugin build` walks three directories up, which is
    // correct inside this repository and meaningless in a plugin a user
    // copied out of it.
    const relative = text.match(/\.{2,}[\/\\][^\s]*anyplugin/g) ?? [];
    expect(
      relative,
      `the starter template points at a repository-relative path: ${relative.join(", ")}`,
    ).toEqual([]);
  });

  it("never tells a user to run a package name that is not published", () => {
    // `npx anyplugin ...` was the instruction before the release: `anyplugin`
    // is not on the registry, so it is a 404. The published package is
    // `@lablaunchpad/cli`, and the binary it installs is `anyplugin` — so
    // the bare package name in an `npx` line is always wrong.
    const bare = text.match(/npx\s+anyplugin\b/g) ?? [];
    expect(
      bare,
      `the starter template tells a user to run a package that is not on the registry: ${bare.length} occurrence(s). ` +
        `The published package is @lablaunchpad/cli; the binary it installs is anyplugin.`,
    ).toEqual([]);
  });
});
