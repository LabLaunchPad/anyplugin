/**
 * EVENT_WRITE_CONTRACT v1 — what a durable event log must guarantee, stated as
 * observable behaviour rather than as the word "atomic".
 *
 * "Atomic" is the word that hides the bug. It is used to mean at least six
 * different things, and a mechanism can satisfy several while violating the one
 * that mattered. So this contract never uses it as a primitive. The guarantees:
 *
 *   G1 EXACTLY-ONCE RECOVERY   Every event that was committed is recovered
 *                              exactly once by replay.
 *   G2 EXPLICIT CLASSIFICATION Every byte of the log is accounted for by replay
 *                              as COMMITTED, INCOMPLETE, or REJECTED. Nothing is
 *                              silently dropped and nothing is silently accepted.
 *   G3 NO SILENT MUTATION      A committed event cannot become a *different*
 *                              well-formed event through interleaving, partial
 *                              write, or corruption. It may become detectably
 *                              broken; it may not become plausibly wrong.
 *   G4 DETERMINISTIC REPLAY    Replaying the same bytes twice yields an
 *                              identical result, including the order and the
 *                              classification of anomalies.
 *   G5 IDEMPOTENCE             Appending an event whose id was already committed
 *                              does not produce two committed events.
 *
 * G3 is the load-bearing one and the reason plain `appendFile` is not enough.
 * A false positive in corruption detection costs a retry; a false negative
 * means the ledger says something that never happened, which is the failure
 * this entire runtime exists to prevent.
 *
 * ── The six properties that "atomic" conflates ─────────────────────────────
 *
 * These are kept lexically separate throughout the harness because a mechanism
 * routinely provides one and not its neighbour:
 *
 *   WRITE ATOMICITY      A concurrent reader/writer never observes a partial
 *                        record. POSIX gives this for O_APPEND writes only up
 *                        to PIPE_BUF (4096 bytes); Windows offers no equivalent
 *                        guarantee at all. Above that bound it is not promised
 *                        on any platform.
 *   DURABILITY           The bytes survive process death / OS crash / power
 *                        loss. Requires fsync of the file AND its directory.
 *                        A rename gives atomic *visibility*, not durability.
 *   ORDERING             Recovered events appear in a defined, reproducible
 *                        order. Filesystem readdir order is not one.
 *   CONCURRENCY          Multiple writers do not corrupt each other. A lock
 *                        serialises writers but says nothing about crash
 *                        consistency — a writer that dies holding the lock is
 *                        a new problem, not a solved one.
 *   CORRUPTION DETECTION Damage is detectable. A checksum gives this and only
 *                        this: it detects, it does not prevent, and it is not
 *                        atomicity.
 *   RECOVERY             Detected damage is classified into an actionable
 *                        outcome rather than aborting replay.
 *
 * ── What this harness can and cannot prove ─────────────────────────────────
 *
 * Stated up front so no result is over-claimed. See F10 in ENGINEERING_LEDGER.md.
 *
 *   PROVABLE IN CI       concurrent multi-process writers, truncated final
 *                        record, malformed frame, duplicate event, replay
 *                        determinism, byte accounting, ordering.
 *   NOT PROVABLE IN CI   OS crash and power loss. No test here simulates them,
 *                        and no result here may be read as durability evidence.
 *                        Process-kill injection is reliable on Linux and flaky
 *                        on Windows, so it is reported per-platform and is
 *                        never the sole basis for a claim.
 *
 * A property that was not exercised is UNKNOWN. It is never UNSUPPORTED and
 * never PASSED.
 */
import { contentHash } from "../canonical.js";

export const EVENT_WRITE_CONTRACT_VERSION = "1.0.0";

/** The guarantees, addressable by id so results can cite them. */
export const GUARANTEES = {
  G1: "every committed event is recovered exactly once",
  G2: "every byte is classified COMMITTED, INCOMPLETE, or REJECTED",
  G3: "a committed event cannot silently become a different event",
  G4: "replay of identical bytes is identical, anomalies included",
  G5: "re-appending a committed event id does not commit it twice",
} as const;

export type GuaranteeId = keyof typeof GUARANTEES;

/**
 * POSIX bounds O_APPEND write atomicity at PIPE_BUF. Records at or above this
 * size are the interesting case: below it a broken mechanism can look correct.
 */
export const PIPE_BUF = 4096;

/** How replay classified a region of the log. Exhaustive by construction. */
export type Classification = "COMMITTED" | "INCOMPLETE" | "REJECTED";

/** One event as the caller hands it over. `id` is the idempotence key. */
export interface LogRecord {
  readonly id: string;
  readonly payload: unknown;
}

/** A successfully recovered event. */
export interface CommittedEntry {
  readonly id: string;
  readonly payload: unknown;
  /** Content hash of the record as written — the tamper-detection anchor. */
  readonly hash: string;
}

/** A region replay could not commit, with the reason it could not. */
export interface Anomaly {
  readonly classification: "INCOMPLETE" | "REJECTED";
  readonly reason: string;
  /** Bytes this anomaly accounts for, so accounting can be checked. */
  readonly bytes: number;
}

export interface ReplayResult {
  readonly committed: CommittedEntry[];
  readonly anomalies: Anomaly[];
  /** Bytes replay claims to have accounted for across all classifications. */
  readonly bytesAccounted: number;
  /** Bytes actually present on disk. G2 holds iff these two agree. */
  readonly bytesTotal: number;
}

/**
 * A candidate durability mechanism. Deliberately synchronous: the harness needs
 * to interleave real OS-level writes from separate processes, and async
 * scheduling would hide exactly the races being measured.
 */
export interface EventLogWriter {
  readonly id: string;
  /** One line on how it works, quoted directly in the F10 results table. */
  readonly mechanism: string;
  /** Prepare `dir` to receive appends. Must be safe to call repeatedly. */
  init(dir: string): void;
  /** Commit one record. Throws only on a real I/O failure, never on contention. */
  append(dir: string, record: LogRecord): void;
  /** Recover everything, classifying whatever cannot be committed. */
  replay(dir: string): ReplayResult;
}

/**
 * The bytes a record is identified by. Kept separate from framing so that every
 * candidate hashes exactly the same thing and the comparison is about the
 * mechanism rather than about incidental serialization differences.
 */
export function recordHash(record: LogRecord): string {
  return contentHash({ id: record.id, payload: record.payload });
}
