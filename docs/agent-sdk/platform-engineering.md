# Platform engineering: the patterns stolen from Linux, Debian, Android, Apple and the clouds

**Every pattern here was read from a published contract** — a man page, a
policy document, an architecture guide, or an open specification. **No
proprietary implementation source was read.** All sources were accessed
**2026-10-20**; the full source ledger with verdicts is in
`docs/EVIDENCE.md`.

**The three legal questions, kept apart:**

| Question | Our position |
|---|---|
| **Patent** | Not analysed. No clearance is claimed. Flagged as a gap, not a clean bill |
| **Copyright** | We learn **mechanisms and architectures** (facts about how systems work) and **never copy expression** — source, prose, comments, error strings, byte sequences |
| **Contract** (licence / ToS / trademark) | The live question for *behaviour*. Every pattern here comes from a published contract, a documented interface, or black-box observation we are authorised to make |

**The operative rule:** every claim in this document must be answerable from a
**named public artefact**, and that artefact must be documentation, a
specification, a published interface, or a licence. If a mechanism can only
be learned by reading a proprietary implementation, it is out of scope —
permanently.

---

## 1. The pattern catalogue

**Fifty patterns**, each with the mechanism, what it buys, where it lands in
the SDK, and the tier it belongs to. Tier = `worker` (any worker) ·
`orchestrator` (the SDK's own coordinating tier) · `platform` (the SDK's
operators) · `kernel` (the deterministic substrate).

