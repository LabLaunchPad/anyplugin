# Decision Record

Every decision that shaped this codebase, why it was made, what was rejected,
and what it cost. A decision without a rejected alternative is not a decision —
it is a preference, and preferences are not worth recording.

**Status values** — `Accepted`, `Accepted (scoped)` (accepted with a stated
boundary on when it holds), `Proposed`, `Superseded by D-nnn`.

**How to read a decision** — the *Consequences* line is not bookkeeping. It is
the part that will be quoted when someone asks "why does this hurt?".

**Evidence classes** — the repo's own `KNOWN_BY` vocabulary, from
`packages/worker-runtime/src/resource/telemetry.ts`:

| Class | Meaning |
|---|---|
| `MEASURED` | Read from a system that was actually run |
| `DERIVED` | Computed deterministically from measured values |
| `ATTESTED` | Asserted by a named human or a primary source |
| `ESTIMATED` | A model or price table produced it — an opinion |
| `UNKNOWN` | Not observable here. Stays UNKNOWN; never defaulted |

---

## Theme A — Product scope and intent

### D-001 — AnyPlugin is a distribution layer; the Worker Runtime is a separate kernel

**Status:** Accepted · **Date:** 2026-08 (frozen) · **Evidence:** `ROADMAP.md` §2

**Context:** The same repository holds two things with different lifecycles: a
plugin distribution pipeline, and a deterministic kernel that records what
happened. They can be one project, but they cannot be one *layer*.

**Decision:** `core/`, `adapters/`, `cli/` are the distribution layer. The
kernel lives in `packages/worker-runtime/` and is consumed by everything else.
The kernel never depends on the distribution layer.

**Alternatives rejected:** One package containing both (the kernel needs `zod`
only; the CLI needs `yaml`, `smol-toml`, the four adapters). A shared package
(creates a dependency cycle the boundary guard cannot express).

**Consequences:** The kernel cannot reference an agent, a plugin format, or the
CLI. Every feature that seems to need that has to be expressed in the kernel's
own vocabulary — which is the point.

---

### D-002 — The kernel depends on no workspace package, not even `core`

**Status:** Accepted · **Evidence:** `core/src/boundaries/package-boundary.test.ts`

**Context:** `core` carries agent-specific knowledge (which agent supports
which hook event). If the kernel imported it, the kernel would inherit that
knowledge and stop being agent-agnostic.

**Decision:** The kernel's only dependency is `zod`. The guard reports
`ARMED` / `PASSED` / `FAILED` and **never reports `ARMED` as `PASSED`** — a
vacuously-green check is worse than no check, because it manufactures
confidence.

**Consequences:** The kernel re-implements small primitives (the actor and
timestamp conventions) rather than importing them. That is duplication, and it
is deliberate: the comment in `contracts/primitives.ts` says so.

---

### D-003 — The Agent/Worker/Employee SDK is a **separate product** that uses the kernel as substrate — it is not AnyPlugin scope

**Status:** Accepted (scoped) · **Date:** 2026-10-20 · **Evidence:** `ROADMAP.md` §1, §6; `docs/agent-sdk/README.md`

**Context:** A reviewed architecture describes a standalone "AI Agent/Worker/
Employee SDK": three deployment modes, a grounding service, a prompt-cache
middleware, a batch orchestrator, a control plane, device runtimes, an SI
partnership kit, and a business layer. It is a *large* product, and it shares
vocabulary with this repository — "worker", "evidence", "knowledge", "learning".

**Decision:** The SDK is specified in `docs/agent-sdk/` as a **specification of
intent**, and the Worker Runtime is recorded as its **substrate** — the layer
it would sit on. The SDK's own modules are **not** AnyPlugin modules, they are
not on AnyPlugin's roadmap, and their acceptance criteria do not gate
AnyPlugin's build. AnyPlugin ships the kernel contracts the SDK would consume;
the SDK is a consumer, not a component.

