/**
 * ResourceMeasurement v1 — the constraints that keep the amortization metric
 * from lying, exercised rather than described.
 */
import { describe, expect, it } from "vitest";
import { CONTRACT_VERSION } from "../contracts/index.js";
import {
  RESOURCE_MEASUREMENT_VERSION,
  ResourceMeasurementSchema,
  coverageOf,
} from "./measurement.js";

const base = {
  schemaVersion: RESOURCE_MEASUREMENT_VERSION,
  subject: { executionId: "EXEC-run-1", subjectId: "DEC-0001", taskClass: "install-plan-review" },
  executor: { deterministic: false, model: "some-model", modelVersion: "2026-01" },
  provenance: { by: "worker-runtime/1.0.0", at: "2026-08-24T20:00:00Z" },
  measuredAt: "2026-08-24T20:00:00Z",
};

describe("independence from the frozen semantic contracts", () => {
  it("carries its own version, so the cost model can evolve alone", () => {
    // They happen to be equal today. The point is that nothing requires them
    // to stay equal — that is what "versioned independently" means, and this
    // test exists so a later divergence is expected rather than alarming.
    expect(RESOURCE_MEASUREMENT_VERSION).toBe("1.0.0");
    expect(typeof CONTRACT_VERSION).toBe("string");
  });

  it("references the record by id — the frozen record never points back", () => {
    const m = ResourceMeasurementSchema.parse(base);
    expect(m.subject.subjectId).toBe("DEC-0001");
  });

  it("rejects a subject id that is not a prefixed record id", () => {
    expect(ResourceMeasurementSchema.safeParse({ ...base, subject: { ...base.subject, subjectId: "../etc/passwd" } }).success).toBe(false);
  });
});

describe("absent means unknown, never zero", () => {
  it("accepts a measurement carrying only what was measured", () => {
    const m = ResourceMeasurementSchema.parse({
      ...base,
      wallClock: { value: 12.5, unit: "ms", knownBy: "MEASURED" },
      unobserved: ["inputTokens", "outputTokens"],
    });
    expect(m.inputTokens).toBeUndefined();
    expect(m.unobserved).toContain("inputTokens");
  });

  it("refuses a quantity recorded as UNKNOWN with a value", () => {
    // This is the failure mode the whole design guards: an unobservable
    // quantity written down as 0 makes an execution look free, and the
    // amortization ratio would then improve exactly when instrumentation was
    // lost — reporting success as a consequence of going blind.
    const r = ResourceMeasurementSchema.safeParse({
      ...base,
      inputTokens: { value: 0, unit: "tokens", knownBy: "UNKNOWN" },
    });
    expect(r.success).toBe(false);
  });

  it("refuses a negative or non-finite quantity", () => {
    expect(ResourceMeasurementSchema.safeParse({ ...base, wallClock: { value: -1, unit: "ms", knownBy: "MEASURED" } }).success).toBe(false);
    expect(ResourceMeasurementSchema.safeParse({ ...base, wallClock: { value: Infinity, unit: "ms", knownBy: "MEASURED" } }).success).toBe(false);
  });

  it("refuses a quantity in the wrong unit", () => {
    expect(ResourceMeasurementSchema.safeParse({ ...base, wallClock: { value: 1, unit: "us", knownBy: "MEASURED" } }).success).toBe(false);
  });
});

describe("an estimate is never mistaken for a measurement", () => {
  it("requires an estimated cost to name the price table that produced it", () => {
    const withoutTable = ResourceMeasurementSchema.safeParse({
      ...base,
      estimatedCost: { value: 0.02, currency: "USD", knownBy: "ESTIMATED" },
    });
    expect(withoutTable.success, "a cost without its price basis is not comparable across time").toBe(false);

    const withTable = ResourceMeasurementSchema.safeParse({
      ...base,
      estimatedCost: { value: 0.02, currency: "USD", priceTable: "vendor-2026-08", knownBy: "ESTIMATED" },
    });
    expect(withTable.success).toBe(true);
  });

  it("refuses to let an estimate claim to be measured", () => {
    const r = ResourceMeasurementSchema.safeParse({
      ...base,
      estimatedCost: { value: 0.02, currency: "USD", priceTable: "t", knownBy: "MEASURED" },
    });
    expect(r.success).toBe(false);
  });
});

describe("a deterministic execution cannot report token usage", () => {
  it("rejects the contradiction outright", () => {
    // The amortization target is a task class that stops needing a model. A
    // record claiming both would make that transition unmeasurable.
    const r = ResourceMeasurementSchema.safeParse({
      ...base,
      executor: { deterministic: true },
      inputTokens: { value: 100, unit: "tokens", knownBy: "ATTESTED" },
    });
    expect(r.success).toBe(false);
  });

  it("accepts a deterministic execution with only measured cost — the goal state", () => {
    const m = ResourceMeasurementSchema.parse({
      ...base,
      executor: { deterministic: true },
      wallClock: { value: 1.2, unit: "ms", knownBy: "MEASURED" },
      cpuUser: { value: 900, unit: "us", knownBy: "MEASURED" },
    });
    expect(m.executor.deterministic).toBe(true);
  });
});

describe("coverage travels with every ratio", () => {
  it("reports how much of the sample was actually observed", () => {
    const withTokens = ResourceMeasurementSchema.parse({
      ...base,
      inputTokens: { value: 12000, unit: "tokens", knownBy: "ATTESTED" },
      wallClock: { value: 18000, unit: "ms", knownBy: "MEASURED" },
    });
    const blind = ResourceMeasurementSchema.parse({ ...base, unobserved: ["inputTokens"] });
    const solved = ResourceMeasurementSchema.parse({
      ...base,
      executor: { deterministic: true },
      wallClock: { value: 1.2, unit: "ms", knownBy: "MEASURED" },
    });

    const c = coverageOf([withTokens, blind, solved]);
    expect(c.samples).toBe(3);
    expect(c.withTokens, "only one sample carried tokens at all").toBe(1);
    expect(c.withWallClock).toBe(2);
    expect(c.deterministic, "one execution needed no model — the amortization signal").toBe(1);
  });

  it("distinguishes an empty sample from a fully-covered one", () => {
    expect(coverageOf([])).toEqual({ samples: 0, withTokens: 0, withWallClock: 0, deterministic: 0 });
  });
});
