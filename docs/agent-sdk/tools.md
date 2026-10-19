# Tools: the 18-tool surface, the two tiers, and the region bundles

**The user asked for "Top 10–20 tools as per latest area, region, country
specific user needs" and then for the full surface including MCP servers.**
This document specifies 18 tools, split into two explicit tiers, plus the
**region bundle** that makes "tailored by region" a schema rather than a
marketing phrase.

The design constraint that shapes everything: **a tool's tier is part of its
schema**, so the model, the policy engine, and the auditor can all see it.

---

## 1. The two tiers, and why there are exactly two

| Tier | Meaning | Network egress | Default |
|---|---|---|---|
| **`local`** | Runs entirely on the user's device. WASM or native. | **None** | **Enabled** |
| **`network`** | Requires egress. | Yes — every call is an event with a legal basis | **Disabled** for regulated tenants |

**Why `local` is the default rather than a mode.** The local-first research
brief is explicit: *"'local-first' is not the same as 'offline.'"* A tool that
can reach the network will reach the network. The only reliable way to make
"your document never left your device" a true statement is for the default
tool surface to have **no egress path at all**, and for egress to be an
explicit, per-tenant, logged grant.

This is also where the compliance payoff lives. Under India's DPDP Act 2023,
§3(1)(b) applies to processing **outside** India in connection with offering
goods or services to Data Principals **in** India. A document parsed in the
user's own browser in India and never transmitted is the simplest possible
answer to that question — and it is an answer the tool surface can *make*
rather than one the documentation has to *promise*.

---

## 2. The 18 tools

Legend: **L** = local-only · **N** = requires network

| # | Tool | Tier | What it does | Why it is here |
|---|---|---|---|---|
| 1 | `doc.parse` | **L** | Bytes + mime → structured text, headings, tables, page/bbox provenance, content hash | The front door. Every downstream claim's citation anchor comes from here |
| 2 | `ocr.page` | **L** | Raster page → text + confidence + language | Passports, invoices, scans. **Special-category data** under GDPR Art. 9, PIPL, DPDP — so it must be local |
| 3 | `web.fetch_cited` | **N** | URL → markdown + a **citation bundle** (final URL after redirects, retrieved-at, content sha256, quoted span + offset, HTTP status, content-type) | The citation bundle *is* the product. A fetch without provenance is a fetch with no evidence |
| 4 | `web.search` | **N** | Query → titles, URLs, snippets | Separate from fetch; provenance is provider + query + retrieved-at |
| 5 | `calc.expr` | **L** | Deterministic arithmetic, percentiles, date arithmetic, unit-aware spreadsheet formulas | A real expression evaluator, **never `eval`**. Reproducible ⇒ hashable ⇒ replayable |
| 6 | `code.run` | **L** browser / **N** server | Sandboxed execution of generated code | The tier split is the security boundary. Browser tier never egresses; server tier egress **is** a transfer |
| 7 | `units.convert` | **L** | Dimensioned unit conversion, including local customary units | Bundled, versioned unit tables, with the table cited in the ledger |
| 8 | `geo.resolve` | **L** only | Address/place → lat-lon + administrative hierarchy | **Never a hosted geocoder by default** — sending a user's address to a geocoder is a disclosure. See the licence note below |
| 9 | `fx.rate` | **N** | Currency conversion with an **as-of date** and a rate source | FX rates move. The rate and its timestamp are part of the evidence record |
| 10 | `tz.now` / `tz.convert` | **L** | Current time in an IANA zone; conversion across zones; DST-aware | The **zone identifier**, never a fixed offset — `Asia/Kolkata` ≠ `UTC+05:30` for DST-observing jurisdictions |
| 11 | `locale.format` | **L** | Date, number, currency, list and collation formatting for a locale (CLDR) | `Intl` is already in the runtime. Unicode CLDR is under the Unicode Licence |
| 12 | `currency.round` | **L** | Minor-unit-aware rounding, cash rounding, ISO 4217 | **A real correctness trap.** JPY/KRW/CLP have 0 decimals; BHD/KWD/JOD/TND have 3. Rounding a KWD invoice to 2 decimals is a data-integrity bug |
| 13 | `holiday.calendar` | **L** | Public holidays, working days, days-between, for a jurisdiction | "Country-specific user needs" gold. **China's 调休 make-up workdays** are a genuine differentiator |
| 14 | `tax.rate` / `tax.compute` | **L** | VAT/GST/sales-tax rate by jurisdiction + effective date; inclusive/exclusive computation | A **versioned table with `effective_from`**, not a live API. A live tax API is a transfer *and* a liability |
| 15 | `translate.text` | **L** preferred / **N** opt-in | Translation between locales | The single largest cross-border transfer in the set. Local-first default, hosted opt-in |
| 16 | `transliterate` | **L** | Latin ↔ native script, ISO 15919 / UN romanisation | **Security note:** transliteration can evade name-match filters. Display utility only — **never** the sole key for a blocklist match |
| 17 | `entities.extract` | **L** | NER + PII classification (name, email, phone, IBAN, national ID, card PAN) | **The egress chokepoint.** Everything passes through here before it leaves the device |
| 18 | `address.normalize` / `contact.normalize` | **L** | Postal address normalisation; E.164 phone; email normalisation | libphonenumber metadata is Apache-2.0; ITU-T E.164. **Not** a hosted validation API by default |