**Alternatives rejected:** Building the SDK inside AnyPlugin (it would make the
distribution layer's release cadence hostage to a product that is not a
plugin). Folding the SDK's contracts into the kernel's frozen contracts (the
kernel's contracts are at `1.0.0` and certificate-bound; a speculative
consumer's needs are not a reason to version them). Leaving it in chat only
(the reasoning would be lost, and the next session would re-derive it).

**Consequences:** Two vocabularies now exist — "evidence" in the kernel
(`Evidence` records with authority/validity) and "evidence tier" in the SDK
(`VERIFIED` / `UNCITED` / `BROKEN` / `UNSUPPORTED`). **D-006** resolves the
collision: the tier is a *projection* over the kernel record, not a new
ledger. And every SDK acceptance criterion that would touch the kernel says
exactly what it would change, so the cost of the substrate coupling stays
visible.

**The boundary, stated for the record:** `ROADMAP.md` §1 already says the
product is "**not** another agent SDK". The SDK spec lives here because it
*consumes* the kernel and because the reasoning is worth keeping — not because
AnyPlugin is becoming it.

---

### D-004 — "Polylithic" means one stable contract per layer, and it is the only thing that makes it safe

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/README.md` §2

**Context:** Multiple native runtimes means multiple build pipelines, multiple
release cadences, and a canonical specification that must be versioned
carefully. The coordination cost is real and was understated in the first pass
of the review.

**Decision:** The invariant is explicit: **every layer has a stable contract**
— a schema, a protocol, or an API — so that its implementation can be replaced
without touching its consumers. The canonical manifest, the JSON Schema
mirror, the event map, the journal schema and the ten kernel contracts are all
such contracts, and each is either drift-guarded by a test or explicitly
versioned.

**Alternatives rejected:** "No irreversible tradeoffs" as a slogan (it is
unfalsifiable; the contract invariant is falsifiable — a layer without one
fails the check). Monolithism (a single implementation is a single point of
failure, and the audit's twelve findings were all *contract* failures).

**Consequences:** Every contract needs a drift test or a version field. That is
the recurring cost, and it is paid deliberately.

---

## Theme B — Evidence, truth, and trust

### D-005 — The epistemic ladder is four rungs and is the *only* trust axis

**Status:** Accepted · **Evidence:** `packages/worker-runtime/src/contracts/primitives.ts:88`

**Context:** A system that learns from its own execution will invent a second
way to express "how much do we trust this?" — a candidate lifecycle, a
confidence score, a trust tier. Two answers to one question is a silent
collision, and this repository has already paid for one (`FAILURE_CLASSES`).

**Decision:** `OBSERVATION → LESSON → HYPOTHESIS → VERIFIED_KNOWLEDGE`, and
`rungIndex()` is the only ordering authority. The load-bearing constraint is
enforced in the *schema*, not in prose: `ExperienceSchema` refuses
`VERIFIED_KNOWLEDGE` without at least one supporting evidence id.

**Consequences:** A rung advance is an event, always. Promotion needs its own
evidence, always. There is no shortcut, and the shortcut cannot be configured
away.

---

### D-006 — The SDK's four evidence tiers are a **derived projection** over `EvidenceSchema`, not a new ledger

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `packages/worker-runtime/src/contracts/index.ts:139-182`; `docs/agent-sdk/trust.md` §2

**Context:** The reviewed design proposes `VERIFIED` / `UNCITED` / `BROKEN` /
`UNSUPPORTED`. The kernel already records `authority` (`AUTHORITATIVE` /
`DERIVED` / `REPORTED`), `validity` (`VALID` / `INVALIDATED` / `SUPERSEDED`),
`contentHash` and `provenance`.

**Decision:** The tier is computed from the existing fields:

| Tier | Derivation |
|---|---|
| `VERIFIED` | `authority = AUTHORITATIVE` ∧ `validity = VALID` ∧ ≥1 citation that resolves ∧ producer lineage external to the claiming worker |
| `UNCITED` | `validity = VALID` but no citation, or `authority = REPORTED` |
| `BROKEN` | `validity = INVALIDATED` |
| `UNSUPPORTED` | `authority = DERIVED` from an UNCITED source, or an empty evidence set |

**Alternatives rejected:** A second evidence ledger (two write paths, two
audit stories, and a third party asking "which is authoritative?" gets no
answer). Renaming the kernel's fields (a versioned migration of frozen,
certificate-bound contracts for a consumer's convenience).

**Consequences:** The tier is not stored — it is derived, so it cannot drift
from the record it describes. The cost is that a tier query is a fold, not a
field read.

---

### D-007 — The worker cannot anchor facts

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/trust.md` §1 (T1, T8)

**Context:** If the worker can sign a truth anchor, then a hallucinating or
prompt-injected model can launder a false claim into "verified" and the
anti-poisoning design collapses. The learning loop is the laundering path: a
false claim enters memory as a lesson, is recalled, and is eventually promoted.

**Decision:** There is deliberately **no `WORKER_ATTESTATION` anchor kind**.
The anchor kinds are `HUMAN_ATTESTATION`, `HARDWARE_SIGNAL`, `REGULATORY_INPUT`,
`EXTERNAL_OBSERVATION`, `SIGNED_DOCUMENT`, `CONSENSUS_RESULT`. The worker signs
*checkpoints* and *commit records*; it never signs a *fact*.

**Consequences:** Promotion from `HYPOTHESIS` to `VERIFIED_KNOWLEDGE` always
requires an anchor from an admissible attester class. The worker can request
promotion; it cannot perform it.

---

### D-008 — HMAC is forbidden for anchors; ed25519 per-principal keys

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/trust.md` §3

**Context:** The reviewed design proposed HMAC-SHA256 signing for truth
anchors.

**Decision:** HMAC is **forbidden for anchors in every mode**. With a shared
secret, everyone holding it can forge — including the worker, if the worker
holds it. That destroys D-007 immediately. HMAC is permitted only for an
internal at-rest workspace MAC where attribution is explicitly *not* claimed.
Anchors use ed25519, one keypair per principal.

**Consequences:** A local deployment needs key custody, not just a secret: the
attester's key must live in a process the worker cannot read (an `attest`
helper on a device, or a socket-bound attestor service). That is more friction
than a shared secret, and it is the friction that makes the property real.

---

### D-009 — Pinning, not TOFU

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/trust.md` §7

**Context:** Trust-On-First-Use accepts the first key it sees. A compromised
or MITM'd first connection therefore wins silently and permanently.

**Decision:** Obtain the fingerprint **out of band** (printed at install, or
copied through a trusted channel), store it in a trusted-attester set, and
**fail closed on mismatch** with an explicit, logged re-pin path. TOFU is
acceptable only for a loopback-only server with no network exposure, and even
then the first-use event is logged.

**Consequences:** A first-run ceremony exists, and it is manual. A deployment
that skips it is detectable.

---

### D-010 — There is no "AI identity"

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** A "Worker" appearing in a product specification can read as if it were an account — something with an identity to which permissions are granted. The temptation is to treat the model's assertions as credentials, or to invent a scheme in which a model is the subject of a signature.

**Evidence:** `docs/agent-sdk/trust.md` §7

**Decision:** Reject the concept outright. A model holds no key; anything it
"possesses" is copied text, and copyability is not possession. A worker is
identified by its key; the model is an *actor inside* the worker and is never a
principal.

---

**Consequences:** The worker is identified by its key, and a key can be rotated, revoked, and rebound. A model can do none of those, because it holds nothing. The cost is that every record must name the *worker*, and a reader who wants to know which model produced a claim must look in the event payload rather than at an identity field. That is a one-line cost for removing an entire class of confusion.
### D-011 — Truth anchors beat internal memory; facts evolve by supersession

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/trust.md` §6

**Context:** Memory poisoning: a false claim remembered as fact, then recalled
as corroborated.

**Decision:** The claim resolver consults the anchor store **first**. On
conflict the anchor wins, the memory entry is `INVALIDATED` with reason
`ANCHOR_CONFLICT`, and the invalidation cascades to dependent decisions
(the kernel's `REOPENED` transition). A shadowed memory entry can never be
re-promoted while the anchor stands. Facts evolve by appending a supersession
pointer; history is never mutated.

**Consequences:** The kernel's `Validity` enum already separates `SUPERSEDED`
("a newer record replaces it") from `INVALIDATED` ("it should no longer be
relied on at all") — the same distinction, already earned.

---

### D-012 — The chain hash is key-independent and derived, never stored authoritatively

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** A ledger signed record-by-record must be re-signed whenever a key rotates, and a verification path that depends on a key is a verification path that breaks on a schedule. A key rotation would then look like a corruption.

**Evidence:** `docs/agent-sdk/trust.md` §8.6

**Decision:** `chainHash_n = sha256(canonicalJson({prevChainHash, recordHash}))`,
recomputable from the log bytes alone. The `chain.head` side file is a
**cache** of the head, and its *disagreement* with the recomputed head is
itself a signal. Key rotation therefore never breaks chain verification, and
an auditor needs only the bytes.

**Consequences:** A rotation is not a re-signing event. The head file is
advisory, which means it can be stale — and the check that matters is the
recomputation, not the file.

---

### D-013 — `fallbackLegal` must consider **in-flight effects**, not just committed output

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `packages/worker-runtime/src/telemetry/delegation.ts` (`fallbackLegal`); `docs/agent-sdk/trust.md` §5.3

**Context:** The current rule is "once output is committed to the host, the
chain is closed". That is insufficient. An attempt can have committed an
**effect** — a file written, a payment sent — while producing no output at
all. Falling back then re-runs the effect.

**Decision:** The rule becomes:

```
fallbackLegal(attempt) ⇔ no EFFECT in {IN_FLIGHT, COMMITTED} ∧ no COMMIT_POINT exists
```

An `IN_FLIGHT` effect forbids the fallback, because it may have partially
executed.

**Consequences:** This is a **change to a shipped kernel contract** and is
recorded in `docs/BACKLOG.md` as an open P1 with the exact edit named. It is
not applied in this change because it alters a frozen, certificate-bound
contract and needs its own versioned migration.

---

## Theme C — The learning loop

### D-014 — The optimizer lives **above** the kernel, and runs out of band

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/optimization.md` §0.1

**Context:** An optimizer that runs inside the worker's critical path turns
every optimizer bug into a worker bug.

**Decision:** The optimizer is a separate process that reads the log. It takes
the writer lock like any other writer, so single-writer is preserved. The
kernel records and verifies; it never infers (kernel design rule 6).

**Consequences:** The optimizer can be disabled, and the worker does not
notice. That property is the reason the optimizer's budget exists (D-026).

---

### D-015 — A policy is a content-addressed declarative artifact; no policy mutates executable code

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** The reviewed architecture leaned on an "AIWorker with a Soul" pattern as though it were established prior art. A search of GitHub — repository names, code and description, plus the "AIWorker" + "Soul" combination — found nothing citable: 115 repositories named AIWorker, all visibly unrelated, and zero repositories matching both terms. The search was GitHub-only, so a private post could exist. That is why the verdict is UNKNOWN rather than "does not exist".

**Evidence:** `docs/agent-sdk/optimization.md` §0.1 (A2)

**Decision:** A *policy* is a versioned, declarative, content-addressed
artifact that changes worker behaviour: prompt template, tool routing, budget
caps, backend weights, retry/timeout parameters, cache TTL. **No policy
mutates executable code.** A *learning* is knowledge (an `Experience` record);
a *policy* is a change in behaviour derived from a learning. They are separate
records.

**Consequences:** Every guarantee about a policy becomes a file comparison
rather than a program audit. Rollback is byte-for-byte (D-016).

---

### D-016 — The optimizer's plan is a **pure fold over the event log**

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/optimization.md` §1.7

**Context:** An optimizer with its own database can disagree with the ledger.
Which one is authoritative? The question has no good answer.

**Decision:** The plan is a pure function of the log (plus an injected clock, an
injected price table, and a seeded PRNG whose seed is
`sha256(policyId ‖ candidateId ‖ windowId)`).

**Consequences:** Idempotency is free — re-running after a crash recomputes the
same plan, and promotion events get a deterministic id so a duplicate append
is detectable as a duplicate. Replay *is* the audit: "why did the system behave
this way on date X" is "replay to X and re-run the fold". There is no optimizer
database to disagree with the log.

---

### D-017 — Two orthogonal axes: the kernel's epistemic rung, and a new operational stage

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** The kernel already owns an epistemic ladder. A second "candidate lifecycle" ladder would create two answers to "how much do we trust this?" — the collision the kernel file already documents when it renamed the two `FAILURE_CLASSES` symbols.

**Evidence:** `docs/agent-sdk/optimization.md` §1.1

**Decision:** A candidate has two coordinates, and they may not move
independently without a recorded event each.

- **Axis E (epistemic, the kernel's):** `OBSERVATION → LESSON → HYPOTHESIS → VERIFIED_KNOWLEDGE`.
- **Axis S (operational, new):** `CAPTURED → EXTRACTED → VALIDATING → VALIDATED → SHADOWED → ENACTED → RETIRED`, with `REJECTED` reachable from most stages and re-entry only via `VALIDATING`.

**The binding rule:**

> Operational activation requires epistemic rung ≥ `HYPOTHESIS` **and** Axis-S
> stage ≥ `SHADOWED`.

Epistemic truth does not imply operational safety, and operational safety does
not imply epistemic truth. A candidate may be *known true* and still be
un-enacted because it was never shadowed; a candidate may be *shadowed and
safe* while remaining epistemically a `HYPOTHESIS` forever.

**Consequences:** The checkable invariant is
`enacted ⟹ (rungIndex ≥ rungIndex("HYPOTHESIS")) ∧ (stage ≥ SHADOWED)`. The
forbidden jumps are enumerated and mechanically unreachable (D-018).

---

### D-018 — Shadow evaluation precedes enactment; twelve gates, all of them mechanical

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** A policy promoted on a production measurement has already been measured on the traffic it was measured on. The evidence that the change is safe was gathered under the *old* policy, and it does not transfer. A candidate that would improve the measured metric only by degrading something unmeasured is the failure mode this closes.

**Evidence:** `docs/agent-sdk/optimization.md` §2.4

**Decision:** A candidate's decision function is computed on live traffic and
**never enacted**; where the candidate's decision is side-effecting, it is
**not executed at all**, only scored. Assignment is a deterministic hash
bucket, not a coin flip, so a ramp step does not reshuffle populations.

Twelve gates, all required: minimum sample (200 paired, and ≥30 in every task
class), minimum duration (7 days), statistical confidence (one-sided 95% lower
bound of Δsuccess > 0, paired bootstrap, seeded), materiality (Δsuccess ≥
+1.0pp), guard tolerance, coverage (≥0.90, else `BLOCKED` not `PASS`),
evidence integrity (0 invalidated), holdout confirmation (20%), provenance
purity (the candidate may not verify itself), budget, flap-free, and a
conditional human gate.

**Consequences:** A promotion takes at least a week. That is the intended
cost: a system that improves itself weekly can also damage itself weekly, and
the rollback machinery (D-020) is the safety net that makes the week
affordable.

---

### D-019 — The ramp is 1% → 10% → 50% → 100%, with soaks

**Status:** Accepted · **Date:** 2026-10-20 · **Decision:** Enact a candidate in stages, and require a soak at each stage before advancing.

**Context:** A policy promoted straight to full traffic is a policy whose failure is observed by its users. The blast radius of a mistake is the whole user base, and the detection time is however long a user takes to complain.

**Evidence:** `docs/agent-sdk/optimization.md` §3.1

| Stage | Traffic | Soak to advance |
|---|---|---|
| `SHADOW` | 0% (observed) | all 12 gates |
| `CANARY` | 1% | 24h ∧ ≥50 tasks |
| `PARTIAL` | 10% | 72h ∧ ≥200 tasks |
| `HALF` | 50% | 7d ∧ ≥1 000 tasks |
| `FULL` | 100% | known-good advances after a further 7d soak |

**Consequences:** Blast radius is bounded by a **slot**, and one slot has one
live version at a time. A policy whose *mechanism* is new is capped at
`CANARY` and cannot exceed `PARTIAL` without human approval.

---

### D-020 — Rollback happens **before** diagnosis

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/optimization.md` §3.3

**Context:** Seven automatic rollback triggers, any one of which fires an
immediate rollback with no human and no debate.

**Decision:** The order is: **detect → rollback → record → diagnose.** A
rollback that waits for a human to understand why is a rollback that did not
happen. The mechanical sequence is: emit the rollback event → atomic pointer
swap to the known-good artifact → **re-verify the hashes after the swap** →
if verification fails, the worker **halts** (fail closed) and pages. It never
continues on an unverified configuration.

**Consequences:** Diagnosis happens on a system that is already safe, which is
the only state in which diagnosis is safe.

---

### D-021 — Flapping is a safety event; quarantine, and only a human can unpin

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/optimization.md` §4

**Context:** A bad policy costs one bad period. A flapping policy costs
repeatedly, and it destroys the signal value of every other metric — after
three flip-flops, "the policy is live" carries no information.

**Decision:** Four detectors (oscillation count, repeat offender, alternation,
slot churn). On a trip: immediate rollback, a `POLICY_PINNED` event carrying
the detector and the history, and **quarantine** — the extractor refuses to
re-propose the pinned `contentHash`, the candidate is excluded from shadow
evaluation, and it cannot be promoted again at all. Only a human can unpin,
with a recorded id and a 30-day cooldown.

**A hysteresis band** is the other half: any evaluation whose Δsuccess point
estimate lies within ±1.0pp of zero is `INCONCLUSIVE` — it never promotes and
never rolls back.

**Consequences:** A pin is visible, with its reason attached. A pin that hides
is a rollback with extra steps and no audit trail.

---

### D-022 — The never-automated list is a **constant in code**, not configuration

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/optimization.md` §6

**Context:** The kernel already established the precedent: `FAIL_POLICY` is a
constant because *"an operator must not be able to configure the unsafe
combination"*.

**Decision:** Thirteen decisions always require a human, no matter how good the
measured evidence is: changing what the worker is *permitted* to do (tool
allow-lists, file scope, egress, credentials, spend caps); any change to
auth/secret handling; deleting or invalidating evidence; any change to the
frozen contracts, the epistemic ladder, the verification engine, or the event
log format; any change to the promotion gates, budgets, or the
never-automated list itself; self-modifying code; auto-generated executable
tools; assigning the `human-reviewed` trust tier; raising a contract's risk
level or widening its scope; accepting evidence from the candidate's own
execution lineage; unpinning; deciding a task is done without an external
verifier; and any change to the *existence* of the loop.

**Consequences:** A human approval must name the candidate's `contentHash` it
approves. Approving "the plan" rather than the bytes means the bytes can
change afterwards and the approval silently transfers to something the human
never saw.

---

### D-023 — Nine top signals, and six rules that make them hard to game

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** A self-improving system needs a way for a human to tell whether it is improving. The naive answer — a dashboard of quality metrics — is exactly the answer that a metric-gaming system will satisfy, because the system is optimising the same numbers the dashboard shows.

**Evidence:** `docs/agent-sdk/optimization.md` §7

**Decision:** Nine signals: evidence-tier mix and drift · cache effectiveness
versus break-even · delegation failure-class mix and circuit state · the
learning funnel (validation / promotion / rollback) · grounding denial rate ·
cost per task and per verified claim · shadow sufficiency and coverage · work
deferral and escape rate · verifier divergence.

The six anti-gaming rules, applied to every signal:

1. The denominator comes from outside the optimizer's control (tasks executed,
   not claims produced).
