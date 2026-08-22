---
type: Interoperability Format
title: Open Knowledge Format (OKF) v0.2
description: Google Cloud's OKF v0.2 spec extraction — frontmatter fields, reserved files, conformance rules, trust tiers — the authority for the knowledge/ library in agent-prism core.
tags: [okf, knowledge, google-cloud, spec]
status: stable
generated:
  by: agent-prism/research@0.1.0
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://github.com/GoogleCloudPlatform/open-knowledge-format
    id: "1"
    title: Official OKF repository (SPEC.md, bundles/, reference_agent/)
  - resource: https://cloud.google.com/blog/products/data-analytics/okf-v-0-2-adds-trust-signals
    id: "2"
    title: "OKF v0.2 announcement (2026-07-25)"
  - resource: https://cloud.google.com/blog/products/data-analytics/how-the-open-knowledge-format-can-improve-data-sharing
    id: "3"
    title: OKF v0.1 announcement (2026-06)
---

# OKF v0.2

Bundle = directory of UTF-8 `.md` files, one per concept; **file path (minus .md) = concept ID**. No SDK/runtime required. Origin: Google Cloud (BigQuery/Data team), formalizing Karpathy's "LLM wiki". v0.2 (2026-07-25) adds trust signals; fully backward compatible with v0.1.

## Frontmatter

- Required (only): `type` (short string, unregistered values allowed, e.g. `Metric`, `Agent Platform`)
- Recommended: `title`, `description`, `resource` (URI), `tags`
- v0.2 provenance: `sources[]` each `{resource (req), id?, title?, author?, usage_count?, last_modified?}` + optional `usage_window {from,to}`. NO numeric credibility score by design. Per-claim attribution via footnotes keyed to `sources[].id`.
- v0.2 generation: `generated {by, at}` — `by` = `<producer>/<version>` | `human:<id>` | `process:<id>`; `at` = ISO 8601 with explicit UTC offset
- v0.2 trust: `verified[]` of `{by, at}` events → tiers: absent = **unverified**; only non-human entries = **machine-confirmed**; any `human:<id>` = **human-reviewed**. Advisory, not access control.
- v0.2 lifecycle: `status: draft|stable|deprecated` (absent = stable); `stale_after` (absolute instant; stale when now >= stale_after — chosen for deterministic non-LLM comparison)
- `Attested Computation` type extras: `runtime`, `parameters[] {name,type,required}`, `computation` (path or `# Computation` fence), `executor {resource,receipt}`, `attester {resource}`. Agents may only fill declared parameters; MUST NOT edit the computation; receipts never stored in bundle.

## Reserved files

- `index.md` — navigation/progressive disclosure ONLY; must not document concepts; only allowed frontmatter: root-level `okf_version: "0.2"` (this declares bundle version)
- `log.md` — flat, newest-first list under ISO `YYYY-MM-DD` date headings
- `references/` — convention for mirrored external material

## Links

Bundle-absolute (leading `/`, recommended) or relative markdown links; consumers MUST tolerate broken links.

## Conformance (normative)

1. Parseable YAML frontmatter in every non-reserved `.md`; 2. non-empty `type` everywhere; 3. reserved files follow their structure when present. Consumers MUST NOT reject for: missing optional fields, unknown types, unknown keys, broken links, missing index.md. **Unknown keys MUST be preserved on round-trip.** v0.1→v0.2 renames with fallback: `timestamp` → `generated.at`; body `# Citations` → `sources`.

## Authority note

Third-party sites okf.md and openknowledgeformat.com are community-run (one still documents v0.1 only; one claims an `okf.yaml` manifest — contradicts official spec). The official repo SPEC.md is authoritative. No `.okf` extension exists — everything is `.md`.

## Validator matrix (verified against official tests/ + reference_agent, drives @agent-prism/core okf implementation)

MUST-fail: non-reserved `.md` without parseable frontmatter mapping (rule: file not starting `---` = empty frontmatter ⇒ fails on missing type); unterminated frontmatter; empty/missing `type`; `type: Attested Computation` without `runtime`; frontmatter in non-root index.md (root index.md may carry ONLY `okf_version`).

MUST-warn (never reject): `generated` without `by`; malformed `verified` entries; timestamps without explicit UTC offset (date-only/naive ⇒ ignored by staleness, never error); `status` outside draft|stable|deprecated; `sources[]` entry missing `resource`; duplicate `sources[].id`; body footnotes `[^x]` without matching source id; actor strings not matching `<producer>/<version>|human:<id>|process:<id>`; AC concepts lacking both `# Computation` block and `computation:` path (or having both); legacy `timestamp`/`# Citations` (suggest migration); broken internal links; non-dict sources entries / non-list tags (normalize).

MUST-tolerate: unknown `type` values (no registry); unknown frontmatter keys of any shape — PRESERVE verbatim on round-trip; missing index/log/optional families; bare `verified` mapping (normalize to 1-list); bare-mapping sources entry (counts as 1); non-`.md` files; free-text `sources[].resource`; frontmatter in `log.md` (official sample has `type: Log`); absent `status` ⇒ stable; absent/invalid `stale_after` ⇒ not stale; YAML 1.2 core-schema parsing (never let ISO datetimes coerce to date objects — reference impl strips YAML 1.1 timestamp resolver).

Algorithms (copy from reference impl): trust tier = no verified → unverified; only non-human actors → machine-confirmed; any `human:<id>` → human-reviewed. Stale iff `now >= stale_after` (instant compare, deterministic non-LLM). Serializer: `---\n<yaml safe_dump sort_keys=False>\n---\n\n<body>`; known-key order type,resource,title,description,tags,status,generated,verified,stale_after,sources,usage_window then unknown keys. index.md auto-gen: deepest-first per dir, sections `# <Type>` (`# Subdirectories` at root), entries `* [title](file.md) - description` sorted by title; single-child dir reuses child description.
