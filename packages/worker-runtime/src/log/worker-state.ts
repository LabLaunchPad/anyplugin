/**
 * Worker state, folded from the event log.
 *
 * State is derived, never authoritative. The log is the record of what
 * happened; this is a projection of it, and deleting the projection must
 * always be safe because it can be rebuilt (invariant I6). Nothing here may
 * hold a fact that is not reconstructible from events alone — the moment it
 * does, there are two sources of truth and they will disagree.
 *
 * The phase machine is NOT reimplemented here. `LEGAL_TRANSITIONS` and
 * `isLegalTransition` already exist in the frozen contracts and are already
 * tested; a second copy would be a second answer to the same question.
 */
import { canonicalJson, contentHash } from "../canonical.js";
import {
  WorkerStateSchema,
  isLegalTransition,
  type WorkerEvent,
  type WorkerPhase,
  type WorkerState,
} from "../contracts/index.js";
import type { ReplayReport } from "./replay.js";

/** A transition the log asked for that the phase machine forbids. */
export interface RejectedTransition {
  readonly sequence: number;
  readonly from: WorkerPhase;
  readonly to: string;
  readonly reason: string;
}

export interface FoldResult {
  /** One state per work contract, keyed by contract id. */
  readonly states: Map<string, WorkerState>;
  /** Transitions refused by the phase machine. Never silently applied. */
  readonly rejected: RejectedTransition[];
  /** Events whose kind this fold does not interpret. Not an error. */
  readonly ignored: number;
}

const INITIAL_PHASE: WorkerPhase = "NEW";

/**
 * Fold `STATE_TRANSITION` events into worker states.
 *
 * An illegal transition is **rejected and recorded**, never coerced. Coercing
 * would let a log that says something impossible produce a state that looks
 * possible, which is exactly the class of silent divergence replay exists to
 * make visible.
 */
export function foldWorkerState(events: readonly WorkerEvent[]): FoldResult {
  const states = new Map<string, WorkerState>();
  const rejected: RejectedTransition[] = [];
  let ignored = 0;

  for (const event of events) {
    if (event.kind !== "STATE_TRANSITION") {
      ignored += 1;
      continue;
    }
    const contractId = event.subject;
    const to = event.payload["to"];
    const current = states.get(contractId);
    const from = current?.phase ?? INITIAL_PHASE;

    if (typeof to !== "string" || !isPhase(to)) {
      rejected.push({ sequence: event.sequence, from, to: String(to), reason: "payload.to is not a worker phase" });
      continue;
    }
    if (!isLegalTransition(from, to)) {
      rejected.push({ sequence: event.sequence, from, to, reason: `illegal transition ${from} -> ${to}` });
      continue;
    }

    states.set(
      contractId,
      WorkerStateSchema.parse({
        id: current?.id ?? deriveStateId(contractId),
        contractVersion: event.contractVersion,
        contractId,
        phase: to,
        assumptions: current?.assumptions ?? [],
        // Counts applied transitions, so revision matches what actually
        // happened rather than how many were attempted.
        revision: (current?.revision ?? -1) + 1,
        updatedAt: event.at,
      }),
    );
  }

  return { states, rejected, ignored };
}

/** Fold straight from a replay report. */
export function foldFromReplay(report: ReplayReport): FoldResult {
  return foldWorkerState(report.events);
}

/**
 * Canonical hash of the folded state.
 *
 * This is what "replay reconstructs byte-identical state" is asserted against.
 * Map iteration order follows insertion, which depends on the order contracts
 * first appear, so entries are sorted before hashing — otherwise two replays of
 * one log could differ for a reason that has nothing to do with the events.
 */
export function stateHash(result: FoldResult): string {
  return contentHash({
    states: [...result.states.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s),
    rejected: result.rejected,
  });
}

/** Canonical JSON of the folded state, for diffing a divergence. */
export function stateJson(result: FoldResult): string {
  return canonicalJson([...result.states.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, s]) => s));
}

const PHASES = new Set<string>([
  "NEW",
  "PLANNING",
  "EXECUTING",
  "WAITING",
  "VERIFYING",
  "BLOCKED",
  "COMPLETED",
  "FAILED",
  "REOPENED",
]);

function isPhase(value: string): value is WorkerPhase {
  return PHASES.has(value);
}

/**
 * Derive a state id from its contract id.
 *
 * Deterministic on purpose: a random id would make two replays of one log
 * produce two different state hashes, which would defeat the determinism check.
 */
function deriveStateId(contractId: string): string {
  return `WS-${contractId.replace(/^WC-/, "")}`;
}