2. Every quality metric is paired with a cost metric and a difficulty control.
3. The system may not count as evidence for itself.
4. Coverage is reported with every ratio; below the threshold the result is
   `BLOCKED`, never `PASS`.
5. No single aggregate decides — two signals from different families must agree.
6. Every signal has a sampled human audit (N=20/week, blind to the metric's
   framing).

**Why nine and not ten.** Evidence quality and verifier divergence are not
redundant: a system can have a beautiful evidence ledger and lie about
completion. A tenth signal would most likely duplicate cost or promotion,
which are already paired against a live control arm.

---

**Consequences:** A promotion requires **two signals from different families** to agree, so no single gameable metric can enact a change. The cost is a slower promotion path and a larger surface to instrument, and the benefit is that a system optimising the dashboard still has to do the work. The signals that cannot be made measurable are listed as auditable rather than measured, so the limit is visible instead of implied.
### D-024 — Reuse the kernel's delegation failure taxonomy; do not re-invent one

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** The SDK design needed a failure taxonomy, and the kernel already has two. A third vocabulary would have been a third answer to "how do we classify a failure" — the same silent-collision problem the kernel already paid for once.

**Evidence:** `packages/worker-runtime/src/telemetry/delegation.ts`

**Decision:** The SDK's failure handling uses
`DELEGATION_FAILURE_CLASSES` and `FAILURE_BEHAVIOUR` verbatim, and the
`FAIL_POLICY` two-axis constants (capability fails closed, health fails open).

