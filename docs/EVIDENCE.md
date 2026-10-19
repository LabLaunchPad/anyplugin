# Evidence ledger — every external claim, with its source and its date

The repository's own rule is that a quantity is `MEASURED`, `DERIVED`,
`ESTIMATED`, `ATTESTED`, or `UNKNOWN`, and that an `UNKNOWN` quantity is
**absent from the record entirely, never present with a zero**
(`packages/worker-runtime/src/resource/telemetry.ts`).

This file applies that rule to **external facts** — provider prices, protocol
versions, framework releases, and prior art. Anything quoted elsewhere in the
repository that comes from outside the repository is listed here with a source
URL and an access date.

**Why the dates are non-negotiable.** Provider prices are volatile in a way
that code is not. Anthropic's cached-read multiplier is already per-model
excepted; OpenAI introduced a cache-write charge with GPT-5.6; Gemini withdrew
explicit caching for its newest models. A spec that pins exact multipliers
rots. So: **cite the URL and the access date, never a remembered number.**

**Access date for every row below: 2026-10-20.** Re-verify before publishing
anything that quotes a price. `docs/BACKLOG.md` records the standing
requirement.

---

## 1. Verification verdicts

| Verdict | Meaning |
|---|---|
| `VERIFIED` | Confirmed against a primary source |
| `PARTLY VERIFIED` | Confirmed in part; the qualifier states the gap |
| `CONTRADICTED` | The primary source says something materially different |
| `UNKNOWN` | Not establishable from a primary source; stays UNKNOWN |

---

## 2. Prompt caching

