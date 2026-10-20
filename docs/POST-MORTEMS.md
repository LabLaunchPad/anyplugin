# Post-mortems

**Status:** ACTIVE — this is the repository's post-mortem record. The live
state of the work is `docs/agent-sdk/roadmap.md` for plans and
`docs/BACKLOG.md` for open work.

A post-mortem here answers one question: **why did a false claim survive long
enough to matter?** The answer is not "someone was careless". It is always a
specific, nameable mechanism — a document that rationalised the defect, a
safety predicate fed a constant, a test that asserted the subject's own
self-report — and a mechanism can be closed.

---

## 0. The rules

| Rule | Why |
|---|---|
| **Blameless.** | The unit of analysis is the mechanism, not the author. "Somebody should have caught it" is not a mechanism. |
| **Evidence, not inference.** | Every claim about the code carries a `file:line`. Every claim about impact carries a reproduction. A post-mortem that says "could" where it can say "did" is a guess wearing a report's clothes. |
| **A finding without a decision is not closed.** | Each post-mortem ends in a numbered decision, a backlog row, or an explicit "this is accepted, and here is why". |
| **The guard is the deliverable.** | A post-mortem that produces only a narrative has produced a story. The thing that stops it recurring is a check that fails when the defect returns. |

### 0.1 The defect-to-closed checklist

Reusable. Use it for every defect that reaches this file.

| # | Step | The question it answers |
|---|---|---|
| 1 | **Reproduce.** A test that **fails** on the unfixed code. Assert on the **effect** — the filesystem, the exit code, the written record — never on a value the subject produced itself. | *Is this real?* |
| 2 | **Classify the severity by the repository's own table**, not by intuition. | *How bad is this, in the units this repository uses?* |
| 3 | **Prove the blast radius.** Who can reach it? What is the worst outcome? Is a user reachable, or only the maintainer? | *How much does this matter?* |
| 4 | **Find the stated invariant.** Which sentence, in which document or code comment, claims this is handled? Quote it verbatim. | *What was supposed to prevent this?* |
| 5 | **Ask whether the claim was ever true, or was rationalised.** A document that explains the defect away is worse than no document: it makes the defect *look* handled. | *Why did reading the docs not help?* |
| 6 | **Find every consumer.** Grep the symbol. A rule with exactly one live consumer is a rule whose input can be a constant. | *Is the rule even wired up?* |
| 7 | **Verify the deferral rationale.** "It changes a frozen contract" is a claim about the registry. Check the registry, not the README. | *Is the fix really blocked?* |
| 8 | **Ask whether the suite could ever have caught it.** A test that asserts a value the subject produced is a subject grading its own homework. | *Why did it ship green?* |
| 9 | **Fix the code — and the test that encoded the bug.** A test asserting the wrong behaviour is a defect of its own. | *What changes?* |
| 10 | **Sweep every document that overclaims.** The same false sentence usually appears in four places. | *What else lies?* |
| 11 | **Add the guard that would have caught it.** This is the deliverable. | *How does it not recur?* |
| 12 | **Get an independent adversarial review**, and fix or classify every finding. | *What did I miss?* |
| 13 | **Record the decision, the scope note, and the severity correction.** | *What is the truth now?* |

---

## 1. PM-001 — The fallback chain that could not close

**Class:** BUG · **Severity:** **P0** (was filed as P1) · **Status:** FIXED
· **Decision:** D-052 · **Backlog:** P1-10 (re-classified), P1-10a…d below

### 1.1 Summary

`anyplugin delegate` runs a request through a fallback chain of backends. The
chain is supposed to stop when a failed attempt has already had an effect,
because trying the next backend would run the task a second time.

**The chain could never stop.** The rule existed, was correct, and was tested
in the kernel — but the only live consumer fed it the constant `false`, so
the rule never refused anything. A backend that wrote files and then failed
was followed by a **second backend running the same task**.

The same file's header comment claimed the invariant was enforced. It was
not.

### 1.2 Impact — proven, not asserted

The reproduction drives real subprocesses against a real directory and asserts
on the **filesystem**:

```
marker.log == ["alpha", "beta"]
```

