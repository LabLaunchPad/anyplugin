# Worker Runtime — kernel domain model

Input to **M1** (freeze the kernel contract). See [`../ROADMAP.md`](../ROADMAP.md) for strategy, milestones, and the audit findings referenced here as F1–F7.

**Status:** design input, not a specification. M1 turns this into `schemas/*.schema.json` plus executable contract tests, and M1 is free to correct anything here that does not survive contact with implementation.

## Design rules

1. **Every field must have a concrete runtime purpose.** No field exists because it sounds useful. If nothing reads it, it does not ship.
2. **Records are immutable.** Correction and invalidation append new events; history is never mutated in place.
3. **Persisted input is untrusted.** Every record is zod-`safeParse`d on read and yields `null` on anything malformed, following the precedent in `cli/src/state.ts`.
4. **Every path goes through `resolveAuthorizedPath`** (`core/src/fs/safe-path.ts`). Repo invariant.
5. **Deterministic serialization.** Same logical record → byte-identical output → identical hash. Required for the Certificate (M10) to mean anything.
6. **No LLM inference inside the kernel.** The kernel records and verifies; it never infers. Anything probabilistic lives above it.

---

## 1. Work Contract

The frame every action is judged against. Written *before* work begins.

```json
{
  "goal": "Implement authentication",
  "scope": ["src/auth/**"],
  "constraints": ["do not change database schema", "tests must remain passing"],
  "success_conditions": ["typecheck", "unit tests", "integration test"],
  "risk_level": "medium"
}
```

`scope` bounds what may be touched; `constraints` are invariants the work must preserve; `success_conditions` name the deterministic checks that decide completion — they are verifier identifiers, not prose. Without this, "done" is whatever the model says it is.

## 2. Worker State

```
NEW → PLANNING → EXECUTING → WAITING → VERIFYING → COMPLETED
                     ↓           ↓          ↓
                  BLOCKED     FAILED    REOPENED ──┐
                     ↑                              │
                     └──────────────────────────────┘
```

Deterministic transitions; illegal transitions are rejected, not coerced. Every transition emits an immutable event. Persisted as versioned JSON.

**`REOPENED` is the one that matters** — it is what the Invalidation Engine (M6) drives when evidence underneath a completed decision changes. Without it, "completed" is permanent regardless of whether it is still true.

**Acceptance (M2):** replaying the event log reconstructs byte-identical state.

## 3. Event Log

Append-only, ordered, the substrate under Worker State.

**Must use atomic `O_APPEND` single writes.** Per **F3**, the existing `okf-turn-stop.mjs` read-modify-write pattern loses data under concurrent turns and must not be copied. Concurrent agent sessions against one workspace are the normal case, not an edge case.

## 4. Evidence Ledger

A fact plus everything needed to decide whether to still trust it.

Fields: `source` · `type` · `authority` · `timestamp` · `content_hash` · `provenance` · `confidence` · `validity` · `supersession` · `relationships` (to claims and decisions).

Operations: `add` · `get` · `invalidate` · `supersede` · `verify` · `list`.

Evidence is immutable. **Invalidation creates a new event**; the historical record survives unchanged with its current validity flipped. Typical kinds: git diff, test result, build result, browser screenshot, API response, documentation, package metadata, human approval, security scan.

**Acceptance (M3):** invalidating `E1` preserves `E1` intact *and* flips its current validity.

## 5. Decision Ledger

Fields: `decision_id` · `worker`/`task` · `selected_option` · `alternatives_considered` · `supporting_evidence_ids` · `assumptions` · `dependencies` · `timestamp` · `outcome` · `validity` · `supersession`.

`alternatives_considered` and `assumptions` are what make a decision re-evaluable later rather than merely re-readable. The dependency chain is the point:

```
E1 ─┐
E2 ─┼→ B3 → D17          then, when E1 becomes INVALID:
C2 ─┘                    E1 → B3 = STALE → D17 = REVERIFY
```

## 6. Experience Ledger

What happened when the agent attempted X under conditions Y — the distinction from ordinary "memory" that this product rests on.