| # | Claim as it appears in the reviewed architecture | Verdict | What the primary source says | Source | Date |
|---|---|---|---|---|---|
| E1 | Anthropic: cached read ≈10% of base input; 5-min write 1.25×, 1-hour write 2× | `PARTLY VERIFIED` | Multipliers confirmed — 5-min write **1.25×**, 1-hour **2×**, cache read **0.1×** — but **per-model exceptions**: Opus 5.5 / Sonnet 5.5 read = **0.05×**; Fable 5.1 / Mythos 5.1 read = **0.025×**; all other models use 0.1×. Write charges apply to `cache_creation_input_tokens` and stack with the Batch discount | [prompt-caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) · [pricing](https://platform.claude.com/docs/en/about-claude/pricing) | 2026-10-20 |
| E2 | Break-even ≈21.74% hit rate for the 5-min TTL | `PARTLY VERIFIED` | **Not provider-published — a derivation**, exactly reproducible from the published multipliers under the assumption that *every miss incurs a fresh write*: `h = (W−1)/(W−R)`. 5-min → **21.74%**; 1-hour → **52.63%**; for 0.05×-read models 20.83% / 51.28%; for 0.025×-read models 20.41% / 50.63%. Anthropic's own framing is different: "pays off after one cache read (5-minute duration) or after two cache reads (1-hour duration)" | [pricing](https://platform.claude.com/docs/en/about-claude/pricing) | 2026-10-20 |
| E3 | OpenAI: automatic at ≥1,024-token prefix; cached ≈25–50% of base; **writes are free** | **`CONTRADICTED`** for current flagships | Minimum cacheable prefix is **1,024 visible input tokens for GPT-5.6+**; earlier models vary by request settings. Cached read is **0.1×** for `gpt-6-astra`, `gpt-6-sol`, `gpt-5.6`/`5.5`/`5.4`/`5.x`, and **0.05×** for `gpt-6.1-sol`; 0.25–0.5× describes **legacy** models only (gpt-4.1 0.25×, gpt-4o 0.5×). **Writes are NOT free for GPT-5.6+**: cache writes = **1.25×** uncached input. GPT-5.5 and earlier have no cache-write charge | [prompt-caching](https://developers.openai.com/api/docs/guides/prompt-caching) · [pricing](https://platform.openai.com/docs/pricing) | 2026-10-20 |
| E4 | Gemini: explicit cache with storage billing; ≈10% of base; storage billed per minute or per hour | `PARTLY VERIFIED` | Cached read is **0.1×** for large models. Storage is billed **per hour** — e.g. **$0.50 / 1M tokens per hour** (Gemini 3.8 Flash, through 2026-12-31; $1.00 from 2027-01-01), $4.50/1M/hour for 3.1 Pro — **not per minute**. **Implicit caching is on by default for all Gemini 2.5+** (min 4,096 tokens for 3.x/4.x, 2,048 for 2.5). **Explicit caching is NOT supported for Gemini 4 Argon and later, nor in the Interactions API** | [caching](https://ai.google.dev/gemini-api/docs/caching) · [pricing](https://ai.google.dev/gemini-api/docs/pricing) | 2026-10-20 |
| E5 | DeepSeek: automatic prefix match; 0.1× base, 0.032× off-peak | **`CONTRADICTED`** | Cache hit is **1–3.3%** of the miss price, not 10%: `deepseek-flash` hit ¥0.02 off-peak / ¥0.04 peak vs miss ¥1 / ¥2; `deepseek-v4-pro` hit ¥0.15 / ¥0.30 vs miss ¥4.5 / ¥9.0. Off-peak **does exist** but is exactly **50% of peak** (Beijing-time peak 09:00–12:00 and 14:00–18:00 weekdays) and applies to *all* prices, not only cache reads. No separate cache-write charge is published | [pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) | 2026-10-20 |
| E6 | Kimi: is there a 0.1× cached-input price? | `VERIFIED` | **Yes, for the K3 series**: `kimi-k3` — cache write 5-min ¥20 (1.0× base input), 1-hour ¥40 (2.0×), **cache-hit input ¥2 = 0.1×**, output ¥100. K2 series have no write fee: `kimi-k2.7-code` hit ¥1.30 vs ¥6.50 (0.2×); `kimi-k2.6` hit ¥1.10 vs ¥6.50 (0.169×). Cache is automatic, TTL 5min/1h; a hit renews the TTL with no re-write charge | [pricing](https://platform.moonshot.cn/docs/pricing/chat) | 2026-10-20 |
| E7 | Self-hosted vLLM/SGLang: "50–90% throughput gain" | `UNKNOWN` | No primary source publishes this figure. vLLM's APC doc claims only "much higher throughput and much lower latency" and warns APC reduces **prefill only, not decode**; SGLang's HiCache docs give **no percentage**. The nearest published number is the SGLang paper's "up to **6.4× higher throughput**" — a *whole-system* figure across workloads, not a prefix-cache-only figure, and not a latency figure | [vLLM APC](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching.html) · [SGLang HiCache](https://docs.sglang.ai/advanced_features/hicache_best_practices.html) · [arXiv 2312.07104](https://arxiv.org/abs/2312.07104) | 2026-10-20 |
| E8 | "30-turn session, 20k prefix, 90% hit, GLM-5.3 744B: $0.459 vs $1.58 (71% saving)" | `PARTLY VERIFIED` — the arithmetic does not hold | **GLM-5.3 is real**, 1M context, always-on reasoning; GLM-5 is **744B total / 40B active**. Prices (USD/MTok): **input $1.40, cached input $0.26 (0.186×), output $4.40**; implicit caching, no write multiplier published. Recompute (30 × 20k = 600k input tokens): uncached = 600k × $1.40/M = **$0.84**; at 90% hit = **$0.2244** → **73.3% saving (input only)**. Including output (5k/turn → 150k output): **$1.50 → $0.884 → 41% saving**. The published "$0.459 vs $1.58" ratio is only reproduced by importing a 1.25× write-on-miss multiplier that Z.AI does not publish, and by a ~$2.63/MTok input price | [GLM-5.3](https://docs.z.ai/guides/llm/glm-5.3.md) · [pricing](https://docs.z.ai/guides/overview/pricing.md) · [caching](https://docs.z.ai/guides/capabilities/cache.md) | 2026-10-20 |

**Standing correction.** E3, E5 and E8 are the three that change a decision.
The corrected provider table is in `docs/agent-sdk/economics.md` §1, and the
decision that it supersedes is D-027.

---

## 3. Batch APIs

| # | Claim | Verdict | What the primary source says | Source | Date |
|---|---|---|---|---|---|
| E9 | OpenAI Batch: 2,000 batches/hour; 50,000 requests or 200 MB; 24 hours; 50% off | `VERIFIED` | "up to **2,000 batches per hour**"; "a single batch may include up to **50,000 requests**, and a batch input file can be up to **200 MB**"; `completion_window` "can only be set to **24h**"; "**50% cost discount**". Caveat: the 50% is exact for input/output on the gpt-6/5.x families, but rounding appears on cached input (gpt-5.4 cached $0.25 → $0.13 batch) and several legacy models publish **no** batch cached-input rate | [batch](https://developers.openai.com/api/docs/guides/batch) | 2026-10-20 |
| E10 | Anthropic Batch: 100,000 requests or 256 MB; "24-hour SLA, often under 1 hour"; 50% discount | `PARTLY VERIFIED` | "A Message Batch is limited to either **100,000 Message requests or 256 MB**"; "most batches completing **within 1 hour**"; "**Batches expire if processing does not complete within 24 hours**", results accessible "when all messages have completed **or after 24 hours, whichever comes first**". So 24 h is an **expiry deadline, not an SLA**. The 50% is exact: "All usage is charged at 50% of the standard API prices". Results retained 29 days | [batch-processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing) | 2026-10-20 |
| E11 | Gemini Batch (Vertex): GCS-based input/output; 24 hours; 50% off | `PARTLY VERIFIED` | GCS/BigQuery input is the **Vertex / Gemini Enterprise Agent Platform** path. The **Gemini Developer API** batch is **File-API/JSONL based, not GCS** (inline <20 MB; input file max **2 GB**; results JSONL or inline; results kept 6 weeks; job **expires after 48 hours**). "50% of the standard cost" and "target turnaround time is **24 hours**… in majority of cases much quicker" are confirmed | [batch-api](https://ai.google.dev/gemini-api/docs/batch-api) · [Vertex batch](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/capabilities/batch-inference) | 2026-10-20 |
| E12 | Batch requests consume a **separate rate-limit pool** | `VERIFIED` | OpenAI: "Batch API rate limits are a new, separate pool… **will not consume tokens from your standard per-model rate limits**". Anthropic: "The Message Batches API has **its own set of rate limits** which are shared across all models" (RPM 1k/2k/4k; queued batch requests 200k/300k/500k). Gemini: "Batch API requests are subject to **their own rate limits, separate from the non-batch API calls**" (100 concurrent batch requests) | [OpenAI](https://developers.openai.com/api/docs/guides/batch) · [Anthropic](https://platform.claude.com/docs/en/api/rate-limits) · [Gemini](https://ai.google.dev/gemini-api/docs/rate-limits) | 2026-10-20 |

---

## 4. Framework and pattern versions

| # | Claim | Verdict | What the primary source says | Source | Date |
|---|---|---|---|---|---|
| E13 | LangGraph is "v1.x" | `VERIFIED` | Current release **1.2.16** (published 2026-10-16); **1.0.0 published 2025-10-17** — so v1 is ≈12 months old | [1.0.0 release](https://api.github.com/repos/langchain-ai/langgraph/releases/tags/1.0.0) | 2026-10-20 |
| E14 | OpenAI Agents SDK is v0.17.1 | **`CONTRADICTED`** | Current release is **v0.24.0** (published 2026-10-15). v0.17.1 is several minors behind. The project is still pre-1.0 (0.x) | [releases](https://api.github.com/repos/openai/openai-agents-python/releases) | 2026-10-20 |
| E15 | The "AIWorker" pattern with a "Soul" (capability descriptor) projecting to any engine | `UNKNOWN` - **not citable** | No primary source found. GitHub repo search for `AIWorker` returns 115 repos, all visibly unrelated; repo search for `AIWorker` + `Soul` returns **0 results**; the `aiworker` user has 1 public repo and 0 followers. No vendor doc, paper, or spec describing a "Soul" capability descriptor was found. **A bounded negative result — the search was GitHub-only, so a private blog or post could exist (U3)** | [repo search](https://api.github.com/search/repositories?q=AIWorker+in:name) | 2026-10-20 |
| E16 | Agent Client Protocol (ACP) exists; OpenCode ships `opencode acp` | `VERIFIED` | ACP is a real, versioned protocol (JSON-RPC over stdio for local agents). Releases: **schema v1.26.0** (2026-10-16), Rust crate v1.12.0, prerelease schema v2.0.0-alpha.9. OpenCode documents the command: "configure your editor to run the **`opencode acp`** command… communicates with your editor over JSON-RPC via stdio" (Zed, JetBrains, Avante.nvim, CodeCompanion.nvim) | [ACP releases](https://api.github.com/repos/agentclientprotocol/agent-client-protocol/releases) · [OpenCode ACP](https://opencode.ai/docs/acp/) | 2026-10-20 |

---

## 5. Grounding, evidence, and receipt conventions

| # | Claim | Verdict | What the primary source says | Source | Date |
|---|---|---|---|---|---|
| E17 | OTel GenAI semconv: required/optional attributes for `invoke_agent`; `error.type` cardinality; "do not synthesize `conversation.id`" | `PARTLY VERIFIED` (location) / `VERIFIED` (rules) | **The location has moved** — the opentelemetry.io GenAI pages are now stubs: "GenAI semantic conventions have moved to the OpenTelemetry GenAI semantic conventions repository… This page has moved and is **no longer maintained**." Canonical: **github.com/open-telemetry/semantic-conventions-genai**. Rules confirmed: `invoke_agent` client span — **Required**: `gen_ai.operation.name`, `gen_ai.provider.name`; **Conditionally Required**: `error.type` (iff the operation errored), `gen_ai.conversation.id`, `gen_ai.agent.id/name/description/version`, `gen_ai.output.type`; **Recommended**: `gen_ai.request.*`, `gen_ai.usage.*` (including `gen_ai.usage.cache_read.input_tokens` and `cache_write.input_tokens`); **Opt-In**: `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.definitions`. `error.type` "SHOULD match… **another low-cardinality error identifier**"; fallback `_OTHER`. `gen_ai.conversation.id`: "When no identifier for the conversation is available, instrumentations **SHOULD NOT** populate conversation id. For example, a new UUID, a trace identifier, or a hash of request content **SHOULD NOT** be used as a fallback value" | [gen-ai-agent-spans.md](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md) | 2026-10-20 |
| E18 | Is there a published standard for a four-tier evidence model, or for "truth anchors" with HMAC-SHA256 + supersession chains? | `UNKNOWN` — **no prior art found in the searched corpus** | No standard, spec, or RFC **was found in the corpus searched** — GitHub repository search, W3C PROV-O, in-toto, SLSA and OTel GenAI. **This is not an ISO/IETF/NIST catalogue sweep (U4), and it is not proof of absence.** Closest citable prior art: **W3C PROV-O** (Recommendation, 2013-04-30) — Entity/Activity/Agent, `prov:wasDerivedFrom`, `prov:wasRevisionOf`, `prov:alternateOf`, `prov:invalidated`/`invalidatedAtTime` — but no confidence tiers and no MAC-based anchoring; **in-toto** attestations and **SLSA** provenance (supply-chain *build*, not runtime claims); OTel GenAI (no evidence tiering) | [PROV-O](https://www.w3.org/TR/prov-o/) · [in-toto](https://in-toto.io/) · [SLSA](https://slsa.dev/spec/v1.2/) | 2026-10-20 |
| E19 | Which cryptographic-receipt patterns apply to a local agent runtime? | `VERIFIED` (with applicability caveats) | **Sigstore** signs software artifacts with ephemeral keys, identity from OIDC via Fulcio, events in the Rekor transparency log — designed for release artifacts, requires the public Sigstore service, **not** a local per-tool-call MAC. **in-toto** is a framework for supply-chain integrity — its *layout* and DSSE-style envelope are the closest reusable prior art. **SLSA** is currently **v1.2** (v1.1 retired) and its Build Track is explicitly *not* runtime tool invocations. **MCP authorization** applies to **HTTP transports only** — "Implementations using an STDIO transport **SHOULD NOT** follow this specification, and instead retrieve credentials from the environment"; authorization is optional; requires OAuth 2.1, RFC 9728, RFC 8414, RFC 8707, PKCE, audience binding, and forbids token passthrough. ⇒ For a local runtime spawning tools on the user's machine, MCP's OAuth model is largely **N/A**; a local chained-receipt scheme is covered by none of these specs, and in-toto's envelope is the nearest reusable shape | [Sigstore](https://docs.sigstore.dev/about/overview/) · [in-toto](https://in-toto.io/) · [SLSA](https://slsa.dev/spec/v1.2/) · [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | 2026-10-20 |

---

## 6. The UNKNOWN register

These are recorded as UNKNOWN on purpose. An UNKNOWN is not a gap to be
papered over — it is a gap that must not be filled by inference.

| # | Unknown | Why it stays UNKNOWN | What would resolve it |
|---|---|---|---|
| U1 | The exact provider-published break-even *hit rate* | No provider publishes one. Every number in E2 is a derivation with stated assumptions | Nothing — it is a derivation, and it should be labelled as one |
| U2 | The inputs behind the original "$1.58 vs $0.459" GLM example | No reading of GLM-5.3's published prices reproduces it. The reviewed text did not state its assumptions | The original author's working |
| U3 | The origin of the "AIWorker / Soul" pattern | Search was GitHub-only; a private post could exist. **A negative result, not proof of absence** | The original source, cited |
| U4 | Whether *any* standards body has a four-tier evidence standard | The sweep covered GitHub repo search plus W3C PROV-O, in-toto, SLSA and OTel. **Not** an ISO/IETF/NIST catalogue sweep | A standards-body search |
| U5 | Gemini explicit-cache TTL options on the Developer API | Not stated on the caching page; implicit caching has no user-set TTL there | Vertex context-cache TTL documentation |
| U6 | The exact per-breakpoint splitting of Anthropic's cache-write charge | Confirmed to apply to `cache_creation_input_tokens`; no provider statement quantifies per-breakpoint splitting beyond the 4-breakpoint / 20-block-lookback rules | A provider statement |
| U7 | Whether the reviewed architecture's "coordination cost" estimate for polylithic delivery is real | It was asserted, not measured. **This repository has no measurement** | A measurement — until then it stays an assertion, and is not quoted as a fact |

---

## 7. Claims that are ours, not the world's

Some things in the documentation are **our design**, and it matters that they
are not mistaken for prior art. The repository's convention for this is
`docs/ai-native/reusable-procedures.md`: "This file owns nothing else… Entries
here reference those; they never restate them."

| Design | Where it lives | Status |
|---|---|---|
| The four-tier evidence projection | `docs/agent-sdk/trust.md` §2; D-006 | **Ours so far** — no prior art found *in the searched corpus* (E18). This is not an ISO/IETF/NIST catalogue sweep (U4), so it is not a claim of absence. It is a projection over the kernel's existing `EvidenceSchema`, not a new ledger |
| The truth-anchor chain with per-tenant co-signed heads | `docs/agent-sdk/trust.md` §3.3 | **Ours so far** — no prior art found in the searched corpus (E18, U4). Closest prior art is in-toto's envelope layout (E19) |
| The "Worker/Soul" framing | `docs/agent-sdk/README.md` | **Ours** (E15: not citable). Stated as a design, not as a pattern being followed |
| The two-axis fail policy (capability closed, health open) | `packages/worker-runtime/src/telemetry/delegation.ts` | **Ours.** Treating the two axes independently is the pattern; the specific constants are our choice |
| The `backend_failed` class distinct from `unknown` | `docs/FAILURE-MODES.md` §2; D-031 | **Ours.** It exists because `unknown` must stay non-retryable, and "the backend ran and failed without saying why" is a genuinely different, still-fallback-able state |
| The nine top signals and the six anti-gaming rules | `docs/agent-sdk/optimization.md` §7 | **Ours.** The rules generalise established practice (denominator from outside the optimiser's control; coverage with every ratio); the specific set is our choice |

---

## 8. How this ledger stays true

| Claim type | How it is kept true |
|---|---|
| A price | Source URL + access date, re-verified before publication |
| A version | Source URL + access date; a version claim older than ~6 months is re-checked |
| A derivation | The formula and its assumptions, stated next to the number |
| A design of ours | Labelled as ours, with the prior-art search that found nothing |
| An unknown | Listed in §6 with what would resolve it |

**A row may not be added without a source URL and an access date.** A claim
without a source is an opinion, and opinions do not belong in an evidence
ledger.
