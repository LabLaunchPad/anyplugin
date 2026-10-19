# The Agent/Worker/Employee SDK — specification of intent

**Status: specification, not implementation.** Nothing in this directory is on
AnyPlugin's build path, and no acceptance criterion here gates AnyPlugin's
build. The reason it is in the repository at all is in
`docs/DECISIONS.md` **D-003**: the SDK is a *consumer* of the Worker Runtime
kernel, and the reasoning is worth keeping where the kernel is.

> `ROADMAP.md` §1 says this product is "**not** another agent SDK". That is
> still true of AnyPlugin. This directory specifies a **different** product
> that AnyPlugin's kernel could serve. `ROADMAP.md` §6 also lists
> "Kubernetes runtime", "cloud dashboard" and "SaaS billing" as things
> AnyPlugin is **not** building as a product — which is precisely the scope
> of the SDK's phases 2.4, 3.1 and 4.3 below. The overlap is the point:
> these are the same capabilities, deliberately placed in a different
> product. See `docs/DECISIONS.md` D-003 and `docs/BACKLOG.md` P1-12.

---

## 1. What the SDK is

A standalone, embeddable runtime for an AI "Worker" that produces claims and
can **prove** them.

| Mode | What the developer gets | When to use it | Runtime family |
|---|---|---|---|
| **Library** | `import { Worker } from "@lablaunchpad/agent-sdk"` — in-process | Embedding an agent in an existing application | The host application's runtime |
| **Daemon** | `agent-sdk start --soul ./my-worker.yaml` — local daemon, SQLite state, local workbench, CLI | Local-first, desktop, on-premises, air-gapped | Native binary or Node.js |
| **Control plane** | `agent-sdk deploy --target kubernetes` — the same spec, deployed | Cloud, multi-tenant, enterprise scale | Serverless or Kubernetes |

**One Worker specification drives all three modes.** The Worker never depends
on the control plane to run; the control plane is a replication lever, not a
runtime dependency.

### 1.1 The invariant that makes "polylithic" safe

Multiple native runtimes means multiple build pipelines, multiple release
cadences, and a canonical specification that must be versioned carefully.
That coordination cost is real.

What makes it affordable is a single invariant:

> **Every layer has a stable contract** — a schema, a protocol, or an API — so
> that its implementation can be replaced without touching its consumers.

This is the same discipline the Worker Runtime already follows: ten frozen
contracts at `1.0.0`, each with a JSON Schema mirror and a byte-for-byte
drift test, plus a mechanically enforced package boundary.

**What "no irreversible tradeoffs" actually means here.** It does not mean no
tradeoffs exist. It means the product is not locked into one runtime, one
provider, one deployment target, or one ungrounded source of truth. Every
layer has a replaceable implementation, and every learning must pass through
evidence before it is promoted.

---

## 2. What the developer implements

Four things. Everything else is the SDK's.

1. **A Worker specification** (`worker.yaml`): goals, missions, tools, model
   routing, memory policy, budgets, permissions, evidence requirements,
   grounding policy, cache policy, batch policy.
2. **Tool definitions**: MCP server references, or native function handlers
   with typed inputs and outputs.
3. **A grounding policy**: which claims require evidence, what evidence tiers
   are acceptable, and what happens when a claim is ungrounded.
4. **Lifecycle hooks** (optional): `onStart`, `onStep`, `onReplan`,
   `onComplete`, `onError` — each inside a non-blocking error boundary.

The SDK provides the iteration loop, replanning, state persistence, caching,
batching, evidence recording, and the deployment adapters.

### 2.1 The guarantees

| Guarantee | Mechanism | Where the substrate already exists |
|---|---|---|
| **Portability** | The Worker spec runs unchanged in library, daemon, and control-plane modes | — |
| **Determinism** | The recorded call log is the source of truth; caching never changes the recorded result, only the cost of producing it | `packages/worker-runtime/src/log/` |
| **Grounding** | Every claim carries an evidence tier and a provenance chain | `EvidenceSchema` (tier is a *projection* — D-006) |
| **Accountability** | Every tool call, model call, and state transition produces a hash-bound receipt | `EventSchema`, `CertificateSchema` — the certificate binds hashes, not signatures; signatures are a proposed addition (`trust.md` §7.3) |
| **Resource efficiency** | Caching and batching are first-class, with measured hit rates and automatic fallback when cache economics turn negative | `ResourceMeasurement`, `DurabilityLevel` |
| **Error containment** | Every hook and tool call runs inside an error boundary; failures degrade gracefully and are recorded as structured events | `ContractFailureClass`, `DelegationEvent` |

