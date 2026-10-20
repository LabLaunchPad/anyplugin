/**
 * The Evidence Ledger (M3).
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * `EvidenceSchema` is a frozen contract, and until now nothing produced one
 * or consumed one. This is the projection: the evidence records the log
 * holds, with their **current** validity.
 *
 * ── The property that makes it a ledger and not a log ─────────────────────
 *
 * **The history is preserved.** A record is immutable. Invalidation does not
 * rewrite it — it appends an event, and the *projection* flips. So:
 *
 * - the evidence's `contentHash`, `source` and `authority` never change;
 * - only `validity` changes; and
 * - the event that changed it is still in the log, so the change is
 *   explainable.
 *
 * That is the distinction the `ValiditySchema` makes: `SUPERSEDED` means *"a
 * newer record replaces this — it may still have been true when it was
 * written"*, and `INVALIDATED` means *"it should no longer be relied on at
 * all"*. A ledger that conflated the two would be able to say that a fact
 * was never true, which is a different claim from "it is no longer
 * trustworthy".
 *
 * ── Why the flip is a projection and not an edit ──────────────────────────
 *
 * The kernel's own rule: *"Records are immutable. Invalidation and
 * supersession append new events; history is never mutated in place."* And
 * the reason is not tidiness — a Certificate (M10) binds a record by
 * content hash, so a record that changed under a certificate would make
 * every certificate over it unverifiable.
 */
import { EvidenceSchema, type Evidence, type Validity } from "../contracts/index.js";

/** The evidence, as the log projects it. */
export interface EvidenceProjection {
  readonly id: string;
  readonly kind: Evidence["kind"];
  readonly source: string;
  readonly contentHash: string;
  readonly authority: Evidence["authority"];
  /** The CURRENT answer. Never a rewrite of history. */
  readonly validity: Validity;
  /** Set iff the record was superseded — the newer record that replaced it. */
  readonly supersededBy?: string;
  /** Set iff the record was invalidated — why it stopped being trustworthy. */
  readonly invalidationReason?: string;
}

export interface EvidenceFoldResult {
  /** One projection per evidence record, keyed by id. */
  readonly evidence: Map<string, EvidenceProjection>;
  /** Events whose kind this fold does not interpret. Not an error. */
  readonly ignored: number;
  /**
   * The records whose payload could not be read.
   *
   * Recorded, never coerced: a malformed record is a broken writer, and
   * pretending it said something else would make the log unreadable in a
   * way nothing could detect.
   */
  readonly rejected: readonly string[];
}

/** Fold the evidence events into evidence projections. */
export function foldEvidence(events: readonly import("../contracts/index.js").WorkerEvent[]): EvidenceFoldResult {
  const evidence = new Map<string, EvidenceProjection>();
  const rejected: string[] = [];
  let ignored = 0;

  for (const event of events) {
    if (event.kind === "EVIDENCE_ADDED") {
      const parsed = EvidenceSchema.safeParse(event.payload["evidence"]);
      if (!parsed.success) {
        rejected.push(event.subject);
        continue;
      }
      const record: Evidence = parsed.data;
      evidence.set(record.id, {
        id: record.id,
        kind: record.kind,
        source: record.source,
        contentHash: record.contentHash,
        authority: record.authority,
        validity: record.validity,
        ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
        ...(record.invalidationReason ? { invalidationReason: record.invalidationReason } : {}),
      });
      continue;
    }

    if (event.kind === "EVIDENCE_INVALIDATED") {
      const current = evidence.get(event.subject);
      if (!current) {
        // An invalidation for a record the log never held. Recorded, not
        // invented: the fold does not conjure the record it cannot see.
        rejected.push(event.subject);
        continue;
      }
      const reason = event.payload["reason"];
      evidence.set(event.subject, {
        ...current,
        validity: "INVALIDATED",
        invalidationReason: typeof reason === "string" && reason !== "" ? reason : "invalidated",
      });
      continue;
    }

    if (event.kind === "EVIDENCE_SUPERSEDED") {
      const current = evidence.get(event.subject);
      if (!current) {
        rejected.push(event.subject);
        continue;
      }
      const by = event.payload["supersededBy"];
      evidence.set(event.subject, {
        ...current,
        validity: "SUPERSEDED",
        ...(typeof by === "string" && by !== "" ? { supersededBy: by } : {}),
      });
      continue;
    }

    ignored += 1;
  }

  return { evidence, ignored, rejected };
}

/**
 * The evidence that may be relied on right now.
 *
 * A record is usable when it is `VALID`. `INVALIDATED` means it should not
 * be relied on at all; `SUPERSEDED` means it was replaced, and the
 * replacement — not this one — is the current answer.
 *
 * This is the function the verification engine consults, and it is why
 * invalidating evidence **forces re-verification**: the evidence that
 * backed the claim is no longer usable, so the claim cannot be checked.
 */
export function usableEvidence(
  evidence: ReadonlyMap<string, EvidenceProjection>,
): Map<string, EvidenceProjection> {
  const out = new Map<string, EvidenceProjection>();
  for (const [id, record] of evidence) {
    if (record.validity === "VALID") out.set(id, record);
  }
  return out;
}

/** The evidence that is currently invalidated, by id. */
export function invalidatedEvidence(
  evidence: ReadonlyMap<string, EvidenceProjection>,
): Set<string> {
  const out = new Set<string>();
  for (const [id, record] of evidence) {
    if (record.validity === "INVALIDATED") out.add(id);
  }
  return out;
}