| # | Pattern | Mechanism | What it buys | Lands in | Tier |
|---|---|---|---|---|---|
| 1 | **One path boundary** | Lexical rejection + two-sided realpath containment | Untrusted input becomes a path through exactly one chokepoint | `core/src/fs/safe-path.ts` | kernel |
| 2 | **Every input has a schema** | Zod validation at every model boundary | Malformed model output is a typed error, not a crash | MVP 1 `1.4`; MVP 5 `5.1` | platform |
| 3 | **Default-deny, with an unknown-kill default** | seccomp treats every unknown action as `KILL_PROCESS` | Unknown ⇒ terminate, never "assume support" | `core/src/capabilities/matrix.ts` | kernel |
| 4 | **A four-state capability matrix** | NATIVE / DEGRADED / UNSUPPORTED / UNKNOWN | Compatibility becomes authored data, not folklore | `core/src/capabilities/matrix.ts` | kernel |
| 5 | **Policy ceilings are not grants** | AWS SCPs *"do not grant permissions"* — they can only remove | A guardrail platform can never confer authority | MVP 3 `3.5` (D5) | orchestrator |
| 6 | **Explicit, minimal, non-inheriting authority** | Linux capabilities are per-process bits; `execve` raises only within the inheritable set | A child never inherits ambient credential | MVP 3 `3.5` (D5); MVP 5 `5.4` | orchestrator |
| 7 | **Name isolation per worker** | A namespace isolates the *names* a process sees | A worker cannot see another worker's world | MVP 1 `1.1`; MVP 3 `3.2` | worker |
| 8 | **One budget envelope per tier** | cgroup v2: write a PID into `cgroup.procs` to attach a cgroup | CPU/memory/pid ceilings attached by one operation | MVP 3 `3.5`; MVP 4 `4.3` | worker |
| 9 | **"No internal process" ⇒ one owner per subtree** | cgroup v2's no-internal-process constraint | A supervisor cannot double-book a subtree | MVP 3 `3.1` | orchestrator |
| 10 | **Bounded queues with explicit limits** | SRE: shed early rather than degrade everything | Overload is bounded by construction | MVP 3 `3.2`; MVP 6 `6.4` | worker |
| 11 | **Token-bucket budgets (rate + burst)** | AWS Organizations throttling: a sustained rate plus a burst allowance | A budget with *both* a steady rate and a burst | MVP 3 `3.5`; MVP 7 `7.4` | platform |
| 12 | **Budgets are control surfaces, not reports** | AWS/GCP Budgets with thresholds and automatic actions | A spend ceiling that triggers a response | MVP 4 `4.3`; MVP 6 `6.3` | platform |
| 13 | **Submission ≠ execution** | io_uring evaluates permission when the operation is *performed* | Work can be enqueued without being authorised | MVP 3 `3.4` | worker |
| 14 | **Readiness is declared, not inferred** | systemd `Type=notify` + `sd_notify` | A worker announces READY; no polling heuristic | MVP 3 `3.3`, `3.7` | worker |
| 15 | **The platform owns the listener** | systemd socket activation hands the fd over | Workers never bind or race a socket | MVP 3 `3.1` | platform |
| 16 | **No-privilege-escalation as a declared property** | systemd `NoNewPrivileges=` — *"the simplest and most effective way to ensure that a process and its children can never elevate privileges again"* | Escalation is prevented **by the mechanism, when the mechanism is present**. The SDK's equivalent is the **non-inheriting authority grant** (D5), which is a *policy* control, not a kernel one — so the SDK must *verify* the grant rather than assume the kernel enforces it | MVP 5 `5.6`; MVP 7 `7.3` | worker |
| 17 | **Namespace / capability allow-lists** | systemd `RestrictNamespaces=` allow-list | Reach is declared in one file | MVP 5 `5.1` | worker |
| 18 | **Stackable, ordered policy hooks** | The LSM framework: independent modules, each seeing the same event | Several policy modules, one event stream | MVP 7 `7.2` | kernel |
| 19 | **A permanently forbidden combination** | SELinux `neverallow` — forbidden *no matter who asks* | The never-automated list becomes machine-checked | MVP 7 `7.6` | platform |
| 20 | **Verify before you admit** | The eBPF verifier proves termination and bounds *before* the program runs | A policy module must pass a check before it may act | MVP 7 `7.2`; MVP 8 `8.2` | platform |
| 21 | **Prove a guard can fail** | `ARMED` vs `PASSED` — a guard that cannot fail is never reported as passing | The guard is a test, not a claim | MVP 8 `8.2`, `8.3` | kernel |
| 22 | **Eradicate the class, not the instance** | `VERIFY → FIX → ERADICATE THE CLASS → TEST → UPDATE LEDGER` | One defect record per class, every instance named | `docs/agent-sdk/learnings.md` | platform |
| 23 | **Reversibility as a first-class feature** | Transactional install, byte-exact restore, or abort | Nothing done requires trust that survives a mistake | MVP 3 `3.4`; MVP 7 `7.4` | platform |
| 24 | **Measure before defining a field; absent, never zero** | `MEASURED`/`DERIVED`/`ESTIMATED`/`UNKNOWN`; a missing token count must not make an execution look free | A missing metric never masquerades as free | MVP 6 `6.2`; MVP 1 `1.1` | platform |
| 25 | **Detect, don't assume** | Framed append detects tamper; replay reports gaps and duplicates as distinct anomalies | Integrity is proven, not asserted | `packages/worker-runtime/src/log/event-log.ts` | kernel |
| 26 | **An honest state vocabulary** | `UNKNOWN` is a first-class answer; an unclassifiable failure stays unclassified | No silent success; no fabricated classification | Kernel contracts; `docs/FAILURE-MODES.md` | kernel |
| 27 | **Three grades of dependency** | Debian: `Depends` / `Recommends` / `Suggests` | Required vs recommended vs discoverable tools have different failure semantics | MVP 5 `5.2` | worker |
| 28 | **The privileged act is a separate artefact** | `deb-systemd-helper` is *"specifically NOT intended to be used interactively"* | The agent may *request*; a named helper performs the privileged act | MVP 5 `5.6` | platform |
| 29 | **No silent partial state** | dpkg latches a configuration error and leaves the package explicitly half-configured | A half-applied change is an explicit, diagnosable state | `cli/src/journal.ts`; MVP 3 `3.3` | platform |
| 30 | **A canonical home per artefact class** | FHS 3.0 + Debian Policy ch.9/ch.10 | "Where did this go" is not a failure mode | `core/src/okf`; kernel `storage.ts` | kernel |
| 31 | **N-1/N-2/N-3 support windows** | Debian always keeps ≥3 active releases | A rollback target always exists; deprecation is dated | MVP 8 `8.1` | platform |
| 32 | **Every app is a principal** | Android: one Linux UID per app | Authority attaches to an identity, not to a prompt | MVP 5 `5.4`; MVP 3 `3.5` | worker |
| 33 | **Tenant = a UID range** | Android multi-user: per-user UID ranges, e.g. 1010034 | Tenant isolation is arithmetic, not configuration | MVP 3 `3.3` | platform |
| 34 | **Cross-tenant = a named permission** | `INTERACT_ACROSS_USERS` is `signature\|system` | Cross-boundary capability has a provenance class | MVP 3 `3.5` | orchestrator |
| 35 | **Identity travels with the request** | Binder carries the caller's UID with the transaction | Possession of a handle ≠ authorisation | MVP 3 `3.5` (D11) | orchestrator |
| 36 | **Fork from a warm template** | The Zygote forks and rewrites PID and cgroup | Cheap worker spawn from a pre-warmed image | MVP 3 `3.2`; MVP 8 `8.2` | worker |
| 37 | **Two-phase grant** | Android: install-time permissions vs runtime "dangerous" permissions | *Declaring* a capability ≠ *holding* it | MVP 5 `5.1` vs `5.6` | worker |
| 38 | **Signature separate from artefact** | APK v4 carries a separate `.apk.idsig`, with a fallback if missing or invalid | Content hash + separately-carried, revocable signature | MVP 9 `9.2`; MVP 7 `7.3` | platform |
| 39 | **Compile at admission** | ART compiles with `dex2oat` at install time | A worker is prepared and verified before it runs | MVP 1 `1.2`; MVP 8 `8.3` | worker |
| 40 | **A published, user-visible latency budget** | Android's ANR: 5 s input dispatch; 5 s `startForeground` | Timeouts are *published* budgets with named consequences | MVP 3 `3.8`; MVP 5 `5.6` | worker |
| 41 | **Dated compatibility cliffs** | 16 KB pages from Android 15; API 35+ must support them | Compatibility deadlines are dates, not intentions | MVP 8 `8.2` | platform |
| 42 | **Per-resource, revocable consent** | App Sandbox; TCC grants are per-resource and revocable | Grants are revocable per resource | MVP 5 `5.5`, `5.4` | worker |
| 43 | **Purpose-bound grants** | Entitlements are signed into the artefact | The grant set is unforgeable by the caller | MVP 3 `3.5` | platform |
| 44 | **Privilege separation *and* stability** | XPC gives *"two main reasons… privilege separation and stability"* | Isolation justified by correctness, not only security | MVP 3 `3.2` | worker |
| 45 | **A protected floor** | System Integrity Protection | The kernel's contracts and log live beneath worker reach | `packages/worker-runtime/` boundary tests | kernel |
| 46 | **Consent per call, not per app** | TCC: a per-resource basis, not a blanket app permission | A blanket app-level permission is insufficient | MVP 5 `5.6` | platform |
| 47 | **Trust before execution** | Notarisation/Gatekeeper; Verified Boot; Binary Authorization | Admission is decided by content identity | MVP 7 `7.2`; MVP 8 `8.3` | platform |
| 48 | **Platform tier on trusted execution** | Confidential computing (hardware-backed TEE) | Kernel secrets are not in worker process memory | Platform-tier deployment | platform |
| 49 | **Cells = blast radius** | A cell is a *"bulkhead in a ship"* | A worker failure cannot escalate past its cell | MVP 3 tier boundaries; `3.7` zoom-out | worker |
| 50 | **Static stability** | The data plane *"has no dependency on the control plane"* | Work continues when the control plane is down | MVP 3 `3.4`; `3.7` | platform |
| 51 | **Control plane ≠ data plane** | Distinct APIs, distinct failure domains | The model is never the verifier | MVP 3 `3.1` vs `3.2` | orchestrator |
| 52 | **Versioned policy with a cap** | IAM: five managed-policy versions; **inline policies are unversioned** | Policy history is bounded; inline config is forbidden | MVP 7 `7.3` | platform |
| 53 | **Explicit evaluation order** | Azure: enumerate the applicable assignments, then evaluate each definition | The applicable-policy set is computed first | MVP 3 `3.6` | orchestrator |
| 54 | **Version your policies** | Azure assignments always use the latest definition state | A silent global change is a known trap — pin versions | MVP 7 `7.2`, `7.4` | platform |
| 55 | **Effect-typed enforcement** | Azure's published effect list (`audit`, `deny`, `modify`, `deployIfNotExists`…) | OBSERVE→WARN→REQUIRE→BLOCK expressed as policy types | MVP 6 `6.2`; MVP 7 `7.2` | platform |
| 56 | **Shadow mode for policy** | Azure `doNotEnforce` + an on-demand evaluation scan | A candidate policy is scored, never enforced, first | MVP 7 `7.1` | platform |
| 57 | **No long-lived credential in the worker** | Azure managed identity: platform-issued, no stored secret | The platform issues identity; the worker holds none | MVP 5 `5.4` | platform |
| 58 | **A named, audited break-glass** | AWS SEC03-BP03: emergency access only in emergencies, credentials auto-rotated, activity audited | The escape path is governed, not ad hoc | MVP 7 `7.6` | platform |
| 59 | **An error budget is a spend permission** | SRE: the budget is derived slack, spent deliberately | A budget breach has a defined consequence | MVP 4 `4.3`; MVP 6 `6.3` | platform |
| 60 | **Roll back before diagnosing** | Reliable product launches: canary, percentage rollout, rollback first | Rollback is automatic; diagnosis follows | MVP 7 `7.4` | platform |

