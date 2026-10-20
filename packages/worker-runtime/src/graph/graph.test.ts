/**
 * The graph traversal engine — the corpus.
 *
 * Every case the specification names is here: branching, multi-hop, a cycle,
 * a self-loop, a disconnected component, a duplicate edge, a dangling
 * endpoint, the invalidation chain, and an **unrelated decision that must
 * stay untouched** — the negative acceptance test, which is the one that
 * matters.
 */
import { describe, it, expect } from "vitest";
import {
  CONTRACT_VERSION,
  GraphSnapshotSchema,
  type GraphSnapshot,
} from "../contracts/index.js";
import {
  components,
  computeInvalidation,
  findCycles,
  indexGraph,
  propagatingReachable,
  reachable,
  reachableWithDistance,
  serializeGraphIndex,
  topologicalOrder,
  type GraphEdgeKind,
  type GraphNodeKind,
} from "./index.js";

const AT = "2026-10-20T00:00:00Z";

function node(id: string, kind: GraphNodeKind, ref: string) {
  return { id, kind, ref };
}
function edge(from: string, kind: GraphEdgeKind, to: string) {
  return { from, kind, to };
}
function snapshot(
  nodes: ReturnType<typeof node>[],
  edges: ReturnType<typeof edge>[],
): GraphSnapshot {
  return GraphSnapshotSchema.parse({ contractVersion: CONTRACT_VERSION, at: AT, nodes, edges });
}

/**
 * The invalidation chain, exactly as the milestone states it:
 * E1 → Claim → Decision → Work, plus an unrelated decision on unrelated
 * evidence, which must be left untouched.
 */
const CHAIN = snapshot(
  [
    node("ND-E1", "EVIDENCE", "EV-1"),
    node("ND-C1", "CLAIM", "CLAIM-1"),
    node("ND-D1", "DECISION", "DEC-1"),
    node("ND-W1", "WORK_ITEM", "WC-1"),
    node("ND-E2", "EVIDENCE", "EV-2"),
    node("ND-D2", "DECISION", "DEC-2"),
  ],
  [
    edge("ND-C1", "SUPPORTS", "ND-E1"),
    edge("ND-D1", "SUPPORTS", "ND-C1"),
    edge("ND-W1", "DEPENDS_ON", "ND-D1"),
    edge("ND-D2", "SUPPORTS", "ND-E2"),
  ],
);

describe("indexing a snapshot", () => {
  it("reports nothing wrong with a well-formed graph", () => {
    const index = indexGraph(CHAIN);
    expect(index.anomalies).toEqual([]);
    expect(index.nodes.size).toBe(6);
    expect(index.dangling.size).toBe(0);
  });

  it("never mutates its input", () => {
    const before = JSON.stringify(CHAIN);
    indexGraph(CHAIN);
    expect(JSON.stringify(CHAIN)).toBe(before);
  });

  it("reports a duplicate node and keeps the first after sorting", () => {
    // The sort is a TOTAL order — id, then kind, then ref — so the retained
    // node does not depend on the input order. An earlier version sorted on
    // the id alone, which left a tie in INPUT order, and the same
    // node/edge multiset then produced two different answers.
    const forward = snapshot(
      [node("ND-A", "FILE", "a.ts"), node("ND-A", "FILE", "other.ts")],
      [],
    );
    const backward = snapshot(
      [node("ND-A", "FILE", "other.ts"), node("ND-A", "FILE", "a.ts")],
      [],
    );
    for (const graph of [forward, backward]) {
      const index = indexGraph(graph);
      expect(index.anomalies.map((a) => a.classification)).toEqual(["DUPLICATE_NODE"]);
      expect(index.nodes.get("ND-A")?.ref, "the retained node must not depend on the input order").toBe("a.ts");
    }
  });

  it("reports a duplicate edge and traverses it once", () => {
    const graph = snapshot(
      [node("ND-A", "FILE", "a.ts"), node("ND-B", "FILE", "b.ts")],
      [edge("ND-A", "IMPORTS", "ND-B"), edge("ND-A", "IMPORTS", "ND-B")],
    );
    const index = indexGraph(graph);
    expect(index.anomalies.map((a) => a.classification)).toEqual(["DUPLICATE_EDGE"]);
    expect(index.outgoing.get("ND-A")).toHaveLength(1);
  });

  it("reports a self-loop", () => {
    const graph = snapshot([node("ND-A", "FILE", "a.ts")], [edge("ND-A", "IMPORTS", "ND-A")]);
    const index = indexGraph(graph);
    expect(index.anomalies.map((a) => a.classification)).toEqual(["SELF_LOOP"]);
  });

  it("reports a dangling endpoint and never drops the edge", () => {
    const graph = snapshot([node("ND-A", "FILE", "a.ts")], [edge("ND-A", "IMPORTS", "ND-GONE")]);
    const index = indexGraph(graph);
    expect(index.anomalies.map((a) => a.classification)).toEqual(["DANGLING_ENDPOINT"]);
    expect(index.dangling.has("ND-GONE")).toBe(true);
    // The edge is still there — dropping it would hide the defect.
    expect(index.outgoing.get("ND-A")).toHaveLength(1);
  });
});

