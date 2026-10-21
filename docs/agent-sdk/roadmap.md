# Roadmap: the MVP ladder for the Agent/Worker SDK

**This is the implementation plan.** The specification is in
`docs/agent-sdk/README.md`; this document says **what gets built, in what
order, and what proves each step works.**

**Status:** PLANNED — no code from this plan exists yet. It is written here
because D-039 puts the implementation in a **separate repository** that
consumes the kernel from npm, and because the kernel-side work it needs
(MVP 2) lands in *this* repository.

Every external claim carries a source URL and an access date of
**2026-10-20**, in `docs/EVIDENCE.md` or in the document that quotes it.
Verdicts: `VERIFIED` / `PARTLY VERIFIED` / `CONTRADICTED` / `UNKNOWN`.

---

## 1. The problem-solving framework

**Every MVP runs the same eight stages.** The stages are not a metaphor; each
has a **schema**, a **deterministic gate**, and a **named failure mode**, and
the deterministic-vs-model boundary is marked explicitly.

### 1.1 The pipeline

| # | Stage | Output | Gate (deterministic) | Failure mode | Model? |
|---|---|---|---|---|---|
| **0** | **INTAKE** | `{ request, requester, requestedOutcome, declaredAcceptance[], stakes, deadline, budget, authzScope }` | request non-empty; `requestedOutcome` is a **question**, not a solution; `authzScope` present; budget > 0; requester identified | Missing or ambiguous intake; **the solution smuggled in as the problem** | **D** |
| **1** | **FRAME** | `{ goal, successMetric, job, circumstance, stakeholders[], assumptions[{id, statement, status: ASSERTED\|VERIFIED\|INVALIDATED, basis}], framingAlternatives[] }` | ≥2 `framingAlternatives` recorded (anti-anchoring); every `assumption` has a `status` (no silent axioms); `goal` and `successMetric` distinct and non-empty | Anchoring on the first framing; unexamined assumptions; **MECE violation** — a missing branch of the problem space | **M** + gate |
| **2** | **CONSTRAIN** | `{ musts[{id, statement, measurable, evidenceRef?}], wants[{id, statement, weight, measurable}], constraintsHard[{kind, value}], adverseConsequences[] }` | every `must` is **measurable**; every `must` is satisfiable by some candidate; `musts` non-empty; `wants` are **ranked**, not thresholded; `adverseConsequences` non-empty | MUSTs that are unmeasurable; MUSTs that are unachievable; adverse consequences never considered | **D** + **M** |
| **3** | **DECOMPOSE** | `{ workItems[{id, parentId, statement, type: TASK\|HYPOTHESIS\|DECISION, dependsOn[], doneWhen, evidencePlanRef?, budget, owner: SELF\|DELEGATE(specialty), depth}], coverage: {uncoveredBranches[]}, rationale }` | acyclic; every leaf has `doneWhen`; **MECE** — `uncoveredBranches` empty or each explicitly accepted out-of-scope with a reason; **independence** — no two leaves' `doneWhen` require the same evidence artefact; budget sum ≤ parent; `depth` ≤ cap | The **telephone game** — fidelity lost at every hop; a missing branch; coupled functions | **M** + gate |
| **4** | **EVIDENCE PLAN** | `{ plan: { forWorkItemId, sources[{kind: AUTHORITATIVE\|DERIVED\|REPORTED, locator, expectedAuthority}], method, falsifier, cost }[] }` | every work item has a plan with a **falsifier**; no plan relies solely on `REPORTED` for a load-bearing claim; each source's authority matches the claim's required authority; plan cost ≤ stage budget | An evidence plan that **cannot fail**; authority inflation; a chain of plausible reasons with no test | **M** + gate |
| **5** | **EXECUTE** | `{ attempts[{workItemId, actor, toolCalls[], artifacts[{uri, hash, kind}], outcome, failureClass?, evidence[] }], ledgerAppendOnly }` | every attempt is hash-framed and appended to the single-writer log; per-attempt deadline and token/cost budget enforced; delegation depth and fan-out within caps; **unclassifiable failure ⇒ no retry**; capability grant explicit and minimal, **never inherited** | Infinite agentic loop; cascade; privilege inheritance; spend blow-up | **M** + **D** |
| **6** | **VERIFY** | `{ verdict: PASS\|FAIL\|BLOCKED, checks[{kind: MECHANICAL\|EVIDENCE\|CONFORMANCE, target, result, detail}], evidenceAdmitted[], blockedReason? }` | verification is **against the requirement**; `PASS` requires ≥1 `AUTHORITATIVE` or `DERIVED` evidence record **or** a mechanical check — never a `REPORTED` claim; **`BLOCKED` is first-class** and never silently converted; a delegated result is verified **outside** the supervisor's own reasoning | Verifying with the same reasoning that produced the thing; judging on hard pairs; conflating FAIL with BLOCKED | **D** + **M** |
| **7** | **INTEGRATE** | `{ integrated: {artifactRefs[], workItemIds[], decisionTrace, conflicts[{between, resolution, authorityBasis}]}, residualGaps[], nextActions[] }` | every included artefact has a verified hash and an admitted evidence record; every conflict is resolved by **authority basis**, not recency or verbosity; `residualGaps` explicitly enumerated (empty ⇔ a completeness claim); nothing enters integration while any of its evidence is `INVALIDATED` or `SUPERSEDED` | Merging contradictory results without recording the conflict; silently dropping a failing branch | **D** |
| **8** | **LEARN** | `{ promotions[{evidenceId, from, to, justification, verifier}], invalidations[{targetId, reason, evidenceId}], lessons[{statement, scope, confidence, evidenceRefs[]}], nextHypotheses[] }` | no promotion to `VERIFIED_KNOWLEDGE` without ≥1 admitted evidence record of sufficient authority; a superseded lesson is **invalidated**, not edited in place; every lesson cites its evidence; invalidated lessons are excluded from future planning | **Unearned promotion** — the epistemic ladder is the defence; lesson drift; "validated learning" without validated metrics | **D** + **M** |

**D** = deterministic (executable in the kernel with no model). **M** =
model-required.

### 1.2 Which frameworks each stage is lifted from — and which are refused

| Stage | Lifted from | The specific thing taken |
|---|---|---|
| 0 | Lean Startup | The distinction: *"Can this product be built?"* vs *"Should it be?"* |
| 1 | First principles · JTBD · Double Diamond | `goal` / `constraints` / `assumptions[]` / `job`+`circumstance`; the **ordering constraint** that Discover+Define precede Develop+Deliver |
| 2 | **Kepner–Tregoe** · **Polya** · ISO 15288 Risk Analysis | The **MUST/WANT split** as a *screen* (MUSTs eliminate, WANTs rank, MUSTs must be measurable); Polya's condition-sufficiency classification; non-empty `adverseConsequences` |
| 3 | First principles · **Suh's independence axiom** · **V-model** | MECE coverage; the independence check; **bidirectional traceability** — every requirement ↔ ≥1 design element ↔ ≥1 acceptance test |
| 4 | **FTA / IEC 61025** · MAST | The **minimal cut set** as the hypothesis set (a disjunction over conjunctions — the exact shape of a falsifier set); MAST's *task verification* failure category |
| 5 | LLMCompiler · Anthropic effort budgets · **IAL-Scan** · OWASP ASI02/ASI03 | The planner/executor split; **bounds enforced at the scope where the feedback is created** and propagated along the path; the "Intent Gate" (treat planner output as untrusted) |
| 6 | **V-model** · τ-bench · **CaMeL** | Verification against the *requirement*; **end-state grading**; `BLOCKED` as a distinct verdict; control/data-flow separation |
| 7 | ISO 15288 §6.4.4/§6.4.8 | The definition → integration chain; residual-gap enumeration as the completeness claim |
| 8 | Lean Startup · **the kernel's own ladder** | Validated learning; the epistemic ladder as the promotion mechanism |

### 1.3 Three frameworks that are **refused** as gates

