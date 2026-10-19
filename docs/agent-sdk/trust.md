# Trust: identity, attestation, and the commit-point protocol

The trust subsystem's job is to let an auditor answer *"what did the Worker
see, do, and prove?"* — and to be honest about how far that answer reaches.

**Everything here is design, not implementation.** The contracts it would use
mostly exist already; the schemas in §7 are the proposed additions.

---

## 1. Threat model

The single most consequential assumption:

> **The model is untrusted input, never a principal.**

If that is false, nothing in this document helps. Every control below assumes
a model that can be wrong, can be injected, and will sometimes be confidently
wrong in exactly the way that matters.

Three deployment modes, and the difference is real:

| | **LOCAL** | **SELF-HOSTED** | **HOSTED** |
|---|---|---|---|
| Who owns the machine | the user | the operator | the operator |
| Who can be trusted | nobody, including the user | the operator for availability, not for content | **the operator is the assumed adversary** for tenant isolation |

**Scope legend:** L = local, S = self-hosted, H = hosted. "—" means *not in
scope, because there is no authority to appeal to* — and saying so is the
point.

| # | Adversary | Attack | Blast radius | Control | Scope |
|---|---|---|---|---|---|
| T1 | Hallucinating or prompt-injected model | Emits a false claim as fact; tries to get it remembered, then recalled as corroborated | Every downstream decision; persists across runs | Model output is an `OBSERVATION`, never an anchor. The worker holds **no key that can sign an anchor**. Promotion to `VERIFIED_KNOWLEDGE` requires an anchor from an admissible attester class. The anchor store is consulted **before** memory; on conflict the anchor wins and the memory entry is `INVALIDATED` and cannot be re-promoted | L,S,H |
| T2 | Malicious or compromised tool / MCP server | Returns a forged "success"; injects instructions via tool output; replays a stale result | Actions taken on the tool's word | Tool output is evidence with `authority: REPORTED` unless pinned. Every call records request/response `contentHash`. **A tool response can never be an anchor.** The pinned config digest of an MCP server is in the ledger, so a changed server is visible | L,S,H |
| T3 | Malicious plugin (in-process code) | Reads the key file; forges anchors; rewrites the ledger | **Total** for the local runtime | Keep anchor-signing keys **out of the worker's process** (an attestor helper or service). A plugin digest is pinned; an unpinned plugin can never confer `AUTHORITATIVE` authority. Local mitigation is **custody, not cryptography** | L (mitigate), S/H (isolate) |
| T4 | Compromised worker host (root/admin) | Rewrites the ledger; backdates clocks; deletes records | Total for local evidence | Hash chain + segment sealing + an **externally published head**. Tampering becomes *detectable*, not prevented. The clock is not trusted | L (detection only), S/H (service holds heads) |
| T5 | Replay of an old signed receipt | Re-presents a valid "approved" anchor as current | A repeated action, or a stale fact read as current | The signed payload binds `tenantId`, the **context** (contract / effect / purpose) and a **nonce**. An anchor is valid **only for the context it names**. Freshness is a *secondary* control, because the clock is not trusted | L,S,H |
| T6 | User tampering with the local ledger | Edits, deletes or truncates to hide an action | Local audit | Chain detects inner edits; suffix truncation is detected only against an external head copy. **In LOCAL mode the user holds the keys, so this is tamper-evidence against accident and against a lower-privileged accomplice — not against the owner.** | L (honest limit) |
| T7 | Confused deputy (tenant A → control plane → tenant B) | Requests "tenant B's anchor" with A's credentials, or passes a `tenantId` to steer a store path | Cross-tenant read + forgery | Store paths derive from the **authenticated** principal, never from a request field. `tenantId` is inside the signed preimage. Per-tenant keypairs. Delegation to another tenant requires an explicit signed delegation record | S,H |
| T8 | Learning-loop laundering | A false claim enters memory as a lesson, is recalled, and is eventually promoted to "verified knowledge" | Persistent false knowledge that later looks authoritative | Promotion is a state machine that **cannot advance without a signed anchor**. The worker is not an admissible attester kind — there is deliberately no `WORKER_ATTESTATION` kind. Recall never raises authority. A contradicting anchor triggers invalidation and a `REOPENED` work contract | L,S,H |
| T9 | Clock manipulation | Sets the clock so a replayed anchor looks fresh | Freshness windows | Context binding is the primary defence; a fresh-looking replay is still bound to the wrong context | L,S,H |
| T10 | Whole-store rollback | Restores an old snapshot; the ledger looks self-consistent | Local evidence | The head hash lives in a separate store. A restored store has an older head → mismatch against the last known head | L,S,H |
| T11 | Supply chain (a malicious package or plugin version) | Executes with the worker's privileges | As T3 | Plugin/dependency digest recorded in the ledger; unpinned ⇒ no `AUTHORITATIVE` authority | L,S,H |
| T12 | Model provider compromise | Mints or alters provider output | Any claim whose only evidence is the provider | Provider output is an `OBSERVATION`; a provider never signs an anchor | L,S,H |
| T13 | Cross-tenant denial of service | One tenant holds the global writer lock; others stall | Availability for all tenants | The writer lock is **per-tenant directory**. A shared lock across tenants is a design bug, not an incident | S,H |
| T14 | Auditor collusion / witness capture | All witnesses sign a false attestation | Local/peer attestation only | Witness quorum is k-of-N over independent witnesses — **reducing** single-party forgery, not preventing collusion | L |