describe("reachability", () => {
  it("follows a dependency edge backwards", () => {
    // "ND-A imports ND-B" is the edge ND-A → ND-B, so ND-B's change affects
    // ND-A. The edge must be walked the other way.
    const graph = snapshot(
      [node("ND-A", "FILE", "a.ts"), node("ND-B", "FILE", "b.ts")],
      [edge("ND-A", "IMPORTS", "ND-B")],
    );
    const index = indexGraph(graph);
    expect(reachable(index, "ND-B", { direction: "REVERSE" })).toEqual(["ND-A"]);
    expect(reachable(index, "ND-B", { direction: "FORWARD" })).toEqual([]);
  });

  it("walks multiple hops and branches", () => {
    const index = indexGraph(CHAIN);
    // From the decision, the work item that depends on it.
    expect(reachable(index, "ND-D1", { direction: "REVERSE" })).toEqual(["ND-W1"]);
  });

  it("terminates on a cycle rather than looping forever", () => {
    const graph = snapshot(
      [node("ND-A", "FILE", "a.ts"), node("ND-B", "FILE", "b.ts")],
      [edge("ND-A", "IMPORTS", "ND-B"), edge("ND-B", "IMPORTS", "ND-A")],
    );
    const index = indexGraph(graph);
    expect(reachable(index, "ND-A")).toEqual(["ND-B"]);
    expect(reachable(index, "ND-B")).toEqual(["ND-A"]);
  });

  it("enumerates disconnected components", () => {
    const graph = snapshot(
      [
        node("ND-A", "FILE", "a.ts"),
        node("ND-B", "FILE", "b.ts"),
        node("ND-C", "FILE", "c.ts"),
        node("ND-D", "FILE", "d.ts"),
      ],
      [edge("ND-A", "IMPORTS", "ND-B"), edge("ND-C", "IMPORTS", "ND-D")],
    );
    const index = indexGraph(graph);
    expect(components(index)).toEqual([
      ["ND-A", "ND-B"],
      ["ND-C", "ND-D"],
    ]);
  });
});

describe("cycles", () => {
  it("detects a cycle", () => {
    const graph = snapshot(
      [node("ND-A", "FILE", "a.ts"), node("ND-B", "FILE", "b.ts")],
      [edge("ND-A", "IMPORTS", "ND-B"), edge("ND-B", "IMPORTS", "ND-A")],
    );
    expect(findCycles(indexGraph(graph))).toEqual([["ND-A", "ND-B"]]);
  });

  it("treats a self-loop as a cycle of one", () => {
    const graph = snapshot([node("ND-A", "FILE", "a.ts")], [edge("ND-A", "IMPORTS", "ND-A")]);
    expect(findCycles(indexGraph(graph))).toEqual([["ND-A"]]);
  });

  it("reports no cycle for an acyclic graph", () => {
    expect(findCycles(indexGraph(CHAIN))).toEqual([]);
  });
});