**Consequences:** The signal table's S3 reads the same events the wrapper
already emits. A third vocabulary would have been a third answer to "how do we
classify a failure".

---

## Theme D — Economics: caching and batching

### D-025 — Prompt caching is a **measured optimization**, not a default

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/EVIDENCE.md` E1–E8; `docs/agent-sdk/economics.md` §1

**Context:** Caching that is not carefully managed can silently *increase*
cost when the hit rate falls below break-even, and it can also serve a stale
or wrong answer.

**Decision:** Caching is enabled only where it is measured to pay. The SDK
tracks hit rate, write cost and re-prefill cost per worker and per model, and
**warns and suggests disabling** when the hit rate falls below break-even. The
break-even formula, and the per-provider multipliers that feed it, are in
`docs/EVIDENCE.md` with sources and access dates.

**Consequences:** A cache is not free, and a cache that stops hitting is a
cost regression with no visible symptom. The monitor is the only thing that
makes it visible.

---

### D-026 — Batching is **policy-gated**

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** A 50% discount is the largest single lever available on inference cost, and it is therefore the most likely to be switched on enthusiastically and left on.

**Evidence:** `docs/EVIDENCE.md` E9–E12; `docs/agent-sdk/economics.md` §2

**Decision:** A task goes to batch mode only if it is non-interactive,
idempotent, latency-tolerant, and the saving exceeds the operational cost of
polling and reconciliation. Batch calls use a separate rate-limit pool
(verified per provider).

**Consequences:** The savings are real and large (50% on input/output across
the three major providers) but the eligible workload set is much smaller than
"everything that isn't interactive".

---

### D-027 — The provider table in the reviewed answer is **wrong** in three places, and the corrected table is the one of record

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** The reviewed architecture quoted a provider pricing table from memory. Three of its rows were wrong, and two of them in the direction that makes caching look *more* attractive than it is — the OpenAI row omitted the cache-write charge that arrived with GPT-5.6, and the DeepSeek row overstated the cached-read discount by an order of magnitude. A table that flatters the optimisation is the most dangerous kind of error to publish.

**Evidence:** `docs/EVIDENCE.md` E3, E5, E8

**Decision:** The reviewed architecture's caching table is corrected:

| Reviewed claim | Reality (verified 2026-10-20) |
|---|---|
| "OpenAI: writes are free; cached ≈25–50% of base" | Writes cost **1.25×** for GPT-5.6 and later; cached read is **0.1×** (0.05× for `gpt-6.1-sol`); 0.25–0.5× describes legacy models only |
| "DeepSeek: 0.1× base, 0.032× off-peak" | Cache hit is **1–3.3%** of the miss price (¥0.02/¥0.04 flash, ¥0.15/¥0.30 v4-pro); off-peak exists but is exactly **50% of peak** across all prices |
| "GLM-5.3 744B: $0.459 vs $1.58 (71% saving)" | GLM-5.3 is real and 744B-class ($1.40 in / $0.26 cached / $4.40 out). Input-only recompute: **$0.84 → $0.2244 (73.3%)**; with 5k output tokens/turn: **$1.50 → $0.884 (41%)**. The published figures do not reproduce |

**Consequences:** A spec that publishes remembered prices publishes errors.
`docs/EVIDENCE.md` records the source URL and access date for every number,
and `docs/BACKLOG.md` records the standing requirement to re-verify before
publication.

---

### D-028 — The recorded call log is the source of truth; caching never changes the result

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** A cache is an optimisation, and an optimisation that can change what a system returns is not an optimisation — it is a second, faster, harder-to-reason-about implementation of the same function.

**Evidence:** `docs/agent-sdk/economics.md` §1.3

**Decision:** Replay returns the recorded result without consulting the cache.
Caching changes only the *cost* of producing a result, never the result.

**Consequences:** A cache bug is a cost bug, not a correctness bug — unless it
is in the *write* path, which is why the local content-addressed cache keys on
a digest of the assembled request and the digest is recorded.

---

### D-029 — The 21.74% break-even is a **derivation**, not a provider figure

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** The 21.74% figure is quoted in the reviewed architecture as though a provider published it. No provider publishes a hit-rate break-even; Anthropic's own framing is in terms of cache *reads* rather than a rate.

**Evidence:** `docs/EVIDENCE.md` E2

**Decision:** State it as derived, with the formula and the assumption (every
miss incurs a fresh write): `h = (W−1)/(W−R)`. 5-minute TTL → **21.74%**;
1-hour TTL → **52.63%**. Anthropic's own published framing is different
("pays off after one cache read for the 5-minute duration, after two for the
1-hour"). No provider publishes a hit-rate break-even.

**Consequences:** The number is model-dependent (0.05× read models → 20.83% /
51.28%) and TTL-dependent, so a spec must not quote a single figure as if it
were universal.

---

## Theme E — Process and discipline

### D-030 — A contract with no test is a comment

**Status:** Accepted · **Date:** 2026-10-19 · **Evidence:** `AGENTS.md` (Definition of done); `docs/SESSION-LEARNINGS.md` §1

**Context:** The audit's twelve findings shared one root cause: **a contract
that was declared but never enforced**. `timeoutSec` was in the schema and
ignored. `failurePolicy` was in the schema and ignored. The journal had a
schema and was cast rather than validated.

**Decision:** Every contract ships with a test that fails without it. The
definition of done is `pnpm build` clean and `pnpm test` green with no silent
skips.

---

**Consequences:** Every fix in this cycle ships with a regression test that fails without it, and the definition of done says so. The cost is that a contract change now costs a test, which is the point: a contract with no test is a comment that will drift, and the drift is invisible until it is expensive.
### D-031 — A failure that cannot be classified is **not retried**

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/FAILURE-MODES.md` §1; `packages/worker-runtime/src/telemetry/delegation.ts`

