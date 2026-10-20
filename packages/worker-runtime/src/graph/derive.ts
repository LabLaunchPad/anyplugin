/**
 * The graph derivation: the log's own contents, projected into a graph.
 *
 * ── Why this is the capstone ───────────────────────────────────────────────
 *
 * Every other engine in this kernel is a **projection of the log**: the
 * worker state, the decision ledger, the evidence ledger, the experience
 * ledger. The graph was the odd one out — its contracts existed, its engine
 * existed, but nothing ever *produced* a snapshot, so every graph in the
 * repository was hand-made.
 *
 * This closes the loop. `deriveGraph(events)` is a **pure function of the
 * log's bytes**: the same log always yields the same snapshot, and the
 * snapshot is a projection, never an authority. That is the kernel's
 * invariant I6 applied to one more thing.
 *
 * ── What it can and cannot derive ──────────────────────────────────────────
 *
 * From the log alone, the derivable graph is the **knowledge** graph:
 *
 * | node | from |
 * |---|---|
 * | `EVIDENCE` | an `EVIDENCE_ADDED` event |
 * | `DECISION` | a `DECISION_RECORDED` event |
 * | `EXPERIENCE` | an `EXPERIENCE_RECORDED` event |
 * | `WORK_ITEM` | a work contract that has a `STATE_TRANSITION` event |
 *
 * and the edges that follow from what those records *say*:
 *
 * | edge | meaning |
 * |---|---|
 * | `DECISION → EVIDENCE` (`SUPPORTS`) | the decision rests on that evidence |
 * | `EXPERIENCE → EVIDENCE` (`LEARNED_FROM`) | the lesson was learned from it |
 * | `WORK_ITEM → DECISION` (`DEPENDS_ON`) | the work was decided by it |
 *
 * The `FILE`, `SYMBOL`, `TEST` and `CONFIG` nodes are **not** derivable from
 * the log: they come from the source tree, which is the AST kernel's job
 * (modules 2.6 and 2.7). And `CLAIM` has no record type and no event, so it
 * cannot be derived either — the claim node in a hand-made graph is a
 * human's assertion, and the log does not record assertions.
 *
 * **So the derivation is partial by construction, and it says so.** A
 * derivation that invented a claim node, or a file node, would be inventing
 * facts — and *"the kernel records and verifies; it never infers"* is the
 * rule that keeps the whole thing honest.
 */
import {
  CONTRACT_VERSION,
  GraphSnapshotSchema,
  type GraphSnapshot,
  type WorkerEvent,
} from "../contracts/index.js";
import { contentHash } from "../canonical.js";

/** The node kinds the log can derive. */
export type DerivedNodeKind = "EVIDENCE" | "DECISION" | "EXPERIENCE" | "WORK_ITEM";

/** A node derived from the log, with the event it came from. */
interface DerivedNode {
  readonly id: string;
  readonly kind: DerivedNodeKind;
  readonly ref: string;
}

/**
 * A deterministic node id.
 *
 * The id is derived from the KIND and the RECORD id, so the same record
 * always yields the same node — and two records of different kinds can
 * never collide. The record id is kept in the node's `ref`, which is the
 * convention the invalidation cascade already uses.
 */
function nodeId(kind: DerivedNodeKind, recordId: string): string {
  // The record id is NOT stripped of its prefix. Stripping it would make
  // `EV-1` and `EX-1` both derive the node `ND-EVIDENCE-1` — a silent
  // collision between two different records, in a graph whose whole purpose
  // is to say which record is which.
  return `ND-${kind}-${recordId}`;
}

/**
 * Derive a graph snapshot from the log.
 *
 * **Pure**: no clock, no I/O, no randomness. The snapshot's `at` is the
 * instant of the LAST event — derived from the log, not read from a clock,
 * so the same log always yields byte-identical output.
 *
 * The result is sorted (nodes by id, edges by `from`, `kind`, `to`), so two
 * logs with the same records in different orders produce the same snapshot.
 */