`alpha` wrote the file and failed. `beta` wrote it again. **The task ran
twice, and the side effect was performed twice.** The host also received
both answers, because `cli/src/bin.ts:646-651` printed every attempt's stdout.

Worst case, in the general shape: a delegated agent turn that partially
succeeded — writing files, sending a request, charging a card — fails, and
the wrapper repeats the whole turn against a different backend.

### 1.3 Root cause — the causal chain, not the proximate one

| # | Level | Fact |
|---|---|---|
| 1 | **Proximate** | `cli/src/delegate.ts` (HEAD `485c1e2`) set `committed: false` at four call sites — lines 252, 404, 437, 451. The string `committed: true` appeared nowhere in the repository outside one unit test. |
| 2 | **Structural** | The kernel rule took a single boolean (`fallbackLegal(committed: boolean)`), so it had **no input** for the thing that actually mattered: whether the attempt had an *effect*. A rule with no input for the decisive fact is a rule that cannot decide the decisive fact. |
| 3 | **Systemic** | The same file's header listed five invariants. **Four were mechanically enforced** — never a shell (`shell: false`), never an unbounded run (a deadline and a byte cap), never an unbounded environment (an allowlist), never a silent failure (an event per attempt). **The fifth was not.** The defect lived in the gap between a list of promises and the code beneath it. |
| 4 | **Epistemic** | `docs/FAILURE-MODES.md` §5 did not omit the behaviour — it **explained it away**: *"The CLI's own chain is therefore unbounded by this rule today, which is honest: the CLI is a batch tool, not a streaming proxy."* The conclusion was framed as a design property. The reasoning was wrong: buffering does not make the host unaware, because the buffer is printed per attempt at the end, and nothing in the sentence addressed **effects** at all. |
| 5 | **Testing** | `cli/src/delegate.test.ts:98-99` asserted `outcome.fallbackLegal === true` after a timeout, with the comment *"A timed-out turn is NOT committed, so a fallback is still legal."* The reasoning was about **output** and said nothing about **effects**. The suite was green because it agreed with the defect. |
| 6 | **Guard** | The mechanical guard in this repository (`core/src/boundaries/doc-ownership.test.ts`) checks **documents**: ownership, status vocabulary, decision labels, evidence rows, section pointers. A **code-versus-prose divergence** is invisible to it — it reads documents and never executes a claim. It found four orphaned documents and seventeen under-specified decisions in its first hour, and it could not have found this. |

### 1.4 What went wrong that was not the defect

**The deferral rationale was false, and it was the reason nobody fixed it.**

`docs/BACKLOG.md` P1-10 and `docs/DECISIONS.md` D-013 both deferred the fix
because it *"changes a frozen, certificate-bound contract, so it needs its own
versioned migration"*. That is **not true**:

- The frozen contracts are exactly the ten Zod schemas in the `CONTRACTS`
  registry (`packages/worker-runtime/src/contracts/index.ts:403-414`), each
  with a committed JSON Schema mirror under `packages/worker-runtime/schemas/`
  (exactly ten files), enforced byte-for-byte by
  `packages/worker-runtime/src/schema-sync.test.ts`.
- `fallbackLegal` is a plain exported **function** in
  `packages/worker-runtime/src/telemetry/delegation.ts`. It is not a schema,
  it is not in `CONTRACTS`, it has no mirror, and `CertificateSchema` binds no
  delegation hash.
- `npm view @lablaunchpad/worker-runtime` → **404**. The package is
  **unpublished**. There is no external API surface to break.

**The blocker was a behaviour change, not a contract migration** — and that is
a completely different kind of blocker, one a human can decide in a sentence.
A wrong rationale is worse than no rationale: it makes a fix look impossible.

### 1.5 The decision (D-052)

The rule becomes:

```
fallbackLegal(attempt) ⇔ no COMMIT_POINT exists
                        ∧ no output was HANDED TO THE HOST
                        ∧ the effect state is KNOWN and is NONE
```

Three consequences, each forced by the repository's own principles:

1. **The effect state is a required argument.** A caller that cannot say what
   state the attempt's effects are in must say `UNKNOWN` — and `UNKNOWN`
   forbids the fallback. Making it optional would let a caller forget it, and
   a forgotten effect state is the defect.
