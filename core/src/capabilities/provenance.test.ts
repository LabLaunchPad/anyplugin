/**
 * F9 — capability provenance, without weakening UNKNOWN-by-construction.
 *
 * The instruction that produced this work asked for `evidenceRef` and
 * `observedAt` on "the two UNKNOWN capability rows". There are no such rows:
 * `Verdict.level` is `Exclude<SupportLevel, "UNKNOWN">`, and `supports()`
 * returns UNKNOWN from `row.capabilities[cap]?.level ?? "UNKNOWN"` — UNKNOWN is
 * the **absence of a key**, never a value. Creating a row to hold provenance
 * would have meant inventing a verdict for a combination nobody audited, which
 * is the one thing the capability model exists to prevent.
 *
 * The real gap was different and is what this closes: verdicts assert audited
 * facts while their provenance lived in **free-text prose**. The audit date for
 * `opencode@v1` survived only as the phrase "(docs verified 2026-08)" inside a
 * rationale string — unqueryable, and invisible to any staleness check. The
 * file header claims "Rows cite audited facts"; until now no test could confirm
 * that any audit had ever happened.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VARIANTS,
  auditedSurfaces,
  provenance,
  rationale,
  supports,
  surfacesWithoutObservedAt,
  type Capability,
} from "./matrix.js";

const ISO_DATE = /^\d{4}-\d{2}(-\d{2})?$/;

describe("UNKNOWN remains an absence, not a value", () => {
  it("an unaudited agent surface has no verdict and no provenance", () => {
    expect(supports("opencode", "v9", "skills")).toBe("UNKNOWN");
    expect(provenance("opencode", "v9"), "inventing provenance would assert an audit happened").toBeUndefined();
  });

  it("an audited surface still returns UNKNOWN for a capability it never audited", () => {
    // codex mcp.http is the canonical case: mcp.stdio IS audited on the same
    // row, so this is absence of a key, not absence of a row.
    expect(supports("codex", ">=0.147", "mcp.stdio")).toBe("NATIVE");
    expect(supports("codex", ">=0.147", "mcp.http")).toBe("UNKNOWN");
    expect(rationale("codex", ">=0.147", "mcp.http"), "an unaudited capability has nothing to say").toBe("");
  });

  it("opencode@v2 is UNSUPPORTED for hooks and UNKNOWN for mcp — different states", () => {
    // Conflating these would be the misreport corrected as C1 in the ledger.
    expect(supports("opencode", "v2", "hooks.session-start")).toBe("UNSUPPORTED");
    expect(rationale("opencode", "v2", "hooks.session-start")).toContain("dropped the v1 hook API");
    expect(supports("opencode", "v2", "mcp.stdio")).toBe("UNKNOWN");
    expect(supports("opencode", "v2", "mcp.http")).toBe("UNKNOWN");
  });

  it("row provenance never leaks into an unaudited capability's verdict", () => {
    // The row IS audited and HAS provenance; that must not imply a verdict for
    // every capability on it.
    expect(provenance("codex", ">=0.147")).toBeDefined();
    expect(supports("codex", ">=0.147", "mcp.http")).toBe("UNKNOWN");
  });
});

describe("audited surfaces carry structured provenance", () => {
  it("every audited surface records what was consulted", () => {
    for (const key of auditedSurfaces()) {
      const [agent, variant] = key.split("@") as [string, string];
      const p = provenance(agent as never, variant);
      expect(p, key).toBeDefined();
      expect(p!.source.length, `${key} names no source`).toBeGreaterThan(10);
      expect(p!.observedAt, `${key} observedAt must be a date or the literal UNKNOWN`).toMatch(
        new RegExp(`${ISO_DATE.source}|^UNKNOWN$`),
      );
    }
  });

  it("the one recorded audit date survived the move out of prose", () => {
    // This is why the field exists: the date was real, and it was trapped in a
    // rationale string where nothing could read it.
    const p = provenance("opencode", "v1");
    expect(p?.observedAt).toBe("2026-08");
    expect(p?.source).toContain("opencode official plugin API docs");
  });

  it("every default variant resolves to an audited surface", () => {
    // A default pointing at an unaudited surface would make every build for
    // that agent fail closed — correct, but it would be a packaging bug.
    for (const [agent, variant] of Object.entries(DEFAULT_VARIANTS)) {
      expect(provenance(agent as never, variant), `${agent}@${variant}`).toBeDefined();
    }
  });
});

describe("the unrecorded-audit-date deficit is counted, and ratcheted", () => {
  /**
   * Four of five surfaces assert verdicts with no recorded audit date. That is
   * a real deficit and it is deliberately NOT hidden: the verdicts stand, but
   * nothing can reason about whether they have gone stale.
   *
   * The ratchet freezes the count so it can only shrink. A NEW surface must
   * record when it was checked; an existing one stays honest about the fact
   * that nobody did. Without the ratchet, "required field, UNKNOWN allowed"
   * would decay into "required field, always UNKNOWN".
   */
  const KNOWN_DEFICIT = 4;

  it("is exactly the surfaces whose audit date was never written down", () => {
    expect(surfacesWithoutObservedAt().sort()).toEqual(
      ["antigravity@current", "claude-code@latest", "codex@>=0.147", "opencode@v2"].sort(),
    );
  });

  it("never grows — a new surface must record its audit date", () => {
    expect(
      surfacesWithoutObservedAt().length,
      "a surface was added or changed without recording when it was audited; " +
        "record the date, or lower KNOWN_DEFICIT if one was resolved",
    ).toBeLessThanOrEqual(KNOWN_DEFICIT);
  });

  it("UNKNOWN provenance does not weaken the verdict it accompanies", () => {
    // claude-code has no recorded audit date and still asserts NATIVE. That is
    // the honest position: the claim stands, its freshness is unknown. If this
    // ever downgraded the verdict, an unrecorded date would silently break
    // builds — a much worse failure than an unmeasurable one.
    expect(provenance("claude-code", "latest")?.observedAt).toBe("UNKNOWN");
    expect(supports("claude-code", "latest", "mcp.http")).toBe("NATIVE");
  });
});

describe("the guards can fail", () => {
  /**
   * Anti-vacuity (see docs/ai-native/reusable-procedures.md). Each check below
   * constructs the false state in-line and confirms the shape of the assertion
   * would catch it, so these tests cannot pass against a model where UNKNOWN
   * has quietly become a verdict.
   */
  it("would catch a fabricated verdict for an unaudited capability", () => {
    const real = supports("codex", ">=0.147", "mcp.http");
    const fabricated: string = "NATIVE";
    expect(real).not.toBe(fabricated);
    expect(real).toBe("UNKNOWN");
  });

  it("would catch provenance invented for an unaudited surface", () => {
    const real = provenance("codex", "v0.1-nonexistent");
    expect(real).toBeUndefined();
  });

  it("distinguishes 'no verdict' from every real verdict level", () => {
    const levels = new Set(
      (["mcp.stdio", "skills", "knowledge"] as Capability[]).map((c) => supports("codex", ">=0.147", c)),
    );
    expect(levels.has("UNKNOWN"), "audited capabilities must not report UNKNOWN").toBe(false);
  });
});
