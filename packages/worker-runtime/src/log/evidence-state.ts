/**
 * Current Evidence state, folded from the evidence log.
 *
 * Mirrors `worker-state.ts`'s split exactly: the log is the record of what
 * happened, this is a derived projection of it, and nothing here may hold a
 * fact that is not reconstructible from the log alone. A `BASE` entry
 * establishes a record at `VALID`; a `TRANSITION` entry updates the
 * projection, never the entry that came before it.
 *
 * Evidence has no `LEGAL_TRANSITIONS` table of its own (unlike `WorkerPhase`),
 * so the legality rule is small and stated here, once: `VALID -> INVALIDATED`
 * and `VALID -> SUPERSEDED` are legal; anything else — a transition for an id
 * with no `BASE` entry, or a second transition on a record that already left
 * `VALID` — is rejected and recorded, never coerced. A record cannot be
 * un-invalidated by a later transition; supersession and invalidation are
 * both terminal, which is what makes "current validity" well-defined at all.
 */
import { EvidenceSchema, type Evidence } from "../contracts/index.js";
import type { EvidenceEntry } from "./evidence-log.js";
import type { EvidenceReplayReport } from "./evidence-replay.js";

/** A transition the log asked for that the lifecycle rule above forbids. */
export interface RejectedEvidenceTransition {
  readonly entrySequence: number;
  readonly id: string;
  readonly to: "INVALIDATED" | "SUPERSEDED";
  readonly reason: string;
}

export interface EvidenceFoldResult {
  /** Current view, one Evidence per id, reflecting every legal transition applied. */
  readonly current: Map<string, Evidence>;
  readonly rejected: RejectedEvidenceTransition[];
  /** BASE ids seen more than once — appendBase already refuses this in-process, but replay must not trust a foreign writer. */
  readonly duplicateBase: string[];
}

export function foldEvidenceState(entries: readonly EvidenceEntry[]): EvidenceFoldResult {
  const current = new Map<string, Evidence>();
  const rejected: RejectedEvidenceTransition[] = [];
  const duplicateBase: string[] = [];

  for (const e of entries) {
    if (e.entry.kind === "BASE") {
      const record = e.entry.record;
      if (current.has(record.id)) {
        duplicateBase.push(record.id);
        continue; // first BASE wins; a second is damage, not a valid update
      }
      current.set(record.id, record);
      continue;
    }

    // TRANSITION
    const { id, to } = e.entry;
    const existing = current.get(id);
    if (!existing) {
      rejected.push({ entrySequence: e.entrySequence, id, to, reason: `no BASE entry for ${id}` });
      continue;
    }
    if (existing.validity !== "VALID") {
      rejected.push({
        entrySequence: e.entrySequence,
        id,
        to,
        reason: `${id} is already ${existing.validity}; supersession and invalidation are terminal`,
      });
      continue;
    }

    const updated: Evidence =
      to === "INVALIDATED"
        ? { ...existing, validity: "INVALIDATED", invalidationReason: e.entry.reason }
        : { ...existing, validity: "SUPERSEDED", supersededBy: e.entry.supersededBy };

    // Re-validated against the frozen schema rather than trusted: a fold must
    // never manufacture a record the contract itself would reject.
    current.set(id, EvidenceSchema.parse(updated));
  }

  return { current, rejected, duplicateBase };
}

export function foldEvidenceFromReplay(report: EvidenceReplayReport): EvidenceFoldResult {
  return foldEvidenceState(report.entries);
}
