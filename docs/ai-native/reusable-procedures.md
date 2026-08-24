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
