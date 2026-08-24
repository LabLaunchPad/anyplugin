# AnyPlugin Roadmap — the Worker Runtime

**Status:** strategy frozen, implementation not started. M0 is the next action.

This document supersedes the short checklist that used to live in `README.md`. It records what we are building, what we are deliberately *not* building, the thirteen milestones (M0–M12, plus M7a) that get us there, and the evidence that shaped them.

---

## 1. What we are building

Not another coding agent. Not another agent SDK. Not another MCP wrapper, memory product, or plugin marketplace.

**A coding-agent-agnostic worker-control layer** — a reliability substrate that surrounds an existing agent (Claude Code, OpenCode, Codex, Antigravity, Cursor, or none at all) and answers questions the agent cannot answer about itself:

```
What is this agent supposed to accomplish?
        ↓
What does it currently believe?
        ↓
Why does it believe that?
        ↓
What has it changed?
        ↓
What experience has it accumulated?
        ↓
What can invalidate previous conclusions?
        ↓
What must be rechecked?
        ↓
Can we safely continue?
```

The agents themselves are improving quickly and are a poor battlefield for a small team. The layer *around* the agent — what happens when work becomes long-running, stateful, risky, and consequential across sessions — is largely unoccupied.

### The separations that define the product

These are the load-bearing distinctions. Everything else follows from them.

| The model is not… | …which means |
| --- | --- |
| **MEMORY** | recall is a runtime primitive with provenance, not a context window |
| **KNOWLEDGE** | what is true is separate from what was said |
| **EXPERIENCE** | what happened under which conditions is recorded, not inferred |
| **AUTHORITY** | the agent does not get to declare its own work correct |
| **VERIFIER** | verification is deterministic and runs outside the model |
| **EXECUTION ENVIRONMENT** | isolation is owned by us, not borrowed from the host |

Corollaries that keep us honest about the host agent's own features:

- Claude Code memory / `CLAUDE.md` → **optional convenience.** Our Worker State → **authoritative.**
- A Skill → **workflow instruction.** Our Verification Engine → **actual verification.**
- A subagent → **reasoning.** Our Evidence Ledger → **provenance.**

Without these, the product degenerates into a fancy prompt pack.

---

## 2. Architecture

```
Agent  (Claude Code / OpenCode / Codex / Antigravity / CI / bare CLI)
        │
        ▼
   Adapter                ← thin. The AnyPlugin plugin is ONE adapter among several.
        │
        ▼
   Worker Runtime Core    ← owns all truth. Must run with zero agents installed.
        │
   Contract · State · EventLog · Evidence · Decision · Experience
   Graph · Invalidation · Verification · Execution · Certificate
```

### The non-negotiable rule

> AnyPlugin may provide lifecycle hooks, agent/tool integration, commands, and adapter APIs. It must **never** own evidence, decisions, experience, the dependency graph, invalidation state, certificates, or authoritative worker state.

AnyPlugin is the **distribution mechanism**. The runtime is the **product**. Experience + evidence + decision-integrity is the **moat**. Confusing these is how we end up locked into one agent vendor.

### The architectural baseline

Hooks are **accelerators, never correctness mechanisms.** Per F5/F6 a target may offer no hooks at all — and `opencode@v2` cannot even take MCP without a matrix change — so correctness may never depend on either.

The layers, floor first:

| Layer | Guarantee | Availability |
| --- | --- | --- |
| **Runtime's own CLI** | Complete runtime operation | **Always.** No agent, no AnyPlugin, no matrix entry. This is the irreducible floor. |
| **MCP** | Richest agent-facing integration | Where the capability matrix supports it — **not `opencode@v2` today** (F6). |
| **Hooks** | Automatic capture without user action | Where `NATIVE`. Convenience only. |

Anything a hook does must remain reachable through the CLI. If a capability exists *only* behind a hook, that is a design defect.

### Locked dependency direction

```
                 ┌───────────────────────┐
                 │  Worker Runtime       │   deterministic kernel
                 │  kernel               │   knows nothing about any agent
                 └───────────┬───────────┘
                             ▲
          ┌──────────────────┼──────────────────┐
          │                  │                  │
       CLI / MCP      Agent adapters       Integrations
          │                  │                  │
        human        OpenCode / Claude       AnyPlugin
```