**Context:** A wrapper that guesses "this unrecognised error is probably a
timeout" and retries it against a second backend has not recovered — it has
converted one failure into two, without evidence.

**Decision:** `unknown` is a real failure class with behaviour `report`. It is
not retryable and not fallback-able. A separate class, `backend_failed`,
covers the honest case where the backend ran and failed without saying why:
the failure is known to be about *this* backend, so a fallback is legal, and
no cause is invented.

---

**Consequences:** The chain stops earlier than a naive implementation would, so some recoverable failures are reported rather than retried. That is the intended trade: a reported failure costs one attempt, and a misclassified retry costs two — one wasted, and one that may have taken a different path than the operator intended.
### D-032 — Capability fails closed; health fails open

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `packages/worker-runtime/src/telemetry/delegation.ts` (`FAIL_POLICY`)

**Context:** Two different questions that were being conflated.

**Decision:** An `UNKNOWN` capability is refused — never attempted. When every
candidate is unhealthy, the chain still tries — because refusing everything is
a self-inflicted outage. These are **constants**, not configuration.

---

**Consequences:** The two axes are constants, so an operator cannot configure the unsafe combination — they can only choose, at the registry level, which backends declare which capabilities. The cost is a slightly-heavier registry: a capability that is not declared is UNKNOWN, and an UNKNOWN capability is excluded, so a backend that is usable but undocumented is not usable.
### D-033 — Never a shell, never unbounded, never an unbounded environment

