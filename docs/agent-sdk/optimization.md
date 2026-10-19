# The learning loop and the top signals

How the system improves itself, and how a human reads whether that
improvement is real.

**Design, not implementation.** The kernel primitives it would use mostly
exist; the two kernel changes it would need are named in
`docs/BACKLOG.md` and in D-037.

---

## 1. Assumptions

Everything below depends on these. If one is false, the rest needs rework.

| # | Assumption | If it is false |
|---|---|---|
| A1 | The optimizer lives **above** the kernel; the kernel records and verifies but never infers | Putting the optimizer inside the kernel breaks kernel design rule 6 and gives the kernel a network and clock dependency |
| A2 | A **policy** is a versioned, declarative, content-addressed artefact that changes behaviour — prompt template, tool routing, budget caps, backend weights, retry/timeout parameters, cache TTL. **No policy mutates executable code.** | If policies could carry code, every guarantee becomes "audit a program" instead of "compare two files" |
| A3 | "Traffic" means *executions*, and arm assignment is a **deterministic hash bucket**, never a coin flip | Random assignment breaks replay and contaminates every ramp comparison |
| A4 | Ground truth for a task outcome comes from an **external deterministic verifier** — tests, a schema check, a diff integrity check, a human sign-off — never from the model's own "done" | Without an external oracle, every quality metric below is a model opinion and is trivially gameable. **This is the single most load-bearing assumption.** |
| A5 | The evidence tiers are a **projection** over the kernel's `EvidenceSchema`, not a new ledger (D-006) | A second taxonomy would mean two vocabularies disagreeing |
| A6 | The optimizer runs **out of band** — a separate process reading the log, not in the worker's critical path | In-band means an optimizer bug becomes a worker bug |

### 1.1 The kernel primitives it reuses

| Kernel asset | Used for |
|---|---|
| `EventSchema` (kinds including `EXPERIENCE_RECORDED`, `EXPERIENCE_PROMOTED`, `VERIFICATION_RUN`, `DECISION_RECORDED`, `EVIDENCE_ADDED/INVALIDATED/SUPERSEDED`) | Every optimizer action is an event. A promotion is `EXPERIENCE_PROMOTED` plus a `DECISION_RECORDED` carrying the ledger hash. |
| `EventLog.append` (framed, hashed, single-writer, gapless sequence, `DurabilityLevel`) | The optimizer is a later process, and it takes the writer lock like any other writer, so single-writer is preserved. |
| `replay()` / `findGaps()` | The optimizer's plan is a **fold over the log** — this is what makes it idempotent. |
| `foldWorkerState()` / `LEGAL_TRANSITIONS` | The precedent for how a state machine is expressed here: a frozen transition table, illegal transitions **rejected and recorded**, never coerced. |
| `ExperienceSchema` (`rung`, `evidence`, `confidence`, `validWhen`, `invalidatedBy`) | The candidate **is** an `Experience` record; the lifecycle lives in a separate, orthogonal field. |
| `EPISTEMIC_RUNGS` / `rungIndex()` | The epistemic axis. |
| `DELEGATION_FAILURE_CLASSES` / `FAILURE_BEHAVIOUR` / `CircuitBreaker` | Signal S3. Reused verbatim, not re-invented. |
| `ResourceMeasurement` / `coverageOf()` | Cost and latency signals, and the coverage rule that makes a ratio ungameable. |
| `Quantity.knownBy` (`MEASURED`/`DERIVED`/`ESTIMATED`/`ATTESTED`/`UNKNOWN`; `UNKNOWN` absent) | Every signal quantity carries how it was known. A signal computed from an `UNKNOWN` quantity is `BLOCKED`, never `PASS`. |
| `canonicalJson` / `contentHash` / `recordHash` | The policy content hash, the ledger record hash, the hash chain. |
| `storage.ts` | Optimizer state lives under `.worker-runtime/` and never in a `TEMPLATES` install destination. |
| OKF `TrustTier` (`unverified` / `machine-confirmed` / `human-reviewed`) | The trust tier of a promoted learning. |

### 1.2 The one kernel change required

The candidate lifecycle and the policy promotions need event kinds that do not
exist: `CANDIDATE_CAPTURED`, `CANDIDATE_STAGE_CHANGED`,
`SHADOW_EVAL_COMPLETED`, `POLICY_PROMOTED`, `POLICY_ROLLED_BACK`,
`POLICY_PINNED`, `BUDGET_EXHAUSTED`.

Adding enum members to `EventSchema.kind` is a **versioned migration**
(`CONTRACT_VERSION` 1.0.0 → 1.1.0), which the contracts file explicitly
sanctions. Certificates already carry `contractVersion`, so 1.0.0 certificates
stay valid and verifiable.

**Rejected:** a sidecar optimizer log. Two logs means two audit stories, two
writers, two hash chains, and no answer to "which is authoritative?" — D-037.

---

## 2. The candidate state machine

### 2.1 Two orthogonal axes — the reconciliation

The kernel already owns an epistemic ladder. A parallel "candidate lifecycle
ladder" would be a second answer to "how much do we trust this?" — exactly the
collision the kernel file warns about when it renamed `FAILURE_CLASSES`.

So a candidate has **two coordinates**, and neither may move without a
recorded event:

- **Axis E (epistemic, the kernel's):** `OBSERVATION → LESSON → HYPOTHESIS →
  VERIFIED_KNOWLEDGE`. Non-decreasing, advanced only by `EXPERIENCE_PROMOTED`,
  with `VERIFIED_KNOWLEDGE` mechanically requiring `evidence.length ≥ 1`.
  **`rungIndex()` is the only ordering authority.**
- **Axis S (operational, new):** what the system is *allowed to do* with the
  candidate.

**The binding rule:**

> **Operational activation requires epistemic rung ≥ `HYPOTHESIS` *and*
> Axis-S stage ≥ `SHADOWED`.**

Epistemic truth does not imply operational safety, and operational safety does
not imply epistemic truth. A candidate may be *known true* and still be
un-enacted because it was never shadowed; a candidate may be *shadowed and
safe* while remaining epistemically a `HYPOTHESIS` forever.

**The checkable invariant:**

```
enacted ⟹ (rungIndex ≥ rungIndex("HYPOTHESIS")) ∧ (stage ≥ SHADOWED)
```

### 2.2 Axis S — the stage machine

```ts
export const CANDIDATE_STAGES = [
  "CAPTURED",    // a trace matched an extraction pattern; no claim made yet
  "EXTRACTED",   // a lesson was articulated as an Experience record
  "VALIDATING",  // evidence collection in flight (shadow + external)
  "VALIDATED",   // evidence collected; may be proposed for enactment
  "SHADOWED",    // evaluated in shadow and passed every shadow gate
  "ENACTED",     // live, at a named ramp stage
  "REJECTED",    // refuted, or the shadow failed
  "RETIRED",     // was enacted, then withdrawn (rollback / stale / invalidated)
] as const;
```

The transition table is frozen, exactly like `LEGAL_TRANSITIONS`:

```ts
export const LEGAL_STAGE_TRANSITIONS = Object.freeze({
  CAPTURED:   ["EXTRACTED", "REJECTED"],
  EXTRACTED:  ["VALIDATING", "REJECTED"],
  VALIDATING: ["VALIDATED", "REJECTED"],
  VALIDATED:  ["SHADOWED", "REJECTED"],
  SHADOWED:   ["ENACTED", "REJECTED"],
  ENACTED:    ["ENACTED", "RETIRED"],   // ENACTED→ENACTED = a ramp step
  REJECTED:   ["VALIDATING"],           // revalidation with new evidence
  RETIRED:    ["VALIDATING", "SHADOWED"],// revalidation / re-shadow
});
```

### 2.3 Transitions, triggers and guards

Every transition requires **one recorded event** whose kind is
`CANDIDATE_STAGE_CHANGED` (or the specialised kind), with `subject =
candidateId` and a payload naming `from`, `to` and the guard evidence. **A
transition without an event is not a transition.**

| From | To | Trigger | Guards (ALL must hold) | Forbids |
|---|---|---|---|---|
| — | `CAPTURED` | `CANDIDATE_CAPTURED` | ≥1 source `Experience` id; a deterministic extractor id + version; extraction recorded in a deterministic order | capture from a source the extractor did not declare |
| `CAPTURED` | `EXTRACTED` | `EXPERIENCE_RECORDED` | a new `Experience` with `rung ≤ LESSON`; `lesson` non-empty; `validWhen` non-empty; `invalidatedBy` non-empty; `failureClass` set iff `outcome = FAILURE` | creating an `Experience` at `VERIFIED_KNOWLEDGE` directly — that is auto-promotion |
| `CAPTURED`/`EXTRACTED` | `REJECTED` | `CANDIDATE_STAGE_CHANGED` | noise filter: duplicate `contentHash`, or below the extractor's confidence floor | — |
| `EXTRACTED` | `VALIDATING` | `CANDIDATE_STAGE_CHANGED` | the validation budget is not exhausted; an evidence plan exists (which evidence class will be sought) | starting validation without a plan — unbounded evidence shopping |
| `VALIDATING` | `VALIDATED` | `EVIDENCE_ADDED` + `VERIFICATION_RUN` | ≥1 evidence id with `authority ∈ {AUTHORITATIVE, DERIVED}`; `contentHash` present; `VERIFICATION_RUN.outcome ≠ BLOCKED`; the verifier is **not** the candidate's own execution lineage | promotion on `REPORTED` authority alone |
| `VALIDATING` | `REJECTED` | `CANDIDATE_STAGE_CHANGED` | the hypothesis was refuted, or evidence collection timed out | a timeout counting as validation — absence of evidence is not success |
| `VALIDATED` | `SHADOWED` | `SHADOW_EVAL_COMPLETED` | every gate in §3.4 passes; the shadow report id is recorded; paired-sample coverage ≥ 0.90 | a "completed" shadow with insufficient `n` — the gate is mechanical, not a judgement |
| `SHADOWED` | `ENACTED` | `POLICY_PROMOTED` | within the auto-authority envelope **or** a human approval id is present; the ramp stage is recorded; budget is available; the slot is not occupied by another live version | promotion without a shadow report |
| `SHADOWED`/`VALIDATED` | `REJECTED` | `CANDIDATE_STAGE_CHANGED` | any shadow gate failed, or a guard metric regressed beyond tolerance | — |
| `ENACTED` | `ENACTED` (ramp) | `POLICY_PROMOTED` | the soak window for the current stage is satisfied; no regression trigger fired; the hysteresis band is not inconclusive | a ramp step before the soak |
| `ENACTED` | `RETIRED` | `POLICY_ROLLED_BACK` | an automatic trigger fired, **or** the staleness date passed, **or** the supporting evidence was invalidated | — |
| `RETIRED` | `VALIDATING` | `CANDIDATE_STAGE_CHANGED` | the reason for retirement was addressed and new evidence collected | silent resurrection — `RETIRED → ENACTED` does not exist |
| `ENACTED` | — | *any* | **the candidate is pinned**: all transitions out of `ENACTED` except `POLICY_ROLLED_BACK` are refused, and a pin is cleared only by a human | — |

### 2.4 The forbidden jumps — structurally unreachable, and tested

1. `CAPTURED → VALIDATED` — no extraction, no lesson.
2. `EXTRACTED → ENACTED` — no evidence, no shadow.
3. `VALIDATED → ENACTED` — validation without shadow is exactly "trust the
   measurement you took in production".
4. `RETIRED → ENACTED` — resurrection without revalidation.
5. `REJECTED → ENACTED` — ever.
6. **Rung jumps:** `OBSERVATION → VERIFIED_KNOWLEDGE` and
   `LESSON → VERIFIED_KNOWLEDGE` without an intervening `HYPOTHESIS` record. A
   rung advances **at most one step per `EXPERIENCE_PROMOTED` event**, and
   each such event requires ≥1 evidence id.
7. **Any promotion without an event.** The kernel rule holds verbatim:
   *"promotion between rungs requires its own evidence and is itself a
   recorded event."*
8. **Any enactment while pinned.**

### 2.5 Trust tier, staleness, and the learning/policy split

A promoted candidate carries:

- **Trust tier** — `unverified` / `machine-confirmed` / `human-reviewed`
  (the OKF `TrustTier`; no fourth tier is invented). `human-reviewed` is only
  obtainable by a human approval id and is **never** auto-assigned.
- **Staleness date** (`stale_after`) — the date after which the candidate must
  be re-validated, not merely re-used. On expiry it transitions
  `ENACTED → RETIRED` (reason `STALED`) and must re-shadow before re-enacting.
- `invalidatedBy` — the signals that retire it (a package-lock change, a model
  major version, a tool schema change), mirroring `ExperienceSchema`.

**A learning is knowledge; a policy is a change in behaviour.** They are
separate records: an `Experience` (kernel) carries the learning; a `Policy`
carries `{ policyId, slot, version, contentHash, artifactRefs,
derivedFrom: experienceId[], validity }`. A policy may be enacted only if its
`derivedFrom` experience is at rung ≥ `HYPOTHESIS` and stage ≥ `SHADOWED`. A
policy carries the **hash of its artefact bytes**, so revert is a file
comparison, not a program audit.

### 2.6 The optimizer is a fold, not a procedure

**The plan is a pure function of the event log** (plus an injected clock, an
injected price table, and a seeded PRNG whose seed is
`sha256(policyId ‖ candidateId ‖ windowId)`).

- **Idempotency is free.** Re-running after a crash recomputes the same plan;
  applying it again is a no-op because the target state already matches.
  Promotion events get a **deterministic id**, so a duplicate append is
  detectable as a duplicate.
- **Replay is the audit.** "Why did the system behave this way on date X" is
  "replay to X and re-run the fold". If the fold does not reproduce the
  recorded decisions, the system is wrong — and the test that proves it is a
  property test, not a promise.
- **No hidden state.** The optimizer's cursors, counters and budgets are all
  derived. There is no optimizer database that can disagree with the log.

### 2.7 Snapshot and restore — byte-for-byte revert

```
.worker-runtime/policies/
  slots/<slot>/current.json          # atomic pointer to the live artefact set
  slots/<slot>/known-good.json       # pointer to the last fully-ramped version
  artifacts/<policyId>@<contentHash>/ # immutable, content-addressed artefact bytes
  snapshots/<snapshotId>.json         # manifest: path → sha256 → bytes ref
```

1. A policy artefact is written **immutably** into
   `artifacts/<policyId>@<contentHash>/`. It is never edited in place.
2. Enactment = an **atomic pointer swap** of `current.json`: write
   `current.json.tmp` → `fsync` → `rename`. There is **no window** in which a
   partial configuration is live.
3. `current.json` carries the content hash of the artefact set, and **every
   worker start verifies the live artefact hashes.** A mismatch — someone
   edited a file in place — means the worker **refuses to start on that
   policy** and falls back to `known-good.json`. Fail closed.
4. Rollback = an atomic pointer swap back. The byte-for-byte guarantee comes
   from three things: the artefact bytes are immutable and hash-verified; the
   swap is atomic; and the restore **re-verifies the hash after the swap** and
   **refuses to report success** if it does not match.
5. `known-good.json` advances only after a policy reaches `FULL` ramp **and**
   soaks for 7 days.

**Why immutable artefacts rather than "restore from backup":** a backup
restore can restore a file that was mutated after the backup was taken. A
content-addressed, hash-verified, never-edited artefact set cannot — the
mutation fails the hash check and is refused rather than silently restored.

---

## 3. Shadow evaluation

### 3.1 What "shadow" means, precisely

> For every execution assigned to the shadow arm, **both** the live policy and
> the candidate policy compute their decisions. **Only the live policy's
> decisions are enacted.** The candidate's decisions are recorded, and — where
> the candidate's decision is a side-effecting action — **not executed at
> all**; only scored.

Three properties matter:

- **No side effects from the candidate.** The candidate may *propose*
  `delete file X`; the harness records the proposal and refuses to run it.
  Enacting shadow proposals is how shadow evaluation becomes a production
  change with extra steps.
- **Both arms see the same task.** Pairing is per `executionId`: the same
  input, the same task class, the same verifier, two different decision
  functions. Paired comparison removes most task-difficulty variance.
- **Assignment is deterministic.** `bucket = sha256(executionId ‖ policyId)
  mod 10_000`; the shadow arm is `bucket < shadowShare × 10_000`. The same
  execution is always in the same arm for a given policy, so a ramp step does
  not reshuffle populations.

### 3.2 The protocol

```
for each candidate policy P with slot S:
  1. assign the arm per executionId (hash bucket, sticky)
  2. for each shadow execution E:
       a. run the live policy        → outcome_live
       b. compute the candidate decision (NOT executed if side-effecting)
       c. if the candidate's decision is reversible/simulated:
            run it in the sandbox    → outcome_candidate
          else:
            score by verifier projection only → outcome_candidate (projected)
       d. score both against the EXTERNAL verifier → verdict_live, verdict_candidate
       e. append SHADOW_EVAL_COMPLETED
  3. every window (1h or 50 tasks, whichever is later) compute the gate report
  4. at window end: if all gates pass, the candidate may advance to SHADOWED
```

**Sandbox overfitting guard, all mechanical:** the shadow set is **live
traffic**, not a curated benchmark — a fixed benchmark is a *regression* check
only and never the promotion source; the required `n` is computed **per task
class**, so a candidate cannot reach `n` by monopolising one easy class; and
**20% of the shadow sample is held out** for the final confirmation pass, so a
candidate that passes on the holdout but fails on the training portion is
rejected as overfit.

### 3.3 The metrics that gate a promotion

All computed **paired** and **per task class**, and all reported with their
coverage.

| Class | Metric | Definition |
|---|---|---|
| **Primary** | `Δsuccess` | `P(verdict_candidate = PASS) − P(verdict_live = PASS)` on paired executions, verifier-derived |
| **Guard** | `Δcost` | per-task cost delta (median and p95), the same price-table id on both arms |
| **Guard** | `Δlatency_p95` | p95 wall-clock delta |
| **Guard** | `Δgrounding` | grounding-policy denial-rate delta — **must not decrease**. A policy that "improves" success by weakening grounding is rejected, not celebrated |
| **Guard** | `Δfailure_mix` | the share of each `CONTRACT_FAILURE_CLASSES` category; a new class above 1% of shadow executions fails the gate |
| **Guard** | `Δexternality` | the share of executed side effects attributable to the candidate |
| **Hygiene** | `coverage` | the fraction of shadow executions carrying every field the gates need |
| **Hygiene** | `evidence_integrity` | the count of supporting evidence items invalidated during the window (must be 0) |

### 3.4 The twelve promotion gates — all required

| Gate | Threshold | Reasoning |
|---|---|---|
| **G1 Minimum sample** | `n_paired ≥ 200` **and** `n_paired ≥ 30` in every task class in scope | 200 paired samples at a ~50% baseline gives a paired-difference standard error around 3–4pp, which with G3 resolves a +5pp effect. The 30/class floor stops a candidate reaching `n` by dominating one easy class. |
| **G2 Minimum duration** | `window ≥ 7 calendar days` | Covers weekday/weekend variation and slow drift. A 1-day shadow can be entirely inside one regime. |
| **G3 Statistical confidence** | one-sided 95% lower bound of `Δsuccess` (paired bootstrap, 10 000 resamples, **seeded** from `policyId`) `> 0` | A paired bootstrap is the cheapest defensible interval for a bounded binary outcome and needs no distributional assumption. Seeding makes the verdict reproducible. |
| **G4 Materiality** | `Δsuccess ≥ +1.0pp` absolute (point estimate) | Significance on a +0.1pp effect is noise dressed as a result, and the operational cost of a policy is not worth it. |
| **G5 Guard tolerance** | each guard's one-sided 95% bound in the bad direction is within tolerance: `Δcost ≤ +5%`, `Δlatency_p95 ≤ +10%`, `Δgrounding ≥ 0`, a new failure class ≤ 1% | The guard bounds are *not* "no regression" — a strict zero-regression rule would forbid every change. They are "no **material** regression, and never a grounding regression". |
| **G6 Coverage** | `coverage ≥ 0.90` on every metric the gates use | The kernel's `Quantity` rule: a metric computed from unobserved inputs is not a metric. Below 90% the gate result is `BLOCKED`, **not** `PASS`. |
| **G7 Evidence integrity** | 0 supporting evidence invalidated during the window | A stale evidence base invalidates the shadow result. |
| **G8 Holdout** | the 20% holdout confirms the sign of `Δsuccess` at `> 0` | A cheap overfit detector. |
| **G9 Provenance purity** | zero evidence items whose producer lineage includes the candidate's own shadow executions | Otherwise the candidate "verifies itself". The single most common way a learning loop becomes a belief loop. |
| **G10 Budget** | the optimizer's budgets are not exhausted; a shadow slot is free | A learning loop that spends more than it saves is a negative-value feature. |
| **G11 Flap-free** | the candidate is not pinned; fewer than 2 prior rollbacks for the same `contentHash` | Prevents re-promoting a known-flapping artefact. |
| **G12 Human gate (conditional)** | if the policy changes permissions, scope, credentials, egress, or spend caps, a human approval id must be present | §6. |

**Why 200 and 7 days, honestly.** These are **educated guesses**, chosen as
defensible defaults for a system that has not yet collected traffic. They
become *measured* numbers after ~500 paired shadow samples, at which point the
required `n` is recomputed from the **observed** paired-difference variance
(target: a 95% CI half-width ≤ 2pp) rather than assumed. The 7-day window
becomes measured when the log shows a weekday/weekend effect larger than the
CI half-width. Until then, both are recorded as `[GUESS]` in the config and
surfaced in the ledger record, so a later auditor can see which thresholds were
assumed.

### 3.5 Promotion authority

| Policy kind | Auto-promotable? | Conditions |
|---|---|---|
| **Parameter tuning** (timeout, retry count, cache TTL, backend weights within a declared set) | **Yes**, up to `PARTIAL` ramp | All gates pass; the auto-authority envelope is not exceeded |
| **Prompt / tool-routing change** (declarative, diff-reviewable) | **Yes**, up to `CANARY` (1%) | All gates pass; the artefact diff is auto-reviewed for forbidden patterns |
| **Permission / scope / credential / egress / spend-cap change** | **No** | A human approval id, always |
| **Anything that adds or alters executable behaviour** | **No** | A human approval, and §6's no-auto-generated-tools rule |

---

## 4. Ramp, blast radius, and rollback

### 4.1 The ramp

| Stage | Enacted traffic | Soak to advance | Cumulative tasks |
|---|---|---|---|
| `SHADOW` | 0% (observed only) | gates G1–G12 | 200 paired |
| `CANARY` | **1%** | 24h ∧ ≥ 50 tasks | 250 |
| `PARTIAL` | **10%** | 72h ∧ ≥ 200 tasks | 450 |
| `HALF` | **50%** | 7d ∧ ≥ 1 000 tasks | 1 450 |
| `FULL` | **100%** | — (`known-good` advances after a further 7d soak) | — |

**Why 1% first:** at 1%, a catastrophic policy touches ~1 task in 100. At
1 000 tasks/day that is ~10 tasks — small enough to be survivable, large
enough to produce 50 tasks in 24h. **Why 24h at canary:** one full diurnal
cycle. **Why 7d at HALF:** a week is the shortest window in which a weekly
pattern (a batch job, a weekly release, a weekly report) is visible at all.

### 4.2 Blast radius caps

- A policy's blast radius is bounded by the **slot** it occupies. Slots are
  declared, finite and exclusive.
- **One live version per slot.** Two versions of the same slot are never live
  simultaneously.
- **First-promotion cap.** A policy whose *mechanism* is new is capped at
  `CANARY` and cannot exceed `PARTIAL` without human approval. Routine
  parameter movement within a known mechanism may reach `FULL` automatically.
- **Concurrency cap.** At most 10 policies `ENACTED` at once, and at most 1
  policy per slot in shadow evaluation at a time.

### 4.3 Automatic rollback triggers — any one fires an immediate rollback

1. **Guard breach** — any guard metric outside tolerance for 3 consecutive
   evaluation windows.
2. **Success regression** — `Δsuccess ≤ −3pp` against the live baseline in
   any window with `n ≥ 30`.
3. **A single severe incident attributable to the policy** — a grounding
   denial bypassed, a credential/scope violation, unbounded tool recursion, a
   spend anomaly > 5× the 30-day same-slot baseline sustained for 10 minutes,
   or any `Certificate` verification failure.
4. **A circuit breaker opened** for a backend the policy introduced.
5. **The policy's own budget exceeded** (its declared cap, not the global
   optimizer cap).
6. **Evidence invalidation** — any supporting evidence invalidated
   (`ENACTED → RETIRED`, reason `EVIDENCE_INVALIDATED`).
7. **Staleness expiry** — `stale_after` passed.

> **Ordering rule: rollback happens before diagnosis.** Detection → rollback →
> record → diagnose. A rollback that waits for a human to understand why is a
> rollback that did not happen.

### 4.4 What rollback does, mechanically

1. Emit `POLICY_ROLLED_BACK` with the trigger, the offending window's metrics,
   and the detection latency.
2. Atomic pointer swap `current.json` → `known-good.json`; **re-verify the
   hashes after the swap**; if verification fails, the worker **halts** (fail
   closed) and pages. It never continues on an unverified configuration.
3. The candidate stage → `RETIRED` (reason `ROLLBACK`). It is **not** deleted:
   it may re-enter `VALIDATING` only with new evidence, and its ledger record
   stays forever.
4. The slot returns to the incumbent. If the incumbent was also broken, the
   slot falls back to its **default** (declared, human-authored) policy. The
   system always has a floor.

**Idempotency:** rolling back an already-rolled-back policy is a no-op and
emits nothing new (deterministic event id). Rolling back a policy that is not
live is refused.

---

## 5. Flapping detection and pinning

### 5.1 Why flapping is worse than a bad policy

A bad policy costs one bad period. A flapping policy costs *repeatedly*, and
it destroys the signal value of every other metric: after three flip-flops,
"the policy is live" carries no information and the operator's trust in the
whole loop collapses. **Flapping is a safety event, not a performance event.**

### 5.2 The detector

For each `(slot, policyContentHash)` the fold keeps a bounded history of the
last 8 promotion decisions and the last 90 days of outcomes.

| # | Detector | Rule |
|---|---|---|
| **F1** | Oscillation count | `promotions ≥ 3` in a rolling 30-day window **and** `rollbacks ≥ 2` among them |
| **F2** | Repeat offender | the same `policyContentHash` promoted and rolled back **≥ 2 times** — the same bytes failing twice is a fact about the bytes, not about the weather |
| **F3** | Alternation | in the last 6 promotion decisions the outcome alternates more than twice (W-L-W-L-W). A policy that alternates wins and losses is chasing noise |
| **F4** | Slot churn | the slot changed its live version **≥ 5 times in 14 days**, regardless of which content hash — the *slot* is unstable even if each individual policy looked fine |

**F1's "3 promotions + 2 rollbacks in 30 days"** is the core rule: two rollbacks
already indicate the promotion gate is not measuring what it claims to. A
third promotion inside the window is the system re-learning the same lesson in
a loop. This threshold is a **[GUESS]**; it becomes measured when the ledger
has 90 days of promotion history, at which point the detector should use the
empirical distribution of rollback counts (e.g. the 99th percentile of healthy
policies).

### 5.3 The hysteresis band

The other half of flapping prevention is not promoting on noise.

> Any evaluation whose `Δsuccess` point estimate lies within **±1.0pp** of
> zero is **INCONCLUSIVE**. INCONCLUSIVE never promotes, never rolls back,
> holds the current state, and is recorded as such.

Without this band, a metric that dithers around zero will promote on one
sample and roll back on the next — flapping *without any policy being wrong*.
The band is wider than G4's materiality floor by design: promotion requires
**both** significance and materiality; rollback requires a **breach**, and
noise is not a breach. **Band width [GUESS]** — becomes measured from the
observed sampling distribution of `Δsuccess` for null candidates.

### 5.4 What pinning does

1. **Immediate rollback** of the flapping policy (if live) to `known-good`.
2. A `POLICY_PINNED` event carrying the detector that tripped and the
   promotion/rollback history that justified it.
3. **Quarantine** — and this is the part that actually stops the loop:
   - the **extractor refuses to re-propose** the candidate. The candidate set
     is deduplicated by `contentHash` and pinned hashes are excluded from
     extraction. A pin that only blocks promotion still lets the system
     re-derive the same lesson every day.
   - the candidate is excluded from shadow evaluation.
   - it cannot be promoted again **at all**.
4. **Only a human can unpin**, with a recorded id. Unpinning re-enables
   *eligibility* only — the candidate must go through `VALIDATING` again from
   scratch.
5. **Cooldown:** 30 days between unpin attempts. A human *can* override the
   cooldown, but the override is recorded and the pin's history is preserved.
   **30 days [GUESS]** — one monthly cycle plus drift.

**What is NOT done on a pin:** the candidate is not deleted, not silently
archived, and not "deprecated". It is pinned, visibly, with the reason
attached.

---

## 6. Optimizer budgets and the never-automated list

### 6.1 Budget defaults

| Dimension | Default cap | Reasoning |
|---|---|---|
| Wall-clock per cycle | **900 s** (hard deadline; the cycle aborts) | A cycle that can run forever will, given an unbounded backlog. 15 minutes is long enough for a full extraction + validation sweep on a realistic backlog and short enough to self-terminate within a human's attention window. |
| Wall-clock per day | **4 cycles** (≤ 60 min/day) | Bounds the optimizer's footprint and keeps the "optimizer is a rounding error" property. |
| Tokens per cycle | **250 000 in / 50 000 out** | One extraction sweep over a 200-trace backlog with a reader model plus a judge pass. Above this the optimizer is doing bulk inference — the signature of a learning loop that has outgrown its budget. |
| Tokens per day | **1 000 000** | ~4× the per-cycle cap, leaving headroom for one retried cycle. |
| Money per day | **min(2% of the worker's 7-day rolling spend, $5)** | The optimizer must be **deletable without the product noticing**. The 2% rule expresses the intent (scale-relative); the $5 rule is the floor for a small deployment where 2% is trivially small. |
| Money per cycle | **$1.25** (25% of the daily cap) | Forces the optimizer to spread work across days rather than one giant cycle. |
| Enacted changes per day | **3 globally** | With a 24h canary soak, 3 changes/day means at most ~3 policy versions mid-ramp at once — the same bound as the concurrency cap, enforced from the other side. |
| Changes per slot | **1 per 7 days** | A slot that changed weekly is not converging. |
| Candidates in flight | **50** | Bounds memory and validation cost. **A learning system should have a large rejected backlog and a tiny promoted set.** A backlog that empties is a red flag. |
| Extraction batch | **200 traces scanned / cycle, ≤ 20 advanced to `VALIDATING`** | Extraction is cheap; validation is expensive. Cap the expensive step. |
| Concurrent shadow evaluations | **2 policies** | Shadow evaluation costs a second decision per execution. Two is enough to keep a pipeline busy without paying double inference across all traffic. |
| Live (`ENACTED`) policies | **10** | Every live policy is a thing that can be wrong and must be monitored; more than 10 exceeds what one operator can hold in their head. |
| Shadow traffic share | **20%** of executions | Shadow is observation, so its risk is cost only. Raising it is a budget decision, not a policy decision. |

**Enforcement.** Every step checks the counters *before* executing. On
exhaustion: append `BUDGET_EXHAUSTED` naming the cap hit and the remaining
headroom; abort the cycle immediately (the plan is applied atomically, so
abort = apply nothing); the worker continues on its last known-good
configuration. **The optimizer failing is never a worker failure.**

**The optimizer's cost is attributed to the optimizer budget, never to task
budgets** — otherwise a runaway optimizer would silently consume the worker's
allowance and the cost signal would blame the wrong component.

### 6.2 The never-automated list — a constant in code, not configuration

Thirteen decisions always require a human, no matter how good the measured
evidence is. The list is a constant for the same reason `FAIL_POLICY` is:
*"an operator must not be able to configure the unsafe combination."*

| # | Never automated | Why |
|---|---|---|
| **N1** | Changing what the worker is **permitted** to do: tool allow-lists, file scope, network egress, credentials, spend caps | The permission boundary. A policy that widens it is optimising its own authority, and the evidence was gathered under the old authority. |
| **N2** | Any change to **auth, credential, or secret handling** | Unbounded blast radius, and detection is by definition late. |
| **N3** | **Deleting, editing, or invalidating evidence** | Evidence is append-only. An optimiser that can delete its own evidence can always look successful. |
| **N4** | Any change to the **frozen contracts**, the **epistemic ladder**, the **verification engine**, or the **event log format** | The substrate that makes the loop auditable. A loop that can edit its own judge is not a loop. |
| **N5** | Any change to the **promotion gates, budgets, or the never-automated list itself** | Self-modifying gates make every historical comparison meaningless. |
| **N6** | **Self-modifying code** — the optimiser rewriting its own source, the SDK's source, or the kernel's source | Breaks determinism, invalidates certificate hashes, and creates an unbounded execution surface. |
| **N7** | **Auto-generating executable tools**, or any new code path learned from traces | Learned code is untrusted code. It requires human review + sandbox + capability declaration, matching the repo's existing fail-closed capability rule (`UNKNOWN` → treated as `UNSUPPORTED` → hard build error). |
| **N8** | **Assigning the `human-reviewed` trust tier** | Only a human can attest to human review. The optimiser may *request* it. |
| **N9** | **Raising a work contract's risk level above `medium`, or widening its `scope`** | Scope and risk are the frame the work is judged against. A worker that can widen its own frame is unfalsifiable. |
| **N10** | **Accepting evidence produced by the candidate's own execution lineage** | Self-verification. Enforced mechanically (G9), never by judgement. |
| **N11** | **Unpinning a flapping candidate** | A pin the system can clear is not a pin. |
| **N12** | **Deciding a task is "done" without an external verifier** | The kernel already forbids this: `BLOCKED` exists so absence of evidence has somewhere to go that is not success. |
| **N13** | **Any change to the *existence* of the loop** — disabling it, raising its budget ceiling, changing the shadow share | An optimiser that can turn itself off is an optimiser that will. (Budget *within* the caps is adjustable; the caps are not.) |

**Human-in-the-loop is not a rubber stamp.** A human approval must name the
candidate `contentHash` it approves. Approving "the plan" rather than the
bytes means the bytes can change afterwards and the approval silently
transfers to something the human never saw.

---

## 7. The top signals

### 7.0 Six rules that make a signal hard to game

1. **The denominator comes from outside the optimiser's control.** Rates
   divide by *tasks executed* (an input), never by *claims produced* or
   *memories written* (outputs the optimiser controls). Cost-per-claim is
   demoted to a secondary ratio with a coverage denominator; cost-per-task is
   primary.
2. **Every quality metric is paired with a cost metric and a difficulty
   control.** A metric that improves while cost per task explodes is not an
   improvement; a metric that improves because the easy tasks were selected is
   not an improvement.
3. **The system may not count as evidence for itself.** Provenance exclusion
   (G9).
4. **Coverage is reported with every ratio.** A ratio computed over 40% of the
   intended population is `BLOCKED`, not `PASS`.
5. **No single aggregate decides.** A promotion requires **two signals from
   different families** to agree.
6. **Every signal has a sampled human audit** (N=20/week, blind to the
   metric's own framing). A metric no human has ever looked at is a
   hypothesis about the metric, not a measurement of the system.

### 7.1 The nine signals

| # | Signal | Formula | Source | Healthy range | Alert threshold | Gaming mode | Counter-measure |
|---|---|---|---|---|---|---|---|
| **S1** | Evidence tier mix + drift | `p_tier = n_tier / n_total`; `Δ7 = p_VERIFIED(t) − p_VERIFIED(t−7d)` | `EVIDENCE_ADDED`, `EVIDENCE_INVALIDATED`, `EVIDENCE_SUPERSEDED` | `p_VERIFIED ≥ 0.40` and non-decreasing; `p_UNCITED ≤ 0.35`; `p_BROKEN ≤ 0.02`; `p_UNSUPPORTED ≤ 0.10` | `p_BROKEN > 0.05` or `Δ7(p_VERIFIED) < −0.05` or `p_UNSUPPORTED > 0.25` | **Citation laundering** — attach a self-generated artefact as the citation, converting `UNCITED → VERIFIED` with no external corroboration | Tier assignment requires `authority = AUTHORITATIVE`, a citation that **resolves** (fetch/hash check) at verification time, and a producer lineage external to the claiming worker. A claim that cites its own author is demoted to `UNCITED` automatically. |
| **S2** | Cache effectiveness vs break-even | `h* = c_store / (C_recompute + c_store − c_serve − p_bad·C_bad)`; health = `h_eff − h*`, where `h_eff` counts **verified-correct** hits only | delegation/tool telemetry + `ResourceMeasurement` + verification verdicts | `h_eff ≥ h* + 0.05` | `h_eff < h*` (the cache destroys value) or `h_eff` drops > 0.15 at stable volume | **Cache inflation** — serve stale or trivial entries to raise the raw hit rate; or cache a huge prompt whose storage exceeds the call it avoids | Use `h_eff`, not raw hits. Cache keys include `taskClass`, `inputHash`, `policyVersion`, `modelVersion`. `p_bad` is **measured** (the fraction of cache hits that fail the external verifier). Publish `p_bad·C_bad` next to the hit rate: when it exceeds `C_recompute`, the cache loses money at *any* hit rate. |
| **S3** | Delegation failure-class mix + circuit state | `share(class) = n_class / n_failures` per window; circuit-open time per window | `DELEGATION_FAILED`, `CIRCUIT_OPENED/CLOSED/HALF_OPEN` | `share(unknown) ≤ 0.05`; `share(rate_limited) ≤ 0.15`; `share(auth\|quota) ≤ 0.02`; circuit open ≤ 10% of window | `share(unknown) > 0.10` or a circuit open > 30% of the window or `share(backend_failed) > 0.40` for 2 windows | **Failure-class laundering** — classify everything as `backend_failed` so it looks like a provider problem and gets silently retried on a pricier backend | `unknown` is **never** auto-retried (already the kernel rule). Classification is evidence-driven and the raw envelope is retained. A weekly sample of 50 `DELEGATION_FAILED` events is manually re-classified and the disagreement rate is reported. |
| **S4** | The learning funnel: validation / promotion / rollback | `validation_rate = n_VALIDATED / n_EXTRACTED`; `promotion_rate = n_ENACTED / n_VALIDATED`; `rollback_rate = n_RETIRED(ROLLBACK) / n_ENACTED`; **plus** `effective_promotion_rate` = promotions whose artefact diff is non-empty | `CANDIDATE_STAGE_CHANGED`, `POLICY_PROMOTED`, `POLICY_ROLLED_BACK` | validation 0.05–0.30; promotion ≤ 0.25; rollback ≤ 0.15; `effective_promotion_rate ≈ promotion_rate` | rollback > 0.30, or promotion > 0.60 (over-promotion), or `effective_promotion_rate / promotion_rate < 0.7` | **No-op inflation** — promote policies whose artefact diff is empty, so the promotion count looks healthy while nothing changes. **Selection bias** — validate only easy candidates | The ledger stores the artefact hash before and after, so an empty diff is mechanically visible. Every promotion carries its paired shadow delta, so the rate cannot be inflated without producing shadow evidence. Validation is reported per task class. A *high* promotion rate is a red flag, not a success. |
| **S5** | Grounding-policy denial rate | `denial_rate = n_denials / (n_denials + n_requests)` per concern; plus `n_denials_per_task` | grounding decisions, `VERIFICATION_RUN`, `DECISION_RECORDED` | `denial_rate ∈ [0.05, 0.30]`; denials per task stable within ±20% WoW | denial < 0.01 (grounding effectively disabled) or > 0.60 (over-refusal) or +30% WoW with flat success | **Over-refusal** — deny everything: a perfect safety record and zero work done. **Under-refusal** — disable the check | Denial rate is **paired with S8 and S9** in the same reading: a system that refuses more while deferring more and verifying less is not healthy. A weekly sample of 30 denials is reviewed for "correctly denied vs correctly allowed". The failure-policy ladder records *which* level denied, so a demotion from `BLOCK` to `WARN` shows up as a denial-rate drop with no work-completion change — the classic grounding-weakening signature. |
| **S6** | Cost per task; cost per verified claim | `cost_per_task = Σ estimatedCost / n_tasks`; `cost_per_verified_claim = Σ estimatedCost / n_claims(VERIFIED)` — **both published with coverage** | `ResourceMeasurement` (with the `priceTable` id), evidence events | `cost_per_task` flat or falling while tasks and success are flat/rising; `cost_per_verified_claim` falling **and** the absolute claim count not falling | `cost_per_task` +20% WoW with no matching success increase, or `cost_per_verified_claim` falling while the claim count also falls | **Claim suppression** — make fewer claims, so fewer to verify, so a lower cost per claim, while the real output is unchanged or worse. **Price-table drift** | Cost-per-task (denominator = work done) is primary; cost-per-claim is secondary and always published with the absolute claim count. Every cost carries its `priceTable` id, so cross-time comparisons are only valid within a table. |
| **S7** | Shadow sufficiency and coverage | `sufficiency = n_candidates_reaching_n / n_candidates_started`; `coverage` = fraction of shadow executions carrying every gated field; `shadow_share` = shadow / total | `SHADOW_EVAL_COMPLETED` | sufficiency ≥ 0.60 within 2× the nominal window; coverage ≥ 0.90; shadow share ≤ 0.25 | sufficiency < 0.30 (the pipeline is starved) or coverage < 0.90 (metrics computed from partial data) or shadow share > 0.35 | **Benchmark overfitting** — shadow on a curated, easy, fixed set to reach `n` fast. **Coverage blindness** — stop emitting a field so a ratio's denominator shrinks | Minimum `n` is computed **per task class** (30/class). Shadow runs on live traffic; a fixed benchmark is a regression check only. Coverage below 0.90 makes the gate `BLOCKED`, never `PASS`. The shadow share is budgeted and its cost is charged to the optimiser, so gaming it has a visible price. |
| **S8** | Work deferral and escape rate | `deferral = n_tasks(ended BLOCKED without attempt, or plan delivered in place of artefact) / n_tasks`; separately `n_tasks(ended FAILED) / n_tasks`. **`BLOCKED` and `FAILED` are never merged** | worker state transitions, `ContractFailureClass` | `deferral ≤ 0.10`; `FAILED` stable within ±20% WoW | deferral +5pp WoW, or deferral rises while the success rate is flat | **Deferring hard work** — block instead of fail. The task never "fails", the ledger looks clean, and the hard part is quietly not done. The mirror trick: mark everything `FAILED` so failures are visible but nothing is claimed complete | The kernel already distinguishes `BLOCKED` from `FAILED`; the signal keeps them separate, and `deferral` is measured **against a control cohort** (executions the policy is forbidden to defer). A weekly sample of 20 deferred tasks is inspected for "legitimately blocked" vs "avoided". |
| **S9** | Verifier divergence | `divergence = P(model claims success) − P(external verifier says PASS)`; `false_complete = n_tasks(model claims success, verifier ≠ PASS) / n_tasks` | model self-report (`ATTESTED`) vs `VERIFICATION_RUN` outcomes | `divergence ≤ 0.05`; `false_complete ≤ 0.02` | divergence > 0.15 or false_complete > 0.05 | **Sycophancy / self-certification** — the agent learns that saying "done" scores well, and the metric rewards it. The classic Goodhart trap: the optimiser tunes the *claim*, not the work | The two numbers come from **different sources by construction**: the self-report is `ATTESTED` by the model, the verdict is produced by a deterministic external verifier whose `verifierId` is outside the model's lineage. The gap is the signal. `BLOCKED` verdicts are excluded from the denominator (they mean "not observable", not "failed") and reported separately, so a verifier that stops running cannot make divergence look good. |

**Why nine and not ten.** S1 (evidence quality) and S9 (verifier divergence)
are not redundant — one measures the knowledge base, the other measures the
honesty of self-reporting; a system can have a beautiful evidence ledger and
lie about completion. S4's three sub-rates are one funnel and are read
together. A tenth signal would most likely duplicate S6 (cost) or S4
(promotion), both of which are already paired against a live control arm,
which is the strongest anti-gaming instrument available.

### 7.2 How a human actually reads it

One row per slot, plus one global row. Each row shows the signal, its value,
its coverage, its week-over-week delta, and **two** independent
family-confirmations:

```
slot:            router.taskClass.billing
S1 p_VERIFIED    0.52  coverage 0.98  Δ7 +0.03   [ok]
S2 h_eff - h*    +0.11 coverage 0.97  Δ7 -0.02   [ok]
S3 unknown share 0.02 coverage 1.00  Δ7 -0.01   [ok]
S4 rollback      0.08  coverage 1.00  Δ7 +0.01   [ok]
S5 denial rate   0.14  coverage 0.99  Δ7 +0.00   [ok]   (paired with S8 0.06, S9 0.01)
S6 cost/task     $0.031 coverage 0.98 Δ7 +0.02   [ok]
S8 deferral      0.06  coverage 0.95  Δ7 -0.01   [ok]
S9 divergence    0.01  coverage 0.99  Δ7 +0.00   [ok]
decision:        HOLD  (needs 2 families to agree before any promotion)
```

**The last line is the rule:** no promotion on one signal's say-so.

---

## 8. Metric gaming and specification gaming

| Game | Detector | Mitigation | Measurable or auditable |
|---|---|---|---|
| Reward hacking — optimise the proxy, not the task | S9 (divergence) and the external verifier | Every quality metric comes from a deterministic verifier outside the model's lineage | Measurable |
| Goodharting — a metric becomes the target | S7 (coverage) plus the paired control arm | Every promotion requires two signal families to agree | Measurable |
| Sandbox overfitting | S7 (per-task-class `n`, holdout) | Shadow on live traffic; a 20% holdout; `n` computed per class | Measurable |
| Sycophancy to the evaluator | S9 | Self-report and verdict come from different sources by construction | Measurable |
| Over-refusal | S5 paired with S8 | Denial rate is read with deferral and divergence in one row | Measurable |
| Teaching to the test | S7 (live traffic) + the holdout | A fixed benchmark is a regression check only, never a promotion source | Measurable |
| Deferring hard work | S8, measured against a control cohort | `BLOCKED` and `FAILED` are never merged; a control cohort forbids deferral | Measurable |
| Laundering a claim into "verified" | S1 + G9 | Tier assignment requires an external, resolving, non-self-produced citation | Measurable |
| Oscillating to look responsive | S4 + the flapping detectors | Quarantine by `contentHash`; only a human can unpin | Measurable |
| **Executing a destructive action that the metrics do not see** | None is complete | A weekly human sample of executed side effects, read against the policy's declared externality bound | **Auditable, not measurable** |

**The last row is the honest limit.** Some harms are not visible in the
aggregate metrics, and no signal catches them. The mitigation is a human
sample, and it should be recorded as a limitation rather than presented as a
control.

---

## 9. What to defer

| Feature | Verdict | Why |
|---|---|---|
| **Self-modifying code** | Defer permanently | Breaks determinism, invalidates certificate hashes, and creates an unbounded execution surface (N6) |
| **Online RL / policy gradient on production traffic** | Defer | The experiment cannot fail safely in production, and the shadow protocol already gives a safe approximation of the same measurement |
| **Auto-generated tools** | Defer | Learned code is untrusted code (N7) |
| **Multi-agent debate** | Defer | It multiplies cost and latency without a measurable gain in the primary metric; the extractor + verifier pair already surfaces disagreement |
| **LLM-judge-only evaluation** | Defer | A judge that is a model is a model opinion. The primary metric must come from a deterministic external verifier (A4); an LLM judge is at most a secondary signal |
| **Automatic promotion of a `HYPOTHESIS` to `VERIFIED_KNOWLEDGE`** | Defer permanently | Precisely the laundering mechanism (T8) |
| **A learned "skill library" of executable code** | Defer | Same reason as auto-generated tools, with a larger surface |
| **Multi-armed bandit routing of *models*** | Defer, but the mechanism is reusable | The signal set is there (cost, latency, failure mix), but the blast radius of a bad model choice is higher than a bad parameter, and the shadow protocol is less applicable to a stateless choice |

---

## 10. Related documents

| Document | Owns |
|---|---|
| `trust.md` | Identity, attestation, the anchor chain, the commit-point protocol, multi-tenant isolation |
| `economics.md` | Prompt caching and batching, with the corrected provider table |
| `docs/EVIDENCE.md` | Every external number, with its source and access date |
| `docs/DECISIONS.md` | Why each choice was made, and what was rejected |
| `docs/BACKLOG.md` | The two kernel changes this would need, as open P1 items |