### 2.2 What it does not guarantee

Stated, because a guarantee that is silently narrower than advertised is worse
than no guarantee.

- **Not legal non-repudiation.** Offline, with or without asymmetric keys, the
  honest claim is *"I can reconstruct what the Worker saw, did, and proved, and
  I can detect modification of that record."* Not *"Alice personally signed
  this and cannot deny it."* See `trust.md` §3.6.
- **Not protection from a hostile operating system.** A hostile kernel or a
  malicious hypervisor can forge any local measurement. The claim is
  "internally consistent and matches an externally published head", never
  "the machine is honest".
- **Not confidentiality against the operator.** In every mode where the
  service terminates TLS and handles plaintext, the operator can read tenant
  data. Client-side encryption is deferred precisely because it breaks the
  "an auditor can reconstruct" property.
- **Not a guarantee that the loop is currently enabled.** The optimizer is
  out-of-band, and "the optimizer failing is never a worker failure".

---

## 3. The two design gaps this closed

The architecture review that produced this spec had two gaps that were filled
by the design work in `trust.md` and `optimization.md`.

### 3.1 Grounding: a four-tier model, and where it actually lives

The four tiers are **`VERIFIED` / `UNCITED` / `BROKEN` / `UNSUPPORTED`**, and
the derivation is **not** restated here — it is defined once, in
`trust.md` §2, and recorded as a decision in `docs/DECISIONS.md` D-006.

The one thing worth repeating here is *why* it matters: the tier is a
**projection** over the kernel's `EvidenceSchema`, not a stored field and not
a second ledger. It is computed from `authority` × `validity` × citation
resolvability × producer lineage, so it cannot drift from the record it
describes.

> **One input is not a kernel field.** The optional *entailment hook* (an NLI
> model, an LLM judge, or a deterministic rule) can downgrade a cited claim
> to `UNSUPPORTED`. It is a proposed addition, not something `EvidenceSchema`
> carries today — which is why `trust.md` §2 and D-006 mark it as the single
> non-kernel input to the derivation.

**Prior art:** none found in the searched corpus — see `docs/EVIDENCE.md` E18
and the caveat in U4. The design is ours; see `docs/EVIDENCE.md` §7.

### 3.2 Truth anchors: facts the agent must not contradict

The evidence model handles **claims the agent makes**. Truth anchors handle
**facts the agent must not contradict**. An anchor is an append-only,
externally-signed fact with a kind, a claim, evidence, an attester id, and a
signature, in six source kinds: human attestation, hardware signal,
regulatory input, external observation, signed document, consensus result.

When the agent's internal memory conflicts with a truth anchor, **the anchor
wins**. That is what prevents memory poisoning and hallucinated "learnings"
from overriding verified facts. Supersession chains let facts evolve without
mutating history.

The full design — including the mode-specific signature schemes, the forgery
surface for each, the revocation semantics, and the commit-point protocol —
is in **`trust.md`**.

---

## 4. Module decomposition

Ordered by dependency, not by calendar time. A small team can parallelise
modules that share no dependencies. Each acceptance criterion is **checkable**
— a test, not an adjective.

### Phase 1 — Canonical spec and standalone core

| Module | Todos | Acceptance criterion |
|---|---|---|
| **1.1 Worker specification schema** | Define the `worker.yaml` schema: goals, missions, tools, model routing, memory policy, budgets, permissions, grounding policy, cache policy, batch policy. Publish it as a versioned JSON Schema with a changelog. Build a linter that warns on unsafe defaults | The schema validates with field-level errors; the JSON Schema is derived, not hand-written, and a drift test fails when they disagree; the linter catches all three unsafe-default classes (no grounding policy, unbounded budgets, wildcard tool permissions) |
| **1.2 Standalone runtime (daemon mode)** | `agent-sdk start --soul ./worker.yaml` with SQLite state and a local workbench. The iteration loop: plan → execute → reflect → replan. Non-blocking error boundaries around every tool call and hook. The evidence recorder | A user can run a Worker locally with one command; the loop survives a forced kill and resumes from the last checkpoint; a failing tool produces a structured error event and the loop continues; a test trace produces `VERIFIED`, `UNCITED` and `BROKEN` correctly |
| **1.3 Library mode** | Publish the programmatic `Worker` class. Share the iteration loop and evidence recorder with daemon mode. Typed tool-definition helpers | A developer can embed a Worker in a Node.js app in under ten lines; a **conformance test** proves library and daemon modes produce identical traces for identical inputs |
| **1.4 MCP tool layer** | An MCP client for stdio and HTTP servers. An MCP gateway with per-Worker rate limits and audit logging. Tool-failure fallbacks: retry with backoff, alternate tool, graceful degradation | A Worker can call a filesystem MCP server and a remote HTTP MCP server in the same run; every MCP call produces a receipt with server, tool, input hash and output hash; a failing MCP server does not crash the Worker |

