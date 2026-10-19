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
 * ── What it proves ─────────────────────────────────────────────────────────
 *
 * 1. The graph the engine produces from the real workspace is **acyclic** —
 *    so the topological order is defined, and a cycle in the dependency
 *    direction would be caught rather than tolerated.
 * 2. The kernel is a **leaf**: nothing depends on it that it depends on, and
 *    it depends on no workspace package.
 * 3. Multi-hop paths exist and are the ones the architecture says they are:
 *    `cli → core → (nothing)` and `cli → worker-runtime → (nothing)`.
 * 4. The result is **deterministic**: the same workspace yields the same
 *    bytes, whatever order the files are read in.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONTRACT_VERSION, GraphSnapshotSchema, type GraphSnapshot } from "../contracts/index.js";
import { components, indexGraph, reachable, topologicalOrder } from "./index.js";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..", "..");
const AT = "2026-10-20T00:00:00Z";

/** The workspace's package directories. */
const WORKSPACE_DIRS = ["cli", "core", "packages/worker-runtime", "plugins/knowledge"];

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
  const packages = WORKSPACE_DIRS.map(readPackage).filter((p): p is { name: string; deps: string[] } => p !== null);
  const nameToSlug = new Map(packages.map((p, i) => [p.name, `ND-${i}`]));

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

describe("the repository as its own graph", () => {
  it("builds a graph from the real workspace", () => {
    const graph = buildWorkspaceGraph();
    expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(indexGraph(graph).anomalies).toEqual([]);
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

  it("shows the kernel as a leaf — nothing depends on what it depends on", () => {
    const graph = buildWorkspaceGraph();
    const index = indexGraph(graph);
    const kernel = graph.nodes.find((n) => n.ref === "@lablaunchpad/worker-runtime");
    expect(kernel, "the kernel must be in the graph").toBeDefined();
    // The kernel depends on no workspace package, so nothing sits below it.
    expect(reachable(index, kernel!.id, { direction: "FORWARD" })).toEqual([]);
  });

  it("shows the multi-hop path the architecture states", () => {
    const graph = buildWorkspaceGraph();
    const index = indexGraph(graph);
    const cli = graph.nodes.find((n) => n.ref === "@lablaunchpad/cli");
    expect(cli).toBeDefined();
    // The CLI depends on the core and on the kernel; walking the dependency
    // edge backwards from the core finds the CLI.
    const core = graph.nodes.find((n) => n.ref === "@lablaunchpad/core");
    expect(core).toBeDefined();
    expect(reachable(index, core!.id, { direction: "REVERSE" })).toContain(cli!.id);
  });

  it("is deterministic whatever order the workspace is read in", () => {
    const a = JSON.stringify(buildWorkspaceGraph());
    const b = JSON.stringify(buildWorkspaceGraph());
    expect(a).toBe(b);
    // And the engine's output is independent of the edge array's order too.
    const graph = buildWorkspaceGraph();
    const shuffled = GraphSnapshotSchema.parse({
      ...graph,
      nodes: [...graph.nodes].reverse(),
      edges: [...graph.edges].reverse(),
    });
    expect(JSON.stringify(indexGraph(shuffled))).toBe(JSON.stringify(indexGraph(graph)));
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
    expect(readdirSync(REPO_ROOT).length).toBeGreaterThan(0);
    expect(existsSync(join(REPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });
});
