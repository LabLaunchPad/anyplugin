---
name: hello
description: Greets the user and demonstrates the cross-agent skill format. Use when the user says hello or asks what this plugin can do. Not for anything else.
---

# Hello skill

This skill runs identically in Claude Code, OpenCode, Codex, and Antigravity.

## Workflow

1. Read the user's request.
2. Respond with a short greeting and the plugin name.

Keep skills small: description = trigger surface, body = procedure,
`scripts/`/`references/` = on-demand resources.
