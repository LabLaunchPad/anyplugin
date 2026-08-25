# Harness corpus audit — external research input

**Reconnaissance only. Nothing here was implemented.** This is a research artifact: it records what an
external corpus contains, what of it is relevant, and what evidence each mechanism would need before
admission. It is **not** authoritative over anything.
[`ENGINEERING_LEDGER.md`](../../ENGINEERING_LEDGER.md) owns findings and taxonomy,
and the contracts, canonicalization rules and CI results own behavioural truth. (An earlier version of
this line named `CURRENT_STATE.md` as owning current system state; it is a pinned snapshot of `77729f8`
and owns only that commit's history.)

| | |
|---|---|
| **Our repo** | `fce714d` on `lablp/relaxed-johnson-vq396s`, clean · 377 tests / 36 files · 4/4 CI cells green |
| **External corpus** | `RyanAlberts/best-of-agent-harnesses` @ `ece3146` (shallow clone, read-only) |
| **Corpus size** | 160 projects · 12 categories · 88 attribute files · 13 comparisons · 12 test files · 3 agent skeletons · 1 MCP server (657 L) |
| **Corpus licence** | CC-BY-SA-4.0. Prose and data are **not** copyable into this repo without attribution; mechanisms and schema shapes are ideas, not text. |

---

## 1. The finding that matters most

The corpus **independently arrived at three invariants this repository already enforces**, by a different
route and for a different problem. That convergence is the useful signal — far more than any specific
tool it lists.

| Their mechanism | Our equivalent | Convergent invariant |
|---|---|---|
| `test_rating_without_evidence_fails` — a rating without an `evidence` URL **fails the build** (`SystemExit`) | `ExperienceSchema` refinement: `VERIFIED_KNOWLEDGE` requires ≥1 evidence id | **A claim without evidence must fail mechanically, not be caught in review** |
| `unknown` is a first-class rating with a `detail` saying *what was looked for* | `UNKNOWN` in the capability matrix; the seven UNKNOWNs in `CURRENT_STATE.md` | **Absence of evidence gets its own state, never a default** |
| `graveyard` — archived or integrity-flagged projects are a hard veto, separate from ranking | AP-004 fail-closed capability matrix | **Popularity is not operational validity** |

Two independently-developed systems converging on "unevidenced claims fail the build" is the strongest
available argument that the shape is right. It is not proof, and it does not license importing anything.

**The discipline is real, not aspirational.** Measured across the corpus: 86 of 160 projects carry a
deep-dive rating at all (the other 74 are reported as *not rated* rather than guessed), and `unknown`
appears 24 times across the four axes of those that are rated. A corpus that never emits `unknown` is
one where the state exists on paper only.

---

## 2. CONTRADICTION — the same word, inverted safety semantics

**This is the one finding that could cause real harm if missed.**

- **Their `unknown`** → rank `0`, and `attributes/RUBRIC.md` states it is **"excluded from comparisons"**.
  It fails **open**: an unrated axis simply drops out and the comparison proceeds.
- **Our `UNKNOWN`** → a **hard build error** (`core/src/capabilities/matrix.ts`, AP-004). It fails
  **closed**: a plugin declaring an unknown capability aborts the build.

Both are defensible for their own problem. A recommendation engine that refused to answer whenever one
axis was unrated would be useless; a build system that shipped an unverified capability would be
dangerous.

**The hazard is vocabulary transfer.** Adopting their attribute schema — which is otherwise the best
fit for the F9 capability work — would import a word whose safety direction is the opposite of ours. If
any of it is ever borrowed, `UNKNOWN` must keep **our** fail-closed meaning, and that must be enforced
by a test rather than remembered.

**Status:** recorded, not resolved. No decision is required until something actually consumes their
schema.

---

## 3. Mechanism census

Classified per the audit protocol. "Evidence level" is **our** confidence, not theirs.

### DIRECTLY_REUSABLE (shape only — no code, no data)

**M1 · Evidence-bearing capability claim.** `attributes/RUBRIC.md` + `attributes/*.json`: one file per
subject, fixed axes, a closed rating vocabulary, and a mandatory `evidence` URL per non-unknown rating,
validated at build time. Rank derivation is explicit (`strong=3 … unknown=0`).
*Maps to:* F9 capability truth, and the `CapabilityClaim` shape — `{subject, capability, versionRange,
environment, status, evidenceRef, observedAt}`. Our capability matrix has the states but **no evidence
reference field** and no researched-on date.
*Evidence level:* their rubric is directly readable and their validator is executable. **VERIFIED** as a
description of their system; **UNVERIFIED** as a claim that it improves ours.

**M2 · Two distinct admission vetoes.** `generate.ARCHIVED` (upstream archived) and
`generate.INTEGRITY_FLAGGED` (e.g. *"suspected star manipulation — ~228k stars / ~35k forks on a repo
created 2026-01 with no matching install base"*) are separate sets with separate reasons, and
`test_integrity_flagged_repo_is_graveyarded_with_reason` asserts a non-empty public reason renders for
each.
*Why it matters to us:* this is the same discipline as our gap-versus-duplicate split in `replay.ts` —
two failures that would be convenient to merge are kept apart because they demand different responses.
*Evidence level:* **VERIFIED** by reading their tests.

**M3 · Staleness as recorded metadata.** `meta.stars_captured: "2026-08-23"` — every derived number
carries the date it was captured.
*Maps to:* OKF's `stale_after`, and the `observedAt` we would need on any promoted claim.

### ADAPTABLE (the idea, heavily reshaped)

**M4 · Progressive disclosure as a layered context ladder.** Their `comparisons/progressive-disclosure.md`
frames context bloat as entering through **three doors** — instructions, tool definitions, and tool
output — and notes the third has no standard answer.
*Relevance:* this is the closest external analogue to the reasoning-amortization objective, and the
three-door split is a genuinely useful decomposition we do not currently have.
*Caution:* everything in that document is about **feeding a model better**, which is upstream of our
actual goal (not needing the model). Useful as a taxonomy; not a design.

**M5 · Query the corpus instead of ingesting it.** `harnesses.json` + `llms.txt` + an MCP server exposing
ten tools (`pick_harness`, `recommend`, `search_harnesses`, `get_harness`, `compare`, `compare_for`,
`pick_infrastructure`, `list_comparisons`, `get_comparison`, `list_categories`).
*The transferable idea:* a large corpus reduced to a canonical structured form plus a deterministic
retrieval surface, so an agent pulls a slice rather than loading everything. That is the same move as
`CURRENT_STATE.md` — knowledge compiled into a lookup — one order of magnitude larger.
*Not transferable:* the MCP server itself. We would be adding a dependency and a network surface to
solve a problem we do not yet have.

**M6 · Routed roles instead of remembered procedure.** Three agent skeletons — `harness-scout` (select),
`stack-auditor` (inspect an existing repo), `harness-radar` (diff against a snapshot). Each is a narrow
role with a fixed method, and each begins by fetching fresh data.
*The transferable idea:* the system routes the procedure; the model does not recall it. This is
`reusable-procedures.md` with a dispatcher in front.

### NOT_YET_NEEDED

**M7 · `ExecutionStrategy` as a first-class object.** The corpus supports the *idea* — its `tier` /
`autonomy` / `recovery` axes are a crude execution-strategy vocabulary — but nothing there implements
strategy promotion or reuse.
*Assessment:* **premature.** An `ExecutionStrategy` records what worked for a task class. We have
executed exactly zero governed tasks: the event log was built this week and has never carried a real
workload. Defining the schema now would be designing from imagination, which is the failure mode
`resource/telemetry.ts` exists to document. The prerequisite is *execution traces*, not a schema.

### INCOMPATIBLE / REDUNDANT

- **Their build pipeline** (`generate.py` as single source, hand-edits forbidden) — sound for them,
  redundant here; we already have schema-export with byte-for-byte drift tests.
- **Their commit-identity and branching policy** (`CLAUDE.md`) — repository-specific policy, not a
  mechanism, and directly contrary to this repo's PR discipline. Explicitly **not** imported.
- **Every listed product** (memory layers, vector stores, orchestration frameworks, browser
  infrastructure) — out of scope by standing decision. The corpus is a catalogue of things we have
  already decided not to add.

---

## 4. What we already have, and must not duplicate

| Capability | Ours | Verdict |
|---|---|---|
| Evidence with provenance and validity | `EvidenceSchema` | Superior — has supersession and invalidation; theirs has neither |
| Content-addressed integrity | `canonical.ts`, AP-020 | No corpus equivalent |
| Ownership / single-writer | `ownership.ts`, I1–I6 | No corpus equivalent |
| Durable event log + replay | `log/` (Gate 3) | No corpus equivalent |
| Capability negotiation | `capabilities/matrix.ts` | Ours fails closed; theirs fails open (§2) |
| Executable rules over documentation | 377 tests | **Convergent** — they reached the same conclusion |
| Defect-class ledger | `ENGINEERING_LEDGER.md` | No corpus equivalent |

The corpus contributes **no integrity, ownership, durability, or verification mechanism** that we lack.
Its contribution is concentrated in **capability description** and **context economy**.

---

## 5. Token / resource efficiency

Honest accounting: **nothing in the corpus measurably reduces reasoning cost for us today**, because
nothing in it is a verification mechanism.

The two mechanisms with genuine amortization potential:

1. **M1 (evidence-bearing claims)** would let a capability question be *looked up with its evidence*
   instead of re-researched. That is a direct reasoning-cost reduction for the F9 class — the exact class
   where I have already produced one misreport (F9, corrected as C1 in the ledger).
2. **M5 (query, don't ingest)** is the structural pattern behind `CURRENT_STATE.md`, whose measured
   effect this session was replacing a full repository re-scan with a single read.

**Not claimed:** any specific token figure. Their document cites vendor claims (~85% fewer
tool-definition tokens; ~98% on a benchmark). Those are `EXTERNAL_CLAIM`, recorded and **not promoted** —
no experiment here reproduced them, and they concern a mechanism we do not run.

---

## 6. Security, determinism, portability, recovery

- **Security.** Adding their MCP server would add a runtime dependency and a network fetch to a kernel
  that currently depends on `zod` alone. Their agent skeletons fetch over the network on every run. Both
  conflict with the dependency-free runtime promise. **Do not adopt.**
- **Determinism.** Their corpus is a dated snapshot rescored weekly. Any value derived from it is
  non-deterministic across time and must carry `observedAt` before entering a hashed record.
- **Portability.** Their tooling is Python + `uvx`; ours is Node + pnpm. Nothing is transferable as code.
- **Recovery.** The corpus has no crash, partial-write, or replay model. It contributes nothing to U1
  (durability), which remains `UNKNOWN`.

---

## 7. UNKNOWNs added by this audit

| # | Subject | Required evidence | Blocking? |
|---|---|---|---|
| U8 | Whether an evidence field on capability rows measurably reduces re-research cost | One task class measured before and after | No — cannot be answered before M1-style rows exist |
| U9 | Whether their star/rating data is accurate | Independent verification against GitHub | No — we consume none of it |
| U10 | Whether the three-door context model maps onto our execution model | An actual governed execution trace | No — blocked on M7's prerequisite |

Per the standing rule, none of these was filled by inference to allow progress.

---

## 8. Contradictions

**CONTRADICTION 3 — `unknown` fails open there, closed here.** See §2. Recorded, unresolved,
non-blocking. Becomes blocking the moment anything consumes their vocabulary.

No contradiction was found between the corpus and our architecture. The corpus makes **no claim** about
integrity, ownership, durability, or verification, so there is nothing for it to contradict.

---

## 9. Smallest next implementation — and what must not be built

**Smallest defensible step (not taken; requires approval):** add `evidenceRef` and `observedAt` to
capability rows in `core/src/capabilities/matrix.ts`, so the two surfaces already documented as
`UNKNOWN` (codex `mcp.http`, OpenCode v2) carry *what was looked for and when*, instead of only that
nobody knows. This is M1's shape at the smallest scale, touches no frozen contract, adds no dependency,
and directly serves an already-open ledger item (AP-004).

**Must NOT be built now:**

- `ExecutionStrategy` in any form — no execution traces exist to derive one from (§3, M7).
- A context-ladder / progressive-disclosure router — presupposes stored procedures and traces.
- Any MCP server, vector store, graph store, memory layer, or corpus mirror.
- Any change to the ten frozen contracts.
- Any promotion of an `EXTERNAL_CLAIM` into evidence.

**The governing question this audit was run to answer** — *which harness mechanisms can be compiled from
model-dependent behaviour into verified, deterministic, reusable state?* — has a narrow answer:
**capability claims can; nothing else in the corpus is close.** The rest either describes feeding a model
better (upstream of our goal) or catalogues products we have already decided not to adopt.

---

## 10. Corrections to the framing this audit was given

Recorded because the framing was stated as fact and repository evidence differs.

- **C-H1.** The *"fetch fresh, don't hallucinate"* rule is not in the corpus's `CLAUDE.md`. That file
  covers commit identity, branching, and list generation. The rule lives in all three
  `agents/*.md` skeletons — *"Never recommend from memory. If the fetch fails, say so and stop; do not
  fall back to training data."* The rule is real; its location was not as described.
- **C-H2.** The corpus is described as containing "100+ agent frameworks". It contains **160 projects
  across 12 categories**, of which only 86 are researched in depth; 74 carry no rating at all. The
  unrated majority is a feature of their discipline, and any use of the corpus must not read absence of
  a rating as absence of the capability.
