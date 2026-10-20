/**
 * The symlink-containment test for `copyDir` (P1-9).
 *
 * ── Why this file exists ───────────────────────────────────────────────────
 *
 * The symlink-containment rejection — F-02 — is a **security** property with
 * **no test at all**. `core/src/emit/` contained only `index.ts`. A
 * containment check nobody exercises is a containment check that will be
 * broken by a well-meaning refactor and nothing will say so.
 *
 * ── The property ───────────────────────────────────────────────────────────
 *
 * A symlink inside the source tree may only be copied if its **resolved
 * target** is inside the source tree. A symlink whose target escapes would
 * let content from outside the plugin root into the emitted bundle — which is
 * exactly what the check exists to prevent.
 *
 * The check is on the **resolved** target, not the link's own path: a link
 * that points at `../../etc/passwd` has a perfectly innocent-looking path
 * and a target outside the root.
 *
 * ── ARMED, not PASSED ──────────────────────────────────────────────────────
 *
 * Creating a symlink needs a privilege that Windows does not grant by
 * default. When the platform refuses, the tests are **ARMED** — skipped, and
 * said so loudly — because a guard whose target is absent has not been
 * exercised, and calling that "passed" would manufacture confidence.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDir } from "./index.js";

let root: string;
/** Whether this platform lets us create a symlink at all. */
let canSymlink = false;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "copydir-containment-"));
  const probe = join(root, "probe-target");
  const link = join(root, "probe-link");
  await writeFile(probe, "x", "utf8");
  try {
    await symlink(probe, link, "file");
    canSymlink = true;
  } catch {
    canSymlink = false;
    console.info(
      "\nsymlink containment: ARMED — this platform refused to create a symlink, so the guard was not exercised.\n",
    );
  }
});

afterAll(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

/** Build a source tree and return the destination. */
async function tree(): Promise<{ src: string; dest: string }> {
  const dir = join(root, `case-${Math.random().toString(36).slice(2)}`);
  const src = join(dir, "src");
  const dest = join(dir, "dest");
  await mkdir(join(src, "nested"), { recursive: true });
  await writeFile(join(src, "plugin.json"), "{}", "utf8");
  await writeFile(join(src, "nested", "inner.md"), "inner", "utf8");
  return { src, dest };
}

describe("copyDir's symlink containment", () => {
  it.skipIf(!canSymlink)("SKIPS a symlink whose target escapes the source root", async () => {
    // The decisive case. The link's own path is innocent; its TARGET is
    // outside the root.
    const { src, dest } = await tree();
    const outside = join(root, "outside-secret.txt");
    await writeFile(outside, "SECRET", "utf8");
    await symlink(outside, join(src, "escape.txt"), "file");

    const written = await copyDir(src, dest);

    expect(written.map((w) => w.split(/[\\/]/).pop())).not.toContain("escape.txt");
    expect(existsSync(join(dest, "escape.txt")), "the escaping link must not be copied").toBe(false);
  });

  it.skipIf(!canSymlink)("SKIPS a symlink that points OUTSIDE through a subdirectory", async () => {
    // The escape does not have to be a sibling of the link: a link in a
    // nested directory reaching out with `..` is the same escape.
    const { src, dest } = await tree();
    const outside = join(root, "outside-nested.txt");
    await writeFile(outside, "SECRET", "utf8");
    await symlink(outside, join(src, "nested", "escape.txt"), "file");

    await copyDir(src, dest);

    expect(existsSync(join(dest, "nested", "escape.txt"))).toBe(false);
  });

  it.skipIf(!canSymlink)("SKIPS a dangling symlink", async () => {
    // An unresolvable link cannot be shown to be contained, so it is
    // skipped. "Probably fine" is not "fine".
    const { src, dest } = await tree();
    await symlink(join(src, "does-not-exist.txt"), join(src, "dangling.txt"), "file");

    const written = await copyDir(src, dest);

    expect(written.map((w) => w.split(/[\\/]/).pop())).not.toContain("dangling.txt");
  });

  it.skipIf(!canSymlink)("COPIES a symlink whose target is inside the source root", async () => {
    // The other half: a containment check that rejects everything is not a
    // containment check, it is a broken copy.
    const { src, dest } = await tree();
    await symlink(join(src, "plugin.json"), join(src, "alias.json"), "file");

    const written = await copyDir(src, dest);

    expect(written.map((w) => w.split(/[\\/]/).pop())).toContain("alias.json");
    expect(await readFile(join(dest, "alias.json"), "utf8")).toBe("{}");
  });

  it("copies ordinary files and directories", async () => {
    // The positive case, which needs no symlink and so is never ARMED.
    const { src, dest } = await tree();
    const written = await copyDir(src, dest);

    expect(written.length).toBe(2);
    expect(existsSync(join(dest, "plugin.json"))).toBe(true);
    expect(existsSync(join(dest, "nested", "inner.md"))).toBe(true);
    expect(await readFile(join(dest, "nested", "inner.md"), "utf8")).toBe("inner");
  });
});
