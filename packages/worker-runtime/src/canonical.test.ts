import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalJson, contentHash, isContentHash } from "./canonical.js";

describe("canonical serialization", () => {
  it("is insensitive to key insertion order", () => {
    const a = { beta: 1, alpha: { z: 1, a: 2 }, gamma: [3, 1, 2] };
    const b = { gamma: [3, 1, 2], alpha: { a: 2, z: 1 }, beta: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(contentHash(a)).toBe(contentHash(b));
  });

  it("preserves array order, because order is semantic", () => {
    expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
  });

  it("distinguishes absent from explicitly null", () => {
    // If these collided, a record could change meaning without changing hash.
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(canonicalJson({ a: 1, b: null })).toBe('{"a":1,"b":null}');
    expect(contentHash({ a: 1, b: undefined })).not.toBe(contentHash({ a: 1, b: null }));
  });

  it("normalizes -0 to 0", () => {
    expect(canonicalJson({ n: -0 })).toBe(canonicalJson({ n: 0 }));
  });

  /**
   * F14 — Unicode normalization.
   *
   * The same failure shape as the CRLF bug F13: one logical object, two byte
   * representations, two hashes. macOS normalizes filenames toward NFD while
   * Linux stores NFC, so a path or source string captured on two machines
   * would otherwise produce two hashes for one record.
   */
  describe("Unicode normalization (F14)", () => {
    const nfc = "café"; // é as a single code point
    const nfd = "café"; // e + combining acute

    it("the two forms really are distinct strings", () => {
      expect(nfc).not.toBe(nfd);
      expect(nfc.length).toBe(4);
      expect(nfd.length).toBe(5);
    });

    it("hashes NFC and NFD values identically", () => {
      expect(contentHash({ v: nfc })).toBe(contentHash({ v: nfd }));
    });

    it("hashes NFC and NFD keys identically", () => {
      expect(contentHash({ [nfc]: 1 })).toBe(contentHash({ [nfd]: 1 }));
    });

    it("rejects two keys that collapse to one field after normalization", () => {
      // Silently keeping one would drop data; silently merging would change it.
      expect(() => canonicalJson({ [nfc]: 1, [nfd]: 2 })).toThrow(/duplicate key after Unicode normalization/);
    });

    it("normalizes nested values too", () => {
      expect(contentHash({ a: { b: [nfc] } })).toBe(contentHash({ a: { b: [nfd] } }));
    });
  });

  /**
   * F15 — integers beyond ±(2^53-1) collapse.
   *
   * 9007199254740993 becomes 9007199254740992 as an f64, so two DIFFERENT
   * logical values would produce ONE hash. That is a collision: a false
   * negative in tamper detection, which is strictly worse than a false
   * positive. Refuse rather than hash a value we cannot round-trip.
   */
  describe("unsafe integers (F15)", () => {
    it("rejects integers outside the safe range", () => {
      expect(() => canonicalJson({ n: 9007199254740993 })).toThrow(/safe range/);
    });

    it("rejects large integral floats, which are equally indistinguishable", () => {
      // 1e300 is exactly representable, but 1e300 and 1e300+1 are not
      // distinguishable — so a tamper of +1 could not be detected.
      expect(() => canonicalJson({ n: 1e300 })).toThrow(/safe range/);
    });

    it("accepts the safe maximum and ordinary fractional values", () => {
      expect(() => canonicalJson({ n: 9007199254740991 })).not.toThrow();
      expect(() => canonicalJson({ n: 0.91 })).not.toThrow();
      expect(() => canonicalJson({ n: 1.5e10 })).not.toThrow();
    });
  });

  it("is stable across repeated invocations", () => {
    const record = { id: "EVID-1", tags: ["b", "a"], meta: { nested: { deep: true } } };
    const first = canonicalJson(record);
    for (let i = 0; i < 50; i += 1) expect(canonicalJson(record)).toBe(first);
  });

  it("sorts keys recursively, not just at the top level", () => {
    expect(canonicalJson({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}');
  });

  it("emits no insignificant whitespace", () => {
    expect(canonicalJson({ a: 1, b: [1, 2] })).toBe('{"a":1,"b":[1,2]}');
  });

  describe("rejects values JSON.stringify would silently corrupt", () => {
    it("rejects NaN and Infinity rather than emitting null", () => {
      // JSON.stringify({n: NaN}) === '{"n":null}' — two different records
      // would otherwise hash identically.
      expect(() => canonicalJson({ n: NaN })).toThrow(CanonicalizationError);
      expect(() => canonicalJson({ n: Infinity })).toThrow(CanonicalizationError);
      expect(() => canonicalJson({ n: -Infinity })).toThrow(CanonicalizationError);
    });

    it("rejects undefined array elements rather than emitting null", () => {
      expect(() => canonicalJson([1, undefined, 3])).toThrow(CanonicalizationError);
    });

    it("rejects Date, which serializes engine- and locale-dependently", () => {
      expect(() => canonicalJson({ at: new Date() })).toThrow(/ISO-8601/);
    });

    it("rejects bigint, function, and symbol", () => {
      expect(() => canonicalJson({ n: 1n })).toThrow(CanonicalizationError);
      expect(() => canonicalJson({ f: () => 1 })).toThrow(CanonicalizationError);
      expect(() => canonicalJson({ s: Symbol("x") })).toThrow(CanonicalizationError);
    });

    it("names the offending path so failures are debuggable", () => {
      expect(() => canonicalJson({ outer: { inner: [0, NaN] } })).toThrow(/outer\.inner\[1\]/);
    });
  });
});

describe("content hashing", () => {
  it("produces an algorithm-prefixed hex digest", () => {
    const h = contentHash({ a: 1 });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(isContentHash(h)).toBe(true);
  });

  it("changes when any field changes", () => {
    const base = { id: "D-1", outcome: "accepted" };
    expect(contentHash(base)).not.toBe(contentHash({ ...base, outcome: "rejected" }));
  });

  it("changes when a nested field changes", () => {
    const base = { id: "D-1", ctx: { commit: "abc" } };
    expect(contentHash(base)).not.toBe(contentHash({ id: "D-1", ctx: { commit: "abd" } }));
  });

  it("rejects malformed hashes", () => {
    expect(isContentHash("sha256:xyz")).toBe(false);
    expect(isContentHash("a".repeat(64))).toBe(false);
    expect(isContentHash(`md5:${"a".repeat(32)}`)).toBe(false);
    expect(isContentHash(`sha256:${"A".repeat(64)}`)).toBe(false); // uppercase not canonical
  });

  it("is a known-answer match, pinning the format against accidental change", () => {
    // Golden value. If this changes, every previously issued certificate
    // becomes unverifiable — so a change here must be a deliberate, versioned
    // migration, never a refactor side effect.
    expect(contentHash({ a: 1, b: "two" })).toBe(
      "sha256:f15bfc93d70801047473922f67fed863ecc7f82f0677ebb7122923aee81e0f97",
    );
  });
});