**Explicitly out of scope everywhere.** A hostile OS kernel, or a CPU with a
malicious hypervisor, can forge any local measurement. No scheme here defends
against that. The honest claim is *"the evidence is internally consistent and
matches an externally published head"* — never *"the machine is honest"*.

**What LOCAL mode cannot offer, stated plainly.** No revocation authority, no
timestamp authority, no appeal, no cross-machine identity continuity, and no
non-repudiation. LOCAL offers **integrity, tamper-evidence, and attribution to
a key** — nothing stronger. A deployment that needs more must add an external
service, and that service must be **named in the product**, not implied.

---

## 2. The evidence tiers are a projection, not a ledger

The four tiers (`VERIFIED` / `UNCITED` / `BROKEN` / `UNSUPPORTED`) are derived
from the kernel's existing `EvidenceSchema` fields. They are never stored, so
they cannot drift from the record they describe.

| Tier | Derivation from `EvidenceSchema` |
|---|---|
| `VERIFIED` | `authority = AUTHORITATIVE` ∧ `validity = VALID` ∧ ≥1 citation that resolves ∧ producer lineage external to the claiming worker |
| `UNCITED` | `validity = VALID` but no citation, or `authority = REPORTED` |
| `BROKEN` | `validity = INVALIDATED` — the claim was once relied upon and was found wrong |
| `UNSUPPORTED` | `authority = DERIVED` from a source that is itself `UNCITED`, or the supporting evidence set is empty |

**Prior art:** none found (`docs/EVIDENCE.md` E18). W3C PROV-O has the
derivation and invalidation vocabulary but no confidence tiers. This is our
design and is labelled as such.

### 2.1 The grounding policy

A data structure, evaluated by rules — **never by a model**:

```ts
policy: {
  tiers: [
    { tier: "DRAFT",        mayBeGroundedBy: [] },
    { tier: "READ",         mayBeGroundedBy: ["UNCITED"] },
    { tier: "SUGGEST",      mayBeGroundedBy: ["UNCITED", "VERIFIED"] },
    { tier: "ACT",          mayBeGroundedBy: ["VERIFIED"] },
    { tier: "IRREVERSIBLE", mayBeGroundedBy: ["VERIFIED"], minAttesterClass: "PEER" },
  ],
}
```

`VERIFIED` is conferred only by a **valid, unexpired, unrevoked anchor** whose
kind is admissible for the tier and whose attester class meets the tier's
minimum. An unknown anchor kind, an unknown attester, an expired anchor, or a
key revoked after the fact ⇒ the anchor does not confer `VERIFIED` ⇒ the claim
is treated as `UNCITED` for live purposes. **Fail closed.**

### 2.2 The truth anchor beats memory

The claim resolver consults the anchor store **first**. On conflict:

1. The anchor wins.
2. The memory entry is `INVALIDATED` with reason `ANCHOR_CONFLICT`.
3. The invalidation cascades to dependent decisions (the kernel's `REOPENED`
   transition).
4. A shadowed memory entry **cannot be re-promoted** while the anchor stands.

The kernel's `Validity` enum already separates `SUPERSEDED` (a newer record
replaces it) from `INVALIDATED` (it should no longer be relied on at all) —
the same distinction, already earned.

---

## 3. Identity and signatures

### 3.1 Principals

| Principal | Id form | May sign an anchor? |
|---|---|---|
| **Worker** | `worker:<uuid-v4>` (a label) | **No** — it signs checkpoints and commit records only |
| **Tool / MCP server** | `tool:<name>@<version>` | No — its output is evidence |
| **Model provider** | `provider:<name>` | No |
| **Human attester** | `human:<local-part>` | **Yes** — `HUMAN_ATTESTATION`, and `REGULATORY_INPUT` only if their class is `AUTHORITY` |
| **Tenant** | `tenant:<slug>` | **Yes** — for tenant-scoped anchors |
| **Plugin** | `plugin:<name>@sha256:<hex>` | No |
| **Service (control plane)** | `service:<deployment-id>` | Co-signs heads; never signs a tenant's *content* (§3.4) |

The id forms reuse the kernel's `ActorSchema` grammar (`human:` / `process:` /
`producer/version`), with `tenant:` and `worker:` added as explicit prefixes so
a tenant id can never be confused with a person or a process.

### 3.2 The forgery surface, stated exactly

| Scheme | Who can produce a valid signature |
|---|---|
| **HMAC-SHA256 (shared secret)** | **Everyone holding the secret.** If the Worker holds it, the Worker can forge a human attestation — which destroys the anti-poisoning design outright. **HMAC is therefore forbidden for anchors in all modes.** It is permitted only for an internal at-rest workspace MAC where attribution is explicitly not claimed. |
| **ed25519, single private key** | The key holder, and anyone who copied the key file. Uniqueness of *possession*, not uniqueness of *person*. |
| **ed25519, per-principal keys** | The principal, and its key custodian. Isolation between principals is cryptographic. |
| **Service-held CA** | The service operator, for anything the service signs — **including, if allowed, tenant content**. This is the single most important deployment decision (§3.4). |

