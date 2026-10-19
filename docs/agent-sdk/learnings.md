# Learnings: the extraction ledger, the negative cases, and what is planned but unbuilt

**This is the ledger.** Every learning extracted from every source, with its
source, its **status**, its **negative case**, and where it lands.

**Status vocabulary** (deliberately closed, and different from the document
status vocabulary in the ownership guard):

| Status | Meaning |
|---|---|
| `ADOPTED` | Learned, designed for, and scheduled into an MVP |
| `BUILT` | Learned and **already implemented** in this repository |
| `REFERENCED` | Learned and cited as a design reference; not a dependency |
| `BUILD-NOT-DEPEND` | Learned; **reimplemented** rather than depended upon (licence or maturity) |
| `REFUSED` | Learned and **deliberately not adopted**, with the reason recorded |
| `DEFERRED` | Learned; real and valuable; **not yet scheduled** |
| `UNKNOWN` | Claimed by a source but **not verifiable** from a primary source |

**The rule that governs this file:** *a learning without a source is not a
learning; it is an opinion.* Every row carries a source. Where a source's
own numbers are self-reported, that is stated.

---

## 1. The Unee 0.3.0 extraction — a full read of the source

**Source:** the PyPI metadata and README for `unee` **0.3.0**, uploaded
2026-10-08, Apache-2.0, author Muneef Mumthas / UNEEVERSE, built on Qwen3.5
(Apache-2.0). Read via the PyPI JSON API on **2026-10-20**.

This project is small, single-author, self-benchmarked, and **honest about
its own limits** — which is exactly why it is worth reading in full. It
independently rediscovered several of this repository's design decisions.

### 1.1 What it is

A small open model (0.8B or 2B) that does **two jobs from one loaded
model**: it returns a **calibrated probability per option** for a
caller-supplied option list, and it streams chat. It runs in a browser tab
(WebGPU), on CPU via llama.cpp or onnxruntime-node, and behind an HTTP
server. No API key, no per-call fee.

The decision API is `noul` (yes/no), `choice` (pick one), `score` (rate).
It is **Jev-compatible** (`/v1/systemone`) and also exposes an
OpenAI-compatible `/v1/chat/completions`.

### 1.2 The measured numbers, and their own caveat

| | Unee 0.8B | Unee 2B | Jev 1.13 (hosted) | Laya (421M) |
|---|---|---|---|---|
| Parameters | 0.75B | 1.9B | not published | 421M |
| **DecideBench v1.1** | **84.0 %** | **88.0 %** | **98.0 %** | 59.8 % |
| Pair accuracy | 70.0 % | 76.5 % | 96.0 % | — |
| **ECE** | **0.025** | **0.026** | — | — |
| **Right when ≥ 90 % sure** | **96.3 %**, on **40 %** of decisions | **97.2 %**, on **62 %** of decisions | — | — |
| One decision, laptop GPU (p50) | 96 ms | 111 ms | 639 ms (API) | 97 ms (L4) |
| Cost per 1M decisions | **$0** in the browser; ~$19 rented GPU | ~$23 rented GPU | $32.26 | $5.45 |

**The single most important number in the whole document** is the
"right when it says it is sure" row: the 0.8B is **96.3 % correct on the
40 % of decisions where it is ≥ 90 % confident**, and the 2B is **97.2 %
correct on 62 %**. The rest is where it should abstain.

> **This is a *quantified* abstention band, and it is the empirical basis
> our grounding policy has been missing.** A tier system that says "`UNCITED`
> may proceed with a warning" is not yet a routing rule. This is:
> *route the band the small model can carry; escalate the rest.* It also
> tells us the honest expected accuracy of a local-model tier: **96.3 %**,
> not 84 %.

### 1.3 The three techniques that make a 0.8B model competitive

| Technique | What it is | Measured gain | Cost at runtime |
|---|---|---|---|
| **Date facts** | A **tiny deterministic preprocessor** adds day differences between any dates in the input — *"2026-06-05 is 35 days after 2026-05-01"* — before the model runs. Because single-pass models are bad at calendar arithmetic | **~3 points** | **Zero tokens.** Pure string work |
| **Model soups** | The weights of several fine-tuned runs are averaged | **1–3 points** | **Zero.** It is an offline artefact |
| **A compact prompt** | ~half the tokens of the usual few-shot chat format | — | **~2× faster on CPU** |

**All three are ours already, or cheaper than ours.**

- **Date facts is the "deterministic pre-processing before the model"
  pattern**, and it is exactly what our sixteen local tools are for. The
  lesson is precise: *the tool computes; the model reads the result.* Our
  `calc.expr`, `tz.*`, `holiday.calendar`, `currency.round` and `tax.compute`
  are all date/arithmetic facts preprocessors. The rule for the SDK becomes
  mechanical: **if a tool can compute it exactly, the model is never asked
  to.**
- **Model soups is an offline, artefact-producing, zero-runtime-cost
  optimisation** — and therefore **safe under the safe-adaptation
  envelope**. It belongs in the CI-time optimiser, not the hot path.
- **The compact prompt is compression without a verifier** — and without a
  verifier it is the thing the Replay Gap warns about. Our compression is
  gated; theirs is not. That difference is the whole point of D-044.

### 1.4 Strict mode — the commit-point protocol, independently rediscovered

This is the most important extraction in the document.

**The mechanism:**
1. Unee writes the **whole** answer.
2. Its **decision side** sorts each sentence: a **fact**, an **"I don't
   know"**, or **neither** (a greeting, a question, an offer to help).
3. Each **fact** must pass **two checks**:
   - **a character-for-character check** — numbers of three or more digits,
     clock times, email addresses and links must appear in the documents or
     in the user's own messages;
   - **a claim check** — the decision side verifies the sentence as a claim
     against the documents.
4. Sentences that fail are **removed**, and a short note says the rest could
   not be confirmed.
5. If **no fact is left**, the reply is only that note.

> **"The answer arrives whole, not word by word, because it is checked
> first."**