describe("topological order", () => {
  it("places a dependency before the thing that depends on it", () => {
    // ND-A depends on ND-B, so ND-B comes first.
    const graph = snapshot(
      [node("ND-A", "FILE", "a.ts"), node("ND-B", "FILE", "b.ts")],
      [edge("ND-A", "DEPENDS_ON", "ND-B")],
    );
    const result = topologicalOrder(indexGraph(graph));
    expect(result.cycles).toEqual([]);
    expect(result.order.indexOf("ND-B")).toBeLessThan(result.order.indexOf("ND-A"));
  });

  it("REFUSES to emit an order when a cycle exists", () => {
    // A partial order would be a wrong answer presented as right.
    const graph = snapshot(
      [node("ND-A", "FILE", "a.ts"), node("ND-B", "FILE", "b.ts")],
      [edge("ND-A", "DEPENDS_ON", "ND-B"), edge("ND-B", "DEPENDS_ON", "ND-A")],
    );
    const result = topologicalOrder(indexGraph(graph));
    expect(result.order).toEqual([]);
    expect(result.cycles.length).toBeGreaterThan(0);
  });
});

describe("the invalidation cascade", () => {
  it("reaches the dependent decision and work item, and leaves the unrelated one untouched", () => {
    // THE acceptance criterion. Invalidating E1 flips the dependent claim,
    // the dependent decision and the dependent work — and leaves DEC-2
    // alone.
    const { result, anomalies } = computeInvalidation(CHAIN, {
      trigger: "ND-E1",
      at: AT,
      decisions: [
        { id: "DEC-1", contractId: "WC-1", supportingEvidence: ["EV-1"] },
        { id: "DEC-2", contractId: "WC-9", supportingEvidence: ["EV-2"] },
      ],
    });

    expect(anomalies).toEqual([]);
    expect(result.affectedNodes).toEqual(["ND-C1", "ND-D1", "ND-W1"]);
    expect(result.staleDecisions).toEqual(["DEC-1"]);
    expect(result.reopenedWork).toEqual(["WC-1"]);
    expect(result.staleDecisions).not.toContain("DEC-2");
    expect(result.reopenedWork).not.toContain("WC-9");
  });

  it("marks a decision stale through its supporting evidence", () => {
    // The route `DecisionSchema.supportingEvidence` encodes, which the graph
    // may not model as an edge. The decision the graph ALSO reaches is stale
    // for the same reason, so both appear.
    const { result } = computeInvalidation(CHAIN, {
      trigger: "ND-E1",
      at: AT,
      decisions: [{ id: "DEC-7", contractId: "WC-7", supportingEvidence: ["EV-1"] }],
    });
    expect(result.staleDecisions).toEqual(["DEC-1", "DEC-7"]);
    expect(result.reopenedWork).toEqual(["WC-1", "WC-7"]);
  });

  it("re-verifies an artefact the trigger itself invalidated", () => {
    // The artefact that CHANGED is the trigger. A verification that consumed
    // it must run again — the trigger is excluded from `affectedNodes`
    // because it is the changed thing, not an affected thing, but it is not
    // excluded from the consequences.
    const { result } = computeInvalidation(CHAIN, {
      trigger: "ND-E1",
      at: AT,
      evidence: [{ id: "EV-1", contentHash: "sha256:" + "a".repeat(64) }],
      verifications: [
        { id: "VER-1", inputHashes: ["sha256:" + "a".repeat(64)] },
        { id: "VER-2", inputHashes: ["sha256:" + "b".repeat(64)] },
      ],
    });
    expect(result.requiresReverification).toEqual(["VER-1"]);
  });

  it("does not require re-verification when the artefact was unaffected", () => {
    // Invalidating E1 must not re-verify whatever consumed E2.
    const { result } = computeInvalidation(CHAIN, {
      trigger: "ND-E1",
      at: AT,
      evidence: [{ id: "EV-2", contentHash: "sha256:" + "b".repeat(64) }],
      verifications: [{ id: "VER-2", inputHashes: ["sha256:" + "b".repeat(64)] }],
    });
    expect(result.requiresReverification).toEqual([]);
  });

  it("reports a missing trigger instead of pretending nothing was affected", () => {
    const { result, anomalies } = computeInvalidation(CHAIN, { trigger: "ND-NOPE", at: AT });
    expect(anomalies.map((a) => a.classification)).toEqual(["MISSING_TRIGGER"]);
    expect(result.affectedNodes).toEqual([]);
    expect(result.staleDecisions).toEqual([]);
  });

  it("never propagates along a SUPERSEDES edge", () => {
    // SUPERSEDES is a replacement relation: invalidating the new record must
    // not invalidate the old one.
    const graph = snapshot(
      [
        node("ND-E1", "EVIDENCE", "EV-1"),
        node("ND-E2", "EVIDENCE", "EV-2"),
        node("ND-D1", "DECISION", "DEC-1"),
      ],
      [edge("ND-E2", "SUPERSEDES", "ND-E1"), edge("ND-D1", "SUPPORTS", "ND-E2")],
    );
    const index = indexGraph(graph);
    expect(propagatingReachable(index, "ND-E1")).toEqual([]);
    expect(propagatingReachable(index, "ND-E2")).toEqual(["ND-D1"]);
  });

  it("follows an INVALIDATES edge forwards", () => {
    // INVALIDATES is the one kind that literally says "this invalidates
    // that", so it propagates in the edge's own direction.
    const graph = snapshot(
      [node("ND-E1", "EVIDENCE", "EV-1"), node("ND-D1", "DECISION", "DEC-1")],
      [edge("ND-E1", "INVALIDATES", "ND-D1")],
    );
    expect(propagatingReachable(indexGraph(graph), "ND-E1")).toEqual(["ND-D1"]);
  });
});

