# Substrate: the proven OSS stack, and what we deliberately build instead

**Seven repos. Four load-bearing, three deliberately built.** The evidence
base this replaces contained eleven factual errors; the corrections are in
`docs/agent-sdk/gaps.md` §3.

Every external claim below carries a source URL and an access date of
**2026-10-20**. Verdicts: `VERIFIED` / `PARTLY VERIFIED` / `CONTRADICTED` /
`UNKNOWN`.

---

## 1. The selection rule, stated first

A dependency is admitted to the SDK core only if **all four** hold:

| # | Rule | Why it is a rule and not a preference |
|---|---|---|
| 1 | **Licence allowlist** — MIT, Apache-2.0, BSD, ISC, public domain, Unicode-3.0, OFL-1.1 | AGPL §13 infects any linking service. ELv2 and BUSL are source-available, not open source. An unlicensed repo is **all rights reserved** — you may read it, you may not depend on it |
| 2 | **Permissive + maintained** — a licence we can ship, and a project with a release in the last 12 months | Rule 1 alone admits abandoned code that will not receive a security fix |
| 3 | **Not load-bearing if single-maintainer** | A 3★, one-author repo that gates our routing decision is a supply-chain single point of failure. Such projects are **wrapped behind an interface** or **cited as design references** |
| 4 | **A replacement path** — every dependency sits behind an interface we own, so it can be swapped without touching call sites | A dependency that is *in* the architecture is not a dependency; it is a fork we did not write |

Rule 4 is why the recommendation list has seven entries and the build list has
five. **The SDK's own contracts are the stable surface; the libraries are
pluggable backends.**

---

## 2. The seven