**That is our commit-point protocol.** `PREPARED` → emit → `EMITTED`, with
the answer fully computed and verified *before* any byte reaches the host.
A small project, writing a chat bot, arrived at the same architecture that
`trust.md` §5.2 derives from the atomicity problem. **Independent
convergence.**

**The measured effect, honestly:**

| | 0.8B no check | 0.8B strict | 2B no check | 2B strict |
|---|---|---|---|---|
| Replies with a made-up fact | 14.7 % (17) | **11.2 %** (13) | 10.3 % (12) | **6.0 %** (7) |
| Good replies | 44.0 % | 41.4 % | 50.0 % | 46.6 % |
| Answer in the documents | 39.8 % | 36.4 % | 46.6 % | 40.9 % |
| Correct "I don't know" | 57.1 % | 57.1 % | 60.7 % | **64.3 %** |

**Cost:** two decisions per sentence. On a laptop GPU, +0.19 s to +0.31 s
for a one-sentence answer. On a CPU in Node, **+1.1 s** for one sentence and
**+2.0 s** for three.

**The threshold is a dial, and both ends are bad:**
- at **0.3**, the 2B drops to 7.8 % made-up facts with **no loss** of good
  replies (0.8B: 12.1 %, one good reply lost);
- at **0.9**, made-up facts fall to 4.3 % (2B) / 3.4 % (0.8B) — but **the
  0.8B then removes most of its correct answers too (20.7 % good replies)**.

> **"It lowers the risk; it is not a guarantee."** And the checker is the
> same small model. **The verifier is not independent of the verified.**

**That last clause is the finding that decides our architecture.** Unee's
strict mode uses the *same* model to check the answer. Our kernel's
verification engine uses an **external, deterministic verifier** — a
different identity, a different mechanism. That is the difference between
"the model checked itself" and "the claim was verified". The trust design's
rule — the verifier is **not** the producer's own lineage — is exactly what
Unee cannot do at this scale, and it is why their ceiling is ~6 % made-up
facts while ours can be a hard zero for a `VERIFIED` claim.

### 1.5 BM25 instead of a vector database

> *"Unee splits them into passages and finds the most relevant ones for each
> turn with built-in **BM25**, so there's no vector database."*

**This directly challenges our plan.** `roadmap.md` module 5.8 and module 9.7
propose `sqlite-vec` — a vector index — for semantic search.

| | BM25 (Unee's choice) | `sqlite-vec` (our plan) |
|---|---|---|
| Model download | **None** | EmbeddingGemma 2 — **168–1.15 GB** depending on precision |
| Determinism | **Perfect** — a scoring function | Depends on the model and the quantisation |
| Explainability | The matching terms are visible | A cosine similarity is not |
| Known defect risk | None | `transformers.js` **#1728**: quantised WebGPU embeddings are **silently orthogonal** |
| Semantic recall | Weak on paraphrase | Strong |
| Cost | Zero | A 300 MB–1 GB download, or a local model |

**The decision is not "one or the other" — it is "lexical first, semantic
when the lexical answer is insufficient", and the escalation must be
measurable.** A two-stage retrieval where stage 1 is BM25 over the *same*
SQLite database (FTS5, no new dependency, no download) and stage 2 is the
vector index **only when stage 1's score is below a threshold** gets the
best of both: zero download for the common case, semantic recall for the
hard case.

**And the fallback is the same shape as everything else here: a local
`sqlite-vec` index is *off* until the lexical stage has been *measured* to
be insufficient.** That is the break-even discipline applied to retrieval.

### 1.6 It reads our own OKF bundle

> *"If your knowledge is an Open Knowledge Format bundle (a folder of
> Markdown files with a small YAML header each), Unee reads it directly."*
> *"Written against OKF v0.2; it organises the knowledge you give Unee, it
> does not change how accurate the answers are."*

**This repository already ships an OKF v0.2 bundle** — `knowledge/`, with
`index.md`, `log.md`, per-concept files with front-matter, and
`status: deprecated` handling. Unee's loader skips `index.md` and `log.md`,
excludes `status: deprecated` concepts (unless `include_deprecated=True`),
and **never rejects a bundle** on unknown keys or types.

**Two concrete consequences:**
1. **The OKF format is already a decision-model interchange format.** A
   bundle built for humans and agents is directly loadable by a local
   decision model. That is a real property of the format this repository
   already owns, and it is worth stating.
2. **"It organises the knowledge you give Unee, it does not change how
   accurate the answers are"** is the correct kind of claim about a format:
   a container does not confer accuracy. The same is true of OKF — and of
   our evidence tiers. **Organisation is not verification.**

### 1.7 The negative cases — every one of them, verbatim

| Limitation | The consequence for us |
|---|---|
| *"One forward pass, no step-by-step reasoning. Multi-step rules and arithmetic (other than date differences) are weaker."* | A single-pass local model **cannot** be the verification engine. It can be the **decider** in a tier. Our `PASS`/`FAIL`/`BLOCKED` verifier must stay deterministic |
| *"English is strongest."* | Measured: 2B scores **86.7 %** English, **69.7 %** across 51 languages, **77.2 %** across the 12 priority languages (Arabic, Hindi, Spanish, Chinese, French, Portuguese, Bengali, Russian, Urdu, Indonesian, German, Japanese). 0.8B: **91.7 / 63.3 / 74.4**. The base model before Unee's training: **43.3 / 28.5 / 35.8**. **"With 60 requests per language a single language moves about ±6 points by chance."** → **The region bundles are not optional, and the language gap is measured, not guessed.** The priority-language list is almost exactly our region set: India (Hindi, Bengali), Gulf (Arabic), China (Chinese), Singapore/Indonesia (Indonesian) |
| *"Open-ended chat is not its strength."* A blind Qwen3.5-9B judge preferred the **base** model's answers — Unee won only **35 %** of comparisons (0.8B) and **21 %** (2B) | A small local model must not be the *author*. It may classify, route, and abstain. |
| *"Answers from documents are not yet reliable enough to run unsupervised: about half are judged fully correct… Without strict mode 10–15 % of replies contain a made-up fact; with it, 6–11 %. **Keep a person in the loop.**"* | The local tier's document-grounded path is **assisted, not autonomous**. Our grounding policy's "human review or fallback" branch is the correct default, not a reluctant concession |
| *"**The streamed reason is the model's explanation, not proof of how it decided.**"* | **A rationale is not evidence.** A model's explanation of its own claim is `REPORTED`, never `AUTHORITATIVE`. This is the single most important line in the README for our evidence model, and it independently confirms D-006's derivation |
| *"Not for high-stakes decisions (medical, legal, credit, employment) without a person checking."* | The **never-automated list** and the human approval gate are not conservatism; they are the vendor's own published limit |
| General benchmarks: MMLU 49.3/58.1, TruthfulQA mc1 **32.4/29.9**, GSM8K 29.7/49.0 | **TruthfulQA is the weak axis.** A decision model that is good at classification and bad at truthfulness is exactly the shape of tool that must never be a *source* of claims |
| *"Read it honestly: JEV is more accurate, and smaller self-hosted models cost less per decision and score lower."* | The honest framing of every local-model claim: **it is a trade, not a win** |