**Dependencies point inward, never outward.** The kernel knows nothing about OpenCode, Claude Code, Codex, Antigravity, AnyPlugin, MCP transport, or hooks. Everything agent-shaped is a replaceable execution client sitting *above* it.

Two shapes are permanently forbidden:

- `AnyPlugin → Worker Runtime → AnyPlugin` — any cycle back into the distribution layer.
- `Agent adapter → kernel internals` — adapters use the public contract, never reach inside.

This is the property the whole strategy rests on: **agents are replaceable execution clients; the runtime owns state, evidence, authority, verification, experience, and recovery.** M1 is where these become frozen contracts, which is why they are locked before M1 rather than during it.

### Package boundary

The runtime lives at `packages/worker-runtime/` — same pnpm workspace (splitting repos now would cost more than it buys), **hard package boundary**:

- It **must not** import from `cli/` or `adapters/`.
- It ships its own standalone CLI.
- A test asserts it passes its full suite with **no agent installed**.

Enforced by executable guards in `core/src/boundaries/package-boundary.test.ts`, which classify every invariant as **ARMED** (enforcement exists, target absent, invariant *not* exercised), **PASSED** (target exists and was actually checked), or **FAILED**. ARMED is never reported as PASSED — a vacuously-green check manufactures confidence. The three runtime guards are ARMED today and the test **fails deliberately** the moment `packages/worker-runtime/` appears, forcing a conscious flip to PASSED instead of a silent slide from "never checked" to "checked and fine".

⚠️ **`packages/` is not currently a workspace location — this is a setup step, not an existing property.** `pnpm-workspace.yaml` declares exactly `core`, `adapters/*`, `plugins/*`, `cli`; there is no `packages/*` glob and no `packages/` directory, and root `tsconfig.json` lists seven references, none under `packages/`. **M1's first task** is adding the workspace glob and the tsconfig reference.

### Language: TypeScript

Decided, and recorded here so it is not silently revisited. The hook path is not negotiable — all four agents invoke `node runner.js <hook-id>` as a subprocess, and a dedicated CI job asserts the runtime stays dependency-free Node ≥20. A Python core would add a hard interpreter dependency to every install of a plugin whose entire value proposition is *"installs natively into every agent"*, plus per-hook interpreter startup against Antigravity's 30-second clamp.

The advantages usually cited for Python are already met in-repo: `zod` (with a JSON-Schema mirror kept honest by a sync test) for schemas, `vitest` for tests, `node:child_process` for subprocesses. Container and VM execution backends stay language-agnostic either way.

The boundary that actually matters — *AnyPlugin never owns truth* — is enforced by module boundaries and the standalone-CLI test, not by choice of language.

---

## 3. The primitive stack

Twelve primitives — the nine drawn below, plus **Event Log** (§3 of the kernel doc, the substrate under Worker State), **Execution Backend**, and **Agent Adapter**, which sit outside this vertical stack. All twelve are enumerated as numbered sections in [`docs/WORKER-RUNTIME-KERNEL.md`](docs/WORKER-RUNTIME-KERNEL.md). The set is frozen for M1; additions require evidence from real use.

```
                    AI WORKER
                       │
                ┌──────▼───────┐
                │ Work Contract│   goal · scope · constraints · success conditions
                └──────┬───────┘
        ┌──────────────▼──────────────┐
        │        Worker State         │   goal / phase / status / assumptions
        └──────────────┬──────────────┘
        ┌──────────────▼──────────────┐
        │      Experience Ledger      │   successes / failures / observations
        └──────────────┬──────────────┘
        ┌──────────────▼──────────────┐
        │       Evidence Ledger       │   facts / provenance / age / authority
        └──────────────┬──────────────┘
        ┌──────────────▼──────────────┐
        │       Decision Ledger       │   decision / rationale / dependencies
        └──────────────┬──────────────┘
        ┌──────────────▼──────────────┐
        │      Dependency Graph       │   files / symbols / tests / decisions
        └──────────────┬──────────────┘
        ┌──────────────▼──────────────┐
        │    Invalidation Engine      │   stale / affected / reopen
        └──────────────┬──────────────┘
        ┌──────────────▼──────────────┐
        │    Verification Engine      │   deterministic checks / tests / diff
        └──────────────┬──────────────┘
        ┌──────────────▼──────────────┐
        │        Certificate          │   evidence + state + outcome, bound by hash
        └─────────────────────────────┘
```