### 3.3 The scheme per mode

**LOCAL.** Anchors are ed25519, signed by the **human attester's** key, which
is **not held by the Worker process**. Two custody models: an `attest` helper
CLI on the attester's own device (offline, air-gap friendly, the human
confirms the payload on screen), or a local attestor service reachable over a
**unix socket / named pipe** — not TCP — so a plugin in the Worker process
cannot use it without explicitly asking the human. The worker's own ed25519
key signs checkpoints and commit records, and is wrapped with a passphrase.
**Forgery surface:** anyone who obtains the human's key file. The worker's key
can forge only worker-signed records, never an anchor.

**SELF-HOSTED (multi-tenant).** Per-tenant ed25519 keypair; the private key
never leaves the tenant. The service holds the public key and issues a
tenant-scoped identity cert. **Can tenant A forge tenant B's anchors? No**,
for three independent reasons: B's private key is not in A's possession;
`tenantId` is inside the signed preimage, so an A-signed payload cannot be
relabelled as B; and the service binds `(tenantId, keyId) → publicKey` at
registration and refuses any signature that does not verify under the
*requested tenant's* registered key.

> **The highest-value control in this document:** the **tenant co-signs the
> per-tenant chain head.** The service publishes `head = H(prevHead, …)` and
> the tenant signs it; the service's own copy of the head is worthless without
> the tenant's co-signature. Injection into the anchor log is therefore
> detectable by the tenant **offline, without asking the service**.

**HOSTED.** Two-key model, and the tenant's key must be **tenant-held**
whenever the operator is not trusted. Two explicitly-labelled modes:

- `TENANT_SIGNS_LOCAL` (default, isolation-preserving) — the tenant signs;
  the service stores and co-signs heads.
- `SERVICE_SIGNS_FOR_TENANT` (convenience, **downgraded**) — the operator can
  forge. The record, the audit export and the UI must all carry
  `attestationClass: "OPERATOR_ASSERTED"`, and the grounding policy may refuse
  to let such an anchor reach the highest tier.

### 3.4 Attester identity without a PKI

Offline, with no PKI, a human attestation can only ever prove *"the holder of
key K asserted this"*. It cannot prove *"Alice said this"* in a legal sense.
The scheme is a **good-enough** upgrade, and the limit is stated:

1. The attester generates an ed25519 keypair on their own device (or via the
   `attest` helper, which holds the key and only signs a canonical payload the
   human confirms on screen).
2. An `ATTESTER_BINDING` record binds `keyId → human:<id>`, signed by the
   attester key itself.
3. The binding is **countersigned by a witness set**: up to N independent
   principals (other humans, other worker instances with distinct keys, a
   hardware token) each sign the binding's hash. Threshold k-of-N
   (k=1 locally, k=2 self-hosted, k=3 hosted for the `AUTHORITY` class).
4. Verification checks: binding present, witness count ≥ threshold, key not
   revoked, not expired.

**What this proves:** *"the holder of key K, vouched for by k witnesses,
asserted this."*
**What it does not prove:** the real-world identity of the human; that the key
was not cloned; that the witnesses are not colluding; anything about legal
non-repudiation.

**Optional upgrade (online):** an OIDC/SSO identity assertion signed by an
IdP key, cached locally with an expiry, so the anchor can be verified offline
for the cache's validity window. Off by default; never required for LOCAL.

### 3.5 Worker identity across runs, and machine rebuild

**Yes, the worker identity is stable — but the identity is the key, not the
UUID.** The UUID is a label; the cryptographic identity is `keyId` (the public
key fingerprint), and every record carries it.

**A machine rebuild is a new identity**, and the recovery is explicit and
logged:

| Situation | Recovery | Continuity |
|---|---|---|
| The old key file survived (backup media) | A `WORKER_REBIND` anchor signed by the **old** key and co-signed by the new one, naming `oldKeyId → newKeyId` with a reason | Cryptographic |
| The old key is gone, a human attester is available | An `ATTESTER_BINDING` for the new key, countersigned by the same witness set as the old binding, plus a `REBIND` naming the old `keyId` | **Social** — the record must say so (`continuity: "attested"`) |
| Neither | The worker starts as a **new identity**. Previous anchors are not attributable to it, and the audit trail shows a discontinuity | None — and the SDK must not paper over it with a "same worker" claim |

### 3.6 Rotation, revocation, and what an expired anchor means

**Rotation.** A `KEY_ROTATION` record names `oldKeyId → newKeyId`, is signed
by the **old** key and co-signed by the **new** key, and carries a validity
overlap window. Custody continuity is therefore cryptographic and the
succession is visible. The **chain hash is key-independent** (plain SHA-256),
which is why rotation never breaks chain verification.

**Revocation is append-only and three-valued**, never a binary valid/invalid.
For an anchor `A` signed by key `K` at time `T`:

