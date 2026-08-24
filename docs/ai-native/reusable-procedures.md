# Reusable procedures

Procedures whose reasoning has already been done, so it is not done again.

Each entry exists because a past session spent real model reasoning deriving it, and the derivation
would otherwise survive only in a conversation transcript. A future session should be able to **retrieve
and execute** one of these instead of re-investigating the original problem.

**This file owns nothing else.** Finding ids, defect taxonomy, statuses, and the
VERIFY → FIX → ERADICATE THE CLASS protocol belong to
[`ENGINEERING_LEDGER.md`](../../ENGINEERING_LEDGER.md); milestones and constraints belong to
[`ROADMAP.md`](../../ROADMAP.md); current subsystem state belongs to
[`CURRENT_STATE.md`](../../CURRENT_STATE.md). Entries here reference those; they never restate them.

A procedure earns a place here only when it is **executable** — a checklist a future session can run and
get a pass/fail from. Advice belongs in prose; this file is for steps.

---

## THE GOVERNING PRINCIPLE — evidence-producing machinery is itself an object of verification

> **Every mechanism that produces, transforms, measures, validates, or promotes evidence must itself
> produce evidence of its discriminating power.**

Verification usually points downward — procedure verifies test verifies system. F16 through F19 showed
the upper layers failing while the layer below them was perfectly correct:

```
SYSTEM → PROCEDURE → HARNESS → MEASUREMENT → EVIDENCE → DECISION
```

Each layer can be independently defective, and a defect at any of them produces **confident wrongness
rather than visible failure**. The instrument returns 0 for real work (F19). The harness cannot observe
the property it is cited for (F16, F18). The procedure covers the field's definition but not the
evidence drawn from it (the gap F19 came through). In every case the test passed, the number was
present, and the claim looked established.

So assurance must run **upward as well**, and every layer answers one question:

> **What false reality could this layer let me believe?**

That is `ANTI_VACUITY_ANALYSIS` applied recursively — not only to `tests/`, but to harnesses,
measurements, procedures, evidence transformations, provenance records, and promotion rules.

**Why this matters beyond correctness.** The goal is converting experience into verified reusable state
so future work needs less reasoning. That only pays off if the chain
`experience → observation → evidence → verification → promotion` is trustworthy. If it is not, the
system is not amortizing intelligence — **it is amortizing mistakes**, and doing so with increasing
confidence and decreasing scrutiny. A wrong belief that has been promoted to executable state is worse
than one that has to be re-derived, because nothing will re-examine it.

Both findings that produced these protocols came from applying an existing procedure **to the thing that
produced the evidence** rather than to the code. That is the generalized method: run the protocols on
the procedures themselves.

---

## RULE: EVIDENCE INSPECTION DEPTH MUST MATCH THE PROPERTY BEING CLAIMED

Green CI is not one thing. Whether it is sufficient by itself depends entirely on what is being claimed
— treating "green" as a single universal sufficiency bar is how the U1a Windows miss happened: CI was
green, and green was misread as "closed" without reading what the passing test had actually recorded. The
fix generalizes past that one incident:

| Claim | Green CI alone sufficient? | What else is required |
|---|---|---|
| Pure deterministic transformation | Usually yes | Negative tests proving the guard can fail |
| Schema validation | Usually yes | Invalid-input tests, not only valid ones |
| Cross-process determinism | **No** | Fresh-process boundary evidence (F18) |
| Fault occurrence | **No** | Raw outcome distribution/classification, not a pass/fail summary (F20, U1a) |
| Measurement accuracy | **No** | Ground-truth comparison; unit and resolution checked separately (F19) |
| Cross-platform behaviour | **No** | Per-platform results inspected individually, never generalized from one cell |
| Durability | **No** | A fault model that actually matches the failure mode claimed (U1a vs. U1b — a process kill is not a power loss) |
| Performance / resource claim | **No** | Raw measurements plus the resolution analysis `MEASUREMENT_EVIDENCE_PROTOCOL` requires |

The left column is not exhaustive and is not meant to be looked up mechanically — the actual test is
**"is the interesting state part of what makes this claim true, or only part of how it's tested?"** M3's
correctness tests (ordering, rejection, replay determinism) are the first row: the test passing *is* the
evidence, because nothing about the claim depends on a rare or platform-specific event occurring. U1a's
tear reproduction is the fourth row: the claim is specifically about an event occurring, so a green suite
that never provoked the event proves nothing. Conflating the two — applying fourth-row scrutiny where
first-row suffices, or first-row credulity where fourth-row rigor is required — is itself a source of
wasted reasoning in one direction and vacuous evidence in the other.