An orchestrator sits above this and **consumes** the primitives. The orchestrator is not the moat and is not on the critical path.

Full domain model: [`docs/WORKER-RUNTIME-KERNEL.md`](docs/WORKER-RUNTIME-KERNEL.md).

### The loop we are ultimately building

```
WORK → OBSERVE → RECORD → LEARN → REMEMBER → ACT → VERIFY → UPDATE → NEXT WORK
```

and, when reality moves underneath us:

```
REALITY CHANGE → EVIDENCE INVALIDATED → DEPENDENCIES TRAVERSED
   → DECISIONS REOPENED → CONTEXT RECOMPILED → RE-VERIFY → NEW EXPERIENCE
```

---

## 4. Starting evidence

An audit was run before this roadmap was written (2026-08-24, against `main` @ `0f8e22d`). M0 still executes formally to produce its artifacts, but it starts from these verified findings rather than from zero. Every claim below was confirmed by direct reading.

**Baseline.** The repo is unusually clean. A `TODO|FIXME` search across all `.ts`/`.md` sources hits **two files, both documentation** (`knowledge/agents/opencode.md`, `knowledge/log.md`). No `NotImplemented`, no stubbed logic — the one `export const _placeholder = true;` (`plugins/knowledge/src/index.ts:1`) is a tsc project anchor, not an unimplemented path. 134 tests across 23 test files, green, over 7 workspace packages.

### Live bugs that gate specific milestones

**F1 — OpenCode silently discards every `block` decision. Gates M7, M11.**
`adapters/opencode/src/index.ts:183` — `maybeRun` only parses stdout `if (result.code === 0 && result.stdout.trim())`. But a `block: true` result exits **2** (`plugins/knowledge/runtime/runner.js:175`). The canonical block channel is therefore a **no-op on OpenCode**, despite `core/src/capabilities/matrix.ts` marking those hooks `NATIVE`. Additionally `tool.execute.before` only ever reads `updatedInput` — it never consults `block` at all.

Scope precisely: this is the `block: true` channel on tool execution. **Permission *denial* still works** through the separate `permissionDecision` channel, which exits 0 and is consumed at `adapters/opencode/src/index.ts:205-210`. M7 must not rebuild a channel that already functions.

**F2 — OpenCode loses a hook on the `turn-stop`/`session-end` collision. Gates M11.**
Both canonical events map to `session.idle`. The shim builds its bridge as `Object.fromEntries(bridge.map((b) => [b.opencode, b.id]))` (`adapters/opencode/src/index.ts:142`) — keyed by **native** name, so one hook is silently dropped, last-wins. The runtime adapter needs both.

**F3 — Non-atomic whole-file rewrite, three instances. Gates M2.**
`plugins/knowledge/plugin/hooks/okf-turn-stop.mjs:21-36` does an unlocked, non-atomic `readFileSync` → mutate → `writeFileSync` on `log.md`; concurrent turns overwrite each other.

This is a **class, not an instance** — per `ENGINEERING_LEDGER.md`'s VERIFY → FIX → **ERADICATE THE CLASS** methodology, all three must be named or M2 will fix the copy and ship the original:

1. `plugins/knowledge/plugin/hooks/okf-turn-stop.mjs:21-36` — the hook (the only one currently wired to an agent).
2. `core/src/okf/index.ts:431-451` — `appendLog()`, the identical routine as exported **public `core` API**. Currently has no callers, which is the only reason it has not bitten yet.
3. `core/src/okf/index.ts:350-424` — `regenerateIndexes()`, a second non-atomic whole-file rewrite.

The event log **must not** copy this pattern.

