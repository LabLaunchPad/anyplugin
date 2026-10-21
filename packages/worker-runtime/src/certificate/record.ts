/**
 * Writing a certificate into the history (M10).
 *
 * ── Why a certificate has to be WRITTEN, not just held ─────────────────────
 *
 * A certificate that is issued and checked but never recorded is a
 * certificate about a moment with no trace. The whole point of the seal is
 * that the outcome becomes part of the run's history: a later reader must
 * be able to find the certificate, and then re-verify it against the
 * artifacts as they stand.
 *
 * So the certificate is written as an event, with the event kind the
 * frozen contract already names: `CERTIFICATE_ISSUED`.
 *
 * ── The id is DERIVED, and that is the point ────────────────────────────────
 *
 * The event's id comes from `eventIdOf`, which derives it from the event's
 * content. So recording the same certificate twice produces the same event
 * id — and the log's own guarantee G5 says re-appending a committed event
 * id does not commit it twice.
 *
 * A derived id is what makes a duplicate DETECTABLE, and it is what
 * the log's own G5 guarantee keys on. But the production append path does
 * not enforce G5 yet — it writes what it is handed — so a retried recording
 * commits the same event id twice, and replay reports a duplicate id as the
 * contract's "broken writer" signal. That gap is recorded in
 * `docs/BACKLOG.md`, and it is not closed by this module.
 *
 * ── What goes in the payload ───────────────────────────────────────────────
 *
 * The certificate itself. Not a summary of it, not a reference to it: the
 * payload IS the sealed record, and the verifier recomputes the hashes
 * from the artifacts and compares them against what the certificate says.
 */
import { eventIdOf } from "../log/event-id.js";
import type { EventLog } from "../log/event-log.js";
import { CONTRACT_VERSION, type Certificate, type WorkerEvent } from "../contracts/index.js";

/**
 * Record a certificate in the log.
 *
 * Returns the event that was written, so the caller can cite its id.
 */
export function recordCertificate(log: EventLog, certificate: Certificate): WorkerEvent {
  // Typed, not inferred: an inferred object literal widens the contract
  // version to `string`, and the frozen event schema pins it to the
  // literal. The annotation makes the widening a compile error instead of
  // a runtime surprise.
  const draft: Omit<WorkerEvent, "id" | "sequence"> = {
    contractVersion: CONTRACT_VERSION,
    at: certificate.issuedAt,
    actor: certificate.provenance.by,
    kind: "CERTIFICATE_ISSUED",
    subject: certificate.id,
    payload: { ...certificate } as Record<string, unknown>,
  };
  return log.append({ ...draft, id: eventIdOf(draft) });
}
