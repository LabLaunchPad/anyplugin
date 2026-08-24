/**
 * Telemetry observability inventory — what this runtime can ACTUALLY observe.
 *
 * Written BEFORE the ResourceMeasurement schema, deliberately. Defining the
 * schema first would have produced a plausible field list, and the fields that
 * cannot be measured would then have been filled with something — an estimate,
 * a zero, a default — and the amortization metric would be computed from
 * numbers nobody observed. A metric built on manufactured inputs cannot detect
 * its own wrongness.
 *
 * Every quantity is therefore classified by how it is KNOWN, not by whether it
 * would be nice to have:
 *
 *   MEASURED   read from a runtime API that is reliable on the platforms we test
 *   DERIVED    computed deterministically from measured values (arithmetic only)
 *   ESTIMATED  produced by a model or price table — an opinion, never a fact
 *   UNKNOWN    not observable here. Stays UNKNOWN; it is never defaulted to 0.
 *
 * The empirical findings that shaped this list, from probing the real APIs
 * rather than reading about them:
 *
 *   1. `process.resourceUsage().maxRSS` is NOT in bytes on every platform. On
 *      Linux it is KILOBYTES — measured directly: maxRSS × 1024 matched
 *      `memoryUsage().rss` exactly. macOS's getrusage reports bytes. Writing
 *      `peakMemoryBytes: maxRSS` would therefore be silently wrong by 1024× on
 *      one of them. This is AP-020's class again — one logical quantity, two
 *      representations — so peak memory is UNKNOWN until its unit is
 *      established per platform, which `telemetry.test.ts` does empirically.
 *
 *   2. `resourceUsage().fsRead` and `.fsWrite` both read ZERO immediately after
 *      writing a real file, because they count block-device operations and the
 *      write was absorbed by the page cache. A field that reports 0 for work
 *      that definitely happened is worse than an absent field: it looks like an
 *      answer. Classified UNKNOWN.
 *
 *   3. Token counts, model identity, and tool timings are not observable from
 *      inside the kernel at all — it never calls a model and has no tool
 *      executor. They must be SUPPLIED by the caller, which makes them
 *      attested rather than measured, and the schema records that difference.
 */

/** How a quantity came to be known. Never inferred; always recorded. */
export const KNOWN_BY = ["MEASURED", "DERIVED", "ESTIMATED", "ATTESTED", "UNKNOWN"] as const;
export type KnownBy = (typeof KNOWN_BY)[number];

export interface TelemetryCapability {
  readonly field: string;
  readonly knownBy: KnownBy;
  readonly source: string;
  /** Why it is classified this way — the evidence, not the intention. */
  readonly note: string;
}

/**
 * The inventory. This is the authority on what may appear as an authoritative
 * value in a ResourceMeasurement; a field absent here has no way to be filled
 * honestly.
 */
export const TELEMETRY_INVENTORY: readonly TelemetryCapability[] = [
  {
    field: "wallClockMs",
    knownBy: "MEASURED",
    source: "process.hrtime.bigint()",
    note: "monotonic; unaffected by wall-clock adjustments, unlike Date.now()",
  },
  {
    field: "cpuUserMicros",
    knownBy: "MEASURED",
    source: "process.cpuUsage().user",
    note: "microseconds on every supported platform; verified by test",
  },
  {
    field: "cpuSystemMicros",
    knownBy: "MEASURED",
    source: "process.cpuUsage().system",
    note: "microseconds on every supported platform; verified by test",
  },
  {
    field: "storageBytes",
    knownBy: "MEASURED",
    source: "fs.statSync().size",
    note: "exact logical size. st.blocks is NOT used: it is 0 on Windows and reflects allocation, not content",
  },
  {
    field: "peakMemoryBytes",
    knownBy: "UNKNOWN",
    source: "process.resourceUsage().maxRSS",
    note: "unit is platform-dependent — kilobytes on Linux (measured: maxRSS*1024 === rss), bytes on macOS. Not recorded as bytes until the unit is established per platform",
  },
  {
    field: "fsReadOps",
    knownBy: "UNKNOWN",
    source: "process.resourceUsage().fsRead",
    note: "measured 0 immediately after a real file write — counts block-device I/O, which the page cache absorbs. A field that reports 0 for work that happened is worse than an absent one",
  },
  {
    field: "fsWriteOps",
    knownBy: "UNKNOWN",
    source: "process.resourceUsage().fsWrite",
    note: "same as fsReadOps: measured 0 after a real write",
  },
  {
    field: "inputTokens",
    knownBy: "ATTESTED",
    source: "caller",
    note: "the kernel never calls a model; the number comes from the provider's response and is trusted, not observed",
  },
  {
    field: "outputTokens",
    knownBy: "ATTESTED",
    source: "caller",
    note: "as inputTokens: reported by the provider that generated them, so trusted rather than observed here",
  },
  {
    field: "reasoningTokens",
    knownBy: "ATTESTED",
    source: "caller",
    note: "as inputTokens, and not reported by every provider — absent means unreported, never zero",
  },
  {
    field: "model",
    knownBy: "ATTESTED",
    source: "caller",
    note: "recorded HERE and never in a semantic contract: the ten frozen contracts stay model-agnostic, while a measurement of an execution legitimately records what ran",
  },
  {
    field: "toolCalls",
    knownBy: "ATTESTED",
    source: "caller",
    note: "no tool executor exists in the kernel; becomes MEASURED only if one is built here",
  },
  {
    field: "toolLatencyMs",
    knownBy: "ATTESTED",
    source: "caller",
    note: "as toolCalls: the kernel does not invoke tools, so it cannot time them; becomes MEASURED only if an executor is built here",
  },
  {
    field: "estimatedCost",
    knownBy: "ESTIMATED",
    source: "external price table",
    note: "an opinion with an expiry date — prices change and are not a property of the execution. Never comparable across time without recording which table produced it",
  },
];

/** Fields that may carry an authoritative value measured by the kernel itself. */
export const MEASURABLE_FIELDS = TELEMETRY_INVENTORY.filter((c) => c.knownBy === "MEASURED").map((c) => c.field);

/** Fields that are NOT observable here and must never be defaulted to a number. */
export const UNOBSERVABLE_FIELDS = TELEMETRY_INVENTORY.filter((c) => c.knownBy === "UNKNOWN").map((c) => c.field);

/** A single measurement sample the kernel can take of its own work. */
export interface KernelSample {
  readonly wallClockMs: number;
  readonly cpuUserMicros: number;
  readonly cpuSystemMicros: number;
}

/**
 * Measure the cost of running `fn`, reporting only what is genuinely measured.
 *
 * Returns no peak-memory and no I/O counters: those are UNKNOWN per the
 * inventory above, and returning them as zero is exactly the manufactured
 * evidence this file exists to prevent.
 */
export function measure<T>(fn: () => T): { result: T; sample: KernelSample } {
  const cpu0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  const result = fn();
  const t1 = process.hrtime.bigint();
  const cpu = process.cpuUsage(cpu0);
  return {
    result,
    sample: {
      wallClockMs: Number(t1 - t0) / 1e6,
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
    },
  };
}
