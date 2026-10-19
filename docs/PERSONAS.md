# Personas, intent, and accountability

Who this is for, what each of them is trying to do, what they are accountable
for, and — the part that matters — what the system is **not** accountable to
anyone for.

This document extracts the actors already implicit in `ROADMAP.md` §1, the
`README.md` contract, the kernel's ownership map, and the SDK design. It
introduces no new ones. Where a persona is a *machine*, it is listed too,
because a machine actor with authority is a design decision, not a detail.

---

## 1. The intent, in one paragraph

> **AnyPlugin is a reliability substrate for agents that do real work.**
> It answers the questions an agent cannot answer about itself: what is this
> supposed to accomplish, what does it currently believe, why does it believe
> that, what has it changed, what experience has it accumulated, what can
> invalidate previous conclusions, what must be rechecked, and can we safely
> continue.

That is `ROADMAP.md` §1, verbatim in intent. The distribution layer
(`core/`, `adapters/`, `cli/`) is how a plugin reaches four different agents
natively. The Worker Runtime (`packages/worker-runtime/`) is the layer that
answers those questions, and it is the part that survives the agent.

**The agent is not the product.** The agents are improving quickly and are a
poor battlefield for a small team. The layer *around* the agent — what happens
when work becomes long-running, stateful, risky, and consequential across
sessions — is largely unoccupied. That is the opening this repository takes.

### 1.1 The separations that define the product

These are the load-bearing distinctions, and they are the reason the personas
below have the authority they do.

| The model is not… | …which means |
|---|---|
| **MEMORY** | recall is a runtime primitive with provenance, not a context window |
| **KNOWLEDGE** | what is true is separate from what was said |
| **EXPERIENCE** | what happened under which conditions is recorded, not inferred |
| **AUTHORITY** | the agent does not get to declare its own work correct |
| **VERIFIER** | verification is deterministic and runs outside the model |
| **EXECUTION ENVIRONMENT** | isolation is owned by us, not borrowed from the host |

**Consequences that follow, and that the personas depend on:**

- Claude Code's memory / `CLAUDE.md` → **optional convenience.** Our Worker
  State → **authoritative.**
- A Skill → **workflow instruction.** Our Verification Engine → **actual
  verification.**
- A subagent → **reasoning.** Our Evidence Ledger → **provenance.**

Without these, the product degenerates into a fancy prompt pack.

### 1.2 The explicitly-not product

`ROADMAP.md` §1, stated as a list, because a list of exclusions is a
constraint, not a preference:

- not another coding agent
- not another agent SDK
- not another MCP wrapper
- not a memory product
- not a plugin marketplace

And `ROADMAP.md` §6 records what is deliberately not built as a *product* —
including another LLM router. The delegation wrapper added in PR #28 is
**not** that: it is a front door to other runtimes, inside the distribution
layer, and `9router/` (a separate project with its own git history) is
gitignored rather than vendored. See `docs/DECISIONS.md` D-003 for why the
full SDK lives in `docs/agent-sdk/` as a specification of intent rather than in
this repository's scope.

---

## 2. Human personas

### 2.1 The Plugin Author

**Who.** A developer who writes one plugin and wants it to work in Claude Code,
OpenCode, Codex CLI, and Antigravity — without four implementations and
without a maintenance treadmill.

**Wants.** Write once. Have it installed natively everywhere. Have the install
be reversible, and *know* it is reversible.

**Is accountable for.** Their plugin's manifest, its hooks, its permissions.
They declare capabilities; the capability matrix decides whether a target can
honour them.

**Needs from the system.** One canonical manifest → four native bundles →
reversible, journaled installs. A strict-args CLI that refuses a silent
no-op. Capability verdicts that fail closed, so a target that cannot honour a
declared capability is a *build error*, not a runtime surprise.

**What the system must never do to them.** Silently ignore a declared
capability. Silently install into a directory they did not author. Destroy
their files on uninstall.

**Evidence.** `README.md` (the one-line product promise); `core/src/schema/`
(the manifest contract); `core/src/capabilities/matrix.ts` (the verdicts);
`cli/src/index.ts` (ownership proof and reversibility).