```yaml
id: EXP-1042
task:        { goal: "Upgrade Astro" }
context:     { repository: ..., commit: abc123, environment: node-22, agent: claude-code }
action:      { command: "pnpm update astro" }
observation: { result: failure, error: "..." }
diagnosis:   { cause: "..." }
correction:  { action: "..." }
outcome:     { tests: "286/286" }
lesson:      "This repository requires X before Y."
evidence:    [test-run-827, commit-def456]
confidence:  0.91
valid_when:  { node: "22.x", package_manager: "pnpm" }
invalidated_by: [package-lock-change, astro-major-version-change]
```

`valid_when` and `invalidated_by` are what make an experience *applicable* rather than merely *recalled*.

### The epistemic ladder — the core constraint

```
OBSERVATION → LESSON → HYPOTHESIS → VERIFIED_KNOWLEDGE
```

**A lesson must never auto-promote to authoritative evidence.** Most memory systems silently blur *what happened* with *what we learned* with *what is true*. Promotion between rungs requires its own evidence and is itself a recorded event.

**Acceptance (M4):** a test proves a `LESSON` cannot become authoritative evidence without an explicit, evidenced promotion.

## 7. Dependency Graph

Nodes: file · symbol · test · config · evidence · claim · decision · experience · work item.

Edges: `imports` · `modifies` · `tests` · `supports` · `depends_on` · `derived_from` · `learned_from` · `invalidates` · `supersedes`.

Operations: `add_node` · `add_edge` · `remove_edge` · `neighbors` · `dependents` · `ancestors` · `descendants` · `snapshot` · `diff`.

Built from **real repository information**. No embeddings, no LLM, no probabilistic edges — this graph is the input to invalidation, and a probabilistic input produces unfalsifiable output.

**Acceptance (M5):** deterministic traversal order. Same graph + same root + same depth → byte-identical output. Cycles terminate.

## 8. Invalidation Engine

The heart of the system.

Input: a graph snapshot plus an invalidated node or event.
Output: affected nodes · stale decisions · stale evidence relationships · reopened work items · required re-verification · the exact graph delta.

Rules are explicit and testable. **An LLM never decides impact.**

**Acceptance (M6):** given `E1 → Claim → Decision → Work`, invalidating `E1` yields Claim affected, Decision `STALE`, Work `REOPENED` — while unrelated decisions remain untouched. Also covered: replacement evidence restores validity; multi-hop propagation; cycles; duplicate and repeated invalidation.

## 9. Verification Engine

Deliberately boring, and deliberately **not** the model.

Initial verifiers: git diff integrity · repository cleanliness · schema validity · test result verification · dependency consistency · graph consistency · evidence hash integrity · certificate integrity.

Each returns `PASS` / `FAIL` / `BLOCKED` with `verifier_id`, input hashes, observations, result, timestamp, execution metadata.

**A verifier must never convert missing evidence into `PASS`.** `BLOCKED` exists precisely so absence of evidence has somewhere to go that is not success. M7's acceptance test is false-positive resistance.

### Failure-policy ladder (M7a)

```
OBSERVE  → record only
WARN     → record + surface to the user
REQUIRE  → record + fail the work item
BLOCK    → deny the agent action outright
```

This generalises `runtime.failurePolicy` from `CORE-INVARIANTS-V2.md` §1.3.3, which is specified but unimplemented (**F7**). Policy is per-concern, not global: a verification failure blocks; a memory-retrieval failure warns; a telemetry export failure is observed.

The existing runtime invariant still holds and is not weakened — an *unhandled crash* must never break the host agent. What changes is that a *deliberate policy decision* to block is now expressible per concern.

**F1 gates this.** OpenCode currently discards block decisions entirely (`adapters/opencode/src/index.ts:183` gates on exit code 0, but blocks exit 2). `BLOCK` is a lie on that platform until fixed.

## 10. Execution Backend

```
ExecutionBackend
├── LocalProcessBackend   ← M9 implements this one only
├── ContainerBackend
├── VMBackend
└── RemoteBackend
```