**Phase 1 gate.** A developer can write a Worker spec, run it locally in daemon
and library mode, call MCP tools, and inspect evidence receipts. The
conformance test between modes passes.

### Phase 2 — Control plane, UI, and grounding

| Module | Todos | Acceptance criterion |
|---|---|---|
| **2.1 Grounding service** | The four-tier classifier. The truth-anchor store: append-only, signed, with supersession chains. The grounding-policy engine. An optional entailment-hook interface | A 50-claim suite is classified correctly, including invented quotes and expired receipts; anchors cannot be overwritten and supersession is auditable; signature verification catches tampering; a financial Worker blocks `UNCITED` numbers and a clinical Worker requires `VERIFIED` only; a rejected cited claim produces `UNSUPPORTED` |
| **2.2 Prompt cache middleware** | Stable-prefix construction with provider-specific breakpoints. A local content-addressed prompt cache. The cache-economics monitor. The determinism guarantee | The stable head is byte-identical across turns; repeated identical requests hit locally with zero provider calls; a simulated low-hit-rate scenario triggers a warning and a recommendation to disable; **a replay test produces identical outputs with caching on and off** |
| **2.3 Batch orchestrator** | Batch-eligibility policy. Provider adapters for OpenAI, Anthropic, Gemini. Result reconciliation with per-request error handling. The combined caching + batching path | Ineligible tasks are rejected with a descriptive reason; a batch job can be submitted, polled and reconciled across all three providers; a partially failed batch produces per-request results, not an all-or-nothing failure; a 10k-prompt eval run uses the batch API and shared-prefix caching, and the cost is measured against the real-time baseline |
| **2.4 Thin UI and control plane** | The web UI: chat, worker dashboard, evidence inspector, cache/batch cost panel. The control-plane API: deploy, pause, resume, inspect, roll back. Multi-tenant isolation | A non-technical user can start a Worker, see its evidence status and view cost savings; the same spec deploys to serverless and Kubernetes without modification; tenant A cannot read tenant B's evidence, cache or anchors |

**Phase 2 gate.** The system grounds claims with evidence, caches prompts with
measured economics, batches eligible workloads, and exposes a thin UI. The
control plane deploys the same spec to at least two execution families.

### Phase 3 — Multi-runtime adapters and the learning loop

| Module | Todos | Acceptance criterion |
|---|---|---|
| **3.1 Kubernetes and serverless adapters** | A Kubernetes adapter: Helm chart, Worker CRD, MCP gateway sidecar. A serverless adapter: scale-to-zero, session persistence, cold-start optimisation. A runtime-conformance suite | A spec deploys to a Kind cluster and to a managed EKS/GKE/AKS cluster; a Worker runs on Lambda or Cloud Run with zero idle cost and resumes state after a cold start; the same spec produces **identical evidence receipts** on daemon, Kubernetes and serverless |
| **3.2 Device runtime adapter** | The embedding contract for mobile (Kotlin/Swift) and desktop (Rust/C++) runtimes. Offline mode: local model fallback, local evidence store, deferred sync. Device-level resource guards | A minimal Worker runs on Android and iOS with a local model and MCP tools; a Worker completes a task offline and syncs evidence when connectivity returns; the Worker backs off under memory, battery or thermal pressure instead of crashing |
| **3.3 The learning loop** | Trace extraction. Validation against truth anchors and evidence receipts. Promotion with trust tiers and staleness dates. A reflection subagent with a bounded budget | A trace becomes structured candidate learnings; a candidate contradicting a truth anchor is **rejected and logged**; a promoted learning is tagged validated or hypothesis, and hypothesis learnings are re-validated on schedule; the reflection subagent cannot exceed its token and time budget |

