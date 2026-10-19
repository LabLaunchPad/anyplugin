import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, symlink, lstat, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyDir } from "./index.js";

/**
 * `copyDir` symlink containment (audit finding F-02, AGENTS.md "Symlink
 * containment").
 *
 * The rejection had NO test: `core/src/emit/` contained only `index.ts`, so
 * the one place in the codebase that copies a plugin's files onto a user's
 * machine had an unexercised security control. A control that is never run
 * is a comment.
 *
 * Two link kinds matter, and they behave differently per platform:
 *
 *   - a SYMLINK needs a privilege the runner may not have (on Windows it
 *     needs Developer Mode or Administrator). Where it cannot be created, the
 *     POSIX cases are skipped LOUDLY — not silently passed.
 *   - a JUNCTION needs no privilege and works on every Windows machine, and
 *     Node reports it as a symbolic link, so the SAME containment code
 *     handles it. The junction cases therefore run everywhere, and they are
 *     what makes this suite meaningful on the Windows CI leg.
 *
 * The property under test: content OUTSIDE the source root never lands in
 * the destination, and the destination never contains a symlink.
 */

let CAN_SYMLINK = false;
try {
  const probe = await mkdtemp(join(tmpdir(), "symlink-probe-"));
  try {
    await writeFile(join(probe, "a.txt"), "x");
    await symlink(join(probe, "a.txt"), join(probe, "link.txt"), "file");
    CAN_SYMLINK = true;
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
} catch {
  CAN_SYMLINK = false;
}

/** Create a symlink to a FILE. Returns false when the platform forbids it. */
async function tryFileSymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

/** Create a JUNCTION to a DIRECTORY. Needs no privilege on Windows. */
async function tryJunction(target: string, linkPath: string): Promise<boolean> {
  try {
    await symlink(target, linkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

describe("copyDir — symlink containment (F-02)", () => {
  it("does not copy a symlink whose target escapes the source root", async () => {
    const root = await mkdtemp(join(tmpdir(), "copydir-symlink-"));
    try {
      const src = join(root, "src");
      const dest = join(root, "dest");
      const outside = join(root, "outside");
      await mkdir(src, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(src, "safe.txt"), "safe");
      await writeFile(join(outside, "secret.txt"), "SECRET");

      const link = join(src, "escape.txt");
      if (!(await tryFileSymlink(join(outside, "secret.txt"), link))) {
        // No symlink privilege on this platform. The junction cases below
        // cover the same containment logic, and this case runs on POSIX.
        expect(CAN_SYMLINK).toBe(false);
        return;
      }

      await copyDir(src, dest);

      // The ordinary file was copied.
      expect(await readFile(join(dest, "safe.txt"), "utf8")).toBe("safe");
      // The escaping symlink was NOT copied, so the secret did not land here.
      const copied = await readdir(dest);
      expect(copied).not.toContain("escape.txt");
      expect(copied).toContain("safe.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not copy a DANGLING symlink", async () => {
    const root = await mkdtemp(join(tmpdir(), "copydir-dangling-"));
    try {
      const src = join(root, "src");
      const dest = join(root, "dest");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "safe.txt"), "safe");

      const link = join(src, "dangling.txt");
      if (!(await tryFileSymlink(join(root, "does-not-exist.txt"), link))) {
        expect(CAN_SYMLINK).toBe(false);
        return;
      }

      await copyDir(src, dest);
      const copied = await readdir(dest);
      expect(copied).not.toContain("dangling.txt");
      expect(copied).toContain("safe.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies a symlink whose target stays INSIDE the source root", async () => {
    const root = await mkdtemp(join(tmpdir(), "copydir-contained-"));
    try {
      const src = join(root, "src");
      const dest = join(root, "dest");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "real.txt"), "real content");

      const link = join(src, "alias.txt");
      if (!(await tryFileSymlink(join(src, "real.txt"), link))) {
        expect(CAN_SYMLINK).toBe(false);
        return;
      }

      await copyDir(src, dest);
      const copied = await readdir(dest);
      expect(copied).toContain("alias.txt");
      // The contained symlink is copied as its target's content.
      expect(await readFile(join(dest, "alias.txt"), "utf8")).toBe("real content");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("never copies a symlink as a symlink — the destination holds real bytes", async () => {
    const root = await mkdtemp(join(tmpdir(), "copydir-notalink-"));
    try {
      const src = join(root, "src");
      const dest = join(root, "dest");
      await mkdir(src, { recursive: true });
      await writeFile(join(src, "real.txt"), "real content");

      const link = join(src, "alias.txt");
      if (!(await tryFileSymlink(join(src, "real.txt"), link))) {
        expect(CAN_SYMLINK).toBe(false);
        return;
      }

      await copyDir(src, dest);
      const stat = await lstat(join(dest, "alias.txt"));
      // A symlink in the destination would be a link the user did not ask for.
      expect(stat.isSymbolicLink()).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The junction cases run on EVERY platform, including Windows CI.
 *
 * A junction is a directory symlink; Node reports it as a symbolic link, so
 * the same containment branch handles it. This is what makes the security
 * control actually exercised on the Windows leg of the matrix — a symlink
 * there needs a privilege the runner may not have.
 */
describe("copyDir — junction containment (runs everywhere, including Windows)", () => {
  it("does not descend into a junction that escapes the source root", async () => {
    const root = await mkdtemp(join(tmpdir(), "copydir-junction-"));
    try {
      const src = join(root, "src");
      const dest = join(root, "dest");
      const outside = join(root, "outside");
      await mkdir(src, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(src, "safe.txt"), "safe");
      await writeFile(join(outside, "secret.txt"), "SECRET");

      const link = join(src, "escape-dir");
      if (!(await tryJunction(outside, link))) {
        // Junctions are a Windows concept; on POSIX this case is not
        // applicable (the symlink cases above cover it).
        expect(process.platform).not.toBe("win32");
        return;
      }

      await copyDir(src, dest);

      const copied = await readdir(dest);
      expect(copied).toContain("safe.txt");
      // The content behind the escaping junction did not land here.
      expect(copied).not.toContain("escape-dir");
      expect(copied).not.toContain("secret.txt");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not copy a junction pointing outside as a link", async () => {
    const root = await mkdtemp(join(tmpdir(), "copydir-junction2-"));
    try {
      const src = join(root, "src");
      const dest = join(root, "dest");
      const outside = join(root, "outside");
      await mkdir(src, { recursive: true });
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "secret.txt"), "SECRET");

      const link = join(src, "escape-dir");
      if (!(await tryJunction(outside, link))) {
        expect(process.platform).not.toBe("win32");
        return;
      }

      await copyDir(src, dest);
      // Whatever happened, the SECRET must not be in the destination.
      const copied = await readdir(dest);
      expect(copied).not.toContain("secret.txt");
      expect(copied).not.toContain("escape-dir");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
