# Economics: prompt caching and batching

The cost of an agent workload is dominated by **input tokens**. Caching and
batching are the two levers on that, and both of them can *lose* money if
applied without measurement.

**Every number in this document is verified against a primary source and
carries an access date in `docs/EVIDENCE.md`.** Three of the figures in the
original architecture review were wrong, and the corrected table is below.

---

## 1. Prompt caching

### 1.1 What the providers actually charge — corrected

| Provider | Trigger | Cached read | Write cost | Minimum prefix | Notes |
|---|---|---|---|---|---|
| **Anthropic** | Explicit `cache_control`; 5-min or 1-h TTL | **0.1×** base input (0.05× for Opus 5.5 / Sonnet 5.5; 0.025× for Fable 5.1 / Mythos 5.1) | **1.25×** for 5-min, **2×** for 1-h | — | Write charges apply to `cache_creation_input_tokens` and stack with the Batch discount and the 1.1× data-residency multiplier |
| **OpenAI** | Automatic above the minimum prefix; explicit breakpoints available | **0.1×** for the gpt-6 / gpt-5.6 / gpt-5.x flagships; **0.05×** for `gpt-6.1-sol`; 0.25–0.5× for **legacy** models only | **1.25×** for **GPT-5.6 and later**; free for GPT-5.5 and earlier | **1,024 visible input tokens** for GPT-5.6+; earlier models vary by request settings | The "writes are free" claim holds only for the older models |
| **Gemini** | **Implicit** caching is on by default for all Gemini 2.5+; explicit caching via `generateContent` on Gemini 3 / 2.5 | **0.1×** for large models | n/a (no separate write charge published) | 4,096 tokens for 3.x/4.x; 2,048 for 2.5 | **Explicit caching is NOT supported for Gemini 4 Argon and later, nor in the Interactions API.** Storage is billed **per hour** — e.g. $0.50/1M tok/hr (3.8 Flash, through 2026-12-31; $1.00 from 2027-01-01), $4.50/1M/hr (3.1 Pro) |
| **DeepSeek** | Automatic prefix match | **1–3.3%** of the miss price — `deepseek-flash` ¥0.02 off-peak / ¥0.04 peak vs ¥1 / ¥2 miss; `deepseek-v4-pro` ¥0.15 / ¥0.30 vs ¥4.5 / ¥9.0 | none published (misses bill at full input price) | — | **Off-peak is exactly 50% of peak** (Beijing-time peak 09:00–12:00 and 14:00–18:00 weekdays) and applies to *all* prices |
| **Kimi** | Automatic; TTL 5-min / 1-h | **0.1×** for the K3 series (`kimi-k3`: hit ¥2 vs ¥20 base); K2 series 0.169–0.2× | **1.0×** (5-min) / **2.0×** (1-h) for K3; none listed for K2 | — | A cache hit renews the TTL with no re-write charge |
| **Self-hosted** (vLLM / SGLang) | Automatic prefix cache | No API charge | — | — | No primary source publishes a percentage. The nearest published number is SGLang's paper: "up to 6.4× higher throughput" — a **whole-system** figure, not prefix-cache-only, and not latency |

### 1.2 Break-even — a derivation, and it depends on the TTL

No provider publishes a hit-rate break-even. The figure below is **derived**,
from the published multipliers, under the stated assumption that *every miss
incurs a fresh write*:

```
h* = (W − 1) / (W − R)
  W = write multiplier   (5-min: 1.25, 1-hour: 2.0)
  R = read multiplier    (0.1 for the standard tier)
```

| TTL | Standard tier (R = 0.1) | 0.05× models | 0.025× models |
|---|---|---|---|
| **5 minutes** | **21.74%** | 20.83% | 20.41% |
| **1 hour** | **52.63%** | 51.28% | 50.63% |

Anthropic's own published framing is different, and more useful operationally:
*"caching pays off after one cache read for the 5-minute duration, or after two
cache reads for the 1-hour duration."*