### 1.1 The three that changed the plan

| # | Pattern | Why it changed something |
|---|---|---|
| **19** | SELinux `neverallow` | The never-automated list was a **prose table**. It becomes a **machine-checked constant** — a combination forbidden *no matter who asks*. This is D-022 with a mechanism attached |
| **35** | Binder carries the caller's UID | The delegation contract's D11 ("a server-minted handle bound to the authenticated principal") is the same requirement, and Android solved it at the IPC layer thirty years ago. The SDK should copy the **mechanism**: identity travels *with the transaction*, not beside it |
| **56** | Azure `doNotEnforce` | Our shadow mode was described as "run the candidate in parallel". Azure gives it a name and a **deployment posture**: `doNotEnforce` is a first-class mode, not a special case. MVP 7 `7.1` now says so |

### 1.2 The four that were already ours

Patterns **1** (one path boundary), **4** (four-state capability matrix),
**21** (prove a guard can fail), **25** (detect, don't assume) and **26** (an
honest state vocabulary) are **not new**. They are this repository's own
invariants, arrived at independently. The value of the catalogue is the
**confirmation**: three separate mature systems converged on the same shapes,
which means the shapes are right rather than merely liked.

---

## 2. The multi-tier worker ladder

**Vocabulary fixed:** `worker` · `orchestrator` · `platform` · `kernel`.
**OS analogy:** *process → service → supervisor → platform.*

