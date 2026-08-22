import { rm } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const targets = [];
async function collect(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".vitest") {
      targets.push(join(dir, entry.name));
    } else if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "research") {
      await collect(join(dir, entry.name));
    }
  }
}
await collect(process.cwd());
for (const t of targets) {
  await rm(t, { recursive: true, force: true });
}
console.log(`cleaned ${targets.length} build directories`);
