# CURRENT_STATE.md

Repository ground truth, established by reconnaissance. **No code was modified to produce this.**

- **Commit**: `77729f8` on `lablp/relaxed-johnson-vq396s` · working tree clean
- **Base**: `6403f94` on `main` (M1 kernel, merged)
- **Verified**: 2026-08-24 · Node v22.22.2 local · pnpm 11.14.0
- **CI evidence**: PR #18, merge commit `da0b1bd`, **4/4 green** — Ubuntu Node 22, Ubuntu Node 24, Windows Server 2025 Node 24.19.0, `runtime-node-20`

Every classification below cites the evidence that produced it. Where a subsystem exists as a
**contract but not an engine**, it is recorded as such, because a schema that describes a thing is not
that thing.

---

## Classification legend

| State | Meaning |
|---|---|
| `VERIFIED_TESTED` | Implemented, and a test exercises the invariant on a real target |
| `VERIFIED_IMPLEMENTED` | Implemented and executing, without a test proving the invariant |
| `PARTIALLY_IMPLEMENTED` | Some of it exists; the rest is absent |
| `DESIGNED` | Contract/schema/doc exists; no executing implementation |
| `EXPERIMENTAL` | Exists as a measured candidate, not adopted |
| `UNVERIFIED` | Claimed somewhere; not confirmed from repository evidence |
| `ABSENT` | No occurrence in the repository |

---

## 1. Build and workspace ground truth

| Fact | Value | Evidence |
|---|---|---|
| Workspace | pnpm, 9 projects | `pnpm-workspace.yaml`; CI "Scope: all 9 workspace projects" |
| Packages | `core`, 4 adapters, `cli`, `plugins/knowledge`, `packages/worker-runtime` | `pnpm-workspace.yaml`, per-package `package.json` |
| Build = typecheck | `tsc -b`, TypeScript 7.0.2 | root `package.json`; no separate lint step |
| Test runner | vitest 4.1.11 | root `package.json` |
| Engines | `node >=20` (root and kernel only) | `package.json` |
| CI matrix | Ubuntu 22/24 + Windows 24, plus dependency-free `runtime-node-20` | `.github/workflows/ci.yml` |
| **Baseline** | **377 tests / 36 files** (344 at reconnaissance; Gate 3 added 33) | measured locally |
| Windows baseline | 344 tests, 12.72 s | CI job 97592968916 |
| Line endings | **164/164 tracked files `i/lf`** | `git ls-files --eol` |

Kernel dependency posture: `@lablaunchpad/worker-runtime` declares exactly one dependency, `zod`.
It declares **no** AnyPlugin package — verified mechanically, not by inspection.

---

## 2. What M1 actually proves

All six workspace boundary guards report **`PASSED`**, never `ARMED`, on Windows CI:

```
[PASSED] core: depends on no other workspace package — core is a dependency leaf
[PASSED] adapters: never depend on cli — 4 adapters checked
[PASSED] worker-runtime: no import of cli/ or adapters/
[PASSED] worker-runtime: no AnyPlugin package dependency
[PASSED] worker-runtime: wired into the workspace and the test globs
[PASSED] single ownership: 8 install destinations checked; none touch ".worker-runtime"
```

| Subsystem | State | Evidence |
|---|---|---|
| Package/import/ownership boundaries | `VERIFIED_TESTED` | 6 guards PASSED above; negative-tested |
| Canonicalization + content hashing | `VERIFIED_TESTED` | `canonical.ts`; 25 + 31 tests; golden vectors on all 4 CI cells |
| Unicode NFC normalization (F14) | `VERIFIED_TESTED` | `canonical.test.ts`; NFC/NFD converge |
| Unsafe-integer rejection (F15) | `VERIFIED_TESTED` | `canonical.test.ts`; collision refused |
| Cross-platform artifact determinism (F13) | `VERIFIED_TESTED` | `.gitattributes`; 164/164 `i/lf`; Windows CI green |
| 10 frozen contracts @ `1.0.0` | `VERIFIED_TESTED` | `contracts/index.ts` (405 L); 35 tests |
| JSON Schema mirror | `VERIFIED_TESTED` | 10 files in `schemas/`; 9 sync tests, byte-for-byte |
| ID path safety | `VERIFIED_TESTED` | `id-path-safety.test.ts`; hostile corpus |
| Runtime-state git boundary | `VERIFIED_TESTED` | `git-boundary.test.ts` via real `git check-ignore` |
| Storage ownership predicates | `VERIFIED_TESTED` | `storage.ts` — **zero `node:fs` imports**; 7 tests |

---

## 3. What M1 does NOT prove — searched, not assumed