2. **`UNKNOWN` forbids the fallback.** D-013's *"no EFFECT in {IN_FLIGHT,
   COMMITTED}"* silently treats `UNKNOWN` as `NONE`. That is the same mistake
   the repository forbids everywhere else: an unknown quantity is never
   defaulted, an unknown capability fails closed, an unclassifiable failure is
   not retried. **This is a safety question, not a health question** — and
   `FAIL_POLICY` fails OPEN on health precisely because failing closed there
   would be a self-inflicted outage.
3. **Three signals stay distinct.** `committed` (the host HAS the output —
   irreversible) ≠ `outputProduced` (the attempt produced an answer) ≠
   `effectState` (a side effect may have happened). Conflating the first two
   is what defeated the first attempt at this fix: nearly every backend
   prints something, so a rule that refuses the fallback whenever anything was
   printed would stop the chain from ever falling back.

**The wrapper's honesty about what it cannot know.** A generic CLI wrapper
cannot observe whether a backend had an effect on the world. Its honest answer
is `UNKNOWN`, so **the fallback is refused by default** — and the escape
hatch is explicit: `--re-runnable` asserts that the task is safe to repeat.
It is an assertion by the caller, not a proof by the wrapper, and it is
recorded as such.

**One class is provably safe.** `spawn_failed` means the process never ran, so
it provably had no effect — and the fallback proceeds. The resilience the
chain exists for is preserved where it can be justified.

**And the presentation harm is solved where it lives.** Two answers reaching
the host is a *presentation* problem, so `bin.ts` now sends only the answer
attempt's stdout to stdout; every earlier attempt's output becomes stderr
diagnostics. The chain rule does not have to refuse fallbacks to avoid it.

### 1.6 The four defects the review found in the same file

The independent adversarial review of this cycle found **three more live
defects in the same file**, none of which the original analysis had seen:

| ID | Defect | Fix |
|---|---|---|
| **F2** | An exit-0 attempt carrying an error envelope was reported as a **SUCCESS**: `cli/src/delegate.ts:421-424` dropped the classification when it was `unknown`, so `failureClass` stayed `undefined`. That is "a wrong answer presented as right" — a P0 by this repository's own definition. | `unknown` is a real class whose behaviour is `report`. The classification is no longer dropped. |
| **F4** | `FALLBACK_SELECTED` named the **wrong backend** — the one that had just failed, not the one chosen. Two events were emitted for one transition, one of them contradicting the event's own definition. | The duplicate emission is removed; the loop head already emits the correct one. |
| **F6** | A dead placeholder sat on the hot path of every envelope classification: `const named = classifyHttpStatus(0); void named;`. | Removed. |

And one the review found that is **not yet fixed**, because it needs a
frozen-contract change:

| ID | Defect | Status |
|---|---|---|
| **F3** | The delegation telemetry **never reaches the event log**. `toLogRecords`, `telemetryRelPath` and `resolveTelemetryRoot` (`cli/src/delegate.ts:841-853`) have **zero call sites**. A `DelegationEvent` is *structurally un-appendable*: the frozen `EventSchema`'s `kind` enum contains no delegation kinds. So the wrapper's own contract ("write a telemetry event into the worker-runtime event log") and the OKF bundle's *"the telemetry goes to the worker-runtime event log, not a log file"* are both false. | **P1-10d.** The fix needs the new event kinds of P1-11, which is a versioned migration. Recorded, not applied. |

### 1.7 The prevention — three guards, and the one that matters

The review's sharpest observation: **the class of defect invisible to this
repository's guard is a code-versus-prose divergence**. The guard reads
documents; it never executes a claim. Its "can fail" mutation proves it fails
on *malformed documents*, not that the documents' *claims* are true. The
class a document guard can never catch is **truth**, and truth needs an
executable assertion.

So the guards to add are not document guards:

| # | Guard | What it catches | Cost |
|---|---|---|---|
| **G1** | **Constant-argument guard.** For each exported kernel safety predicate, assert that no call site passes a *literal* for the decisive parameter. | `committed: false` at four sites would have been flagged instantly. The structural cure already landed: the effect state is a **required** argument, so it cannot be forgotten. | Small |
| **G2** | **Consumer-aware check over `docs/FAILURE-MODES.md` §11.** The table already maps each rule to the test that enforces it. Require the named test to import the **live consumer** (`cli/src/delegate.ts`), not only the kernel unit. Row 256 pointed at `delegation.test.ts` — a unit test, while the defect lived in the CLI. | A rule whose enforcement is only tested at the unit level. | Small |
| **G3** | **Orphan-contract guard** *(BUILT)* + **milestone→test binding** *(open)*. Each schema in `CONTRACTS` must have a consumer outside `contracts/index.ts`, or an explicit "bound to milestone X" annotation; each `ROADMAP.md` milestone must name the test file that closes it. | **P1-13** — "the graph has contracts and no engine" would have been *mechanically flagged* rather than sitting in the backlog for months. This is the cheapest guard in the list. | **BUILT** — `packages/worker-runtime/src/contracts/orphan-contracts.test.ts` (8 tests). It found **six** contracts with no consumer, two of which the graph engine bound this cycle. The milestone→test half is still open |

**And the process change that is not a guard:** the backlog's definition of
done for a BUG is *"a regression test exists that fails without the fix"*, so
the process **expects** a red test for an open bug — with no mechanism to
keep `pnpm test` green. The convention this repository needs is
`it.fails` plus a required BACKLOG id in the test name, so an
intentionally-red test and an accidentally-red test are distinguishable.

### 1.8 What was NOT wrong

The repository's instincts held up, and the record should say so:

- The **kernel's taxonomy, the circuit breaker's state machine, the two-axis
  fail policy and the classification precedence** are sound, deterministic and
  tested. The defect was in the **wiring**, not in the design.
- The **doc-ownership guard is genuinely non-vacuous** — it has a "can fail"
  mutation test, and it found four orphaned documents and seventeen
  under-specified decisions the first time it ran.
- The **schema-sync guard** is byte-for-byte, checks for orphan files, and
  checks regeneration determinism.
- The **package-boundary guard** mechanically holds the dependency direction.
- **Writing the reproduction before the fix was the right instinct**, and the
  reproduction is a good artefact: it drives real subprocesses, asserts on the
  filesystem, and its header states the rule that matters — *if the assertion
  were made on the returned events, a wrapper that lied about its own
  telemetry would pass*.
- **The adversarial review found three more live defects in the same file.**
  It also found a bug in the *first attempt at the fix*. Review is not a
  formality; here it changed the design.

---

## 2. PM-002 — A contract with no engine

**Class:** GAP · **Severity:** P1 · **Status:** **PARTLY BUILT** — the traversal
engine and the cascade shipped in this cycle · **Backlog:** P1-13 ·
**Roadmap:** MVP 2 (`docs/agent-sdk/roadmap.md` §5.2)

### 2.1 Summary

`GraphNodeSchema`, `GraphEdgeSchema` and `GraphSnapshotSchema` exist at
`packages/worker-runtime/src/contracts/index.ts:308-325`. A repository-wide
search finds them **only** in that file, in the JSON Schema mirror, in a
generated artefact, and in prose. `InvalidationResultSchema` declares
`affectedNodes`, `staleDecisions`, `reopenedWork` and `requiresReverification`
— **none of which can be computed without traversal**. `ROADMAP.md`'s
milestone M5 is undone, and M6 (the invalidation engine) depends on it.

### 2.2 What is *not* true about it

The investigation corrected three statements that had been carried around:

| Claim | Truth |
|---|---|
| "`CURRENT_STATE.md` calls the graph engine `DESIGNED`, which is not in the closed vocabulary." | `CURRENT_STATE.md` has its **own** seven-value classification legend, and `DESIGNED` is in it ("contract/schema/doc exists; no executing implementation"). The guard's closed vocabulary governs the `**Status:**` line of seven root documents only. **Two vocabularies coexist; neither is violated.** And `CURRENT_STATE.md` is `SUPERSEDED` — it is a retired snapshot, not the live status document. |
| "Nothing notices." | The repository notices in **five** places: `CURRENT_STATE.md`, `docs/agent-sdk/gaps.md`, `docs/DECISIONS.md` D-041, `docs/agent-sdk/roadmap.md` §5.2, and the backlog itself. What is missing is a **machine check** — which is exactly what `ROADMAP.md:300` promises and never realises. |
| "`gaps.md` says the graph symbols are referenced in `contracts.test.ts`." | **Stale.** The only mention there is `graphSnapshotHash`, a certificate field, not a graph consumer. |

