/**
 * The graph traversal engine.
 *
 * ── Why this lives in the kernel ────────────────────────────────────────────
 *
 * The kernel owns `GraphNodeSchema`, `GraphEdgeSchema` and
 * `GraphSnapshotSchema`, and it owns `InvalidationResultSchema` — a contract
 * whose four fields (`affectedNodes`, `staleDecisions`, `reopenedWork`,
 * `requiresReverification`) **cannot be computed without traversal**. Until
 * now the contracts had no engine, and milestone M5 was silently undone.
 *
 * Traversal is a **pure function over an existing contract**: no version
 * bump, no schema regeneration, no certificate invalidation, no new
 * dependency.
 *
 * ── The rules that shape everything here ────────────────────────────────────
 *
 * 1. **No I/O, no clock, no randomness.** The caller supplies `at`. The same
 *    snapshot always produces the same output, byte for byte. This is the
 *    same discipline the circuit breaker uses: *"the state machine is
 *    deliberately free of I/O and of wall-clock reads."*
 *
 * 2. **Order-independent determinism.** Two snapshots with the same node and
 *    edge SETS, in different array orders, must produce identical output. So
 *    everything is sorted: nodes by id, edges by `(from, kind, to)`, and
 *    every returned list by id.
 *
 * 3. **A malformed graph is reported, never silently repaired.** A dangling
 *    edge endpoint, a duplicate node, a duplicate edge and a self-loop are
 *    **anomalies**. The edge is never dropped: dropping it would hide the
 *    defect and change the answer.
 *
 * 4. **The kernel does not decide policy.** Which edges may be traversed, on
 *    what evidence, with what budget, is the SDK's decision (D-041). What
 *    lives here is the *semantics of the edge kinds* — which direction a
 *    kind propagates — because leaving that undefined for every caller is
 *    how a second trust ladder gets built.
 */
import { z } from "zod";
import {
  EDGE_KINDS,
  GraphEdgeSchema,
  GraphNodeSchema,
  NODE_KINDS,
  type GraphSnapshot,
} from "../contracts/index.js";

export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
export type GraphEdgeKind = (typeof EDGE_KINDS)[number];
export type GraphNodeKind = (typeof NODE_KINDS)[number];

/**
 * How an edge kind propagates an invalidation.
 *
 * The direction is stated per kind because this repository writes its
 * dependency edges **dependent → dependency**: "X imports Y" is the edge
 * `X → Y`, so Y's change affects X and the cascade must walk the edge
 * **backwards**.
 *
 * - `INVALIDATES` is the one kind that literally says "this invalidates
 *   that", so it propagates forwards.
 * - `SUPERSEDES` is a **replacement** relation. Invalidating the new record
 *   must not invalidate the old one, and vice versa. It belongs to the
 *   *restore* step, not the cascade.
 * - The other seven are dependency relations and propagate backwards.
 *
 * **Proof that the dependency kinds are required:** the invalidation
 * milestone's acceptance criterion is *"Invalidating E1 flips the dependent
 * claim to INVALIDATED, the dependent decision to STALE, and the dependent
 * work contract to REOPENED, and leaves unrelated decisions untouched."*
 * E1 → Claim is a `SUPPORTS` edge, so a cascade that follows only
 * `INVALIDATES` cannot satisfy it.
 */
export const EDGE_SEMANTICS = {
  IMPORTS: "REVERSE",
  MODIFIES: "REVERSE",
  TESTS: "REVERSE",
  SUPPORTS: "REVERSE",
  DEPENDS_ON: "REVERSE",
  DERIVED_FROM: "REVERSE",
  LEARNED_FROM: "REVERSE",
  INVALIDATES: "FORWARD",
  SUPERSEDES: "NONE",
} as const satisfies Record<GraphEdgeKind, "FORWARD" | "REVERSE" | "NONE">;

export type EdgeDirection = (typeof EDGE_SEMANTICS)[GraphEdgeKind];

/** The kinds that propagate, and how. */
export const PROPAGATING_KINDS: readonly GraphEdgeKind[] = EDGE_KINDS.filter(
  (k) => EDGE_SEMANTICS[k] !== "NONE",
);

