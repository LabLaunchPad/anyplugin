/**
 * The durable evidence log — single-writer, framed append. Its own authoritative
 * store, independent of `events.log`.
 *
 * ── Why a separate store rather than riding the event log (M3-A) ───────────
 *
 * `EventSchema.kind` enumerates `EVIDENCE_ADDED` / `EVIDENCE_INVALIDATED` /
 * `EVIDENCE_SUPERSEDED`, which reads as an invitation to fold Evidence out of
 * `events.log` the way `worker-state.ts` folds `WorkerState`. That reading is
 * NOT proven by anything in this repository: `ROADMAP.md` lists M3's
 * prerequisite as M1 only (not M2); `CORE-INVARIANTS-V2.md` never mentions
 * Evidence; `EventSchema.payload` is untyped and delegates its shape to
 * "the engine that emits it" — a delegation, not a specification; and the only
 * two places those three `kind` values appear anywhere in the repository are
 * incidental placeholder values in tests about something else entirely
 * (`event-log.test.ts`, `replay-determinism.test.ts`), neither of which
 * defines or exercises an Evidence payload shape.
 *
 * Choosing to fold Evidence from `events.log` would therefore be inventing an
 * architectural interpretation the repository does not establish — exactly the
 * move `ANTI_VACUITY_ANALYSIS` and this project's whole doctrine argue against
 * ("do not convert ambiguity into architecture by reasoning alone"). `evidence`
 * is already classified `AUTHORITATIVE_SUBDIRS` in its own right (not
 * `DERIVED_SUBDIRS`), which is what an independent store predicts and what a
 * folded-from-events design would not need. So: its own log, its own writer
 * lock, its own replay — mirroring `event-log.ts`'s proven pattern at the
 * mechanism level, answering to nobody else's contract.
 *
 * ── What is authoritative and what is derived (M3-C) ────────────────────────
 *
 * AUTHORITATIVE (persisted, immutable, replayed): the append-only sequence of
 * `BASE` and `TRANSITION` entries in `evidence.log`. A `BASE` entry is the
 * frozen `EvidenceSchema` record exactly as first observed — written once per
 * id, in the only validity a freshly created record can honestly hold,
 * `"VALID"`. A `TRANSITION` entry records a later invalidation or supersession
 * as its own immutable fact: it never rewrites the `BASE` entry, because
 * "immutable: invalidation appends new events and flips this projection" is
 * `EvidenceSchema`'s own contract comment (`contracts/primitives.ts`, on
 * `ValiditySchema`).
 *
 * DERIVED (computed on demand, never persisted): "what is Evidence `EV-x`'s
 * *current* validity", which is `evidence-state.ts`'s job — the same
 * authoritative/derived split `worker-state.ts` already established for
 * `WorkerState.phase`. Nothing here may hold a fact that is not reconstructible
 * from the log alone, for the same reason I6 requires it of worker state.
 *
 * ── What this deliberately does not do ──────────────────────────────────────
 *
 * No cross-store link to `events.log` (item 6 of the M3 preflight stays
 * unresolved on purpose — a future engine may still choose to also emit
 * observability events, but Evidence's correctness never depends on it). No
 * vector search, no embeddings, no promotion, no provenance/verdict binding.
 * The smallest experiment: record, retrieve, invalidate/supersede, and
 * deterministically reconstruct Evidence without silently corrupting or
 * inventing epistemic state.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";
import { canonicalJson } from "../canonical.js";
import { EvidenceSchema, type Evidence } from "../contracts/index.js";
import { idSchema, TimestampSchema } from "../contracts/primitives.js";
import { assertWritable } from "../ownership.js";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import { recordHash } from "./write-contract.js";

export const EVIDENCE_LOG_FILENAME = "evidence.log";
export const EVIDENCE_WRITER_LOCK_FILENAME = "writer.lock";

/** Relative path of the evidence log within a workspace, for ownership checks. */
export const EVIDENCE_LOG_RELPATH = `${STORAGE_ROOT_DIRNAME}/evidence/${EVIDENCE_LOG_FILENAME}`;