| | **Junior worker** | **Mid worker** | **Senior worker** | **Orchestrator** | **Platform / Kernel** |
|---|---|---|---|---|---|
| **OS analogue** | process | service (a unit) | supervised service group | supervisor (the manager) | the platform / init |
| **Capabilities it may hold** | only the `local` tool tier explicitly granted | `local` + specific `network` tools via the egress chokepoint | `local` + `network` + a *named* MCP server, per-tenant grant | orchestration and admission decisions — **not** the ability to widen a child's scope | all policy, budgets, promotion, rollback, emergency access |
| **It explicitly cannot** | use any `network` tool; use any authority it was not granted | grant anything; hold a capability absent from its manifest | promote a lesson past its own rung; write to the never-automated list | **create** a capability; self-approve | bypass the never-automated list — it is a constant in code, not configuration |
| **Budget shape** | one turn, one attempt, hard cap | per-contract cap + a burst allowance (token bucket) | per-contract cap + a checkpointed horizon budget | fan-out and depth caps; the **D9 gate** | platform-wide error budget; **publish**, don't merely track |
| **Time horizon** | tick — one decision, one bounded projection | tick plus a few ticks | horizon — a contract, checkpointed | horizon across many contracts | quarters |
| **Authority model** | non-inheriting, capability-style bits | explicit grant, revocable, per-resource | explicit grant + purpose binding | grants *down*, never *up* | grants *within* the ceiling only |
| **Isolation** | own UID / namespace | own cgroup | own cell | control plane, separate failure domain | trusted execution / a protected floor |
| **Failure policy** (per concern) | OBSERVE→WARN on tool errors; BLOCK on malformed output | REQUIRE on schema failure; BLOCK on a permission request | BLOCK on verification failure; HITL before irreversibility | REQUIRE on an invalid delegation; BLOCK on gate failure | BLOCK on a never-automated attempt — a **hard stop**, recorded as an anomaly |
| **Liveness contract** | declares READY | checkpointed, resumable | checkpointed + shadow-arm capable | never binds a socket; owns the listener | owns admission, promotion, rollback |
| **It may never** | write outside its authorised root | promote a lesson | promote a lesson | open a capability, widen a scope, or raise a budget | ship an efficacy claim before the falsification experiment |
| **Observable contract** | a span per stage | + domain success rate | + `pass^k` | the bottleneck report — top 3 by cost and latency | the projected monitor |
| **Verdict semantics** | a typed result envelope (D6) | envelope + evidence records | envelope + artefacts with hashes | an **integrated** artefact with `residualGaps` | an audit trail — the kernel event log |