**Phase 3 gate.** The same Worker runs on daemon, Kubernetes, serverless, and
at least one mobile target with conformance-tested evidence. The learning loop
extracts, validates and promotes learnings without contradicting truth anchors.

### Phase 4 — Ecosystem, localisation, and business layer

| Module | Todos | Acceptance criterion |
|---|---|---|
| **4.1 Partner kit** | A white-label UI build with tenant theming. A self-hosted distribution (Docker Compose and single binary). A certification curriculum and a sandbox | A partner can rebrand the UI without forking code; an SI can deploy the full stack on a VPS in under 30 minutes; a partner can train staff and demonstrate competence |
| **4.2 Localisation** | First-class regional language support. Low-bandwidth and intermittent-connectivity modes. Region-specific model routing | A regional-language user can complete the core workflow without English; the Worker syncs evidence and results without a persistent connection; a tenant can route to domestic providers with data residency |
| **4.3 Business layer** | Usage-based billing with a free tier and spend caps. Compliance reporting: evidence audit trail, data residency, access logs. An open-source core under MIT/Apache-2.0 with a managed control plane as the commercial layer | A user cannot exceed a configured spend cap without explicit approval; an auditor can reconstruct what the Worker saw, did and proved for any run; the OSS core is independently installable and passes the conformance suite |

**Phase 4 gate.** A partner can self-host, white-label and support a regional
customer. The business layer enforces spend caps and produces compliance
evidence.

---

## 5. What this spec depends on, and what it would change

### 5.1 It consumes the kernel — it does not fork it

| SDK need | Kernel substrate |
|---|---|
| The ledger | `packages/worker-runtime/src/log/event-log.ts` — framed, hashed, single-writer, `DurabilityLevel` |
| Deterministic replay | `log/replay.ts` — every byte classified `COMMITTED` / `INCOMPLETE` / `REJECTED` |
| Evidence with authority and validity | `contracts/index.ts` — `EvidenceSchema` |
| The epistemic ladder | `contracts/primitives.ts` — `EPISTEMIC_RUNGS`, `rungIndex()` |
| Experience with a failure taxonomy | `contracts/index.ts` — `ExperienceSchema`, `CONTRACT_FAILURE_CLASSES` |
| Certificates | `contracts/index.ts` — `CertificateSchema` |
| Delegation failures and the fail-policy axes | `telemetry/delegation.ts` — `DELEGATION_FAILURE_CLASSES`, `FAIL_POLICY` |
| Cost and latency | `resource/telemetry.ts`, `resource/measurement.ts` — `KNOWN_BY` |

### 5.2 Two changes it would require in the kernel

Both are recorded in `docs/BACKLOG.md` as open P1 items with the exact edit
named, and **neither is applied in this change** — both version frozen,
certificate-bound contracts.

1. **New event kinds** for the candidate lifecycle and the policy promotions
   (`CANDIDATE_CAPTURED`, `CANDIDATE_STAGE_CHANGED`, `SHADOW_EVAL_COMPLETED`,
   `POLICY_PROMOTED`, `POLICY_ROLLED_BACK`, `POLICY_PINNED`,
   `BUDGET_EXHAUSTED`), under a versioned migration `1.0.0 → 1.1.0`. The
   alternative — a sidecar optimizer log — is rejected in D-037.
2. **`fallbackLegal` must consider `IN_FLIGHT` effects**, not only committed
   output (D-013). This is the single most important correctness item in the
   trust design, and it is a one-line change with a large blast radius.

---

## 6. Related documents

| Document | Owns |
|---|---|
| `trust.md` | Identity, attestation, the anchor chain, the commit-point protocol, multi-tenant isolation |
| `optimization.md` | The learning loop, the shadow protocol, the ramp, and the nine top signals |
| `economics.md` | Prompt caching and batching, with the corrected provider table |
| `docs/EVIDENCE.md` | The source of every external number quoted in this directory |
| `docs/DECISIONS.md` | Why each of these choices was made, and what was rejected |
| `docs/PERSONAS.md` | Who the SDK serves, and what they are accountable for |
| `docs/BACKLOG.md` | What is still open, classified |
