/**
 * Characterization test: record ids cannot produce a path hazard.
 *
 * This pins the property that decides whether the kernel needs a SafePath
 * primitive at all for its ledger writes. `idSchema` constrains ids to
 * `PREFIX-[A-Za-z0-9_-]{1,64}`, a character class that excludes every path
 * metacharacter — separators, dots, NUL, control characters, drive letters,
 * and percent-encoding. Joining an accepted id to the storage root therefore
 * cannot traverse or escape it.
 *
 * This is a STRICTER boundary than lexical path validation, not a weaker one:
 * `assertSafeRelative` accepts `a/b/c` and `a.b`, which this rejects outright.
 *
 * If this property is ever relaxed — a new id kind permitting dots or
 * separators, or a raw user string used as a filename — the kernel acquires an
 * untrusted-input-to-path boundary and MUST adopt a real SafePath primitive.
 * These tests are the tripwire for that change.
 */
import { describe, expect, it } from "vitest";
import { ID_PREFIXES, idSchema, type IdKind } from "./primitives.js";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";

const ALL_KINDS = Object.keys(ID_PREFIXES) as IdKind[];

/**
 * Inputs that would escape, traverse, or confuse a filesystem join.
 *
 * Note `-` is deliberately NOT here: it is inside the legal character class,
 * and `WC--.json` is a harmless filename on every platform. Listing it would
 * assert a falsehood — the id contract is allowed to accept it.
 */
const HOSTILE = [
  "../../etc/passwd", "..", "../x", "a/b", "a\\b", "a\u0000b",
  "/abs", "C:/drive", "\\\\server\\share", ".", "a.b", "a..b",
  "%2e%2e%2f", "\u202e", "a b", "café", "a:b", "a|b", "a*b",
  "a\rb", "a\nb", "a\tb", "", " ", "a/../b", "./a",
];

describe("record ids cannot become a path hazard", () => {
  it("rejects every hostile suffix, for every id kind", () => {
    for (const kind of ALL_KINDS) {
      const schema = idSchema(kind);
      const prefix = ID_PREFIXES[kind];
      for (const suffix of HOSTILE) {
        const candidate = `${prefix}-${suffix}`;
        expect(schema.safeParse(candidate).success, `${kind}: ${JSON.stringify(candidate)}`).toBe(false);
      }
    }
  });

  it("rejects a bare hostile string with no prefix", () => {
    for (const kind of ALL_KINDS) {
      const schema = idSchema(kind);
      for (const bad of ["../../etc/passwd", "/abs", "CON", "NUL"]) {
        expect(schema.safeParse(bad).success, `${kind}: ${bad}`).toBe(false);
      }
    }
  });

  it("accepts only [A-Za-z0-9_-] after the prefix", () => {
    const schema = idSchema("evidence");
    expect(schema.safeParse("EV-abc_DEF-123").success).toBe(true);
    expect(schema.safeParse(`EV-${"a".repeat(64)}`).success).toBe(true);
    // bounded: an unbounded id could exhaust a filesystem name limit
    expect(schema.safeParse(`EV-${"a".repeat(65)}`).success).toBe(false);
    expect(schema.safeParse("EV-").success).toBe(false);
  });

  it("cannot express a Windows reserved device name, because the prefix is mandatory", () => {
    // CON/PRN/AUX/NUL/COM1-9/LPT1-9 are reserved as the *basename*. Every
    // accepted id is `PREFIX-...`, so it can never equal one of them.
    const reserved = ["CON", "PRN", "AUX", "NUL", "COM1", "LPT1"];
    for (const kind of ALL_KINDS) {
      const schema = idSchema(kind);
      for (const r of reserved) {
        expect(schema.safeParse(r).success, `${kind}: bare ${r}`).toBe(false);
        // `EV-CON` IS accepted, and is safe precisely because it is not `CON`.
        const prefixed = `${ID_PREFIXES[kind]}-${r}`;
        expect(schema.safeParse(prefixed).success, `${kind}: ${prefixed}`).toBe(true);
        expect(prefixed).not.toBe(r);
      }
    }
  });

  it("a joined ledger path stays under the storage root, textually", () => {
    const schema = idSchema("evidence");
    for (const id of ["EV-1", "EV-abc_DEF-123", "EV-CON", `EV-${"z".repeat(64)}`]) {
      expect(schema.safeParse(id).success, id).toBe(true);
      const joined = `${STORAGE_ROOT_DIRNAME}/evidence/${id}.json`;
      expect(joined.startsWith(`${STORAGE_ROOT_DIRNAME}/`)).toBe(true);
      expect(joined).not.toContain("..");
      // no separator was introduced by the id itself
      expect(joined.split("/").length).toBe(3);
    }
  });
});