| Role | Repo | Licence | Maturity signal | Last activity | Verdict |
|---|---|---|---|---|---|
| 1. WASM client-side **PDF** | [`unjs/unpdf`](https://github.com/unjs/unpdf) · [`npm`](https://www.npmjs.com/package/unpdf) | MIT | 1,249★ · **4.1M weekly npm downloads** | v1.9.1, **2026-10-19** (the day before access) | **DEPEND** |
| 1b. WASM multi-format (**Office/HTML/CSV/JSON/XML**) | [`kreuzberg-dev/kreuzberg-lts`](https://github.com/kreuzberg-dev/kreuzberg-lts) → [`xberg-io/xberg`](https://github.com/xberg-io/xberg) | MIT (v4 LTS confirmed from the raw LICENSE) | 8.5k★ (Kreuzberg) · 9.4k★ (Xberg) | v5.0.0-rc.9, 2026-06-09 | **DEPEND — pin to the MIT line** |
| 2. Multi-agent orchestration, durable state | [`langchain-ai/langgraph`](https://github.com/langchain-ai/langgraph) | MIT | 43,500★ · 7,424 forks | v1.2.16, Oct 2026; **v1.0.0 since 2025-10-17** with a stated no-breaking-changes-until-2.0 policy | **DEPEND — behind an interface** |
| 3. Graph / state machine, conditional edges, bounded loops | [`statelyai/xstate`](https://github.com/statelyai/xstate) | MIT | 30,323★ · **3.0M weekly downloads** (measured 2026-10-20; an earlier draft said 5.1M, which was stale) · **zero dependencies** | v5.33.3 | **DEPEND** |
| 4. Prompt compression / context engineering | — none — | — | LLMLingua: 6,756★ but **v0.2.2, 2024-04-09**, self-classified `Development Status :: 3 - Alpha` | ~2.5 years without a release | **BUILD** |
| 5. Event-sourced SQLite + content-addressed cache | [`sqlite/sqlite-wasm`](https://github.com/sqlite/sqlite-wasm) · [`asg017/sqlite-vec`](https://github.com/asg017/sqlite-vec) · [`npm/cacache`](https://github.com/npm/cacache) | Apache-2.0 / MIT-Apache-2.0 dual / MIT | 1.1k★ / 8,194★ / 301★ | all three actively released | **DEPEND (2 of 3)** |
| 6. Telemetry | [`open-telemetry/semantic-conventions-genai`](https://github.com/open-telemetry/semantic-conventions-genai) + OTel JS | Apache-2.0 | SIG-governed | Active; status **Development** (unstable) | **DEPEND — pin a commit** |
| 7. Local / on-device inference | [`huggingface/transformers.js`](https://github.com/huggingface/transformers.js) + `google/embeddinggemma-2` | Apache-2.0 | 16,352★ | v4.3.1, **2026-10-07** (added EmbeddingGemma 2); v4.0.0 shipped a native C++ WebGPU EP | **DEPEND — with a fp32/fp16 guard** |

---

## 3. Why each one — and what it costs

### 3.1 `unjs/unpdf` — client-side PDF

**VERIFIED.** [GitHub](https://github.com/unjs/unpdf) ·
[npm](https://www.npmjs.com/package/unpdf) · accessed 2026-10-20

Ships a serverless build of Mozilla's **PDF.js** with the worker inlined, and
browser-specific references stripped. Works in Node 22+, Bun, browsers and
Cloudflare Workers. **Zero runtime dependencies.** API: `extractText`,
`extractTextItems` (positioned text with coordinates — for table detection and
citation anchors), `extractLinks`, `extractImages`, `renderPageAsImage`,
`getDocumentProxy`.

**The README is a specification, not a footnote.** It states three limits that
must become our defaults:

| unpdf's warning | Our default |
|---|---|
| `maxImageSize` is **unlimited** by default | Cap at 16 MiB, or a per-tenant lower cap |
| `extractText` processes **all pages in one call** | Check `pdf.numPages` against a limit **before** extracting |
| The serverless build parses **on the event loop with no worker** | Race every parse against a deadline |

**Does badly:** PDF only — no DOCX/XLSX/PPTX. PDF.js text extraction is
**flat**: no reading-order model, no table-structure model, no heading
hierarchy. Do not expect Docling-quality structure from it.

**Cost to depend vs build:** building a PDF text extractor from scratch is not
an option; building *on top of* PDF.js is exactly what unpdf does. **Depend.**

### 3.2 Kreuzberg v4 LTS / Xberg — multi-format

**VERIFIED**, with four **documented** WASM gaps.
[docs](https://docs.kreuzberg.dev/reference/api-wasm/) ·
[npm](https://www.npmjs.com/package/@kreuzberg/wasm) ·
[Xberg](https://github.com/xberg-io/xberg) · accessed 2026-10-20

Rust core; 91–96 file formats (PDF, DOCX/XLSX/PPTX, ODT/ODS/ODP, RTF,
HTML/XHTML/XML, EPUB, EML/MSG, CSV/TSV/JSON/YAML/TOML, archives); plugin
system; chunking; language detection; local FastEmbed embeddings; MCP server.

**Licence discipline — read the file, not the badge.** An earlier check of
this repository read the README's *"Elastic License 2.0 (ELv2)"* claim and
GitHub's `NOASSERTION` detector, and recorded the repository as
source-available. **A later check of the primary file found it MIT**, in five
independent places: the `LICENSE` file itself, the GitHub API `spdx_id`, the
README badge, the PyPI classifier, and the npm `license` field.

> **The rule this changes, and it is the important part: the licence must be
> read from the file, at the version being pinned, by the CI check — never
> from a README, a badge, or a detector.** A licence that has apparently
> changed between two reads in the same month is precisely why
> **D-045** requires the allowlist to be enforced against the resolved
> licence file, and why `summarize-lib`'s *"the code is MIT"* README claim
> with **no licence file at all** is a live counter-example.

The `kreuzberg-dev/kreuzberg-lts` repository that the v4 npm/PyPI packages
point at has a plain **MIT LICENSE** (confirmed from the raw file), and the
successor `xberg-io/xberg` is MIT.

> **Pin `@kreuzberg/wasm@4.x` (MIT) or adopt Xberg (MIT).** The repository was
> **renamed** — `kreuzberg-dev/kreuzberg` now redirects to `xberg-io/xberg` —
> so the pin is to the **v4 LTS line** or the successor, and the licence is
> re-read from the file at the pinned version by the CI allowlist check.

**The four WASM gaps, from the vendor's own reference.** These are not
bugs; they are the shape of the tier boundary:

| Gap | Consequence for us |
|---|---|
| **No layout detection** (needs RT-DETR via ONNX Runtime) | `LayoutDetectionConfig` errors in WASM. Layout-aware parsing is a **Node/edge-worker** tier concern |
| **No GPU / hardware acceleration** | Browser tier is CPU-only |
| **Single-threaded** — `ConcurrencyConfig.maxThreads` ignored | Browser tier parallelism must be achieved by **multiple workers**, not threads |
| **No LLM/VLM structured extraction** in WASM | `StructuredExtractionConfig` and VLM OCR are Node-tier only |

**Cost:** 24.9 MB unpacked WASM, and a rebrand to track. It is the only
permissive multi-format client-capable extractor that also does Office.

### 3.3 `langgraph` — durable multi-agent orchestration

**VERIFIED.** [GitHub](https://github.com/langchain-ai/langgraph) ·
[1.0 blog](https://www.langchain.com/blog/langchain-langgraph-1dot0) ·
accessed 2026-10-20

v1.0 ships exactly what an MVP 3 needs: **durable state that persists
automatically**, **save-and-resume at any point**, and **human-in-the-loop as
a first-class API** (pause → review → approve). Plus
`langgraph-checkpoint-sqlite` (release 3.1.2, Oct 2026) and
`langgraph-checkpoint-postgres`.

**Does badly, and this matters:**

1. **The checkpointer is a state snapshot, not an event log.** The kernel's
   log stays the only authority; LangGraph's checkpointer is a *materialised
   projection* of it.
2. Python is the reference implementation; the JS surface is thinner.
3. LangChain ecosystem gravity — a large transitive dependency surface, which
   fights "zero-compute-by-default".
4. It is a *server* framework. "Client-first" means the JS/edge build, where
   the checkpointing story is thinnest.

**Cost to depend:** depend, but behind an `AgentRuntime` interface and with
our own event log authoritative. Swapping to Temporal/Restate/DBOS later is
then a bounded change.

### 3.4 `xstate` — the evidence gate primitive

**VERIFIED.** [GitHub](https://github.com/statelyai/xstate) ·
[docs](https://stately.ai/docs/xstate) · accessed 2026-10-20

MIT, **30,323★**, **zero dependencies**, **3.0M weekly downloads** (measured
2026-10-20 — an earlier draft carried 5.1M, which was a stale figure that had
never been re-measured), 270 versions, 1.4k dependents.

This is the right primitive for **evidence-gated transitions**: a guarded
transition (`guard` predicate that must pass before an event is accepted) maps
directly onto *"a claim is only accepted once evidence is attached and
verified by a different identity"*. Bounded loops become explicit guard
counters. The actor model gives per-task isolation; `history` states give
resumability.

**Does badly:** XState is a **state-machine library**, not a **durable
execution engine**. It does not persist across process restarts by itself and
has no notion of *"replay this workflow from its event log"*. It pairs with
our log, not instead of it.

**Cost to depend:** depend. Zero-dependency MIT at 5.1M weekly downloads is
about as low-risk as an OSS dependency gets.

### 3.5 Prompt compression — **BUILD**

**VERIFIED, but rejected as a dependency.**
[`microsoft/LLMLingua`](https://github.com/microsoft/LLMLingua) ·
[llmlingua.com](https://llmlingua.com/) · accessed 2026-10-20

The *technique* is sound and the literature is real: perplexity-based token
eviction, a budget controller, coarse-to-fine selection; LLMLingua-2 uses a
BERT-level encoder distilled from GPT-4; LongLLMLingua adds query-aware
document reordering. Reported **20× compression with minimal loss** and
**+17.1% performance at 4× compression**.

**Why we do not depend on it:**

| Fact | Source |
|---|---|
| `setup.py` self-classifies as **`Development Status :: 3 - Alpha`** | the repo |
| **Last release v0.2.2 — 2024-04-09.** Two and a half years without a tagged release | npm/PyPI |
| Python + torch + transformers — a heavy, GPU-adjacent dependency inside a *client-first* SDK | the repo |
| It is a **research artifact**, not a maintained library | the repo |

**What we build instead, and why it is better for us:**

1. **Training-free, local, deterministic.** Score chunks with the
   EmbeddingGemma 2 embedder we already ship (cosine to the query) → keep
   top-k → drop the rest. The "LLMLingua effect" without the perplexity
   model.
2. **An evaluator-head gate — the part LLMLingua does not do at all.** A cheap
   local verifier decides whether the *compressed* context still answers the
   question. Emit `compression_ratio`, `evidence_recall` and `verifier_pass`
   as span attributes, so **prompt compression becomes auditable**.
3. LLMLingua stays an **optional server-side peer**, cited in the design doc.

**Budget:** ~400 LOC.

### 3.6 SQLite-WASM + sqlite-vec + cacache

**VERIFIED.** [sqlite-wasm](https://github.com/sqlite/sqlite-wasm) ·
[sqlite-vec](https://github.com/asg017/sqlite-vec) ·
[cacache](https://github.com/npm/cacache) · accessed 2026-10-20

- **`sqlite/sqlite-wasm`** — Apache-2.0 wrapper around SQLite (core itself
  public domain). 1.1k★, 274 commits. **OPFS persistence requires a Worker**
  and the headers `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp`. **Node.js support is
  in-memory only, without persistence** — stated in the README. The
  Worker1/Promiser1 APIs were deprecated **2026-04-15**.
- **`asg017/sqlite-vec`** — MIT **or** Apache-2.0, **8,194★**, single C file,
  **zero dependencies**, `vec0` virtual tables, float + int8 + binary vectors.
  **The integration tax is real and the repo says so:** *"It's not possible to
  dynamically load a SQLite extension into a WASM build of SQLite. So
  `sqlite-vec` must be **statically compiled into custom WASM builds**."*
  That is a **build-pipeline commitment**, not an `npm install`. It is
  **pre-v1** — pin the version.
- **`npm/cacache`** — MIT, 301★, 783 commits, by npm itself.
  Content-addressable cache with **Subresource Integrity** digests,
  multi-hash, automatic deduplication, corruption-tolerant reads, lockless
  high-concurrency access, `verify()` for GC and offline verification.
  **Node.js only** (fs-based).

**Consequence for the tiers:** the browser tier needs a CAS over **OPFS +
`crypto.subtle`** (~200 LOC — a *build* item), and in Node we use a **native**
SQLite because `@sqlite.org/sqlite-wasm` has no Node persistence. Event
sourcing is SQLite **WAL** mode plus an append-only `events` table with a
monotonic sequence and a hash chain. **No third-party library is needed for
that.**

### 3.7 OpenTelemetry GenAI

**VERIFIED**, and the draft's claim was **CONTRADICTED**. See
`docs/agent-sdk/gaps.md` §3 row 7.

The conventions **moved** out of `semantic-conventions` into
`semantic-conventions-genai`; the old `opentelemetry.io` URL is now a "Moved"
stub. Status is **Development** — attribute names can change.

What OTel actually defines for agents: `create_agent`, `invoke_agent`
(client and internal), `invoke_workflow`, `plan`, `execute_tool`, `load skill`,
`read skill resource`, `command execution`. `gen_ai.operation.name` values
include `chat`, `create_agent`, `create_memory`, `embeddings`, `execute_tool`,
`invoke_agent`, `invoke_workflow`, `plan`, `retrieval`, `search_memory`,
`text_completion`.

**The five phases OTel does not define — ours to define:**

| Phase | OTel name | Our private namespace |
|---|---|---|
| Planning | `plan` ✅ | — |
| Reasoning | — | `agent.reasoning` |
| Safety / guardrail | — | `agent.guardrail` |
| Delegation | — | `agent.delegation` |
| Memory (as a span) | — | `agent.memory` |
| State | — | `agent.state` |

> **Do not emit nine bespoke kinds and call it OTel.** Use `gen_ai.*` where it
> exists, a documented private namespace elsewhere, and state the upstream
> migration path.

**Also considered:** OpenInference (Arize/Phoenix) and OpenLLMetry
(Traceloop/Langfuse) — both "predate the official OpenTelemetry GenAI
conventions", so bridging needs a Collector `transform` processor. If a user
already runs Phoenix/Langfuse, use the Collector; do not fork the SDK.

### 3.8 `transformers.js` + EmbeddingGemma 2 — on-device inference

**VERIFIED**, with one **open correctness defect that must be designed
around**. [transformers.js](https://github.com/huggingface/transformers.js) ·
[EmbeddingGemma docs](https://ai.google.dev/gemma/docs/embeddinggemma) ·
[issue #1728](https://github.com/huggingface/transformers.js/issues/1728) ·
accessed 2026-10-20

**The model:** `google/embeddinggemma-2` — 740M params, **Apache-2.0**, built
on the Gemma 4 decoder, **unified 768-dim vector space** across text, images,
audio and video, **Matryoshka (MRL)** → 768/512/256/128 dims, **8,192-token**
context, 100+ languages. It outperforms EmbeddingGemma 1 on Code MTEB.
transformers.js **v4.3.1 (2026-10-07)** added support; v4.0.0 introduced a
native **C++ WebGPU EP** with ~4× speedup on BERT-style embeddings.

**The landmine — read this twice:**

> `transformers.js` issue **#1728**: *"[WebGPU] embeddinggemma-300m-ONNX q4/q8
> produce silently wrong embeddings (cos ≈ 0 vs WASM); fp32 correct"* —
> **opened 2026-07-22, still OPEN on the access date.**

For an SDK whose entire value proposition is *local, private, zero-token*
classification, **silently wrong embeddings are worse than no embeddings**.

**Mitigations, all three mandatory:**

1. Ship **fp32/fp16 on WebGPU** for the embedding path (589.5 MB / 1.15 GB
   downloads — CDN-cached, one-time), or the **q8 WASM** path (295.1 MB).
2. **Assert cosine sanity at startup** — a fixed-string probe; fail loudly if
   cosine < 0.99.
3. A **regression test comparing WebGPU against WASM** embeddings, in CI, on
   every release.

**Weight-download tax** (measured from the HF file tree, 2026-09-23): q4f16
WebGPU **168.0 MB**, q4 188.1 MB, q8 WASM **295.1 MB**, fp16 589.5 MB, fp32
1.15 GB. Disclose it in the install docs and offer a **local model directory**
(`env.localModelPath`, `env.allowRemoteModels = false`) for a fully offline
install.

**Also considered:** `mlc-ai/web-llm` (Apache-2.0, 19,279★) — a full in-browser
LLM with an OpenAI-compatible API and function-calling. Heavier (GB-scale),
so it stays an **optional** backend, never the default.

---

## 4. What we build instead of depend on

Five build slots. Total ≈ **1,500 LOC**. Each has a named reference and a
licence-clean provenance.

| # | We build | Reference (read, not copied) | Licence position | LOC |
|---|---|---|---|---|
| B1 | **Hierarchical chunker + summary tree** with progressive disclosure | [`sermakarevich/chunker`](https://github.com/sermakarevich/chunker) — the algorithm is the most valuable thing in the draft evidence base: leaf chunks → section summaries → document summary, bidirectional parent/child links with source spans, per-chunk checkpoint/resume | **NO LICENSE FILE → all rights reserved.** Reimplement from the published README + the repo's own `FR-01…FR-11` requirements spec. Cite the README as a design reference. If we want the code, we ask the author for a licence grant | ~500 |
| B2 | **Binary-tree reducer** for parallel long-text summarisation | The pattern is real and widely implemented, but the two named repos are 1★ and 0★ with no tests or releases. Canonical instances: LangChain's `map_reduce` chain, Chunker's bottom-up aggregation, `ExtensityAI/summarize-lib` | No licence risk — the pattern is a textbook map-reduce | ~150 |
| B3 | **Prompt-compression gate** with an evaluator head | `microsoft/LLMLingua` (MIT) for the idea; the *gate* is ours | MIT reference, our code | ~400 |
| B4 | **Browser content-addressed cache** over OPFS + `crypto.subtle` | `npm/cacache` (MIT) for the semantics — but it is Node-only | MIT reference, our code | ~200 |
| B5 | **Deterministic graph traversal engine** — in the **kernel** | The kernel already owns `GraphNodeSchema`/`GraphEdgeSchema`/`GraphSnapshotSchema` and `EDGE_KINDS`. The *engine* is missing. `ROADMAP.md` M5 requires "deterministic traversal across branching, multi-hop, cycles, disconnected components; byte-identical output for identical input" | **Our own code, in the kernel** — MVP 2 | ~250 |

**B5 is the only build slot that lands in AnyPlugin rather than the SDK
repo**, and it is the one that completes an existing roadmap milestone rather
than starting a new one.

---

## 5. The licence allowlist and the deny-list

### Allowlist

`MIT` · `Apache-2.0` · `BSD-2-Clause` · `BSD-3-Clause` · `ISC` · `0BSD` ·
`Unlicense` · `CC0-1.0` · public domain · `Unicode-3.0` · `OFL-1.1` ·
`PostgreSQL` · `BSL-1.0` *(only with the non-production restriction removed
before distribution)*

### Deny-list — and why each is here

| Denied | Reason |
|---|---|
| **AGPL-3.0** — BentoPDF, PyMuPDF-WASM | §13 network-use clause infects any linking service. **BentoPDF is excluded today** |
| **Elastic License 2.0** | Source-available, not open source. Denied **as a licence class** — the check reads the file at the pinned version, so a repository whose licence is actually MIT is admitted. (Kreuzberg is the live case: it was recorded as ELv2 from a README and later found to be MIT in the file.) |
| **BUSL-1.1** | Source-available with a production restriction |
| **No licence file** — `sermakarevich/chunker` | Default copyright: **all rights reserved**. Readable, not dependable upon |
| **SSPL** | Network-copyleft; unusable for a library |
| **AGPL-adjacent data** — GeoLite2 (MaxMind EULA) | A gazetteer under a non-OSS EULA cannot ship. Use an **ODbL** open gazetteer or skip the tool |

### The check, and where it runs

A **licence-allowlist test** in CI: every entry in the lockfile's licence
field must be in the allowlist, or appear in an explicitly-reviewed exception
file naming the dependency, the licence, the reason, and the expiry review
date. This is the same discipline as the repo's existing
`core/src/boundaries/package-boundary.test.ts`, applied to a new dimension.

---

## 6. "Is there already a project that does the whole thing?"

**We found no production-scale project that does the whole thing** — and, as the ledger says, absence of a publication is `UNKNOWN`, not proof of absence. Every project matching "local-first +
durable multi-agent + evidence gating" found in the sweep is small and young.

| Project | Licence | Scale | What it does |
|---|---|---|---|
| [`letta-ai/letta`](https://github.com/letta-ai/letta) | Apache-2.0 | 25,125★ | The closest to a local-first stateful agent: subagents, a local App Server, hooks, permission modes, crons, and **MemFS — all context tracked via git** |
| [`pydantic/pydantic-ai`](https://github.com/pydantic/pydantic-ai) + `pydantic-graph` | MIT | 20,733★ | Typed agent loop, **nine durable-execution engines**, a pure typed graph library, `StepPersistence` (checkpoint every settled step to *your* store, including SQLite), and `Pydantic Evals` |
| `fakoli/anvil` | MIT | small | *"The system of record for agent teams"* — durable, evidence-gated, lease-coordinated state |
| `vajramatt/chainproof` | MIT | small | One Go binary, one SQLite DB, **SHA-256 hash chains**, a provenance ledger with `observed / reported / imported / derived`; resume from a verified checkpoint |
| `blue-az/operator-control-plane` | — | small | **Narration-vs-execution partition**: a claim counts only once evidence is attached *and* verified by a **different OS identity** |
| `Yomiracle/trinity-lite` | MIT | small | Local control plane; capability-based routing; **bounded delegation depth**; allowlisted working dirs; **accept-with-evidence** gate; 150+ tests; zero core deps |
| `AnThophicous/apex-multi-agent` | — | small | **SQLite WAL** durable state, channels, task graph, Guardian review gates, workspace checkpoints, rollback |
| `open-covenant/covenant` | — | small | Rust daemon; signed capabilities; append-only JSONL audit with **local hash-chain verification**; SQLite-backed memory tiers; MCP + A2A adapters |

**The gap is real, and it is the business case.**

### 6.1 The four patterns that keep recurring — these are the actual IP of the category

1. **A hash-chained append-only event log in local SQLite, WAL mode.** Five
   independent implementations converge here (ChainProof, operator, CAST,
   APEXMA, Covenant). **The kernel already has the stronger version** — a
   framed, hashed, single-writer log with an explicit `DurabilityLevel`.
2. **The evidence gate is a distinct state transition with a *different*
   verifying identity.** Three independent implementations. The kernel has
   the vocabulary (`authority` × `validity` × rung) and the prohibition (the
   worker may not sign an anchor); the *transition* is MVP 1.
3. **Bounded delegation depth and an allowlisted working directory as hard
   constraints, not advisory ones.** Two independent implementations. The
   kernel has the allowlist (`safe spawn`, env allowlist) but **no depth cap**.
4. **Durable state is a machine-local control plane, not a hosted service.**
   All of them.

### 6.2 What to steal, and what not to

| Steal | From | Why |
|---|---|---|
| **MemFS** — git-versioned agent context | `letta` | Content-addressed, diffable, forkable. Our `contentHash` + snapshot model is the same idea without git |
| **Hooks at key execution points** as the extension point for evidence gates | `letta` | The right seam: the gate is a hook, not an inline check |
| **Permission modes** (auto-approve / auto-deny) | `letta` | The tool-policy model; but our approval must name a `contentHash`, per D-022 |
| **"Durability is not storage"** — separating *keep a run alive* from *keep the thread* | `pydantic-ai` | The distinction our two-store decision (D-040) needs |
| **"One durable execution engine per agent"** | `pydantic-ai` | A second engine raises an error before binding. A rule we can make mechanical |
| **`StepPersistence`** — snapshot per settled step, not engine-mandated durability | `pydantic-ai` | Fits our direction of truth: the checkpoint is a projection of the log |
| **Evaluators that grade *trajectories*, not just outputs** | `pydantic-ai` Evals | Our compression gate needs exactly this |
| **Capabilities as attachable** | `pydantic-ai` | The tool registry shape in `tools.md` |
| **`/doctor <symptent>`** as a debug surface | `letta` | We already have `anyplugin doctor`; the SDK should mirror the shape |

**Do not copy:** server-plus-Postgres architectures; cloud-default postures;
LLM-managed memory (it hallucinates its own context); the absence of any
parsing layer; the absence of any evidence/provenance model.

---

## 7. Related documents

| Document | Owns |
|---|---|
| `docs/agent-sdk/roadmap.md` | Where each of these lands, and in which MVP |
| `docs/agent-sdk/tools.md` | The 18-tool surface the substrate must support |
| `docs/agent-sdk/simulations.md` | The certification matrix that every dependency must pass |
| `docs/agent-sdk/gaps.md` | The eleven corrected claims, and the conflict register |
| `docs/EVIDENCE.md` | The source URL and access date for every figure above |
| `docs/DECISIONS.md` | D-044 (build compression), D-045 (licence allowlist), D-046 (telemetry namespace) |