| Condition | Result |
|---|---|
| `K` valid at `T`, no revocation, or revocation effective **after** `T` | `VALID` (flag `keyRevokedAfter`) |
| `K` revoked effective at `T' > T` | `VALID` historically; **no new** anchor from `K` accepted; the grounding policy may downgrade it |
| Compromise suspected at `T'' ≤ T` (backdated) | Anchors from `K` with `issuedAt ≥ T''` are `INVALID` — the **only** retroactive semantics, and it is an **overlay** (`DISTRUST` record), never a deletion or an edit |
| `K` expired (`notAfter < T`) | Anchors issued at `T` are invalid; anchors issued earlier remain valid |

Key material is never removed from the record. The resolution is a
**projection computed at read time** — exactly like the kernel's `Validity`
model.

**Non-repudiation, plainly.** A local HMAC gives **no** non-repudiation: both
parties to the secret can produce a valid signature. A local ed25519 with an
exclusively-held attester key gives a *technical exclusivity* claim — "only
the holder of `keyId` could have produced this" — which is stronger than
HMAC but is **not legal non-repudiation**: there is no independent binding of
key to person, key material can be copied, and there is no trusted
third-party timestamp.

**What an auditor may honestly claim:**

- ✅ *"I can reconstruct what the Worker saw, did, and proved, and I can detect
  modification of that record."*
- ✅ *"This anchor was signed by the holder of key K, which was bound to
  `human:alice` by a binding record countersigned by k witnesses."*
- ❌ *"Alice personally signed this and cannot deny it."*
- ❌ *"The record existed before time T."* — only with an external timestamp or
  a co-signed head from an independent party.

**The documentation, the audit export, the CLI output and the marketing copy
must use the ✅ wording verbatim.** Anything else is a false claim that a
competent adversary will exploit.

---

## 4. Ledger integrity

### 4.1 The kernel's event log is sufficient as the substrate — with named gaps

**Already provided; do not rebuild.** Frame format `<contentHash>\t<byteLength>\t<canonicalJson>\n`;
the hash covers the whole event; every byte classified `COMMITTED` /
`INCOMPLETE` / `REJECTED`; idempotence on duplicate ids; a monotonic
per-log sequence; single-writer enforced by an exclusive `wx` lock; an
explicit `DurabilityLevel` (`best-effort` / `process-crash` / `power-loss`)
with fsync + directory fsync.

**What is missing:**

| # | Gap | Addition |
|---|---|---|
| L1 | **Cross-run chain link.** The sequence continues across restarts, but records are not *linked*, so truncating a whole run is invisible | `prevChainHash` in the event; `chainHash_n = H(canonicalJson({prevChainHash, recordHash}))` |
| L2 | **Head publication.** A chain with no published head detects edits, not suffix truncation | A `chain.head` sidecar (atomic temp + rename) plus an exportable receipt the user can copy out of band |
| L3 | **Key rotation across restarts** | The chain hash is key-independent (already true); the *signing* key is only for checkpoints; a failed key unwrap must **fail closed** — no "run unsigned" mode |
| L4 | **Multi-writer merges** | **Do not build.** Single-writer is a load-bearing invariant. Multi-tenant ⇒ separate logs plus a Merkle tree of tenant heads, never a merged byte stream |
| L5 | **Merkle tree over anchors** | A batch Merkle root over sorted `(anchorId → payloadHash)` at checkpoint time, so a claim can be proven with a compact inclusion proof |
| L6 | **Segment sealing / rotation** | `events/000001.log`, sealed segments with a per-segment root, atomic and chain-preserving |
| L7 | **Reconciliation records** | The commit-point protocol needs `EFFECT_INTENT` / `EFFECT_COMMIT` in the same log, with the same chain |

### 4.2 The three anchoring profiles

| | (a) Air-gapped local | (b) Self-hosted + internet | (c) Hosted control plane |
|---|---|---|---|
| Chain | Hash chain + `prevChainHash` + sealed segments + local `chain.head` | Same, per tenant | Same, per tenant |
| Merkle | Anchor-set root at checkpoint | Per-tenant root, published | Per-tenant root plus a tree over tenant heads |
| External anchor | **Manual** — an exported receipt the user copies out of band | Optional RFC 3161 TSA token, or an append-only anchoring service | The service co-signs per-tenant heads; **the tenant keeps its own copy** |
| Detects | inner edits, corruption, byte loss, record-id replay | + suffix truncation against the external head | + truncation, + cross-tenant claims, + operator injection (via the tenant co-signature) |
| Does **not** detect | whole-store rollback without an out-of-band head, key theft, a user with the key re-signing a fresh chain | same | same |
| Works offline | **fully** | fully (TSA optional) | anchors sign locally; submission deferred |

**Recommendation:** implement (a) as the base in every mode — the chain code
is identical — and layer the external anchor behind one interface:

```ts
interface CheckpointPublisher {
  publish(cp: Checkpoint): Promise<PublishReceipt | null>;
}
// local: writes chain.head and prints an exportable receipt
// internet: adds an RFC 3161 token or pushes to an anchoring service
```

**The honest limit, stated once:** a hash chain is *tamper-evident*, not
*tamper-proof*. A user who holds the machine and the keys can rebuild a fully
self-consistent fake chain — unless a copy of the head exists somewhere they do
not control. That is why head publication is not optional in
self-hosted/hosted, and is "best effort, the user must copy it out" in local.

---