**The three load-bearing lines in that table:**

1. **The orchestrator cannot create a capability.** It can *route*, *schedule*
   and *decide*, but authority flows **down** only.
2. **Every tier has a different failure policy for the same concern.** A
   verification failure BLOCKs a senior worker and is merely OBSERVED by the
   platform's telemetry exporter. This is the error-boundary ladder applied
   **per concern**, not globally.
3. **The platform tier cannot bypass the never-automated list**, because it
   is a constant in code — not configuration an operator can relax.

---

## 3. The reverse-engineering worksheet

**Format, used for every system in §1:** **READ** (the published contract —
name the URL and the section) · **MEASURE** (the number, and its
provenance) · **INFER** (the transferable principle — always labelled) ·
**NEVER-DO** (what must not be copied).

| System | READ | MEASURE | INFER | NEVER-DO |
|---|---|---|---|---|
| **Linux** | `cgroup-v2`, `capabilities(7)`, `namespaces(7)`, `seccomp(2)`, the LSM docs, SELinux, eBPF, `io_uring(7)`, the systemd man pages | cgroup: a file-based interface, one PID per write. seccomp: an unknown action **kills**. systemd: `RestrictNamespaces=` allow-list; `NoNewPrivileges=` is *"the simplest and most effective way…"* | Authority is bits on a process; isolation is namespace-scoped; policy is stackable hooks | Do not read kernel source — the docs are complete. Do not assume `O_APPEND` atomicity beyond `PIPE_BUF` (4096 bytes) |
| **Debian** | Debian Policy ch.6/7/9/10; `debian.org/releases`; `dpkg(1)`; `deb-systemd-helper(1p)`; FHS 3.0 | ≥3 active releases; stable = trixie (13.0 on 2025-08-09) | Dependencies are *declared*, graded and evaluated; maintainer scripts are the trust boundary; half-configured is an explicit state | Do not treat an undeclared dependency list as a contract; do not call the privileged helper interactively |
| **Android** | `core/permissions`, `runtime_perms`, `apksigning` (+v4), `verifiedboot`, `app-sandbox`, `selinux/concepts`, `core/runtime`, `core/runtime/zygote`, `binder-overview`, `cdd`, `page-sizes`, `vitals/anr`, `devices/admin/multiuser-apps` | ANR: **5 s** input dispatch; **5 s** `startForeground`. ART AOT via `dex2oat` at install. Per-user UID ranges (e.g. 1010034). 16 KB pages from Android 15; API 35+ must support them | An untrusted actor inside a trusted host is a **first-class** problem, solved by identity, labels, install-time verification and published budgets | Do not read AOSP internals. Do not bypass a signature or keystore check. Do not treat a *declared* permission as a *held* permission |
| **Apple** | Platform Security (sandboxing, SIP, TCC, code signing, runtime security, secure updates, app protection/groups); the archived XPC guide; the App Sandbox Design Guide; `sandbox-exec(1)` | `sandbox-exec` is **DEPRECATED** → App Sandbox. XPC's *"two main reasons… privilege separation and stability"* | Consent is per-resource and revocable; grants are signed into the artefact; isolation buys **stability** as well as security | Do not build on a deprecated enforcement surface. Do not read `sandboxd` internals. Do not use vendor marks in tier names |
| **AWS** | The Fault Isolation Boundaries whitepaper; the cell-based architecture paper; the IAM User Guide; the Organizations Guide; CloudTrail concepts; Well-Architected SEC03-BP03 and AG.SAD.5; PrivateLink; Budgets; EC2 instance types; Nitro | Organizations throttling is a token bucket: **20 rps baseline / 30 burst**. Managed policy: **5 versions**; inline policies **unversioned**. CloudTrail logs **4** event types and *"isn't an ordered stack trace"*. SCPs *"do not grant permissions"* | Cells bound blast radius; the data plane must not depend on the control plane; **ceilings ≠ grants**; an external audit log is not a stack trace | Do not claim ordered causality from CloudTrail. Do not rely on a policy definition being immutable — pin versions yourself |
| **GCP** | Binary Authorization + breakglass; service accounts; IAM conditions; the org-policy hierarchy; projects; build provenance; the Cloud Run container contract; budgets; gVisor | Binary Authorization evaluates at **deploy time**; breakglass is a separate governed path; IAM conditions are CEL over token/resource/request attributes | Admission is by content identity; constraints inherit down a hierarchy; provenance is an artefact attribute | Do not assume gVisor is a VM — it is a user-space kernel. Do not read its internals |
| **Azure** | Management groups; Policy overview + effects + evaluate-impact; managed identity; Private Link; confidential computing | Published effect list: `addToNetworkGroup, append, audit, auditIfNotExists, deny, denyAction, deployIfNotExists, disabled, manual, modify, mutate`. Assignments always use the latest definition state. A failed template evaluation is an **implicit deny**. `doNotEnforce` for shadow testing | Effects are the OBSERVE→BLOCK axis as policy types; **new / updated / existing** is a third axis we lack; shadow mode is a deployment posture | Do not assume an effect is GA — the preview status is **UNKNOWN**. Do not assume a definition change is inert for existing assignments |
| **VPS / hosting** | DigitalOcean's rate card; EC2 burstable; Nitro | Shared-CPU and burstable are **separate product classes**; baseline + borrowed capacity | Capacity is **typed** — a tier promising an SLO needs guaranteed capacity | **The magnitude of noisy-neighbour impact is UNKNOWN** — no primary vendor quantification was located. **Do not quote a number** |
| **Cross-cloud ops** | The SRE Book (nine chapters) + Workbook; the Argo Rollouts spec; SLSA v1.1 | SLOs are targets over windows; error budgets are derived slack; Argo steps = `setWeight` / `setCanaryScale` / `pause` / `analysis` / `experiment`; SLSA defines levels | Overload must shed early; rollback precedes diagnosis; retries must be bounded and jittered; provenance has **levels** | **"Chaos engineering" is not a chapter in the SRE Book v1** — that URL is a 404. **CONTRADICTED.** Cite "Testing for Reliability" instead |

