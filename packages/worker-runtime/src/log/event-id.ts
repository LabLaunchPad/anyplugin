/**
 * Event ids.
 *
 * ── Why an id is a content hash ────────────────────────────────────────────
 *
 * The delegation telemetry's id is described in the kernel as *"A stable id
 * for a delegation event, so re-appending the same event is idempotent"*.
 * The same property is wanted of the work events, and it is obtained the
 * same way: **the id is derived from the record's own content**.
 *
 * Two identical events therefore get identical ids, so re-appending one
 * changes nothing; and two different events cannot collide, because their
 * contents differ.
 *
 * The digest is truncated to 24 hex characters — 96 bits. The id schema's
 * slug limit is 64 characters, so there is room, and a collision is not a
 * practical concern.
 */
import { contentHash } from "../canonical.js";
import type { WorkerEvent } from "../contracts/index.js";

/** A deterministic id for an event, derived from the event's own content. */
export function eventIdOf(event: Omit<WorkerEvent, "id" | "sequence">): string {
  const digest = contentHash({
    contractVersion: event.contractVersion,
    kind: event.kind,
    subject: event.subject,
    at: event.at,
    actor: event.actor,
    payload: event.payload,
  });
  return `EVT-${digest.slice("sha256:".length, "sha256:".length + 24)}`;
}