Direct search across all `.ts/.mjs/.js/.json/.md`, excluding `node_modules` and `dist`:

| Subsystem | State | Evidence |
|---|---|---|
| Durable event log | `VERIFIED_TESTED` | `log/event-log.ts` — single-writer framed append (Gate 3) |
| Production write mechanism | `VERIFIED_TESTED` | framed append chosen from measurement; durability still `UNKNOWN` (U1) |
| Replay engine (governed state) | `VERIFIED_TESTED` | `log/replay.ts` — byte classification, gap/duplicate detection; determinism proven **across a process boundary** (Gate 4), incl. varying cwd/TZ/locale. Not durability — see U1 |
| Worker state store | `VERIFIED_TESTED` | `log/worker-state.ts` — folded from events via `LEGAL_TRANSITIONS` |
| Evidence ledger engine | `DESIGNED` | `EvidenceSchema` exists; no reader, writer, or store |
| Decision engine | `DESIGNED` | `DecisionSchema` exists; no engine |
| Dependency graph engine | `DESIGNED` | `GraphSnapshotSchema` exists; `dependencyGraph` appears **only in `ROADMAP.md`** |
| Invalidation / impact traversal | `DESIGNED` | every `invalidat*` occurrence is schema, doc, or comment — **no engine module** |
| Verification transaction | `DESIGNED` | `VerificationResultSchema` exists; no executor |
| Certificate engine | `DESIGNED` | every `certificate` occurrence is schema, doc, or comment — **no issuer, no verifier** |
| Claim / belief state | `ABSENT` | `belief` appears once, in a contract comment; `proofObligation` = **0 files** |
| Cognitive Compiler V5.2.1 | `ABSENT` | `CognitiveCompiler` = 0 files · `V5.2.1` = 0 files |
| Marketing Content Integrity Worker | `ABSENT` | `MarketingContent` = 0 · `ContentIntegrity` = 0 |
| `markops verify` | `ABSENT` | `markops` = **0 files** |

**The load-bearing distinction:** ten contracts and ten JSON Schemas exist and are tested. As of Gate 3
exactly **two** of them have an engine behind them — `Event` (`log/event-log.ts`, `log/replay.ts`) and
`WorkerState` (`log/worker-state.ts`). The remaining eight do not. The kernel can *describe* an
invalidation result; nothing computes one.

---

## 4. AnyPlugin (the distribution layer) — verified separately

| Subsystem | State | Evidence |
|---|---|---|
| SafePath boundary | `VERIFIED_TESTED` | `core/src/fs/safe-path.ts`; 10 tests incl. hostile corpus (4 151 ms) |
| Transactional install journal | `VERIFIED_TESTED` | `cli/src/journal.ts`; 6 tests incl. byte-exact restore + conflict abort |
| Strict CLI arg contract | `VERIFIED_TESTED` | `cli/src/strict-args.ts`; 9 tests |
| Capability negotiation matrix | `VERIFIED_TESTED` | `core/src/capabilities/matrix.ts`; 3 tests; fail-closed observed in CI build output |
| OKF v0.2 library + bundle | `VERIFIED_TESTED` | `core/src/okf/`; 15 tests; CI: "bundle CONFORMANT with OKF v0.2" |
| 4 agent adapters | `VERIFIED_TESTED` | 21 tests total; CI emits all 4 bundles |
| Dependency-free runtime | `VERIFIED_TESTED` | 19 E2E tests; `runtime-node-20` job green |

---

## 5. F10 — the cross-platform result

Concurrency: **4 processes × 25 records × 8 192 bytes each (2× `PIPE_BUF`)**.

| candidate | Linux Node 22 | **Windows Node 24** | tamper rejected | **silently accepted** | arrival order | µs/append |
|---|---|---|---|---|---|---|
| A plain append | 100/100 | **100/100** | **no** | **YES** | yes | 50 |
| B framed append | 100/100 | **100/100** | yes | no | yes | 91 |
| D locked append | 100/100 | **100/100** | yes | no | yes | 113 |
| C rename per event | 100/100 | **100/100** | yes | no | **no** | 115 |
| E exclusive per event | 100/100 | **100/100** | yes | no | **no** | 111 |

Windows lines from CI job 97592968916, e.g.
`[F10] win32 node24.19.0 B-framed-append: 100/100 committed, 0 anomalies`.

**What this does and does not establish.** Concurrent appends above `PIPE_BUF` lost nothing on either
platform. That is an **observation on two runners, not a guarantee** — POSIX bounds `O_APPEND`
atomicity at `PIPE_BUF` and Windows documents no equivalent. It stays an observation.

