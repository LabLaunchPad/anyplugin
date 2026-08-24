# Capability provenance — semantic contract

What a `CapabilityProvenance` record means, and — more importantly — what it does **not** mean.

This exists because the first version of that record was structurally sound and **epistemically thin**:
it turned one date into a queryable field and left the artifact identity as free prose. A record can be
technically present and mean nothing, which is a worse failure than an absent one, because it looks like
an answer. Same class as F19 (`0` CPU for real work) and the `fsRead` counter.

Ledger: F9. Related: `ENGINEERING_LEDGER.md` AP-004, and `reusable-procedures.md`
`ANTI_VACUITY_ANALYSIS`.

---

## The record

```ts
interface CapabilityProvenance {
  readonly source: string;       // what was consulted
  readonly method: AuditMethod;  // how it was established
  readonly observedAt: string;   // ISO date, or "UNKNOWN"
}
```

Provenance sits on the **row** (`agent@variant`), not the capability, because that is how the audits were
performed — one pass over one agent's plugin surface. Per-capability provenance would assert an evidence
granularity that does not exist.

---

## What each field means

### `method` — the load-bearing field

Before this existed, "audited" covered both *someone read a doc* and *someone ran it against the real
agent*. Those are different epistemic acts producing different confidence, and collapsing them is how a
documentation claim silently acquires the authority of an execution result.

| value | means | does NOT mean |
|---|---|---|
| `DOCUMENTED` | A vendor doc or published API reference states this | that anyone ran it |
| `OBSERVED` | The behaviour was executed against the real agent and seen | that it holds for other versions |
| `DERIVED` | Inferred from an adjacent verified fact (e.g. a documented protocol shared with another agent) | independent confirmation |
| `NOT_AUDITED` | No audit was performed; the row exists for other capabilities | anything about the unaudited capability |

**Today every row is `DOCUMENTED` or weaker.** No capability verdict in this repository rests on having
executed anything against a real third-party agent. That is worth stating plainly: the matrix is a
*documentation-derived* model, and its verdicts inherit documentation's failure modes.

### `observedAt`

**Means:** the date the *audit act* was performed — when a person or process consulted the source and
recorded the verdict.

**Does not mean:** when the source was published, when the agent shipped the behaviour, or when the
verdict was last reviewed. Those are three other dates, none of which this field carries.

`"UNKNOWN"` is legal and means **nobody recorded when the check happened**. The verdict still stands; its
freshness cannot be reasoned about. The count is ratcheted so it can shrink and never grow.

### `source`

**Means:** what was consulted, in human-readable terms.

**Does not mean:** a resolvable, versioned, or verifiable identifier. It is prose, deliberately, because
**the underlying audits did not record one** — and inventing a URL or version hash to fill the field
would manufacture evidence. See the open gap below.

---

## What this record cannot currently support

Stated explicitly so nothing downstream assumes otherwise.

| question | status | what would be required |
|---|---|---|
| Which exact document version was read? | **UNKNOWN** | a URL + retrieval date + content hash, captured at audit time |
| Who or what performed the audit? | **UNKNOWN** | an actor field, populated by whatever performs the audit |
| Is this verdict stale *right now*? | **NOT COMPUTABLE** | a `staleAfter` policy plus a real `observedAt` on every row |
| Was the capability executed, or only read about? | **ANSWERABLE** via `method` | — |
| Can provenance drift from its verdict? | **YES** | see below |
| Does provenance participate in capability identity? | **NO** | see below |

### Provenance can drift from the verdict it describes

Nothing binds them. Someone can change a verdict from `NATIVE` to `UNSUPPORTED` and leave `observedAt`
untouched, and no test notices. Both live in the same file under version control, so this is a
review-discipline gap rather than a tampering vector — an attacker who can edit `matrix.ts` can edit
anything.

**Not fixed here, deliberately.** Binding them means hashing the verdict together with its provenance,
which creates a capability identity that changes whenever either changes — useful, and a real design
decision with migration consequences. It should not be introduced as a side effect of adding a field.

### There is no capability identity

Contracts under `packages/worker-runtime/` are content-addressed; the capability matrix is not. A
verdict has no hash, so nothing downstream can bind to "the capability model as it was when this
decision was made". If a `Decision` ever depends on a capability verdict, that becomes necessary — and
`canonical.ts` already provides the primitive.

---

## The rule this file exists to enforce

**A provenance record is evidence about an audit, never a substitute for one.**

Recording `NOT_AUDITED` with a date is not an audit. Recording `DOCUMENTED` does not make the behaviour
observed. Upgrading a `method` without performing the corresponding act is fabrication, and it is the
single most likely way this record becomes epistemically meaningless while remaining structurally valid.

Anti-vacuity, applied to provenance itself: *what would have to be true for this record to look correct
while the audit never happened?* Answer — someone edits the fields. Which is why `method` is enumerated
rather than free text, why `observedAt` admits an honest `UNKNOWN` instead of inviting a plausible
guess, and why the ratchet counts the gaps rather than hiding them.
