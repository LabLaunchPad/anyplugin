import { mkdir, writeFile, readdir, stat, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

/** Shared filesystem helpers for adapters emitting native artifacts. */

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function writeIfChanged(path: string, content: string): Promise<boolean> {
  await ensureDir(dirname(path));
  try {
    const prev = await stat(path);
    if (prev.isFile()) {
      const { readFile } = await import("node:fs/promises");
      if ((await readFile(path, "utf8")) === content) return false;
    }
  } catch {
    // new file
  }
  await writeFile(path, content, "utf8");
  return true;
}

export async function copyDir(src: string, dest: string): Promise<string[]> {
  const written: string[] = [];
  await ensureDir(dest);
  for (const entry of await readdir(src, { withFileTypes: true })) {
    const s = join(src, entry.name);
    const d = join(dest, entry.name);
    if (entry.isDirectory()) {
      written.push(...(await copyDir(s, d)));
    } else {
      const { copyFile } = await import("node:fs/promises");
      await ensureDir(dirname(d));
      await copyFile(s, d);
      written.push(d);
    }
  }
  return written;
}

export function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** Filesystem primitives shared by adapters and the install CLI. */
export async function readText(path: string): Promise<string> {
  return await readFile(path, "utf8");
}

export async function writeText(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, "utf8");
}

export async function removeTree(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(path, { recursive: true, force: true });
}

export async function listDir(path: string): Promise<{ name: string; isDir: boolean; abs: string }[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries.map((e) => ({ name: e.name, isDir: e.isDirectory(), abs: join(path, e.name) }));
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export function relPosix(from: string, to: string): string {
  return toPosix(relative(from, to));
}

export function jsonStable(value: unknown): string {
  return JSON.stringify(sortKeys(value), null, 2) + "\n";
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}