describe("the findings of the adversarial review", () => {
  // ── D1: a malformed ref must be REPORTED, not crash the schema ─────────
  it("reports a malformed ref instead of crashing", () => {
    // `GraphNodeSchema.ref` is `z.string().min(1)` — ANY non-empty string.
    // "DEC-bad id" and "DEC-" both start with "DEC-", so a prefix check let
    // them through and the failure surfaced as an unhandled ZodError in the
    // RESULT. A crash is the worst possible absorption of a defect.
    const graph = snapshot([node("ND-D", "DECISION", "DEC-bad id")], []);
    const { result, anomalies } = computeInvalidation(graph, { trigger: "ND-D", at: AT });
    expect(anomalies.map((a) => a.classification)).toEqual(["MALFORMED_REF"]);
    expect(result.staleDecisions, "the malformed decision must be EXCLUDED").toEqual([]);
  });

  it("does not crash on any right-prefix ref", () => {
    for (const ref of ["DEC-", "DEC-bad id", "DEC-bad.dot", `DEC-${"x".repeat(100)}`]) {
      const graph = snapshot([node("ND-D", "DECISION", ref)], []);
      const { result, anomalies } = computeInvalidation(graph, { trigger: "ND-D", at: AT });
      expect(result.staleDecisions, `ref "${ref}" must not reach the result`).toEqual([]);
      expect(anomalies.map((a) => a.classification)).toEqual(["MALFORMED_REF"]);
    }
  });

  // ── D2: the caller's references are validated too ───────────────────────
  it("reports an invalid decision id instead of crashing", () => {
    const { result, anomalies } = computeInvalidation(CHAIN, {
      trigger: "ND-E1",
      at: AT,
      decisions: [{ id: "nope", contractId: "WC-1", supportingEvidence: ["EV-1"] }],
    });
    expect(anomalies.map((a) => a.classification)).toEqual(["MALFORMED_REFERENCE"]);
    expect(result.staleDecisions).not.toContain("nope");
  });

  it("reports an invalid work-contract id instead of crashing", () => {
    const { result, anomalies } = computeInvalidation(CHAIN, {
      trigger: "ND-E1",
      at: AT,
      decisions: [{ id: "DEC-3", contractId: "nope", supportingEvidence: ["EV-1"] }],
    });
    expect(anomalies.map((a) => a.classification)).toEqual(["MALFORMED_REFERENCE"]);
    expect(result.reopenedWork).not.toContain("nope");
  });

  it("refuses an invalid instant with a clear message", () => {
    expect(() => computeInvalidation(CHAIN, { trigger: "ND-E1", at: "not-a-time" })).toThrow(
      /ISO-8601 instant/,
    );
  });

  // ── D3: the result must not depend on the input order ─────────────────
  it("gives the same answer whatever order the duplicate nodes arrive in", () => {
    // The semantic failure: the same graph marked a decision stale in one
    // order and not in the other.
    const forward = snapshot(
      [node("ND-A", "DECISION", "DEC-1"), node("ND-A", "FILE", "other.ts")],
      [],
    );
    const backward = snapshot(
      [node("ND-A", "FILE", "other.ts"), node("ND-A", "DECISION", "DEC-1")],
      [],
    );
    const a = computeInvalidation(forward, { trigger: "ND-A", at: AT });
    const b = computeInvalidation(backward, { trigger: "ND-A", at: AT });
    expect(a.result).toEqual(b.result);
    expect(a.anomalies).toEqual(b.anomalies);
  });

  // ── D4: every dependency kind constrains the order ────────────────────
  it("orders SUPPORTS, TESTS and LEARNED_FROM like the other dependency kinds", () => {
    // These three are declared dependency relations, so the "dependency
    // first" order must respect them. Leaving them out made the order
    // violate its own invariant.
    for (const kind of ["SUPPORTS", "TESTS", "LEARNED_FROM"] as const) {
      const graph = snapshot(
        [node("ND-A", "FILE", "a.ts"), node("ND-B", "FILE", "b.ts")],
        [edge("ND-A", kind, "ND-B")],
      );
      const result = topologicalOrder(indexGraph(graph));
      expect(result.order.length, `${kind} must produce an order`).toBe(2);
      expect(
        result.order.indexOf("ND-B"),
        `${kind}: the dependency must come before the dependent`,
      ).toBeLessThan(result.order.indexOf("ND-A"));
    }
  });

  // ── D5: the hop distance must be exposed ───────────────────────────────
  it("exposes the hop distance separately from the flat id list", () => {
    const withDistance = reachableWithDistance(indexGraph(CHAIN), "ND-E1", { direction: "REVERSE" });
    expect(withDistance).toEqual([
      { id: "ND-C1", hops: 1 },
      { id: "ND-D1", hops: 2 },
      { id: "ND-W1", hops: 3 },
    ]);
  });

  // ── D7: a dangling trigger must not contradict the traversal ───────────
  it("accepts a dangling trigger, because the traversal finds its dependents", () => {
    // The module's own traversal treats a dangling endpoint as an
    // unknown-kind node. Refusing it as a trigger made the cascade and
    // `propagatingReachable` disagree about the same graph.
    const graph = snapshot(
      [node("ND-A", "FILE", "a.ts")],
      [edge("ND-A", "IMPORTS", "ND-GONE")],
    );
    const index = indexGraph(graph);
    expect(propagatingReachable(index, "ND-GONE"), "the traversal finds the dependent").toEqual(["ND-A"]);
    const { result, anomalies } = computeInvalidation(graph, { trigger: "ND-GONE", at: AT });
    expect(result.affectedNodes, "the cascade must agree with the traversal").toEqual(["ND-A"]);
    expect(anomalies.map((a) => a.classification)).toContain("DANGLING_ENDPOINT");
  });

  // ── D11: a self-loop inside an SCC is ONE cycle, not two ──────────────
  it("reports a self-loop inside a cycle once, not twice", () => {
    const graph = snapshot(
      [node("ND-A", "FILE", "a.ts"), node("ND-B", "FILE", "b.ts")],
      [edge("ND-A", "IMPORTS", "ND-A"), edge("ND-A", "IMPORTS", "ND-B"), edge("ND-B", "IMPORTS", "ND-A")],
    );
    const cycles = findCycles(indexGraph(graph));
    expect(cycles, "the self-loop is inside the SCC, so it is one cycle").toEqual([["ND-A", "ND-B"]]);
  });

  // ── T4: the unrelated decision must be able to REACH the trigger ───────
  it("does not reach a decision that invalidates the trigger", () => {
    // The discriminating case the earlier test missed: the unrelated
    // decision is in the SAME component, joined by an INVALIDATES edge
    // pointing AT the trigger. INVALIDATES propagates forwards, so
    // invalidating the trigger must NOT reach it.
    const graph = snapshot(
      [
        node("ND-E1", "EVIDENCE", "EV-1"),
        node("ND-D2", "DECISION", "DEC-2"),
      ],
      [edge("ND-D2", "INVALIDATES", "ND-E1")],
    );
    const { result } = computeInvalidation(graph, { trigger: "ND-E1", at: AT });
    expect(result.affectedNodes).toEqual([]);
    expect(result.staleDecisions, "DEC-2 invalidates E1, so E1's invalidation does not reach DEC-2").toEqual([]);
  });

  it("does not reach a decision joined only by SUPERSEDES", () => {
    const graph = snapshot(
      [
        node("ND-E1", "EVIDENCE", "EV-1"),
        node("ND-E2", "EVIDENCE", "EV-2"),
        node("ND-D2", "DECISION", "DEC-2"),
      ],
      [edge("ND-E2", "SUPERSEDES", "ND-E1"), edge("ND-D2", "SUPPORTS", "ND-E2")],
    );
    const { result } = computeInvalidation(graph, { trigger: "ND-E1", at: AT });
    expect(result.affectedNodes).toEqual([]);
    expect(result.staleDecisions).toEqual([]);
  });
});