### 2.1 The five tool-layer design rules

These fall out of the table and are **binding**:

1. **Two tiers, explicitly.** A tool's tier is a required field in its
   schema. The model sees it; the policy engine enforces it; the auditor
   reads it.
2. **Every `network` tool returns a provenance bundle.** Source,
   retrieved-at, hash, exact quoted span. Without it, "citation capture" is
   marketing.
3. **Every `local` tool is content-addressable** — it hashes its inputs
   *and* its versioned dataset (`holiday.calendar@2026.1`), so a result can
   be recomputed and audited later.
4. **Every tool result passes through `entities.extract` before egress.** One
   chokepoint, one policy.
5. **The `local` tier must be genuinely usable offline.** If the SDK needs a
   network for currency or holidays, "local-first" is a slogan.

### 2.2 The licence note on `geo.resolve`

An offline gazetteer is the only default-compatible option. **MaxMind GeoLite2
is not OSS-licensed** (it is under a proprietary EULA) and therefore cannot
ship in an MIT/Apache core. The options are an **ODbL** open gazetteer (OSM /
Nominatim-derived) or dropping the tool from the default bundle. This is
recorded as an open decision, not resolved silently.

---

## 3. MCP servers in the surface

The user asked for the full surface **including MCP servers**. Three
categories, with a different trust posture each:

| Category | Examples | Trust posture |
|---|---|---|
| **First-party `local` tools** | The 16 local tools above | Part of the SDK. Pinned by content hash. Full evidence tier |
| **First-party `network` tools** | `web.fetch_cited`, `web.search`, `fx.rate` | Part of the SDK. Egress-gated, per-tenant grant, every call an event with a legal basis |
| **Third-party MCP servers** | User-supplied | **Untrusted by default.** The MCP authorization spec applies to **HTTP transports only** — it explicitly says implementations using an STDIO transport SHOULD NOT follow it. A local stdio MCP server is a **local process**, and gets the `local` tier's containment rules, not an OAuth trust grant |

**The rule that keeps this safe:** a third-party MCP server can only ever be
in the `network` tier, and only with an explicit per-tenant grant. It cannot
be promoted to `local` by configuration, and it can never confer
`AUTHORITATIVE` authority — an unpinned plugin or MCP server is `REPORTED` at
best (trust.md T2, T11).

**And the one the plan must not forget:** the digest pipeline reads
untrusted text that the model will then read. A parsed document may contain
instructions. The rule is that **untrusted content never creates
instructions or capabilities** — it is data, and it is quoted, never obeyed.

---

## 4. The region bundle — the unit of tailoring

A **region bundle** is a versioned, citable artefact:

```ts
RegionBundle = {
  id: "IN",                       // ISO 3166-1 alpha-2
  version: "2026.1",              // the bundle's own version
  effectiveFrom: "2026-01-01",
  locales: ["hi-IN", "ta-IN", "te-IN", "bn-IN", "mr-IN", "gu-IN", "kn-IN", "ml-IN"],
  currency: { code: "INR", minorUnits: 2, symbol: "₹" },
  timezone: "Asia/Kolkata",       // identifier, not offset
  taxRates: [ { rate: 0.18, from: "2026-01-01", label: "GST", jurisdiction: "IN-central" } ],
  holidays: { dataset: "IN-2026", version: "2026.1", shiftRules: [] },
  complianceProfile: "DPDP-IN",
  sources: [ /* one citation per dataset, with an access date */ ],
}
```

**The `complianceProfile` field is the whole point.** It declares which tools
may run locally, which require a documented transfer mechanism, and what
artefact the SDK must be able to emit. Without it, "tailored by region" is a
locale string; with it, it is an enforceable policy.

---

## 5. The eight bundles, and what each one's compliance profile changes

> **Every figure in this section is `REPORTED`-authority** unless a primary
> source URL is given. The regulatory instruments are cited; the *legal
> conclusions* are not ours to make, and the SDK encodes references, not
> opinions.

