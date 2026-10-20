/**
 * The graph derivation — the log's own contents, projected into a graph.
 *
 * The property that matters: **the same log always yields the same
 * snapshot, byte for byte.** And the snapshot is a *projection* — nothing in
 * it is authoritative, and the log stays the record of what happened.
 */
import { describe, it, expect } from "vitest";
import { CONTRACT_VERSION, type WorkerEvent } from "../contracts/index.js";
import { deriveGraph, graphHash } from "./derive.js";
import { indexGraph, propagatingReachable } from "./index.js";

const AT = "2026-10-20T00:00:00Z";
const ACTOR = "process:test";

let sequence = 0;
function event(kind: WorkerEvent["kind"], subject: string, payload: Record<string, unknown>, at = AT): WorkerEvent {
  sequence += 1;
  return {
    contractVersion: CONTRACT_VERSION,
    at,
    actor: ACTOR,
    kind,
    id: `EVT-${kind}-${sequence}`,
    sequence,
    subject,
    payload,
  };
}

/** A log with evidence, a decision on it, and the work that decision made. */
function aLog(): WorkerEvent[] {
  return [
    event("EVIDENCE_ADDED", "EV-1", {
      evidence: { id: "EV-1", contractVersion: CONTRACT_VERSION, kind: "TEST_RESULT", source: "pnpm test" },
    }),
    event("DECISION_RECORDED", "DEC-1", {
      decision: {
        id: "DEC-1",
        contractVersion: CONTRACT_VERSION,
        contractId: "WC-1",
        selected: "a",
        supportingEvidence: ["EV-1"],
        provenance: { by: ACTOR, at: AT },
        validity: "VALID",
      },
    }),
    event("STATE_TRANSITION", "WC-1", { to: "PLANNING" }),
    event("STATE_TRANSITION", "WC-1", { to: "COMPLETED" }),
  ];
}

describe("the graph derivation", () => {
  it("derives the knowledge graph from the log alone", () => {
    const graph = deriveGraph(aLog());
    expect(graph.nodes.map((n) => `${n.kind}:${n.ref}`)).toEqual([
      "DECISION:DEC-1",
      "EVIDENCE:EV-1",
      "WORK_ITEM:WC-1",
    ]);
    expect(graph.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`)).toEqual([
      "ND-DECISION-DEC-1 -SUPPORTS-> ND-EVIDENCE-EV-1",
      "ND-WORK_ITEM-WC-1 -DEPENDS_ON-> ND-DECISION-DEC-1",
    ]);
  });

  it("is byte-identical for the same log", () => {
    const a = deriveGraph(aLog());
    const b = deriveGraph(aLog());
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    expect(graphHash(b)).toBe(graphHash(a));
  });

  it("does not depend on the ORDER of the events", () => {
    const forward = deriveGraph(aLog());
    const backward = deriveGraph([...aLog()].reverse());
    expect(JSON.stringify(backward)).toBe(JSON.stringify(forward));
  });

  it("derives the instant from the log, not from a clock", () => {
    const log = aLog();
    log.push(event("STATE_TRANSITION", "WC-1", { to: "REOPENED" }, "2026-10-21T00:00:00Z"));
    const graph = deriveGraph(log);
    expect(graph.at, "the snapshot's instant is the last event's").toBe("2026-10-21T00:00:00Z");
  });

  it("does NOT invent a node for evidence the log never recorded", () => {
    // A decision that cites evidence nobody recorded cites nothing. The
    // derivation does not conjure the missing node - inventing one would be
    // inventing a fact, and the kernel records and verifies; it never
    // infers.
    const log = [
      event("DECISION_RECORDED", "DEC-1", {
        decision: {
          id: "DEC-1",
          contractVersion: CONTRACT_VERSION,
          contractId: "WC-1",
          selected: "a",
          supportingEvidence: ["EV-MISSING"],
          provenance: { by: ACTOR, at: AT },
          validity: "VALID",
        },
      }),
    ];
    const graph = deriveGraph(log);
    expect(graph.nodes.map((n) => n.kind)).toEqual(["DECISION"]);
    expect(graph.edges).toEqual([]);
  });

  it("derives an EXPERIENCE node and its LEARNED_FROM edge", () => {
    const log = [
      event("EVIDENCE_ADDED", "EV-1", {
        evidence: { id: "EV-1", contractVersion: CONTRACT_VERSION, kind: "TEST_RESULT", source: "x" },
      }),
      event("EXPERIENCE_RECORDED", "EXP-1", {
        experience: {
          id: "EXP-1",
          contractVersion: CONTRACT_VERSION,
          contractId: "WC-1",
          action: "pnpm test",
          outcome: "FAILURE",
          lesson: "needs a build first",
          rung: "OBSERVATION",
          evidence: ["EV-1"],
          confidence: 0.4,
          provenance: { by: ACTOR, at: AT },
        },
      }),
    ];
    const graph = deriveGraph(log);
    expect(graph.edges.map((e) => `${e.from} -${e.kind}-> ${e.to}`)).toEqual([
      "ND-EXPERIENCE-EXP-1 -LEARNED_FROM-> ND-EVIDENCE-EV-1",
    ]);
  });

  it("feeds the invalidation cascade directly", () => {
    // The whole point: the graph is a projection, so the cascade can walk
    // the graph the log produced - with no hand-made graph in between.
    const graph = deriveGraph(aLog());
    const index = indexGraph(graph);
    expect(index.anomalies, "a derived graph is well-formed").toEqual([]);
    // Invalidating the evidence reaches the decision that rests on it.
    expect(propagatingReachable(index, "ND-EVIDENCE-EV-1")).toEqual([
      "ND-DECISION-DEC-1",
      "ND-WORK_ITEM-WC-1",
    ]);
  });

  it("yields an empty graph for an empty log", () => {
    const graph = deriveGraph([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});