**Evidence.** U1a's Windows correction (`ENGINEERING_LEDGER.md`) · F20 · F19 · F18.

---

## RULE: A VERIFIER MUST HAVE AN INDEPENDENT GROUND TRUTH

**A stored claim cannot simultaneously serve as both the claim and the ground truth it is checked
against.** Before defining a verification algorithm, identify — explicitly, in writing — where the
value it compares the claim to actually comes from, and confirm that source is not itself derived from
the record being verified.

**Why it exists.** The M7 preflight found `Evidence.contentHash` documented as *"hash of the observed
content,"* which reads as something a verifier can simply recompute and compare. It cannot: the
`Evidence` record stores the hash and a `source` string, never the observed content itself. A verifier
that reads `Evidence.contentHash`, reformats or re-hashes something derived from the same record, and
compares the result to itself is checking the record's internal consistency, not whether the claim is
true — it would `PASS` a record whose author mutated both the content *and* the stored hash to match.
This is `ANTI_VACUITY_ANALYSIS`'s false-implementation step applied specifically to verifiers: the false
verifier here isn't a bad test, it's a verifier with no real ground truth, dressed as one.

**The check.** For any verifier, name the two inputs separately before writing the comparison:

```
CLAIM        — what the record asserts (e.g. Evidence.contentHash)
GROUND TRUTH — where the actual value comes from, independent of the record
```

If GROUND TRUTH cannot be named without pointing back into the same record (or a field derived from
it), the verifier is non-discriminating by construction — no amount of test-writing fixes that; the
architecture must supply an independent source first.

**Candidate ground-truth models**, in the order M7's preflight found the architecture actually
constrains them:

| Model | Ground truth comes from | Cost |
|---|---|---|
| **Verification-time supplied observation** | The caller passes the content to check, at the moment of verification | None — fits the frozen `EvidenceSchema` and M7 having no persisted store, as-is |
| **Re-execute the source** | Re-running `Evidence.source` (a command/URL/path) | Entangles verification with execution/isolation (M9, not yet built) and non-reproducible sources (time, network, environment) make a mismatch ambiguous between tampering and legitimate drift |
| **Persist the original observation** | A content store written alongside `Evidence` at creation time | Reopens M3's closed, CI-verified storage architecture — a storage-authority change |
| **Content-addressed external artifact reference** | A new `artifactRef`-style field on `Evidence` | A frozen-contract change (`FROZEN CONTRACT RULE`, above) |

Only the first requires no change to anything already closed. The other three each name a specific,
identifiable HITL-gated change (execution scope, storage authority, or contract change) rather than
being ruled out by preference — the point of naming them is so a future session doesn't have to
re-derive this table from scratch if requirements change.

**Evidence.** M7 preflight, this session — `Evidence.contentHash` is documented as hashing "observed
content" the record never stores.

---

## PROCEDURE: REUSE_AN_ARCHITECTURAL_PRECEDENT

**Trigger.** Any point where a previous milestone's architecture looks like it answers the current one —
"Evidence got its own store, so Decision should too", "M7 didn't persist its result, so M9 shouldn't
either".

**Why it exists.** Three milestones in a row nearly inherited the wrong answer by analogy. M4's preflight
found `AUTHORITATIVE_SUBDIRS` lists `decisions` and `experience` exactly as it listed `evidence`, and the
`EventSchema.kind` enum offers `DECISION_RECORDED`/`EXPERIENCE_PROMOTED` exactly as it offered the three
`EVIDENCE_*` kinds — the same surface that M3 resolved. Copying M3's answer would have modelled
`Decision.stale` (**reversible** — replacement evidence restores validity, per M6) as a terminal
transition, and `Experience.rung` (**multi-step** promotion) as a two-outcome one. Both would have been
structurally incapable of the behaviour the system needs, and nothing would have said so until M6. That
is F16's shape — machinery whose construction excludes the case it will be relied on for — reached
through architecture rather than through a test.

**Steps.** A precedent is never reusable because the shapes match. It is reusable when its *reason* still
holds:

1. State the **property** that made the precedent correct, not the decision it produced.
2. State the current component's corresponding property.
3. List what **differs**. Lifecycle shape (terminal vs. reversible vs. multi-step), durability
   requirement, authority model, replay requirement, and identity semantics are the five that have
   actually diverged in this repository.
