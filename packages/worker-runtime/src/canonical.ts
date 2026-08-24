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
  if (t === "string" || t === "boolean") return value as string | boolean;

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new CanonicalizationError(`non-finite number at ${path}: ${String(n)}`);
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
    for (const key of Object.keys(source).sort()) {
      const v = source[key];
      if (v === undefined) continue; // absent, not null
      out[key] = canonicalize(v, path ? `${path}.${key}` : key);
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