export class EvidenceLogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceLogError";
  }
}

/**
 * One physical entry in the log. `entrySequence` and `at` are envelope
 * concerns — never part of `EvidenceSchema`, which is frozen and carries no
 * sequence field of its own. Ordering is a property of THIS store, proven
 * independently of `EventLog`'s (M3 preflight: "ordering... NOT YET PROVEN by
 * analogy" — closed here, not assumed).
 */
const TransitionEntrySchema = z
  .object({
    kind: z.literal("TRANSITION"),
    id: idSchema("evidence"),
    to: z.enum(["INVALIDATED", "SUPERSEDED"]),
    /** Set iff `to` is INVALIDATED. Mirrors EvidenceSchema's own refinement. */
    reason: z.string().min(1).optional(),
    /** Set iff `to` is SUPERSEDED. */
    supersededBy: idSchema("evidence").optional(),
  })
  .strict()
  .refine((t) => (t.to === "INVALIDATED") === (t.reason !== undefined), {
    message: "reason must be present exactly when to is INVALIDATED",
    path: ["reason"],
  })
  .refine((t) => (t.to === "SUPERSEDED") === (t.supersededBy !== undefined), {
    message: "supersededBy must be present exactly when to is SUPERSEDED",
    path: ["supersededBy"],
  });

export const EvidenceEntrySchema = z
  .object({
    entrySequence: z.number().int().nonnegative(),
    at: TimestampSchema,
    entry: z.union([z.object({ kind: z.literal("BASE"), record: EvidenceSchema }).strict(), TransitionEntrySchema]),
  })
  .strict();
export type EvidenceEntry = z.infer<typeof EvidenceEntrySchema>;
/** The TRANSITION variant of an entry's `entry` field, for callers building one directly. */
export type TransitionEntry = z.infer<typeof TransitionEntrySchema>;

/** What the caller supplies; `entrySequence` is assigned by the log, never chosen by a caller. */
export type EvidenceEntryInput = Omit<EvidenceEntry, "entrySequence">;

export interface WriterIdentity {
  readonly pid: number;
  readonly host: string;
  readonly claimedAt: string;
}

/** Serialize one entry into its frame. Same format `event-log.ts` measured — unchanged deliberately. */
export function frameOfEntry(entry: EvidenceEntry): string {
  const body = canonicalJson(entry);
  return `${recordHash({ id: String(entry.entrySequence), payload: entry })}\t${Buffer.byteLength(body, "utf8")}\t${body}\n`;
}

/**
 * An exclusive, append-only handle on one evidence log.
 *
 * Construct with `EvidenceLog.open`, which claims the writer lock — a second
 * `open` on the same directory fails rather than producing a second writer
 * that believes it is alone (I1, same reasoning as `EventLog`).
 */
export class EvidenceLog {
  #dir: string;
  #logPath: string;
  #lockPath: string;
  #nextSequence: number;
  #knownIds: Set<string>;
  #closed = false;

  private constructor(dir: string, nextSequence: number, knownIds: Set<string>) {
    this.#dir = dir;
    this.#logPath = join(dir, EVIDENCE_LOG_FILENAME);
    this.#lockPath = join(dir, EVIDENCE_WRITER_LOCK_FILENAME);
    this.#nextSequence = nextSequence;
    this.#knownIds = knownIds;
  }