### 1.8 The methodological patterns — the best part of the README

| Pattern | What they did | Why it matters to us |
|---|---|---|
| **The model-selection rule was fixed before any result** | *"the best mean of three held-out validation sets (English, translated, and S1MB-style from public validation splits), among the previous release, the new run and their 50/50 weight average. **No benchmark took part.**"* | **Pre-registration.** Our twelve promotion gates are evaluated *after* the fact; this is the discipline that stops that from being circular — fix the rule, then measure |
| **A contamination check as a shipped tool** | `tools/contamination_check.py` compares every evaluation set with all training text (exact and 13-word overlap); the results are published | The **"has this benchmark been seen?" gate**. SWE-bench's 59.4 % material-defect rate is what happens without one |
| **The clean re-score** | Leaving out every S1MB benchmark with any overlap (101 remain), the clean Task Avg is **45.69** (2B) and **36.74** (0.8B) — *"the gain is not from overlap"* | Re-measure on the clean subset rather than arguing about the overlap. This is what our golden corpus needs: a **contamination-scored** corpus, not an assumed-clean one |
| **Run-to-run noise, published** | *"The same models scored 44.0 % and 38.8 % (0.8B), 50.0 % and 48.3 % (2B). That spread is the run-to-run noise of a 116-question test, so read differences of a few points with care."* | **Our metrics must publish their run-to-run spread.** A gate that fires on a 1-point difference is noise, and `optimization.md`'s ±1.0 pp hysteresis band is the same discipline applied to policy promotion |
| **Standard errors on every benchmark** | "about 0.4 points on MMLU, 0.5 on HellaSwag, 1.5 on ARC, 1.6 on TruthfulQA, 1.4 on GSM8K and 2.1 on IFEval per prompt" | Report CIs. We already require it for the bootstrap gates |
| **Raw outputs are in the repo** | *"Every run's raw output is in `bench/results/`"* | The event-log discipline applied to benchmarks. Our golden-align corpus is the equivalent: the artefact, not the summary |
| **The project's own rules, stated** | *"DecideBench data is never used for training. The checkout is git-ignored. Teachers are open-weight models whose licenses allow distillation. **Results are reported as measured, including the ones that didn't work.**"* | *"including the ones that didn't work"* is the sentence to copy into our promotion records |
| **The decision API is a compatibility surface** | Jev-compatible `/v1/systemone` + OpenAI-compatible `/v1/chat/completions` | A local decision model that speaks two protocols is **pluggable** — the same rule that produced our `AgentRuntime` interface |

### 1.9 The status of Unee for us

| Verdict | Reason |
|---|---|
| `REFERENCED` | Apache-2.0 and genuinely well-documented, but **single-author, v0.3, self-benchmarked**. The README itself says *"Not for high-stakes decisions… without a person checking"* and *"not yet reliable enough to run unsupervised"* |
| **Not a dependency** | The `decide`/`noul`/`choice`/`score` interface is the valuable artefact. Implement it behind our own `IntentScorer` interface with a **deterministic baseline** (rules + BM25 + the tool layer), and treat Unee as a **pluggable backend** |
| **Adopt the interface shape** | `noul` / `choice` / `score` with a **probability per option** and an **ECE target** is a better contract than "the model classified it". Our `IntentScorer` interface should be `score(options[]) → { option, p, calibratedBy }` — and the **calibration must be measured on our own corpus**, not inherited |

---

## 2. The density principle — "as much as possible, within as little as possible"

The request asks for a *"quantum highly saturated, high density workflow
within least resources as much as possible"*. Read literally that is a
demand for **maximum throughput per unit of resource**. Read carefully, it
is a demand for **density**: *how much verified work does one unit of
resource buy?*

**Throughput is not density.** A system that processes 10,000 tokens/second
and verifies none of them has zero density. Density requires the
verification to be in the denominator.

> **Density = verified work per unit of resource.**

Three resource axes, three verified-work measures:

| Axis | Resource | Verified work | The measure |
|---|---|---|---|
| **Latency** | Wall-clock seconds | Tasks reaching a **verified** terminal state | `verified tasks / second` |
| **Tokens** | Input + output tokens | Tokens that produced a **verified** claim | `verified claims / 1k tokens` |
| **Money** | USD | Decisions that reached a `VERIFIED` tier | `verified decisions / $` |

**And the composite — the one number the whole system is optimised for:**

```
DENSITY = (verified tasks × evidence tier weight) / (tokens + wall-clock + cost)
```

The **tier weight** is what stops it from being gamed: a `VERIFIED` claim
counts more than an `UNCITED` one, and a `BROKEN` one counts **negative**.
That is `optimization.md`'s S1 counter-measure applied to the headline
metric instead of only to a side signal.

### 2.1 The four density levers, and where each one is measurable