---

### 2.2 The End User — the person the agent works for

**Who.** Someone who installed a plugin, or is using an agent that has one.

**Wants.** Their agent to be more capable, and to not break. They did not
choose the plugin's internals and should not have to debug them.

**Is accountable for.** Their own workspace and their own data. Nothing else.

**Needs from the system.** The runtime must never break the host. A hook
failure exits 0 with a stderr note by default; the single exception is an
explicit `failurePolicy: "blocking"` that the **plugin author** opted into —
never the platform inferring it. An install is journaled, and an uninstall
restores exact pre-install bytes, and **aborts** rather than overwriting a
file they edited after the install.

**What the system must never do to them.** Delete a file they wrote. Leave a
half-installed plugin they cannot diagnose. Make them read a stack trace to
find out that a hook failed.

**Evidence.** `SECURITY.md` §3 (the runtime-isolation rule, corrected in PR
#28 to name the `blocking` opt-in); `cli/src/journal.ts`;
`cli/src/transaction.ts`; `plugins/knowledge/runtime/runner.js`.

---

### 2.3 The Operator

**Who.** Whoever runs the machine the work happens on. In a self-hosted
deployment, this is a platform team; on a laptop, it is the same person as the
End User.

**Wants.** To know whether the system is healthy, and to be told when it is
not. To be able to roll something back without a runbook.

**Is accountable for.** The host, the credentials, the egress, the spend.

**Needs from the system.** Diagnostics that name the problem and the fix:
`anyplugin doctor` decides a writer lock is stale by the **holder's liveness**,
not by file age, and `--fix` releases a stale lock but never an active or
unverifiable one. A rollback that happens **before** diagnosis. A cache that
warns when it stops paying for itself.

**What the system must never do to them.** Hide a degradation behind a green
dashboard. Auto-break a lock that might be held by a live writer. Make a
security-relevant change to permissions, credentials, egress, or spend caps
without a human.

**Evidence.** `cli/src/bin.ts` (the doctor); `docs/agent-sdk/optimization.md` §3
(rollback-before-diagnosis) and §6 (the never-automated list);
`docs/agent-sdk/economics.md` (the cache monitor).

---

### 2.4 The Auditor / Compliance Reader

**Who.** Someone who must answer "what did the system see, do, and prove?" for
a given run — for a customer, a regulator, or an incident review.

**Wants.** A reconstruction they did not have to be present for, and that they
can check.

**Is accountable for.** Their own conclusion. They need the evidence to be
*reconstructible*, not merely asserted.

**Needs from the system.** An append-only, hash-chained ledger where every
byte is accounted for as `COMMITTED`, `INCOMPLETE`, or `REJECTED`. Deterministic
replay. A record that says who attested what, with the chain visible.

**What the system must never do to them.** Overclaim. The honest claim is
*"I can reconstruct what the Worker saw, did, and proved, and I can detect
modification of that record."* It is **not** *"Alice personally signed this and
cannot deny it"* — that is not supported offline, with or without asymmetric
keys. It is **not** *"the record existed before time T"* — that needs an
external timestamp. Those wordings are forbidden in the audit export, the CLI
output, and the marketing copy, because a competent adversary will use them.

**Evidence.** `packages/worker-runtime/src/log/write-contract.ts` (the five
guarantees); `docs/agent-sdk/trust.md` §3.6 (the non-repudiation wording);
`docs/agent-sdk/trust.md` §4 (the three anchoring profiles).

---

### 2.5 The Maintainer

**Who.** Whoever changes this repository.

**Wants.** To know that a change is safe before merging it, and to know what
they are not allowed to break.

**Is accountable for.** The contracts. The invariants. The fact that the
documentation is true.

**Needs from the system.** A source-of-truth table (`AGENTS.md`), a definition
of done (`pnpm build` clean, `pnpm test` green, no silent skips), a mechanical
boundary guard that reports `ARMED` / `PASSED` / `FAILED` and never reports
`ARMED` as `PASSED`, and a doc-ownership test that fails the build when a
document has no owner.

**What the system must never do to them.** Accept a change because it passed
the tests, when the tests cannot fail. This is why an adversary review is part
of the definition of done (`docs/DECISIONS.md` D-038): the branch in PR #28
passed its own full suite and still shipped four BLOCKERs.

**Evidence.** `AGENTS.md`; `core/src/boundaries/package-boundary.test.ts`;
`core/src/boundaries/doc-ownership.test.ts`; `docs/DECISIONS.md` D-030, D-034.

---

### 2.6 The SDK Consumer — the developer embedding a Worker

**Who.** A developer building a product on the standalone Agent/Worker/Employee
SDK, in one of three modes: an in-process library, a local daemon, or a
deployed control plane.

**Wants.** One Worker specification that runs unchanged in all three modes. To
embed an agent in an existing application in ten lines. To know exactly what
the SDK guarantees and what it does not.

**Is accountable for.** The Worker specification they author: goals, tools,
model routing, memory policy, budgets, permissions, and grounding policy. They
implement four things — the spec, the tool definitions, the grounding policy,
and optional lifecycle hooks. Everything else is the SDK's.

**Needs from the system.** Portability, determinism (the recorded call log is
the source of truth; caching never changes the result), grounding (every claim
tagged with an evidence status and a provenance chain), accountability (every
tool call and state transition produces a receipt), resource efficiency
(caching and batching first-class, with measured economics), and error
containment (every hook and tool call inside an error boundary).

**What the system must never do to them.** Run a delegated turn twice because
the first one half-failed. Classify a failure it could not classify and retry
it. Change the result of a recorded call because a cache was cold.

**Evidence.** `docs/agent-sdk/README.md`; `docs/agent-sdk/economics.md` §1.3
(determinism); `docs/agent-sdk/trust.md` §5 (the commit-point protocol).

---

### 2.7 The SDK Operator / Tenant — the persona the "Employee" framing serves

**Who.** A business that wants work done by an agent that can be held
accountable: a claims triage desk, a support queue, a compliance reviewer.

**Wants.** To delegate a *role*, not a script. To see what the worker
believes, why, and what would change its mind.

**Is accountable for.** The scope it grants and the spend it caps. Nothing
else — the agent does not get to declare its own work correct.

**Needs from the system.** A grounding policy that decides what each evidence
tier may touch (a financial worker may block `UNCITED` numbers; a clinical
worker may require `VERIFIED` only). A truth-anchor store that wins over
internal memory on conflict. A trust tier and a staleness date on every
promoted learning. A cost cap that cannot be exceeded without explicit
approval.

**What the system must never do to them.** Present an `UNCITED` claim as
established. Let the worker widen its own scope. Let a learned behaviour
become permanent without re-validation.

**Evidence.** `docs/agent-sdk/trust.md` §6 (the grounding policy);
`docs/agent-sdk/optimization.md` §1.5 (trust tier and staleness);
`docs/agent-sdk/optimization.md` §6 (the never-automated list).

---

## 3. Machine personas

Machine actors are listed because **authority is a design decision**, and the
table below is where each one gets its — or is denied its.

| Actor | May it assert a fact? | May it sign an anchor? | May it change its own permissions? | May it verify its own work? |
|---|---|---|---|---|
| **The Worker** (the kernel's execution subject) | No — its output is an `OBSERVATION` | **No.** There is deliberately no `WORKER_ATTESTATION` kind | No | No |
| **The Model** (provider) | No — its output is an `OBSERVATION` | No — a provider never signs an anchor | No | No |
| **A Tool / MCP server** | No — its output is evidence with `authority: REPORTED` unless pinned | No | No | No |
| **A Plugin** (in-process code) | No | No | No | No |
| **A Human Attester** | **Yes** — via a signed anchor whose kind is admissible | **Yes** — for `HUMAN_ATTESTATION`, and for `REGULATORY_INPUT` only if their class is `AUTHORITY` | No | No |
| **A Tenant** | Yes — for tenant-scoped anchors, signed by the tenant's own key | Yes | No | No |
| **The Service (control plane)** | No — it co-signs *heads* and issues identity certs | Only what it signs is operator-asserted, and that is labelled as such | No | No |
| **The Optimizer** (the reflection subagent) | No | No | No | No — gate G9 excludes the candidate's own execution lineage |

**The two rules that fall out of the table, and they are the whole design:**

1. **The worker cannot anchor facts** (D-007). If it could, a hallucinating
   or prompt-injected model could launder a false claim into "verified", and
   the learning loop would be the laundering path.
2. **The system may not count as evidence for itself** (D-023 rule 3). No
   evidence item whose producer lineage includes the candidate's own shadow
   executions may back that candidate's promotion. This is enforced
   mechanically, never by judgement.

---

## 4. The authority table — who may do what, and who answers for it

| Action | Decided by | Accountable to | Recorded as |
|---|---|---|---|
| Which plugin targets exist | `core/src/detect/index.ts` (`ALL_AGENTS`) | the Maintainer | a build-time fact |
| Whether a target can honour a declared capability | `core/src/capabilities/matrix.ts` | the Maintainer | `NATIVE` / `DEGRADED` / `UNSUPPORTED` / `UNKNOWN` |
| Where a plugin is installed | `cli/src/index.ts` (`TEMPLATES`) | the Maintainer | the install journal |
| Whether an install may proceed | `cli/src/index.ts` (ownership classification) | the Operator | `ABSENT` / `OWNED` / `CONFLICTING` |
| Whether a hook failure denies the host | the **plugin author** (`failurePolicy`) | the Plugin Author | the runner's exit code |
| Whether a delegated attempt may fall back | the **failure class** (kernel constant) | nobody — it is a rule | `DELEGATION_*` event |
| Which backend serves a request | the registry's capability verdict, then health | the Operator | `ROUTE_SELECTED` event |
| Whether a claim is `VERIFIED` | an admissible anchor, resolved offline | the Human Attester | the anchor record |
| Whether a learning is promoted | the twelve gates | the Operator (or a recorded human approval) | `POLICY_PROMOTED` event |
| Whether a policy is rolled back | the seven automatic triggers | nobody — it is a rule | `POLICY_ROLLED_BACK` event |
| Whether permissions, credentials, egress, or spend caps change | **a human, always** | the Operator | a human approval naming a `contentHash` |

**The pattern:** the more consequential the action, the less the system is
allowed to decide alone. And the "accountable to" column is never the model.

---

## 5. Anti-personas — what this system is not

Naming these prevents the most common failure of an agent product: the
gradual, well-meant drift of a reliability substrate into a self-certifying
oracle.

| It is not… | Because… |
|---|---|
| a teammate | It has no stake in the outcome and no obligation to the person it works for beyond the contract it was given |
| a source of truth | It records what happened. What is *true* is separate from what was said (D-006) |
| a self-certifier | Verification runs outside the model; the agent does not get to declare its own work correct |
| a memory system with no provenance | Recall is a runtime primitive with provenance, not a context window |
| an authority it inherits from the host | Isolation is owned by us, not borrowed from the host |
| a marketplace | It ships one first-party plugin, not a catalogue |
| a router product | `ROADMAP.md` §6 lists "another LLM router" under what is deliberately not built |
| an agent SDK | `ROADMAP.md` §1 says so explicitly; the SDK in `docs/agent-sdk/` is a specification of intent, not this repository's scope (D-003) |

---

## 6. How this document stays true

| Claim type | How it is kept true |
|---|---|
| A persona's authority | Mirrored by a machine-checked rule in the kernel, or it is not authority |
| A persona's accountability | The never-automated list (`docs/agent-sdk/optimization.md` §6) is a constant in code |
| A separation ("the model is not MEMORY…") | `ROADMAP.md` §1 is the source; this document links to it |
| A count, a threshold, a price | `docs/EVIDENCE.md` carries the source and the access date |
| A "we never do X" claim | It must appear in the never-automated list or the fail-closed rules, not only here |

**A persona may not be added without stating what it is accountable for and
what it is forbidden from doing.** A persona with no accountability is a
marketing segment, not an actor in the system.
