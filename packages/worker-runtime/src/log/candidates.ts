/**
 * Candidate durability mechanisms for the M2 event log.
 *
 * These are UNDER EVALUATION. None of them is the kernel's write path yet — the
 * F10 harness measures them against EVENT_WRITE_CONTRACT v1 and the results
 * table decides. They live here rather than in a scratch directory precisely so
 * the losers stay in the repository: the reason a mechanism was rejected is
 * evidence, and deleting it would mean re-deriving it the next time someone
 * proposes "just append to a file".
 *
 * Every candidate hashes the same bytes (`recordHash`) so the comparison is
 * about the mechanism, never about incidental serialization differences.
 */
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson } from "../canonical.js";
import type { Anomaly, CommittedEntry, EventLogWriter, LogRecord, ReplayResult } from "./write-contract.js";
import { recordHash } from "./write-contract.js";

const LOG_FILE = "events.log";

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Serialized body every candidate agrees on, so framing is the only variable. */
function body(record: LogRecord): string {
  return canonicalJson({ id: record.id, payload: record.payload });
}

/**
 * Split an append-structured log into newline-delimited segments, reporting
 * whether the file ended without its final newline.
 *
 * Canonical JSON never contains a raw newline (control characters are escaped),
 * so newline framing is unambiguous — that is a property of the canonicalizer,
 * not a hopeful assumption about payloads.
 */
function segments(raw: string): { lines: string[]; unterminated: string | null } {
  if (raw.length === 0) return { lines: [], unterminated: null };
  const parts = raw.split("\n");
  const last = parts.pop() ?? "";
  return { lines: parts, unterminated: last.length > 0 ? last : null };
}

/**
 * A — plain append, no framing metadata, no checksum.
 *
 * The naive mechanism, included as the baseline that shows why the others are
 * necessary. It cannot distinguish a truncated write from a tampered one from a
 * correct one, because it has recorded nothing to check against.
 */
export const plainAppend: EventLogWriter = {
  id: "A-plain-append",
  mechanism: "appendFileSync of newline-delimited canonical JSON; no checksum, no length",
  init: ensureDir,
  append(dir, record) {
    appendFileSync(join(dir, LOG_FILE), `${body(record)}\n`, "utf8");
  },
  replay(dir) {
    const raw = readOrEmpty(join(dir, LOG_FILE));
    const { lines, unterminated } = segments(raw);
    const committed: CommittedEntry[] = [];
    const anomalies: Anomaly[] = [];
    const seen = new Set<string>();
    let bytesAccounted = 0;

    for (const line of lines) {
      bytesAccounted += Buffer.byteLength(line, "utf8") + 1;
      let parsed: { id?: unknown; payload?: unknown };
      try {
        parsed = JSON.parse(line) as { id?: unknown; payload?: unknown };
      } catch {
        anomalies.push({ classification: "REJECTED", reason: "unparseable", bytes: Buffer.byteLength(line, "utf8") + 1 });
        continue;
      }
      if (typeof parsed.id !== "string") {
        anomalies.push({ classification: "REJECTED", reason: "missing id", bytes: Buffer.byteLength(line, "utf8") + 1 });
        continue;
      }
      if (seen.has(parsed.id)) {
        anomalies.push({ classification: "REJECTED", reason: `duplicate id ${parsed.id}`, bytes: Buffer.byteLength(line, "utf8") + 1 });
        continue;
      }
      seen.add(parsed.id);
      // NOTE the defect this candidate exists to expose: the hash is computed
      // from whatever was read back, not compared against what was written. A
      // flipped byte yields a *different, well-formed* event and is committed
      // silently. That is a G3 violation and it is not fixable by parsing
      // harder — the information needed to detect it was never recorded.
      committed.push({ id: parsed.id, payload: parsed.payload, hash: recordHash({ id: parsed.id, payload: parsed.payload }) });
    }
    if (unterminated !== null) {
      bytesAccounted += Buffer.byteLength(unterminated, "utf8");
      anomalies.push({ classification: "INCOMPLETE", reason: "trailing bytes without terminator", bytes: Buffer.byteLength(unterminated, "utf8") });
    }
    return { committed, anomalies, bytesAccounted, bytesTotal: Buffer.byteLength(raw, "utf8") };
  },
};

/**
 * B — framed append with a length and a content hash.
 *
 * `<hash>\t<byteLength>\t<body>\n`. The length lets replay tell a short record
 * from a complete one; the hash lets it tell a damaged record from an intact
 * one. Together they turn every failure into a *detected* failure, which is
 * what G3 asks for. Neither of them makes the write atomic — they make
 * non-atomicity observable, which is the achievable goal.
 */