| Lever | The move | The measurement | The MVP |
|---|---|---|---|
| **L1 — Do not compute** | The deterministic path answers it. A cache hit, an exact-match rule, a date-facts preprocessor, a BM25 lookup | `Tier 0` share — the fraction of tasks never reaching a model | 1, 4, 5 |
| **L2 — Compute less** | Compression, a focused projection, a compact prompt, the smallest model that can carry the band | Tokens per verified task, and the compression quality gate | 4 |
| **L3 — Compute less often** | The cache, the batch API, the sleep-time pre-computation | Measured hit rate against the derived break-even | 4, 9 |
| **L4 — Compute only what is verified** | The abstention band: route the band the small model can carry, escalate the rest | `verified decisions / $`, and the escalated fraction | 3, 5 |

**L1 is the biggest and the cheapest.** It is also the one every "AI-first"
roadmap skips, because it is not AI: it is *knowing what not to ask a
model*. The Unee date-facts preprocessor is worth ~3 points at **zero token
cost** — and the same idea applied to our sixteen local tools is worth
**far more than 3 points**, because it removes the call entirely.

### 2.2 The density metric, and the anti-gaming rules

The composite metric is gameable in three ways, and each has a rule:

| Gaming mode | Rule |
|---|---|
| Count easy tasks | Density is reported **per task class**, and the composite is a **weighted** aggregate by class, not a flat mean |
| Count trivial verifications | A `VERIFIED` claim requires an **admissible** evidence record — the kernel's rule, not ours. A claim with no citation counts as `UNCITED` and therefore at low weight |
| Slow down to raise the ratio | **Wall-clock is in the denominator**, and the run-to-run spread is published — a system that idles to raise its density is visible in the latency axis |
| Cache the easy answers forever | The cache is keyed on the **assembled request digest** — including the policy and model version — so a policy or model change **cannot produce a stale hit through that path**. (A hit served by some *other* path is a different bug, and the drift check is what catches it) |

### 2.3 The honest limit

**Density is not quality.** A system that verifies one trivial claim per
million tokens has a terrible density *and* a terrible quality; the
composite metric is only meaningful next to `TSR` and `VP`. The rule is
that **density is reported beside `VP` and `TSR`, never instead of them** —
the same pattern as `optimization.md`'s "no single aggregate decides".

---

## 3. The planned-but-not-implemented ledger

**Everything this repository has planned and not yet built.** Each entry
names the source, the current status, and the MVP that would implement it.
This is the file to consult before starting any of them.

### 3.1 From this repository's own roadmap and backlog

| Learning | Source | Status | Where it lands |
|---|---|---|---|
| **The graph traversal engine** — reachability, topological order, cycle detection, invalidation cascade, the re-orient trigger | `ROADMAP.md` M5; `docs/BACKLOG.md` P1-13 | `DEFERRED` — the contracts exist, the engine does not | **MVP 2** |
| **`fallbackLegal` must consider `IN_FLIGHT` effects** | `docs/BACKLOG.md` P1-10; D-013 | `DEFERRED` — a live defect, named with the exact edit | Before the SDK's delegation layer ships |
| **The candidate-lifecycle event kinds** (`CANDIDATE_CAPTURED`, `CANDIDATE_STAGE_CHANGED`, `SHADOW_EVAL_COMPLETED`, `POLICY_PROMOTED`, `POLICY_ROLLED_BACK`, `POLICY_PINNED`, `BUDGET_EXHAUSTED`) | `docs/BACKLOG.md` P1-11; D-037 | `DEFERRED` — a versioned migration, not a sidecar log | Before **MVP 7** |
| **The failure-policy ladder** (`OBSERVE`/`WARN`/`REQUIRE`/`BLOCK`) reconciling `AGENTS.md`, `CLAUDE.md` and `CORE-INVARIANTS-V2.md` §1.3.3 | `ROADMAP.md` M7a | `DEFERRED` — M7a exists only to say which reading is implemented | Before **MVP 3** — the grounding policy needs it |
| **`ContainerBackend`, `VMBackend`, `RemoteBackend`** — the `ExecutionBackend` shape beyond `LocalProcessBackend` | `ROADMAP.md` M9; `docs/WORKER-RUNTIME-KERNEL.md` §10 | `DEFERRED` — shapes only, no implementation | **MVP 3** (server tier) |
| **The falsification experiment** — a real bounded task driven end-to-end, then deliberately broken and recovered | `ROADMAP.md` M12 | `DEFERRED` | **MVP 8** — S-05, S-13, S-16 |
| **The certificate golden + mutation tests** — tampering with *any* referenced artefact must fail verification | `ROADMAP.md` M10 | `DEFERRED` | **MVP 8** |
| **`ROADMAP.md` as a live status board** | `docs/BACKLOG.md` P2-23 | `DEFERRED` — corrected, not rewritten | Repo hygiene |
| **The platform patterns, mapped to modules** | `docs/BACKLOG.md` P2-24 | `DEFERRED` — documented, not scheduled | `docs/agent-sdk/platform-engineering.md` |
| **The Brazil and US-health region bundles** | `docs/BACKLOG.md` P2-25 | `DEFERRED` — `UNKNOWN` regulatory claims | **MVP 5** |
| **Re-verifying the volatile prices** | `docs/BACKLOG.md` P2-21 | `DEFERRED` — a manual step today | Continuous |

### 3.2 From the SDK specification