## 5. The commit-point protocol

### 5.1 The problem, stated precisely

The side effect happens in an external system; the commit record happens in a
local log. **They cannot be made atomic** without the target supporting
idempotency or transactions. The protocol therefore does not pretend; it makes
the ambiguous state **explicit and terminal**.

- **Effect** — an operation with an externally visible side effect.
- **`effectId`** — a deterministic idempotency key derived from
  `H(contractId, stepId, paramsHash)`. Stable across retries of the *same
  logical step*; different for a different step.
- **Commit point** — the moment the worker's output becomes irreversible to
  the host: the first byte of the final answer leaves the worker.

### 5.2 Domain A — output commit (answer bytes to the host)

1. The worker computes the **entire** final answer in memory and
   `answerHash = contentHash({answer, effectIds})`. **Nothing is streamed yet.**
2. Append `CommitPointRecord state=PREPARED` with the `answerHash`, the byte
   count, the effect ids, the target, and `durability: "power-loss"` (fsync).
   **Durable before any byte is emitted.**
3. Stream the bytes to the host.
4. Append `CommitPointRecord state=EMITTED`.

**Crash between 2 and 3.** The log says `PREPARED` with a known `answerHash`.
On restart the SDK re-emits **the identical bytes** (re-derived from the
ledger, or from a stored answer blob). Re-emitting identical content is a
*retransmission*, not a duplicate side effect, and the host can dedupe on
`answerHash`. If the answer cannot be re-derived ⇒ `INDETERMINATE` ⇒
`BLOCKED`, and **no effect is re-run**.

**Crash during 3.** The same, plus the host may hold partial output. The
answer is fully buffered before emission, and the `answerHash` is also
written to a side channel so the host can dedupe a partial delivery.

**This is what makes fallback legal or illegal precise:** the answer is
committed **iff** a `PREPARED` record with that `answerHash` exists.
`PREPARED` ⇒ committed (only identical bytes may be re-emitted). No record ⇒
not committed ⇒ fallback is legal.

### 5.3 Domain B — effect commit (external side effects)

1. Append `EffectRecord state=IN_FLIGHT` with the `effectId`, `paramsHash`,
   target, and whether the target honours an idempotency key. **Fsynced
   before the call** (write-ahead intent).
2. Execute the effect, passing `effectId` as the idempotency key when the
   target supports one.
3. On success: append `state=COMMITTED` with the `resultHash`.
4. On failure: append `state=ABORTED` with the error class.

**Crash between 1 and 2 (or 2 and 3).** The effect may or may not have
happened; the record is `IN_FLIGHT`. **Recovery is never an automatic
retry:**

| Target capability | Recovery |
|---|---|
| Supports idempotency keys | Retry with the **same** `effectId` — safe by construction |
| Supports a status query | Query by `effectId`; reconcile to `COMMITTED` or `ABORTED` |
| Neither | **`INDETERMINATE` ⇒ `BLOCKED`.** Escalate to a human, mark the work contract `BLOCKED`, append `RECONCILIATION_REQUIRED`. Never claim success; never auto-retry |

### 5.4 The correction this forces on the kernel

The current rule is "once output is committed, the chain is closed". That is
**insufficient**: an attempt can have committed an *effect* while producing no
output at all. The rule must become:

```
fallbackLegal(attempt) ⇔ no EFFECT in {IN_FLIGHT, COMMITTED} ∧ no COMMIT_POINT exists
```

An `IN_FLIGHT` effect forbids the fallback, because it may have partially
executed. This is the highest-severity correctness item in this design, and
it is recorded in `docs/BACKLOG.md` as an open P1 with the exact edit named
(D-013). It is **not** applied here because it alters a frozen,
certificate-bound contract.

### 5.5 Ordering, and what "atomic" may and may not mean

Per turn, the ledger order is fixed:

```
EFFECT_INTENT(s) → [effect calls] → EFFECT_COMMIT(s) → COMMIT_POINT(PREPARED) → emit bytes → COMMIT_POINT(EMITTED)
```

**"Recorded atomically with the side effect" is achievable only for effects
against a resource the SDK controls.** For a local file effect, the SDK writes
`<effectId>.marker` (temp + fsync + atomic rename) beside the target and
appends the log record after the rename; on recovery the marker set reconciles
the log, so the effect and the record converge without ever being
simultaneously true. For a **remote** effect there is no atomicity — only
idempotency keys and the `INDETERMINATE` state. Say exactly that in the API
docs; do not use the word "atomic" for the remote case.

**Binding answer ↔ effects.** The final `Certificate` gains `effectIds` and
`answerHash`, so the artefact an auditor receives proves the answer and those
effects belong to the same turn.

### 5.6 Verification plan

Process-kill injection at each of the five points above, asserting the
recovery classification. The kernel already establishes the convention:
process-kill is reliable on Linux and flaky on Windows, so results are
**reported per platform and never the sole basis for a claim**. The suite
must include a case where the ledger contains an `IN_FLIGHT` effect and the
harness asserts the SDK **refuses to retry** and reports `BLOCKED`.

---

## 6. Multi-tenant isolation

### 6.1 What is guaranteed (cryptographic; survives a malicious control plane that lacks tenant keys)

