---
name: okf-reader
description: Read and navigate the project's OKF (Open Knowledge Format v0.2) knowledge bundle. Use when the task would benefit from prior project knowledge — decisions, audited platform facts, playbooks, architecture notes — or when asked to remember, recall, or capture project knowledge. Not for generic web search or reading regular source files.
argument-hint: [concept-id]
---

# OKF Knowledge Reader

A knowledge "bundle" is a directory of Markdown concept files (OKF v0.2, Google's Open Knowledge Format). One concept per file; **the file path is the concept id**. `index.md` is navigation only. `log.md` lists changes newest-first.

## Locate the bundle

Try in order, use the first that exists:

1. The environment variable `ANYPLUGIN_OKF_BUNDLE` — absolute path to the bundle.
2. MCP tools `okf_index` / `okf_read` / `okf_search` — if an `okf` MCP server is connected, ALWAYS prefer these tools.
3. This skill's own directory: `../knowledge/` relative to this SKILL.md (plugin-shipped bundle).
4. Project root `./knowledge/` directory (walk up from cwd).

## Read progressively (never crawl the whole bundle)

1. Read `index.md` first — it lists concepts by type with one-line descriptions.
2. Pick only concept ids relevant to the task and read those single files.
3. In each concept, frontmatter tells you how much to trust it:
   - `status: draft | stable | deprecated` (absent = stable; avoid deprecated)
   - `stale_after` — if the date has passed, treat content as outdated and say so
   - `verified` — trust tier: none = unverified, only machine actors = machine-confirmed, any `human:<id>` = human-reviewed
   - `sources[]` — provenance with `resource` URIs; footnotes `[^id]` in the body map to `sources[].id`
4. Follow bundle links only when the target matters to the current task.

## Capture new knowledge (when asked, or after significant decisions)

- One concept per file, frontmatter MUST include a non-empty `type` (e.g. `Decision`, `Playbook`, `Agent Platform`, `Reference`).
- Recommended: `title`, `description`, `tags`, `generated: {by: <tool>/<version>, at: <ISO8601+offset>}`.
- Record provenance in `sources: [{resource, id, title}]` and cite with `[^id]` footnotes.
- Append a one-line entry under today's `## YYYY-MM-DD` heading in `log.md` (newest first).
- Never edit `index.md` by hand sections you didn't add; prefer regenerating via `npx anyplugin okf-reindex` if available.
- NEVER remove `type` from any file, and preserve unknown frontmatter keys when editing.

## Validation

`npx anyplugin okf-validate <bundle-dir>` checks conformance (errors = missing/empty `type`, unparseable frontmatter, reserved-file structure).
