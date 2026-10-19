import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { assertSafeRelative, resolveAuthorizedPath, SecurityError, isContained } from "./safe-path.js";

describe("assertSafeRelative (lexical boundary)", () => {
  it("rejects traversal, absolute, UNC, drive-letter, NUL, and oversized inputs", () => {
    const bad = [
      "", "..", "../", "a/../..", "a/b/../../../c", "..\\evil", "a\\..\\..\\b", "./../x",
      "/etc/passwd", "\\windows", "\\\\srv\\share", "//x/y", "C:\\x", "c:/x", "Z:\\..\\..",
      "a/C:x", "folder/C:", `a${"\0"}b`, "a".repeat(4097), `${"x".repeat(256)}/ok`,
    ];
    for (const input of bad) {
      expect(() => assertSafeRelative(input), JSON.stringify(input)).toThrow(SecurityError);
    }
  });

  it("accepts and normalizes plain relative paths", () => {
    expect(assertSafeRelative("skills/demo")).toBe("skills/demo");
    expect(assertSafeRelative("./a//b/./c")).toBe("a/b/c");
    if (sep === "\\") expect(assertSafeRelative("a\\b")).toBe("a/b"); // windows separator normalized
  });

  it("rejects backslash separators on posix", () => {
    if (sep === "/") expect(() => assertSafeRelative("a\\b")).toThrow(SecurityError);
  });
});

describe("resolveAuthorizedPath (filesystem boundary)", () => {
  it("resolves a safe relative path inside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "safepath-"));
    const p = await resolveAuthorizedPath(root, "knowledge/index.md");
    expect(isContained(p, realpathSync(root))).toBe(true);
  });

  it("resolves a not-yet-existing path inside an existing ancestor", async () => {
    const root = await mkdtemp(join(tmpdir(), "safepath-"));
    const p = await resolveAuthorizedPath(root, "new/deep/file.json");
    expect(isContained(p, realpathSync(root))).toBe(true);
    expect(p.endsWith(join("new", "deep", "file.json"))).toBe(true);
  });

  it("throws SecurityError on symlink escape", async () => {
    const root = await mkdtemp(join(tmpdir(), "safepath-"));
    const outside = await mkdtemp(join(tmpdir(), "safepath-out-"));
    await writeFile(join(outside, "secret.txt"), "x");
    const link = join(root, "link-out");
    try {
      await symlink(outside, link, "junction");
    } catch {
      try {
        await symlink(outside, link, "dir");
      } catch {
        console.warn("no symlink permission on this platform — symlink escape test skipped");
        return;
      }
    }
    await expect(resolveAuthorizedPath(root, "link-out/secret.txt")).rejects.toThrow(SecurityError);
    await expect(resolveAuthorizedPath(root, "link-out")).rejects.toThrow(SecurityError);
  });

  it("throws SecurityError on a DANGLING symlink whose target is outside the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "safepath-dangling-"));
    const link = join(root, "dangling-link");
    try {
      await symlink(join(root, "..", "definitely-missing-target-xyz"), link, "file");
    } catch {
      console.warn("no symlink permission on this platform — dangling symlink test skipped");
      return;
    }
    await expect(resolveAuthorizedPath(root, "dangling-link")).rejects.toThrow(SecurityError);
    await expect(resolveAuthorizedPath(root, "dangling-link/deep/file")).rejects.toThrow(SecurityError);
  });

  it("throws when the authorized root does not exist", async () => {
    await expect(resolveAuthorizedPath(join(tmpdir(), "definitely-missing-root-xyz"), "a")).rejects.toThrow(SecurityError);
  });
});

describe("SafePath hostile corpus — zero escapes from 10,000 generated inputs", () => {
  it("every input either throws SecurityError or stays inside the authorized root", async () => {
    const root = await mkdtemp(join(tmpdir(), "safepath-corpus-"));
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "a", "b"), { recursive: true });
    await writeFile(join(root, "a", "b", "c.txt"), "x");
    const rootReal = realpathSync(root);

    const fragments = [
      "..", "...", "....", "../", "..\\", "\\", "/", "//", "\\\\", ".", "./", "a", "b", "c.txt",
      "C:", "c:", "CON", "NUL", "%2e%2e", "‥", "．.", "\u0000", " ", "~", "$HOME", "${x}", "a&b",
    ];
    const inputs: string[] = [];
    // systematic combinatorial generation, deterministic, no RNG
    for (const f1 of fragments) {
      for (const f2 of fragments) {
        for (const sep2 of ["/", "\\", "/\\", "//", ""]) {
          if (inputs.length >= 10000) break;
          inputs.push(`${f1}${sep2}${f2}`);
        }
        if (inputs.length >= 10000) break;
      }
      if (inputs.length >= 10000) break;
    }
    // deep-repeat and mixed-case traversal variants to fill the corpus
    let i = 0;
    while (inputs.length < 10000) {
      const depth = (i % 8) + 2;
      inputs.push(Array.from({ length: depth }, (_, k) => (k % 3 === 0 ? ".." : k % 3 === 1 ? "a" : "..\\")).join(i % 2 ? "/" : "\\"));
      i++;
    }
    expect(inputs.length).toBeGreaterThanOrEqual(10000);

    let resolved = 0;
    for (const input of inputs) {
      let result: string | null = null;
      try {
        result = await resolveAuthorizedPath(root, input);
      } catch (err) {
        expect(err, `input must fail with SecurityError: ${JSON.stringify(input)}`).toBeInstanceOf(SecurityError);
        continue;
      }
      resolved++;
      expect(isContained(result, rootReal), `ESCAPE via ${JSON.stringify(input)} → ${result}`).toBe(true);
    }
    expect(resolved).toBeGreaterThan(0); // corpus isn't all-reject
    await rm(root, { recursive: true, force: true });
    // The bound is a LIVELINESS limit, not a correctness claim: this loop
    // performs 10 000 real filesystem resolutions, and vitest runs test FILES
    // concurrently, so the wall time is a property of the runner's load
    // rather than of the code. It passes in ~19s on a quiet Windows machine
    // and exceeded the old 60s bound when the whole workspace ran at once.
    // Nothing about the assertion changed: still 10 000 inputs, still zero
    // escapes, and a genuine escape still fails the test.
  }, 240_000);
});

describe("isContained", () => {
  it("prefix-matches with separator discipline and platform casing", () => {
    const root = resolve("/r");
    expect(isContained(join(root, "x"), root)).toBe(true);
    expect(isContained(root, root)).toBe(true);
    expect(isContained(resolve("/rootkit"), root)).toBe(false);
  });
});