- Tenant A **cannot forge** tenant B's anchors — B's private key never leaves
  B, `tenantId` is in the signed preimage, and the service binds
  `(tenantId, keyId) → publicKey`.
- Tenant A **cannot alter** B's anchor chain undetectably — the head is
  co-signed by B's key.
- Tenant A **cannot write into** B's ledger or anchor store — paths derive
  from the authenticated principal, and the writer lock is per-tenant.
- No tenant can steer a store path via a request field.

### 6.2 What is not guaranteed — stated, not implied

- **The operator can read tenant data** in every mode where the service
  terminates TLS and handles plaintext. Confidentiality against the operator
  requires client-side encryption, which breaks the "auditor can reconstruct"
  property and is deferred.
- **The operator can drop or delay** anchors and checkpoints (availability).
- **The operator can forge anything the service itself signs** — hence the
  rule that content anchors are tenant-signed, and the explicitly downgraded
  `SERVICE_SIGNS_FOR_TENANT` mode.
- **Metadata leaks** — timing, sizes, counts.
- **A compromised host can lie about its own local ledger**; only the
  published head constrains it.

### 6.3 The minimum viable mechanics

| Concern | Mechanism |
|---|---|
| Storage paths | `<root>/tenants/<slug>/…`, the slug validated by the kernel's SafePath boundary, and derived from the **authenticated** principal |
| Keys | Per-tenant key store; private keys never uploaded; the service holds public keys + identity certs only |
| Anchor store | Per-tenant directory + per-tenant chain; every query scoped by the authenticated tenant; a mismatch is a hard error, not a filter |
| Ledger | Per-tenant event log ⇒ per-tenant writer lock ⇒ no cross-tenant contention |
| Cache | Namespace key = `H(tenantId, cacheKey)`; the tenant id comes from the auth context, never from the caller's key alone |
| Confused deputy | A request whose `tenantId` ≠ the authenticated tenant's id is **rejected** unless an explicit signed delegation record names the delegate and the scope |
| Quotas | Per-tenant rate and storage limits, so one tenant cannot starve another |

**The enforcement test** mounts two tenants' stores and asserts: (a) A's path
resolution cannot reach B's files; (b) A's key does not verify under B's
registered key; (c) a forged `tenantId` request is rejected; (d) A's writer
lock does not block B's. The precedent is
`core/src/boundaries/package-boundary.test.ts`.

---

## 7. Proposed schemas

Kernel-flavoured: `zod` plus the existing primitives (`TimestampSchema`,
`ContentHashSchema`, `ActorSchema`, `ProvenanceSchema`, `idSchema`) and
`canonicalJson` / `contentHash` from `packages/worker-runtime/src/canonical.ts`.

**New id prefixes** to add to `ID_PREFIXES`:
`anchor: "ANC"`, `attestation: "ATT"`, `commitPoint: "CPT"`, `effect: "EFF"`,
`key: "KEY"`, `binding: "BND"`, `witness: "WCH"`.

### 7.1 Primitives

```ts
/** `sha256:<hex>` over the SPKI DER of the public key. Stable, publishable, pinnable. */
export const KeyIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/** Tenant namespace. Derived from the AUTHENTICATED principal, never a request field. */
export const TenantIdSchema = z.string().regex(/^tenant:[a-z0-9][a-z0-9_-]{0,63}$/);

/** How much an attester is trusted to establish. Drives the grounding policy. */
export const ATTESTER_CLASSES = ["SELF", "PEER", "AUTHORITY", "EXTERNAL"] as const;

/** The six source kinds. There is deliberately NO "worker" kind. */
export const ANCHOR_KINDS = [
  "HUMAN_ATTESTATION", "HARDWARE_SIGNAL", "REGULATORY_INPUT",
  "EXTERNAL_OBSERVATION", "SIGNED_DOCUMENT", "CONSENSUS_RESULT",
] as const;

/** Signature algorithms. HMAC is permitted for internal MACs only — never for an anchor. */
export const SIGNATURE_ALGS = ["ed25519", "hmac-sha256"] as const;
```

### 7.2 `AnchorRecord` — the truth anchor (immutable)

