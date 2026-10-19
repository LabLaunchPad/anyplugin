# Gaps: why the last cycle stopped at documentation, and what is still missing

**This document answers one question honestly:** PR #29 produced a complete
*specification* and no *implementation plan*. That was a deliberate scope
decision (D-003), but it left the work half-finished in a way that was easy to
mistake for "done". This page names every gap, with the evidence for it, so
the next cycle does not have to re-derive them.

Everything here was checked against the repository on **2026-10-20** at
commit `d8c6059`.

---

## 1. The direct answer: there was no live plan to extend

The reason PR #29 did not produce an implementation plan is not that the plan
was hard to write. It is that **the repository's own plan had gone stale, and
the guard was pointed at the wrong directory.**

### 1.1 The repository's roadmap still describes a repository that no longer exists

`ROADMAP.md` line 3 read, **before this PR corrected it**:

> **Status:** strategy frozen, implementation not started. M0 is the next action.

That was true in August 2026. It is false now. The kernel ships ten frozen
contracts at `CONTRACT_VERSION = "1.0.0"` (`packages/worker-runtime/src/contracts/index.ts`),
an append-only hash-framed event log with three `DurabilityLevel`s, a
verification engine, an invalidation engine, a delegation wrapper with a
declarative backend registry, and a `doctor` command. M1 through M12 are
largely shipped.

`ROADMAP.md` also made a checkably false claim, **before this PR corrected
it** (the text below is quoted as it stood; `ROADMAP.md` now carries a
correction banner in its place):

> **`packages/` is not currently a workspace location - this is a setup step,
> not an existing property.** `pnpm-workspace.yaml` declares exactly `core`,
> `adapters/*`, `plugins/*`, `cli`; there is no `packages/*` glob and no
> `packages/` directory, and root `tsconfig.json` lists seven references, none
> under `packages/`.

`pnpm-workspace.yaml` today declares:

```yaml
packages:
  - core
  - adapters/*
  - plugins/*
  - cli
  - packages/*
```

`packages/*` is the last line. The statement is false, it is load-bearing (it
is the **first task of M1**), and nothing in the repository caught it.

### 1.2 Seven root-level planning documents, none of them owned or checked

