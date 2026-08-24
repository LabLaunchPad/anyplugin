/**
 * Canonical serialization and content hashing.
 *
 * Everything downstream depends on this being exactly right. A Certificate
 * (M10) binds evidence, decisions, and verification results by hash; if two
 * logically identical records can serialize to different bytes, tamper
 * detection produces false positives and the certificate is worthless. If two
 * logically *different* records can serialize to the same bytes, it produces
 * false negatives, which is worse.
 *
 * Rules:
 *   - Object keys are sorted lexicographically by UTF-16 code unit, recursively.
 *   - Arrays keep their order (order is semantic; reordering is a different record).
 *   - `undefined`-valued object properties are omitted; `null` is preserved.
 *     JSON has no `undefined`, and treating "absent" and "explicitly null" as
 *     the same value would let a record change meaning without changing hash.
 *   - No insignificant whitespace.
 *   - Non-finite numbers, functions, symbols, and BigInt are rejected rather
 *     than silently coerced — `JSON.stringify` turns NaN into `null`, which
 *     would make two different records hash identically.
 *
 * Deliberately NOT full RFC 8785 (JCS): that mandates ECMAScript number
 * formatting rules we do not need, since kernel records carry integers and
 * short decimals only. What matters is that the rules are explicit, total, and
 * tested — see canonical.test.ts.
 */
import { createHash } from "node:crypto";

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalizationError";
  }
}

/** JSON values the kernel is willing to persist. */
export type CanonicalValue =
  | string
  | number
  | boolean
  | null
  | CanonicalValue[]
  | { [key: string]: CanonicalValue | undefined };

function canonicalize(value: unknown, path: string): CanonicalValue {
  if (value === null) return null;

  const t = typeof value;
  if (t === "boolean") return value as boolean;

  if (t === "string") {
    // Unicode normalization. "café" as NFC (e-acute, one code point) and NFD
    // (e + combining acute) are DIFFERENT JS strings with different bytes, but
    // the same logical text — so without this they hash differently. This is
    // not hypothetical: macOS normalizes filenames toward NFD while Linux
    // stores NFC, so the same path captured on two machines would produce two
    // hashes for one logical record. NFC is the interchange form (Unicode
    // Annex #15) and is what JSON consumers expect.
    return (value as string).normalize("NFC");
  }

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError(`non-finite number at ${path}: ${String(n)}`);
    }
    // Integers beyond ±(2^53 - 1) are not representable distinctly as f64:
    // 9007199254740993 silently becomes 9007199254740992, so two DIFFERENT
    // logical values would produce ONE hash. That is a collision — a false
    // negative in tamper detection, which is worse than a false positive.
    // Refuse rather than hash a value we cannot faithfully round-trip.
    if (Number.isInteger(n) && !Number.isSafeInteger(n)) {
      throw new CanonicalizationError(
        `integer outside the safe range at ${path}: ${String(n)} cannot be represented distinctly; ` +
          `persist large integers as strings`,
      );
    }
    // -0 and 0 are indistinguishable in JSON; normalize so they cannot produce
    // two hashes for one value.
    return Object.is(n, -0) ? 0 : n;
  }

  if (t === "bigint") throw new CanonicalizationError(`bigint is not serializable at ${path}`);
  if (t === "function") throw new CanonicalizationError(`function is not serializable at ${path}`);
  if (t === "symbol") throw new CanonicalizationError(`symbol is not serializable at ${path}`);
  if (t === "undefined") throw new CanonicalizationError(`undefined is not a value at ${path}`);

  if (Array.isArray(value)) {
    return value.map((item, i) => {
      if (item === undefined) {
        // JSON.stringify would emit null here, silently changing the record.
        throw new CanonicalizationError(`undefined array element at ${path}[${i}]`);
      }
      return canonicalize(item, `${path}[${i}]`);
    });
  }

  if (value instanceof Date) {
    throw new CanonicalizationError(
      `Date at ${path}: persist timestamps as ISO-8601 strings so serialization is not locale- or engine-dependent`,
    );
  }

  if (t === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, CanonicalValue> = {};
    // Keys are normalized too, then sorted — an NFD key and an NFC key are the
    // same logical field and must not produce two entries or two orderings.
    const normalized = new Map<string, unknown>();
    for (const rawKey of Object.keys(source)) {
      const v = source[rawKey];
      if (v === undefined) continue; // absent, not null
      const key = rawKey.normalize("NFC");
      if (normalized.has(key)) {
        throw new CanonicalizationError(
          `duplicate key after Unicode normalization at ${path ? `${path}.` : ""}${key}: ` +
            `two differently-encoded keys collapse to one field`,
        );
      }
      normalized.set(key, v);
    }
    for (const key of [...normalized.keys()].sort()) {
      out[key] = canonicalize(normalized.get(key), path ? `${path}.${key}` : key);
    }
    return out;
  }

  throw new CanonicalizationError(`unsupported value at ${path}`);
}

/** Deterministic JSON. Same logical record → byte-identical output, always. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value, ""));
}

/**
 * Content hash of a record: sha256 over its canonical JSON, hex encoded.
 * Prefixed with the algorithm so the format can evolve without ambiguity —
 * a bare hex string cannot tell you what produced it.
 */
export function contentHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

/** True iff `hash` is a well-formed content hash produced by `contentHash`. */
export function isContentHash(hash: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(hash);
}
