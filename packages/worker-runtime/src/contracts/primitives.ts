/**
 * Shared contract primitives.
 *
 * Every field here earns its place by being read by something. Fields that
 * merely "sound useful" are excluded by design rule 1 of the kernel doc.
 *
 * The actor and timestamp conventions deliberately mirror OKF v0.2's
 * (`<producer>/<version>` | `human:<id>` | `process:<id>`, offset-bearing
 * ISO-8601) so that promoting a kernel record into the OKF bundle is a
 * translation, not a redesign. They are reimplemented rather than imported:
 * the kernel may not depend on `@lablaunchpad/core` (ROADMAP.md §2).
 */
import { z } from "zod";

/** ISO-8601 instant that MUST carry an explicit offset. */
export const TimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/,
    "timestamp must be ISO-8601 with an explicit UTC offset (naive local time is not a point in time)",
  );
export type Timestamp = z.infer<typeof TimestampSchema>;

/** Who produced a record: a tool version, a person, or an automated process. */
export const ActorSchema = z
  .string()
  .regex(
    /^(human:|process:)[^\s]+$|^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/,
    'actor must be "<producer>/<version>", "human:<id>", or "process:<id>"',
  );
export type Actor = z.infer<typeof ActorSchema>;

/** Creation provenance. Every kernel record carries one; none is optional. */
export const ProvenanceSchema = z
  .object({ by: ActorSchema, at: TimestampSchema })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Algorithm-prefixed content hash (see canonical.ts). */
export const ContentHashSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "content hash must be sha256:<64 lowercase hex>");

/**
 * Typed record identifiers. The prefix makes a dangling reference obvious at a
 * glance and makes it impossible to pass an evidence id where a decision id is
 * required without the schema noticing.
 */
export const ID_PREFIXES = {
  workContract: "WC",
  workerState: "WS",
  event: "EVT",
  evidence: "EV",
  decision: "DEC",
  experience: "EXP",
  verification: "VER",
  certificate: "CERT",
  node: "ND",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;

/** `PREFIX-<slug>`; slug is 1-64 chars of `[A-Za-z0-9_-]`. */
export function idSchema<K extends IdKind>(kind: K) {
  const prefix = ID_PREFIXES[kind];
  return z
    .string()
    .regex(new RegExp(`^${prefix}-[A-Za-z0-9_-]{1,64}$`), `${kind} id must look like ${prefix}-<slug>`);
}

/**
 * Validity is the *current* answer, never a rewrite of history.
 *
 * A record is immutable; invalidation and supersession append new events and
 * flip this projection. `SUPERSEDED` differs from `INVALIDATED`: superseded
 * means a newer record replaces it (the original may still have been true when
 * written); invalidated means it should no longer be relied on at all.
 */
export const ValiditySchema = z.enum(["VALID", "INVALIDATED", "SUPERSEDED"]);
export type Validity = z.infer<typeof ValiditySchema>;

/**
 * The epistemic ladder (kernel doc §6). A LESSON must never auto-promote to
 * VERIFIED_KNOWLEDGE — promotion requires its own evidence and is itself a
 * recorded event. This enum exists so that constraint is expressible in the
 * type system rather than only in prose.
 */
export const EPISTEMIC_RUNGS = ["OBSERVATION", "LESSON", "HYPOTHESIS", "VERIFIED_KNOWLEDGE"] as const;
export const EpistemicRungSchema = z.enum(EPISTEMIC_RUNGS);
export type EpistemicRung = z.infer<typeof EpistemicRungSchema>;

/** Rung index, for asserting that promotion never skips or auto-advances. */
export function rungIndex(rung: EpistemicRung): number {
  return EPISTEMIC_RUNGS.indexOf(rung);
}

/** Confidence in [0,1]. Recorded only where something actually reads it. */
export const ConfidenceSchema = z.number().min(0).max(1);
