# Session learnings — what the last sessions established, and how they failed

A record of the engineering sessions that preceded this work, so the reasoning
survives the sessions that produced it.

**Sources.** The live opencode session store (`session_v2`), filtered to this
repository and to the adjacent projects whose findings fed into it. 10 AnyPlugin
sessions and 38 sessions across the three adjacent projects, extracted with
their tool-error records intact.

**How to read the classifications.** A session's outcome is classified by what
it *changed about the codebase*, not by whether it felt productive:

| Class | Meaning |
|---|---|
| **PRODUCED** | it produced a change that is still in the tree |
| **SUPERSEDED** | it produced a change that a later session replaced |
| **INVALIDATED** | its conclusion was later shown to be wrong |
| **RECONCILIATION** | it found the repo's own state to be inconsistent |
| **ORPHANED** | it produced nothing that survived |

---

## 1. The AnyPlugin audit sessions (10)

Ten sessions on 2026-10-19, orchestrated under "Deep audit and organize
anyplugin repo". The orchestrator dispatched five parallel audits, then a
findings-analysis pass, then a fix-mapping pass, then a research pass, then an
implementation-plan pass.

| Session | Class | What it established |
|---|---|---|
| Deep audit and organize anyplugin repo | **ORCHESTRATOR** | The finding set A–L. Everything else descends from it. |
| Security audit of AnyPlugin | **PRODUCED** | Findings A, B, C; the P0/P1/P2 split. |
| Test coverage and quality audit | **PRODUCED** | Finding C; the "a test that cannot fail is not evidence" rule. |
| Documentation and DX audit | **PRODUCED** | Finding C's user-visible impact; the fact that the docs contradicted the code. |
| Plugin developer UX audit | **PRODUCED** | That the ownership gap was a *developer* problem, not only a safety one. |
| Code quality and architecture audit | **PRODUCED** | Finding C; the boundary discipline. |
| Audit findings analysis | **RECONCILIATION** | Merged the five audits into one set; removed the duplicates. |
| Map all files to modify for 5 fixes | **SUPERSEDED** | A file map for the first five findings. Superseded by the transactional rewrite, which touched a different set. |
| Research best practices for fixes | **PRODUCED** | The TOCTOU and journal-transaction patterns. |
| Create implementation plan for 5 fixes | **PRODUCED** | The plan that became `REMEDIATION_PLAN.md`. |

### The failures worth recording

**The most consequential finding was that the code was right and the tests
were not.** The five parallel audits all reported the *same* classes of
problem — a declared contract that nothing enforced. `timeoutSec` was in the
schema and ignored by the runner. `failurePolicy` was in the schema and
ignored by the runner. The journal had a schema and was cast rather than
validated. The OpenCode shim emitted every hook and then dropped all but the
last. The MCP server parsed YAML with a line-based heuristic.

That pattern — *declared but not enforced* — is why the fixes are regression
tests rather than code changes alone. A test that does not exist cannot fail,
and a contract with no test is a comment.

**Two findings were actively wrong, not merely unenforced:**

- The MCP frontmatter parser turned `tags: [a, b]` into a string and
  `verified: []` into `"[]"`, so the trust tier was computed from a non-empty
  list. The MCP tools were reporting false facts about the repository's own
  bundle. No test caught it because the tests asserted that the tools
  *responded*, not that the response was true.
- `okf-reindex knowledge` overwrote the hand-curated root `index.md`, and
  `AGENTS.md` instructed agents to run exactly that command. The inventory
  predicted this; it then happened, live, during this work.

**A recurring lesson from the reconciliation pass:** the five audits
independently produced overlapping findings with different wording. Merging
them was not clerical — it is what revealed that findings A–L shared a single
root cause and could be fixed as a coherent set rather than twelve unrelated
patches.

**Where the audit was wrong about itself:** the "map the files" session
assumed the fixes were local edits to five files. Three of them were not: the
transactional install needed a new module, the journal needed a migration
path, and the delegation contract needed to live in the kernel rather than the
CLI. Planning from "which file do I edit" produced a plan that had to be
rewritten.

---

## 2. The adjacent projects (38 sessions)

These did not touch this repository. They were the source of patterns, and one
of them is a hazard.

### `9router` (22 sessions) — a heterogeneous LLM router

**Class: REFERENCE.** A separate project with its own git history, in the
working directory.

Its value was three patterns, all of which appear here:

1. **The SLO gate** (`docs/operations/slo-gate.md`) — a deployment gate with
   a *closed* exit-code table: 0 allow, 1 block, 2 warning, 3 configuration
   error, 4 data unavailable. It made the case for a distinct code for "no
   backend could serve the request" rather than reusing the generic failure
   code, which is why `anyplugin delegate` exits **69** (`EX_UNAVAILABLE`).
2. **The chaos harness** — failure *injection* rather than failure
   simulation. This is the difference between a test that asserts a function
   returns an error and one that asserts the system *behaves* correctly when
   the error happens. The negative-case style of the new tests comes from here.
3. **Circuit-breaker runtime verification** — proving the breaker transitions
   under real conditions, not just asserting the state enum.

**Class: HAZARD.** It is a nested git repository inside this working
directory. It has its own `.git`, its own `package.json`, and it is one
`pnpm install` away from being picked up by the workspace. It is now
gitignored, and `docs/BACKLOG.md` records the decision: AnyPlugin is not
building an LLM router as a product (`ROADMAP.md` lists it under what is
deliberately not built); the delegation wrapper is the in-repo answer, and it
borrows the patterns rather than vendoring the project.

### `AI Router` (16 sessions) — the adversarial design passes

**Class: PRODUCED.** A research programme run as a *red team*: five
independent "agents" (evidence/competitive, customer-validation design,
business-model economics, technical feasibility, security/compliance) plus
four explicit red-team personas (security-and-reliability, OSS business
strategist, skeptical investor, small-team advocate) and a "verify the claims"
pass.

The transferable discipline is the **repo gate**: each dimension was reviewed
against a gate and told to *pass* or *block*, rather than producing commentary
that was then interpreted. A finding that could not block anything was not a
finding.

The other transferable idea is the **claim-verification pass** — a session
whose only job was to check that the other sessions' claims were actually
supported. It is why the delegation wrapper's failure taxonomy cites sources
rather than asserting a consensus.

### `AI Design Agent wrapper` (12 sessions) — the wrapper research programme

**Class: PRODUCED.** A staged research programme (S2 → S3 → S4) run with
multiple parallel researchers per stage, each with a named perspective:
*calm discernment*, *strategic detachment*, *pattern recognition*,
*delusional optimism*, *relentless curiosity*, *conflict states*, *error
channels*, *contract tests*, *agent QA layers*, *gates and hooks*.

Two stages are directly relevant to what shipped here:

- **S3 "error channels"** and **S3 "contract tests"** — the observation that
  the hard part of a wrapper is not calling the other system, it is knowing
  what the other system said when it failed. That is the error-envelope
  parser and the failure taxonomy.
- **S3 "gates and hooks"** — the observation that a hook must be a *gate*
  with an explicit pass/fail, not a side effect. That is `failurePolicy`,
  the `committed` flag, and the two fail-policy axes.

The naming of the research perspectives is worth copying: asking one
researcher for "the answer" produces the consensus; asking several for
*different kinds of answer* produces the disagreements, which is where the
design decisions live.

---

## 3. What the audit sessions established, in one list

1. **A contract with no test is a comment.** Every fix in this cycle ships
   with a regression test that fails without it.
2. **A failure that cannot be classified is not retried.** The taxonomy's
   `unknown` class is deliberately not retryable.
3. **The exit code is not the answer.** A backend can exit 0 after failing.
   Classification combines every signal.
4. **Capability and health are different axes.** One fails closed, the other
   fails open. Conflating them is a bug.
5. **A committed turn is terminal.** Fallback after commit splices two
   answers together and re-runs side effects.
6. **Never guess at a state you did not measure.** The `KNOWN_BY` taxonomy
   (`MEASURED` / `DERIVED` / `ESTIMATED` / `ATTESTED` / `UNKNOWN`) and the
   failure taxonomy are the same discipline applied to two things.
7. **A read must not have a side effect.** Selecting a backend claimed a
   circuit's half-open trial — a permanent silent exclusion produced by a
   decision that was never acted on.
8. **The repo's own documents are code.** Seven documents describing the
   architecture differently is a defect with a test count attached.
9. **Distrust a feature that was never executed.** `runner.js --batch` was
   documented as working, had no test, and could not work — three separate
   bugs in one function.
10. **Adversarial review finds what tests do not.** The independent review
    of this branch found four defects that the full suite passed over, three
    of them in code written *for* this branch.

---

## 4. The design sessions (2026-10-20)