export const framedAppend: EventLogWriter = {
  id: "B-framed-append",
  mechanism: "appendFileSync of hash + byte-length + canonical JSON, newline framed",
  init: ensureDir,
  append(dir, record) {
    const b = body(record);
    const frame = `${recordHash(record)}\t${Buffer.byteLength(b, "utf8")}\t${b}\n`;
    appendFileSync(join(dir, LOG_FILE), frame, "utf8");
  },
  replay(dir) {
    return replayFramed(readOrEmpty(join(dir, LOG_FILE)));
  },
};

/**
 * D — exclusive lock around a framed append.
 *
 * Serialises writers with an atomically-created lock directory (`mkdir` is
 * atomic on POSIX and on Windows, unlike `open(O_CREAT|O_EXCL)` semantics over
 * some network filesystems). Serialisation addresses CONCURRENCY and nothing
 * else: a writer that dies holding the lock leaves it held, so the lock is a
 * new failure mode traded for an old one. Framing is retained because without
 * it the lock would protect only against *concurrent* damage and not against
 * partial or tampered writes.
 */
export const lockedAppend: EventLogWriter = {
  id: "D-locked-append",
  mechanism: "mkdir-based exclusive lock around the framed append of candidate B",
  init: ensureDir,
  append(dir, record) {
    const lock = join(dir, ".lock");
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch {
        if (Date.now() > deadline) throw new Error(`lock acquisition timed out at ${lock}`);
      }
    }
    try {
      framedAppend.append(dir, record);
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  },
  replay(dir) {
    return replayFramed(readOrEmpty(join(dir, LOG_FILE)));
  },
};

/**
 * C — one file per event, published by rename.
 *
 * Write to a unique temporary name, then `rename` it into place. Rename is the
 * one filesystem operation that is atomic with respect to *visibility* on both
 * POSIX and Windows: a reader sees the whole file or no file. It sidesteps
 * append atomicity entirely, so PIPE_BUF stops being relevant at any record
 * size.
 *
 * What it does not give: durability (the rename can be reordered before the
 * data reaches disk without an fsync of file and directory), and arrival
 * ORDER — filenames carry identity, not sequence.
 */
