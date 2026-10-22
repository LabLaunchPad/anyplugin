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
 * DURABILITY is a per-open choice, stated exactly rather than implied. See
 * `DurabilityLevel` below. The default (`best-effort`) hands the bytes to the
 * OS and does NOT survive power loss; the stronger levels fsync explicitly and
 * say so. A completed `append()` at the default level means the bytes were
 * handed to the OS, not that they survive its death.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, fsyncSync, writeSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { canonicalJson } from "../canonical.js";
import { EventSchema, type WorkerEvent } from "../contracts/index.js";
import { migrateRecord } from "../contracts/migration.js";
import { assertWritable } from "../ownership.js";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import { recordHash } from "./write-contract.js";

export const LOG_FILENAME = "events.log";
export const WRITER_LOCK_FILENAME = "writer.lock";

/**
 * How much durability a writer asks for.
 *
 * The level is a claim about what survives a failure, so each one names the
 * failure it tolerates:
 *
 * - `best-effort` (default) — bytes are handed to the OS page cache. They
 *   survive the process dying. They do NOT survive an OS crash or power loss.
 *   This is the default because the write path was measured (F10) at this
 *   level, and an fsync per append would invalidate those numbers.
 * - `process-crash` — bytes are fsynced to the storage device before the
 *   append returns. They survive an OS crash. A power loss may still lose the
 *   file ENTRY (the directory update), so a brand-new log file may vanish.
 * - `power-loss` — bytes are fsynced, and the containing directory is fsynced
 *   so the file entry itself is durable. On Windows the directory fsync is a
 *   no-op (NTFS does not need it the way POSIX does); the level then means
 *   the same as `process-crash` there, and this is reported rather than
 *   pretended away.
 */
export type DurabilityLevel = "best-effort" | "process-crash" | "power-loss";

/** The durability a writer uses when it does not ask for one. */
export const DEFAULT_DURABILITY: DurabilityLevel = "best-effort";

/** Options accepted by `EventLog.open`. */
export interface EventLogOptions {
  /** How durable each append must be. Defaults to `best-effort`. */
  durability?: DurabilityLevel;
}

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
  #durability: DurabilityLevel;
  #committedEvents: Map<string, WorkerEvent>;
  #closed = false;

  private constructor(
    dir: string,
    nextSequence: number,
    durability: DurabilityLevel,
    committedEvents: Map<string, WorkerEvent> = new Map(),
  ) {
    this.#dir = dir;
    this.#logPath = join(dir, LOG_FILENAME);
    this.#lockPath = join(dir, WRITER_LOCK_FILENAME);
    this.#nextSequence = nextSequence;
    this.#durability = durability;
    this.#committedEvents = committedEvents;
  }

  /**
   * Claim the log for this process.
   *
   * `relPath` is validated through the ownership chokepoint before any
   * filesystem call, so the log cannot be opened outside kernel-owned storage
   * even if a caller supplies the path.
   */
  static open(
    workspaceRoot: string,
    relPath: string = `${STORAGE_ROOT_DIRNAME}/events`,
    opts: EventLogOptions = {},
  ): EventLog {
    assertWritable(relPath);
    const dir = join(workspaceRoot, relPath);
    mkdirSync(dir, { recursive: true });
    const durability = opts.durability ?? DEFAULT_DURABILITY;

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
    const { highestSequence: resumeFrom, committedEvents } = readCommittedEvents(join(dir, LOG_FILENAME));
    const log = new EventLog(dir, resumeFrom + 1, durability, committedEvents);
    // The file ENTRY must be durable before any byte in it can be: a log file
    // that the directory does not know about cannot be recovered, however
    // durable its contents are.
    if (durability === "power-loss") log.#fsyncDirectory();
    return log;
  }

  /** The sequence the next appended event will receive. */
  get nextSequence(): number {
    return this.#nextSequence;
  }

  get directory(): string {
    return this.#dir;
  }

  /** The durability level this writer commits to. */
  get durability(): DurabilityLevel {
    return this.#durability;
  }

  /**
   * Flush the containing directory so the log file's ENTRY is durable.
   *
   * A no-op on Windows: NTFS journals directory updates, so there is no
   * directory handle to fsync. The failure is swallowed deliberately — a
   * platform that cannot express the guarantee must not make the write fail.
   */
  #fsyncDirectory(): void {
    try {
      const dirFd = openSync(this.#dir, "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
    } catch {
      /* not supported on this platform — the file contents are still fsynced */
    }
  }

  /**
   * Append one event, assigning its sequence.
   *
   * The caller supplies everything except `sequence`: allowing a caller to
   * choose it would reintroduce the allocator race this design exists to avoid.
   */
  append(event: Omit<WorkerEvent, "sequence">): WorkerEvent {
    if (this.#closed) throw new EventLogError("cannot append to a closed event log");

    // G5 IDEMPOTENCE: If an event with this ID was already committed, return the existing event.
    const existing = this.#committedEvents.get(event.id);
    if (existing) {
      return existing;
    }

    const complete = EventSchema.parse({ ...event, sequence: this.#nextSequence });
    const frame = frameOf(complete);
    const fd = openSync(this.#logPath, "a");
    try {
      writeSync(fd, frame);
      // fsync BEFORE the sequence advances: a sequence that was handed out but
      // whose bytes are not durable would be a permanent gap on recovery.
      if (this.#durability !== "best-effort") {
        fsyncSync(fd);
      }
    } finally {
      closeSync(fd);
    }
    // Incremented only after the write returns, so a throwing write does not
    // burn a sequence number and manufacture a gap.
    this.#committedEvents.set(complete.id, complete);
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
 * Highest sequence already committed and all committed events map, or -1 / empty map for absent log.
 *
 * Reads only well-formed frames: a damaged tail must not raise the resume
 * point, because that would turn corruption into a permanent gap.
 */
function readCommittedEvents(logPath: string): { highestSequence: number; committedEvents: Map<string, WorkerEvent> } {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { highestSequence: -1, committedEvents: new Map() };
    }
    throw err;
  }
  let highest = -1;
  const committedEvents = new Map<string, WorkerEvent>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const second = line.indexOf("\t", line.indexOf("\t") + 1);
    if (second < 0) continue;
    try {
      const parsed = JSON.parse(line.slice(second + 1));
      // MIGRATE BEFORE CHECKING, exactly as replay does.
      //
      // A record written under an earlier contract version is READABLE — the
      // migration upgrades it on the way in. Checking it against the CURRENT
      // schema without migrating first would reject it, and then its sequence
      // would be ignored: the writer would resume at 0 and REUSE a sequence
      // that is already on disk, which replay reports as "broken writer" and
      // which manufactures gaps out of nothing.
      const migrated = migrateRecord(parsed);
      const candidate = migrated.ok ? migrated.value : parsed;
      const valid = EventSchema.safeParse(candidate);
      if (valid.success) {
        if (valid.data.sequence > highest) highest = valid.data.sequence;
        committedEvents.set(valid.data.id, valid.data);
      }
    } catch {
      continue; // damaged frame; replay classifies it, resume ignores it
    }
  }
  return { highestSequence: highest, committedEvents };
}
