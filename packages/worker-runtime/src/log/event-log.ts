/**
 * The durable event log — single-writer, framed append.
 *
 * This promotes candidate B from the F10 evaluation into the production write
 * path. The frame format is unchanged (`<hash>\t<byteLength>\t<body>\n`),
 * because it is the format the measurements were taken against; changing it
 * here would invalidate that evidence.
 *
 * ── Why single-writer, and why that is not a simplification ────────────────
 *
 * `EventSchema.sequence` is documented in the frozen contract as *"Monotonic
 * per log; gaps mean loss, duplicates mean a broken writer."* Allocating a
 * gapless monotonic sequence across concurrent processes means reading the
 * current maximum and then writing — a read-modify-write race, which is
 * AP-018's defect class one layer up from the bytes. The F10 harness never
 * carried a sequence, so its clean concurrency numbers say nothing about this
 * (finding F16).
 *
 * Invariant I1 already requires exactly one authoritative writer per mutable
 * root. Combined with `sequence`, that settles the design: the log has one
 * writer, the sequence is an in-process counter, and correctness follows by
 * construction rather than from a lock. Concurrent writing is therefore not a
 * mode to support but an **error to detect and refuse**.
 *
 * ── What this does and does not guarantee ──────────────────────────────────
 *
 * GUARANTEED, and tested: framing detects truncation and tampering; every byte
 * is classified; sequence gaps and duplicates are reported distinctly; replay
 * is deterministic; a second writer is refused.
 *
 * NOT guaranteed, and deliberately not claimed: **durability across OS crash or
 * power loss** (U1). Nothing here calls fsync, and no test simulates a crash.
 * A completed `append()` means the bytes were handed to the OS, not that they
 * survive its death. Claiming otherwise would be inventing a property.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { canonicalJson } from "../canonical.js";
import { EventSchema, type WorkerEvent } from "../contracts/index.js";
import { assertWritable } from "../ownership.js";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import { recordHash } from "./write-contract.js";

export const LOG_FILENAME = "events.log";
export const WRITER_LOCK_FILENAME = "writer.lock";

/** Relative path of the event log within a workspace, for ownership checks. */
export const EVENT_LOG_RELPATH = `${STORAGE_ROOT_DIRNAME}/events/${LOG_FILENAME}`;

export class EventLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventLogError";
  }
}

/** Identifies the process that holds the log, so a stale claim is diagnosable. */
export interface WriterIdentity {
  readonly pid: number;
  readonly host: string;
  readonly claimedAt: string;
}

/**
 * Serialize one event into its frame.
 *
 * The hash covers the canonical event, so any byte change anywhere in it is
 * detected — not merely changes to fields replay happens to inspect.
 */
export function frameOf(event: WorkerEvent): string {
  const body = canonicalJson(event);
  return `${recordHash({ id: event.id, payload: event })}\t${Buffer.byteLength(body, "utf8")}\t${body}\n`;
}

/**
 * An exclusive, append-only handle on one event log.
 *
 * Construct with `EventLog.open`, which claims the writer lock. The claim is
 * the point: a second `open` on the same directory fails rather than producing
 * a second writer that believes it is alone.
 */
export class EventLog {
  #dir: string;
  #logPath: string;
  #lockPath: string;
  #nextSequence: number;
  #closed = false;

  private constructor(dir: string, nextSequence: number) {
    this.#dir = dir;
    this.#logPath = join(dir, LOG_FILENAME);
    this.#lockPath = join(dir, WRITER_LOCK_FILENAME);
    this.#nextSequence = nextSequence;
  }

  /**
   * Claim the log for this process.
   *
   * `relPath` is validated through the ownership chokepoint before any
   * filesystem call, so the log cannot be opened outside kernel-owned storage
   * even if a caller supplies the path.
   */
  static open(workspaceRoot: string, relPath: string = `${STORAGE_ROOT_DIRNAME}/events`): EventLog {
    assertWritable(relPath);
    const dir = join(workspaceRoot, relPath);
    mkdirSync(dir, { recursive: true });

    const lockPath = join(dir, WRITER_LOCK_FILENAME);
    let fd: number;
    try {
      // Exclusive create: the filesystem, not a check-then-act, decides who wins.
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Deliberately NOT auto-broken. A stale lock and a live second writer
        // are indistinguishable from here, and breaking the lock to find out
        // produces exactly the two-writer state the lock exists to prevent.
        // Report it and let a human or an explicit recovery step decide.
        throw new EventLogError(
          `event log at ${dir} is already claimed by ${describeHolder(lockPath)}; ` +
            `refusing to become a second writer. If that process is gone, remove ${WRITER_LOCK_FILENAME} deliberately.`,
        );
      }
      throw err;
    }
    const identity: WriterIdentity = { pid: process.pid, host: hostname(), claimedAt: new Date().toISOString() };
    try {
      writeFileSync(fd, `${canonicalJson(identity)}\n`, "utf8");
    } finally {
      closeSync(fd);
    }

    // Resume from the existing log rather than restarting the sequence, which
    // would produce duplicates — the contract's "broken writer" signal.
    const resumeFrom = highestSequence(join(dir, LOG_FILENAME));
    return new EventLog(dir, resumeFrom + 1);
  }

  /** The sequence the next appended event will receive. */
  get nextSequence(): number {
    return this.#nextSequence;
  }

  get directory(): string {
    return this.#dir;
  }

  /**
   * Append one event, assigning its sequence.
   *
   * The caller supplies everything except `sequence`: allowing a caller to
   * choose it would reintroduce the allocator race this design exists to avoid.
   */
  append(event: Omit<WorkerEvent, "sequence">): WorkerEvent {
    if (this.#closed) throw new EventLogError("cannot append to a closed event log");
    const complete = EventSchema.parse({ ...event, sequence: this.#nextSequence });
    appendFileSync(this.#logPath, frameOf(complete), "utf8");
    // Incremented only after the write returns, so a throwing write does not
    // burn a sequence number and manufacture a gap.
    this.#nextSequence += 1;
    return complete;
  }

  /** Release the writer claim. Safe to call twice. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      unlinkSync(this.#lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
}

/** Best-effort description of the current lock holder, for the refusal message. */
function describeHolder(lockPath: string): string {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const held = JSON.parse(raw) as Partial<WriterIdentity>;
    return `pid ${held.pid ?? "?"} on ${held.host ?? "?"} since ${held.claimedAt ?? "?"}`;
  } catch {
    // An unreadable lock is still a lock. Failing to describe the holder must
    // never soften the refusal.
    return "an unidentified writer";
  }
}

/**
 * Highest sequence already committed, or -1 for an empty/absent log.
 *
 * Reads only well-formed frames: a damaged tail must not raise the resume
 * point, because that would turn corruption into a permanent gap.
 */
function highestSequence(logPath: string): number {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return -1;
    throw err;
  }
  let highest = -1;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const second = line.indexOf("\t", line.indexOf("\t") + 1);
    if (second < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(second + 1)) as { sequence?: unknown };
      if (typeof parsed.sequence === "number" && Number.isSafeInteger(parsed.sequence)) {
        if (parsed.sequence > highest) highest = parsed.sequence;
      }
    } catch {
      continue; // damaged frame; replay classifies it, resume ignores it
    }
  }
  return highest;
}