### 2.3 A gap the contracts themselves hide

`GraphNodeSchema.id` is `idSchema("node")` → **`ND-…`**. But
`InvalidationResultSchema.staleDecisions` is `idSchema("decision")` →
**`DEC-…`**, and `reopenedWork` → **`WC-…`**.

**A graph node therefore cannot carry a decision's id.** The cascade cannot
populate `staleDecisions` or `reopenedWork` without a **node→record
resolution convention**, and that convention exists nowhere. It is the one
piece of design that must be written down before the engine can be built, and
writing it down is part of the specification:

> For node kinds `EVIDENCE`, `DECISION`, `EXPERIENCE` and `WORK_ITEM`, the
> node's `ref` **is** the record id. For `FILE`, `SYMBOL`, `TEST`, `CONFIG`
> and `CLAIM`, `ref` is a path, a symbol or a claim key. A `ref` that does
> not match the id schema its kind requires is reported as an
> **anomaly**, never silently skipped.
>
> **`CLAIM` is in the second list, not the first**, and the reason is worth
> recording: the kernel has **no CLAIM record type** — `ID_PREFIXES` has no
> entry for it — so a claim node's `ref` is a claim key, not a typed id.
>
> And the `ref` is validated with the **same id schema the result is
> validated with**, never with a prefix check. `"DEC-bad id"` starts with
> `"DEC-"` and is not a decision id; a prefix check let it through, and the
> failure surfaced as an unhandled schema error in the *result* — which is
> the worst possible place for it.

### 2.4 Which edges propagate, and in which direction

**`INVALIDATES` alone is not sufficient.** The dependency-like kinds propagate
too — and in the **reverse** direction of the edge, because this repository
writes those edges *dependent → dependency*:

| kind | direction | why |
|---|---|---|
| `IMPORTS`, `MODIFIES`, `TESTS`, `SUPPORTS`, `DEPENDS_ON`, `DERIVED_FROM`, `LEARNED_FROM` | **REVERSE** | "X imports Y" means *X → Y*, so Y's change affects X. `SUPPORTS` is what `DecisionSchema.supportingEvidence` encodes. |
| `INVALIDATES` | **FORWARD** | the one edge that literally says "this invalidates that". |
| `SUPERSEDES` | **NONE** | a *replacement* relation. Invalidating the new record must not invalidate the old one; it belongs to the **restore** step, not the cascade. |

**Proof that the dependency kinds are required:** M6's acceptance criterion is
*"Invalidating E1 flips the dependent claim to `INVALIDATED`, the dependent
decision to `STALE`, and the dependent work contract to `REOPENED`, and leaves
unrelated decisions untouched."* E1 → Claim is a `SUPPORTS` edge, so a
cascade that follows only `INVALIDATES` **cannot satisfy M6**.

The kind→direction table is **contract semantics** and belongs in the kernel
(D-041: the kernel owns traversal; the SDK owns which edges may be traversed,
on what evidence, with what budget). The SDK may narrow the set; the kernel
must not leave the direction undefined for every caller — that is the
"second trust ladder" mistake this repository has already made once.

### 2.5 The specification

**Module:** `packages/worker-runtime/src/graph/` (the path the backlog already
names). **Kernel only.** **No contract change, no version bump, no
certificate invalidation** — the input and output contracts already exist.

**Pure functions. No I/O, no clock, no randomness.** The kernel precedent is
the circuit breaker: *"the state machine is deliberately free of I/O and of
wall-clock reads: the caller supplies `now`."*

```
indexGraph(snapshot) -> { nodes, outgoing, incoming, anomalies }
reachable(index, from, { kinds?, direction? }) -> node ids
components(index) -> components
findCycles(index) -> cycles
topologicalOrder(index) -> { order, cycles }        // refuses on a cycle
computeInvalidation(snapshot, input) -> { result, anomalies }
```

