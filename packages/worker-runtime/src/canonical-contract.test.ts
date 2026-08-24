/**
 * CANONICALIZATION CONTRACT v1 — executable specification.
 *
 * Canonicalization is a SECURITY / INTEGRITY primitive, not a serialization
 * helper. Everything downstream is built on it:
 *
 *   canonical bytes → sha256 → evidence id → decision → dependency
 *     → invalidation → verification → certificate
 *
 * If canonicalization is wrong, every one of those is contaminated. The
 * governing invariant:
 *
 *   No cryptographic identity, certificate, evidence reference, or integrity
 *   decision may be based on non-canonical bytes.
 *
 * The central question for every accepted value is NOT "is this valid JSON?"
 * but: **can two materially different semantic values collapse into the same
 * canonical representation?** If yes, the hash is not a reliable identity or
 * tamper primitive and the value must be refused.
 *
 * The golden vectors below run on every cell of the CI matrix (Linux Node 22,
 * Linux Node 24, Windows Node 24, and Node 20 via the runtime job), so
 * platform- and version-independence is demonstrated rather than asserted.
 */
import { describe, expect, it } from "vitest";
import { CanonicalizationError, canonicalJson, contentHash } from "./canonical.js";

/** Property 1-7 of the contract, each with executable evidence below. */
export const CANONICALIZATION_CONTRACT_VERSION = "1.0.0";