| Jurisdiction | Locale set | Currency | Tax | Holiday nuance | Compliance profile → what it changes |
|---|---|---|---|---|---|
| **India** | 8 Indic locales | INR (2) | **GST** — CGST/SGST/IGST split by state code | Per-state public holidays | `DPDP-IN` — §3(1)(b) captures offshore processing of Indian users' data. **Local-first is a compliance feature, not a privacy feature.** DPDP Rules 2025 (notif. 13 Nov 2025) commence in tranches: Rules 1, 2, 17–21 in force; **Rule 4 ≈ 14 Nov 2026**; **Rules 3, 5–16, 22, 23 ≈ 14 May 2027** — the substantive consent/notice/transfer rules land within ~7 months of this plan |
| **Singapore** | `en-SG`, `zh-SG`, `ms-SG`, `ta-SG` | SGD (2) | GST 9% | SG public holidays | `PDPA-SG` — s.26 transfer limitation is a **contractual** problem, not a consent problem. PDPR 2021 reg 10–11; ASEAN MCCs reusable with MY/ID |
| **UAE** | `ar-AE` (+ numerals variant), `en-AE` | AED (2) | VAT 5% | **Friday–Sunday weekend; Islamic-calendar holidays shift** | `PDPL-AE` — Art.22/23: transfer permitted where the destination has adequate legislation or an agreement. **No published UAE adequacy list** as of the source consulted ⇒ assume none; Art.23(b) explicit consent is the workable path. Free-zone regimes (DIFC/ADGM) have their own instruments — the profile should detect a free-zone controller |
| **Saudi Arabia** | `ar-SA` (+ Hijri/Gregorian), `en-SA` | SAR (2) | VAT 15% | SA public holidays | `PDPL-SA` — Art.29(2)(c) limits transfer to the **minimum necessary** and requires appropriate protection; Transfer Regulation Art.5 permits BCRs, SDAIA-model SCCs, certification, or binding codes of conduct. **SCC-in-a-box is templateable** |
| **China** | `zh-CN`, `zh-HK`, `zh-TW` | CNY (2) | VAT 13/9/6% by category | **调休 — make-up workdays: the calendar has working weekends** | `PIPL-CN` — Art.38: security assessment / certification / standard contract / other; Art.39: notice + **separate consent**. **Strictest of the seven.** The four gateways are slow and document-heavy ⇒ **local-only is the only realistic path** |
| **Brazil** | `pt-BR` | BRL (2) | ICMS by state + DIFAL | National + state holidays | `LGPD-BR` — ⚠️ **UNVERIFIED.** The statutory transfer provisions were not re-fetched in the research pass. **Resolve before the Brazil bundle ships** |
| **EU/EEA + UK** | Full CLDR set | EUR (2) | VAT OSS/IOSS | EU public holidays | `GDPR-EU` — Art. 5(1)(c) minimisation, Art. 9 special categories, Art. 44/46 transfers. The `local` tier is the mitigation: **if the bytes never leave, there is no transfer question.** SCCs + TIA; DPF adequacy for certified US recipients |
| **United States** | `en-US` (+ `es-US`, `fr-CA`) | USD (2) | Sales tax by state + city | Federal/state/local | `HIPAA-US` — Safe Harbor's 18 identifier classes must be detectable by `entities.extract`. ⚠️ **The exact identifier list was not re-fetched — treat as UNVERIFIED until checked.** **HIPAA is a no-egress regime**: ePHI must not reach a hosted LLM, so `local` + a local model is the only compliant default |

### 5.1 The one differentiator worth stating plainly

No mainstream platform ships **region-aware utilities**. The MCP reference
`Time` server does timezones; the archived `Google Maps` server did geocoding.
Currency *rounding*, tax *effective dates*, holiday *shift rules*, and a
*compliance profile* are not exposed anywhere as a first-class concept.

**The `local` tier is simultaneously the privacy story, the cost story, and
the compliance story** — because the same mechanism (the bytes never leave)
satisfies all three at once. That is the product thesis in one sentence.

---

## 6. The egress chokepoint

Every `network` call passes through one function. There is no second path.

```
tool result
    → entities.extract (PII + special-category classification)
    → policy check (tenant grants, region profile, sensitivity)
    → legal-basis record (consent id | SCC id | BCR id | certification)
    → event (network_call with the bundle)
    → return to the orchestrator
```

If the policy check cannot produce a legal basis, the call is refused and the
refusal is recorded. **Absence of a legal basis is not a default-allow
branch** — it is a `BLOCKED`, the same way a missing verification result is.

---

## 7. Related documents

| Document | Owns |
|---|---|
| `docs/agent-sdk/roadmap.md` | Which MVP ships which tool group |
| `docs/agent-sdk/substrate.md` | The parsers that back `doc.parse` and `ocr.page` |
| `docs/agent-sdk/trust.md` | The evidence tier each tool's output receives |
| `docs/agent-sdk/optimization.md` | The signals that watch tool cost and grounding-denial rate |
| `docs/EVIDENCE.md` | Every regulatory citation, with a source URL and an access date |