4. Ask the inverting question: **could the precedent be structurally wrong here?** Construct the failure
   it would produce. If you cannot name one, you have not yet understood the precedent's reason.
5. Reuse only if every differing dimension is irrelevant to the precedent's reason. Otherwise reuse the
   *mechanism* (canonicalization, framing, writer locks, `Anomaly`/`Classification`) and design the
   *semantics* fresh — M3 reused `recordHash`/`canonicalJson` while rejecting `EventLog` itself.

**Acceptance.** A named property, a named difference, and either a reuse justified by that property or a
constructed failure showing why reuse is invalid.

### Decision registry

Accepted decisions, with the conditions under which they transfer. Query this **before** opening a new
architecture question; a matching precedent is an answer, and a non-matching one is not a licence.

| id | decision | the property that made it correct | applies when | does NOT apply when |
|---|---|---|---|---|
| **M3-STORE-001** | Evidence gets its own authoritative append store, not a fold off `events.log` | The record is authoritative in its own right (its own `AUTHORITATIVE_SUBDIRS` entry) **and** the event-log route rests on untyped `payload` semantics nothing specifies | A contract has its own authoritative subdir and its lifecycle is **terminal** transitions over an immutable base | The lifecycle is reversible (`Decision.stale`) or multi-step (`Experience.rung`) — the store's shape must then differ even if the storage *location* decision matches |
| **M7-GT-001** | A verifier takes its ground truth as a caller-supplied observation | It was the only model requiring no change to anything already closed — not that it was the best model available | The needed ground truth can be supplied at call time without new storage, contract change, or execution | Ground truth requires re-execution (M9), persistence (reopens M3), or a new contract field — each is its own L4 boundary |
| **M7-NOSTORE-001** | `VerificationResult` is computed, never persisted | `WorkerState`'s shipped precedent: a record referenced by `Certificate` by hash, with no `STORAGE_SUBDIRS` entry, is computed on demand | The artifact has no storage subdir **and** no downstream milestone requires retrieving the original | A milestone's own acceptance criterion requires retention — M9's "artifact capture" does, so this precedent does **not** transfer to it |

**A precedent that does not match is not evidence for the opposite answer either.** It simply returns the
question to a fresh derivation.

