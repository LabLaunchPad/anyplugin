/**
 * Contract-version migration.
 *
 * ── Why a migration exists at all ──────────────────────────────────────────
 *
 * A frozen contract is frozen because Certificates (M10) bind records by
 * content hash: a record's bytes must not change under a certificate. So
 * when a contract has to change, the change is a **versioned migration**,
 * not a refactor — the old records stay exactly as they were written, and
 * a reader upgrades them on the way in.
 *
 * The pattern is the one the install journal already uses
 * (`cli/src/journal.ts`): upgrade what is known, and **refuse what is not**.
 *
 * ── The 1.0.0 → 1.1.0 migration ────────────────────────────────────────────
 *
 * `1.1.0` widened the event-kind vocabulary with `DELEGATION_RECORDED`, so
 * the delegation telemetry can live in the same log as the work events. The
 * record's **shape** did not change — the same fields, the same
 * constraints — so the migration is the version string and nothing else.
 *
 * That matters for two reasons:
 *
 * - a record labelled `1.0.0` carrying a kind that did not exist in
 *   `1.0.0` would be a lie, and a lie in a version field is the one lie
 *   the whole mechanism exists to prevent; and
 * - a **widen-only** migration is trivially reversible in meaning: the
 *   upgraded record means exactly what it meant before, so a certificate
 *   that binds a `1.0.0` record's content still verifies against it.
 *
 * ── What is refused ────────────────────────────────────────────────────────
 *
 * An unknown **future** version is refused, not guessed at. A future
 * version may have changed the shape, and reading it as if it had not would
 * be inventing a record. The same rule the journal follows.
 */
import { CONTRACT_VERSION } from "./index.js";

/** The contract versions this build can read. */
export const READABLE_CONTRACT_VERSIONS = ["1.0.0", "1.1.0", CONTRACT_VERSION] as const;

/** The versions this build can UPGRADE from. */
const UPGRADABLE: readonly string[] = ["1.0.0", "1.1.0"];

export type MigrationResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      /**
       * `NOT_A_RECORD` — the thing is not a record at all, or has no
       * version. The schema check will diagnose it, and its diagnosis is
       * the better one.
       *
       * `UNKNOWN_VERSION` — the record names a version this build does not
       * read. That gets its own diagnosis, because "this build does not
       * read that version" is more useful than "does not satisfy the
       * schema" — and because it is the **fail-closed** answer.
       */
      readonly kind: "NOT_A_RECORD" | "UNKNOWN_VERSION";
      readonly reason: string;
    };

/**
 * Upgrade a record written under an earlier contract version.
 *
 * A record already at the current version is returned unchanged — the
 * common case, and the one that must not allocate.
 */
export function migrateRecord(raw: unknown): MigrationResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, kind: "NOT_A_RECORD", reason: "not a record" };
  }
  const record = raw as Record<string, unknown>;
  const version = record["contractVersion"];
  if (version === undefined) {
    return { ok: false, kind: "NOT_A_RECORD", reason: "no contract version" };
  }
  if (version === CONTRACT_VERSION) return { ok: true, value: record };
  if (typeof version === "string" && UPGRADABLE.includes(version)) {
    // A widening migration: the version string, and nothing else. Every
    // widening so far has LOOSENED a constraint, so a record written under
    // an earlier version still satisfies the current one.
    return { ok: true, value: { ...record, contractVersion: CONTRACT_VERSION } };
  }
  return {
    ok: false,
    kind: "UNKNOWN_VERSION",
    reason: `unknown contract version ${JSON.stringify(version)}`,
  };
}
