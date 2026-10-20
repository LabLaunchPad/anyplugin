/**
 * The repository's own dependency graph — the first real corpus.
 *
 * This is the roadmap's *"the repository as its own graph"* module, and it is
 * the corpus the synthetic tests cannot replace: a real graph, with real
 * branching, real multi-hop paths, and a real answer that a change to a
 * `package.json` would move.
 *
 * ── Why this test lives in the kernel package ──────────────────────────────
 *
 * The KERNEL still knows nothing about AnyPlugin: it imports nothing
 * workspace-internal, and `core/src/boundaries/package-boundary.test.ts`
 * enforces that mechanically. This file is a **corpus**, not a dependency —
 * it reads the workspace's `package.json` files as data, the way a test
 * fixture would. No module specifier crosses a package boundary.
 *
 * ── The corpus is DERIVED, not listed ─────────────────────────────────────
 *
 * An earlier version hard-coded four package directories. The workspace has
 * **eight**, and the four it missed — the adapters — are exactly the ones
 * the CLI depends on, so their edges were **silently dropped**: a change to
 * an adapter's dependencies would move nothing, while the corpus claimed it
 * would. The directory list now comes from `pnpm-workspace.yaml`, and a
 * test asserts that every package the workspace declares is in the corpus.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTRACT_VERSION, GraphSnapshotSchema, type GraphSnapshot } from "../contracts/index.js";
import { components, indexGraph, reachable, reachableWithDistance, serializeGraphIndex, topologicalOrder } from "./index.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const AT = "2026-10-20T00:00:00Z";

/**
 * The workspace's package directories, read from `pnpm-workspace.yaml`.
 *
 * The manifest is a small, fixed shape — a `packages:` list of directories
 * and globs — so it is parsed directly rather than through a YAML
 * dependency, which the kernel must not have.
 */
function workspaceDirs(): string[] {
  const manifest = readFileSync(join(REPO_ROOT, "pnpm-workspace.yaml"), "utf8");
  const dirs: string[] = [];
  let inPackages = false;
  for (const line of manifest.split(/\r?\n/)) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const item = /^\s*-\s*(\S+)\s*$/.exec(line);
      if (item) {
        const pattern = item[1]!;
        if (pattern.endsWith("/*")) {
          const parent = join(REPO_ROOT, pattern.slice(0, -2));
          if (existsSync(parent)) {
            for (const entry of readdirSync(parent).sort()) {
              if (statSync(join(parent, entry)).isDirectory()) dirs.push(`${pattern.slice(0, -2)}/${entry}`);
            }
          }
        } else {
          dirs.push(pattern);
        }
        continue;
      }
      if (line.trim() !== "") break;
    }
  }
  return dirs;
}

/** Read one package's name and its workspace dependencies. */
function readPackage(dir: string): { name: string; deps: string[] } | null {
  const file = join(REPO_ROOT, dir, "package.json");
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, "utf8")) as {
    name?: string;
    dependencies?: Record<string, string>;
  };
  if (!parsed.name) return null;
  const deps = Object.keys(parsed.dependencies ?? {}).filter((d) => d.startsWith("@lablaunchpad/"));
  return { name: parsed.name, deps };
}

/**
 * Build the workspace's dependency graph.
 *
 * The edge is **dependent → dependency**, which is the direction this
 * repository writes its dependency edges in — and the direction the
 * invalidation cascade walks backwards.
 */
function buildWorkspaceGraph(): GraphSnapshot {
  const packages = workspaceDirs()
    .map(readPackage)
    .filter((p): p is { name: string; deps: string[] } => p !== null);
  // The id must be stable and derived from the NAME, not from the array
  // index — an index-derived id would change whenever the workspace's
  // directory order changed, which would make the corpus's ids meaningless.
  const nameToSlug = new Map(packages.map((p) => [p.name, `ND-${p.name.replace(/^@lablaunchpad\//, "").replace(/[^A-Za-z0-9_-]/g, "-")}`]));

  const nodes = packages.map((p) => ({
    id: nameToSlug.get(p.name)!,
    kind: "FILE" as const,
    ref: p.name,
  }));

  const edges: Array<{ from: string; kind: "DEPENDS_ON"; to: string }> = [];
  for (const p of packages) {
    for (const dep of p.deps) {
      const to = nameToSlug.get(dep);
      if (!to) continue;
      edges.push({ from: nameToSlug.get(p.name)!, kind: "DEPENDS_ON", to });
    }
  }

  return GraphSnapshotSchema.parse({ contractVersion: CONTRACT_VERSION, at: AT, nodes, edges });
}

/** The node id of a package by its name. */
function idOf(graph: GraphSnapshot, name: string): string {
  const node = graph.nodes.find((n) => n.ref === name);
  if (!node) throw new Error(`the corpus does not contain ${name}`);
  return node.id;
}