**Evidence.** M4 preflight (near-miss on `stale`/`rung`) · M9 preflight (near-miss on the no-storage
precedent, where the roadmap's "artifact capture" contradicts it) · F16.

---

## RULE: A MILESTONE WITHOUT A FROZEN CONTRACT IS A DESIGN TASK, NOT AN IMPLEMENTATION TASK

**Before implementing any milestone, establish whether the contract it implements actually exists.** The
ten frozen contracts in `contracts/index.ts` are the complete set; a milestone whose interface is not
among them is being asked to *invent* semantics, not to satisfy them.

This distinction decides the authority level, and nothing else does. M3 and M7 were each constrained down
to a single viable answer *because* `EvidenceSchema` and `VerificationResultSchema` already existed and
already ruled the alternatives out — that is what made them safe to settle without escalation. M9's
`ExecutionBackend` appears only as one line of roadmap prose (`ROADMAP.md`: "define the `ExecutionBackend`
abstraction"). There is nothing to derive from, so a confident-sounding derivation there would be
invention wearing a derivation's clothes — the failure this rule exists to prevent.

**The check**, before any implementation begins:

1. Name the frozen contract this milestone implements. If you cannot name one, stop here.
2. State exactly what it constrains — and what it leaves to the engine (`EventSchema.payload` is the
   worked example: explicitly delegated, therefore *not* a specification).
3. Separate the **implementation** portion (constrained → proceed) from the **contract-design** portion
   (unconstrained → escalate). A milestone can be both, and usually is.

**Never label a contract-design decision L1/L2.** Being unable to find a constraint is not the same as
being constrained.

**Evidence.** M9 preflight — no `Execution*` schema exists among the ten frozen contracts.

---

## PROCEDURE: CROSS_PLATFORM_CANONICALIZATION_CHECK

**Trigger.** Any change to a cryptographic identity, a hash-bearing record, or a generated artifact whose
bytes are compared — including adding a field to a contract, changing a serializer, or emitting a new
generated file.

**Why it exists.** This was derived the expensive way. F13 began as a Windows-only CI failure that looked
like a flake; generalizing it to *"cryptographic identity must be platform-independent"* then exposed F14
(Unicode NFC) and F15 (unsafe integers) in code already declared frozen — F15 being a hash **collision**,
a false negative in tamper detection. See AP-020 in the ledger. The class, not the symptom, is the
finding: **one logical value with two byte representations, or two logical values with one.**

**Preconditions.** `packages/worker-runtime/src/canonical.ts` and its contract test exist.

**Steps.**

1. Ask the governing question for every accepted value — not *"is this valid JSON?"* but **"can two
   materially different semantic values collapse into the same canonical representation?"** If yes, the
   value must be refused, not encoded.
2. Confirm the canonicalizer still rejects what `JSON.stringify` silently corrupts: `NaN`, `Infinity`,
   `undefined` array elements, `Date`, `BigInt`, function, symbol.
3. Confirm Unicode normalization applies to **values and keys**, and that keys colliding after
   normalization are refused rather than merged or dropped.
4. Confirm integers outside ±(2^53−1) are refused — they are not distinctly representable as f64.
5. Confirm `-0` normalizes to `0`, and that key ordering is by UTF-16 code unit rather than locale
   collation.
6. Run the golden vectors. A change to any of them invalidates every previously issued hash and must be
   a deliberate, versioned migration — never a refactor side effect.
7. Verify line endings: `git ls-files --eol` must report `i/lf` for every tracked file. A CRLF checkout
   silently changes generated-artifact bytes.
8. Run the full CI matrix. **A local green run is not cross-platform evidence** — Windows has already
   caught one class-level defect that local runs could not.

**Acceptance.** Identical canonical bytes and identical SHA-256 on every matrix cell; no
platform-specific representation anywhere in a hashed record.

**Known caveat, deliberately not fixed.** The canonicalizer does **not** normalize path semantics —
separator variants hash differently. That is correct at this layer, but any future record that stores a
path must POSIX-normalize *before* hashing. No frozen contract stores one today;
`canonical-contract.test.ts` carries the tripwire.

**Evidence.** `canonical.ts` · `canonical.test.ts` · `canonical-contract.test.ts` · `.gitattributes` ·
AP-020.

---

## PROCEDURE: ANTI_VACUITY_ANALYSIS

**Trigger.** Before citing ANY test, benchmark, audit, or measurement as evidence for a property —
including in a commit message, a PR body, a gate claim, or the ledger.

**Why it exists.** This class has now bitten three times, and twice it was the *verification machinery*
rather than the runtime:

- The workspace boundary guard enumerated forbidden packages and silently omitted the most important
  one. It could not fail for the case it existed to catch.
- **F16** — the F10 write harness carried no `sequence`. Its clean concurrency numbers proved *set
  completeness* while being cited for *ordering*. Two different properties; only one was measured.
- **F18** — Gate 3 replayed twice in one process and was cited for determinism. Injecting
  `process.pid` into `stateHash` left all **32 in-process tests green** while failing **13 of 15**
  fresh-process tests.

The through-line: **a harness whose construction excludes the very failure it is cited as evidence
against.** A non-discriminating test is indistinguishable from a passing one by inspection, which is
what makes this class recur silently.

**Steps.**

1. **PROPERTY.** State the exact property claimed, in one sentence. If it takes two, they are probably
   two properties and only one is being tested.
2. **FALSE IMPLEMENTATION.** Construct the *smallest* change that makes that property false while
   leaving the code plausible. Not a broken build — a working implementation that lacks the property.
3. **DISCRIMINATION.** Run the test against it. **It must fail.** If it passes, the test is
   non-discriminating and may not be promoted to evidence for that property, whatever else it proves.
4. **OBSERVATION BOUNDARY.** Record what the test can actually observe: same process · fresh process ·
   concurrent processes · filesystem · machine/OS · crash boundary · network · clock · external state.
5. **PROMOTION RULE.** Promote it as evidence *only* for the property it discriminates, *only* within
   the boundary it observes. Never infer a stronger guarantee from a weaker boundary.

**Inferences that are not valid**, each of which has a real counterexample in this repository or is one
step from one:

| this | does not establish |
|---|---|
| in-process replay | cross-process determinism (F18) |
| successful concurrent execution | durability (U1) |
| no observed data loss | guaranteed atomicity (F10 — POSIX bounds `O_APPEND` at `PIPE_BUF`) |
| parser validity | integrity (plain append accepted a tampered, well-formed record) |
| schema validity | engine correctness (10 contracts, 2 engines) |
| CI green | semantic correctness |
| a green run on an earlier SHA | the current head (F17) |
| test coverage | proof of the covered property |

**Acceptance.** A recorded false-implementation cycle showing the test failing, plus a stated
observation boundary. Absent either, the claim is `UNKNOWN` — not `PASS`.

**Relationship to the procedure below.** `PROVE_A_GUARD_CAN_FAIL` is this procedure's narrowest special
case: it covers step 3 for a single guard. This one additionally forces steps 1, 4 and 5 — which is
where F16 and F18 actually went wrong. Both harnesses *could* fail; they simply could not fail for the
property being claimed.

---

## PROCEDURE: PROVE_A_GUARD_CAN_FAIL

**Trigger.** Before claiming any guard, invariant test, or boundary check `PASSED`.

**Why it exists.** Two real defects in this repository were guards that could not fail. The workspace
boundary guard enumerated forbidden packages individually and silently omitted `@lablaunchpad/core` — the
single most important one to block. The F10 concurrency harness used `spawnSync` in a loop, so its
"concurrent" writers ran **sequentially**; it would have passed for a mechanism with no concurrency
safety whatsoever. Both were found by trying to make them fail, not by reading them.

**Steps.**

1. Name the property the guard asserts, in one sentence.
2. Break that property in the source — remove the check, weaken the rule, delete the constraint.
3. Run the guard. **It must fail, and the failure must name the offending thing**, not merely report a
   mismatch.
4. Confirm it fails for the *right reason*: assert the specific cause, not just that something threw. A
   test that only checks "it threw" still passes when the check it targets is deleted and a neighbouring
   check catches the input by accident.
5. Restore the source and re-run. Verify the restoration is byte-exact.
6. If the guard cannot be made to fail, it is **not a guard**. Either it targets nothing, or its target
   does not exist — in which case report it `ARMED`, never `PASSED`.

**Acceptance.** A recorded broken-then-restored cycle, with the exact tests that failed.

**Evidence.** `core/src/boundaries/package-boundary.test.ts` (5 violation classes) ·
`packages/worker-runtime/src/ownership.test.ts` (I5 caught an undeclared writer by name) ·
`log/event-log.test.ts` (three guards independently falsified).

---

## PROCEDURE: MEASUREMENT_EVIDENCE_PROTOCOL

**Trigger.** Before adding, asserting on, or citing ANY measurement — tokens, latency, memory, CPU,
disk, cost, counts, durations. Supersedes the earlier `MEASURE_BEFORE_DEFINING_A_TELEMETRY_FIELD`,
which covered only the field's definition and not the evidence drawn from it.

**Why it exists.** F19. `telemetry.test.ts` asserted `cpuUserMicros + cpuSystemMicros > 0` after a
3M-iteration loop. It passed on Linux and returned **0** on Windows, which accounts process CPU via
`GetProcessTimes` at roughly a 15.6ms tick — the loop finished inside one tick. The inventory had
recorded the field as *"microseconds on every supported platform"*: true of the **unit**, silently wrong
about the **resolution**.

The dangerous part was never the failing test. It was the shape underneath it:

```
real work happened → measurement returned 0 → test read 0 as "no work" → false evidence
```

A defective measurement layer lets everything above it be confidently wrong while staying green. That
is F16/F18's structure one level lower down — the instrument, rather than the harness.

**The stack, where each layer fails independently:**

```
REAL SYSTEM → INSTRUMENTATION → HARNESS → EVIDENCE → DECISION
              unit/resolution/   can it     what was
              accounting/        discrim-   actually
              availability       inate?     established?
```

**Steps.**

1. **PROPERTY** — what exactly is being measured? Not the field name; the physical quantity.
2. **UNIT** — what unit is returned? Verify empirically, by ratio against a second known quantity.
   Never assume bytes. (`maxRSS` is kilobytes on Linux, bytes on macOS — wrong by 1024× if assumed.)
3. **RESOLUTION** — the smallest change the mechanism can distinguish. **A different property from the
   unit**, and the one F19 turned on.
4. **ACCOUNTING METHOD** — how the platform computes it. Page-cache-absorbed block I/O, timer-tick
   sampling, and direct counters fail in different ways.
5. **PLATFORM MATRIX** — where behaviour differs. Verify on the CI matrix, not locally.
6. **AVAILABILITY** — can the measurement legitimately be absent or zero *while the work happened*? If
   yes, zero is not evidence of nothing.
7. **FALSE-RESULT TEST** — can real activity produce the reported value? This is anti-vacuity aimed at
   the instrument: construct the case where work occurs and the number does not move.
8. **BOUNDARY TEST** — does the test stimulus exceed the measurement's resolution? Size it against the
   **coarsest** resolution supported, and drive it from measured wall clock rather than an iteration
   count — otherwise a faster machine does a *shorter* burn and is *more* likely to fail (F17 applied to
   a measurement instead of a timeout).
9. **PROMOTION RULE** — state the claim the measurement actually justifies, and no more.

**Inferences that are not valid:**

| this | does not establish |
|---|---|
| returns microseconds | detects microsecond-scale work |
| the API exists | it has equivalent semantics on every OS |
| the counter reads 0 | no work occurred |
| the test passes | the property is proven |
| measured on Linux | measured anywhere else |

**Acceptance.** Each of the nine answered, with unit and resolution answered *separately*. Anything
unestablished is `UNKNOWN` and **absent from the record**, never present as a zero — a missing token
count defaulted to 0 makes an execution look free, so the amortization ratio improves exactly when
instrumentation is lost, reporting success as a consequence of going blind. Coverage therefore travels
with every ratio.

**Evidence.** `resource/telemetry.ts` · `resource/telemetry.test.ts` · `resource/measurement.ts` ·
F19 · the `maxRSS` and `fsRead`/`fsWrite` findings.

---

## PROCEDURE: ADD_A_WRITE_PATH_TO_THE_KERNEL

**Trigger.** Any new kernel code that creates, modifies, or deletes a file.

**Why it exists.** The kernel's storage must never collide with AnyPlugin's install destinations, which
are journaled and restored to pre-install bytes on uninstall — a collision would mean
`anyplugin uninstall` reverting or deleting the authoritative ledger, silently and with a clean exit
code.

**Steps.**

1. Call `assertWritable` from `ownership.ts` on the target path **before any filesystem call**. It is the
   only sanctioned validation; do not add a second ad hoc check.
2. If the module calls `node:fs` mutators directly, add it to `DIRECT_FS_WRITERS` **with a stated
   reason**. The I5 guard fails otherwise, by design, and will name the module.
3. Confirm the target lies under a declared `STORAGE_SUBDIRS` entry. An undeclared subdirectory is a
   hidden writer.
4. For deletion, use `assertDeletable` — strictly narrower than writing. Authoritative records are not
   deletable at all; supersession is how the ledger changes its mind, and it preserves history by
   construction.
5. Confirm exactly one authoritative writer for the target root (I1). If a second is possible, refuse it
   at the filesystem with `openSync(..., "wx")` and **never auto-break a stale claim** — from inside the
   process, a stale lock and a live second writer are indistinguishable.
6. Re-run the ownership suite. All of I1–I6 must stay `PASSED`; I7 flips only against a real deletion of
   governed state.

**Acceptance.** I5 reports zero undeclared writers; the new path is refused for every foreign-owned,
absolute, and traversing input, each by its own named reason.

**Evidence.** `ownership.ts` · `ownership.test.ts` · `log/event-log.ts` · AP-018.

---

## PROCEDURE: PROVE_REPLAY_DETERMINISM

**Trigger.** Any change to replay, state folding, canonicalization, or the event
frame — and before citing any determinism claim as gate evidence.

**Why it exists.** Replaying twice in one process is not proof (F18). It shares module state,
lazily-initialized schema objects, and every import-time environment read. Measured: injecting
`process.pid` into `stateHash` left **32 in-process tests green** and failed **13 of 15**
fresh-process tests.

**Steps.**

1. Write an authoritative history with **interleaved contracts**, so map insertion order depends on
   traversal rather than on the alphabet, plus one event kind the fold ignores.
2. Compare by **canonical bytes and content hash**, never object identity — two objects can be
   deep-equal and serialize differently, and serialization is what certificates bind.
3. Replay in a process that shares nothing with the writer. Assert it matches in-process.
4. Replay in **two independent fresh processes**. Assert they match each other.
5. Vary what a process cannot inherit: **cwd, `TZ`, locale**, the log's location on disk, and the
   identity of the writing process. Each must not move the hash.
6. Assert damage replays deterministically too — a corrupted log must give the *same* wrong answer
   everywhere, or two operators recovering it reach different conclusions about what survived.
7. Assert each mutation **differs from the clean digest**. One replay cannot distinguish from the
   original is a silent-acceptance defect.
8. **Negative-test the harness itself**: inject a process-local value into the hash and confirm the
   fresh-process tests fail. If they do not, the harness is not evidence.

**Acceptance.** Identical canonical state across process boundaries and environments, on every CI
cell. Damage classified identically everywhere.

**Explicitly not established.** Durability. These steps prove state rebuilds from a log that
*survived*; they say nothing about whether it survives a crash or power loss.

**Evidence.** `log/replay-determinism.test.ts` · F18 · U1.

---

## PROCEDURE: FAULT_INJECTION_MUST_HIT

**Trigger.** Any test that injects a fault — process kill, truncation, disconnect, timeout, corruption —
and cites the result as evidence.

**Why it exists.** F20. A crash harness using 256KB records reported
`{"NO_WRITES":1,"CLEAN_BOUNDARY":5}`: **zero torn tails in six trials.** It passed, asserted no
corruption, and exercised nothing. The interesting state is the rarest, and the boring one is
indistinguishable from success — so the default outcome of a fault-injection test is *vacuous*.

**Steps.**

1. Enumerate the states the fault can produce. For a kill during a single `write()`: before the syscall
   (nothing), inside it (torn), after it (complete).
2. Identify which state exercises the property. Usually exactly one, usually the rarest.
3. **Classify every trial by outcome. Never assert a global pass/fail across trials.** A trial that
   missed the interesting state must be labelled as having missed it, not counted as a success.
4. **Measure whether the interesting state is producible at all** before concluding anything. If it never
   occurs, distinguish *not observed* from *cannot happen* — they license completely different claims.
   The tuning parameter is usually physical: record size, timing window, buffer boundary.
5. Assert the **universal** invariants on every trial regardless of outcome (nothing silently wrong,
   byte accounting exact, replay deterministic).
6. **Report the outcome distribution rather than asserting it.** How often a fault lands in the
   interesting window is a property of the platform's scheduler, not of the code — asserting a
   distribution makes the suite fail for reasons unrelated to the invariant.
7. Prove the classifier **deterministically**, from a constructed corrupt state — never from an injected
   one. A probabilistic check of a detector tests the scheduler, not the detector.

**Acceptance.** A reported distribution containing at least one occurrence of the interesting state, or
an explicit statement that it was not produced and why. Universal invariants asserted on all trials. The
classifier proven against a constructed false state.

**Measured platform facts (Linux, Node 22).** SIGKILL during `appendFileSync`: 256KB completes
atomically; ≥1MB tears. Do not assume these hold elsewhere — they are observations, not guarantees.
**Confirmed by evidence, not just caution**: the same 2MB threshold reproduced zero tears on Windows in
six trials on exact-head CI. Do not port a tuning parameter across platforms without re-measuring it.

**Evidence.** `log/crash-resilience.test.ts` · F20 · U1a.

---

## PROCEDURE: COMPACTION_INTEGRITY_PROTOCOL

**Trigger.** Any point where conversational context is compressed — automatic (the harness's own
context-window compaction) or manual (a session summary written to hand off work).

**Why it exists.** Every other procedure in this file defends the pipeline `repository → evidence →
decision → procedure → experience → context`. Compaction inserts a step the others don't cover:
`context → COMPACTION → compressed context → reasoning`. A bad compaction produces confident
wrongness with **no code defect at all** — nothing in the repo changed, so none of the tests here would
ever catch it. This is the same class as F16/F18/F19 (a layer that can be wrong while every layer above
it stays green) one level higher: the layer above the repository instead of below it.

**The governing invariant.** *Compaction may remove conversational detail. It may never remove
engineering state.* Engineering state is: decisions, contradictions, UNKNOWNs, negative knowledge
("X does not exist / must not be assumed"), open blockers, closed gates with their exact evidence
(SHA + CI cell count, not just "passed"), ownership/security constraints, procedures, and the next
required action. Losing prose is compression. Losing any of those is data loss wearing compression's
clothes.

**Specific failure shapes to guard against** (each has a concrete instance in this project's history):

1. **Decision loss** — retaining *what* was decided while dropping *why*, e.g. "F9 resolved" surviving
   without "resolved by refusing the literal instruction because it contradicted the type system."
2. **UNKNOWN → FALSE/RESOLVED** — U1a and U1b collapsing into one "durability: done" when U1a is closed
   for process-crash only and U1b is untouched. This is the highest-risk shape in this repository
   specifically, because `SupportLevel`/`Validity` already encode UNKNOWN as a first-class state that a
   sloppy summary can quietly erase.
3. **Evidence provenance loss** — "Gate 4 passed" surviving without the exact SHA, which CI cells, and
   what was NOT established (durability). A summary is then treated as primary evidence instead of a
   pointer to it — exactly the OBSERVED-vs-DOCUMENTED confusion `provenance-semantics.md` exists to
   prevent, recurring at the context layer instead of the capability-matrix layer.
4. **Contradiction loss** — keeping the resolution, dropping the fact that spec and repo disagreed. The
   contradiction is *why* the decision was justified; without it the decision looks arbitrary or, worse,
   reversible by someone who re-reads only the spec.
5. **Scope drift** — "U1a: process crash" + "U1b: power loss" merging into "U1: durability," after which
   future reasoning can claim U1b is covered by U1a evidence. Same failure as collapsing OBSERVED into
   VERIFIED.
6. **Negative knowledge disappears** — facts of the form "V5.2.1 does not exist," "UNKNOWN is an absent
   key, never a value," "CI green ≠ semantic correctness" are asymmetric: forgetting them costs a
   repeated mistake, not just a repeated lookup. Summaries compress toward what exists; what-must-not-be-
   assumed has no natural home in a summary and is the first thing lost.
7. **Procedure degradation** — "anti-vacuity protocol established" is not the same as retaining that a
   procedure requires PROPERTY, FALSE IMPLEMENTATION, DISCRIMINATION, OBSERVATION BOUNDARY, PROMOTION
   RULE. A name without its steps cannot be executed, only cited.
8. **Stale HEAD outliving reality** — a control header asserting a SHA that a later git operation moved
   past. This is why the header below is a *navigation index into the repository*, never a substitute for
   reading it.
9. **Rediscovery cost** — losing *where* something was recorded (not the fact itself) causes
   `grep → scan → inspect → rediscover → reason again`, which can spend more tokens than the compaction
   saved. This is the reason the header names artifacts, not conclusions.
10. **Wrong priority after compaction** — "next: U1a" surviving after U1a closed. Current gate state must
    be re-derived from the repository at the next decision point, never trusted from memory of a prior
    turn — this is `ENGINEERING_LEDGER.md`'s job, not the context window's.

**The control header.** Not authoritative — a pointer, discarded the moment it disagrees with the
repository:

```
ENGINEERING SESSION STATE (navigation index — repository is authoritative)
HEAD: <exact SHA>            BRANCH: <name>
LAST VERIFIED CI: <SHA> — <n>/<total> cells, verified <how: get_commit / get_check_runs>
CLOSED GATES: <ids only — detail lives in ENGINEERING_LEDGER.md>
OPEN BLOCKERS / UNKNOWNS: <ids only>
DECISIONS PENDING AUTHORITY: <one line each>
NEXT REQUIRED ACTION: <one line>
```

**The reconciliation rule.** After any compaction — automatic or a fresh session reading a handoff
summary — the first action is reconciliation, never implementation: re-read `HEAD`, re-verify the last
CI claim against the repository (not the header's memory of it), re-read the open gates in
`ENGINEERING_LEDGER.md`, and only then continue. Cheap relative to rediscovering the state from scratch,
and it is what stops the header from becoming the thing this protocol exists to prevent.

**The anti-vacuity test for compaction**, per `ANTI_VACUITY_ANALYSIS` applied to compaction itself: for
each candidate fact, construct a compacted context with it removed and ask whether a plausible next
action changes. If removing "F9 was resolved by correcting a contradictory spec, not by following it"
changes nothing about what happens next, it may be droppable. If removing it lets a future turn silently
re-attempt the literal instruction, it is mandatory. This is a discipline to apply when writing a
handoff, not a mechanism this repository can run as a test — see Acceptance below.

**What this deliberately does not do.** No memory-compression engine, no second ledger. The header is
a pointer into artifacts this repository already owns (`ENGINEERING_LEDGER.md`, `CURRENT_STATE.md`,
this file); externalizing state into well-structured repository artifacts is what should make context
progressively *smaller*, not a better summarizer. Building the latter would be exactly the premature,
speculative machinery this project's own doctrine argues against.

**Acceptance.** **Not verifiable by this repository's test suite** — compaction happens at the harness
layer, outside kernel code, so nothing here can assert it mechanically today. This procedure's status is
`DOCUMENTED`, not `VERIFIED`, on the same ladder `provenance-semantics.md` defines: stated as a discipline
to follow, not proven by a passing test. Promoting it to `OBSERVED`/`VERIFIED` would require an
instrumented harness that can compare pre- and post-compaction state — not attempted here, and not
invented to fill this gap.

**Evidence.** This session's own U1a-classification handoff (the event this procedure generalizes from)
· `provenance-semantics.md`'s OBSERVED/VERIFIED distinction, applied one layer up.
