/**
 * Deterministic replay of the evidence log.
 *
 * Mirrors `replay.ts`'s discipline exactly (every byte COMMITTED/INCOMPLETE/
 * REJECTED, gaps and duplicates reported by name, anomalies are values never
 * thrown), applied to `EvidenceEntrySchema` instead of `EventSchema`. Kept as
 * a parallel module rather than a generalized one: `replay.ts` hardcodes
 * `LOG_FILENAME` and an `EventSchema`-specific decoder, and generalizing it
 * would mean modifying Gate 3/4's proven, frozen-in-evidence module to serve a
 * shape it was never measured against — the exact risk `PROVE_REPLAY_DETERMINISM`
 * exists to keep out.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../canonical.js";
import { EVIDENCE_LOG_FILENAME, EvidenceEntrySchema, type EvidenceEntry } from "./evidence-log.js";
import { recordHash } from "./write-contract.js";
import type { Anomaly } from "./write-contract.js";

export const EVIDENCE_REPLAY_ANOMALIES = {
  TRUNCATED: "record truncated before terminator",
  FRAME_HEADER: "frame header incomplete",
  SHORT: "record shorter than its declared length",
  LONG: "record longer than its declared length",
  UNPARSEABLE: "unparseable body at declared length",
  HASH_MISMATCH: "content hash mismatch",
  SCHEMA: "entry does not satisfy EvidenceEntrySchema",
  DUPLICATE_SEQUENCE: "duplicate entrySequence — broken writer",
} as const;

export interface EvidenceReplayReport {
  readonly entries: EvidenceEntry[];
  readonly anomalies: Anomaly[];
  readonly gaps: number[];
  readonly bytesAccounted: number;
  readonly bytesTotal: number;
}

export function isEvidenceReplayClean(report: EvidenceReplayReport): boolean {
  return report.anomalies.length === 0 && report.gaps.length === 0 && report.bytesAccounted === report.bytesTotal;
}

export function replayEvidence(dir: string): EvidenceReplayReport {
  const raw = readOrEmpty(join(dir, EVIDENCE_LOG_FILENAME));
  const entries: EvidenceEntry[] = [];
  const anomalies: Anomaly[] = [];
  const seen = new Set<number>();
  let bytesAccounted = 0;

  const parts = raw.length === 0 ? [] : raw.split("\n");
  const unterminated = parts.length > 0 ? (parts.pop() ?? "") : "";

  for (const line of parts) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    bytesAccounted += size;
    const outcome = decodeEntry(line, size);
    if ("anomaly" in outcome) {
      anomalies.push(outcome.anomaly);
      continue;
    }
    const entry = outcome.entry;
    if (seen.has(entry.entrySequence)) {
      anomalies.push({
        classification: "REJECTED",
        reason: `${EVIDENCE_REPLAY_ANOMALIES.DUPLICATE_SEQUENCE} ${entry.entrySequence}`,
        bytes: size,
      });
      continue;
    }
    seen.add(entry.entrySequence);
    entries.push(entry);
  }

  if (unterminated.length > 0) {
    const size = Buffer.byteLength(unterminated, "utf8");
    bytesAccounted += size;
    anomalies.push({ classification: "INCOMPLETE", reason: EVIDENCE_REPLAY_ANOMALIES.TRUNCATED, bytes: size });
  }

  entries.sort((a, b) => a.entrySequence - b.entrySequence);

  return {
    entries,
    anomalies,
    gaps: findGaps(entries),
    bytesAccounted,
    bytesTotal: Buffer.byteLength(raw, "utf8"),
  };
}

function findGaps(entries: readonly EvidenceEntry[]): number[] {
  if (entries.length === 0) return [];
  const gaps: number[] = [];
  for (let expected = entries[0]!.entrySequence; expected < entries[entries.length - 1]!.entrySequence; expected += 1) {
    if (!entries.some((e) => e.entrySequence === expected)) gaps.push(expected);
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

function decodeEntry(line: string, size: number): { entry: EvidenceEntry } | { anomaly: Anomaly } {
  const first = line.indexOf("\t");
  const second = line.indexOf("\t", first + 1);
  if (first < 0 || second < 0) {
    return { anomaly: { classification: "INCOMPLETE", reason: EVIDENCE_REPLAY_ANOMALIES.FRAME_HEADER, bytes: size } };
  }
  const declaredHash = line.slice(0, first);
  const declaredLength = Number(line.slice(first + 1, second));
  const body = line.slice(second + 1);
  const actualLength = Buffer.byteLength(body, "utf8");

  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    return { anomaly: { classification: "REJECTED", reason: "malformed length field", bytes: size } };
  }
  if (actualLength < declaredLength) {
    return { anomaly: { classification: "INCOMPLETE", reason: EVIDENCE_REPLAY_ANOMALIES.SHORT, bytes: size } };
  }
  if (actualLength > declaredLength) {
    return { anomaly: { classification: "REJECTED", reason: EVIDENCE_REPLAY_ANOMALIES.LONG, bytes: size } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { anomaly: { classification: "REJECTED", reason: EVIDENCE_REPLAY_ANOMALIES.UNPARSEABLE, bytes: size } };
  }

  const result = EvidenceEntrySchema.safeParse(parsed);
  if (!result.success) {
    return { anomaly: { classification: "REJECTED", reason: EVIDENCE_REPLAY_ANOMALIES.SCHEMA, bytes: size } };
  }
  const entry = result.data;

  if (recordHash({ id: String(entry.entrySequence), payload: entry }) !== declaredHash) {
    return { anomaly: { classification: "REJECTED", reason: EVIDENCE_REPLAY_ANOMALIES.HASH_MISMATCH, bytes: size } };
  }
  return { entry };
}

/** Canonical digest of an evidence replay report, for asserting determinism. */
export function evidenceReplayDigest(report: EvidenceReplayReport): string {
  return canonicalJson({
    entries: report.entries,
    anomalies: report.anomalies,
    gaps: report.gaps,
    bytesAccounted: report.bytesAccounted,
    bytesTotal: report.bytesTotal,
  });
}