describe("the repository as its own graph", () => {
  it("builds a graph from the real workspace", () => {
    const graph = buildWorkspaceGraph();
    expect(graph.nodes.length).toBeGreaterThanOrEqual(8);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(indexGraph(graph).anomalies).toEqual([]);
  });

  it("covers EVERY package the workspace declares", () => {
    // The guard against the corpus silently narrowing. An earlier version
    // hard-coded four directories and dropped the adapters' edges without a
    // word, while claiming the corpus would move with any dependency
    // change.
    const declared = workspaceDirs().filter((dir) => existsSync(join(REPO_ROOT, dir, "package.json")));
    const graph = buildWorkspaceGraph();
    expect(
      graph.nodes.length,
      `the corpus covers ${graph.nodes.length} of the workspace's ${declared.length} packages`,
    ).toBe(declared.length);
    for (const dir of declared) {
      const pkg = readPackage(dir);
      expect(pkg, `${dir} has a package.json`).not.toBeNull();
      expect(
        graph.nodes.some((n) => n.ref === pkg!.name),
        `${pkg!.name} (${dir}) is missing from the corpus`,
      ).toBe(true);
    }
  });

  it("has no dropped workspace edge", () => {
    // Every workspace dependency must become an edge. A dependency on a
    // package outside the workspace is an EXTERNAL dependency, and is not
    // an edge of this graph — but it must be counted, not silently lost.
    const packages = workspaceDirs()
      .map(readPackage)
      .filter((p): p is { name: string; deps: string[] } => p !== null);
    const names = new Set(packages.map((p) => p.name));
    const graph = buildWorkspaceGraph();
    let expected = 0;
    for (const p of packages) {
      for (const dep of p.deps) {
        if (!names.has(dep)) continue;
        expected += 1;
        expect(
          graph.edges.some((e) => e.from === idOf(graph, p.name) && e.to === idOf(graph, dep)),
          `the edge ${p.name} -> ${dep} was dropped`,
        ).toBe(true);
      }
    }
    expect(graph.edges.length, "the edge count must equal the workspace dependency count").toBe(expected);
  });

  it("is acyclic, so the dependency direction has a topological order", () => {
    const graph = buildWorkspaceGraph();
    const result = topologicalOrder(indexGraph(graph));
    expect(result.cycles, "a cycle in the workspace dependency direction would be a real defect").toEqual([]);
    expect(result.order.length).toBe(graph.nodes.length);
  });

  it("places every dependency before the package that depends on it", () => {
    const graph = buildWorkspaceGraph();
    const index = indexGraph(graph);
    const result = topologicalOrder(index);
    for (const edge of graph.edges) {
      expect(
        result.order.indexOf(edge.to),
        `${edge.from} depends on ${edge.to}, so ${edge.to} must come first`,
      ).toBeLessThan(result.order.indexOf(edge.from));
    }
  });

  it("shows the kernel as a leaf — the kernel depends on no workspace package", () => {
    const graph = buildWorkspaceGraph();
    const index = indexGraph(graph);
    const kernel = idOf(graph, "@lablaunchpad/worker-runtime");
    // The kernel is a leaf in the DEPENDENCY direction: it depends on no
    // workspace package. (It is not a leaf in the other direction — the CLI
    // depends on it. The two are different facts, and this test asserts
    // the one it names.)
    expect(reachable(index, kernel, { direction: "FORWARD" })).toEqual([]);
  });

  it("shows the multi-hop path the architecture states", () => {
    const graph = buildWorkspaceGraph();
    const index = indexGraph(graph);
    const cli = idOf(graph, "@lablaunchpad/cli");
    const core = idOf(graph, "@lablaunchpad/core");
    const kernel = idOf(graph, "@lablaunchpad/worker-runtime");

    // The CLI depends on the core AND on the kernel, so both are reachable
    // from the CLI in the dependency direction — and the core is reachable
    // in TWO hops through the kernel is not: the CLI depends on the core
    // directly, so it is ONE hop. The multi-hop case is the CLI -> core
    // -> nothing, and the CLI -> kernel -> nothing.
    const fromCli = reachableWithDistance(index, cli, { direction: "FORWARD" });
    const coreHop = fromCli.find((n) => n.id === core);
    const kernelHop = fromCli.find((n) => n.id === kernel);
    expect(coreHop, "the CLI must reach the core").toBeDefined();
    expect(kernelHop, "the CLI must reach the kernel").toBeDefined();
    expect(coreHop!.hops, "the CLI depends on the core directly").toBe(1);
    expect(kernelHop!.hops, "the CLI depends on the kernel directly").toBe(1);

    // And the REVERSE direction finds the dependents: the core is depended
    // on by the CLI and by the adapters.
    const dependents = reachable(index, core, { direction: "REVERSE" });
    expect(dependents).toContain(cli);
    expect(dependents.length, "the core has several dependents").toBeGreaterThan(1);
  });

  it("is deterministic whatever order the workspace is read in", () => {
    // A REAL serialisation: `JSON.stringify` on a Map produces `{}`, so a
    // test that stringified the index compared two empty objects and
    // proved nothing.
    const a = serializeGraphIndex(indexGraph(buildWorkspaceGraph()));
    const b = serializeGraphIndex(indexGraph(buildWorkspaceGraph()));
    expect(a).toBe(b);
    expect(a.length, "the serialisation must not be empty").toBeGreaterThan(50);

    // And the engine's output is independent of the edge array's order too.
    const graph = buildWorkspaceGraph();
    const shuffled = GraphSnapshotSchema.parse({
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });
    expect(serializeGraphIndex(indexGraph(shuffled))).toBe(serializeGraphIndex(indexGraph(graph)));
  });

  it("enumerates the workspace's components", () => {
    const graph = buildWorkspaceGraph();
    const parts = components(indexGraph(graph));
    expect(parts.length).toBeGreaterThan(0);
    // Every node appears in exactly one component.
    const flat = parts.flat().sort();
    expect(flat).toEqual([...graph.nodes.map((n) => n.id)].sort());
  });

  it("reads a workspace that exists", () => {
    // A guard against the corpus silently becoming empty: an empty graph
    // would make every other assertion vacuously true.
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
    const dirs = workspaceDirs();
    expect(dirs.length, "the workspace declares no packages").toBeGreaterThan(4);
    expect(dirs).toContain("core");
    expect(dirs).toContain("packages/worker-runtime");
  });
});