> **Corrected by measurement (F10, `ENGINEERING_LEDGER.md` AP-018).** This finding originally prescribed
> *"atomic `O_APPEND` single writes"* as the remedy. That remedy does not hold: **POSIX bounds `O_APPEND`
> write atomicity at `PIPE_BUF` (4096 bytes), and Windows guarantees no equivalent at all** — both are
> platforms this repo tests. Implemented as first written, M2 would have inherited the very class F3
> identifies while believing itself immune. The finding stands; the remedy is replaced by
> `EVENT_WRITE_CONTRACT v1`, which states observable guarantees instead of the word *atomic* and is
> satisfied by a mechanism chosen from measurement.

**F4 — Two divergent implementations of one output protocol. Gates M11.**
`core/src/events/index.ts:121` early-returns on `result.raw`, discarding every other field. `runner.js:160` instead merges raw, then applies `block` *after* it (`runner.js:162-170`) — so in the runner `block` wins over `raw`, while in core `raw` discards everything. Two different precedence rules for one protocol.

The payload diverges in both directions: the runner omits `event` and `nativeEvent`, which `HookPayload` declares **required** (`core/src/events/index.ts:54-55`), plus optional `stopHookActive`; and it *adds* `hookId`, `pluginRoot`, `intensityMode` (`runner.js:78-80`) that `HookPayload` does not declare. Needs one shared conformance test, not a one-sided patch.

**F8 — The runner may exit 2 where Antigravity's protocol expects 0. Gates M11.**
`AGENTS.md:62` documents the translation as *"`block` → `decision: "block"` + exit code 2 (Antigravity: `decision: "deny"`, **exit 0 semantics** per its protocol)"*. But `runner.js:175` is `process.exit(result.block ? 2 : 0)` — unconditional, with **no platform branch** — even though the lines immediately above it (`:162-170`) *do* branch on `platform === "antigravity"` for the payload shape. Either the runner exits 2 where Antigravity expects 0, or `AGENTS.md` is wrong. Same translation layer as F1 and F4, on the one agent whose protocol the docs single out. **M0 resolves which.**

### Hard capability limits that shape the design

**F5 — Antigravity has no `session-end`.** `core/src/capabilities/matrix.ts:100` marks it `UNSUPPORTED`. Record work at **`turn-stop`** instead — it maps everywhere (`Stop`/`Stop`/`Stop`/`session.idle`), which is exactly what the existing `okf-turn-stop` hook already does.

`UNSUPPORTED` behaves **differently at two layers**, and conflating them will mislead an implementer:

- **At the CLI capability gate** (`cli/src/index.ts:78-83`) it is a hard build error — and the throw is **not scoped per agent**, so a single `session-end` hook aborts the *entire four-agent build*, not just the Antigravity bundle.
- **At the pure adapter layer** — the layer M11 actually adds to — it is a **warning, and the hook is silently dropped**: `adapters/antigravity/src/index.ts:56-58` and `adapters/opencode/src/index.ts:34-36` push to `warnings` and `continue`, with no throw. `adapters/opencode/src/opencode.test.ts:76` names this behaviour explicitly. A direct `emitAntigravity(...)` call carrying a `session-end` hook **succeeds and drops it**.

**F6 — Hooks cannot be assumed, and neither can MCP.** OpenCode has no `prompt-submit` (`matrix.ts:69`), and `opencode@v2` marks every hook `UNSUPPORTED` (`matrix.ts:82`) — only `skills` and `knowledge` remain `NATIVE`.

**The `opencode@v2` row does not list `mcp.stdio` or `mcp.http` at all.** `supports()` returns `row[capability]?.level ?? "UNKNOWN"` (`matrix.ts:118-122`), and `cli/src/index.ts:84` turns `UNKNOWN` into a hard build error. Since `requiredCapabilities` adds `mcp.*` whenever a manifest declares any MCP server (`cli/src/index.ts:59-61`), **a runtime plugin declaring MCP cannot be built for `opencode@v2` at all.** An "MCP fallback for hookless targets" therefore fails closed on the very target that motivates it. See the architectural baseline in §2 — the irreducible floor is the runtime's **own CLI**, not MCP.