`core/src/boundaries/doc-ownership.test.ts` (merged in PR #29) enforces that
every markdown file under **`docs/`** has an owner row in `ARCHITECTURE.md` §7.
Seven planning and status documents live at the **repository root**, outside
that directory, and therefore outside the guard:

| Document | Its own status claim | Reality on `d8c6059` | Verdict |
|---|---|---|---|
| `ROADMAP.md` | "strategy frozen, **implementation not started**. M0 is the next action." | Ten contracts, an event log, verification, invalidation, delegation, doctor | **FALSE** |
| `CURRENT_STATE.md` | "**Commit**: `77729f8` on `lablp/relaxed-johnson-vq396s`", "**Verified**: 2026-08-24" | `main` is `d8c6059`; the branch named is gone; **~8 weeks stale** | **FALSE** |
| `ENGINEERING_LEDGER.md` | Statuses `[OPEN]` … `[UNMAPPED]`; "this session's independent code review (PR #2 iteration 1)" | Findings A–L are all **FIXED** (PR #28) | **SUPERSEDED** |
| `CORE-INVARIANTS-V2.md` | "Status: **DRAFT — awaiting founder approval. No implementation is authorized by this document.**" | M1, "Freeze kernel contract", is merged | **FALSE** |
| `REMEDIATION_PLAN.md` | "Based on full repository audit (5 agents, 377 tests, Oct 2026)" | The suite is now 664 tests; the audit it plans from is the *old* one | **SUPERSEDED** |
| `IMPLEMENTATION_PLAN.md` | "**Status: COMPLETE.** … the repository's documentation gaps are closed." | The seven rows above | **FALSE about itself** |
| `CHANGELOG.md` | `[Unreleased]` | — | Accurate, but with no release cut yet |

**The compounding failure:** `IMPLEMENTATION_PLAN.md` declares the
documentation gaps closed while `ROADMAP.md` and `CORE-INVARIANTS-V2.md`
declare that implementation is not started and not authorized. Two documents
at the repository root assert opposite worlds, and neither is checked.

**This is the mechanical answer to "why didn't you get this".** PR #29 built
the guard and pointed it at `docs/`. The seven documents that actually
describe *what to build next* were outside its reach. The guard was correct
about what it covered and blind about what mattered.

### 1.3 The fix, which is mechanical and small

1. Extend the guard's scope from `docs/` to **every** markdown file in the
   repository that is a planning, status or contract document.
2. Add a **status-consistency check**: a document that declares a status must
   declare one from a closed vocabulary, and a document that says "COMPLETE"
   while a sibling says "not started" must fail.
3. Correct `ROADMAP.md`'s false `packages/` claim and its status line.

Items 1 and 2 are implemented in this change. Item 3 is implemented in this
change. The *rewriting* of `ROADMAP.md` into a live document is deferred
(BACKLOG P2-23), because a rewrite is a different kind of work from a
correction and this cycle is a planning cycle.

---

## 2. The other unfinished thing: roadmap milestone M5

`ROADMAP.md`'s M5 row reads:

> | **M5** | Dependency Graph | Deterministic traversal across branching, multi-hop, cycles, disconnected components; byte-identical output for identical input | M1 | - |

**It is not done, and nothing notices.** The kernel *has* the graph contracts:

```ts
// packages/worker-runtime/src/contracts/index.ts
export const GraphNodeSchema = z.object({ id: idSchema("node"), kind: z.enum(NODE_KINDS), ref: z.string().min(1) }).strict();
export const GraphEdgeSchema = z.object({ from: idSchema("node"), to: idSchema("node"), kind: z.enum(EDGE_KINDS) }).strict();
export const GraphSnapshotSchema = z.object({ contractVersion, at, nodes, edges }).strict();
```

`EDGE_KINDS` is a nine-value enum (`IMPORTS`, `MODIFIES`, `TESTS`, `SUPPORTS`,
`DEPENDS_ON`, `DERIVED_FROM`, `LEARNED_FROM`, `INVALIDATES`, `SUPERSEDES`).

A repository-wide search for those three symbols returns **only their own
definitions** in `contracts/index.ts` plus one mention in
`contracts/contracts.test.ts`. There is **no traversal engine**. Nothing
walks the graph, nothing detects a cycle, nothing cascades an invalidation
through it.

**This matters more than it looks.** `InvalidationResultSchema` — the
invalidation engine's output — carries `affectedNodes`, `staleDecisions`,
`reopenedWork` and `requiresReverification`. Without traversal, none of those
fields can be computed. The invalidation engine has a **contract and no
implementation**, and the graph is the missing half.

The user's requirement for "multi-tier graph engineering" therefore does not
start from zero — it starts from a **half-built substrate with a working
contract and a missing engine**. That is the best possible starting position,
and it is why the plan puts graph traversal in MVP 2 rather than later.

---

## 3. The draft evidence base in the request had eleven factual errors

The request's "Part 3 — Evidence Base" listed specific repos and claimed
specific capabilities. A verification pass against primary sources on
2026-10-20 found **eleven claims wrong**. This is the single most valuable
output of the research phase, because the plan's cost and feasibility depend
entirely on it.

| # | Claim as stated | What the primary source says | Verdict | Consequence if unfixed |
|---|---|---|---|---|
| 1 | "EdgeParse … client-side PDF/**Office** parsing" | EdgeParse is **born-digital PDF only**. Its README: *"It does not include an OCR engine."* Office is absent entirely. 150★, last tagged release 2026-04-13 | **PARTLY VERIFIED** | An Office capability that does not exist in the browser tier |
| 2 | "BentoPDF … client-side PDF/Office" | **AGPL-3.0**, and it is an *application* (130+ tools), not a parsing SDK. The npm package is a modified PyMuPDF, which is Artifex AGPL | **PARTLY VERIFIED** | **Licence contamination** — AGPL §13 infects any linking service. Must be excluded from an MIT/Apache core |
| 3 | "Chunker … hierarchical chunking + progressive disclosure" | The *design* is real and is the best in the set — but **there is no LICENSE file**, so it is all-rights-reserved; 6★, Python, and it requires a running Ollama | **VERIFIED / unusable** | Vendoring it is unlawful. It must be **reimplemented from its published algorithm description** |
| 4 | "Dapr Agents v1.0 … state across 30+ databases" | "30+ databases" is **Dapr's state-store catalogue**, not a Dapr Agents feature. It requires a **Dapr sidecar**; non-durable `Agent` is deprecated as of v1.0.0-rc.1 | **PARTLY VERIFIED** | A server-side, sidecar-dependent framework cannot be a client-first SDK's core |
| 5 | "AgentTelemetry … 9 agent-specific span kinds (planning, reasoning, safety, delegation, memory, tool, model, error, state)" | The real nine are `AGENT`, `LLM_CALL`, `TOOL_CALL`, `PLANNING`, `REASONING`, `RETRIEVAL`, `GUARD_RAIL`, `DELEGATION`, `MEMORY`. The stated list invents `safety`/`error`/`state`, renames `model`, and **omits `RETRIEVAL`** | **CONTRADICTED** | A telemetry vocabulary that does not exist in its own cited source |
| 6 | "AgentTelemetry … FDR 1.000" | The current README reports **FDR 0.612**; 1.000 is reachable only with the "conformance-complete adapter (upper bound)" | **CONTRADICTED** | Citing an upper bound as a measurement — the exact overclaim this repository exists to stop |
| 7 | "OTel GenAI semconv … 9 agent span kinds" | OTel defines **no** 9-kind agent vocabulary at all. It defines `create_agent`, `invoke_agent` (client/internal), `invoke_workflow`, `plan`, `execute_tool`, `load skill`, `read skill resource`, `command execution`. The conventions have also **moved** to `github.com/open-telemetry/semantic-conventions-genai` | **CONTRADICTED** | Five agent phases (reasoning, guardrail, delegation, memory-as-span, state) are **ours to define** |
| 8 | "Unee … calibrated on-device **intent classification** probabilities" | Unee scores a **caller-supplied option list** (`choice`/`score`). It is not intent *discovery*. "Zero tokens" means zero *generated* tokens, not zero compute — it is a 0.8B/1.9B local forward pass. The vendor's own limits: doc-grounded answers ~50% fully correct, 10–15% fabricated without strict mode, "not for high-stakes decisions without a person checking" | **PARTLY VERIFIED** | Over-trusting a single-vendor 0.3 release for the routing decision |
| 9 | "EmbeddingGemma 2 + WebGPU … zero-token typed decisions" | The model is real (740M, Apache-2.0, 768-dim Matryoshka). The **decision layer is a Hugging Face Space demo, not a library**. Worse: `transformers.js` issue **#1728** is open — *"WebGPU embeddinggemma-300m-ONNX q4/q8 produce silently wrong embeddings (cos ≈ 0 vs WASM); fp32 correct"* | **PARTLY VERIFIED** | **Silently wrong embeddings** on the flagship local path — worse than no embeddings |
| 10 | "binary-tree reduction libraries" | The two named repos are 1★ and 0★ hobby projects with no tests or releases. The pattern lives in LangChain's `map_reduce` and Chunker's bottom-up aggregation. **No proven library exists** | **PARTLY VERIFIED / hype** | Building on a 1★ repo for the core summarisation path |
| 11 | "LiteParse … PDF/**Office**, browser/edge, no server" | Real, Apache-2.0, LlamaIndex's own, 12,888★. But Office **"requires LibreOffice"** — a native binary, not a browser path. The WASM package scopes itself to PDF | **PARTLY VERIFIED** | The Office story is not a browser story |

**The pattern across all eleven:** every error errs in the direction of
**overstating capability**. Not one understates. That is a property of
vendor-adjacent README prose, and it is exactly the failure mode the
repository's evidence discipline was built to catch.

The corrected substrate — **seven repos, four of them load-bearing, three
deliberately built rather than depended upon** — is in
`docs/agent-sdk/substrate.md`.

---

## 4. The conflict register: four external documents vs. this kernel

Four attached documents were read in full. Each is useful; each conflicts with
the kernel in a specific, nameable way. The rule for all four: **the kernel
wins, and the document supplies vocabulary and requirements rather than
architecture.**

| Document | Its claim | The kernel's position | Resolution |
|---|---|---|---|
| **AIIAI 3.0** (Z.ai, Oct 2026, 62pp) | Evidence = a **scalar confidence** + a span + a path; `status ∈ {grounded, inference, unverified}` | Evidence = **typed authority** (`AUTHORITATIVE`/`DERIVED`/`REPORTED`) × **validity** (`VALID`/`INVALIDATED`/`SUPERSEDED`) × **epistemic rung** | **The kernel's model wins.** AIIAI's grounding gate would pass a `REPORTED` claim with a resolvable span; the kernel demotes it to `UNCITED`. If AIIAI's shape is wanted, add `authority` and `validity` as **required** fields |
| **AIIAI 3.0** | An LLM may mine candidate graph nodes/edges, accepted after human review | "**An LLM never decides impact**"; the verifier may not be the candidate's own lineage | AIIAI's *mitigation* transfers (human review + mechanical span verification + distinct provenance). Its *"mined edge enters the graph"* does not |
| **AIIAI 3.0** | ADR-0001: A2A over an operated gateway; one process per agent | "**The CLI is the floor — not CLI + MCP.**" `opencode@v2` omits `mcp.*` entirely | **The kernel wins.** A2A is a gateway-tier feature, never a kernel dependency |
| **arXiv 2603.00495v2** ("AI Runtime Infrastructure", Feb 2026, preprint) | A runtime layer that "actively observes, reasons over, and intervenes… while they are running" | "**No LLM inference inside the kernel.** The kernel records and verifies; it never infers." | Compatible only as a layer **above** the kernel. The paper also has **zero experiments, zero tables, zero numbers** — its abstract's "materially improve agent robustness and efficiency" is asserted, not measured. Under the kernel's ladder this is `REPORTED` and **cannot be cited as evidence for prioritisation** |
| **Local-first AI research brief** (OpenAI, 14 Oct 2026, 9pp) | VM-per-agent; QEMU, containers, hypervisors | "The runtime ships **NO dependencies**: an emitted bundle must run on a machine that has Node and nothing else." | Its **9-row security acceptance checklist** is adoptable as requirements (see `docs/agent-sdk/simulations.md` §3). Its **architecture** is a roadmap item at the `ExecutionBackend` layer, not a runtime dependency |
| **Gateway security audit** (internal, 22pp) | OmniRoute scores **93.5/100**; "no publicly known critical vulnerabilities" → security **15/15** | "`BLOCKED` exists precisely so absence of evidence has somewhere to go that is not success." | **Its arithmetic does not reproduce**: 58.0 vs 68, 93.5 vs 92, 31.0 vs 40 — none of the three totals equals the sum of its stated parts. Its "non-negotiable rules" are *referenced but never reproduced*. Awarding full marks for **absence of known CVEs** is precisely the false-positive the kernel's M7 acceptance test exists to catch. **Not a usable input to this plan** |

### 4.1 What all four documents agree on — and the kernel already has it

This is worth stating, because it is the strongest mutual corroboration in the
set:

1. **The event log is the substrate, not a by-product.** AIIAI: *"a durable
   event log is the system of record."* The kernel: *"replaying the event log
   reconstructs byte-identical state."* The local-first brief: *"Actions and
   policy decisions can be reviewed."*
2. **Absence of evidence is not success.** AIIAI: *"zero tolerance for
   unverified material claims on risky intents."* The kernel: `BLOCKED`.
3. **Deterministic gates beat prose.** AIIAI: *"Gates that do not blink."*
   The kernel: *"A verifier must never convert missing evidence into PASS."*
4. **No model in the approval path.** AIIAI: *"a model that occasionally
   approves things is not an approval process."* The kernel: a human approval
   naming a `contentHash`.
5. **The graph is the input to invalidation.** AIIAI: *"no vector-only
   retrieval path — answers ground in spans."* The kernel's `EDGE_KINDS`
   includes `INVALIDATES` and `SUPERSEDES`.

**Conclusion: the kernel is not behind these documents. It is ahead of two of
them, and the two that are ahead of it (`arXiv 2603.00495v2`, the gateway
audit) are the two with no measurements.** The plan consumes the four
documents for **requirements and vocabulary**, and takes **architecture**
from the kernel.

---

## 5. The coverage matrix — every gap, and where it is closed

### 5.1 The seven gaps PR #29 was said to leave open

PR #29 stopped at documentation and specification. These seven were the
capability gaps it did not close. **All seven are now planned**, and each
has an MVP, a module, an exit gate, and a certification scenario.

| # | The gap | Where it is closed | MVP | Modules | Gate |
|---|---|---|---|---|---|
| 1 | **Client-first zero-compute ingestion** (WASM parsing, on-device intent classification, local summarization) | `docs/agent-sdk/roadmap.md` §5.1 | **1** | 1.1 environment probe · 1.2 client-first parser · 1.3 structure tree | S-01, S-02 — a 50-page PDF parses in a browser Worker with **zero server calls** |
| 2 | **Token-efficient digestion** (hierarchical summarization, prompt compression, exact/semantic caching, batching) | `roadmap.md` §5.4 | **4** | 4.1 summary tree · 4.2 compression + quality gate · 4.3 provider economics · 4.4 determinism · 4.5 context-rot regression | S-09, S-20, S-21, S-22 — the cache-on/cache-off replay is byte-identical |
| 3 | **Multi-agent orchestration with persistent state** (orchestrator, specialists, event-sourced SQLite, checkpoints) | `roadmap.md` §5.3 | **3** | 3.1 orchestrator · 3.2 specialists · 3.3 both stores · 3.4 checkpoints · 3.5 the delegation contract · 3.6 the delegation decision · 3.7 the metacognitive monitor · 3.8 zoom in/out | S-05, S-11, S-12, S-28 — a `kill -9` resumes without duplicating work |
| 4 | **Graph engineering with evidence-gated progression** (conditional edges, bounded loops, terminal conditions with audit) | `roadmap.md` §5.2 (kernel) and §5.3 (policy) | **2 → 3** | 2.1 derivation · 2.2 traversal · 2.3 invalidation cascade · 2.4 the re-orient trigger · 3.1 the graph-shaped decomposition | S-06, S-07 — M5's acceptance criteria, verbatim |
| 5 | **Telemetry and bottleneck detection** (agent-specific span taxonomy, per-stage latency and cost, success rate per domain) | `roadmap.md` §5.6 | **6** | 6.1 span vocabulary · 6.2 per-stage metrics · 6.3 domain success · 6.4 bounded telemetry · 6.5 the projected monitor | S-27 — the top 3 bottlenecks are identified, and the cardinality cap is **enforced** |
| 6 | **Experiment and simulation framework** (shadow mode, replay, policy promotion gates) | `roadmap.md` §5.7 and §5.8 | **7 → 8** | 7.1 replay and shadow · 7.2 the twelve gates · 7.3 the safe-adaptation envelope · 7.4 ramp and rollback · 7.5 flapping · 7.6 the never-automated list | S-23, S-24 — a candidate failing **one** gate is not promoted |
| 7 | **A full error taxonomy and fallback matrix** | `roadmap.md` §5.1 module 1.5 | **1** | The nine error classes with their fallbacks, each with a bound and a terminal condition | Every class is reachable in a test and produces the declared fallback. `BROKEN` **never** flows through as accepted |

### 5.2 The draft's M0–M9, mapped onto the MVP ladder

| Draft module | MVP | Where it landed | What changed |
|---|---|---|---|
| **M0** Environment detection and capability probing | **1** | Module 1.1 | Split into **capabilities** (what the runtime can do) and the **provider profile** (what the model can do), because they have different lifetimes |
| **M1** Ingestion pipeline (client-first) | **1** | Modules 1.2, 1.3 | Added the **structure tree** — the draft parsed; the roadmap must *structure*, because progressive disclosure (M2) needs it |
| **M2** Hierarchical summarization | **4** | Module 4.1 | The `log₂(n)` incremental-update criterion is kept **and** the context-rot regression test is added |
| **M3** Prompt compression and local cache | **4** | Modules 4.2, 4.4 | The draft's "40–60 % reduction" target became a **measured** quantity with a quality gate, because the compression library is **built, not depended on** (D-044) |
| **M4** Provider-specific optimization | **4** | Module 4.3 | The provider table is **corrected** — OpenAI's 1.25× write for GPT-5.6+, DeepSeek's 1–3.3 %, Gemini's per-hour storage, implicit-first caching |
| **M5** Multi-agent orchestration with persistent state | **3** | Modules 3.1–3.8 | The draft's SQLite store became **both stores with a defined direction of truth** (D-040), and the delegation gained **seventeen clauses** and a **gated topology decision** (D9) |
| **M6** Graph engineering and evidence-gated progression | **2 → 3** | Kernel modules 2.1–2.5, SDK module 3.1 | **Split across the boundary** (D-041): deterministic traversal in the kernel, evidence-gated policy in the SDK. This also closes the undone M5 |
| **M7** Telemetry and bottleneck detection | **6** | Modules 6.1–6.5 | The draft's 9 span kinds were **wrong** (AgentTelemetry's real nine differ); the five OTel does not define went into a documented private namespace (D-046) |
| **M8** Experimentation and simulation | **7 → 8** | Modules 7.1–7.6, 8.1–8.5 | Added the **safe-adaptation envelope** and the **Replay Gap** correction — the draft's "replay" is unsound if it re-asks the model |
| **M9** Error boundaries and fallback matrix | **1** | Module 1.5 | Kept verbatim as the nine classes; each gained a **bound** and a **terminal condition** |

### 5.3 The delivery gates, mapped

The draft's ten delivery gates map onto the plan as follows. **Every one is
now a scenario in the certification harness** (`simulations.md` §4), and
every one is an *exit gate* on an MVP.

| Draft gate | Where | Scenario |
|---|---|---|
| 1. Build | Every MVP | `pnpm build` clean — the repo's own gate |
| 2. Test | Every MVP | Per-module unit tests + integration tests for the orchestrator, the resume, and the fallback matrix |
| 3. Conformance | MVP 1 | **S-02** — identical evidence receipts in browser, Node and edge |
| 4. Evidence | MVP 1 | **S-03** — 50 claims, correct tiers, including invented quotes and expired receipts |
| 5. Cache | MVP 4 | **S-20** — measured hit rate, break-even status, and the disable recommendation |
| 6. Compression | MVP 4 | **S-22** — the quality threshold holds; a regression disables compression and logs the event |
| 7. Batch | MVP 4 | **S-21** — a partial failure reconciles per request |
| 8. Telemetry | MVP 6 | The bottleneck report names the top 3; domain success rates are present |
| 9. Resume | MVP 3 | **S-05** — a killed orchestrator resumes without duplicating work |
| 10. Documentation | Every MVP | **D-039 … D-049** in `docs/DECISIONS.md`, each with a context, a decision, rejected alternatives, evidence and consequences — and the guard that enforces it |

### 5.4 The capabilities named in the follow-up, and where each landed

| Capability | Where | MVP |
|---|---|---|
| **Bounded curiosity** — pattern-matched, budgeted, question-carrying exploration | `roadmap.md` §5.3.2 | 3 (module 3.7) |
| **Pattern matching** — a failure-signature → bounded-diagnostic-question catalogue | `roadmap.md` §5.3.2 | 3 (module 3.7) |
| **Time management — zoom in and zoom out** — two timescales, an explicit relationship | `roadmap.md` §5.3.1 | 3 (module 3.8) |
| **Browser automation** with efficiency and performance budgets | `roadmap.md` §5.5 | 5 (module 5.7) |
| **AI semantic search** over the learnings | `roadmap.md` §5.5, §5.9 | 5 (module 5.8) + 9 (module 9.7) |
| **A graph of nodes and relations** for the learnings | `roadmap.md` §5.9 | 9 (module 9.6) |
| **"Steal like an artist"** — the patterns mined from real source, lawfully | `docs/agent-sdk/platform-engineering.md` | — |
| **Self-scalable AI SDLC** — the loop that improves itself inside a machine-checked envelope | `roadmap.md` §10 | 7 + 9 |
| **A study-and-learn step** — deliberate practice with recorded practice and optimisation | `roadmap.md` §5.3.2 (the signature catalogue) and §5.9 (module 9.6) | 3 + 9 |

### 5.5 The gaps that remain, honestly

| Gap | Status |
|---|---|
| **The SDK has no code.** Every MVP is a plan. | **By design** — D-039 puts it in a separate repository, and the instruction was planning only. `docs/BACKLOG.md` P1-12 |
| **The graph engine does not exist.** | P1-13. The cheapest high-value item in the plan, and the only one that lands in this repository |
| **The two kernel contract changes** — `fallbackLegal` and the candidate-lifecycle event kinds | P1-10, P1-11. Both version frozen, certificate-bound contracts, so both need their own migration |
| **`ROADMAP.md` is a corrected strategy document, not a live status board** | P2-23 |
| **Two region bundles cannot ship** — Brazil and US-health, on `UNKNOWN` regulatory claims | P2-25 |
| **The platform patterns are documented but not scheduled** | P2-24 |
| **Every threshold in the plan is a `[GUESS]`** | P2-22 and the MVP durations. They become measured after MVP 1 ships and real velocity is observed |

---

## 6. What this plan deliberately does not do

| Not doing | Why |
|---|---|
| Writing any code | The instruction is "planning with my directions". This change contains **zero** implementation |
| Designing the UI | Explicit instruction. The plan records only the UI's **contract** — what it may show and what it may not claim |
| Choosing a single region | The request asked for "multi tier solutions with ready to go templates as per users persona and its compliance needs". That is the **region bundle** design: eight bundles, a compliance profile per bundle, and a selection mechanism — not a bet on one jurisdiction |
| Depending on a 0★–6★ repo | Every single-maintainer project named in the draft is wrapped behind an interface or reimplemented. See `substrate.md` §3 |
| Reimplementing the kernel's contracts in the SDK | The SDK projects over them. A second `EvidenceSchema` would be the exact failure PR #29's D-006 prevents |
| Rewriting `ROADMAP.md` wholesale | A correction and a rewrite are different kinds of work. The correction is done here; the rewrite is BACKLOG P2-23 |

---

## 7. Related documents

| Document | Owns |
|---|---|
| `docs/agent-sdk/roadmap.md` | The MVP ladder, the dependency DAG, the metrics, the before/after analysis |
| `docs/agent-sdk/substrate.md` | The seven-repo proven substrate, and the build-vs-depend decision per role |
| `docs/agent-sdk/tools.md` | The 18-tool surface, the two tiers, the eight region bundles |
| `docs/agent-sdk/simulations.md` | The simulation and certification framework |
| `docs/agent-sdk/README.md` | The SDK contract itself |
| `docs/agent-sdk/trust.md` | Identity, attestation, the commit-point protocol |
| `docs/agent-sdk/optimization.md` | The learning loop, the twelve gates, the nine signals |
| `docs/agent-sdk/economics.md` | Caching and batching, with the corrected provider table |
| `docs/DECISIONS.md` | Why each choice was made |
| `docs/EVIDENCE.md` | Every external claim, with a source URL and an access date |
| `docs/BACKLOG.md` | What is still open, classified |