**The consequence:** a 1-hour cache needs roughly **2.5× the hit rate** of a
5-minute cache to be worth enabling. A configuration that quotes "21.74%" as
if it were universal is wrong for half the TTLs in production.

### 1.3 The worked example, corrected

The original example claimed: *"a 30-turn agent session with a 20k-token
prefix at 90% hit rate on GLM-5.3 744B costs $0.459 instead of $1.58 — a 71%
saving."*

**GLM-5.3 is real** (1M context, always-on reasoning; GLM-5 is 744B total /
40B active). Its prices are **$1.40 in / $0.26 cached (0.186×) / $4.40 out**,
with implicit caching and no published write multiplier.

Recomputed over 30 turns × 20k input tokens = 600k input tokens:

| | Uncached | 90% hit |
|---|---|---|
| Input only | 600k × $1.40/M = **$0.84** | 540k × $0.26/M + 60k × $1.40/M = **$0.2244** → **73.3% saving** |
| With 5k output tokens/turn (150k output) | **$1.50** | **$0.884** → **41% saving** |

The published "$0.459 vs $1.58" ratio is only reproducible by importing a
1.25× write-on-miss multiplier that Z.AI does not publish, and by a
~$2.63/MTok input price it does not charge.

**The lesson is more useful than the number:** *the saving depends on the
output-token count, and a prefix-heavy workload with small outputs saves far
more than one with large outputs.* Quoting a headline percentage without the
output assumption is how a 73% saving becomes a 41% one.

### 1.4 Four cache-awareness layers

1. **Stable-prefix construction.** The system prompt, tool definitions, and
   conversation prefix are laid out in a fixed order and marked with
   provider-specific cache breakpoints. The SDK guarantees the stable head is
   **byte-identical** across turns.
2. **Immutable, prefix-sharing context.** The context is a persistent data
   structure: appending a turn allocates a new segment that shares the parent
   prefix **by reference**. Forks are cheap and prefixes stay stable.
3. **A local content-addressed prompt cache.** A digest of the assembled
   request keys a local cache, so a repeated request within the same worker
   hits locally before reaching the provider.
4. **A cache-economics monitor.** The SDK tracks hit rate, write cost, and
   re-prefill cost per worker and per model, and **warns and suggests
   disabling** when the hit rate falls below break-even. Caching that stops
   hitting is a cost regression with no visible symptom, and the monitor is
   the only thing that makes it visible.

### 1.5 The determinism guarantee

**The recorded call log is the source of truth. Replay returns the recorded
result without consulting the cache.** Caching changes only the *cost* of
producing a result, never the result.

A consequence worth stating: a cache bug is a **cost** bug, not a correctness
bug — unless it is in the *write* path, which is why the local cache keys on a
digest of the assembled request and the digest is recorded in the log.

### 1.6 The risk the design has to handle

**Cache invalidation risk.** A changed byte in the prefix, a different worker,
or a different model invalidates the cache, and the re-prefill cost can exceed
the savings. Two mitigations are structural:

- The cache key includes `taskClass`, `inputHash`, `policyVersion` and
  `modelVersion` — a policy or model change invalidates rather than serving
  something stale.
- `p_bad` (the probability that a cached entry is wrong at reuse) is
  **measured**, not assumed. When `p_bad·C_bad > C_recompute`, the cache loses
  money at *any* hit rate — the non-obvious case, and the one worth surfacing
  next to the hit rate.

---

## 2. Batch APIs

### 2.1 What the providers actually offer

| Provider | Creation rate | Size limit | Window | Discount | Mechanism |
|---|---|---|---|---|---|
| **OpenAI** | up to **2 000 batches/hour** | **50 000 requests** or **200 MB** input | `completion_window` can only be **24 h** | **50%** on input/output (rounded on some cached-input rates; several legacy models publish no batch cached-input rate) | JSONL file |
| **Anthropic** | — | **100 000 requests** or **256 MB** | **24 h is the expiry deadline**, not an SLA; most batches complete **within 1 hour**; results available on completion or at 24 h, whichever comes first | **50%**, exact | JSONL file; results retained 29 days |
| **Gemini (Developer API)** | — | inline <20 MB; input file max **2 GB** | job **expires after 48 hours**; target turnaround **24 hours**, usually much quicker | **50%** | **File API / JSONL, not GCS**; results kept 6 weeks |
| **Gemini (Vertex / Agent Platform)** | — | GCS- or BigQuery-sourced | 24 h target | 50% | GCS / BigQuery input |

