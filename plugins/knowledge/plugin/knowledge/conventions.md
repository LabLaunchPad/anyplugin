---
type: Reference
title: Bundle conventions
description: How concepts are structured, captured, and validated in this OKF v0.2 bundle.
tags: [okf, conventions]
status: stable
generated:
  by: anyplugin/0.1.1
  at: 2026-08-22T12:00:00+00:00
sources:
  - resource: https://github.com/GoogleCloudPlatform/open-knowledge-format
    id: "spec"
    title: Open Knowledge Format SPEC.md
---

# Bundle conventions

- One concept per `.md` file; the file path (minus `.md`) is the concept id.
- Frontmatter: `type` required (e.g. `Decision`, `Playbook`, `Reference`); recommended `title`, `description`, `tags`, `generated {by, at}`; optional `sources[]` (each entry needs `resource`), `verified[]`, `status`, `stale_after`.[^spec]
- Actors: `<producer>/<version>`, `human:<id>`, or `process:<id>`.
- `index.md` navigation only; `log.md` newest-first under `## YYYY-MM-DD`.
- Unknown frontmatter keys must be preserved when editing.
- Validate with `npx anyplugin okf-validate <dir>`.