```ts
export const ClaimBodySchema = z.object({
  claimId: z.string().min(1).max(128),
  statement: z.string().min(1).max(4096),   // human-readable, never evaluated
  subject: z.string().min(1).max(256),
  scope: z.string().min(1).max(512),         // path glob, predicate, or "*"
  value: z.unknown().optional(),
}).strict();

export const AnchorEvidenceSchema = z.object({
  locator: z.string().min(1).max(1024),      // "ledger:EV-…", "file:<path>#<sha256>"
  contentHash: ContentHashSchema,           // binds the claim to bytes, not a pointer
  note: z.string().max(1024).optional(),
}).strict();

export const AttesterRefSchema = z.object({
  principalId: ActorSchema,
  keyId: KeyIdSchema,
  attesterClass: AttesterClassSchema,
  bindingHash: ContentHashSchema,            // hash of the ATTESTER_BINDING record
}).strict();

/** What the anchor authorises. THIS is the anti-replay control. */
export const ContextBindingSchema = z.object({
  contractId: z.string().min(1).max(128).optional(),
  effectId: z.string().min(1).max(128).optional(),
  purpose: z.enum(["assert", "authorise", "invalidate"]),
}).strict();

export const AnchorRecordSchema = z.object({
  id: idSchema("anchor"),
  contractVersion: z.literal("1.0.0"),
  tenantId: TenantIdSchema,
  kind: AnchorKindSchema,
  claim: ClaimBodySchema,
  evidence: z.array(AnchorEvidenceSchema).min(1),
  attester: AttesterRefSchema,
  issuedAt: TimestampSchema,                 // a CLAIM, not a proof
  notBefore: TimestampSchema.optional(),
  expiresAt: TimestampSchema.optional(),
  supersedes: idSchema("anchor").optional(), // history is never mutated
  context: ContextBindingSchema,
  anchorSeq: z.number().int().positive(),     // per-tenant monotonic counter
  attestationClass: z.enum(["TENANT_SIGNED", "OPERATOR_ASSERTED"]).default("TENANT_SIGNED"),
  provenance: ProvenanceSchema,
}).strict()
  .refine((a) => a.expiresAt === undefined || a.notBefore === undefined || a.expiresAt > a.notBefore, {
    message: "anchor expiresAt must be after notBefore", path: ["expiresAt"],
  })
  .refine((a) => a.kind !== "HUMAN_ATTESTATION" || a.attester.attesterClass !== "SELF", {
    message: "HUMAN_ATTESTATION requires a non-SELF attester class",
    path: ["attester", "attesterClass"],
  });
```

**The signed preimage** — the exact bytes signed, with no ambiguity and no
self-reference:

```ts
export function anchorPreimage(anchor: AnchorRecord): string {
  const { ...rest } = anchor;
  return canonicalJson(rest);   // sorted keys, NFC, no whitespace
}
```

### 7.3 `AttestationEnvelope`

```ts
export const SignatureSchema = z.object({
  alg: SignatureAlgSchema,
  keyId: KeyIdSchema,
  value: z.string().min(1).max(1024),        // base64 of the raw signature bytes
  preimage: z.literal("canonical-json-v1"),
  signedAt: TimestampSchema,
}).strict();

export const AttestationEnvelopeSchema = z.object({
  envelopeVersion: z.literal("1.0.0"),
  anchorId: idSchema("anchor"),
  payloadHash: ContentHashSchema,            // contentHash(anchor without any signature field)
  tenantId: TenantIdSchema,
  attester: AttesterRefSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema.optional(),
  nonce: z.string().min(22).max(128),        // anti-replay, single-use per (anchorId, context)
  context: ContextBindingSchema,
  signature: SignatureSchema,
  witnesses: z.array(WitnessSignatureSchema).default([]),
  countersignature: SignatureSchema.optional(),  // absence ⇒ tenant-signed
}).strict();
```

### 7.4 `CommitPointRecord` and `EffectRecord`

```ts
export const CommitStateSchema = z.enum([
  "PREPARED",      // durable intent: the answer exists and its hash is fixed
  "EMITTED",       // the bytes reached the host
  "ABORTED",       // the turn was abandoned before emission
  "INDETERMINATE", // a crash left it unclear whether bytes were emitted
]);

export const CommitPointRecordSchema = z.object({
  id: idSchema("commitPoint"),
  contractVersion: z.literal("1.0.0"),
  tenantId: TenantIdSchema,
  turnId: z.string().min(1).max(128),
  state: CommitStateSchema,
  answerHash: ContentHashSchema,             // identical on re-emission
  answerBytes: z.number().int().nonnegative(),
  effectIds: z.array(idSchema("effect")).default([]),
  target: z.string().min(1).max(256),        // "host:stdout", "host:mcp-response"
  durability: z.enum(["best-effort", "process-crash", "power-loss"]),
  at: TimestampSchema,
  emittedAt: TimestampSchema.optional(),
  prevChainHash: ContentHashSchema,
}).strict()
  .refine((c) => c.state !== "EMITTED" || c.emittedAt !== undefined, {
    message: "EMITTED requires emittedAt", path: ["emittedAt"],
  });

export const EffectStateSchema = z.enum([
  "IN_FLIGHT", "COMMITTED", "ABORTED", "INDETERMINATE",
]);

export const EffectRecordSchema = z.object({
  id: idSchema("effect"),
  contractVersion: z.literal("1.0.0"),
  tenantId: TenantIdSchema,
  turnId: z.string().min(1).max(128),
  effectId: z.string().min(1).max(128),      // deterministic idempotency key
  kind: z.enum(["FILE_WRITE", "TOOL_CALL", "MCP_CALL", "NETWORK", "PROCESS", "MESSAGE"]),
  target: z.string().min(1).max(1024),
  paramsHash: ContentHashSchema,
  idempotencySupported: z.boolean(),         // decides the recovery path
  statusQuerySupported: z.boolean().default(false),
  state: EffectStateSchema,
  resultHash: ContentHashSchema.optional(),
  errorClass: z.string().max(128).optional(),
  at: TimestampSchema,
  prevChainHash: ContentHashSchema,
}).strict()
  .refine((e) => e.state !== "COMMITTED" || e.resultHash !== undefined, {
    message: "COMMITTED requires a resultHash", path: ["resultHash"],
  });
```

