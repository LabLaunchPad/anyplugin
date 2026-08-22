---
okf_version: "0.2"
---

# Agent-Prism Knowledge Index

Navigation map for this bundle. Concept identity = file path. Read on demand; do not crawl.

## Agents (backward-engineering audits)

- [Claude Code](/agents/claude-code.md) — plugin.json schema, 33 hook events, SKILL.md, marketplaces, detection
- [OpenCode](/agents/opencode.md) — TypeScript plugin API, hook names, config merge, detection caveats
- [Codex CLI](/agents/codex.md) — config.toml, hooks.json, .codex-plugin, AGENTS.md precedence, detection
- [Antigravity](/agents/antigravity.md) — .agents/ layout, hooks.json, mcp_config.json, plugin.json, detection, ToS caution

## Formats (shared standards)

- [SKILL.md standard](/formats/skill-md.md) — agentskills.io frontmatter, progressive disclosure, per-agent quirks
- [MCP configuration](/formats/mcp-config.md) — stdio/HTTP server shapes per agent
- [AGENTS.md standard](/formats/agents-md.md) — Linux Foundation spec, precedence rules per agent
- [OKF v0.2](/formats/okf-v02.md) — frontmatter fields, reserved files, conformance rules

## Adapter design (forward engineering)

- [Canonical event mapping](/adapters/event-mapping.md) — canonical ↔ native hook events across all four agents
- [Detection matrix](/adapters/detection-matrix.md) — env vars and filesystem fingerprints per agent + environment layer

## References

Mirrored external material with provenance lives in [references/](/references/).