| Learning | Source | Status | Where it lands |
|---|---|---|---|
| **The whole SDK** — three modes, the developer surface, the six guarantees, the four phases | `docs/agent-sdk/README.md` §2, §4 | `DEFERRED` | The nine MVPs |
| **The truth-anchor schemas** — `AnchorRecord`, `AttestationEnvelope`, `CommitPointRecord`, `EffectRecord`, `KeyRecord`, and the eleven-step fail-closed verification algorithm | `docs/agent-sdk/trust.md` §7 | `DEFERRED` | **MVP 3** |
| **The per-mode signature schemes** — LOCAL (attest helper / unix-socket attestor), SELF-HOSTED (per-tenant keys, tenant-co-signed heads), HOSTED (two-key, `SERVICE_SIGNS_FOR_TENANT` downgraded) | `docs/agent-sdk/trust.md` §3.3 | `DEFERRED` | **MVP 5** (multi-tenant) |
| **The revocation overlay** — three-valued, append-only, retroactive distrust never a deletion | `docs/agent-sdk/trust.md` §3.6 | `DEFERRED` | **MVP 3** |
| **The commit-point protocol** — `PREPARED` → emit → `EMITTED`, and the `IN_FLIGHT` → `INDETERMINATE` reconciliation table | `docs/agent-sdk/trust.md` §5 | `DEFERRED` | **MVP 3** — and it now has an independent confirmation (Unee's strict mode, §1.4 above) |
| **The grounding policy** — the tier → permitted-action map, evaluated by rules and never by a model | `docs/agent-sdk/trust.md` §2.1 | `DEFERRED` | **MVP 3** |
| **The learning loop** — the two axes, the binding rule, the eight forbidden jumps, the safe-adaptation envelope | `docs/agent-sdk/optimization.md` §2, §7 | `DEFERRED` | **MVP 7, MVP 9** |
| **The nine top signals** with their gaming modes and counter-measures | `docs/agent-sdk/optimization.md` §7 | `DEFERRED` | **MVP 6, MVP 7** |
| **The content-addressed cache, the semantic cache with calibrated out-of-domain rejection, and the compression quality gate** | `docs/agent-sdk/README.md` §4 (M3) | `DEFERRED` | **MVP 4** — and the **lexical-first** correction from §1.5 above applies to the semantic cache |

### 3.3 The methods and disciplines

| Learning | Source | Status | Where it lands |
|---|---|---|---|
| **The pre-registered selection rule** — fix the rule before any result | Unee §1.8 | `ADOPTED` | **MVP 7** — the gate thresholds are fixed before the shadow window opens |
| **The contamination check as a shipped tool** | Unee §1.8 | `ADOPTED` | **MVP 8** — the golden corpus is contamination-scored, and a contaminated corpus is re-scored clean |
| **Publish the run-to-run spread** | Unee §1.8; Chroma's context rot | `ADOPTED` | **MVP 6** — every metric carries its spread |
| **Report the results that did not work** | Unee's own project rule | `ADOPTED` | **MVP 7** — the promotion record includes the rejected candidates |
| **Deterministic pre-processing before the model** | Unee's date-facts (+3 points, zero tokens) | `ADOPTED` | **MVP 5** — the rule: *if a tool can compute it exactly, the model is never asked to* |
| **Model soups** — average the weights of several fine-tuned runs | Unee (1–3 points, zero runtime cost) | `ADOPTED` | **MVP 9** — an offline, artefact-producing optimisation, safe under the envelope |
| **The abstention band** — route what the small model can carry, escalate the rest | Unee (96.3 % on 40 %; 97.2 % on 62 %) | `ADOPTED` | **MVP 5** — the grounding policy's routing rule, now with numbers |
| **Lexical-first retrieval** | Unee's built-in BM25, no vector DB | `ADOPTED` | **MVP 5** — FTS5 first, `sqlite-vec` only when measured insufficient |
| **A rationale is not evidence** | Unee's own limitation note | `ADOPTED` | Confirms D-006 — a model's explanation of its own claim is `REPORTED` |

---

## 4. The negative-case catalogue

**One table of everything that does not work, from every source.** This is
the part a plan usually omits, and it is the part that prevents the
roadmap from repeating a published failure.

| Failure | Where it came from | The control |
|---|---|---|
| **A model checking its own output is not verification** | Unee strict mode: *"the checker is the same small model"* | The kernel's verifier is an **external deterministic** engine, outside the producer's lineage |
| **A rationale presented as proof** | Unee: *"the streamed reason is the model's explanation, not proof of how it decided"* | A model's explanation is `REPORTED`, never `AUTHORITATIVE` |
| **A local model that is good at classification and bad at truthfulness** | Unee: TruthfulQA mc1 **29.9–32.4 %** | A local model may route and abstain. It may never be a *source* of claims |
| **A single-pass model cannot reason stepwise** | Unee | The deterministic path and the tool layer do the reasoning; the model classifies |
| **Over-refusal from a strict threshold** | Unee at threshold 0.9: the 0.8B drops to **20.7 %** good replies | The threshold is a **measured dial** with both ends published, not a constant |
| **The local tier cannot be autonomous on documents** | Unee: *"not yet reliable enough to run unsupervised"* | The grounding policy's human-review branch is the **default**, not a concession |
| **Naive log-stitching replay scores the wrong world** | arXiv 2608.08239 | Replay re-executes the **decision function**, never the model; policy changes use **branched rollouts with control forks** |
| **Temperature 0 is not determinism** | arXiv 2608.08239: FP8-served models diverge on **90–96 %** of control forks | A model call is a `COMMITTED` fact read from the log, never re-asked |
| **A test-suite pass is not a correctness oracle** | SWE-bench: **59.4 %** materially defective, **+6.2 pp** inflation | The oracle hierarchy; O1–O7 before O8; never a model self-report |
| **A judge model is barely better than chance on hard pairs** | JudgeBench: GPT-4o *"just slightly better than random guessing"* | Judges are calibrated (κ ≥ 0.8) and are **secondary** evidence |
| **A simulated user is not a user** | arXiv 2601.17087: **9 pp** swing, dialect-dependent | Simulated users generate **hypotheses**; real longitudinal data validates |
| **A simulator is itself a policy** | arXiv 2605.11519: look-ahead bias, *controllability collapse* | The oracle is the **external verifier**, never a simulator |
| **A monitor LLM catches about half** | METR SHUSHCAST: **52 %** hidden / **80 %** visible | The monitor reads a **projected graph**, and is one control among several |
| **Long context breaks the monitor as well as the agent** | METR: 23 % of GPT-3.5-Turbo monitor runs overflowed | The projection is the monitor's input (S-27) |
| **More context is a regression, not a feature** | Chroma: focused ~300 tokens beat full ~113k across **every** family; coherent haystacks perform **worse** than shuffled | The context window is a **budget**; S-09 and S-28 are regression tests |
| **Multi-agent on sequential reasoning loses 39–70 %** | arXiv 2512.08296 | The D9 delegation gate refuses it |
| **Multi-agent above a ~45 % single-agent baseline loses money** | arXiv 2512.08296 (β = −0.404) | The D9 gate refuses it |
| **Multi-agent costs ~15× a chat interaction** | Anthropic | The overhead is **priced in the budget**, not assumed away |
| **Self-modifying code's measured property is its sandbox bypass** | STOP (COLM'24) | The never-automated list forbids it |
| **A framework's checkpoint is a snapshot, not an event log** | LangGraph, DBOS, Temporal | The kernel's log stays authoritative (D-040) |
| **No durable-execution engine runs in a browser or an edge worker** | Temporal, Restate, DBOS, Hatchet, Trigger.dev | The kernel's log is the substrate; the engines are server-tier adapters only |
| **A capability sandbox needs restricted-privilege interpretation** | gVisor and Firecracker are server-only; WASI works in a browser | Model-generated code runs as a **WASI component** with per-capability grants |
| **`--allow-run` and `--allow-ffi` are documented holes** | Deno's own docs | Never the sole boundary; layered with WASI/gVisor |
| **A permissive licence is not the only licence risk** | BentoPDF AGPL, `summarize-lib` unlicensed, `archestra` AGPL+Enterprise, Chunker unlicensed | The licence allowlist, enforced in CI against the **resolved licence file** (D-045) |
| **Silently wrong embeddings are worse than no embeddings** | `transformers.js` #1728, still open | fp32/fp16 on WebGPU; a startup cosine-sanity assertion; a CI regression test |
| **A cold model cannot be trusted with the answer** | Chroma's context rot; METR's time horizon | The focused projection; the abstention band |
| **A benchmark the model has seen measures nothing** | Unee's contamination check; SWE-bench | The contamination gate; a clean re-score |
| **A reported confidence is not a calibrated confidence** | Cacioli: accuracy rank and metacognitive-sensitivity rank are **inverted** | The verifier's behavioural signal, never the model's self-report |
| **The vendor's own arithmetic does not always reproduce** | The gateway audit: 58.0 vs 68, 93.5 vs 92, 31.0 vs 40 | Recompute every figure before publishing it |
| **A vendor's claim of "no known vulnerabilities" is not a PASS** | The kernel's `BLOCKED` rule | Absence of evidence is `UNKNOWN` |

