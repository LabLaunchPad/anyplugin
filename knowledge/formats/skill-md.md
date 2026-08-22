---
type: Interoperability Format
title: SKILL.md standard (agentskills.io)
description: The shared skill format adopted by all four target agents, with per-agent frontmatter differences and search paths — the strongest portability bridge.
tags: [skill-md, agentskills, skills, portability]
status: stable
generated:
  by: anyplugin/research@0.1.1
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://agentskills.io
    id: "1"
    title: Agent Skills open standard
  - resource: https://code.claude.com/docs/en/skills
    id: "2"
    title: Claude Code skills
  - resource: https://learn.chatgpt.com/docs/build-skills.md
    id: "3"
    title: Codex build-skills
  - resource: https://antigravity.google/docs/skills/
    id: "4"
    title: Antigravity skills
  - resource: https://opencode.ai/docs/skills/
    id: "5"
    title: OpenCode skills
---

# SKILL.md standard

A skill = directory with `SKILL.md` (YAML frontmatter + markdown body) + optional `scripts/`, `references/`/`resources/`, `assets/`/`examples/`. Progressive disclosure: agents read name+description first, body on invocation.

## Portable frontmatter (honored everywhere)

`name` (1-64 chars, `^[a-z0-9]+(-[a-z0-9]+)*$`, must match directory), `description` (required, 1-1024 chars; this is what triggers implicit invocation).

## Per-agent extras (ignored by others — safe to include)

- Claude Code: `when_to_use`, `argument-hint`, `disable-model-invocation`, `allowed-tools`, `disallowed-tools`, `model`, `context: fork`
- Codex: `agents/openai.yaml` sidecar (display_name, icon, default_prompt, policy.allow_implicit_invocation, MCP dependencies)
- Antigravity: name optional (defaults to folder)
- OpenCode: `license`, `compatibility`, `metadata` (string map)

## Search paths

| Agent | Workspace | User |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| OpenCode | `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` | `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/` |
| Codex | `.agents/skills/` (cwd, parent, repo root) | `~/.agents/skills/` |
| Antigravity | `.agents/skills/` (legacy `.agent/skills/`) | `~/.gemini/config/skills/` |

## Adapter strategy

Write ONE canonical skill per capability with the portable fields; include Claude extras (harmless elsewhere). OpenCode also natively reads `.claude/skills/` — a Claude-emitted skill tree gets dual coverage for free.

## Cross-vendor sidecar convention (verified in openai/skills, 44 official skills)

Harness-specific config lives in `agents/<vendor>.yaml` BESIDE SKILL.md — the explicit portability seam: `agents/openai.yaml` (`interface: {display_name, short_description (25-64 chars), icon_small/large, brand_color, default_prompt (must mention "$skill-name")}`, `policy: {allow_implicit_invocation: bool}`, `dependencies.tools[]: {type: "mcp", value, description, transport, url}`). "Other product-specific config can also live in the agents/ folder" — so `agents/claude.yaml`, `agents/antigravity.yaml` are legitimate extensions of the same convention.

## OpenAI's validated authoring rules (skill-creator quick_validate.py)

Frontmatter allowed keys exactly: `name, description, license, allowed-tools, metadata`; `name` `^[a-z0-9-]+$` ≤64 chars no leading/trailing/double hyphen, folder == name; `description` ≤1024 chars, no angle brackets. Description = the sole trigger surface: must state what it does, "use when" triggers, and explicit out-of-scope exclusions. Body <500 lines; progressive disclosure metadata→body→resources; references one level deep; no README/CHANGELOG clutter. Scripts: stdlib-first Python, invoked as `python "<path-to-skill>/scripts/x.py" --json`, non-zero exit for CI, inline "## Dependencies (install if missing)" section with uv→pip fallback — no requirements.txt, no lockfiles. Note: openai/skills is deprecated in favor of openai/plugins but remains the canonical authoring reference.