---

## 4. The legal boundary

**The pattern is lawful; copying the expression is not.** The cases that
protect what we are doing protect it **narrowly**.

| Authority | What it holds | What it does **not** hold |
|---|---|---|
| **Sega v. Accolade**, 977 F.2d 1510 (9th Cir. 1992) | Reverse engineering **for interoperability** is fair use — without it the owner would have *"a de facto monopoly over the functional aspects"* | It did **not** license copying source; the decompilation recovered only **unprotectable functional elements** |
| **Sony Computer Entertainment v. Connectix**, 203 F.3d 596 (9th Cir. 2000) | The PlayStation BIOS reverse engineering was fair use | It distinguished the *interface* code actually copied |
| **Google v. Oracle**, 593 U.S. 1 (2021) | Copying a functional API was fair use **on the facts** | The Court **assumed without deciding** that the declaring code was copyrightable. **Never claim "APIs are not copyrightable"** — that is contradicted by the disposition |
| **Directive 2009/24/EC, Art. 6** | Decompilation is lawful **in so far as indispensable for interoperability**, and **only if the information is not otherwise readily available** | It is a Directive; the operative law is national. **Do not claim "EU law permits X"** — claim what Art. 6 requires |
| **17 U.S.C. §1201** | — | Circumventing a technological protection measure is unlawful. **Never** extract keys from an OS keychain, Android Keystore, a TPM blob or DPAPI. Never defeat a signature check |

> **Correction to a citation that is commonly mis-stated:** the PlayStation
> case is **Sony v. Connectix (203 F.3d 596)**, not *"Sony v. Datel"*.
> `Datel Corp. v. Game Control Tech., 240 F.3d 21 (2d Cir. 2001)` is a
> different case about a different practice.

### 4.1 The clean-room protocol, as a process discipline

Not a legal opinion — a way of making the learning defensible.