| Refused | Why | Source |
|---|---|---|
| **5 Whys** | Arbitrary depth, **non-repeatable** results, tendency to stop at symptoms, cannot find unknown causes, isolates a single cause. It is a **hypothesis generator**, not a method | Card, *BMJ Qual Saf* 2017;26(8):671–677 — VERIFIED |
| **"Explode the problem"** | A *framing* technique that produces a redefinition. It must never stand in for the evidence stage, and its output must pass the same MUST/WANT screen as any other framing | — |
| **The Double Diamond as a process spec** | "It's not an instruction manual on how to design, it's an invitation to get involved" (IDEO's Tim Browne). Only its **ordering constraint** is gate-worthy | designcouncil.org.uk — VERIFIED |

**The gap no framework closes:** none of them specify **how a sub-agent's claim
becomes admissible evidence**, and none specify **delegation bounds**. That
is exactly what this kernel already owns — which is why the pipeline is
*fused with* the ladder rather than replacing it.

---

## 2. The high-layer goals

Seven goals. Every MVP must advance at least one, and the roadmap is
ordered by which goal it unblocks.

| # | Goal | The falsifiable claim | Where it is measured |
|---|---|---|---|
| **G1** | **Zero-compute by default** | A document becomes a structured, evidence-tiered intent with **zero server compute** | MVP 1 — S-01, S-02 |
| **G2** | **Every claim is evidence-tiered** | No claim is asserted without a tier, and the tier is a *projection* over the kernel's `EvidenceSchema` | MVP 1 — S-03 |
| **G3** | **Bounded, calculated, stable** | Every loop is bounded, every budget capped, every failure classified, every terminal condition audited | All MVPs — S-08 … S-12 |
| **G4** | **Multi-tier graph engineering** | The pipeline *is* a graph; traversal is deterministic; invalidation cascades | MVP 2 — S-06, S-07 |
| **G5** | **Cost and latency are measured, never claimed** | Every optimisation reports its measured hit rate, break-even status, and effect size | MVP 4 — S-20 … S-22 |
| **G6** | **Persistent and non-persistent, one spec** | The same Worker runs stateless and durable, and the difference is *one field* | MVP 3 — S-05 |
| **G7** | **Region-tailored compliance** | The compliance profile is a **first-class input**, not a document | MVP 5 — S-16, S-17 |

---

## 3. Two postures, one specification

The same `worker.yaml` runs in both. The difference is **one field**:
`durability: STATELESS | PERSISTENT`.

| | **STATELESS** | **PERSISTENT** |
|---|---|---|
| **What it is** | One-shot: bytes in, a receipt out | A long-running contract with checkpoints, a graph, a shadow arm, a policy set |
| **State kept** | The content-addressed cache only | The kernel's event log + the SQLite projection |
| **Typical use** | A form submit; a quick document summarisation; a one-shot extraction | A document pipeline over weeks; an agent with a workload |
| **Budget** | One turn, one attempt | Per-contract, per-day, with checkpoints |
| **What can fail** | The one attempt | A hundred attempts across a week — so the metrics become `pass^k` and the time horizon |
| **When to choose it** | When the answer is the product | When the *work* is the product |

**Why this matters to the metrics.** METR's RE-Bench found the best AI agents
beat humans **4×** at a 2-hour budget, humans *narrowly exceeded* top AI at
8 hours, and **humans beat AI 2× at 32 total hours**. Reliability under
*accumulated* time is where the field is weak — and a STATELESS workload
never touches that regime. The posture is therefore a **correctness**
decision, not a performance one.

*Source:* arXiv 2411.15114, PMLR v267 — VERIFIED.

---

## 3A. The three layers, and why conflating them is the leading cause of failure

**Graph Engineering · the Kernel · the Runtime.** Three layers with three
different failure signatures, and the separation is not cosmetic — it is the
difference between a *bug* (a race in a state write) and an *outage* (a
runaway loop, an unhandled concurrency spike, an unbounded fan-out).

| Layer | Responsibility | Core components | What it manages | Where it lives in *this* project |
|---|---|---|---|---|
| **Graph Engineering** | Topology and flow design | Nodes, edges, state schemas, conditional routers | Who talks to whom, what data flows along edges, how parallel writes compose | **The SDK** — MVP 3's orchestrator, MVP 2's graph, the D9 delegation gate |
| **The Kernel** | State and memory control | Checkpointers, reducers, thread ids, memory stores | Immutable execution history, session persistence, conflict resolution across state updates | **`packages/worker-runtime/`** — already built: the framed event log, the replay fold, `foldWorkerState`, the `LEGAL_TRANSITIONS` table |
| **The Runtime** | Execution infrastructure | Sandboxes, async/sync workers, concurrency limits, retries | Process lifecycles, crash recovery, timeout ceilings, hardware and rate-limit safety | **The execution tier** — the `ExecutionBackend` shapes (`LocalProcessBackend` today; `ContainerBackend`, `VMBackend`, `RemoteBackend` are shape-only) |

### 3A.1 The reasoning/execution separation — already ours, and it is load-bearing

| | **The reasoning loop (LLM nodes)** | **The execution layer (deterministic nodes and tools)** |
|---|---|---|
| **What it does** | Analyses input, generates plans, evaluates intermediate outcomes, decides the next step | Executes code, queries databases, calls APIs, does file I/O |
| **Engineering constraint** | Bounded by token limits, schema output validation, and **strict maximum turn/recursion caps** | **Completely isolated from model interpretation.** Strict schemas, transactional guarantees, idempotent retry wrappers |
| **Where it lives here** | The SDK's orchestrator | The kernel + the execution tier |

> `AGENTS.md` already states the invariant in one line: **"the model is not
> memory, not knowledge, not experience, not authority, not the verifier, and
> not the execution environment."** That *is* the reasoning/execution
> separation, and it is enforced mechanically by
> `core/src/boundaries/package-boundary.test.ts` — the kernel imports nothing
> workspace-internal, so **no inference can reach the state layer**.

### 3A.2 The reducer contract — and where this repository is *stricter*

The reference pattern for parallel-safe state is an **append-only reducer**
per key: `Annotated[List[dict], operator.add]`, so two parallel workers
merging into the same collection compose deterministically instead of racing.

**This repository already has the stronger version.** `foldWorkerState` folds
the event log into state, and the kernel's rule is that there is **one
authoritative writer** — a parallel write is not made safe by a reducer, it
is **refused** (`FOREIGN_OWNED_PATHS`, and the storage-root / install-whitelist
disjointness test).

| | Append-only reducers with parallel writers | This repository's single-writer log |
|---|---|---|
| **Parallel writes** | Allowed; composed by a declared reducer | **Refused** — one writer, by construction |
| **Merge determinism** | Depends on the reducer being correct and associative | **Free** — the log is ordered, so the fold is a fold |
| **Cost** | A reducer bug silently corrupts merged state | A second writer is a **refusal**, not a corruption |
| **Cost of the stricter rule** | — | **Serialisation.** Parallel fan-out cannot write concurrently, so the orchestrator's parallelism is *compute* parallelism, not *write* parallelism |
| **Right trade?** | — | For a **kernel** that must be replayable byte-for-byte, yes. For a **hot path** that needs parallel writes, the reducer pattern wins — which is why the SDK's orchestrator may adopt reducers **at the SDK layer**, above the kernel, and never inside it |

**The reconciliation, and it is a real decision:** the SDK's graph layer may
use append-only reducers for its own working state, because it is *not* the
kernel and does not need byte-identical replay. The kernel keeps the
single-writer rule. **Two layers, two disciplines, one boundary** — and the
boundary is the same one the package-boundary test already draws.

### 3A.3 The runtime configuration — policy is a constant; parameters are configuration

**Never hardcode limits inside a prompt or in agent code.** A centralised
configuration schema governs runtime behaviour, concurrency and safety
bound-checks. The reference shape:

| Setting | Reference value | Where it lands here |
|---|---|---|
| `max_recursion_limit` | 25 | MVP 3 `3.8` — the **super-step** cap, distinct from a microstep loop cap |
| `max_concurrency_bound` | 4 | MVP 3 `3.2` — the fan-out cap, applied at the **dispatch site** |
| `max_tool_execution_timeout` | 30 s | MVP 3 `3.5`; MVP 5 `5.6` — the tool deadline |
| `fail_closed_on_error` | true | The kernel's existing capability rule, verbatim |
| `persistence.isolation_level` | serializable | MVP 3 `3.3` — the SQLite (WAL) projection's transaction isolation |

> **A conflict worth recording.** Two official pages of one framework
> disagree on the default recursion limit — **25 on one, 1000 on the other.**
> That is the whole argument for **not inheriting a default**: a limit you
> did not choose is a limit you did not reason about. Every cap in this plan
> is **named, sourced, and labelled** — and the microstep-loop cap in
> particular must be **finite by default**, because a cycle in a graph is a
> *correctness* bug, not a tuning question.

**And the distinction that makes this consistent with the rest of the
plan:** the repository's rule is that the **unsafe combination** is a
constant in code, not configuration an operator can relax (D-022's
never-automated list, the `FAIL_POLICY` axes). The reconciliation is precise:

| | A constant in code | Configuration |
|---|---|---|
| **What** | The *policy* — what is forbidden, what never happens | The *parameters* — the magnitudes, TTLs, budgets, timeouts |
| **Why** | An operator must not be able to configure the unsafe combination | The magnitudes change per deployment, and a value that cannot change is a value that is wrong somewhere |
| **Examples** | The never-automated list; `fail_closed_on_error`; capability-closed vs health-open | The recursion cap, the concurrency bound, the tool timeout, the cache TTL |
| **Where** | `packages/worker-runtime/src/telemetry/delegation.ts`; the never-automated list | The SDK's `RuntimeConfig` schema — a **single, validated** document, never scattered across code or prompts |

### 3A.4 The four-point scenario checklist, mapped to the plan

| Check | Where it is satisfied | The gate that proves it |
|---|---|---|
| **1. State atomicity** — the checkpointer and state database handle concurrent writes via **atomic transactions**, not in-memory volatile maps | MVP 3 `3.3` — the SQLite (WAL) projection, with a serializable isolation level and a sequence number per row | The `doctor` drift check: SQLite's max sequence against the log head. A difference is a `BLOCKED` finding, not a silent inconsistency |
| **2. Explicit fan-out bounds** — if the planner can spawn 1 to 1,000 sub-tasks, place a strict **code-level slice or semaphore cap at the dispatch site** | MVP 3 `3.2` and `3.5` — the cap is at the dispatch site, not in the prompt, and the **D9 gate** refuses an unjustified fan-out in the first place | The handoff-depth cap, the concurrency bound, and a test that a violating delegation is **refused with a reason** |
| **3. A human-in-the-loop gate** — a **durable interrupt checkpoint** that pauses execution **without consuming active compute** | MVP 3 `3.4` — a checkpoint is a *state* transition, and a paused contract consumes no budget while it waits | The human approval must **name the `contentHash`** it approves (D-022). A pause that keeps burning budget is not a pause |
| **4. Resumability** — kill the process mid-run; the runtime reloads the thread state from the checkpointer and resumes from the **exact node-failure boundary** | MVP 3 `3.4`; MVP 2 `2.3` — the invalidation cascade | **S-05**: a `kill -9` resumes without duplicating completed work, verified by the recorded artefacts' hashes |

**And the one the checklist implies but does not say:** a resume must resume
from the **failure boundary**, not from the **start of the node**. The
published research on this is unambiguous — a node that is re-executed from
its start **repeats every side effect before the interrupt** — which is why
the SDK's resume semantics are: *a completed step is replayed from its
recorded result, never recomputed* (the kernel's replay), and a step whose
result is unrecordable is treated as **not durable** and reported, never
silently re-run.

---

## 4. The delegation contract

**Seventeen clauses.** Each is citable; each is either **[KERNEL]** (this
repository already enforces it) or **[NEW]** (the SDK must implement it).

| # | Clause | Source |
|---|---|---|
| **D1** | **Delegation is a typed, schema'd request, not prose.** It carries `objective`, `outputFormat`, `toolsAndSources` guidance, `taskBoundaries`, `depth`, `budget{turns,tokens,cost,wallClock}`, `acceptanceCriteria[]`, `authorityGrant`, `parentTaskId`. | Anthropic — *"Without detailed task descriptions, agents duplicate work, leave gaps, or fail to find necessary information."* **[NEW]** |
| **D2** | **Context is passed as a digest or a handle, never as the full transcript.** The child gets the objective, its minimum inputs, and handles (URI + hash) to artefacts. | Anthropic context engineering (the sub-agent returns a **1,000–2,000 token** digest); LangChain handoffs — *"Pass only these two messages, not the full subagent history."* **[NEW]** |
| **D3** | **Depth is bounded by hard, runtime-enforced caps:** `maxDepth`, `maxFanout`, `maxHandoffs`, `maxTurns`, `maxTokens`, `maxCost`, `maxWallClock`, `maxRepeatedIdenticalCall`. Enforced **at the scope where the feedback is created** and propagated along the path. Uncovered cycles reported at compile time. | IAL-Scan — *"bounds should be enforced at the runtime scope where feedback is created… report uncovered cycles during compilation or runtime."* **[NEW]** |
| **D4** | **Loop detection is structural, not semantic:** identical call with identical arguments in a window; a **pair-level** handoff cycle (A→B→A); a repeated `(workItemId, stateHash)` frontier; state growth exceeding budget. Detection ⇒ **deny and escalate**, never retry. | IAL-Scan ALDG; OWASP ASI02 *loop amplification*. **[NEW]** |
| **D5** | **Authority is explicit, minimal, and non-inheriting.** The child MUST NOT inherit the parent's ambient credentials, sessions or scopes. A privilege the child needs but was not granted is a **FAIL**, not an implicit escalation. | OWASP ASI03 — *"manipulating delegation chains, role inheritance"*; the *attribution gap*. A2A *Opaque Execution*. MCP — *"MCP servers MUST NOT accept any tokens that were not explicitly issued for the MCP server."* **[NEW]** |
| **D6** | **The child returns a typed result envelope:** `{ status: COMPLETE\|PARTIAL\|BLOCKED\|FAILED, findings[], artifacts[{uri, hash}], evidenceRecords[{id, authority, validity, locator}], failureClass?, unblocks[], nextActions[] }`. Prose without an envelope is a **FAIL of the delegation**, not a PASS of the task. | Anthropic — *"Each subagent needs… an output format."* **[NEW]** |
| **D7** | **Verification of the child's result happens outside the supervisor's own reasoning**, is end-state-based, and can return `BLOCKED` as a distinct outcome. | Anthropic — supervisors *"fail most often by stopping too early on output that reads as fluent prose"*; *"end-state evaluation rather than turn-by-turn analysis."* τ-bench grades on **database end state**. **[KERNEL]** + **[NEW]** |
| **D8** | **Reliability is measured, not assumed.** Every delegation is evaluated with **pass^k**, and a delegation whose pass^k collapses with k is **defective**. | τ-bench — gpt-4o succeeded on **<50 %** of tasks and was *"quite inconsistent (pass^8 <25 % in retail)"*. **[NEW]** |
| **D9** | **Delegation topology is chosen from measured task properties, and the decision is itself gated.** | *Towards a Science of Scaling Agent Systems*, arXiv 2512.08296 — VERIFIED. **[NEW]** |
| **D10** | **Every delegation is bounded by an explicit, revocable budget, and every tool call is logged immutably.** | OWASP ASI02 — *"Adaptive Tool Budgeting… automatic revocation or throttling"*; *"immutable logs of all tool invocations."* **[KERNEL]** |
| **D11** | **The delegation handle is server-minted, random, expiring, and bound to the authenticated principal. Possession is not authorisation.** | MCP SEP-2567 — *"MCP servers MUST NOT treat possession of a state handle as authentication."* **[NEW]** |
| **D12** | **Every delegation is recorded in the append-only, hash-framed, single-writer log** — the only durable record of who did what. | **[KERNEL]** |
| **D13** | **An unclassifiable failure is never retried**, and a delegation whose failure cannot be classified is `BLOCKED`, not retried. | **[KERNEL]** |
| **D14** | **Delegation is reversible and auditable after the fact; the contract is versioned.** The record carries contract version, prompt/tool-set version, model snapshot, authority grant, budget consumed, evidence ids, and the verdict. | Anthropic *rainbow deployments*; A2A's mandatory `A2A-Version`. **[NEW]** |
| **D15** | **The child's claim enters the epistemic ladder only after verification, and a supervisor may not promote a child's claim past the child's own authority.** | **[KERNEL]** — the ladder and the authority/validity model |
| **D16** | **Cross-boundary context filtering is measured, not assumed protective.** Support *modification*, not only allow/deny. | SWARM (PARTLY VERIFIED, one study, 96 runs) — the actionable takeaway only. **[NEW]** |
| **D17** | **A delegation contract is not a network protocol.** MCP and A2A carry a delegation; **neither enforces one** — depth, budget and verification must be enforced inside the runtime. | Verified by inspection of MCP `2026-07-28` and A2A `1.0`. **[NEW]** |

### 4.1 The delegation decision rule (D9, expanded)

This is the most decision-relevant published result in the survey, and it
turns "should we delegate?" from taste into a **measurable,
task-property-conditioned rule**.

*Towards a Science of Scaling Agent Systems* (arXiv 2512.08296) ran **180
controlled configurations** — 5 architectures × 3 model families × 4
agentic benchmarks — with identical prompts, tools and **matched token
budgets**.

| Effect | Measured |
|---|---|
| **Error amplification — Independent** (no orchestrator bottleneck) | **17.2×** |
| **Error amplification — Centralized** (validation bottleneck) | **4.4×** — *"centralized coordination **contains** error propagation"* |
| Centralized on parallelizable tasks (financial reasoning) | **+80.8 %** |
| Decentralized on dynamic web navigation | **+9.2 %** vs **+0.2 %** for centralized |
| **Every multi-agent variant on sequential reasoning** | **−39 % to −70 %** — *"coordination overhead fragments reasoning capacity under fixed computational budgets"* |
| Capability saturation | **β = −0.404, p < 0.001** — negative returns once the single-agent baseline exceeds **~45 %** |
| Tool-coordination trade-off | **β = −0.267, p < 0.001** — tool-heavy tasks pay a disproportionate coordination tax |
| Coordination overhead vs single-agent | SAS 0 %, Independent 58 %, Decentralized 263 %, Centralized 285 %, Hybrid 515 % |
| Predictive model from coordination metrics | cross-validated **R² = 0.524** (v2 PDF) / **0.373** (arXiv HTML) — **pin the version before quoting** |
| Optimal-strategy prediction accuracy | **87 %** of held-out configurations |

> ⚠️ **Version caveat:** the headline R² and the benchmark count **differ
> between paper versions** — the v2 PDF (2025-12-17) reports four benchmarks
> and R² = 0.524; the arXiv HTML (v3, 2026-04-08) reports six and 0.373.
> **Do not quote a single R² without pinning the version.** The qualitative
> findings (17.2× vs 4.4×, +80.8 %, −39–70 %, ~45 % saturation) are stated
> consistently across versions and are the safe claims.

**The rule, as a gate:**

```
DELEGATE only if ALL of:
  task is parallelizable            (not sequential reasoning)
  AND singleAgentBaseline < 0.45    (else negative returns, β=−0.404)
  AND task is not tool-heavy under a fixed budget   (β=−0.267)
  AND the coordination overhead is modelled in the budget   (SAS 0 % → Hybrid 515 %)

PREFER centralized when verification-sensitive   (4.4× vs 17.2× error amplification)
PREFER decentralized for high-entropy parallel exploration   (+9.2 % vs +0.2 %)

TOPOLOGY IS A DECISION, AND THE DECISION IS RECORDED — with the measured
coordinates that produced it.
```

**And the cost, stated plainly:** Anthropic measures multi-agent at **~15×
the token cost** of chat and **~4×** for agents. LLMCompiler's parallel
execution bought **3.7× latency** and **6.7× cost savings** against ReAct.
The overhead is real and it is priced in the budget, not assumed away.

### 4.2 The three orchestration archetypes — and why the D9 gate says what it says

A survey of the fourteen production agent SDKs converges on **three
orchestration archetypes**, and their measured profiles are what the D9 gate
is built on. The archetypes are not ranked; they are **matched to the
workload**.

| Archetype | Representative frameworks | State persistence | Failure recovery | Token and latency profile | Best-fit workload |
|---|---|---|---|---|---|
| **Stateful state-machine graphs** | LangGraph, Microsoft Agent Framework | Centralized, typed, persistent state schemas with a relational backing | **Deterministic node re-execution from a graph checkpoint** | **High token efficiency; low latency** | Regulated workflows, explicit software pipelines, audited automation |
| **Hierarchical role-based crews** | CrewAI, MetaGPT | Contextually appended prompt histories and output buffers | Dynamic re-prompting and supervisor escalation | **Variable token overhead; higher latency** from multi-turn dialogue | Rapid prototyping, content production, exploratory research |
| **Message-passing actor models** | AgentScope, AutoGen v0.4 | Distributed memory stores per actor; event logs | Actor isolation, message retry queues, stateful supervisors | Optimised for parallel network calls; **low per-node latency** | Distributed multi-agent systems, high-concurrency enterprise networks |

**The mapping onto our D9 gate, and it is not decorative:**

| Archetype | When the SDK may use it | Why |
|---|---|---|
| **State-machine graph** | **The default.** The decomposition is a typed DAG, the state is persistent, the checkpoint is the recovery mechanism | Highest token efficiency, lowest latency, and the only archetype with *deterministic* recovery |
| **Hierarchical crew** | **Only for exploratory work with no external verifier**, and only at a bounded budget | Variable token overhead and higher latency, and its recovery is *re-prompting* — which is not recovery |
| **Actor model** | **Only for high-concurrency, high-entropy parallel exploration**, and only where the per-node latency dominates | Its advantage is parallelism, which the D9 gate already restricts to parallelizable tasks |

**The rule that falls out, and it sharpens D9:**

> **The archetype is a consequence of the task's shape, never a default.**
> A state-machine graph is what you get when the task is auditable. A crew is
> what you get when it is not. Choosing the archetype by preference — which
> is what "use LangGraph" or "use CrewAI" as a default means — is how a
> system ends up paying crew latency on a regulated workflow.

**And the failure-mode pairing, which is the part the survey makes
uncomfortable:**

- A **state-machine graph** with an *unbounded* loop is the classic
  infinite-retry failure. Our `maxIterations` equivalent must therefore be
  **finite by default**, and our D9 gate's `maxHandoffs` is the sharper
  version of it.
- A **crew** with no external verifier has *no* signal to optimise, so its
  quality metric is a model opinion. This is our A4 assumption
  ("ground truth comes from an external deterministic verifier") stated as
  an archetype-level requirement.
- An **actor model** with a shared mutable state is a race. Our
  single-writer log and the append-only reducer are the answer — and the
  kernel's refusal of two authoritative writers is the archetype-correct
  decision.

### 4.3 The task envelope — the one wire format every tier speaks

The four production failure classes — **memory exhaustion, infinite loop,
parse error, state poison** — need a wire format that carries a *bounded*
request and a *classified* response.

> **This is a PROPOSAL, not existing code.** Nothing named here exists in
> `core/`, `cli/`, `packages/`, `adapters/` or `plugins/` today. It is
deliberately small enough to be implementable in every tier including a
browser Worker.

```ts
interface TaskConstraints { timeoutMs: number; maxMemoryBytes: number }

interface TaskRequestEnvelope {
  id: string;
  timestamp: number;
  plugin: string;
  action: string;
  payload: Record<string, unknown>;
  constraints: TaskConstraints;
}

type TaskErrorCode =
  | 'TASK_TIMEOUT' | 'WORKER_OOM' | 'EXECUTION_ERROR'
  | 'PARSE_ERROR' | 'STATE_DEADLOCK';

interface TaskResponseEnvelope {
  id: string;
  status: 'COMPLETED' | 'FAILED' | 'TIMED_OUT' | 'CANCELLED';
  output: unknown;
  error?: { code: TaskErrorCode; message: string; stackTrace?: string };
  metrics: { wallTimeMs: number; cpuTimeMs: number; peakMemoryBytes: number };
}
```

**Four rules that make it more than a data shape:**

| Rule | Why |
|---|---|
| **`constraints` is part of the request, not a server-side policy** | The bound travels with the work. A caller that omits it gets the default, and the default is enforced at the *worker*, where it can actually stop something |
| **`metrics.peakMemoryBytes` is `MEASURED`, or it is absent** | The kernel's rule: an unknown quantity is **absent, never zero**. A missing memory reading must not make an execution look free |
| **A `status` is never inferred from an exception** | `TIMED_OUT` comes from the abort signal, `FAILED` from a classified error, `CANCELLED` from an explicit cancel. A timeout is a **failure, not a success** — the repo's existing rule |
| **The error code is the classification; the message is the prose** | The code is what the ledger records and what the policy engine branches on. The message is for a human |

**And the four failure classes, each with its named mitigation:**

| Failure | The mechanism that stops it |
|---|---|
| **OOM in the worker heap** | A **memory sentinel loop**: the runner checks the heap before dispatch and terminates the worker safely, freeing the allocation, and emitting a `WORKER_OOM` envelope — not a crash and not a silent truncation |
| **An infinite synchronous loop in generated code** | A **preemptive abort** with a *secondary* hard timer: `AbortSignal.timeout(ms)` for cooperative cancellation, plus a `worker.terminate()` backstop for code that never yields. **Two mechanisms, because one is not enough** |
| **A syntax error during a live edit** | A **fault-tolerant concrete syntax tree**: a parse failure becomes a *localised* `ERROR` node, and the valid adjacent syntax trees are unaffected. The parse of one broken region does not invalidate the file |
| **A cyclic reasoning loop** | A **cycle-count reducer and deduplication gate**: the kernel's checkpointer detects a repeated state signature and routes to a fallback node after N repetitions. This is the checkpointer half of the "detect, don't assume" rule |

**The last one is a hard requirement on the kernel, and it is why the
`maxIterations` default must not be unbounded.** The state machine the SDK
runs on is the kernel's; a cyclic frontier is detectable *in the
checkpointer*, not by the model.

### 4.4 The platform API matrix — the portability contract

The SDK claims to run in a browser, Node, Deno, Bun, and an edge worker.
That claim is only meaningful if the **API surface** is named, because
"works everywhere" is otherwise unfalsifiable.

| API | Used for | Support | Bounded fallback |
|---|---|---|---|
| **`AbortController` / `AbortSignal`** | Preemptive task cancellation | Universal (Node, Bun, Deno, browsers) | Native signal pass-through to `fetch` and timers |
| **`structuredClone`** | Passing IPC payload envelopes safely by value | Universal | JSON serialise / deserialise |
| **Web Streams API** | Streaming stdout/stderr from task workers | Universal | In-memory chunk-array stream buffering |
| **`crypto.subtle`** | SHA-256 state hashing and token-signature verification | Universal | A pure-JS WebAssembly cryptographic fallback |
| **WebAssembly (Tree-Sitter)** | Language-agnostic code analysis and CST indexing | Universal, given a WASM runtime | A lexical regex parse-tree extraction fallback |

**And the honest boundary:** the WASM tier's gaps are **declared, not
discovered**. Layout detection, GPU acceleration, threading and LLM-based
structured extraction are **not available in the WASM build** — so they are
declared absent in the capability object, and a task that needs them is
escalated to the Node tier **by the capability probe, not by a crash**.

**The one thing this matrix does not do:** it does not make the *edge worker*
case safe. A durable-execution engine cannot run there — there is no
long-lived process, no guaranteed wall-clock, and no transactional state
store. The SDK's answer is that **the kernel's log is the durable substrate**
and every engine above is a **server-tier adapter only**.

---

---

## 5. The MVP ladder

**Nine MVPs.** Each has a module decomposition, an exit gate, and the
scenarios that prove it. The dependency DAG is in §6.

| MVP | Name | Lands in | Durations `[GUESS]` |
|---|---|---|---|
| **1** | **The Zero-Compute Digest** | SDK repo | 6 wk |
| **2** | **The Graph Kernel** | **This repo** (the kernel) | 4 wk |
| **3** | **The Persistent Orchestrator** | SDK repo | 6 wk |
| **4** | **The Token Economist** | SDK repo | 5 wk |
| **5** | **The Tool Surface** | SDK repo | 6 wk |
| **6** | **The Telemetry Lens** | SDK repo | 3 wk |
| **7** | **The Promotion System** | SDK repo | 5 wk |
| **8** | **The Certification Harness** | SDK repo | 4 wk |
| **9** | **The Adaptive Loop** | SDK repo | 6 wk |

> **The durations are `[GUESS]`.** They are one-focused-engineer estimates
> for a system that has not been built. They become **measured** after MVP 1
> ships and real velocity is observed — and the roadmap re-estimates then.
> This mirrors the discipline in `optimization.md` §3.4: a threshold labelled
> as a guess, with the condition that would turn it into a measurement.

### 5.1 MVP 1 — The Zero-Compute Digest

**Goal (G1, G2, G3):** a document becomes a structured, evidence-tiered
intent with **zero server compute**.

| Module | Tasks | Acceptance criterion |
|---|---|---|
| **1.1 Environment probe** | Detect runtime (browser / Node / Deno / Bun / edge / serverless / container / VPS), OS, architecture, memory ceiling, concurrency budget. Probe WASM, WebGPU, WebNN, storage (OPFS / IndexedDB / native), network reachability. Probe available parsers and their tier | A `Capabilities` object reports every probe with a **measured** value and a `knownBy` (`MEASURED` / `DERIVED` / `ESTIMATED` / `ATTESTED` / `UNKNOWN`). An unsupported format produces a structured `UnsupportedFormatError`, never a crash. The probe result is **recorded in the log** before any work starts |
| **1.2 Client-first parser** | Wire `unpdf` (PDF) and `@kreuzberg/wasm@4.x` (Office/HTML/CSV/JSON/XML) behind a `DocumentParser` interface. Apply EdgeParse's **hidden-text, off-page, tiny-text and invisible-OCG stripping** as default filters. Honour unpdf's own limits: `maxImageSize` capped, page count checked **before** extraction, every parse raced against a deadline | A 50-page PDF parses in a browser Worker with **zero server calls**. The stable head is byte-identical across runs. The parser tier is recorded per artefact. WASM-only gaps (no layout detection, no GPU, single-thread, no LLM extraction) are **declared in the capability object**, not discovered at runtime |
| **1.3 Structure tree** | Structure-aware chunking: headings, tables, lists, code blocks, page and section boundaries. **Never split a table row or a code block mid-line.** Build a hierarchy: leaf chunks → section summaries → document summary, each node carrying source spans | Chunks never split a table row or code block. The tree preserves a link from every summary node to its source spans. A one-paragraph edit re-summarises **at most log₂(n)** nodes |
| **1.4 Tier projection** | Project the kernel's four evidence tiers (`VERIFIED` / `UNCITED` / `BROKEN` / `UNSUPPORTED`) over `EvidenceSchema` — `authority` × `validity` × citation resolvability × producer lineage. Implement the optional entailment hook as an **interface**, not a dependency | A 50-claim fixture set classifies correctly, including invented quotes, expired receipts, and ungrounded claims. A claim citing its own producer is **automatically demoted to `UNCITED`**. The tier is **never stored** — it is computed, so it cannot drift |
| **1.5 Error taxonomy** | The nine error classes with their fallbacks: `UnsupportedFormatError`, `ParseError`, `CompressionRegression`, `CacheMissCostExplosion`, `SchemaValidationError`, `GroundingFailure`, `BudgetExceededError`, `TimeoutError`, `ToolFailure`. Each has a bound and a terminal condition | Every class is reachable in a test, and each produces the declared fallback — never a silent success. `BROKEN` **never** flows through as accepted |
| **1.6 Simulation harness v0** | The replay harness, the golden-align corpus (G-CORP, G-ADV, G-EDGE, G-LOCALE), the 14-environment matrix, and scenarios **S-01 … S-05, S-08, S-10, S-13, S-14, S-18, S-20** | The harness runs the same scenario in E1–E14 and reports **skip counts per environment** with reasons. A scenario that cannot run is a recorded skip, never a silent drop |

**Exit gate:** `pnpm build` clean; the full SDK test suite green; **S-01 …
S-05, S-08, S-10, S-13, S-14, S-18, S-20** pass in E1–E14; the golden-align
corpus is hash-stable across 30 consecutive runs in every environment.

### 5.2 MVP 2 — The Graph Kernel *(lands in this repository)*

**Goal (G4):** the graph contract gains its engine, and milestone M5 closes.

| Module | Tasks | Acceptance criterion |
|---|---|---|
| **2.1 Derivation** — **BUILT** | `event log → GraphSnapshot`: materialise nodes and edges from recorded events, deterministically, from the log bytes alone | Byte-identical output for identical input. The derivation is a **pure function** of the log. **Shipped as `deriveGraph()`** — `packages/worker-runtime/src/graph/derive.ts`. It derives the **knowledge** graph: `EVIDENCE`, `DECISION`, `EXPERIENCE` and `WORK_ITEM` nodes, with the `SUPPORTS` / `LEARNED_FROM` / `DEPENDS_ON` edges those records imply. It does **not** invent a node for evidence the log never recorded, and it does not derive `FILE`/`SYMBOL`/`TEST`/`CONFIG` (those come from the source tree, in modules 2.6–2.7) or `CLAIM` (no record type, no event) — a derivation that invented a fact would be inferring, and the kernel records and verifies |
| **2.2 Traversal** — **BUILT** | Reachability, topological order, multi-hop walk, cycle detection, disconnected-component handling | **M5's acceptance criteria, verbatim**: deterministic traversal across branching, multi-hop, cycles and disconnected components; byte-identical output for identical input. Cycles are detected, not followed infinitely. **Shipped in `packages/worker-runtime/src/graph/`** — `indexGraph`, `reachable`, `components`, `findCycles`, `topologicalOrder`, with an anomaly report for malformed graphs and no clock, no I/O and no randomness |
| **2.3 Invalidation cascade** — **BUILT** | Compute `InvalidationResultSchema`: `affectedNodes`, `staleDecisions`, `reopenedWork`, `requiresReverification` — by walking the graph from the invalidated node | Invalidating E1 flips the dependent claim to `INVALIDATED`, the dependent decision to `STALE`, and the dependent work contract to `REOPENED`, and **leaves unrelated decisions untouched. **Shipped as `computeInvalidation()`** — with the node→record resolution convention the contracts' two id spaces needed, and with the `SUPERSEDES` edge explicitly excluded from the cascade |
| **2.4 The re-orient trigger** | The missing policy: when an invalidation lands, decide **abandon / re-plan / escalate** | A **re-orient policy** is specified and tested — this is the piece the literature does not have: the kernel has the trigger and the substrate but no policy. The decision is **recorded**, not inferred |
| **2.5 The repository as its own graph** — **BUILT** | Analyse AnyPlugin's own dependency graph as the first real corpus: branching, multi-hop, cycles, disconnected components | The expected output is a reviewed golden artefact. A change to a source file moves exactly the expected nodes. **Shipped as `repo-graph.test.ts`** — the corpus is built from the workspace's real `package.json` files, and it proves the workspace dependency graph is acyclic, that the kernel is a leaf, and that the multi-hop paths are the ones the architecture states |
| **2.6 The AST kernel** | A fault-tolerant concrete-syntax-tree engine (Web-Tree-Sitter, WASM) producing a **symbol graph**: `{ symbol_id, file_path, kind, name, range{start,end}, has_syntax_errors }`. Incremental re-parsing; a parse failure becomes a **localised `ERROR` node** and leaves the valid adjacent trees intact | A broken region does not invalidate the file. The symbol graph is a **projection of the source**, rebuildable and byte-identical for identical input. The lexical-regex fallback is used when WASM is unavailable, and the **two paths are compared** so a divergence is a test failure, not a surprise |
| **2.7 The code graph** | Join the symbol graph to the dependency graph: a `GraphNode` of kind `symbol` carries its `kind` (`function`/`class`/`interface`/`method`/`variable`/`error`) and its range; edges use the kernel's existing `EDGE_KINDS` (`IMPORTS`, `MODIFIES`, `TESTS`, `SUPPORTS`, `DEPENDS_ON`, `DERIVED_FROM`, `LEARNED_FROM`, `INVALIDATES`, `SUPERSEDES`) | A change to a function's *implementation* does not move the graph; a change to its *signature* does. `has_syntax_errors: true` is a **first-class node kind** (`error`), not a warning — the graph represents brokenness rather than hiding it |

**Exit gate:** M5's acceptance criteria pass; the invalidation cascade test
passes; **no contract version bump is required** (traversal is a pure function
over an existing contract); `core/src/boundaries/package-boundary.test.ts`
still passes; the kernel still imports nothing workspace-internal; the AST
kernel and the lexical fallback **agree** on the golden corpus.

**Where the gate stands.** The first four clauses are **met** —
`packages/worker-runtime/src/graph/graph.test.ts` (24 tests) and
`repo-graph.test.ts` (8 tests). The last clause waits on modules 2.1, 2.4, 2.6
and 2.7. **M5 is COMPLETE.** **M6 is COMPLETE** — the transitions and the
restore step shipped as `packages/worker-runtime/src/graph/reopen.ts`
(`planInvalidationEvents()`, `planRestoration()`) with the decision
projection in `packages/worker-runtime/src/log/decisions.ts`; decision
**D-053**.

### 5.3 MVP 3 — The Persistent Orchestrator

**Goal (G3, G6):** a durable multi-agent run that resumes correctly and
cannot run away.

| Module | Tasks | Acceptance criterion |
|---|---|---|
| **3.1 Orchestrator** | Intake → frame → constrain → decompose → evidence plan → execute → verify → integrate → learn. The decomposition is a **typed DAG** with per-node schemas | An invalid plan is rejected before execution. Every leaf has a `doneWhen`. The decomposition passes the MECE and independence checks |
| **3.2 Specialists** | `Parser`, `Compressor`, `Extractor`, `Validator`, `Synthesizer`, `Telemetry` — each with typed input/output schemas and a non-blocking error boundary | A failing tool produces a structured error event and the loop continues. A specialist failing **twice** on the same task escalates with its failure history. **No specialist loops autonomously** |
| **3.3 Both state stores** | The kernel's log is the system of record; SQLite (WAL) is the derived projection and materialised checkpoint store. Every SQLite row carries the log sequence it was derived from | A `doctor` check compares SQLite's max sequence to the log head; a difference is a `BLOCKED` finding with a rebuild command. A SQLite row that is not derivable from the log is a **defect** |
| **3.4 Checkpoints and resume** | Checkpoint on a settled step; resume from the last checkpoint. `Continue-As-New` semantics for unbounded work | A `kill -9` mid-run resumes from the last checkpoint **without duplicating completed work**, verified by the recorded artefacts' hashes |
| **3.5 The delegation contract** | D1–D17 enforced: typed requests, digest context, hard caps, structural loop detection, non-inheriting authority, typed result envelopes, external verification, pass^k measurement, topology gating, revocable budgets, server-minted handles, versioned records, authority non-promotion | Handoff depth **never exceeds the cap**. A pair-level cycle is detected and **denied, not retried**. A child returning prose without an envelope is a **FAIL of the delegation** |
| **3.6 The delegation decision** | The D9 gate, recorded: parallelizable? baseline < 0.45? not tool-heavy? overhead modelled? which topology, and why | Every delegation record carries the measured coordinates that produced the decision. A delegation that violates the gate is **refused**, with the reason |
| **3.7 The metacognitive monitor** | **Bounded curiosity.** The monitor watches for three conditions only: *stuck* (the state hash has not advanced), *looping* (a repeated frontier), and *drifting* (the goal invariant is diverging). On a trip it may **zoom in** (open a sub-episode with its own budget) or **zoom out** (escalate to the parent). It may **never** open a new capability, widen a scope, or explore for its own sake | The monitor's three conditions are **mechanically detected**, not judged. A zoom-in opens a sub-episode with a **declared budget** and a **declared question** — an exploration with no question attached is refused. The monitor can act only within the never-automated list's bounds. A trip is recorded as an event, and the recovery is recorded separately |
| **3.8 Time management — zoom in and zoom out** | Two timescales with an explicit relationship: the **tick** (one decision, one bounded context projection, ≤ a declared token budget) and the **horizon** (the whole contract, checkpointed). Zoom-in = descend into a sub-goal's subgraph with its own budget. Zoom-out = return to the parent with a result | The tick budget is **enforced**; the horizon budget is **checkpointed**. A tick that exceeds its budget produces `BudgetExceededError` with a receipt, never a silent truncation. The monitor's "state progress velocity" is the zoom-out signal: **no progress across N ticks ⇒ zoom out** |

### 5.3.1 The metacognitive design, and the one finding that makes it work

The literature is large, mostly preprint, and mostly about **elicitation**
rather than **action**. The sharpest cross-paper finding is that **accuracy
rank and metacognitive-sensitivity rank are largely inverted** — being good at
the task does not imply being good at knowing you are failing. Almost all
published work reads the model's **self-reported** confidence, which is a
known-weak channel.

**This kernel already has a better channel.** The verification engine emits
`PASS`/`FAIL`/`BLOCKED` against independent criteria — a *behavioural*
metacognitive signal that does not come from the model's own tokens. The
monitor in module 3.7 reads that signal plus the event log's progress, and
**never** asks the model how sure it is.

The design debt in the literature is exactly why this is worth doing:

| Published system | The problem it creates | Our answer |
|---|---|---|
| **STOP** (COLM'24) | A self-improving scaffolding program; the authors' own safety contribution is measuring *"the frequency with which the generated code **bypasses a sandbox**"* | The never-automated list forbids self-modifying code; the optimiser runs out of band behind the safe-adaptation envelope |
| **ADAS / Meta Agent Search** | A meta-agent writes new agents **in code**; the authors' caveat is *"Provided we develop it safely"* | The envelope's `mustNotModify` list makes the attempt a **hard stop**, not a caveat |
| **CoALA** (TMLR'24) | Names the risk: writing to procedural memory *"is significantly riskier… as it can easily introduce bugs or allow an agent to subvert their designers' intentions"* | The learning loop's promotion requires a rung transition with its own evidence — never a direct write to policy |

*Sources:* arXiv 2309.02427 · arXiv 2310.02304 · arXiv 2408.08435 ·
arXiv 2604.15702 · arXiv 2607.11881 — all VERIFIED, accessed 2026-10-20.

**And the SOAR insight, which is the mechanism:** every classic cognitive
architecture independently converged on the **impasse → substate**
transition. SOAR's manual: *"In response to an impasse, the Soar architecture
creates a substate in which operators can be selected and applied to generate
or deliberately retrieve the knowledge that was not directly available."*

> **This kernel's `BLOCKED` verdict is exactly an impasse, and it should not
> be terminal.** It should open a nested, budgeted, evidence-producing
> sub-episode — a zoom-in — whose resolution is recorded in the log as a
> derived node, **never** as a new authority tier. The literature does not
> make this mapping; it would be first.

### 5.3.2 Bounded curiosity, stated precisely

Curiosity is a budgeted search for information that would **change a
decision**. It is not exploration for its own sake.

| Rule | Enforced by |
|---|---|
| A curiosity action must name the **question** it would answer | The zoom-in requires a `declaredQuestion` |
| A curiosity action must name the **decision** that question would change | Otherwise the action is refused — an answer nobody needed is not curiosity |
| A curiosity action has a **budget** | It is a sub-episode with its own cap |
| A curiosity action may **not** create a capability, widen a scope, or raise a budget | The never-automated list |
| A curiosity action's **outcome** is an evidence record, not a belief | It enters the ladder at `OBSERVATION` and may only be promoted through the normal gates |
| Curiosity **cannot** run in the tick's own context | It is always a zoom-in, i.e. a delegated sub-episode with its own context budget |

**Pattern matching is what makes it cheap:** the monitor does not *ask* what
to explore. It matches the recorded **failure signature** — the failure
class, the frontier hash, the goal-divergence vector — against a **catalogue
of known signatures**, each of which names a **question** and a **budget**.
The catalogue is a versioned artefact, and an unmatched signature escalates
rather than explores.

This is the **pattern-matching** half, and it is exactly how the failure
catalogues in `docs/FAILURE-MODES.md` and the kernel's
`CONTRACT_FAILURE_CLASSES` should be used: not as documentation, but as a
**lookup table from failure signature to a bounded diagnostic question**.

**Exit gate:** S-05, S-11, S-12, S-28 pass in E2–E5 and E11–E14; the
`kill -9` resume test passes; the SQLite drift check passes; the delegation
gate is enforced and refuses a violating delegation in a test.

### 5.4 MVP 4 — The Token Economist

**Goal (G5):** every token saved is measured, and no optimisation silently
changes a result.

| Module | Tasks | Acceptance criterion |
|---|---|---|
| **4.1 Summary tree** | Hierarchical summarisation fused with the chunker: leaf → section → document, with bidirectional links and source spans | A query reads **at most 3 tree levels** before answering. The token budget per level and per query is capped; exceeding it produces `BudgetExceededError` |
| **4.2 Compression** | The **built** evaluator-head compression (D-044): embed-score → keep top-k → drop the rest, then a local verifier decides whether the compressed context still answers the question | Compression achieves a **measured** reduction on the eval set while the quality gate holds. A regression **disables compression for that domain only** and emits `CompressionRegression`. `compression_ratio`, `evidence_recall`, `verifier_pass` are emitted as span attributes |
| **4.3 Provider economics** | Per-provider cache and batch handling with the **corrected** multipliers: Anthropic 0.1× read / 1.25×–2× write; OpenAI 0.1× (0.05× `gpt-6.1-sol`) read and **1.25× write for GPT-5.6+**; Gemini implicit-first with **per-hour** storage; DeepSeek **1–3.3 %** hit price; Kimi 0.1× on K3 | Every policy reports **measured** hit rate, write cost and re-prefill cost, and the **break-even status** (21.74 % at 5 min; 52.63 % at 1 h — a **derivation**, labelled as one). Below break-even the monitor **recommends disabling** |
| **4.4 The determinism guarantee** | The recorded call log is authoritative; replay returns the recorded result without consulting the cache | A replay test produces **identical outputs with caching on and off**. A cache bug is a **cost** bug, never a correctness bug — except in the write path, which is digest-keyed and logged |
| **4.5 Context-rot regression** | Measure the focused projection against the full history, on the suite's own corpus | The focused projection **beats** the full history on the eval set, or the projection is wrong. A regression fails the build. Structural coherence is **not** assumed to help — Chroma measured the opposite across 18 models |

**Exit gate:** S-09, S-20, S-21, S-22, S-28 pass in E1–E3 and E8–E14; the
cache-on/cache-off replay is byte-identical; the break-even monitor fires in
the low-hit-rate scenario.

### 5.5 MVP 5 — The Tool Surface

**Goal (G7):** 18 tools, two tiers, eight region bundles, one egress
chokepoint.

| Module | Tasks | Acceptance criterion |
|---|---|---|
| **5.1 Tool registry** | The 18 tools with a **required tier field** in each schema. `local` and `network` are the only values | The model, the policy engine and the auditor all see the tier. A tool cannot be registered without one |
| **5.2 The 15 `local` tools** | `doc.parse`, `ocr.page`, `calc.expr`, `units.convert`, `geo.resolve`, `tz.now/convert`, `locale.format`, `currency.round`, `holiday.calendar`, `tax.rate/compute`, `translate.text`, `transliterate`, `entities.extract`, `address/contact.normalize`, `code.run` | The **entire local tier works with the network disabled**. `currency.round` respects the ISO 4217 exponent (JPY 0, KWD 3). `holiday.calendar` handles China's **调休 make-up workdays**. Every local tool is content-addressable over its inputs **and** its versioned dataset |
| **5.3 The 3 `network` tools** | `web.fetch_cited`, `web.search`, `fx.rate` — the first two returning a provenance bundle: final URL after redirects, retrieved-at, content sha256, quoted span + offset, HTTP status, content-type | All three are **disabled by default** for regulated tenants. The first two produce a provenance bundle. None can create a capability. **15 + 3 = 18** |
| **5.4 MCP servers** | Third-party MCP servers wired in, restricted to the `network` tier, with an explicit per-tenant grant | A third-party MCP server **cannot** be promoted to `local` by configuration and can never confer `AUTHORITATIVE` authority. **Token passthrough is forbidden**; handles are server-minted, random, expiring and bound to the authenticated principal |
| **5.5 Region bundles** | Eight bundles — IN, SG, AE, SA, CN, BR, EU/EEA+UK, US — each with `locales`, `currency` (+ minor units), `timezone`, `taxRates` (+ `effectiveFrom`), `holidays` (+ shift rules), `complianceProfile`, `sources[]` | The compliance profile **changes which tools may run**. Every bundled dataset has a version, an effective date and a citation. **Brazil and US-health do not ship until their regulatory claims are re-verified** |
| **5.6 The egress chokepoint** | One function: `entities.extract` → policy check → legal-basis record → event → return. **No second path** | A call with no derivable legal basis is **refused and recorded** — a `BLOCKED`, never a default-allow. Nothing reaches the network without passing it |
| **5.7 Browser automation** | A bounded browser driver — a `network`-tier tool with its own session, its own **domain allowlist**, and its own budget. Every navigation is an event; every page fetch passes the egress chokepoint; a page's content is **data**, never instructions | The browser is **not** in the default surface. A session has a **declared domain allowlist** and a **declared budget** (pages, bytes, wall-clock). A page that instructs the agent to do something is **quoted and cited, never obeyed**. Re-fetching the same URL inside the session hits the content-addressed cache. The driver runs in a **sandbox with no ambient authority** in the browser tier (WASI) and in a process with an env allowlist in the Node tier |
| **5.8 The local semantic index** | `sqlite-vec` over the same SQLite database — **not a second database**. Vectors are a **projection** of the event log, exactly as the SQLite projection is. The embedding model is the local one (EmbeddingGemma 2, **fp32/fp16 on WebGPU** — never the silently-wrong q4/q8 path) | The index is **rebuildable** from the log, and its rebuild is a fold. A stale vector is detected by the same sequence-number mechanism as a stale row. **The startup cosine-sanity assertion runs** — the known `transformers.js` #1728 defect makes quantised WebGPU embeddings silently orthogonal, and that is worse than no index at all |

**Exit gate:** S-13, S-16, S-17, S-19, S-25 pass in E1–E5 and E11–E14;
the local tier passes with the network disabled; the ISO 4217 rounding test
passes; the egress scrub test passes; the browser session refuses a
non-allowlisted domain and refuses to obey an instruction found in a page.

### 5.6 MVP 6 — The Telemetry Lens

**Goal:** know where the time, tokens and money went — and where it is going
wrong.

| Module | Tasks | Acceptance criterion |
|---|---|---|
| **6.1 Span vocabulary** | OTel `gen_ai.*` where it exists (`plan`, `invoke_agent`, `invoke_workflow`, `execute_tool`, `retrieval`, `search_memory`); a **documented private namespace** for the five it does not: `agent.reasoning`, `agent.guardrail`, `agent.delegation`, `agent.memory`, `agent.state` | The nine-kind metamodel is **ours**, cited to AgentTelemetry (AIware 2026, DOI `10.1145/3805760.3814931`) with the **0.612 measured / 1.000 upper-bound** distinction preserved. The conventions repo is **pinned to a commit** |
| **6.2 Per-stage metrics** | p50/p95 latency, tokens in/out, cache hit rate, compression ratio, cost — **per stage** | The bottleneck report identifies the **top 3 stages by cost and by latency**. Every ratio is published **with its coverage** |
| **6.3 Domain success rates** | Success bucketed by document type, task type, and language | A domain below threshold is flagged **with a recommendation** to decompose or escalate. `BLOCKED` and `FAILED` are never merged |
| **6.4 Bounded telemetry** | Sampling, redaction, cardinality caps, PII scrubbing | No unbounded label explosion. A cardinality cap is **enforced**, not documented. Secrets never appear in an attribute |
| **6.5 The projected monitor** | The monitor reads a **projected graph**, not the raw transcript | A monitor reading the projected graph does **not** overflow its context where a monitor reading the raw transcript does. S-27 proves the difference |

**Exit gate:** S-27 passes in E1–E14; the bottleneck report identifies the top
three; the cardinality cap is enforced in a test; no secret appears in any
attribute.

### 5.7 MVP 7 — The Promotion System

**Goal:** the system improves itself without ever being the thing that
decides it is safe.

| Module | Tasks | Acceptance criterion |
|---|---|---|
| **7.1 Replay and shadow** | Replay a recorded trace through a new policy with **no live model calls**; shadow a candidate on live traffic with the candidate's side-effecting decisions **scored, never executed** | Shadow results are **never served**. The arm assignment is a deterministic hash bucket, so a ramp step does not reshuffle populations |
| **7.2 The twelve gates** | G1–G12 from `optimization.md` §3.4, unchanged | A candidate passing 11 of 12 gates is **not promoted**. A gate computed from unobserved inputs is `BLOCKED`, never `PASS` |
| **7.3 The safe-adaptation envelope** | The machine-checked declaration of what the optimiser may modify | Anything in `mustNotModify` that the optimiser attempts is a **hard stop**, recorded as an anomaly. The optimiser's output takes effect only through the gates and, where required, a human approval **naming the `contentHash`** |
| **7.4 Ramp and rollback** | SHADOW → CANARY 1 % → PARTIAL 10 % → HALF 50 % → FULL 100 %, with soaks; seven automatic rollback triggers; **rollback before diagnosis** | A rollback is followed by a **hash re-verification**; a failed verification **halts** the worker (fail closed) and pages. Rolling back an already-rolled-back policy is a no-op and emits nothing |
| **7.5 Flapping** | The four detectors, the ±1.0pp hysteresis band, quarantine by `contentHash`, and **human-only unpin** | A pinned candidate is **not re-proposed** by the extractor, excluded from shadow, and unpromotable. The pin is visible with its reason |
| **7.6 The never-automated list** | Thirteen decisions that always require a human | The list is a **constant in code**, not configuration. An operator cannot configure the unsafe combination |

**Exit gate:** S-23, S-24, S-04 pass in E2–E5 and E11–E14; a candidate
failing one gate is not promoted; the envelope hard-stop fires in a test;
rollback re-verifies its hashes.

### 5.8 MVP 8 — The Certification Harness

**Goal:** the whole thing is provable in fourteen environments.

| Module | Tasks | Acceptance criterion |
|---|---|---|
| **8.1 The full scenario set** | All **29** scenarios - the twenty-eight in the catalogue plus **S-29 (cross-session pass^k over days)**; **S-15 (injection persistence)** and **S-29** are the two nobody has published — the two nobody has built | Both new scenarios are **specified before** the agents they test. A benchmark written after the implementation is a benchmark written to pass |
| **8.2 The environment matrix** | E1–E14, automated | The matrix runs in CI on every commit. A scenario that cannot run in an environment is a **recorded skip with a reason**, and the report states skip counts per environment |
| **8.3 The golden-align corpus** | G-CORP, G-ADV, G-EDGE, G-LOCALE, G-CORPUS | Every deterministic artefact's content hash is **identical** across 14 environments and 30 consecutive runs. **A golden file is never edited to make a test pass** — a changed golden is a reviewed artefact change with its own diff |
| **8.4 The cross-session pass^k harness** | 20-step tasks, k = 1…8, over simulated days, with a **branched-rollout-with-control-forks** methodology for policy evaluation | The suite reports **pass^k**, not pass@1, and declares which of the three offline-evaluation biases applies |
| **8.5 The injection-persistence harness** | A poison planted on day 1, checked for absence on day 4, in the memory store | The measurement exists. Whatever it finds is recorded honestly — **including if it finds a leak** |

**Exit gate:** all 29 scenarios pass in every environment they claim; the
golden corpus is stable; S-15 and S-26 produce their first results.

### 5.9 MVP 9 — The Adaptive Loop

**Goal:** the system learns **within** the envelope, and the loop is the only
thing that improves.

| Module | Tasks | Acceptance criterion |
|---|---|---|
| **9.1 Trace extraction** | Deterministic extractors over the log produce candidate learnings as `Experience` records | Extraction is **deterministic** given the log. A candidate that contradicts a truth anchor is **rejected and logged** |
| **9.2 The two axes** | The kernel's epistemic rung (Axis E) and the SDK's operational stage (Axis S), with the binding rule: enacted ⟹ rung ≥ `HYPOTHESIS` ∧ stage ≥ `SHADOWED` | The forbidden jumps are **structurally unreachable** and each has a test. `VERIFIED_KNOWLEDGE` requires ≥1 supporting evidence id — **enforced in the schema** |
| **9.3 Sleep-time compute** | Pre-computation over a known corpus, amortised across anticipated queries | A precomputed answer is a **cache entry**, not a policy change. Its cost is charged to the optimiser budget, never the task budget |
| **9.4 The optimiser as a fold** | The plan is a pure function of the log plus an injected clock, price table and seeded PRNG | Idempotency is free. Replay **is** the audit: "why did the system behave this way on date X" is "replay to X and re-run the fold" |
| **9.5 The optimiser is deletable** | Disabling it must not be noticeable to the worker | With the optimiser off, the worker continues on its last known-good configuration. **The optimiser failing is never a worker failure** |
| **9.6 The learnings knowledge graph** | The accumulated learnings become a **graph**, not a pile of notes. A node is a **pattern**; an edge is a **relation**. The node schema: `{ id, title, kind: PATTERN\|FAILURE_MODE\|DECISION\|EXPERIENCE, statement, evidence[], sources[{repo, path, lines}], confidence, provenance, supersedes? }`. The edge schema: `{ from, to, kind: implements\|conflicts-with\|supersedes\|generalises\|shared-mechanism, evidence[] }` | The graph is a **projection** of the log, rebuildable by a fold. A node's `sources` are **file paths and line numbers** into real repositories — a learning without a source is `UNCITED` and cannot reach `VERIFIED_KNOWLEDGE`. The graph is **queryable** — the semantic index (5.8) is over the graph's nodes, not over raw notes |
| **9.7 Semantic search over the learnings** | `sqlite-vec` over the graph nodes, with the **same** embedding model and the **same** cosine-sanity assertion. Search returns a **path** through the graph, not just a list | A search returns nodes **and** the relations between them, so the answer is a *chain of reasoning*, not a list of similar notes. A query whose answer would need a node with `confidence` below its required tier is **downgraded** in the result — the same demotion the evidence projection applies elsewhere. The index is **rebuildable** and its staleness is **detected** |

**Exit gate:** the learning funnel's rates are reported; a promotion
requires two signal families to agree; the optimiser can be disabled with no
worker-visible change; the nine signals are live with their gaming modes
documented; the learnings graph is **rebuildable from the log alone**, and
the rebuild is **byte-identical** to the incremental one — the same
determinism property the event log already guarantees.

---

## 6. The dependency DAG

```
        ┌──────────────────────────────────────────┐
        │  MVP 1  Zero-Compute Digest             │
        │  + Simulation harness v0                 │
        └───────────────┬──────────────────────────┘
                        │
          ┌─────────────┼──────────────┐
          ▼             ▼              ▼
   ┌────────────┐ ┌───────────┐  ┌──────────────┐
   │ MVP 2      │ │ MVP 4     │  │ MVP 5        │
   │ Graph      │ │ Token     │  │ Tool Surface │
   │ Kernel     │ │ Economist │  │ + Regions    │
   │ (kernel)   │ └─────┬─────┘  └──────┬───────┘
   └─────┬──────┘       │               │
         │              │               │
         ▼              │               │
   ┌────────────┐        │               │
   │ MVP 3      │◄───────┴───────────────┘
   │ Persistent │   (needs 1, 2, 5)
   │ Orchestrator│
   └─────┬──────┘
         │
         ▼
   ┌────────────┐      ┌──────────────┐
   │ MVP 6      │◄─────┤ MVP 7        │
   │ Telemetry  │      │ Promotion    │
   │ Lens       │      │ System       │
   └─────┬──────┘      └──────┬───────┘
         │                    │
         └────────┬───────────┘
                  ▼
          ┌──────────────┐
          │ MVP 8        │
          │ Certification│
          └──────┬───────┘
                 ▼
          ┌──────────────┐
          │ MVP 9        │
          │ Adaptive Loop│
          └──────────────┘
```

**The critical path:** 1 → 2 → 3 → 6 → 7 → 8 → 9.

**Three ordering facts that are not obvious:**

1. **MVP 2 precedes MVP 3**, because the orchestrator's decomposition *is* a
   graph, and the DAG's acyclicity, depth and coverage checks are graph
   properties. Building the orchestrator first would mean building a graph
   engine twice — once properly, once badly.
2. **MVP 5 precedes MVP 3's completion**, not its start. The orchestrator can
   be built with one tool; but the delegation contract's authority and
   budget clauses need the real tier and budget fields to bind to.
3. **MVP 6 precedes MVP 7.** The promotion gates read the nine signals; a
   gate that reads a metric nobody emits is a gate that always passes, and
   a gate that always passes is worse than no gate.

**Parallelisable:** MVP 4 and MVP 5 can run in parallel once MVP 1 lands.
MVP 8's harness work can start in MVP 1 and never stops.

---

## 7. The metrics

### 7.1 The primary reliability metric

> **`pass^k`** — the fraction of **k independent runs** that succeed.

Not pass@1. A persistent agent that succeeds 1-in-3 is not a persistent
agent. τ-bench measured gpt-4o succeeding on **<50 %** of tasks and *"quite
inconsistent (pass^8 <25 % in retail)"*.

### 7.2 The headline capability metric

> **METR's 50 %-time-horizon** — the human task-completion time at which the
> fitted logistic success curve crosses 50 %.

TH1.1: **228 tasks**, 31 of them ≥ 8 h. Opus 4.5 **320 min**, GPT-5 214, o3
121, Opus 4 101, GPT-4 (Nov 2023) **3.6 min**. P50 doubling **196.5 d**
overall, **130.8 d** since 2023, **88.6 d** since 2024.

**Two disciplines that come with it, and that the suite must enforce:**

| Discipline | Why |
|---|---|
| **Report confidence intervals** | Opus 4.5's upper bound was **2.3× its point estimate** |
| **Measure the scaffold effect** | METR found GPT-4o and o3 scored **significantly higher** under Vivaria than under Inspect — a ~30 % effect on some models, *derived from the time-horizon deltas METR reports rather than a figure METR itself states*. Two models were "somewhat sensitive to scaffold" |
| **State the human baseline's thinness** | METR measured human baselines for only **5 of 31** long tasks |

### 7.3 The metric set, with its anti-gaming counter-measure

| Metric | Definition | Target | Anti-gaming |
|---|---|---|---|
| **`pass^k`** | fraction of k independent runs succeeding | measured per task class | A high pass^1 with a collapsing pass^k is the failure. Both are reported |
| **`I_tok`** | task accuracy ÷ total tokens | flat or falling while success rises | Denominator from outside the optimiser's control |
| **`I_cost`** | task performance ÷ total compute cost | falling | Every cost carries its **price-table id**; cross-time comparison is only valid within a table |
| **`TSR`** | workflows satisfying all postconditions ÷ total | — | The postconditions must be **external** |
| **`FPC`** | tasks passing verification without retry ÷ total | rising | Rewards first-pass quality, not retries |
| **`RSR`** | initial failures recovered ÷ initial failures | rising | A recovery is **never** counted as a success |
| **`VP`** | verifier accuracy in flagging invalid outputs | **the highest-priority metric** | This is the metric that catches a verifier that turns missing evidence into success |
| **Context-rot delta** | focused projection vs full history | projection **wins** | Measured on the corpus every release; a regression fails the build |
| **Break-even margin** | measured hit rate − derived break-even | ≥ +0.05 | `h_eff` counts **verified-correct** hits only, never raw hits |
| **Monitor catch rate** | fraction of seeded side-tasks detected | measured per environment | The reference value is **52 %** (GPT-5-high, hidden reasoning) — a system claiming more must show how |

### 7.4 The density metric — verified work per unit of resource

**Throughput is not density.** A system that processes 10,000 tokens/second
and verifies none of them has zero density. Density requires the
verification to be in the denominator.

> **DENSITY = (verified tasks × evidence tier weight) / (tokens + wall-clock + cost)**

The **tier weight** is what stops it being gamed: a `VERIFIED` claim counts
more than an `UNCITED` one, and a `BROKEN` one counts **negative**. That is
`optimization.md`'s S1 counter-measure applied to the headline metric
rather than only to a side signal.

| Axis | Resource | Verified work | The measure |
|---|---|---|---|
| Latency | Wall-clock seconds | Tasks reaching a **verified** terminal state | `verified tasks / second` |
| Tokens | Input + output tokens | Tokens that produced a **verified** claim | `verified claims / 1k tokens` |
| Money | USD | Decisions reaching a `VERIFIED` tier | `verified decisions / $` |

**The four levers, in order of how much they buy:**

| Lever | The move | The measurement | MVP |
|---|---|---|---|
| **L1 — Do not compute** | The deterministic path answers it: a cache hit, an exact-match rule, a **date-facts preprocessor**, a BM25 lookup | `Tier 0` share — the fraction of tasks that never reach a model | 1, 4, 5 |
| **L2 — Compute less** | Compression, a focused projection, a compact prompt, the smallest model that can carry the band | Tokens per verified task, and the compression quality gate | 4 |
| **L3 — Compute less often** | The cache, the batch API, sleep-time pre-computation | Measured hit rate against the derived break-even | 4, 9 |
| **L4 — Compute only what is verified** | The abstention band — route what the small model can carry, escalate the rest | `verified decisions / $`, and the escalated fraction | 3, 5 |

**L1 is the biggest and the cheapest**, and it is the one every "AI-first"
roadmap skips, because it is not AI: it is *knowing what not to ask a
model*. Unee's date-facts preprocessor is worth ~3 points at **zero token
cost** — and the same idea applied to our sixteen local tools is worth far
more, because it removes the call entirely.

**The rule that falls out, and it is mechanical:**

> **If a tool can compute it exactly, the model is never asked to.**

**Four gaming modes, four rules** — density is gameable in exactly the ways
`optimization.md` §7 predicts, and each has its counter-measure:

| Gaming mode | Rule |
|---|---|
| Count the easy tasks | Density is reported **per task class**, and the composite is a **weighted** aggregate, not a flat mean |
| Count trivial verifications | A `VERIFIED` claim requires an **admissible** evidence record — the kernel's rule. A claim with no citation is `UNCITED` and counts at low weight |
| Idle to raise the ratio | **Wall-clock is in the denominator**, and the run-to-run spread is published — idling is visible in the latency axis |
| Cache the easy answers forever | The cache is keyed on the **assembled request digest**; a policy or model change invalidates it, so a stale hit is impossible |

**The honest limit:** density is not quality. A system that verifies one
trivial claim per million tokens has a terrible density *and* a terrible
quality. **Density is reported beside `VP` and `TSR`, never instead of
them** — the same "no single aggregate decides" rule.

### 7.5 The nine signals

`optimization.md` §7's nine signals stay as they are — evidence-tier mix ·
cache effectiveness · delegation failure-class mix · the learning funnel ·
grounding denial rate · cost per task and per verified claim · shadow
sufficiency · work deferral · verifier divergence.

**The suite reports them per environment.** A signal that is stable in Node
and broken in a browser is **two different signals**.

---

## 8. Before and after

### 8.1 The honest comparison

| | **Today: AnyPlugin kernel only** | **After MVP 1** | **After MVP 9** |
|---|---|---|---|
| **What a document can become** | Nothing — the kernel does not read documents | A structured tree with source spans and a content hash | The same, plus a verified, evidence-tiered, replayable intent |
| **Where compute happens** | Wherever the host puts it | **On the user's device, by default** | The same, with cloud escalation as an explicit, measured, logged choice |
| **Network egress** | Undefined | **None** for the local tier | Explicitly granted, per-tenant, per-region, every call an event with a legal basis |
| **What evidence exists** | Evidence records, but nothing produces them | Every claim carries a tier and a citation | Every claim carries a tier, a citation, and a **calibration** against reality |
| **What an auditor can reconstruct** | The kernel's own events | The parse, the structure, the classification, the reasons | The same, plus the graph path, the delegations, the policy versions, and the verification verdicts |
| **Cost per digest** | Unmeasurable | **$0.00** on the local tier, measured | Measured, with a break-even margin and a disable recommendation |
| **Time to first intent** | — | Local parse + local classify | Same, with a cached path |
| **Failure containment** | A failing hook exits 0 with a stderr note | Every class classified, bounded, with a receipt | Same, plus a **re-orient policy** and a graph-driven invalidation cascade |
| **Long-horizon behaviour** | Unmeasured | Unmeasured | `pass^k` and the 50 %-time-horizon, **reported** |
| **Self-improvement** | None | None | Bounded by the safe-adaptation envelope; 13 decisions always need a human |

### 8.2 The comparison that matters most

| | **A naive agent SDK** | **This plan** |
|---|---|---|
| Evidence | A scalar confidence number | The kernel's **authority × validity × rung**, with a derived tier that cannot drift |
| Failure | An exception | A **classified** failure with a bound, a fallback and an audit record |
| Memory | A context window | An append-only log, with the window as a **budget** |
| Progress | A loop | A **bounded** loop with a promotion gate and a rollback that happens before diagnosis |
| Learning | "The model learned it" | A rung transition with its own evidence, recorded as an event |
| Cost | "We saved 40 % tokens" | A **measured** hit rate against a **derived** break-even, with the derivation's assumptions stated |
| A malicious document | "We sanitise the input" | Untrusted content is **data**; it never creates instructions or capabilities |
| The operator | Trusted | **The operator is the assumed adversary** for tenant isolation; the tenant co-signs the chain head |
| A second agent | "It runs the sub-task" | Seventeen clauses, a depth cap, a non-inheriting authority grant, and an external verifier |

---

## 9. The affected files

### 9.1 In **this** repository (AnyPlugin)

| File | Change | MVP | Why |
|---|---|---|---|
| `packages/worker-runtime/src/graph/` (**new**) | The traversal engine: derivation, reachability, topological order, cycle detection, component handling | 2 | M5's engine. The contracts already exist at `contracts/index.ts:308–325` |
| `packages/worker-runtime/src/graph/traversal.test.ts` (**new**) | M5's acceptance criteria as tests | 2 | "deterministic traversal across branching, multi-hop, cycles, disconnected components; byte-identical output for identical input" |
| `packages/worker-runtime/src/contracts/index.ts` | **No change required** | 2 | Traversal is a pure function over `GraphSnapshotSchema` — no version bump, no certificate invalidation |
| `packages/worker-runtime/src/index.ts` | Export the graph module | 2 | The SDK consumes it as a package |
| `core/src/boundaries/doc-ownership.test.ts` | Extended scope + status vocabulary | — | D-048 |
| `ARCHITECTURE.md` §7 | Owner rows for the new and the root documents | — | D-048 |
| `ROADMAP.md` | Status corrected; `packages/` claim corrected | — | `gaps.md` §1 |
| `IMPLEMENTATION_PLAN.md` | The false "documentation gaps are closed" claim corrected | — | `gaps.md` §1.2 |
| `docs/BACKLOG.md` | **New in this cycle:** P1-13, P2-23 … P2-28. (P1-10, P1-11, P2-21 and P2-22 pre-exist on `main` — they were raised in PR #29.), plus the SDK items | — | — |

### 9.2 In the **SDK** repository (new, separate)

```
packages/
  digest-worker/          the SDK core
    src/
      capabilities/       1.1 environment probe
      parse/              1.2 client-first parsers
      structure/          1.3 structure tree
      evidence/           1.4 tier projection
      errors/             1.5 error taxonomy
      orchestrator/       3.1 the eight stages
      specialists/        3.2 the six specialists
      state/              3.3 the two stores + direction of truth
      delegation/         3.5 the seventeen clauses
      economy/            4.2 compression, 4.3 provider economics
      tools/              5.1–5.6 the registry, the tiers, the regions
      telemetry/          6.1–6.5 spans, metrics, the projected monitor
      promotion/          7.1–7.6 replay, shadow, gates, envelope, ramp
      learning/           9.1–9.5 extraction, the two axes, the fold
  digest-worker-sim/      8.1–8.5 the certification harness
  digest-worker-regions/  5.5 the eight region bundles, versioned and cited
```

---

## 10. The self-scalable AI SDLC

**How the loop feeds itself, without the loop becoming the thing it judges.**

| Stage | What is automated | What is **never** automated | The gate |
|---|---|---|---|
| **Frame** | Alternative framings are generated and recorded | Choosing the framing that ships | G1.1 (≥2 alternatives) + human judgement |
| **Constrain** | MUST/WANT separation, measurability check | Deciding which MUST is binding | G2.1 — MUSTs must be measurable |
| **Decompose** | The DAG, the coverage check, the independence check | The decomposition *quality* | G3.2–G3.4 + the MECE review |
| **Evidence plan** | The falsifier set, the authority check | Whether the plan is *sufficient* | G4.1–G4.3 |
| **Execute** | Everything, inside the caps | The caps themselves | The never-automated list |
| **Verify** | The mechanical and evidence checks | The semantic judgement (O8, calibrated) | The oracle hierarchy |
| **Integrate** | The authority-based conflict resolution | — | G7.2 |
| **Learn** | The extraction, the candidate capture | The promotion to `VERIFIED_KNOWLEDGE` | The twelve gates + the envelope |

**The loop's own budget** (from `optimization.md` §6.1) is enforced per cycle
and per day, and **the optimiser's cost is attributed to the optimiser
budget, never the task budgets** — otherwise a runaway optimiser would
silently consume the worker's allowance and the cost signal would blame the
wrong component.

**The scaling mechanism is not "more agents".** It is **more width at the
same depth** — and D9's gate is what stops the width from becoming cost
without benefit. The published coordination overheads (SAS 0 %, Independent
58 %, Decentralized 263 %, Centralized 285 %, Hybrid 515 %) are the budget
model.

---

## 11. What this plan does not do

| Not doing | Why |
|---|---|
| Write any code | The instruction is "planning with my directions". This change contains zero implementation |
| Design the UI | Explicit instruction. The plan records only the UI's **contract** — what it may show, and what it may not claim |
| Adopt a scalar confidence model | D-049. The kernel's authority × validity × rung is strictly stronger and already implemented |
| Adopt AIIAI's evidence shape | It would let a `REPORTED` claim pass a blocker gate |
| Depend on a single-maintainer repo | `substrate.md` §3 — six of the named projects are wrapped behind an interface or reimplemented |
| Run a self-modifying optimiser in production | The published measurements of STOP and ADAS are of their **escape** properties |
| Use a simulated user as a go/no-go oracle | Up to 9 pp swing across user LLMs; dialect-dependent differential effectiveness |
| Trust an automated test-suite pass as a correctness oracle | SWE-bench Verified: **59.4 %** of audited problems materially defective |
| Ship the Brazil or US-health region bundle | Their regulatory claims are **UNVERIFIED** in the ledger |
| Rewrite `ROADMAP.md` wholesale | A correction and a rewrite are different kinds of work — BACKLOG P2-23 |

---

## 12. Related documents

| Document | Owns |
|---|---|
| `docs/agent-sdk/README.md` | The SDK contract: three modes, the developer surface, the guarantees |
| `docs/agent-sdk/gaps.md` | What was missing, and why the last cycle stopped at documentation |
| `docs/agent-sdk/substrate.md` | The seven-repo substrate, the build slots, the licence allowlist |
| `docs/agent-sdk/tools.md` | The 18 tools, the two tiers, the eight region bundles |
| `docs/agent-sdk/simulations.md` | The certification harness, the scenario catalogue, the metric set |
| `docs/agent-sdk/learnings.md` | The extraction ledger: every learning with its source, its status, its negative case |
| `docs/agent-sdk/platform-engineering.md` | The patterns stolen from Linux, Debian, Android, macOS, iOS and the clouds |
| `docs/agent-sdk/trust.md` | Identity, attestation, the commit-point protocol |
| `docs/agent-sdk/optimization.md` | The learning loop, the twelve gates, the nine signals |
| `docs/agent-sdk/economics.md` | Caching and batching, with the corrected provider table |
| `docs/DECISIONS.md` | D-039 … D-051 — why each choice was made |
| `docs/EVIDENCE.md` | Every external claim, with a source URL and an access date |
| `docs/BACKLOG.md` | What is still open, classified |