Contract: `create` · `snapshot` · `execute` · `read` · `write` · `diff` · `rollback` · `destroy`.
Types: `ExecutionRequest` · `ExecutionResult` · `ResourceLimits` · `ArtifactCapture` · `ExecutionPolicy`.

`LocalProcessBackend` supports working-directory isolation, an environment allowlist, timeout, stdout/stderr capture, exit status, artifact capture, and deterministic execution metadata.

**The abstraction belongs to us; the infrastructure does not.** M9's acceptance criterion is that a VM backend can later be added **without touching** State, Evidence, Decision, or Verification.

## 11. Certificate

Cryptographically binds: work contract · worker state · evidence · decisions · dependency snapshot · verification results · execution artifacts · graph diff · final outcome.

`certificate.json` carries schema version, certificate ID, input hashes, graph snapshot hash, evidence hashes, verification hashes, final state, timestamp, runtime version.

**Verification is implemented independently of creation.** Tampering with any referenced artifact must fail verification — proven by golden tests plus mutation tests.

Reuse `cli/src/journal.ts` here: `preInstallHash` / `postInstallHash` / `classifyJournalEntry` is already exactly this pattern (hash, compare, detect third-party modification, refuse to proceed on conflict). Do not reinvent it.

## 12. Agent Adapter

```python
class AgentAdapter:            # shape, not the implementation language
    def start_work(...)
    def observe(...)
    def execute(...)
    def request_context(...)
    def emit_event(...)
    def verify(...)
```

Implementations: `AnyPluginAdapter` · `ClaudeCodeAdapter` · `OpenCodeAdapter` · `CodexAdapter` · `CIAdapter` · `CLIAdapter`.

**Adapters are thin.** No runtime logic moves into prompts. Skills carry repeatable workflows; hooks carry deterministic lifecycle enforcement; subagents carry isolated reasoning; MCP carries genuine external tool boundaries. Nothing carries truth.

### Binding constraints from the audit

- **Record at `turn-stop`, not `session-end`.** Antigravity marks `session-end` `UNSUPPORTED` — a *hard build error* (**F5**, `core/src/capabilities/matrix.ts:100`). `turn-stop` maps everywhere.
- **Never require `prompt-submit`.** `UNSUPPORTED` on OpenCode (**F6**, `matrix.ts:69`).
- **Hooks may be entirely unavailable.** `opencode@v2` marks *every* hook `UNSUPPORTED` (`matrix.ts:82`); only `skills` and `knowledge` survive. The runtime must be fully usable via **CLI + MCP with zero hooks** — an M11 acceptance test.
- **Fix F2 before shipping the adapter.** `turn-stop` and `session-end` both map to `session.idle` and the OpenCode bridge is keyed by native name (`adapters/opencode/src/index.ts:142`), so one hook is silently lost.
- **Fix F4 before shipping the adapter.** `core/src/events/index.ts:121` and `runner.js:160` implement `result.raw` handling differently; the runner payload is also missing fields core declares. Needs one shared conformance test, not a one-sided patch.

### Command surface

Small and boring. The runtime records underneath while the agent works normally.

```
/worker:start   /worker:status   /worker:verify
/worker:impact  /worker:recheck  /worker:explain
```

---

## Storage layout (proposed, M1 confirms)

```
.anyplugin/worker/
├── contracts/     work contracts
├── events/        append-only log (atomic O_APPEND)
├── evidence/      evidence ledger
├── decisions/     decision ledger
├── experience/    experience ledger
├── graph/         dependency graph snapshots
└── certificates/  issued certificates
```

Authoritative state lives here — **never** inside AnyPlugin's install journal or `.anyplugin-mode`. Those are AnyPlugin's own concerns, and per the non-negotiable rule in `ROADMAP.md` §2, AnyPlugin never owns worker truth.

Adding this path requires a new `TEMPLATES` whitelist entry plus a test proving uninstall fully reverses it, including the conflict-abort path (`AGENTS.md`, installer safety rules).
