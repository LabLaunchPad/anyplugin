# Worker Runtime — kernel domain model

Input to **M1** (freeze the kernel contract). See [`../ROADMAP.md`](../ROADMAP.md) for strategy, milestones, and the audit findings referenced here as F1–F8.

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

**Must use atomic `O_APPEND` single writes.** Per **F3** the read-modify-write pattern loses data under concurrent turns and must not be copied. Concurrent agent sessions against one workspace are the normal case, not an edge case.

F3 is a **class with three instances**, not one bug: `plugins/knowledge/plugin/hooks/okf-turn-stop.mjs:21-36` (the wired hook), `core/src/okf/index.ts:431-451` (`appendLog()`, exported public API, currently callerless), and `core/src/okf/index.ts:350-424` (`regenerateIndexes()`). Per `ENGINEERING_LEDGER.md`'s VERIFY → FIX → **ERADICATE THE CLASS** methodology, M2 must address all three or explicitly defer the `core` ones with a reason — otherwise the copy gets fixed and the original ships.

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

### Failure classification (the eight classes M8 requires)

Every recorded failure carries exactly one class. M8's exit condition is that all eight are reachable in test.

| Class | Means |
| --- | --- |
| `INFRASTRUCTURE` | the machine, network, or runner failed — nothing about the work itself |
| `TOOL` | a tool was invoked correctly and misbehaved |
| `ENVIRONMENT` | wrong versions, missing deps, misconfiguration |
| `KNOWLEDGE` | the worker lacked a fact it needed |
| `REASONING` | the worker had the facts and drew the wrong conclusion |
| `EXECUTION` | the plan was right; carrying it out went wrong |
| `VERIFICATION` | the work was wrong and verification caught it |
| `USER_CONSTRAINT` | blocked by a contract constraint or an explicit human decision |

**Do not infer root cause automatically unless evidence supports it.** An unclassifiable failure is recorded as unclassified — guessing a class silently corrupts every downstream statistic built on this ledger.

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

Policy is per-concern, not global: a verification failure blocks; a memory-retrieval failure warns; a telemetry export failure is observed.

⚠️ **Whether this weakens an existing invariant is an open question M7a must answer — do not assume it does not.** Per **F7**, three repo documents currently disagree:

- `CORE-INVARIANTS-V2.md:104` says `failurePolicy: blocking` **"flips handler-throw to exit 2"** — an unhandled crash *does* deny the host action.
- `CLAUDE.md:49` and `AGENTS.md:63` state the rule **absolutely**, with no exception: *"Runtime failures are always non-blocking … must never break the host agent."*

So `BLOCK` is one of two different mechanisms, and M7a must state which it implements:

1. **The four-mode generalisation of §1.3.3** — `BLOCK` inherits crash-blocks-host, and the absolute rule in `CLAUDE.md`/`AGENTS.md` is genuinely weakened and must be amended in those files.
2. **A mechanism over *concern outcomes*** (a verifier returned FAIL) rather than over *handler throws* — the crash invariant is untouched, but F7's "extension, not invention" framing is wrong and this is new design needing its own spec.

Reconciling all three documents is **M7a's deliverable**, not a precondition. This document does not pre-judge it.

**F1 constrains this.** OpenCode discards `block: true` on tool execution (`adapters/opencode/src/index.ts:183` gates on exit code 0; blocks exit 2), so `BLOCK` is unenforceable there until fixed. Note the narrower scope: permission *denial* still works via the separate `permissionDecision` channel (`adapters/opencode/src/index.ts:205-210`) — do not rebuild a working channel.

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

**Copy the shape of `cli/src/journal.ts`; do not import it.** `preInstallHash` / `postInstallHash` / `classifyJournalEntry` (`cli/src/journal.ts:19,21,75`) is already exactly this pattern — hash, compare, detect third-party modification, refuse to proceed on conflict — and it is proven in production use. Reimplement that *design* against certificate records.

The package boundary in `ROADMAP.md` §2 forbids importing from `cli/`, and it wins: the runtime must not depend on AnyPlugin's installer. If genuine code sharing is later wanted, extracting the hashing/conflict primitives into `core/` is an explicit **M10 prerequisite task** that has to be written down and scheduled — not something to do implicitly while implementing the Certificate.

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

- **Record at `turn-stop`, not `session-end`.** Antigravity marks `session-end` `UNSUPPORTED` (**F5**, `core/src/capabilities/matrix.ts:100`). `turn-stop` maps everywhere. Note the two-layer behaviour in F5: a hard error at the CLI gate, but a **silent warn-and-drop** at the pure adapter layer — so a passing `emitAntigravity(...)` call is *not* evidence the hook survived.
- **Never require `prompt-submit`.** `UNSUPPORTED` on OpenCode (**F6**, `matrix.ts:69`).
- **The CLI is the floor — not CLI + MCP.** `opencode@v2` marks every hook `UNSUPPORTED` (`matrix.ts:82`) **and omits `mcp.stdio`/`mcp.http` from its row entirely**, which `supports()` resolves to `UNKNOWN` (`matrix.ts:118-122`) and `cli/src/index.ts:84` turns into a hard build error. A plugin declaring MCP therefore cannot build for that target at all. The runtime must be **fully operable through its own CLI with neither hooks nor MCP** — that is the M11 acceptance test. Extending the matrix row to cover `mcp.*` is a separate capability-audit task.
- **Fix F2 before shipping the adapter.** `turn-stop` and `session-end` both map to `session.idle` and the OpenCode bridge is keyed by native name (`adapters/opencode/src/index.ts:142`), so one hook is silently lost.
- **Fix F4 before shipping the adapter.** `core/src/events/index.ts:121` and `runner.js:160` implement `result.raw` with opposite precedence (core: raw discards all; runner: `block` overrides raw at `:162-170`). The payload diverges both ways — the runner omits `event`/`nativeEvent`, which `HookPayload` declares **required** (`core/src/events/index.ts:54-55`), and adds `hookId`/`pluginRoot`/`intensityMode` it does not declare. Needs one shared conformance test.
- **Resolve F8 before shipping the adapter.** `AGENTS.md:62` says Antigravity uses **exit 0** semantics for a block, but `runner.js:175` exits 2 unconditionally with no platform branch — while `:162-170` right above it *does* branch on Antigravity. Either the runner is wrong or the docs are; M0 determines which.

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

⚠️ **`.anyplugin/worker/` must NOT be a `TEMPLATES` install destination.** `TEMPLATES` (`cli/src/index.ts:218-227`) is the whitelist of *install* destinations, and everything reached through it is journaled with pre-install backups and **restored to pre-install bytes on uninstall** (`AGENTS.md`, installer safety rules). Registering the worker ledger there would mean `anyplugin uninstall` either **deletes or reverts the authoritative state**, or aborts on conflict — which it would do on essentially every run, because the runtime legitimately modifies these files constantly.

This directory is **runtime-created state**, the same category as `.anyplugin-mode` (`cli/src/state.ts`), which is deliberately disjoint from the install journal for exactly this reason. It needs no TEMPLATES entry and no uninstall-reversibility test. Its lifecycle is owned by the runtime, not the installer.