**Be careful about *why* v2 is `UNSUPPORTED`.** The code comment at `matrix.ts:79-81` says v2 "dropped the v1 hook API", but this repo's own evidence record walks that back — `docs/PATTERNS.md:21` states the matrix keeps v2 hooks `UNSUPPORTED` *"**not because v2 dropped hooks (unverifiable)**, but because no versioned API contract exists to target; `UNKNOWN`/unversioned fails closed per spec §2.2"*, and `matrix.ts:64-66` records that the official docs show **no documented v1/v2 split**. `opencode@v2` is a **fail-closed placeholder for an unversioned surface**, not an established hookless product. The design conclusion — never *require* hooks — is sound and rests on fail-closed policy; it must not be justified by a claim about OpenCode's roadmap that this repo has already labelled unverifiable.

**F7 — `runtime.failurePolicy` is specified but does not exist, and three documents disagree about it.** `CORE-INVARIANTS-V2.md` §1.3.3 defines `failurePolicy: blocking`; grep finds **zero occurrences outside that document**.

The unresolved part is not the missing implementation — it is that the repo's documents already contradict each other, and M7a walks straight into it:

- `CORE-INVARIANTS-V2.md:104` says `failurePolicy: blocking` **"flips handler-throw to exit 2"** — i.e. an unhandled crash *does* deny the host action.
- `CLAUDE.md:49` and `AGENTS.md:63` state the rule **absolutely**, with no such exception: *"Runtime failures are always non-blocking … must never break the host agent."*

So `OBSERVE / WARN / REQUIRE / BLOCK` is one of two different things, and which one is a real design question, not a formatting choice:

1. the four-mode generalisation of the §1.3.3 switch — in which case `BLOCK` inherits crash-blocks-host and the absolute rule in `CLAUDE.md`/`AGENTS.md` **is** weakened and must be amended; or
2. a distinct mechanism defined over *concern outcomes* (a verification returned FAIL) rather than over *handler throws* — in which case F7's "extension, not invention" framing is wrong and M7a is new design.

**M7a owns reconciling all three documents** and must state which reading it implements. This roadmap does not pre-judge it.

### Existing machinery to reuse, not rebuild

- `cli/src/journal.ts` — `preInstallHash` / `postInstallHash` / `classifyJournalEntry` is *already* the Certificate and Checkpoint model. Reuse the pattern; do not reinvent hashing and tamper detection.
- `core/src/fs/safe-path.ts` — every runtime path goes through `resolveAuthorizedPath`. Repo invariant, not a preference.
- `cli/src/state.ts` — zod `safeParse` on *read*, returning `null` on anything malformed. Every persisted runtime record follows this "persisted input is untrusted" precedent.
- `core/src/capabilities/matrix.ts` — fail-closed `UNKNOWN` negotiation. The runtime needs its own; copy the semantics exactly.
- `plugins/knowledge/plugin/hooks/okf-session-start.mjs` — already the experience-*retrieval* slot (today it injects only a pointer). M11 fills it rather than adding a hook.

### Relationship to the OKF knowledge layer

**Sit beside, promote in.** OKF v0.2 (`core/src/okf/index.ts`) has a **flat namespace** (ids are bundle-relative paths, `core/src/okf/index.ts:35`; directories nest but records do not relate), is markdown-only and read-mostly, with *derived* trust (`trustTier()`), a single coarse `stale_after` instant, and provenance pointing **outward** at URLs. It has no slot for record-to-record relations (evidence→decision) and no per-record outcome.

On writes, be precise: **the MCP surface is read-only** (`okf_index` / `okf_read` / `okf_search`, `plugins/knowledge/runtime/mcp-server.js:138-176`), and there is **no machine-write path for concept records** — but `core` *can* write bundle files: `regenerateIndexes()` (`core/src/okf/index.ts:350`, write at `:424`, exposed as `anyplugin okf-reindex`) and `appendLog()` (`:431`, write at `:451`). The "sit beside" decision rests on the absence of *concept-record* writes and of relations, not on OKF being write-free.

The ledgers are append-heavy, relational, and machine-written; forcing them into OKF frontmatter would fit badly. Keep them separate and make **promotion into OKF the curation step** — which is precisely what `plugins/knowledge/plugin/agents/knowledge-curator.md` and the `okf-turn-stop` comment already gesture at. Promoted facts reuse `verified[]` with `process:` actors.

---

## 5. Milestones