Because no candidate lost data under concurrency, **concurrency is not the discriminator.** The
discriminators are tamper detection (A fails), arrival order (C/E fail), and cost.

---

## 6. Findings ledger state

`ENGINEERING_LEDGER.md` owns the taxonomy. F-ids are mapped by **class**, not one row per symptom.

| ID | Class | Status |
|---|---|---|
| SEC-01 | Unvalidated hook id → arbitrary file load | `[FIXED & ERADICATED]` |
| BUG-01/02/04 | Silent data loss · argv misuse · Node 20 API | `[FIXED & ERADICATED]` |
| AP-001/002/008/009 | Irreversible install · traversal · MCP boundary · uninstall data loss | `[FIXED & ERADICATED]` |
| AP-004 | OpenCode v2 | class fixed; **v2-native emission `[OPEN]`** |
| **AP-017** | Canonical↔native hook translation unverified (F1, F2, F4, F8) | `[OPEN]` |
| **AP-018** | Non-atomic whole-file rewrite (F3 ×3) | `[OPEN]` for AnyPlugin; kernel closed |
| **AP-019** | `runtime.failurePolicy` specified but absent (F7) | `[OPEN]` |
| **AP-020** | Representation ambiguity in integrity (F13, F14, F15) | `[FIXED & ERADICATED]` |
| SEC-02, BUG-03/05, AP-003, AP-005/006, AP-010…016 | — | `[UNMAPPED]` — definitions never supplied; **not invented** |

---

## 7. CONTRADICTIONS

### CONTRADICTION 1 — resolved

**CLAIM** (`ROADMAP.md` F3, and the M2 acceptance row): the event log *"requires atomic `O_APPEND`
single writes"* / *"atomic append"*.
**REPOSITORY EVIDENCE**: POSIX bounds `O_APPEND` write atomicity at `PIPE_BUF` (4 096 B); Windows
documents no equivalent. Both are CI-tested platforms. Measured records are 8 192 B.
**CONFLICT**: the prescribed remedy is not a property that can be relied upon at arbitrary record size.
**IMPACT**: implemented as written, M2 would have inherited the very defect class F3 identifies, while
believing itself immune.
**RESOLUTION**: finding stands; remedy replaced by `EVENT_WRITE_CONTRACT v1`. Recorded in AP-018 and
corrected in `ROADMAP.md` **in place, with the reason stated**.
**STATUS**: resolved, recorded, no decision outstanding.

### CONTRADICTION 2 — open, requires a decision

**CLAIM** (master directive §3): M1 materialized *"integrity foundations"* and the system is progressing
toward the Cognitive Compiler and Marketing Content Integrity Worker.
**REPOSITORY EVIDENCE**: `markops`, `MarketingContent`, `ContentIntegrity`, `CognitiveCompiler`,
`V5.2.1`, `proofObligation` — **0 files each**.
**CONFLICT**: none of the semantic source material named as governing exists in this repository.
**IMPACT**: any work claiming to "reuse proven V5.2.1 concepts" would be reconstructing them from the
prompt, i.e. from Level 7 evidence, which §6 forbids from overriding anything.
**REQUIRED DECISION**: is V5.2.1 an external artifact to be supplied, or is it to be treated as
design intent only? Until answered, it is `ABSENT`, not `UNVERIFIED`.

---

## 8. UNKNOWNs

Per §7, each carries subject, reason, required evidence, and blocking status.

| # | Subject | Reason | Required evidence | Blocking? |
|---|---|---|---|---|
| U1 | Durability under crash / power loss | Not simulable in CI; no test attempts it | Failure injection outside CI, or an accepted written limitation | **Blocks any durability claim**, not M2 itself |
| U2 | Append atomicity **guarantee** above `PIPE_BUF` | Two platforms observed lossless; neither documents a guarantee | Vendor/spec citation, or permanent reliance on detection instead | Non-blocking — B/D/C/E detect violations |
| U3 | `maxRSS` unit on Windows and macOS | Linux measured as KB (`maxRSS×1024 === rss`); others unverified | Same ratio probe per platform | Non-blocking — field held `UNKNOWN` |
| U4 | `codex@>=0.147` `mcp.http` shape | Never audited; matrix row fails closed | Upstream codex TOML audit | Non-blocking for M2 |
| U5 | OpenCode v2 plugin API | v2 dropped the v1 hook API; no audit performed | Upstream v2 API audit | Non-blocking for M2 |
| U6 | Whether AP-017's four symptoms share one root | Inferred from code reading, not proven by a shared conformance test | One conformance suite both implementations must pass | Blocks M11, not M2 |
| U7 | V5.2.1 status | See Contradiction 2 | User decision | Blocks any Cognitive-Compiler work |