**A correction worth flagging:** the reviewed architecture described the Gemini
batch API as GCS-based. That is the **Vertex** path. The **Gemini Developer
API** batch is File-API/JSONL based, with a 2 GB input file and a 48-hour
expiry.

### 2.2 The rate-limit pool

Verified per provider: batch requests consume a **separate rate-limit pool**
and do **not** draw on the real-time allowance. OpenAI: "a new, separate
pool… will not consume tokens from your standard per-model rate limits".
Anthropic: "its own set of rate limits which are shared across all models".
Gemini: "their own rate limits, separate from the non-batch API calls".

This is what makes batching safe to enable: it does not compete with the
interactive path for the same budget.

### 2.3 The eligibility policy

A task goes to batch mode **only if** all of these hold:

- it does not require a sub-second response;
- it can tolerate the completion window;
- it is non-interactive and **idempotent** (safe to retry);
- the cost saving exceeds the operational complexity of polling and result
  reconciliation.

Typical batch-eligible workloads: overnight classification of support tickets,
bulk content generation, evaluation runs across thousands of test cases, and
structured data extraction from a document corpus.

**The idempotency requirement is not optional.** A batch job that is retried
after a partial failure must not double-apply its effects — which is the same
commit-point discipline the trust design uses for delegated effects
(`trust.md` §5.3).

---

## 3. The decision matrix

| Workload shape | Caching | Batching | Combined strategy |
|---|---|---|---|
| **Interactive agent, long system prompt, many turns** | **On** — stable prefix, breakpoints, hit-rate monitor | Off — latency matters | Cache the system prompt and the tool definitions; accept an occasional re-prefill on a model switch |
| **Overnight batch of 50k independent prompts** | Off — no repeated prefix | **On** — 50% saving | Use the batch API; if the prompts share a prefix, enable caching **within** the batch job |
| **Eval suite with shared rubrics** | **On** — the shared rubric is the prefix | **On** — eval is non-interactive | Batch the eval calls and cache the rubric. **The highest-leverage combination**, because both levers apply to the same tokens |
| **Multi-tenant agent with per-tenant system prompts** | **On** — per-tenant cache namespace | Off — interactive | Cache per tenant; monitor hit rates per tenant; **disable for low-volume tenants**, where the write cost dominates |
| **Model routing across providers** | **Cautious** — each model has its own cache | Off — interactive | Pin the model for a session; if routing is required, account for a full re-prefill cost in the routing decision |
| **A multi-turn session that switches model mid-session** | Partially wasted | Off | The prefix cache is model-scoped; a switch forces a full re-prefill. A mid-session switch costs more than it saves unless the switch is rare |

---

## 4. The standing rule

> **Caching is a measured optimization, not a default. Batching is a
> policy-gated optimization, not a default.**

Both levers can lose money. A cache below its break-even hit rate costs more
than it saves; a batch job whose reconciliation is more expensive than the
saving is a net loss with extra infrastructure.

The SDK therefore ships the **monitor** as a first-class feature, not as an
afterthought, and the honest default is: *off until measured*.

---

## 5. Related documents

| Document | Owns |
|---|---|
| `docs/EVIDENCE.md` §2–§3 | The source URL and access date for every number above |
| `optimization.md` §7 (S2, S6) | The cache-effectiveness and cost signals, and their gaming modes |
| `docs/DECISIONS.md` D-025, D-027, D-028, D-029 | Why caching is measured, why the table was corrected, and why the recorded log is the source of truth |
