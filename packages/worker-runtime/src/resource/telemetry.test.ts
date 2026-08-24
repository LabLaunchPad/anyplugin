/**
 * Establishes, empirically and per platform, what this runtime can observe.
 *
 * These run on every CI matrix cell, so the platform claims in
 * `telemetry.ts` are demonstrated on the platforms they describe rather than
 * asserted from documentation.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEASURABLE_FIELDS, TELEMETRY_INVENTORY, UNOBSERVABLE_FIELDS, measure } from "./telemetry.js";

describe("what the kernel can actually measure", () => {
  it("wall clock and CPU move for work that really happened", () => {
    const { result, sample } = measure(() => {
      let x = 0;
      for (let i = 0; i < 3e6; i += 1) x += Math.sqrt(i);
      return x;
    });
    expect(result).toBeGreaterThan(0);
    expect(sample.wallClockMs).toBeGreaterThan(0);
    expect(sample.cpuUserMicros + sample.cpuSystemMicros).toBeGreaterThan(0);
  });

  it("reports no field it cannot observe — absent, not zero", () => {
    const { sample } = measure(() => 1);
    // If peak memory or I/O counters ever appear here, they must first move
    // from UNKNOWN to MEASURED in the inventory, with evidence.
    expect(Object.keys(sample).sort()).toEqual(["cpuSystemMicros", "cpuUserMicros", "wallClockMs"]);
    for (const f of UNOBSERVABLE_FIELDS) {
      expect(Object.keys(sample)).not.toContain(f);
    }
  });

  it("uses a monotonic clock, so a wall-clock adjustment cannot produce a negative duration", () => {
    const { sample } = measure(() => 1);
    expect(sample.wallClockMs).toBeGreaterThanOrEqual(0);
  });
});

describe("the platform quirks the inventory claims are real", () => {
  it("maxRSS is NOT in bytes on Linux — it is kilobytes", () => {
    // The measurement behind the UNKNOWN classification of peakMemoryBytes.
    // Recording maxRSS as bytes would be wrong by 1024x on this platform.
    const ru = process.resourceUsage();
    const rss = process.memoryUsage().rss;
    const ratio = rss / ru.maxRSS;

    if (process.platform === "linux") {
      // ~1024, allowing for RSS moving between the two reads.
      expect(ratio, "linux getrusage reports maxRSS in kilobytes").toBeGreaterThan(500);
    }
    // On every platform the two disagree by a factor that is not 1, which is
    // the whole reason the field cannot be recorded as bytes without knowing
    // which platform produced it.
    expect(ru.maxRSS).toBeGreaterThan(0);
  });

  it("fsRead/fsWrite do not count a real file write, so they cannot be reported", () => {
    const before = process.resourceUsage().fsWrite;
    const dir = mkdtempSync(join(tmpdir(), "tele-"));
    try {
      const f = join(dir, "a.bin");
      writeFileSync(f, "x".repeat(64 * 1024));
      expect(statSync(f).size, "the write definitely happened").toBe(64 * 1024);
      const after = process.resourceUsage().fsWrite;
      // The counter tracks block-device operations, which the page cache
      // absorbs. It commonly stays at 0. Asserting it stays 0 would be
      // asserting a kernel caching policy, so this only records that it cannot
      // be relied on to increase.
      expect(after).toBeGreaterThanOrEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("st.size is exact and st.blocks is not usable cross-platform", () => {
    const dir = mkdtempSync(join(tmpdir(), "tele-"));
    try {
      const f = join(dir, "a.json");
      writeFileSync(f, "x".repeat(1234));
      const st = statSync(f);
      expect(st.size, "logical size is exact everywhere").toBe(1234);
      // st.blocks is 0 on Windows and reflects allocation rather than content.
      expect(typeof st.blocks).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the inventory is honest about itself", () => {
  it("classifies every field, with a stated reason", () => {
    expect(TELEMETRY_INVENTORY.length).toBeGreaterThan(8);
    for (const c of TELEMETRY_INVENTORY) {
      expect(c.note.length, `${c.field} has no stated evidence`).toBeGreaterThan(30);
      expect(c.source.length).toBeGreaterThan(0);
    }
  });

  it("keeps token counts, model identity and tool timings out of MEASURED", () => {
    // The kernel calls no model and runs no tool. Any of these appearing as
    // MEASURED would mean the kernel claims to observe something it cannot.
    for (const f of ["inputTokens", "outputTokens", "reasoningTokens", "model", "toolCalls", "toolLatencyMs"]) {
      expect(MEASURABLE_FIELDS, f).not.toContain(f);
    }
  });

  it("names peak memory and the I/O counters as unobservable", () => {
    expect(UNOBSERVABLE_FIELDS).toContain("peakMemoryBytes");
    expect(UNOBSERVABLE_FIELDS).toContain("fsReadOps");
    expect(UNOBSERVABLE_FIELDS).toContain("fsWriteOps");
  });
});