  static open(workspaceRoot: string, relPath: string = `${STORAGE_ROOT_DIRNAME}/evidence`): EvidenceLog {
    assertWritable(relPath);
    const dir = join(workspaceRoot, relPath);
    mkdirSync(dir, { recursive: true });

    const lockPath = join(dir, EVIDENCE_WRITER_LOCK_FILENAME);
    let fd: number;
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Deliberately NOT auto-broken — same reasoning as EventLog: a stale
        // lock and a live second writer are indistinguishable from here.
        throw new EvidenceLogError(
          `evidence log at ${dir} is already claimed by ${describeHolder(lockPath)}; ` +
            `refusing to become a second writer. If that process is gone, remove ${EVIDENCE_WRITER_LOCK_FILENAME} deliberately.`,
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

    const { resumeFrom, knownIds } = scanExisting(join(dir, EVIDENCE_LOG_FILENAME));
    return new EvidenceLog(dir, resumeFrom + 1, knownIds);
  }

  get nextSequence(): number {
    return this.#nextSequence;
  }

  get directory(): string {
    return this.#dir;
  }

  /**
   * Append a `BASE` entry: the immutable record as first observed.
   *
   * Refuses a duplicate id rather than silently accepting a second creation —
   * a `BASE` entry establishes identity, and identity is not something a log
   * may commit twice (the id-level analogue of `EventLog`'s duplicate-sequence
   * refusal, at the semantic layer instead of the envelope layer).
   */
  appendBase(record: Evidence): EvidenceEntry {
    if (record.validity !== "VALID") {
      throw new EvidenceLogError(
        `BASE entry for ${record.id} must be VALID: a record cannot be created already invalidated or superseded`,
      );
    }
    if (this.#knownIds.has(record.id)) {
      throw new EvidenceLogError(`evidence id ${record.id} already has a BASE entry; ids are write-once`);
    }
    const complete = this.#commit({ kind: "BASE", record: EvidenceSchema.parse(record) });
    this.#knownIds.add(record.id);
    return complete;
  }

  /** Append a `TRANSITION` entry. Legality (does `id` exist? is it still VALID?) is a replay/fold concern, not an append-time one — mirrors worker-state.ts rejecting rather than preventing. */
  appendTransition(transition: Extract<EvidenceEntryInput["entry"], { kind: "TRANSITION" }>, at: string): EvidenceEntry {
    return this.#commit(transition, at);
  }

  #commit(entry: EvidenceEntryInput["entry"], at: string = new Date().toISOString()): EvidenceEntry {
    if (this.#closed) throw new EvidenceLogError("cannot append to a closed evidence log");
    const complete = EvidenceEntrySchema.parse({ entrySequence: this.#nextSequence, at, entry });
    appendFileSync(this.#logPath, frameOfEntry(complete), "utf8");
    this.#nextSequence += 1;
    return complete;
  }

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

function describeHolder(lockPath: string): string {
  try {
    const raw = readFileSync(lockPath, "utf8").trim();
    const held = JSON.parse(raw) as Partial<WriterIdentity>;
    return `pid ${held.pid ?? "?"} on ${held.host ?? "?"} since ${held.claimedAt ?? "?"}`;
  } catch {
    return "an unidentified writer";
  }
}

/**
 * Resume point and known BASE ids, from whatever is already on disk.
 *
 * Reads only well-formed frames — a damaged tail must not raise the resume
 * point or hide a known id, for the same reason `EventLog.highestSequence`
 * only trusts well-formed frames.
 */
function scanExisting(logPath: string): { resumeFrom: number; knownIds: Set<string> } {
  const knownIds = new Set<string>();
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { resumeFrom: -1, knownIds };
    throw err;
  }
  let highest = -1;
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const second = line.indexOf("\t", line.indexOf("\t") + 1);
    if (second < 0) continue;
    try {
      const parsed = EvidenceEntrySchema.safeParse(JSON.parse(line.slice(second + 1)));
      if (!parsed.success) continue;
      const e = parsed.data;
      if (e.entrySequence > highest) highest = e.entrySequence;
      if (e.entry.kind === "BASE") knownIds.add(e.entry.record.id);
    } catch {
      continue; // damaged frame; replay classifies it, resume ignores it
    }
  }
  return { resumeFrom: highest, knownIds };
}