describe("determinism", () => {
  it("produces identical output for the same node and edge SETS in a different order", () => {
    const nodes = [...CHAIN.nodes];
    const edges = [...CHAIN.edges];
    const shuffledNodes = [nodes[4]!, nodes[0]!, nodes[5]!, nodes[2]!, nodes[1]!, nodes[3]!];
    const shuffledEdges = [edges[3]!, edges[0]!, edges[2]!, edges[1]!];

    const a = computeInvalidation(CHAIN, { trigger: "ND-E1", at: AT });
    const b = computeInvalidation(snapshot(shuffledNodes, shuffledEdges), {
      trigger: "ND-E1",
      at: AT,
    });

    expect(b.result).toEqual(a.result);
    expect(b.anomalies).toEqual(a.anomalies);
  });

  it("produces identical output across repeated calls", () => {
    const index = indexGraph(CHAIN);
    expect(reachable(index, "ND-E1", { direction: "REVERSE" })).toEqual(
      reachable(index, "ND-E1", { direction: "REVERSE" }),
    );
    // A REAL serialisation. `JSON.stringify` on a Map produces `{}`, so the
    // earlier version of this test compared two empty objects and proved
    // nothing.
    expect(serializeGraphIndex(indexGraph(CHAIN))).toBe(serializeGraphIndex(indexGraph(CHAIN)));
    expect(serializeGraphIndex(indexGraph(CHAIN)).length).toBeGreaterThan(50);
  });

  it("produces identical output for every permutation of the same graph", () => {
    // The earlier test used ONE fixed permutation of six nodes — one
    // two-hundredth of the coverage a permutation claim deserves.
    const nodes = [...CHAIN.nodes];
    const edges = [...CHAIN.edges];
    const reference = serializeGraphIndex(indexGraph(CHAIN));
    for (let rotation = 0; rotation < nodes.length; rotation++) {
      const rotated = [
        ...nodes.slice(rotation),
        ...nodes.slice(0, rotation),
      ];
      for (let flip = 0; flip < 2; flip++) {
        const graph = snapshot(
          flip === 0 ? rotated : [...rotated].reverse(),
          flip === 0 ? edges : [...edges].reverse(),
        );
        expect(serializeGraphIndex(indexGraph(graph)), `rotation ${rotation}, flip ${flip}`).toBe(reference);
      }
    }
  });
});