Three parallel design passes produced the Agent/Worker SDK specification in
`docs/agent-sdk/`. They are recorded here because **the way they failed is
the lesson**, and because the failures were of a kind the audit had not
previously surfaced.

| Pass | Class | What it established |
|---|---|---|
| External-claim verification | **PRODUCED** | 19 external claims checked against primary sources: 6 `VERIFIED`, 8 `PARTLY VERIFIED`, 4 **`CONTRADICTED`**, 2 `UNKNOWN`. Full ledger in `docs/EVIDENCE.md`. |
| Identity, attestation and trust | **PRODUCED** | The threat model, the per-mode signature schemes, the forgery surface for each, the revocation semantics, the commit-point protocol, and the honest limit on non-repudiation. `docs/agent-sdk/trust.md`. |
| Autonomous optimisation and signals | **PRODUCED** | The candidate state machine reconciled with the kernel's epistemic ladder, the shadow protocol, twelve promotion gates, the ramp, the flapping detector, the optimizer budgets, the never-automated list, and nine anti-gaming signals. `docs/agent-sdk/optimization.md`. |

### The failures worth recording

**The pricing table was wrong in the direction that flatters the optimisation.**
Two of the four contradicted claims made caching look *better* than it is: the
OpenAI row omitted the cache-write charge that arrived with GPT-5.6, and the
DeepSeek row overstated the cached-read discount by an order of magnitude. A
third — the worked example — reproduced only by importing a write multiplier
the provider does not publish and by using a price it does not charge. **A
table that flatters the optimisation is the most dangerous kind of error to
publish**, because it is the error nobody re-checks. The corrected table and
the reasoning are in `docs/agent-sdk/economics.md` §1; the standing rule is
that a price is quoted with a source URL and an access date, never from
memory.

**A "pattern" was cited that has no citable source.** The "AIWorker with a
Soul" framing was presented as established practice. A search found 115
repositories named `AIWorker`, all visibly unrelated, and zero matching both
terms. The verdict is `UNKNOWN` rather than "does not exist" — the search was
GitHub-only, so a private post could exist. The lesson generalises: **a
pattern you cannot cite is a pattern you are proposing**, and it must be
labelled as yours.

**Both design passes independently proposed a SECOND evidence ledger and a
SECOND trust ladder** — and the kernel already owns both. This was the
single most instructive failure of the cycle: two independent expert passes,
given the same problem, both reached for a new vocabulary instead of reading
the existing contracts. The reconciliation (the evidence tier is a *projection*
over `EvidenceSchema`; the trust axis is the kernel's `EPISTEMIC_RUNGS`, with
a new *operational* axis alongside it) is recorded in `docs/DECISIONS.md` D-005,
D-006 and D-017.

**The trust design found a live defect in shipped code.** The commit-point
protocol's analysis — an attempt can commit an *effect* while producing no
output — showed that the shipped `fallbackLegal` rule is too narrow. It is
recorded as an open P1 with the exact edit named (D-013), because it changes a
frozen, certificate-bound contract and needs its own versioned migration.

**The "completeness" request produced a mechanical guard, not a promise.** The
user asked for complete, evidence-backed documentation. Rather than assert
completeness, `core/src/boundaries/doc-ownership.test.ts` now enforces it:
every document under `docs/` must be owned by `ARCHITECTURE.md`, every decision
must carry a context, a decision and consequences, every evidence row must
carry a verdict, a source and an access date, and every decision reference
must resolve. **The guard immediately found three orphaned documents and 17
under-specified decisions** — it paid for itself before it was finished.

### What the cycle established, in one list

11. **A price quoted from memory is a claim, not a fact.** Cite the URL and
    the access date, and re-verify before publishing.
12. **A pattern you cannot cite is a pattern you are proposing.** Label it.
13. **Before inventing a vocabulary, read the contracts that exist.** Two
    independent design passes proposed a second evidence ledger and a second
    trust ladder; the kernel already owned both.
14. **Completeness is a test, not a promise.** The guard found three orphans
    and 17 gaps on its first run.
15. **A design that only exercises the happy path is a design that will one
    day run something it should not.** Every negative case in the trust and
    optimisation designs is a specific, named failure with a specific
    behaviour.
16. **The honest limit is part of the deliverable.** "Not legal
    non-repudiation", "not protection from a hostile OS", "not
    confidentiality against the operator" — each is stated where a reader
    would otherwise assume the stronger property.
