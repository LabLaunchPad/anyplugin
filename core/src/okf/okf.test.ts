import { describe, it, expect } from "vitest";
import { parseDocument, serializeDocument, normalizeVerified, trustTier, isStale, validateBundle } from "./index.js";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("parseDocument", () => {
  it("parses frontmatter and body", () => {
    const doc = parseDocument('---\ntype: Metric\ntitle: Revenue\n---\n\n# Revenue\nBody here.');
    expect(doc.frontmatter["type"]).toBe("Metric");
    expect(doc.hasFrontmatter).toBe(true);
    expect(doc.body).toContain("# Revenue");
  });

  it("treats file without --- as pure body (empty frontmatter)", () => {
    const doc = parseDocument("Just body text.");
    expect(doc.hasFrontmatter).toBeNull();
    expect(doc.frontmatter).toEqual({});
    expect(doc.body).toBe("Just body text.");
  });

  it("detects unterminated frontmatter", () => {
    const doc = parseDocument("---\ntype: Metric\n");
    expect(doc.parseError).toMatch(/unterminated/);
  });

  it("rejects non-mapping frontmatter", () => {
    const doc = parseDocument("---\n- a\n- b\n---\n\nbody");
    expect(doc.parseError).toMatch(/not a mapping/);
  });

  it("keeps ISO timestamps as strings (YAML 1.2 core schema)", () => {
    const doc = parseDocument('---\ntype: T\ngenerated:\n  by: agent-prism/core@0.1.0\n  at: 2026-08-22T09:30:00+00:00\n---\n');
    expect((doc.frontmatter["generated"] as Record<string, unknown>)["at"]).toBe("2026-08-22T09:30:00+00:00");
  });
});

describe("serializeDocument round-trip", () => {
  it("preserves unknown keys verbatim", () => {
    const fm = { type: "Metric", "not": [{ term: "X", why: "Y", instead: "Z" }], custom: 42 };
    const text = serializeDocument(fm, "body");
    const back = parseDocument(text);
    expect(back.frontmatter["not"]).toEqual([{ term: "X", why: "Y", instead: "Z" }]);
    expect(back.frontmatter["custom"]).toBe(42);
    expect(back.body).toBe("body");
  });

  it("orders known keys first, unknown after", () => {
    const text = serializeDocument({ zzz: 1, title: "T", type: "Metric" }, "b");
    const fmBlock = text.split("---")[1] ?? "";
    expect(fmBlock.indexOf("type:")).toBeLessThan(fmBlock.indexOf("zzz:"));
  });
});

describe("trust tiers", () => {
  it("none → unverified", () => {
    expect(trustTier({ type: "T" })).toBe("unverified");
  });
  it("only non-human actors → machine-confirmed", () => {
    expect(trustTier({ type: "T", verified: [{ by: "agent-prism/core@0.1.0", at: "2026-08-22T00:00:00+00:00" }] })).toBe("machine-confirmed");
  });
  it("bare verified mapping normalizes to one-element list (human-reviewed)", () => {
    const fm = { type: "T", verified: { by: "human:jsmith", at: "2026-08-22T00:00:00+00:00" } };
    expect(normalizeVerified(fm)).toHaveLength(1);
    expect(trustTier(fm)).toBe("human-reviewed");
  });
});

describe("isStale", () => {
  const now = new Date("2026-08-22T00:00:00+00:00");
  it("stale when now >= stale_after", () => {
    expect(isStale({ type: "T", stale_after: "2026-08-21T00:00:00+00:00" }, now)).toBe(true);
    expect(isStale({ type: "T", stale_after: "2027-01-01T00:00:00+00:00" }, now)).toBe(false);
  });
  it("date-only / naive / invalid values are never stale (no error)", () => {
    expect(isStale({ type: "T", stale_after: "2026-08-21" }, now)).toBe(false);
    expect(isStale({ type: "T", stale_after: "2026-08-21T00:00:00" }, now)).toBe(false);
    expect(isStale({ type: "T", stale_after: "not a date" }, now)).toBe(false);
    expect(isStale({ type: "T" }, now)).toBe(false);
  });
});

describe("validateBundle", () => {
  it("enforces the official conformance matrix", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okf-"));
    await mkdir(join(dir, "agents"), { recursive: true });
    await writeFile(join(dir, "agents", "good.md"), '---\ntype: Agent Platform\ntitle: Good\nverified:\n  by: human:alice\n  at: 2026-08-22T00:00:00+00:00\n---\n\nok');
    await writeFile(join(dir, "agents", "notype.md"), "---\ntitle: No Type\n---\n\nbad");
    await writeFile(join(dir, "noYaml.md"), "no frontmatter at all");
    await writeFile(join(dir, "legacy.md"), '---\ntype: T\ntimestamp: 2026-01-01\n---\n\n# Citations\n- x');
    await writeFile(join(dir, "index.md"), '---\nokf_version: "0.2"\n---\n\n# Subdirectories\n');
    const issues = await validateBundle(dir);
    const errors = issues.filter((i) => i.level === "error");
    const warnings = issues.map((i) => `${i.file}:${i.rule}`);
    expect(errors.some((i) => i.file === "agents/notype.md" && i.rule === "type-required")).toBe(true);
    expect(errors.some((i) => i.file === "noYaml.md" && i.rule === "frontmatter")).toBe(true);
    expect(warnings.some((s) => s.includes("legacy.md:legacy-timestamp"))).toBe(true);
    expect(warnings.some((s) => s.includes("legacy.md:legacy-citations"))).toBe(true);
    // actor "jsmith" lacks human:/process: prefix and producer/version form → warning, never error
    await writeFile(join(dir, "agents", "actor.md"), '---\ntype: T\ntitle: Actor\nverified:\n  - by: jsmith\n    at: 2026-08-22T00:00:00+00:00\n---\n\nok');
    const allIssues = await validateBundle(dir);
    expect(allIssues.some((i) => i.file === "agents/actor.md" && i.rule === "verified-actor" && i.level === "warning")).toBe(true);
    // root index.md with only okf_version → no index-frontmatter error
    expect(errors.some((i) => i.rule === "index-frontmatter")).toBe(false);
    // missing title on notype/legacy → info only
    expect(issues.some((i) => i.level === "info" && i.rule === "title-recommended")).toBe(true);
  });

  it("errors when root index.md carries foreign frontmatter", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okf-"));
    await writeFile(join(dir, "index.md"), '---\ntype: Bad\n---\n\nbody');
    const issues = await validateBundle(dir);
    expect(issues.some((i) => i.rule === "index-frontmatter" && i.level === "error")).toBe(true);
  });

  it("requires runtime for Attested Computation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okf-"));
    await writeFile(join(dir, "comp.md"), "---\ntype: Attested Computation\n---\n\n# Computation\n```sql\nSELECT 1\n```");
    const issues = await validateBundle(dir);
    expect(issues.some((i) => i.rule === "ac-runtime" && i.level === "error")).toBe(true);
  });
});