**Status:** Accepted · **Date:** 2026-10-20 · **Context:** A wrapper that runs other people's processes is the first place in this codebase where untrusted text becomes an operating-system command. Everything else the project does is file- or JSON-shaped; this is not.

**Evidence:** `cli/src/delegate.ts`

**Decision:** The backend command and its arguments go to `spawn` as an argv
array with `shell: false`. Every attempt has a deadline and an output cap
(measured in **bytes**, on the stream as it arrives). The child gets an
environment **allowlist**, because a blocklist has to anticipate every secret.

---

**Consequences:** The wrapper is the one component where an injection bug is a remote-code-execution bug rather than a wrong answer, so its invariants are stated as rules in `docs/FAILURE-MODES.md` and enforced by tests that drive the real failure paths rather than mocks. The cost is a spawn layer with a deadline, a byte cap, an environment allowlist, and a process-group kill — four mechanisms that would not be needed if the wrapper only ever ran trusted commands.
### D-034 — The documentation is code, and its ownership is enforced

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `ARCHITECTURE.md` §7; `core/src/boundaries/doc-ownership.test.ts`

**Context:** Seven documents described the architecture slightly differently;
eight different test counts appeared across seven files; `AGENTS.md` documented
a runner exit code that did not exist.

**Decision:** One document owns the shape (`ARCHITECTURE.md`); every other
document **links** rather than restates. The ownership map is machine-checked:
a test asserts that every markdown file under `docs/` appears in the map and
that every file the map names exists.

