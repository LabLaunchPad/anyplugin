/**
 * ResourceMeasurement v1 — the amortization instrument, deliberately OUTSIDE
 * the frozen semantic contracts.
 *
 * The ten contracts at 1.0.0 record what is true: what was decided, on what
 * evidence, verified how. A resource measurement records what an execution
 * *cost*, which is an observation about a run and not part of the decision's
 * truth. Two runs producing the identical decision from identical evidence are
 * the same decision, whether one took 800 tokens and the other 12,000 — that
 * difference is precisely the signal being measured, so it cannot also be part
 * of the identity of the thing being compared.
 *
 * Keeping it separate has a concrete consequence rather than an aesthetic one.
 * Cost models change constantly — prices move, providers add token classes,
 * new counters become observable. Had these fields lived in `Decision` or
 * `Certificate`, every such change would alter those records' content hashes
 * and break certificate compatibility. Versioned separately, the resource model
 * can evolve without invalidating a single issued hash.
 *
 *   Decision 1.0.0 ──referenced by──▶ ResourceMeasurement 1.0.0
 *   (frozen, model-agnostic)          (evolves independently)
 *
 * This is also the only place a model identity is recorded. The frozen
 * contracts carry no `model` or `provider` field, and that stays true: a
 * decision must not depend on which model produced it. But a *measurement* of
 * an execution that is not attributed to what ran is not a measurement.
 *
 * ── The rule that makes the metric trustworthy ─────────────────────────────
 *
 * Every quantity carries how it is known (`MEASURED` / `DERIVED` / `ESTIMATED`
 * / `ATTESTED`), and anything unobservable is simply ABSENT. Absent means
 * unknown. It never means zero.
 *
 * That distinction is load-bearing: a missing token count defaulted to 0 makes
 * an execution look free, and an amortization ratio computed from it would show
 * the system improving precisely when it stopped being able to see. The metric
 * would report success as a consequence of losing instrumentation. Every
 * aggregate therefore reports its own coverage, so a ratio can never be read
 * without knowing how much of it was actually observed.
 */
import { z } from "zod";
import { ProvenanceSchema, TimestampSchema } from "../contracts/primitives.js";
import { KNOWN_BY } from "./telemetry.js";

/**
 * Versioned INDEPENDENTLY of CONTRACT_VERSION. That independence is the whole
 * point: this may reach 2.0.0 while the semantic contracts stay at 1.0.0.
 */
export const RESOURCE_MEASUREMENT_VERSION = "1.0.0";

export const KnownBySchema = z.enum(KNOWN_BY);

/**
 * A quantity together with how it came to be known.
 *
 * A bare number would lose the distinction between "we measured 4,000 tokens"
 * and "a price table guessed 4,000 tokens", and those must never be summed
 * into one figure as though they were the same kind of fact.
 */
const Quantity = (unit: string) =>
  z
    .object({
      value: z.number().finite().nonnegative(),
      unit: z.literal(unit),
      knownBy: KnownBySchema,
    })
    .strict()
    .refine((q) => q.knownBy !== "UNKNOWN", {
      message: "a quantity classified UNKNOWN must be omitted entirely, not recorded with a value — absent means unknown, never zero",
    });

/** Identifies the execution being measured, and the record it produced. */
export const MeasurementSubjectSchema = z
  .object({
    /** Opaque id of the run. Groups measurements belonging to one execution. */
    executionId: z.string().regex(/^EXEC-[A-Za-z0-9_-]{1,64}$/, "executionId must be EXEC-<id>"),
    /**
     * The record this execution produced, by id — a Decision, WorkContract, or
     * VerificationResult. The reference points measurement→record and never the
     * reverse, so the frozen record stays unaware it is being measured.
     */
    subjectId: z.string().regex(/^[A-Z]{2,4}-[A-Za-z0-9_-]{1,64}$/, "subjectId must be a prefixed record id"),
    /**
     * The task CLASS this execution belongs to. Amortization is only meaningful
     * within a class: "the same kind of problem, solved again". Without it there
     * is nothing to compare a later run against.
     */
    taskClass: z.string().min(1).max(128),
  })
  .strict();

/**
 * What ran. ATTESTED, not measured — the kernel cannot observe it and does not
 * pretend to. Optional in full: an execution with no model involved is a
 * legitimate and, for this metric, extremely interesting case.
 */
export const ExecutorSchema = z
  .object({
    model: z.string().min(1).max(128).optional(),
    modelVersion: z.string().min(1).max(128).optional(),
    /** True when the execution used no model at all — the amortization target. */
    deterministic: z.boolean(),
  })
  .strict();

export const ResourceMeasurementSchema = z
  .object({
    schemaVersion: z.literal(RESOURCE_MEASUREMENT_VERSION),
    subject: MeasurementSubjectSchema,
    executor: ExecutorSchema,
    provenance: ProvenanceSchema,
    measuredAt: TimestampSchema,

    // ── Measured by the kernel itself ──────────────────────────────────────
    wallClock: Quantity("ms").optional(),
    cpuUser: Quantity("us").optional(),
    cpuSystem: Quantity("us").optional(),
    storage: Quantity("bytes").optional(),

    // ── Attested by the caller: the kernel calls no model and runs no tool ──
    inputTokens: Quantity("tokens").optional(),
    outputTokens: Quantity("tokens").optional(),
    reasoningTokens: Quantity("tokens").optional(),
    toolCalls: Quantity("calls").optional(),
    toolLatency: Quantity("ms").optional(),

    /**
     * An opinion with an expiry date. Recorded with the table that produced it,
     * because a cost without its price basis is not comparable across time —
     * and comparing across time is the only thing this field is for.
     */
    estimatedCost: z
      .object({
        value: z.number().finite().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/, "ISO-4217 currency code"),
        priceTable: z.string().min(1),
        knownBy: z.literal("ESTIMATED"),
      })
      .strict()
      .optional(),

    /**
     * Fields that were expected for this task class but could not be observed.
     * Recording the gap explicitly is what stops a shrinking measurement from
     * being misread as a shrinking cost.
     */
    unobserved: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .refine((m) => !(m.executor.deterministic && (m.inputTokens ?? m.outputTokens ?? m.reasoningTokens)), {
    message: "an execution marked deterministic cannot report token usage — one of the two claims is false",
  });

export type ResourceMeasurement = z.infer<typeof ResourceMeasurementSchema>;

/**
 * Coverage of a set of measurements for one task class: the share that carried
 * each quantity at all.
 *
 * Reported alongside every amortization ratio, never separately. A ratio that
 * improved because instrumentation was lost looks identical to a ratio that
 * improved because the system got better — coverage is the only thing that
 * distinguishes them, and it is the reason this returns a pair rather than a
 * number.
 */
export interface Coverage {
  readonly samples: number;
  readonly withTokens: number;
  readonly withWallClock: number;
  readonly deterministic: number;
}

export function coverageOf(measurements: readonly ResourceMeasurement[]): Coverage {
  return {
    samples: measurements.length,
    withTokens: measurements.filter((m) => m.inputTokens !== undefined || m.outputTokens !== undefined).length,
    withWallClock: measurements.filter((m) => m.wallClock !== undefined).length,
    deterministic: measurements.filter((m) => m.executor.deterministic).length,
  };
}