/**
 * A defect in the graph itself.
 *
 * The kernel's rule is that absence is never evidence and a defect is
 * never silently absorbed: an anomaly is REPORTED, with the ids it concerns.
 */
export type GraphAnomalyClassification =
  | "DANGLING_ENDPOINT"
  | "DUPLICATE_NODE"
  | "DUPLICATE_EDGE"
  | "SELF_LOOP"
  | "MISSING_TRIGGER"
  /**
   * A node's `ref` does not match the id schema its kind requires — the
   * node says it is a DECISION, but its ref is not a decision id.
   *
   * Distinct from `DANGLING_ENDPOINT`, which means "an edge names a node
   * that has no record". Conflating the two made a malformed reference look
   * like a missing node.
   */
  | "MALFORMED_REF"
  /**
   * A caller-supplied reference — a decision id, a work-contract id — is
   * not a valid id.
   */
  | "MALFORMED_REFERENCE";

export interface GraphAnomaly {
  readonly classification: GraphAnomalyClassification;
  /** Why it happened, in one line. */
  readonly reason: string;
  /** The node ids it concerns, sorted. */
  readonly nodeIds: readonly string[];
}

/** The indexed form of a snapshot. Built once, traversed many times. */
export interface GraphIndex {
  /** Every node, keyed by id. A duplicate id keeps the FIRST after sorting. */
  readonly nodes: ReadonlyMap<string, GraphNode>;
  /** The outgoing edges of each node, sorted by `(kind, to)`. */
  readonly outgoing: ReadonlyMap<string, readonly GraphEdge[]>;
  /** The incoming edges of each node, sorted by `(kind, from)`. */
  readonly incoming: ReadonlyMap<string, readonly GraphEdge[]>;
  /** Ids that appear as an edge endpoint but have no node record. */
  readonly dangling: ReadonlySet<string>;
  /** Everything wrong with the graph, sorted by classification then ids. */
  readonly anomalies: readonly GraphAnomaly[];
}

/**
 * The single anomaly order, so two snapshots with the same sets produce the
 * same report and the two code paths cannot disagree.
 */
export function compareAnomalies(a: GraphAnomaly, b: GraphAnomaly): number {
  if (a.classification !== b.classification) return a.classification < b.classification ? -1 : 1;
  const ai = a.nodeIds.join(",");
  const bi = b.nodeIds.join(",");
  if (ai !== bi) return ai < bi ? -1 : 1;
  return a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0;
}

/** Sort an edge by `(from, kind, to)` — the total order the engine uses. */
function compareEdges(a: GraphEdge, b: GraphEdge): number {
  if (a.from !== b.from) return a.from < b.from ? -1 : 1;
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (a.to !== b.to) return a.to < b.to ? -1 : 1;
  return 0;
}

/**
 * Index a snapshot.
 *
 * The input is never mutated, and the output depends only on the SET of nodes
 * and edges — not on their order in the snapshot.
 */