**Consequences:** Adding a document without registering its owner fails the
build. That is the point — a document nobody owns is a document nobody
maintains.

---

### D-035 — Never quote a number in prose; generate it or omit it

**Status:** Accepted · **Date:** 2026-10-19 · **Evidence:** `AGENTS.md` (Commands)

**Context:** Eight different test counts across seven documents, all of them
stale within one cycle.

**Decision:** Prose says "run `pnpm test` for the count", never a number. A
count in prose is a claim that decays.

**Consequences:** The one exception is a threshold that is deliberately
recorded as a `[GUESS]` with the reason and the condition that would turn it
into a measurement — a guess *labelled as a guess* is a decision, not a
decay.

---

### D-036 — A read must not have a side effect

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `packages/worker-runtime/src/telemetry/delegation.ts` (`isRefusing` vs `canAttempt`)

**Context:** `selectBackend` called `canAttempt()` to decide whether a
candidate was reachable. `canAttempt` is not a query: it claims the circuit's
single half-open trial slot. So a candidate that was *considered and passed
over* had its trial consumed by a decision that was never acted on, and the
backend could never be tried again — a permanent silent exclusion produced by
a read.

**Decision:** Separate the read (`isRefusing(now)`) from the claim
(`canAttempt(now)`). The claim happens at the moment an attempt is actually
made.