---

## 4A. Corrections to the repo-mapping table

A mapping table of SDK modules to OSS repos was verified entry-by-entry
against primary sources. **21 of its rows needed correction**, and the pattern
of the errors is the lesson: **every error overstates capability, and every
one of them errs in the direction of "we can depend on this".**

| Row | As written | The correction |
|---|---|---|
| M0 · `OneAI` | capability probing, runtime detection, cross-platform abstraction | **No OneAI does any of the three.** The likely target (`oneai-nlp/oneai-node`) is a hosted NLP API client, last npm publish **2023-07-25**. **CONTRADICTED** |
| M0 · `ionclaw` | capability probing | Its `model_capabilities.json` describes **LLM providers** (context windows, cost/token), not the host. "Runtime detection" is **compile-time** (`#if defined(__APPLE__)`). **PARTLY VERIFIED** |
| M1 · `liteparse` | WASM-first, client-side zero-compute, 91+ formats | Canonical repo is **`run-llama/liteparse`**; "91+ formats" is **Kreuzberg's** number; liteparse handles ~20 and its **Office path requires LibreOffice**, so client-side zero-compute **fails for Office**. **PARTLY VERIFIED** |
| M1 · `bentopdf` | client-side zero-compute | Mapping ✅, but **AGPL-3.0** — and it *pre-configures CDN URLs* for AGPL PyMuPDF/Ghostscript/CPDF, so a hosted deployment still triggers AGPL §13. **Licence FAILS** |
| M1 · `@kreuzberg/wasm` | (recorded as ELv2) | **MIT**, in five independent primary places. The repository was **renamed** to `xberg-io/xberg`. **CORRECTED** |
| M2 · `summarize-lib` | self-sufficient chunk hierarchy, progressive disclosure | It is a **SymbolicAI plug-in**, not standalone, not on PyPI, and **has no licence file** despite a README saying "the code is MIT". It returns **one merged summary**, not a navigable tree — that is `chunker`'s property. **PARTLY VERIFIED** |
| M3 · `WebGemma` | Google's on-device embeddings project | **`NSTiwari/WebGemma` is third-party** (31★, MIT), not Google. Google's are `google-deepmind/gemma` and `google-gemini/gemma-cookbook` (**archived**). **PARTLY VERIFIED** |
| M3 · `gemma-rag-webgpu` | a repo | **No GitHub repository exists** — only a Hugging Face Space with **no declared licence**. **CONTRADICTED** |
| M3 · `unee` → "local vector DB" | a local vector database | **Contradicted by its own README**: built-in **BM25**, *"so there's no vector database."* **PARTLY VERIFIED** |
| M4 · Anthropic, OpenAI | "explicit caching", "automatic prefix" | Both **understated**. Anthropic: automatic **+** explicit. OpenAI: implicit for earlier models, implicit **+** explicit for GPT-5.6+. **PARTLY VERIFIED** |
| M5 · `AgentScope` licence | "changed to non-commercial" | **Apache-2.0**, confirmed by the repo LICENSE, the README, and the PyPI SPDX. The doubt is **CONTRADICTED** |
| M5 · `dapr-agents` | workspace-driven state, checkpointed handoffs | The dapr-agents README has **zero** occurrences of "workspace", "checkpoint" or "handoff". Those belong to **AgentScope Java 2.0** (`AgentStateStore`, session recovery). **Attributes were swapped** |
| M6 · `Eino` | evidence-gated transitions | **Not an Eino feature.** Eino gives nodes, `AddBranch` conditional edges, `maxRunSteps` bounded loops, and `compose/{checkpoint,interrupt,resume,state}.go`. Evidence-gating is **our** policy. **PARTLY VERIFIED (3 of 4)** |
| M7 · `AgentTelemetry`, `agent-telemetry`, `agentic-telemetry` | three repos | **Two do not exist.** Exactly one: `Krishnachaitanyakc/AgentTelemetry`, Apache-2.0, branch `master`, PyPI `agenttelemetry` 0.1.0. "SQLite/JSONL options" is **contradicted** (it is OTLP-first with a `json_file` sink). **CONTRADICTED** |
| M7 · the arXiv id | `arXiv 2410.12784` | That id is **JudgeBench** (ICLR 2025), *not* AgentTelemetry. AgentTelemetry's artefact is the **ACM AIware 2026** paper, DOI `10.1145/3805760.3814931`, Zenodo `10.5281/zenodo.20129005`. **CORRECTED** |
| M8 | "(design pattern from PR #29)" in a *repos* column | PR #29 is **this repository's own PR**. A valid internal pattern, but it is not an OSS borrow and must not sit in a column headed "Repos named". **MISLABELLED** |
| M9 · `archestra`, `dapr-agents` | sandbox/isolation and retry/fallback | **Swapped.** archestra = sandbox ✅, delegation ✅, MCP gateway ✅, A2A ✅, K8s operator ✅ — but **AGPL-3.0 + Enterprise**. dapr-agents = retry/backoff/circuit-breaker ✅ — but **no sandbox, no sub-agent isolation**. **PARTLY VERIFIED** |
| Packaging · `agent-volumes-spec` | "standard distribution format" | Real and on-point (Apache-2.0), but **v0.1.0-rc.1, 0★**, *"No stable version has been released"*, and its second reference implementation **does not exist**. A **reference**, not a dependency. **VERIFIED with a maturity caveat** |
| Control plane · `k0rdent` | multi-cluster Kubernetes | Real (Apache-2.0, CNCF, **Mirantis-originated, not Kyverno**), but it is a **Kubernetes-cluster** control plane, not an agent control plane — a category error in that row. **PARTLY VERIFIED** |
| Business layer · `anyplugin` | manifest, adapters, journal, hooks | **All four VERIFIED** from the working tree; MIT confirmed. One caveat: the repository is **private** (0★) — an internal reference, never a dependency. **VERIFIED** |