**No UNKNOWN above was filled by inference to allow progress.**

---

## 9. Ownership map

| Mutable state | Authoritative writer | Readers | Enforcement |
|---|---|---|---|
| `.worker-runtime/**` | Worker Runtime kernel, exclusively | kernel | `ownership.ts`; 5 guards PASSED |
| `.anyplugin-state.json` (journal) | AnyPlugin CLI installer | CLI | kernel refuses — `foreign-owned` |
| `.anyplugin-mode` | AnyPlugin CLI | runtime | kernel refuses |
| Agent configs (`.claude`, `.codex`, `.opencode`, `AGENTS.md`, …) | AnyPlugin installer, via `TEMPLATES` whitelist | agents | kernel refuses |
| `knowledge/` OKF bundle | Human authorship + `okf-reindex` | CLI, MCP | Model B — kernel does not read it |

**No state has two authoritative writers.** Kernel storage and the 8 install destinations were checked
for intersection mechanically and are disjoint.

Invariant states — `ARMED` is never reported as `PASSED`:

| | |
|---|---|
| I1 single ownership · I2 disjoint · I3 no reverse coupling · I4 no cross-owner deletion · I5 no hidden writers · I6 derived state rebuildable | **PASSED** (6) |
| I7 transactional deletion | **ARMED** — the only delete removes a transient claim (`writer.lock`), not governed state |

---

## 10. Artifacts that do not exist yet

`docs/ai-native/reusable-procedures.md` — created at Gate 3; it owns executable procedures only, referencing the ledger and ROADMAP rather than restating them. The other proposed `docs/ai-native/` pages were deliberately **not** created: `CURRENT_STATE.md` and `ENGINEERING_LEDGER.md` already own that content.

`ROADMAP.md`, `ENGINEERING_LEDGER.md`, `CORE-INVARIANTS-V2.md`, `AGENTS.md`, `CLAUDE.md`,
`CONTRIBUTING.md`, `docs/WORKER-RUNTIME-KERNEL.md`, `docs/PATTERNS.md` all exist and own their semantic
models. Per the directive, **no competing ledger or taxonomy may be created**; the existing ledger was
extended rather than duplicated.

---

## 11. Report

**STATUS**: `IN_PROGRESS` — reconnaissance complete, stopped before modification as required.

**CHANGES**: `CURRENT_STATE.md` (this file) only. No source file was modified in this pass.

**FINDINGS (class level)**: two contradictions, one resolved and one open (§7); the contract-without-
engine gap (§3) is the single most consequential fact in this document.

**DECISIONS MADE**: none. The write-mechanism choice is stated as a recommendation below, not applied.

**RISKS**: the largest is mistaking contract coverage for capability. Ten schemas and 344 green tests
can read as a working system; §3 is the corrective.

**VERIFICATION**: 344 tests / 35 files, green on 4 CI cells (Ubuntu 22, Ubuntu 24, Windows Server 2025
Node 24.19.0, `runtime-node-20`). Local build 905 ms, test 6 501 ms.

**RESOURCE PROFILE (this pass)**: 8 tool calls — 6 batched shell, 2 GitHub. No file rewritten twice, no
repeated full-tree scan, no speculative test run. Discovery batched per §41.

**EXPERIENCE COMPILED**: this document is the artifact. Previously each session re-derived package
layout, test commands, boundary states, ledger status, and what is implemented versus merely
contracted. That rediscovery is now a lookup.

**NEXT GATE**: approval to proceed, plus the two decisions in §12.

---

## 12. Decisions required before any modification

**D1 — Write mechanism (recommend B, framed append).**
Concurrency did not discriminate: all five candidates lost nothing on both platforms. What
discriminates is that **A silently accepts tampered records**, and that **C/E cannot preserve arrival
order** — a filename carries identity, not sequence. **D adds a lock, and with it a stale-lock liveness
failure, for no measured concurrency benefit.** B is the cheapest mechanism (91 µs) that both detects
tampering and preserves arrival order. Its dependence on append behaviour that is observed-but-not-
guaranteed (U2) is bounded by its own framing: the racy-writer negative test lost 18 of 100 events,
**detected all 18 and silently accepted none**. Its worst case is detected, recoverable loss — never
silent corruption.

**D2 — V5.2.1 status.** See Contradiction 2. External artifact to be supplied, or design intent only?

**D3 — `docs/ai-native/` scope.** The directory is absent and may be created. It should reference
`ENGINEERING_LEDGER.md` and `ROADMAP.md` rather than restate them; any page that would duplicate
taxonomy, statuses, finding ids, or class-closure semantics should not be created at all.