export function deriveGraph(events: readonly WorkerEvent[]): GraphSnapshot {
  const nodes = new Map<string, DerivedNode>();
  const edges = new Map<string, { from: string; kind: string; to: string }>();
  /** The decisions, so their supporting evidence can become edges. */
  const decisionSupport = new Map<string, string[]>();
  /** The experiences, and the evidence they were learned from. */
  const experienceSupport = new Map<string, string[]>();
  /** The work contracts, so a decision can be attached to the work. */
  const workContracts = new Set<string>();
  /** The decisions, and the work contract each belongs to. */
  const decisionContract = new Map<string, string>();
  let lastAt: string | undefined;

  for (const event of events) {
    if (event.at > (lastAt ?? "")) lastAt = event.at;

    switch (event.kind) {
      case "EVIDENCE_ADDED": {
        const record = event.payload["evidence"] as { id?: unknown } | undefined;
        if (typeof record?.id !== "string") break;
        nodes.set(nodeId("EVIDENCE", record.id), {
          id: nodeId("EVIDENCE", record.id),
          kind: "EVIDENCE",
          ref: record.id,
        });
        break;
      }
      case "DECISION_RECORDED": {
        const record = event.payload["decision"] as
          | { id?: unknown; contractId?: unknown; supportingEvidence?: unknown }
          | undefined;
        if (typeof record?.id !== "string") break;
        const id = nodeId("DECISION", record.id);
        nodes.set(id, { id, kind: "DECISION", ref: record.id });
        if (Array.isArray(record.supportingEvidence)) {
          decisionSupport.set(
            record.id,
            record.supportingEvidence.filter((e): e is string => typeof e === "string"),
          );
        }
        if (typeof record.contractId === "string") decisionContract.set(record.id, record.contractId);
        break;
      }
      case "EXPERIENCE_RECORDED": {
        const record = event.payload["experience"] as { id?: unknown; evidence?: unknown } | undefined;
        if (typeof record?.id !== "string") break;
        const id = nodeId("EXPERIENCE", record.id);
        nodes.set(id, { id, kind: "EXPERIENCE", ref: record.id });
        if (Array.isArray(record.evidence)) {
          experienceSupport.set(
            record.id,
            record.evidence.filter((e): e is string => typeof e === "string"),
          );
        }
        break;
      }
      case "STATE_TRANSITION": {
        // A work contract is a work item once it has a phase.
        workContracts.add(event.subject);
        break;
      }
      default:
        break;
    }
  }

  // The work-item nodes.
  for (const contractId of workContracts) {
    const id = nodeId("WORK_ITEM", contractId);
    nodes.set(id, { id, kind: "WORK_ITEM", ref: contractId });
  }

  // The edges.
  const addEdge = (from: string, kind: string, to: string): void => {
    const key = `${from}\u0000${kind}\u0000${to}`;
    if (!edges.has(key)) edges.set(key, { from, kind, to });
  };

  for (const [decisionId, evidenceIds] of decisionSupport) {
    const from = nodeId("DECISION", decisionId);
    for (const evidenceId of evidenceIds) {
      const to = nodeId("EVIDENCE", evidenceId);
      // Only an edge between nodes that EXIST is an edge. A decision that
      // cites evidence the log never recorded cites nothing, and the
      // derivation does not invent the missing node.
      if (nodes.has(from) && nodes.has(to)) addEdge(from, "SUPPORTS", to);
    }
  }

  for (const [experienceId, evidenceIds] of experienceSupport) {
    const from = nodeId("EXPERIENCE", experienceId);
    for (const evidenceId of evidenceIds) {
      const to = nodeId("EVIDENCE", evidenceId);
      if (nodes.has(from) && nodes.has(to)) addEdge(from, "LEARNED_FROM", to);
    }
  }

  for (const [decisionId, contractId] of decisionContract) {
    const from = nodeId("WORK_ITEM", contractId);
    const to = nodeId("DECISION", decisionId);
    if (nodes.has(from) && nodes.has(to)) addEdge(from, "DEPENDS_ON", to);
  }

  return GraphSnapshotSchema.parse({
    contractVersion: CONTRACT_VERSION,
    // The instant of the LAST event, so the snapshot is a function of the log
    // alone. An empty log has no instant, and the schema requires one — so
    // the epoch is used, and it says so by being the only value possible.
    at: lastAt ?? "1970-01-01T00:00:00Z",
    nodes: [...nodes.values()]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((n) => ({ id: n.id, kind: n.kind, ref: n.ref })),
    edges: [...edges.values()]
      .sort((a, b) => {
        if (a.from !== b.from) return a.from < b.from ? -1 : 1;
        if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
        return a.to < b.to ? -1 : a.to > b.to ? 1 : 0;
      })
      .map((e) => ({ from: e.from, kind: e.kind as "SUPPORTS" | "LEARNED_FROM" | "DEPENDS_ON", to: e.to })),
  });
}

/**
 * The content hash of a derived snapshot.
 *
 * The snapshot is hashable so a Certificate (M10) can bind the graph it
 * reasoned over — and so two derivations can be compared without comparing
 * their bytes.
 */
export function graphHash(snapshot: GraphSnapshot): string {
  return contentHash(snapshot);
}