### 7.5 The verification algorithm — fail closed, in order

```
verifyAnchor(anchor, envelope, store, now):
  1. schema-parse anchor and envelope            → invalid    → REJECT
  2. payloadHash === contentHash(anchor)          → mismatch   → REJECT
  3. envelope.anchorId === anchor.id              → mismatch   → REJECT
  4. envelope.tenantId === anchor.tenantId        → mismatch   → REJECT
  5. key = store.resolveKey(envelope.attester.keyId)
       unknown key                               → REJECT   (fail closed)
       REVOKED, compromiseSuspectedAt <= issuedAt → REJECT   (retroactive distrust)
       REVOKED, otherwise                        → VALID, flagged keyRevokedAfter
       validUntil < issuedAt                     → REJECT
  6. verify the signature over anchorPreimage    → bad        → REJECT
  7. binding = store.resolveBinding(keyId)       → absent     → REJECT
       binding.principalId !== attester.principalId → REJECT
       witness count < required(k)               → REJECT
  8. anchor.context === envelope.context, and it matches the operation → REJECT
  9. anchor.expiresAt < now                      → not VERIFIED; UNCItED for live purposes
 10. a valid anchor supersedes this one          → SUPERSEDED
 11. otherwise                                   → VERIFIED
```

No step is optional, and no step has a "default allow" branch. Note step 9:
an **expired** anchor is not *invalid*, it is *not current* — the distinction
is preserved in the status vocabulary.

---

## 8. What to defer, and why

| Feature | Verdict | Why |
|---|---|---|
| **Zero-knowledge proofs** | Defer | The goal is auditability, not privacy-preserving disclosure. ZK needs a heavy dependency and enormous complexity, and it does not answer the actual threat — a curious operator reading plaintext. Solved instead by honest scoping and tenant-side signing. Revisit only if a tenant must prove a fact *without* disclosing it. |
| **On-chain anchoring** | Defer | Costs money, breaks air-gap, leaks metadata, and is slower to finalise than needed (reorg risk) — it buys a timestamp. An RFC 3161 TSA or a single-purpose append-only service buys the same property for a fraction of the complexity. |
| **TOFU** | **Pin, do not TOFU** | TOFU accepts the first key seen, so a compromised or MITM'd *first* connection wins silently and permanently. Pinning obtains the fingerprint out of band and **fails closed on mismatch**. TOFU is acceptable only for a loopback-only server with no network exposure, and even then the first-use event is logged. |
| **"AI-generated identity"** | **Reject outright** | A model holds no key; anything it "possesses" is copied text, and copyability is not possession. It adds zero cryptographic assurance and manufactures a false sense of authentication. |
| **TPM / Secure Enclave** | Defer, but design for it | Genuinely valuable, but platform-specific and fragile. Introduce a `KeyProvider` interface now (`getKey(keyId) → KeyHandle`) with a file-backed implementation, and add a TPM-backed one later without touching call sites. |
| **A global transparency log (CT-style)** | Defer | It reintroduces the centralized party the design claims not to need. The per-tenant co-signed checkpoint already provides detection; keep the `CheckpointPublisher` interface so a transparency log is just another publisher. |
| **W3C Verifiable Credentials / SD-JWT** | Defer | Heavy, and a worker's factual claim is not a credential in the VC sense. `AnchorRecord` is deliberately VC-shaped (issuer, subject, claim, evidence) so a later VC export is a translation, not a redesign. |
| **Automatic lesson → verified-knowledge promotion** | **Defer permanently** | This is precisely the laundering mechanism (T8). Promotion requires an anchor; the worker can never supply one. |
| **Ledger encryption at rest with tenant-held keys** | Defer | Breaks "an auditor can reconstruct" for anyone but the tenant, and adds a key-management surface larger than the trust subsystem itself. Offer later as an explicit mode. |
| **A TSA timestamp on every record** | Defer | Per-checkpoint is sufficient; per-record is cost and latency for no additional property. |
| **Byzantine quorum across tenants** | Defer | There is no shared trust domain. A quorum over an untrusted set inherits the weakest member's guarantee. Quorum is only meaningful over a *single tenant's* witnesses. |
| **Hosted identity continuity** | Defer for LOCAL | The rebind-anchor scheme works fully offline; a hosted continuity service is an online dependency for a problem that has an offline answer. |

---

## 9. Notes for an implementer

1. **Do not** add a `WORKER_ATTESTATION` anchor kind. The worker must be
   unable to anchor facts; that is what makes T1 and T8 survivable.
2. **Do** change `fallbackLegal` to consider `IN_FLIGHT` effects, not just
   committed output. This is the single most important correctness fix in this
   design.
3. **Do** keep the chain hash key-independent and derived — never stored
   authoritatively — so rotation never breaks verification and an auditor needs
   only the bytes.
4. **Do** make the *unknown* path loud: unknown key, unknown kind, unknown
   attester class, expired key, failed unwrap ⇒ all fail closed, all logged as
   an anomaly, none silently coerced.
5. **Do not** describe LOCAL mode as providing non-repudiation. Use the §3.6
   wording verbatim in the audit export, the CLI output, and the marketing copy.