**Edge cases the engine must handle, and what it must do with each:**

| Case | Required behaviour |
|---|---|
| **Cycles** | Detected and **reported**, never followed infinitely. Reachability over a cyclic region is still well-defined (visited set), so the cascade **terminates** and lists the whole affected region. Only the *topological order* is undefined with a cycle ⇒ `topologicalOrder` must **fail closed** and return the cycle members rather than emit a wrong order. |
| **Self-loops** | A 1-cycle: reported as `SELF_LOOP`, never recursed. |
| **Duplicate edges** | Identical `(from, to, kind)` triples de-duplicated for traversal and **reported**, never silently merged. Distinct kinds between the same pair are **not** duplicates. |
| **Dangling endpoints** | `GraphSnapshotSchema` has **no** referential-integrity refinement, so an edge may name a node that is absent. The endpoint is treated as an UNKNOWN-kind node, **reported**, and **never** silently dropped. |
| **Disconnected components** | Enumerated, deterministically ordered. No single-root assumption. |
| **Multi-hop and branching** | BFS/DFS with a visited set; hop distance exposed separately from the flat id list. |
| **Determinism** | No `Date.now()`, no `Math.random()`, no I/O; the caller supplies `at`. Node ids sorted lexicographically, edges sorted by `(from, kind, to)`, every returned list sorted by id ⇒ two snapshots with the same node and edge **sets** in different array orders produce identical output. The engine never mutates its input and never infers a node's kind. |

**What the cascade must compute.** `affectedNodes` — the nodes reachable from
the trigger through the propagation relation, **excluding the trigger**,
sorted by id. `staleDecisions` — the decisions resting on an affected node,
resolved through the node→record convention of §2.3. `reopenedWork` — the
`contractId` of the stale decisions, ∪ the `WORK_ITEM` nodes reached; the
`REOPENED` **transition** is not a graph operation (`LEGAL_TRANSITIONS`
already permits it), so the engine returns **ids** and the fold writes the
transition. `requiresReverification` — the verifications whose `inputHashes`
reference an invalidated artefact, resolved through the evidence records that
carry the content hash.

**Corpus:** the repository's own dependency graph — the backlog's own choice
— plus branching, multi-hop, a cycle, a self-loop, a disconnected component,
duplicate edges, a dangling endpoint, the M6 chain E1 → Claim → Decision →
Work, and **an unrelated decision that must stay untouched** (the negative
acceptance test).

**Must not be done:** no LLM, no heuristic, no wall clock, no I/O; the engine
must not decide policy; no contract edits.

### 2.6 Why it is still the cheapest high-value item in the plan

It is a **pure function over an existing contract**. No version bump, no
schema regeneration, no certificate invalidation, no new dependency, and the
kernel still imports nothing workspace-internal. It is the only item in the
SDK roadmap that lands in **this** repository (D-047), and it is what makes
`InvalidationResultSchema` — already shipped — mean something.

### 2.7 What was built, and what was not

**BUILT in this cycle** — `packages/worker-runtime/src/graph/`:

| Piece | What it does |
|---|---|
| `indexGraph(snapshot)` | The indexed form: nodes, outgoing and incoming adjacency, and an **anomaly report** for duplicate nodes, duplicate edges, self-loops and dangling endpoints. The input is never mutated, and the output depends only on the node and edge **sets** — not their order. |
| `reachable(index, from, opts)` | Multi-hop reachability with a visited set, so a cycle terminates the walk instead of truncating the answer. |
| `reachableWithDistance(index, from, opts)` | The same walk, with the **hop distance** exposed separately from the flat id list — "is it reachable" and "how far is it" are different questions. |
| `propagatingReachable(index, from)` | The cascade's walk: `INVALIDATES` forwards, the seven dependency kinds backwards, `SUPERSEDES` never. |
| `components(index)` | Every connected component, deterministically ordered. No single-root assumption. |
| `findCycles(index)` | Tarjan's algorithm, iterative, plus every self-loop. |
| `topologicalOrder(index)` | A dependency-first order — and a **refusal** when a cycle makes the order undefined. A partial order would be a wrong answer presented as right. |
| `computeInvalidation(snapshot, input)` | The producer `InvalidationResultSchema` never had. It carries the **node→record resolution convention** of §2.3, so the two id spaces finally meet. |
| `serializeGraphIndex(index)` | A stable, comparable serialisation of an index. `JSON.stringify` on a `Map` produces `{}`, so a determinism test that stringifies an index compares two empty objects and proves nothing — which is exactly what two of this module's own tests were doing. |