export function indexGraph(snapshot: GraphSnapshot): GraphIndex {
  const anomalies: GraphAnomaly[] = [];

  // ── Nodes ────────────────────────────────────────────────────────────────
  //
  // The sort is a TOTAL order — id, then kind, then ref. Sorting on the id
  // alone is not enough: a stable sort leaves two nodes with the same id in
  // INPUT order, and the retained node's kind and ref decide whether a
  // decision is stale. The same node/edge multiset would then produce two
  // different answers, which is exactly what the determinism guarantee
  // forbids.
  const sortedNodes = [...snapshot.nodes].sort((a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    if (a.ref !== b.ref) return a.ref < b.ref ? -1 : 1;
    return 0;
  });
  const nodes = new Map<string, GraphNode>();
  for (const node of sortedNodes) {
    if (nodes.has(node.id)) {
      anomalies.push({
        classification: "DUPLICATE_NODE",
        reason: `node id "${node.id}" appears more than once; the first after sorting is kept`,
        nodeIds: [node.id],
      });
      continue;
    }
    nodes.set(node.id, node);
  }

  // ── Edges ────────────────────────────────────────────────────────────────
  const sortedEdges = [...snapshot.edges].sort(compareEdges);
  const seenEdge = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const edge of sortedEdges) {
    const key = `${edge.from}\u0000${edge.kind}\u0000${edge.to}`;
    if (seenEdge.has(key)) {
      anomalies.push({
        classification: "DUPLICATE_EDGE",
        reason: `edge ${edge.from} -${edge.kind}-> ${edge.to} appears more than once; it is traversed once`,
        nodeIds: [edge.from, edge.to].sort(),
      });
      continue;
    }
    seenEdge.add(key);
    edges.push(edge);

    if (edge.from === edge.to) {
      anomalies.push({
        classification: "SELF_LOOP",
        reason: `node "${edge.from}" has a ${edge.kind} edge to itself; it is reported, not followed`,
        nodeIds: [edge.from],
      });
    }
    for (const endpoint of [edge.from, edge.to]) {
      if (!nodes.has(endpoint)) {
        anomalies.push({
          classification: "DANGLING_ENDPOINT",
          reason: `edge ${edge.from} -${edge.kind}-> ${edge.to} names "${endpoint}", which has no node record`,
          nodeIds: [endpoint],
        });
      }
    }
  }

  // ── Adjacency ───────────────────────────────────────────────────────────
  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  const dangling = new Set<string>();
  for (const edge of edges) {
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
    outgoing.get(edge.from)!.push(edge);
    if (!incoming.has(edge.to)) incoming.set(edge.to, []);
    incoming.get(edge.to)!.push(edge);
    if (!nodes.has(edge.from)) dangling.add(edge.from);
    if (!nodes.has(edge.to)) dangling.add(edge.to);
  }

  anomalies.sort(compareAnomalies);

  return { nodes, outgoing, incoming, dangling, anomalies };
}

/** The neighbours of a node in a given direction, following only `kinds`. */
function neighbours(
  index: GraphIndex,
  id: string,
  direction: "FORWARD" | "REVERSE",
  kinds: ReadonlySet<GraphEdgeKind>,
): string[] {
  const edges = direction === "FORWARD" ? index.outgoing.get(id) : index.incoming.get(id);
  if (!edges) return [];
  const out: string[] = [];
  for (const edge of edges) {
    if (!kinds.has(edge.kind)) continue;
    out.push(direction === "FORWARD" ? edge.to : edge.from);
  }
  return out;
}

export interface TraverseOptions {
  /** The edge kinds to follow. Every kind, by default. */
  readonly kinds?: readonly GraphEdgeKind[];
  /** `FORWARD` follows `from → to`; `REVERSE` follows `to → from`. */
  readonly direction?: "FORWARD" | "REVERSE";
}

/** One reachable node, with how far it is from the start. */
export interface ReachableNode {
  readonly id: string;
  /** The number of edges from the start node. */
  readonly hops: number;
}

/**
 * A stable, comparable serialisation of an index.
 *
 * `JSON.stringify` on a `Map` or a `Set` produces `{}`. So a determinism
 * test that stringifies an index compares two empty objects and proves
 * nothing — which is exactly what two of this module's own tests were
 * doing. This is the serialisation such a test needs: every map rendered as
 * sorted entries, every list sorted, so two indexes built from the same
 * node and edge sets produce the same string.
 */
export function serializeGraphIndex(index: GraphIndex): string {
  const nodes = [...index.nodes.keys()].sort();
  const outgoing = [...index.outgoing.entries()]
    .map(([id, edges]) => `${id}=>${edges.map((e) => `${e.kind}:${e.to}`).join("|")}`)
    .sort();
  const incoming = [...index.incoming.entries()]
    .map(([id, edges]) => `${id}<=${edges.map((e) => `${e.kind}:${e.from}`).join("|")}`)
    .sort();
  const dangling = [...index.dangling].sort();
  const anomalies = index.anomalies
    .map((a) => `${a.classification}:${a.nodeIds.join("+")}:${a.reason}`)
    .sort();
  return JSON.stringify({ nodes, outgoing, incoming, dangling, anomalies });
}

/**
 * The nodes reachable from `from`, with their hop distance, sorted by id.
 *
 * The hop distance is exposed SEPARATELY from the flat id list, because
 * "is it reachable" and "how far is it" are different questions, and a
 * caller that wants the second must not have to re-walk the graph to get
 * it.
 *
 * Reachability over a cyclic region is still well defined — a visited set
 * makes the walk terminate — so a cycle never turns into an infinite loop
 * and never truncates the answer.
 */
