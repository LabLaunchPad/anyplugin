/**
 * Deterministic replay.
 *
 * Replay is the only way governed state comes into existence. That makes its
 * failure modes more important than its success path: a replay that quietly
 * skips a damaged region produces a state that looks complete and is not, and
 * nothing downstream can tell.
 *
 * So every byte of the log is accounted for as COMMITTED, INCOMPLETE, or
 * REJECTED (`EVENT_WRITE_CONTRACT v1`, G2), and `bytesAccounted` must equal
 * `bytesTotal`. Anomalies are values in the result, never thrown: an exception
 * would abort recovery at the first damaged frame and discard everything after
 * it, which is the opposite of recovery.
 *
 * ── Gaps and duplicates are different failures ─────────────────────────────
 *
 * The frozen contract says: *"gaps mean loss, duplicates mean a broken
 * writer."* Those demand different responses — a gap means events are missing
 * and state is incomplete; a duplicate means the writer itself is wrong and
 * more damage is likely coming. Collapsing them into one "sequence error"
 * would send recovery down the wrong path, so they are reported separately.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EventSchema, type WorkerEvent } from "../contracts/index.js";
import { canonicalJson } from "../canonical.js";
import { LOG_FILENAME } from "./event-log.js";
import { recordHash } from "./write-contract.js";
import type { Anomaly } from "./write-contract.js";

/** Anomaly reasons replay can produce, enumerated so tests can assert the cause. */
export const REPLAY_ANOMALIES = {
  TRUNCATED: "record truncated before terminator",
  FRAME_HEADER: "frame header incomplete",
  SHORT: "record shorter than its declared length",
  LONG: "record longer than its declared length",
  UNPARSEABLE: "unparseable body at declared length",
  HASH_MISMATCH: "content hash mismatch",
  SCHEMA: "event does not satisfy EventSchema",
  DUPLICATE_SEQUENCE: "duplicate sequence — broken writer",
} as const;

export interface ReplayReport {
  readonly events: WorkerEvent[];
  readonly anomalies: Anomaly[];
  /** Sequences absent from an otherwise-ordered log. Loss, not writer error. */
  readonly gaps: number[];
  readonly bytesAccounted: number;
  readonly bytesTotal: number;
}

/** True iff replay found nothing wrong: no anomaly, no gap, all bytes accounted. */
export function isClean(report: ReplayReport): boolean {
  return report.anomalies.length === 0 && report.gaps.length === 0 && report.bytesAccounted === report.bytesTotal;
}

export function replay(dir: string): ReplayReport {
  const raw = readOrEmpty(join(dir, LOG_FILENAME));
  const events: WorkerEvent[] = [];
  const anomalies: Anomaly[] = [];
  const seen = new Set<number>();
  let bytesAccounted = 0;

  const parts = raw.length === 0 ? [] : raw.split("\n");
  const unterminated = parts.length > 0 ? (parts.pop() ?? "") : "";

  for (const line of parts) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    bytesAccounted += size;
    const outcome = decodeEvent(line, size);
    if ("anomaly" in outcome) {
      anomalies.push(outcome.anomaly);
      continue;
    }
    const event = outcome.event;
    if (seen.has(event.sequence)) {
      // Not merely a repeated record: the writer allocated one number twice.
      anomalies.push({ classification: "REJECTED", reason: `${REPLAY_ANOMALIES.DUPLICATE_SEQUENCE} ${event.sequence}`, bytes: size });
      continue;
    }
    seen.add(event.sequence);
    events.push(event);
  }

  if (unterminated.length > 0) {
    const size = Buffer.byteLength(unterminated, "utf8");
    bytesAccounted += size;
    anomalies.push({ classification: "INCOMPLETE", reason: REPLAY_ANOMALIES.TRUNCATED, bytes: size });
  }

  // Deterministic order regardless of the order bytes happened to arrive in.
  events.sort((a, b) => a.sequence - b.sequence);

  return {
    events,
    anomalies,
    gaps: findGaps(events),
    bytesAccounted,
    bytesTotal: Buffer.byteLength(raw, "utf8"),
  };
}

/**
 * Sequences missing between the lowest and highest recovered.
 *
 * Bounded by what was recovered on purpose. Events after the highest surviving
 * one are indistinguishable from events that were never written, and reporting
 * them as gaps would invent losses that may not have occurred.
 */
function findGaps(events: readonly WorkerEvent[]): number[] {
  if (events.length === 0) return [];
  const gaps: number[] = [];
  for (let expected = events[0]!.sequence; expected < events[events.length - 1]!.sequence; expected += 1) {
    if (!events.some((e) => e.sequence === expected)) gaps.push(expected);
  }
  return gaps;
}

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/**
 * Decode one frame into an event, checking length, then hash, then schema.
 *
 * The order encodes what each failure means. A short frame is INCOMPLETE — a
 * write that did not finish. A full-length frame whose hash disagrees is
 * REJECTED — bytes that were changed. Checking the hash first would report a
 * crash as tampering and send recovery down the wrong path.
 */
function decodeEvent(line: string, size: number): { event: WorkerEvent } | { anomaly: Anomaly } {
  const first = line.indexOf("\t");
  const second = line.indexOf("\t", first + 1);
  if (first < 0 || second < 0) {
    return { anomaly: { classification: "INCOMPLETE", reason: REPLAY_ANOMALIES.FRAME_HEADER, bytes: size } };
  }
  const declaredHash = line.slice(0, first);
  const declaredLength = Number(line.slice(first + 1, second));
  const body = line.slice(second + 1);
  const actualLength = Buffer.byteLength(body, "utf8");

  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    return { anomaly: { classification: "REJECTED", reason: "malformed length field", bytes: size } };
  }
  if (actualLength < declaredLength) {
    return { anomaly: { classification: "INCOMPLETE", reason: REPLAY_ANOMALIES.SHORT, bytes: size } };
  }
  if (actualLength > declaredLength) {
    return { anomaly: { classification: "REJECTED", reason: REPLAY_ANOMALIES.LONG, bytes: size } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { anomaly: { classification: "REJECTED", reason: REPLAY_ANOMALIES.UNPARSEABLE, bytes: size } };
  }

  const result = EventSchema.safeParse(parsed);
  if (!result.success) {
    // A well-formed frame carrying something that is not an Event. Rejected
    // rather than coerced: replay must not invent a valid event from an
    // invalid one.
    return { anomaly: { classification: "REJECTED", reason: REPLAY_ANOMALIES.SCHEMA, bytes: size } };
  }
  const event = result.data;

  if (recordHash({ id: event.id, payload: event }) !== declaredHash) {
    return { anomaly: { classification: "REJECTED", reason: REPLAY_ANOMALIES.HASH_MISMATCH, bytes: size } };
  }
  return { event };
}

/**
 * Canonical digest of a replay report, for asserting determinism.
 *
 * Covers anomalies and gaps as well as events: a replay that recovered the
 * same events but classified damage differently is *not* the same replay, and
 * a digest that ignored that would hide the divergence it exists to catch.
 */
export function replayDigest(report: ReplayReport): string {
  return canonicalJson({
    events: report.events,
    anomalies: report.anomalies,
    gaps: report.gaps,
    bytesAccounted: report.bytesAccounted,
    bytesTotal: report.bytesTotal,
  });
}
