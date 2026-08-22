---
type: Interoperability Format
title: AGENTS.md open standard
description: Linux-Foundation-stewarded AGENTS.md spec, per-agent precedence rules, and how the four target agents consume it.
tags: [agents-md, instructions, standard]
status: stable
generated:
  by: anyplugin/research@0.1.1
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://agents.md
    id: "1"
    title: agents.md
  - resource: https://learn.chatgpt.com/docs/agent-configuration/agents-md.md
    id: "2"
    title: Codex AGENTS.md handling
  - resource: https://opencode.ai/docs/rules/
    id: "3"
    title: OpenCode rules
---

# AGENTS.md standard

Plain markdown, no schema/frontmatter requirement. Recommended sections: overview, build/test commands, code style, testing, security, PR conventions. Stewarded by Agentic AI Foundation (Linux Foundation). Adopters include Codex, Cursor, Gemini CLI, Copilot coding agent, Jules, Amp, Devin, Windsurf, Junie, opencode, Zed, Warp, VS Code, Aider, goose.

## Consumption per target agent

- **Claude Code**: reads CLAUDE.md natively (project `./CLAUDE.md` > `~/.claude/CLAUDE.md`, `@import` support); AGENTS.md not native — adapters should symlink/duplicate AGENTS.md content into CLAUDE.md or generate one from the other.
- **OpenCode**: `AGENTS.md` first (project root + `~/.config/opencode/AGENTS.md`), `CLAUDE.md` fallback; `instructions: [...]` accepts files/globs/URLs.
- **Codex**: global `$CODEX_HOME/AGENTS[.override].md`; project walk git-root → cwd, per-dir `AGENTS.override.md` > `AGENTS.md` > fallbacks; concatenated root-down; 32 KiB cap.
- **Antigravity**: workspace root `GEMINI.md` or `AGENTS.md` (both auto-parsed; precedence undocumented, community says AGENTS.md wins — unconfirmed); plus `.agents/rules/*.md` (12k chars/file, activation modes incl. glob).

## Adapter strategy

Maintain one canonical AGENTS.md at repo root; adapters generate per-agent instruction files from it (CLAUDE.md copy for Claude; pointer lines for Antigravity rules). Never let agents' copies diverge — regenerate on build.
