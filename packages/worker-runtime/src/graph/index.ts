/**
 * The graph traversal engine.
 *
 * A pure function over an existing contract: no version bump, no schema
 * regeneration, no certificate invalidation, no new dependency.
 */
export {
  EDGE_SEMANTICS,
  PROPAGATING_KINDS,
  components,
  findCycles,
  indexGraph,
  propagatingReachable,
  reachable,
  reachableWithDistance,
  serializeGraphIndex,
  topologicalOrder,
  type EdgeDirection,
  type GraphAnomaly,
  type GraphAnomalyClassification,
  type GraphEdge,
  type GraphEdgeKind,
  type GraphIndex,
  type GraphNode,
  type GraphNodeKind,
  type ReachableNode,
  type TopologicalOrder,
  type TraverseOptions,
} from "./traverse.js";

export {
  NODE_REF_PREFIX,
  computeInvalidation,
  type DecisionSummary,
  type EvidenceSummary,
  type InvalidationComputation,
  type InvalidationInput,
  type VerificationSummary,
} from "./invalidation.js";