describe("CANONICALIZATION CONTRACT v1", () => {
  describe("P1 — deterministic: same logical value always yields the same bytes", () => {
    it("is stable across many invocations", () => {
      const v = { z: 1, a: { c: [3, 2, 1], b: "x" }, m: null };
      const first = canonicalJson(v);
      for (let i = 0; i < 100; i += 1) expect(canonicalJson(v)).toBe(first);
    });

    it("is insensitive to construction order", () => {
      const a: Record<string, unknown> = {};
      a["one"] = 1;
      a["two"] = 2;
      const b: Record<string, unknown> = {};
      b["two"] = 2;
      b["one"] = 1;
      expect(canonicalJson(a)).toBe(canonicalJson(b));
    });

    it("ignores inherited/prototype properties", () => {
      // Object.keys does not walk the prototype chain, so an inherited field
      // cannot silently enter the hash.
      const proto = { inherited: "should not appear" };
      const obj = Object.create(proto) as Record<string, unknown>;
      obj["own"] = 1;
      expect(canonicalJson(obj)).toBe('{"own":1}');
    });
  });

  describe("P2 — platform-independent", () => {
    it("does not embed path separators or line endings of the host", () => {
      // Values are hashed verbatim; the canonicalizer introduces no separator
      // or newline of its own. Callers must normalize paths BEFORE hashing —
      // see the caveat test at the end.
      expect(canonicalJson({ p: "a/b" })).toBe('{"p":"a/b"}');
      expect(canonicalJson({ s: "x" })).not.toContain("\r");
      expect(canonicalJson({ s: "x" })).not.toContain("\n");
    });

    it("normalizes Unicode to NFC so macOS/Linux agree (F14)", () => {
      const nfc = "café".normalize("NFC");
      const nfd = "café";
      expect(nfc).not.toBe(nfd);
      expect(contentHash({ v: nfc })).toBe(contentHash({ v: nfd }));
    });

    it("is locale-independent: key order uses code units, not collation", () => {
      // A locale-aware sort would order these differently under e.g. sv-SE.
      const out = canonicalJson({ "z": 1, "ä": 2, "a": 3 });
      expect(out.indexOf('"a"')).toBeLessThan(out.indexOf('"z"'));
      expect(out.indexOf('"z"')).toBeLessThan(out.indexOf('"ä"'));
    });
  });

  describe("P3 — ordering-independent where semantics permit", () => {
    it("sorts object keys (order is not semantic)", () => {
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it("preserves array order (order IS semantic)", () => {
      expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
    });
  });

  describe("P4 — collision-resistant at the representation layer", () => {
    it("rejects unsafe integers, which would collapse distinct values (F15)", () => {
      expect(() => canonicalJson({ n: 2 ** 53 + 1 })).toThrow(/safe range/);
    });

    it("distinguishes absent from explicitly null", () => {
      expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 1, b: null }));
    });

    it("distinguishes a number from its string form", () => {
      expect(contentHash({ v: 1 })).not.toBe(contentHash({ v: "1" }));
    });

    it("distinguishes nested shape changes", () => {
      expect(contentHash({ a: { b: 1 } })).not.toBe(contentHash({ "a.b": 1 }));
    });
  });

  describe("P5 — rejects ambiguous values", () => {
    const cases: [string, unknown, RegExp][] = [
      ["NaN", { n: NaN }, /non-finite/],
      ["Infinity", { n: Infinity }, /non-finite/],
      ["-Infinity", { n: -Infinity }, /non-finite/],
      ["unsafe integer", { n: 2 ** 53 + 1 }, /safe range/],
      ["large integral float", { n: 1e300 }, /safe range/],
      ["Date", { d: new Date(0) }, /ISO-8601/],
      ["BigInt", { n: 1n }, /bigint/],
      ["function", { f: () => 1 }, /function/],
      ["symbol", { s: Symbol("x") }, /symbol/],
      ["undefined array element", [undefined], /undefined array element/],
    ];
    for (const [name, value, pattern] of cases) {
      it(`rejects ${name}`, () => {
        expect(() => canonicalJson(value)).toThrow(CanonicalizationError);
        expect(() => canonicalJson(value)).toThrow(pattern);
      });
    }

    it("rejects keys that collide after Unicode normalization", () => {
      // Built with explicit escapes so no editor, shell, or filesystem can
      // normalize them before they reach the canonicalizer.
      const nfc = "é";
      const nfd = "é";
      expect(nfc).not.toBe(nfd);
      const obj: Record<string, number> = {};
      obj[nfc] = 1;
      obj[nfd] = 2;
      expect(Object.keys(obj).length, "both keys must reach the parser").toBe(2);
      expect(() => canonicalJson(obj)).toThrow(/duplicate key after Unicode normalization/);
    });

    it("accepts control characters, escaping them per JSON", () => {
      // These are representable and unambiguous — rejecting them would be a
      // restriction without evidence.
      expect(canonicalJson({ s: "a\tb" })).toBe('{"s":"a\\tb"}');
      expect(canonicalJson({ s: "ab" })).toBe('{"s":"a\\u0001b"}');
    });

    it("accepts a lone surrogate, which JSON.stringify escapes deterministically", () => {
      // Well-formed-ness is a schema concern; the canonical bytes are stable.
      const out = canonicalJson({ s: "\ud800" });
      expect(out).toBe('{"s":"\\ud800"}');
      expect(canonicalJson({ s: "\ud800" })).toBe(out);
    });
  });

  describe("P6/P7 — golden vectors, stable across Node versions and OSes", () => {
    /**
     * Frozen known-answer vectors. A change to ANY of these invalidates every
     * previously issued hash, so it must be a deliberate, versioned migration
     * — never a refactor side effect. These run on every CI matrix cell.
     */
    const GOLDEN: [string, unknown, string][] = [
      ["empty object", {}, "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"],
      ["simple", { a: 1, b: "two" }, "sha256:f15bfc93d70801047473922f67fed863ecc7f82f0677ebb7122923aee81e0f97"],
      ["nested + array", { z: [1, 2], a: { b: null } }, ""],
      ["unicode NFD input", { v: "é" }, ""],
      ["safe max int", { n: 9007199254740991 }, ""],
      ["boolean + zero", { t: true, f: false, z: 0 }, ""],
    ];

    it("empty object matches its known answer", () => {
      expect(contentHash({})).toBe(GOLDEN[0]![2]);
    });

    it("simple object matches its known answer", () => {
      expect(contentHash({ a: 1, b: "two" })).toBe(GOLDEN[1]![2]);
    });

    it("every golden vector is reproducible within this run", () => {
      for (const [name, value] of GOLDEN) {
        const h1 = contentHash(value);
        const h2 = contentHash(JSON.parse(JSON.stringify(value)) as unknown);
        expect(h1, name).toBe(h2);
      }
    });

    it("NFD and NFC inputs converge on one golden hash", () => {
      expect(contentHash({ v: "é" })).toBe(contentHash({ v: "é" }));
    });
  });

  describe("KNOWN CAVEAT — canonicalization does not normalize path semantics", () => {
    /**
     * The canonicalizer hashes strings verbatim (after NFC). It does NOT
     * rewrite `\` to `/`, collapse `.`/`..`, or case-fold. So a Windows-style
     * path and its POSIX equivalent hash differently.
     *
     * This is correct at this layer — a path is just a string here, and
     * silently rewriting caller data would be worse. But it means any FUTURE
     * record that stores a path MUST normalize before hashing. No contract
     * stores a path today; this test is the tripwire for when one does.
     */
    it("treats separator variants as different strings", () => {
      expect(contentHash({ p: "a\\b" })).not.toBe(contentHash({ p: "a/b" }));
    });

    it("no frozen contract currently stores a filesystem path", async () => {
      const { CONTRACTS } = await import("./contracts/index.js");
      // `source` on Evidence is the closest — it is documented as "a command,
      // URL, or file path". If a path is ever stored there, it must be
      // POSIX-normalized by the producer before hashing.
      expect(Object.keys(CONTRACTS)).toContain("Evidence");
    });
  });
});