---

**Consequences:** Every state-mutating primitive in the codebase now has a read-only counterpart, and the two are named differently (`isRefusing`/`canAttempt`). The cost is a slightly wider API surface; the benefit is that a function whose name begins with "is" cannot change anything, which is a property a reader can check without reading the body.
### D-037 — One log, not two

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** `docs/agent-sdk/optimization.md` §0.2 (the required kernel change)

**Context:** The candidate lifecycle and the policy promotions need event kinds
that do not exist in `EventSchema.kind`. The alternative is a sidecar
optimizer log.

**Decision:** Add the kinds to the kernel's event log under a **versioned
migration** (`CONTRACT_VERSION` 1.0.0 → 1.1.0), which the contracts file
explicitly sanctions. Certificates already carry `contractVersion`, so 1.0.0
certificates stay valid.

**Alternatives rejected:** A sidecar log (two write paths, two hash chains,
two audit stories, and no answer to "which is authoritative?").

**Consequences:** `docs/BACKLOG.md` records the change as an open P1 with the
exact kinds named. It is not applied in this change because it versions frozen
contracts.

---

### D-038 — An adversary review is part of the definition of done

**Status:** Accepted · **Date:** 2026-10-20 · **Evidence:** PR #28 review trail

**Context:** The branch passed its own full test suite and was still shipped
with four BLOCKERs — including one where the branch was **committed red**, one
where the OpenCode shim silently discarded a blocking hook's denial, one where
the YAML parser still mis-parsed valid YAML in exactly the way it was written
to fix, and one where a failed rollback destroyed the only copy of the user's
pre-install data.

**Decision:** A change is not done until an independent adversarial review has
run against it and every finding is either fixed or classified into the
backlog with an honest scope note. **"Not fixed" is an acceptable outcome;
"not recorded" is not.**

**Consequences:** Reviews produce work. That is the correct trade: the
alternative is shipping the four defects above.

---

## Related documents

| Question | Owner |
|---|---|
| What does the system look like? | `ARCHITECTURE.md` |
| What goes wrong, and what does the system do? | `docs/FAILURE-MODES.md` |
| What is still open, and why? | `docs/BACKLOG.md` |
| What did the last sessions establish? | `docs/SESSION-LEARNINGS.md` |
| Where does every external claim come from? | `docs/EVIDENCE.md` |
| Who is this for, and what are they accountable for? | `docs/PERSONAS.md` |
| What is the SDK, and what does it consume? | `docs/agent-sdk/README.md` |
