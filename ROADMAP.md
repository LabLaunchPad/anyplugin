# AnyPlugin Roadmap — the Worker Runtime

**Status:** strategy frozen, implementation not started. M0 is the next action.

This document supersedes the short checklist that used to live in `README.md`. It records what we are building, what we are deliberately *not* building, the twelve milestones that get us there, and the evidence that shaped them.

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

### Package boundary

The runtime lives at `packages/worker-runtime/` — same pnpm workspace (splitting repos now would cost more than it buys), **hard package boundary**:

- It **must not** import from `cli/` or `adapters/`.
- It ships its own standalone CLI.
- A test asserts it passes its full suite with **no agent installed**.

### Language: TypeScript

Decided, and recorded here so it is not silently revisited. The hook path is not negotiable — all four agents invoke `node runner.js <hook-id>` as a subprocess, and a dedicated CI job asserts the runtime stays dependency-free Node ≥20. A Python core would add a hard interpreter dependency to every install of a plugin whose entire value proposition is *"installs natively into every agent"*, plus per-hook interpreter startup against Antigravity's 30-second clamp.

The advantages usually cited for Python are already met in-repo: `zod` (with a JSON-Schema mirror kept honest by a sync test) for schemas, `vitest` for tests, `node:child_process` for subprocesses. Container and VM execution backends stay language-agnostic either way.

The boundary that actually matters — *AnyPlugin never owns truth* — is enforced by module boundaries and the standalone-CLI test, not by choice of language.

---

## 3. The primitive stack

Twelve primitives. This set is frozen for M1; additions require evidence from real use.

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

**Baseline.** The repo is unusually clean. A `TODO|FIXME` search across all `.ts`/`.md` sources hits **two files, both documentation** (`knowledge/agents/opencode.md`, `knowledge/log.md`). No stubs, no `NotImplemented`, no placeholder returns. 134 tests green across 8 workspace projects.

### Live bugs that gate specific milestones

**F1 — OpenCode silently discards every `block` decision. Gates M7, M11.**
`adapters/opencode/src/index.ts:183` — `maybeRun` only parses stdout `if (result.code === 0 && result.stdout.trim())`. But a `block: true` result exits **2** (`plugins/knowledge/runtime/runner.js:175`). The canonical block channel is therefore a **no-op on OpenCode**, despite `core/src/capabilities/matrix.ts` marking those hooks `NATIVE`. Additionally `tool.execute.before` only ever reads `updatedInput` — it never consults `block` at all. A Verification Engine that cannot block is decorative, so this must be fixed before M7 ships.

**F2 — OpenCode loses a hook on the `turn-stop`/`session-end` collision. Gates M11.**
Both canonical events map to `session.idle`. The shim builds its bridge as `Object.fromEntries(bridge.map((b) => [b.opencode, b.id]))` (`adapters/opencode/src/index.ts:142`) — keyed by **native** name, so one hook is silently dropped, last-wins. The runtime adapter needs both.

**F3 — The only existing automated write is clobber-prone. Gates M2.**
`plugins/knowledge/plugin/hooks/okf-turn-stop.mjs:21-36` does an unlocked, non-atomic `readFileSync` → mutate → `writeFileSync` on `log.md`. Concurrent turns overwrite each other. The event log **must not** copy this pattern — it requires atomic `O_APPEND` single writes.

**F4 — Two divergent implementations of one output protocol. Gates M11.**
`core/src/events/index.ts:121` early-returns on `result.raw`, discarding every other field; `runner.js:160` instead does `Object.assign(out, result.raw)` after building them. The runner's payload also omits `event` / `nativeEvent` / `stopHookActive`, which core's `HookPayload` declares. Needs a shared conformance test, not a patch to one side.

### Hard capability limits that shape the design

**F5 — Antigravity has no `session-end`.** `core/src/capabilities/matrix.ts:100` marks it `UNSUPPORTED`, which is a **hard build error**, not a warning. A runtime plugin declaring a session-end hook is *unbuildable for Antigravity*. Record work at **`turn-stop`** instead — it maps everywhere (`Stop`/`Stop`/`Stop`/`session.idle`), which is exactly what the existing `okf-turn-stop` hook already does.

**F6 — Hooks cannot be assumed at all.** OpenCode has no `prompt-submit` (`matrix.ts:69`, `UNSUPPORTED`, hard build error), and **`opencode@v2` marks *every* hook `UNSUPPORTED`** (`matrix.ts:82`) — only `skills` and `knowledge` remain `NATIVE`. Consequence: **the runtime must be fully usable through CLI + MCP with no hooks whatsoever.** This reinforces the "runs without any agent" rule and is a stated M11 acceptance test, not an afterthought.

**F7 — `runtime.failurePolicy` is specified but does not exist.** `CORE-INVARIANTS-V2.md` §1.3.3 defines `failurePolicy: blocking` (flip handler-throw to exit 2); grep finds **zero occurrences outside that document**. The `OBSERVE / WARN / REQUIRE / BLOCK` ladder this runtime needs is the four-mode generalisation of that already-specified two-mode switch — an extension, not an invention. Tracked as **M7a**.