export function reachableWithDistance(
  index: GraphIndex,
  from: string,
  opts: TraverseOptions = {},
): ReachableNode[] {
  const kinds = new Set<GraphEdgeKind>(opts.kinds ?? EDGE_KINDS);
  const direction = opts.direction ?? "FORWARD";
  const distance = new Map<string, number>([[from, 0]]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const hops = distance.get(current)!;
    for (const next of neighbours(index, current, direction, kinds)) {
      if (distance.has(next)) continue;
      distance.set(next, hops + 1);
      queue.push(next);
    }
  }
  distance.delete(from);
  return [...distance.entries()]
    .map(([id, hops]) => ({ id, hops }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The nodes reachable from `from`, excluding `from` itself, sorted by id.
 */
export function reachable(index: GraphIndex, from: string, opts: TraverseOptions = {}): string[] {
  return reachableWithDistance(index, from, opts).map((node) => node.id);
}

/**
 * The nodes reachable from `from` through the **propagating** edges, using
 * each kind's own direction.
 *
 * This is the walk the invalidation cascade uses: it follows `INVALIDATES`
 * forwards and the seven dependency kinds backwards, and ignores
 * `SUPERSEDES` entirely.
 */
export function propagatingReachable(index: GraphIndex, from: string): string[] {
  const seen = new Set<string>([from]);
  const queue: string[] = [from];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of index.outgoing.get(current) ?? []) {
      const semantics = EDGE_SEMANTICS[edge.kind];
      if (semantics === "NONE") continue;
      // FORWARD: the edge says "this invalidates that", so the affected node
      // is the edge's target. REVERSE: the edge is a DEPENDENCY edge written
      // dependent → dependency, so the affected node is the edge's SOURCE —
      // which means walking the INCOMING edges of the current node.
      const next = semantics === "FORWARD" ? edge.to : edge.from;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
    for (const edge of index.incoming.get(current) ?? []) {
      if (EDGE_SEMANTICS[edge.kind] !== "REVERSE") continue;
      const next = edge.from;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  seen.delete(from);
  return [...seen].sort();
}

/**
 * The connected components, each sorted, and the list sorted by its first
 * member. No single-root assumption: a disconnected graph is the normal
 * case, not an error.
 */
export function components(index: GraphIndex): string[][] {
  const visited = new Set<string>();
  const all = new Set<string>(index.nodes.keys());
  for (const id of index.dangling) all.add(id);

  const out: string[][] = [];
  for (const start of [...all].sort()) {
    if (visited.has(start)) continue;
    const members: string[] = [];
    const stack = [start];
    visited.add(start);
    while (stack.length > 0) {
      const current = stack.pop()!;
      members.push(current);
      for (const next of neighbours(index, current, "FORWARD", new Set(EDGE_KINDS))) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
      for (const next of neighbours(index, current, "REVERSE", new Set(EDGE_KINDS))) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    members.sort();
    out.push(members);
  }
  out.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0));
  return out;
}

/**
 * The cycles, as strongly connected components with more than one member,
 * plus every self-loop.
 *
 * Deterministic: the components are sorted by their smallest member, and
 * each component's members are sorted.
 */
export function findCycles(index: GraphIndex): string[][] {
  // Tarjan's algorithm, iterative so a deep graph cannot blow the stack.
  const index_ = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  let counter = 0;
  const out: string[][] = [];

  const ids = [...new Set([...index.nodes.keys(), ...index.dangling])].sort();

  for (const root of ids) {
    if (index_.has(root)) continue;
    const work: Array<{ id: string; edgeIndex: number }> = [{ id: root, edgeIndex: 0 }];
    index_.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const edges = index.outgoing.get(frame.id) ?? [];
      if (frame.edgeIndex < edges.length) {
        const edge = edges[frame.edgeIndex]!;
        frame.edgeIndex += 1;
        const next = edge.to;
        if (!index_.has(next)) {
          index_.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          work.push({ id: next, edgeIndex: 0 });
        } else if (onStack.has(next)) {
          const candidate = index_.get(next)!;
          if (candidate < low.get(frame.id)!) low.set(frame.id, candidate);
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) {
        const candidate = low.get(frame.id)!;
        if (candidate < low.get(parent.id)!) low.set(parent.id, candidate);
      }
      if (low.get(frame.id) === index_.get(frame.id)) {
        const component: string[] = [];
        for (;;) {
          const member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
          if (member === frame.id) break;
        }
        component.sort();
        if (component.length > 1) out.push(component);
      }
    }
  }

  // A self-loop is a cycle of one, and Tarjan does not report it.
  //
  // But a node that has a self-loop AND belongs to a larger strongly
  // connected component is ONE cycle, not two. Reporting it twice makes a
  // consumer that COUNTS cycles double-count, so the self-loop is only
  // reported on its own when it is not already inside an SCC.
  const inLargerComponent = new Set(out.flatMap((component) => (component.length > 1 ? component : [])));
  for (const id of ids) {
    if (inLargerComponent.has(id)) continue;
    for (const edge of index.outgoing.get(id) ?? []) {
      if (edge.from === edge.to) {
        out.push([id]);
        break;
      }
    }
  }

  out.sort((a, b) => {
    const ai = a.join(",");
    const bi = b.join(",");
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
  return out;
}

export interface TopologicalOrder {
  /**
   * The order, when the graph is acyclic.
   *
   * **Empty when a cycle exists** — the order is undefined there, and
   * emitting a plausible-looking one would be a wrong answer presented as
   * right. `cycles` says what blocked it.
   */
  readonly order: readonly string[];
  /** The cycles that made the order undefined. */
  readonly cycles: readonly string[][];
}

/**
 * A topological order over the dependency edges, or a refusal.
 *
 * The dependency edges point **dependent → dependency**, so the topological
 * order is computed on the REVERSED graph: a dependency must come before
 * the thing that depends on it.
 *
 * The order is deterministic: among the nodes whose dependencies are all
 * placed, the smallest id is chosen next.
 */
export function topologicalOrder(index: GraphIndex): TopologicalOrder {
  const cycles = findCycles(index);
  if (cycles.length > 0) return { order: [], cycles };

  // The dependency relation is `dependent → dependency`, so the ordering
  // constraint is "the dependency comes first" — i.e. Kahn's algorithm on
  // the REVERSED adjacency.
  const deps = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of index.nodes.keys()) deps.set(id, 0);
  for (const id of index.dangling) deps.set(id, 0);

  // ALL SEVEN dependency kinds, not four. `SUPPORTS`, `TESTS` and
  // `LEARNED_FROM` are declared dependency relations in EDGE_SEMANTICS, so
  // they constrain the order exactly like `DEPENDS_ON` does. Leaving them
  // out made the "dependency-first" order violate its own invariant: the
  // dependent could come before the thing it depends on.
  //
  // `INVALIDATES` is NOT a dependency — it is an invalidation, and it does
  // not order anything. `SUPERSEDES` is a replacement, and it does not
  // either.
  const dependencyKinds = new Set<GraphEdgeKind>(
    (Object.keys(EDGE_SEMANTICS) as GraphEdgeKind[]).filter(
      (kind) => EDGE_SEMANTICS[kind] === "REVERSE",
    ),
  );
  for (const [id, edges] of index.outgoing) {
    for (const edge of edges) {
      if (!dependencyKinds.has(edge.kind)) continue;
      if (!deps.has(edge.from) || !deps.has(edge.to)) continue;
      deps.set(edge.from, (deps.get(edge.from) ?? 0) + 1);
      if (!dependents.has(edge.to)) dependents.set(edge.to, []);
      dependents.get(edge.to)!.push(edge.from);
    }
  }

  const ready = [...deps.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();

  const order: string[] = [];
  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);
    for (const dependent of (dependents.get(next) ?? []).sort()) {
      const remaining = (deps.get(dependent) ?? 0) - 1;
      deps.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== deps.size) {
    // A cycle that Tarjan missed — impossible in theory, but the engine
    // refuses rather than emitting a partial order.
    return { order: [], cycles: findCycles(index) };
  }
  return { order, cycles: [] };
}