### 4A.1 The one rule this correction round produces

> **A mapping table is a hypothesis about a codebase, and it must be verified
> the way any other claim is verified: against the primary source, with a
> date, and with the errors counted.**

Twenty-one corrections out of twenty-one rows is not a bad table — it is a
table that had not been checked. The value of the corrections is not that
they make the table right; it is that **the table was found to be wrong
before it was designed against.**

---

## 4B. The convergent designs from mining nineteen real repositories

Nineteen repositories were cloned into a **non-persistent scratch folder**
and mined for their invariants and failure-mode defences — four cycles:
clone in parallel, extract contracts and invariants in parallel, cross-read
for convergence, then propose the graph. Nothing was written into the
repository; no source code is reproduced here.

**Independent convergence is the strongest signal a pattern is right.** It is
the reason a pattern can be assumed rather than merely admired.

| # | The pattern | N | What the agreement licenses us to assume |
|---|---|---|---|
| 1 | **A resource limit is derived from the execution environment and named** — not hard-coded | 7 | The limit belongs to the environment that imposes it, and it is *named* |
| 2 | **When a capability is unavailable, refuse — or degrade to a *named default* and announce it. Never guess silently** | 10 | The cheap implementation is to guess; the mature one refuses or announces |
| 3 | **Completeness is a producer-owned declaration; consumers reject records without it. Absence is never evidence** | 5 | The difference between "the tool said there are none" and "the tool could not look" must be in the data |
| 4 | **Durable state is an append-only step/event log with one named write path, and a *failure* is recorded as durably as a success** | 5 | Recording the failure is what makes a side-effecting step exactly-once |
| 5 | **Make the non-deterministic physically unavailable, and fail loudly rather than diverge silently** | 4 | Temporal removes `WeakRef`; V8 removes raw pointers. *Remove the capability*, don't detect the divergence |
| 6 | **Identity and provenance travel on the artefact; ownership is distinct from validity, editability and readiness** | 6 | "Who produced this" and "is this valid" are different questions |
| 7 | **One declarative table maps failure identity → (cause, retry, grade); every consumer derives from it** | 4 | Four separate lists drift. One table, keyed by a stable string, with an explicit unknown default |
| 8 | **Refuse rather than repair; bind to the verified object rather than re-resolving a path later** | 4 | A tampered object may already hold attacker content — repairing it destroys the evidence |
| 9 | **Oversize output produces a named error plus a resumable cursor — never a silent truncation** | 3 | A truncated result is indistinguishable from a complete one |
| 10 | **Progressive disclosure as a first-class output shape, with whole-item token budgeting** | 3 | A summary must never be *partially* inserted |
| 11 | **Safety filters run at ingestion, before any structural inference the untrusted content could influence** | 4 | The **ordering** is the defence. A filter applied after structure inference has already been influenced |
| 12 | **A capability request returns `None`/exclusion, never a substituted value** | 3 | The consumer asks; the answer is "not here", with no silent substitution |

### 4B.1 The three traps that the mining found, and that we must not import

| Trap | Where | Why we refuse it |
|---|---|---|
| **A documented threshold that the code does not implement** | A mature parser documents "3 pt" for tiny text and implements **1.0 pt** | **Any threshold we adopt must be a single named constant the documentation reads from**, or a drift test. This is the highest-priority transfer — it is live, silent, and already present in a mature repo |
| **A fallback whose precision differs between runtimes** | A popular runtime defaults to fp32 in Node and **q8 in the browser** | The same model produces different embeddings in Node and in a browser. **Any local-inference artefact must record its device and dtype in its provenance** |
| **Silent state corruption from pruning** | A checkpoint library documents that a naive "keep latest" prune makes delta channels reconstruct as **empty, with no error raised** | Any pruning policy must be checked against reconstructibility, or pruning must be refused |

### 4B.2 The four *refuse-to-copy* verdicts, from licence and from safety