Each milestone follows the same shape — **Goal / Non-goals / Truth constraint / Acceptance / Artifact** — and ends in a machine-checkable exit condition. A milestone that fails its gate is fixed before the next one starts.

**Two different things gate a milestone**, and the table keeps them in separate columns. *Depends on* names milestones that must finish first. *Constraints* names findings that must be **honoured** — F3 says don't copy a pattern; F5/F6 say a capability does not exist. A constraint is never "satisfied," so it can never be a prerequisite.

| # | Milestone | Exit condition (machine-checkable) | Depends on | Constraints |
|---|---|---|---|---|
| **M0** | Repository truth | 4 audit artifacts exist; F1–F8 confirmed or corrected; **zero source diffs** | — | — |
| **M1** | Freeze kernel contract | Workspace glob + tsconfig reference added; JSON Schemas + contract tests green; deterministic hash; invalid objects rejected; boundary tests armed | M0 | — |
| **M2** | Worker State + Contract | Replaying the event log reconstructs **byte-identical** state; illegal transitions rejected; **`EVENT_WRITE_CONTRACT v1` satisfied** (not "atomic append" — see F3's correction); all three F3 sites addressed or explicitly deferred | M1 | F3 |
| **M3** | Evidence Ledger | Invalidating E1 preserves history *and* flips current validity; immutability test | M1 | — |
| **M4** | Decision + Experience | `OBSERVATION` / `LESSON` / `HYPOTHESIS` / `VERIFIED_KNOWLEDGE` distinction proven by test — a lesson must **never** auto-promote to authoritative evidence | M3 | — |
| **M5** | Dependency Graph | Deterministic traversal across branching, multi-hop, cycles, disconnected components; byte-identical output for identical input | M1 | — |
| **M6** | Invalidation Engine | E1→Claim→Decision→Work: Decision `STALE`, Work `REOPENED`, unrelated decisions untouched; replacement evidence restores validity | M5 | — |
| **M7** | Verification Engine | Every verifier returns PASS/FAIL/BLOCKED; false-positive-resistance test proves missing evidence never becomes PASS | M3 | F1 |
| **M7a** | Failure-policy ladder | Reconciles `CLAUDE.md` / `AGENTS.md` / `CORE-INVARIANTS-V2.md` §1.3.3 and states which reading it implements; `OBSERVE`/`WARN`/`REQUIRE`/`BLOCK` implemented, E2E per mode | M7 | F7 |
| **M8** | Experience + failure recovery | Execution reconstructable from records; the eight failure classes enumerated in the kernel doc all reachable in test; no unevidenced root-cause inference | M4, M7 | — |
| **M9** | Execution isolation | `LocalProcessBackend` with cwd isolation, env allowlist, timeout, artifact capture; a VM backend must be addable **without touching** State/Evidence/Decision/Verification | M2 | — |
| **M10** | Certificate | Tampering with **any** referenced artifact fails verification; golden + mutation tests; verify path independent of create path | M3, M6, M7 | I4 |
| **M11** | Agent adapter | Runtime passes its full suite with **zero agents installed and the CLI alone**; every hook-reachable capability also reachable via CLI | M1, M9 | F1, F2, F4, F5, F6, F8 |
| **M12** | Falsification experiment | A real bounded task driven end to end, then deliberately broken and recovered. Every transition backed by an artifact | M10, M11 | — |

**M11's exit condition was corrected.** It previously required the adapter to work "hooks-less (CLI + MCP only) against `opencode@v2`" — which is **impossible**, because that matrix row omits `mcp.*` entirely and `UNKNOWN` is a hard build error (F6). The bare CLI is the only floor that always holds. Making MCP work on `opencode@v2` is a **capability-matrix audit and extension** — a separate prerequisite task, not something the runtime can do.

### M0 — the next action

> **Goal.** Establish the evidence-backed implementation baseline for the Worker Runtime.
> **Non-goals.** No implementation. No architecture changes. No source modification.
> **Truth constraint.** Every finding references a concrete `file:line`. No speculative claims.
> **Acceptance.** F1–F8 each independently confirmed or corrected; the capability boundary of the current repo is established; tests run.
> **Artifact.** `docs/repository-truth.md`, `artifacts/repository-inventory.json`, `artifacts/capability-matrix.json`, `artifacts/closure-gaps.json`.

Determine what already exists for each of: WorkContract, WorkerState, Experience, Evidence, Decision, DependencyGraph, Invalidation, Verification, execution isolation, certificates, persistence, hooks, skills, agents, MCP, plugin integration. Explicitly flag **anything that would make the runtime accidentally depend on a host agent's capability instead of owning it.**

The M0 artifacts describing this repo's own audited capability boundary are a genuine fit for the OKF bundle (`type: Reference`, `verified[]` with a `process:` actor) and would be its first real `verified[]` usage — today every concept in `knowledge/` is trust tier `unverified`.

### M12 — the falsification gate, and it is binding

```
real bounded task → contract → baseline evidence → decision
     → implement → verify → certificate
          → deliberately invalidate one authoritative dependency
               → impact traversal → decision STALE → work REOPENED
                    → re-verify → new certificate
```

The question M12 answers is not "did we build it" but:

> Does a developer using Claude Code / OpenCode / Codex for a week become **measurably** safer or faster because the system remembers verified experience and detects stale decisions?

Measure with and without the plugin: task success, time, tokens, repeated mistakes, rework, experience reuse, stale-decision detection, verification failures caught.

**No efficacy claim ships until M12 produces artifacts. A null result is grounds to kill or pivot the product.** This repo already refused to publish unmeasured benchmark numbers once — `docs/PATTERNS.md:12` records benchmarking as **DEFERRED (honestly)**, because *"a harness without real runs would fabricate numbers — deferred until a benchmark budget exists. No results claimed."* That standard carries forward here.

---

## 6. What we are deliberately not building

Scope discipline is the difference between shipping and dissolving. A 2–5 person team cannot simultaneously rebuild OpenHands, LangGraph, Claude Code, Docker, a memory vendor, an observability stack, and CI.

**Not yet:** multi-agent swarm · 20-agent orchestration · vector database · RAG platform · cloud dashboard · enterprise RBAC · SaaS billing · VMware integration · custom model or fine-tuning · autonomous long-running employee · generalized ontology · giant memory system · Kubernetes runtime · "AI operating system".

**Not ever, as products:** another LLM router · another vector memory DB · another MCP server collection · another coding agent · another Docker wrapper · another generic agent SDK · another plugin marketplace.

For execution isolation specifically: define the `ExecutionBackend` abstraction and implement `LocalProcessBackend` **only**. The abstraction belongs to us; the infrastructure implementation does not. Docker → Apple Virtualization → Firecracker → remote workers get added later, behind the same interface, without touching the primitives.

---

## 7. Beyond M12

Only after M12 returns a positive result does packaging become a question worth asking.

```
Stage 1  Developer tool      free / OSS — AnyPlugin + reliability plugin
Stage 2  Team runtime        shared experience, shared evidence, team policies
Stage 3  Vertical workers    Coding · QA · Research · DevOps · Marketing
Stage 4  AI employee         goal → worker → runtime → evidence → verified outcome
```

The moat is not any single feature — each is individually copyable. It is the **combination**: agent-neutral + persistent state + experience + evidence provenance + decision dependency graph + invalidation + verification + reproducible workspace. And underneath that, the **accumulated historical graph**: tasks → experiences → evidence → outcomes → failure patterns → repair patterns → validated operational knowledge. That is hard to replicate not because the software is clever but because the graph only accrues through real work.

We are our own first customer. Every real project run through this runtime generates evidence about whether it is actually valuable.

---

## 8. Prior AnyPlugin roadmap items

Still wanted, not superseded by the above:

- [ ] npm publish — `anyplugin` CLI + `@lablaunchpad/*` packages
- [x] `anyplugin init` — scaffold a new plugin from `templates/starter`
- [ ] `anyplugin status` / `doctor` — installed-plugin report, agent trust diagnostics
- [ ] Toolkit plugins — git workflow, test orchestration as second-party examples
- [ ] Import path — convert an existing Claude Code plugin to the canonical manifest
- [ ] Codex marketplace emission, per-agent capability gating, HTTP-MCP auth fields
- [ ] Logo, demo GIF, docs site, i18n