### Existing machinery to reuse, not rebuild

- `cli/src/journal.ts` — `preInstallHash` / `postInstallHash` / `classifyJournalEntry` is *already* the Certificate and Checkpoint model. Reuse the pattern; do not reinvent hashing and tamper detection.
- `core/src/fs/safe-path.ts` — every runtime path goes through `resolveAuthorizedPath`. Repo invariant, not a preference.
- `cli/src/state.ts` — zod `safeParse` on *read*, returning `null` on anything malformed. Every persisted runtime record follows this "persisted input is untrusted" precedent.
- `core/src/capabilities/matrix.ts` — fail-closed `UNKNOWN` negotiation. The runtime needs its own; copy the semantics exactly.
- `plugins/knowledge/plugin/hooks/okf-session-start.mjs` — already the experience-*retrieval* slot (today it injects only a pointer). M11 fills it rather than adding a hook.

### Relationship to the OKF knowledge layer

**Sit beside, promote in.** OKF v0.2 (`core/src/okf/index.ts`) is flat, file-per-concept, markdown-only and read-mostly, with *derived* trust (`trustTier()`), a single coarse `stale_after` instant, and provenance pointing **outward** at URLs. It has no slot for record-to-record relations (evidence→decision), no per-record outcome, and no machine-write path — the MCP server exposes `okf_index` / `okf_read` / `okf_search` only, all read-only.

The ledgers are append-heavy, relational, and machine-written; forcing them into OKF frontmatter would fit badly. Keep them separate and make **promotion into OKF the curation step** — which is precisely what `agents/knowledge-curator.md` and the `okf-turn-stop` comment already gesture at. Promoted facts reuse `verified[]` with `process:` actors.

---

## 5. Milestones

Each milestone follows the same shape — **Goal / Non-goals / Truth constraint / Acceptance / Artifact** — and ends in a machine-checkable exit condition. A milestone that fails its gate is fixed before the next one starts.

| # | Milestone | Exit condition (machine-checkable) | Gated by |
|---|---|---|---|
| **M0** | Repository truth | 4 audit artifacts exist; F1–F7 confirmed or corrected; **zero source diffs** | — |
| **M1** | Freeze kernel contract | JSON Schemas + contract tests green; deterministic hash; invalid objects rejected | M0 |
| **M2** | Worker State + Contract | Replaying the event log reconstructs identical state; illegal transitions rejected; **atomic append** | F3 |
| **M3** | Evidence Ledger | Invalidating E1 preserves history *and* flips current validity; immutability test | M1 |
| **M4** | Decision + Experience | `OBSERVATION` / `LESSON` / `HYPOTHESIS` / `VERIFIED_KNOWLEDGE` distinction proven by test — a lesson must **never** auto-promote to authoritative evidence | M3 |
| **M5** | Dependency Graph | Deterministic traversal across branching, multi-hop, cycles, disconnected components; byte-identical output for identical input | M1 |
| **M6** | Invalidation Engine | E1→Claim→Decision→Work: Decision `STALE`, Work `REOPENED`, unrelated decisions untouched; replacement evidence restores validity | M5 |
| **M7** | Verification Engine | Every verifier returns PASS/FAIL/BLOCKED; false-positive-resistance test proves missing evidence never becomes PASS | F1 |
| **M7a** | Failure-policy ladder | `OBSERVE`/`WARN`/`REQUIRE`/`BLOCK` implemented, E2E per mode; extends `CORE-INVARIANTS-V2.md` §1.3.3 | F7 |
| **M8** | Experience + failure recovery | Execution reconstructable from records; 8-way failure classification; no unevidenced root-cause inference | M4, M7 |
| **M9** | Execution isolation | `LocalProcessBackend` with cwd isolation, env allowlist, timeout, artifact capture; a VM backend must be addable **without touching** State/Evidence/Decision/Verification | M2 |
| **M10** | Certificate | Tampering with **any** referenced artifact fails verification; golden + mutation tests; verify path independent of create path | M3, M6, M7 |
| **M11** | Agent adapter | Runtime passes its full suite with **zero agents installed**; adapter works hooks-less (CLI + MCP only) against `opencode@v2` | F1, F2, F4, F5, F6 |
| **M12** | Falsification experiment | A real bounded task driven end to end, then deliberately broken and recovered. Every transition backed by an artifact | M10, M11 |

### M0 — the next action

> **Goal.** Establish the evidence-backed implementation baseline for the Worker Runtime.
> **Non-goals.** No implementation. No architecture changes. No source modification.
> **Truth constraint.** Every finding references a concrete `file:line`. No speculative claims.
> **Acceptance.** F1–F7 each independently confirmed or corrected; the capability boundary of the current repo is established; tests run.
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

**No efficacy claim ships until M12 produces artifacts. A null result is grounds to kill or pivot the product.** This repo already refused to publish unmeasured benchmark numbers once — `docs/PATTERNS.md` row 6 records benchmarking as *"DEFERRED (honestly) — a harness without real runs would fabricate numbers."* That standard carries forward here.

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