| Refused | Why |
|---|---|
| `chunker` — **no licence file** | All rights reserved. The **idea** (hierarchical tree, whole-item budgeting, atomic checkpoint with an identity check) is reimplemented from its README prose; no code, no data model, no text |
| A prompt-injection research artefact — **self-disclaiming** | Its own README: *"the implementation might not be fully secure… This is not a Google product."* Apache-2.0 permits reuse; the disclaimer means the **mechanism** is borrowed and the **implementation** is not |
| `systemd`'s C implementation — **LGPL-2.1+** | The **documentation** is freely usable and the concepts are unprotectable. We read the man pages; we did not read the source |
| A browser engine's sandbox implementation — **BSD-3-Clause but load-bearing** | The **architectural idea** (pointer-as-index, type-tag crash, a written attacker model) is borrowed; the implementation is not |

**And the safety refusals, independent of licence:** do not copy a
documented-but-unimplemented threshold; do not copy an unbounded loop
detector's default; do not copy an unserialisable-error path that silently
re-runs a side-effecting step; do not copy a policy table whose **unknown**
case **grades** a harness fault as a datapoint; do not copy a sandbox provider
that supplies **no isolation** without declaring it; do not copy a
device-dependent default precision without recording it.

---

## 5. Decision-making: taken, refused, deferred

| Decision | Verdict | One line of reason |
|---|---|---|
| Adopt the `score(options[]) → {option, p, calibratedBy}` interface | **ADOPTED** | A probability per option with a calibration target is a better contract than a bare label |
| Adopt the abstention-band routing | **ADOPTED** | It turns the grounding policy from a slogan into a number: 96.3 % on 40 % of decisions |
| Adopt deterministic pre-processing before the model | **ADOPTED** | ~3 points at zero token cost, and it removes the call entirely |
| Adopt model soups | **ADOPTED** | 1–3 points, zero runtime cost, offline — safe under the envelope |
| Adopt the pre-registered selection rule | **ADOPTED** | It is the only defence against a circular promotion gate |
| Adopt the contamination check | **ADOPTED** | SWE-bench's 59.4 % material-defect rate is what happens without one |
| Adopt BM25-first retrieval | **ADOPTED** | Zero download, perfect determinism, explainable — and `sqlite-vec` escalates only when measured insufficient |
| Adopt the OKF-bundle loader | **ADOPTED** | This repository already owns an OKF v0.2 bundle that a local decision model can read directly |
| Depend on Unee as a runtime | **REFUSED** | Single-author, v0.3, self-benchmarked, and its own README says "not yet reliable enough to run unsupervised" |
| Use Unee's strict mode as *our* verifier | **REFUSED** | The checker is the same small model — that is not verification, it is self-consistency |
| Use a local model as a claim *source* | **REFUSED** | TruthfulQA mc1 of 29.9–32.4 %; a model is `REPORTED` at best |
| Use a local model for open-ended chat | **REFUSED** | A blind judge preferred the base model's answers 65–79 % of the time |
| Use a local model without a human on documents | **REFUSED** | 6–11 % made-up facts even with strict mode |
| Depend on `chunker` | **REFUSED** | No licence file → all rights reserved |
| Depend on BentoPDF | **REFUSED** | AGPL-3.0 |
| Depend on the Kreuzberg repository | **ADOPTED — pending a licence re-read at the pinned version** | **Corrected 2026-10-20.** An earlier check recorded this as ELv2 from the README; the **primary file says MIT**, confirmed in five independent places (LICENSE, GitHub `spdx_id`, README badge, PyPI classifier, npm `license`). The lesson is not about Kreuzberg — it is that **a licence must be read from the file, at the pinned version, by CI**, never from a README |
| Depend on `summarize-lib` | **REFUSED** | **No licence file**, despite a README that says "the code is MIT". An MIT assertion in a README is not a licence grant |
| Depend on `archestra` | **REFUSED** | AGPL-3.0-only by default, plus `LicenseRef-Archestra-Enterprise` regions — and the licence *router* makes the failure subtle |
| Depend on `gemma-rag-webgpu` | **REFUSED** | **No GitHub repository exists.** It is a Hugging Face Space with no declared licence |
| Depend on `agent-telemetry` / `agentic-telemetry` | **REFUSED** | **Neither exists.** Not a PyPI package, not a GitHub repo. Recording a decision about a phantom name manufactures false confidence |
| Depend on LiteParse for Office in the browser | **REFUSED** | Its Office path requires LibreOffice — a native binary, not a browser path |
| Adopt AIIAI's scalar-confidence evidence shape | **REFUSED** | Strictly weaker than the kernel's authority × validity × rung |
| Adopt the gateway audit's scores | **REFUSED** | Its arithmetic does not reproduce, and its rules are never stated |
| Adopt a *simulated user* as a go/no-go oracle | **REFUSED** | 9 pp swing, dialect-dependent differential effectiveness |
| Depend on a durable-execution engine | **REFUSED** for the browser and edge tiers; **adopted** as a server-tier adapter | None of them can run without a long-lived authoritative process |
| Use `sqlite-vec` as the *first* retrieval stage | **REFUSED**; adopted as the **second** | A 168 MB–1.15 GB model download and a known silent-wrongness defect are the wrong default |

---

## 6. Related documents

| Document | Owns |
|---|---|
| `docs/agent-sdk/roadmap.md` | The MVP ladder these learnings land in |
| `docs/agent-sdk/substrate.md` | The seven-repo substrate and the licence allowlist |
| `docs/agent-sdk/tools.md` | The eighteen tools, the two tiers, the region bundles |
| `docs/agent-sdk/simulations.md` | The certification harness and the scenario catalogue |
| `docs/agent-sdk/gaps.md` | The coverage matrix and what remains open |
| `docs/agent-sdk/platform-engineering.md` | The patterns mined from Linux, Debian, Android, macOS and the clouds |
| `docs/EVIDENCE.md` | Every external claim, with a source URL and an access date |
| `docs/DECISIONS.md` | D-039 … D-049 — why each choice was made |