| Team | Inputs | Output | Forbidden |
|---|---|---|---|
| **A — the observer** | The artefact, read-only, under NDA if any | A **behavioural specification**: inputs → outputs, the error taxonomy, the observable contract | May **not** write shipping code; may **not** annotate with code excerpts |
| **B — the implementer** | **Only** Team A's specification | The implementation | May **not** view, read, or be told about the target's source |

The bridge is a written specification that is (a) reviewed by someone who
has seen neither side's private notes, (b) free of any expression from the
target, and (c) written in the vocabulary of **behaviour** — *"a request with
an expired receipt is rejected with reason EVIDENCE_EXPIRED"* — rather than of
**structure**.

**Where this applies here:** the SDK's kernel contracts, the event-log
format and the capability matrix are **our own** design and need no clean
room. The **only** external artefact we study in depth is **published vendor
documentation** — which is documentation, not source, and is fair to learn
from.

### 4.2 What we refuse to steal

| Refused | Why |
|---|---|
| AGPL-3.0 code in the kernel, SDK or MCP server | §13 imposes a network-source obligation on the whole modified service. Denied outright |
| Any copyleft that would cross the kernel boundary | The kernel must remain a dependency leaf |
| A field-restricted licence (a modified Apache-2.0, or dual-condition terms) | The SDK's intended deployment mode is exactly the one they restrict |
| Vendor SDK internals, decompiled binaries, private APIs | §1201 exposure, and expression is copyrightable regardless |
| Key/secret extraction from any OS store | The clearest §1201 case. Denied absolutely |
| A deprecated enforcement surface | When the platform retires a mechanism, the successor is the new floor |
| Vendor prose, error-message strings, documentation text, example code | Expression — the one thing all four fair-use cases leave unprotected |
| Vendor names as tier or feature names | Trademark risk. **Source attributions in the docs; descriptive naming in the code** |
| Learning from any service in breach of its terms | Contract breach — and it is how supply-chain compromises arrive |
| Behaviour inferred from a proprietary black box beyond its published contract | The clean-room protocol requires the specification to come from observation *or* documentation; proprietary observation may breach contract or trade-secret duty |
| A cross-SDK throughput comparison | **No measured cross-SDK benchmark exists**; each vendor's numbers are self-published. We decline to fabricate one |

---

## 5. What nobody has built

Stated as claims about the **combination**, because each ingredient exists
somewhere. **The absence claim itself is `UNKNOWN`** — absence of
publication cannot be proven — and is marked as such rather than asserted.

| # | The gap | Status |
|---|---|---|
| 1 | A tier ladder where authority is **simultaneously** explicit, non-inheriting down the delegation chain, revocable mid-run, bound to a declared purpose, **and** measured for its effect on reliability | Ingredients VERIFIED; the **absence** is `UNKNOWN` |
| 2 | A delegation-topology **gate** enforced at runtime — the D9 rule is published, but no production runtime ships it as a control | The rule VERIFIED; the **absence** is `UNKNOWN` |
| 3 | An error-boundary ladder that is **per-concern and typed as policy effects** — no vendor ships one spanning model output, tools, supply chain, state, autonomy and host protection | Azure ships effect-typed policy; the **unified span** is `UNKNOWN` |
| 4 | **Cross-session, multi-day `pass^k`** and **injection-persistence** measurement | τ-bench measures within-session; the multi-day question is **unmeasured anywhere** we could locate |
| 5 | A kernel that **refuses to hold LLM inference** while holding the evidence, invalidation and promotion engines — the *separation* enforced by a package-boundary test | `INFERENCE` |
| 6 | A **named, audited, credential-rotated break-glass** for a *worker*, not just for an account | AWS ships the guidance; the **agent-runtime instance** is `UNKNOWN` |
| 7 | A **host-adversarial threat model** for agent workers on a shared VPS | gVisor provides the mechanism; no agent SDK ships the threat model |

---

## 6. Related documents

| Document | Owns |
|---|---|
| `docs/agent-sdk/roadmap.md` | Where each pattern lands, and in which MVP |
| `docs/agent-sdk/learnings.md` | The extraction ledger, the negative cases, and what is planned but unbuilt |
| `docs/agent-sdk/substrate.md` | The dependencies, and the licence allowlist |
| `docs/agent-sdk/simulations.md` | The certification harness these patterns are tested in |
| `docs/EVIDENCE.md` | Every source URL, access date and verdict |
| `docs/DECISIONS.md` | D-039 … D-049 — why each choice was made |