export const renamePerEvent: EventLogWriter = {
  id: "C-rename-per-event",
  mechanism: "write temp file then renameSync into place, one file per event",
  init: ensureDir,
  append(dir, record) {
    const b = body(record);
    const content = `${recordHash(record)}\t${Buffer.byteLength(b, "utf8")}\t${b}\n`;
    const target = join(dir, `${record.id}.event`);
    // Check-then-rename is not race-free between processes; candidate E closes
    // that hole. Measured rather than assumed — see the idempotence results.
    const tmp = join(dir, `.tmp-${record.id}-${process.pid}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, target);
  },
  replay: replayPerFile,
};

/**
 * E — one immutable file per event, created exclusively.
 *
 * `open(..., "wx")` fails if the name already exists, so a duplicate event id
 * is refused by the *filesystem* at write time rather than by replay after the
 * fact. That makes idempotence a property of the store instead of a property of
 * the reader, which is strictly stronger: a reader can be reimplemented wrongly.
 *
 * Same two costs as C — no durability without fsync, and no arrival order — plus
 * one file per event, which is a real cost at volume and is measured rather
 * than hand-waved.
 */
export const exclusivePerEvent: EventLogWriter = {
  id: "E-exclusive-per-event",
  mechanism: "openSync with 'wx' (exclusive create), one immutable file per event",
  init: ensureDir,
  append(dir, record) {
    const b = body(record);
    const content = `${recordHash(record)}\t${Buffer.byteLength(b, "utf8")}\t${b}\n`;
    let fd: number;
    try {
      fd = openSync(join(dir, `${record.id}.event`), "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return; // already committed
      throw err;
    }
    try {
      writeFileSync(fd, content, "utf8");
    } finally {
      closeSync(fd);
    }
  },
  replay: replayPerFile,
};

export const CANDIDATES: readonly EventLogWriter[] = [
  plainAppend,
  framedAppend,
  lockedAppend,
  renamePerEvent,
  exclusivePerEvent,
];

/** Candidates whose frames carry a checksum, and so can detect tampering. */
export const CHECKSUMMED = new Set(["B-framed-append", "D-locked-append", "C-rename-per-event", "E-exclusive-per-event"]);

/** Candidates that preserve the order in which appends arrived. */
export const ORDER_PRESERVING = new Set(["A-plain-append", "B-framed-append", "D-locked-append"]);

function readOrEmpty(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

/** Shared replay for the framed-append candidates (B and D). */
function replayFramed(raw: string): ReplayResult {
  const { lines, unterminated } = segments(raw);
  const committed: CommittedEntry[] = [];
  const anomalies: Anomaly[] = [];
  const seen = new Set<string>();
  let bytesAccounted = 0;

  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    bytesAccounted += size;
    const entry = decodeFrame(line, size);
    if ("anomaly" in entry) {
      anomalies.push(entry.anomaly);
      continue;
    }
    if (seen.has(entry.committed.id)) {
      anomalies.push({ classification: "REJECTED", reason: `duplicate id ${entry.committed.id}`, bytes: size });
      continue;
    }
    seen.add(entry.committed.id);
    committed.push(entry.committed);
  }
  if (unterminated !== null) {
    const size = Buffer.byteLength(unterminated, "utf8");
    bytesAccounted += size;
    anomalies.push({ classification: "INCOMPLETE", reason: "record truncated before terminator", bytes: size });
  }
  return { committed, anomalies, bytesAccounted, bytesTotal: Buffer.byteLength(raw, "utf8") };
}

/** Shared replay for the file-per-event candidates (C and E). */
function replayPerFile(dir: string): ReplayResult {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { committed: [], anomalies: [], bytesAccounted: 0, bytesTotal: 0 };
    throw err;
  }
  const committed: CommittedEntry[] = [];
  const anomalies: Anomaly[] = [];
  let bytesAccounted = 0;
  let bytesTotal = 0;

  // readdir order is not defined across platforms or filesystems, so it is
  // never the recovered order. Sorting by name gives a deterministic total
  // order (G4). It is NOT arrival order — see ORDER_PRESERVING.
  for (const name of names.slice().sort()) {
    if (name.startsWith(".tmp-")) continue; // an abandoned write, not a record
    if (!name.endsWith(".event")) continue;
    const raw = readOrEmpty(join(dir, name));
    const size = Buffer.byteLength(raw, "utf8");
    bytesTotal += size;
    bytesAccounted += size;
    const { lines, unterminated } = segments(raw);
    if (unterminated !== null || lines.length !== 1) {
      anomalies.push({ classification: "INCOMPLETE", reason: `partial event file ${name}`, bytes: size });
      continue;
    }
    const entry = decodeFrame(lines[0]!, size);
    if ("anomaly" in entry) {
      anomalies.push(entry.anomaly);
      continue;
    }
    committed.push(entry.committed);
  }
  return { committed, anomalies, bytesAccounted, bytesTotal };
}

/**
 * Decode one `<hash>\t<byteLength>\t<body>` frame, verifying both the declared
 * length and the declared hash.
 *
 * The order matters: length is checked first because a short frame is
 * INCOMPLETE (a write that did not finish) while a full-length frame whose hash
 * disagrees is REJECTED (bytes that were changed). Collapsing the two would
 * report a crash as corruption and send recovery down the wrong path.
 */
function decodeFrame(line: string, size: number): { committed: CommittedEntry } | { anomaly: Anomaly } {
  const first = line.indexOf("\t");
  const second = line.indexOf("\t", first + 1);
  if (first < 0 || second < 0) {
    return { anomaly: { classification: "INCOMPLETE", reason: "frame header incomplete", bytes: size } };
  }
  const declaredHash = line.slice(0, first);
  const declaredLength = Number(line.slice(first + 1, second));
  const payloadText = line.slice(second + 1);
  const actualLength = Buffer.byteLength(payloadText, "utf8");

  if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
    return { anomaly: { classification: "REJECTED", reason: "malformed length field", bytes: size } };
  }
  if (actualLength < declaredLength) {
    return { anomaly: { classification: "INCOMPLETE", reason: `record short by ${declaredLength - actualLength} bytes`, bytes: size } };
  }
  if (actualLength > declaredLength) {
    return { anomaly: { classification: "REJECTED", reason: "record longer than its declared length", bytes: size } };
  }

  let parsed: { id?: unknown; payload?: unknown };
  try {
    parsed = JSON.parse(payloadText) as { id?: unknown; payload?: unknown };
  } catch {
    return { anomaly: { classification: "REJECTED", reason: "unparseable body at declared length", bytes: size } };
  }
  if (typeof parsed.id !== "string") {
    return { anomaly: { classification: "REJECTED", reason: "missing id", bytes: size } };
  }
  const actualHash = recordHash({ id: parsed.id, payload: parsed.payload });
  if (actualHash !== declaredHash) {
    // The G3 check. Full-length, well-formed, parseable — and not what was
    // written. Only the recorded hash can tell.
    return { anomaly: { classification: "REJECTED", reason: "content hash mismatch", bytes: size } };
  }
  return { committed: { id: parsed.id, payload: parsed.payload, hash: actualHash } };
}