**The corpus is the repository's own dependency graph**, built from the
workspace's real `package.json` files — so a change to a dependency would
move exactly the expected nodes, and the workspace graph is proven **acyclic**
(which is what makes the dependency direction's topological order defined).

**NOT built** — the rest of the roadmap's MVP 2, and each is recorded in the
backlog rather than implied: the **log → snapshot derivation** (module 2.1),
the **re-orient policy** (2.4), and the **AST kernel** (2.6, 2.7).

**And M6 is PARTIAL, not done.** The cascade computes the *ids*; the `STALE`
and `REOPENED` **transitions** are the state fold's job — `LEGAL_TRANSITIONS`
already permits them, and the kernel's rule is that it records and verifies
and never infers. The *replacement evidence restores validity* half of M6's
exit condition has no producer yet.

### 2.8 The review of the engine, and what it found

The engine got its own independent adversarial review — the same discipline
D-038 requires of every change. It ran **experiments**, not readings: a
brute-force SCC oracle over 5 000 random graphs, 6 000 random graphs through
the topological order, 200 permutations of the determinism claim, and a fuzz
that generated schema-valid graphs to see whether the engine crashed.

**What it confirmed.** Tarjan's implementation is **exactly right** — 0
mismatches against the oracle. The edge-direction table is **exactly** as
specified, all nine kinds, in both directions. The refusal semantics are
sound — 0 partial orders in 6 000 graphs. The trigger semantics are
correct. The anomaly list is deterministic.

**What it found — three P1 merge-blockers:**

| # | The defect | The fix |
|---|---|---|
| **D1** | A **schema-valid** graph could crash the cascade. `GraphNodeSchema.ref` is `z.string().min(1)` — any non-empty string — and the engine's check was `startsWith(prefix)`. So `"DEC-bad id"` passed the check and then failed the *result*'s schema with an unhandled `ZodError`. **117 of 4 000** randomly generated schema-valid graphs threw. | The ref is validated with the **same id schema the result is validated with**. A malformed ref is a **`MALFORMED_REF` anomaly** and the record is excluded — reported, never crashed on. |
| **D2** | The caller's `decisions` and `at` were unvalidated, so a caller could break the schema the engine produces. | The decision and work-contract ids are validated and reported as **`MALFORMED_REFERENCE`**; the instant is validated with a **clear message**, because a result cannot exist without one and there is nothing to exclude. |
| **D3** | The determinism guarantee was **false** when two nodes shared an id: the sort tie-broke on the id alone, so a stable sort left the tie in *input* order — and the retained node's kind decided whether a decision was stale. The same graph marked a decision stale in one order and not the other. | The node sort is now a **total order** — id, then kind, then ref. |

**And nine more, all fixed:** the topological order ignored three of the
seven dependency kinds (so its "dependency-first" invariant was inverted for
them); the hop distance the specification required was **not exposed**; a
malformed ref was filed under `DANGLING_ENDPOINT`, which means something
else; a dangling trigger was refused although the module's own traversal
finds its dependents from it; the corpus covered **4 of the workspace's 8**
packages and dropped the adapters' edges **silently**, while claiming the
corpus would move with any dependency change; the engine's most important
file contained **literal NUL bytes**, so **git treated it as binary** and
the change was not reviewable; `findCycles` could report a self-loop twice;
and two of the determinism tests compared `{}` to `{}`, because
`JSON.stringify` on a `Map` produces `{}`.

**And eight weaknesses in the tests themselves** — the most instructive,
because the engine's behaviour was *correct* in several of the places the
tests were weak:

- The duplicate-node test asserted **input-order** behaviour and so
  **masked D3**.
- The "unrelated decision stays untouched" test put the unrelated decision
  in a **disconnected component**, so a "flood the whole component" bug
  would also have passed. The discriminating cases — same component, joined
  by an `INVALIDATES` edge pointing *at* the trigger, or by a `SUPERSEDES`
  edge — are now tested, and the implementation was correct in both.
- The determinism test used **one fixed permutation** of six nodes, which
  is one two-hundredth of the coverage a permutation claim deserves. It now
  runs every rotation, both flips.

**The lesson, and it is the same one as §1.3:** *the class of defect a
document guard cannot catch is truth.* It applies just as well to a
**test** guard. A test that asserts the implementation's own output proves
that the implementation is self-consistent, which is not the same as
proving it is correct — and a test that compares two empty objects is
**theatre**.

**And the fixes were verified with the review's own method**, not with a
new test that could be wrong in the same way. The same fuzz — random
**schema-valid** graphs, with deliberately near-miss refs — was run again:

| | Before | After |
|---|---|---|
| Graphs that threw an unhandled error | 117 of 4 000 | **0 of 8 000** |
| Malformed refs silently passed the check | the rest | **1 682, each REPORTED as `MALFORMED_REF` and excluded** |
| Results that depended on the input order | 294 of 3 000 | **0 of 2 000** |

The second row is the one worth reading twice: **21% of the fuzzed graphs
contained a malformed ref, and every one of them now produces an anomaly
instead of a crash.** A crash is the worst possible absorption of a defect,
because it converts a data problem into an outage and takes the diagnosis
with it.

---

## 3. The checklist, filled in

Every step of §0.1, against the two post-mortems above.

| # | Step | PM-001 | PM-002 |
|---|---|---|---|
| 1 | Reproduce | ✅ `cli/src/delegate-fallback-audit.test.ts` — real subprocesses, filesystem assertions, **failing before the fix** | ⬜ the corpus is specified; the failing test comes with the engine |
| 2 | Classify severity by the repo's table | ✅ **P0**, was filed P1 | ✅ P1 |
| 3 | Prove the blast radius | ✅ `marker.log == ["alpha","beta"]`; two answers to the host | ✅ zero consumers; M5 and M6 undone |
| 4 | Find the stated invariant | ✅ `cli/src/delegate.ts:32`; `docs/FAILURE-MODES.md` §5 | ✅ `ROADMAP.md:300` — "ends in a machine-checkable exit condition" |
| 5 | Was the claim true, or rationalised? | ✅ **rationalised** — `FAILURE-MODES.md` §5 explained it away as a design property | ✅ the milestone's exit condition was promised and never realised |
| 6 | Find every consumer | ✅ one — and its input was a constant | ✅ zero consumers |
| 7 | Verify the deferral rationale | ✅ **false** — not a frozen contract; the package is unpublished | ✅ n/a — no contract change needed |
| 8 | Could the suite ever have caught it? | ✅ **no** — the test asserted the subject's own self-report | ✅ no — no test names the milestone |
| 9 | Fix the code and the test that encoded the bug | ✅ both | ⬜ with the engine |
| 10 | Sweep the documents that overclaim | ✅ six artefacts | ⬜ |
| 11 | Add the guard | ⬜ **G1, G2, G3** — specified, not yet built | ⬜ **G3** — the orphan-contract guard is the whole point |
| 12 | Independent adversarial review | ✅ ran; found 3 more live defects and a bug in the first fix | ✅ reviewed; found 2 factual errors in the original analysis |
| 13 | Record the decision, scope note, severity | ✅ D-052; P1-10 re-classified to P0 | ✅ P1-13 restated with its specification |

---

## 4. Related documents

| Document | Owns |
|---|---|
| `docs/BACKLOG.md` | Every open item, classified, with its severity and the scope note |
| `docs/FAILURE-MODES.md` | What goes wrong, and what the system does about it — the catalogue this record cites |
| `docs/DECISIONS.md` | Why each choice was made, and what was rejected |
| `docs/EVIDENCE.md` | The source of every external number quoted in this record |
| `docs/SESSION-LEARNINGS.md` | What each cycle learned, at the level of the cycle |
| `docs/agent-sdk/learnings.md` | The extraction ledger: every learning with its source, its status, its negative case |
| `docs/agent-sdk/roadmap.md` | The plan these post-mortems feed |
