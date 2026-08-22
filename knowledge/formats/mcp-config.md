---
type: Interoperability Format
title: MCP server configuration shapes
description: Exact MCP server config schema per target agent — TOML vs JSON variants, field names, timeouts — used by adapters when emitting server registrations.
tags: [mcp, model-context-protocol, config]
status: stable
generated:
  by: agent-prism/research@0.1.0
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://code.claude.com/docs/en/mcp
    id: "1"
    title: Claude Code MCP
  - resource: https://opencode.ai/docs/mcp-servers/
    id: "2"
    title: OpenCode MCP
  - resource: https://learn.chatgpt.com/docs/extend/mcp.md
    id: "3"
    title: Codex MCP
  - resource: https://antigravity.google/docs/mcp/
    id: "4"
    title: Antigravity MCP
---

# MCP configuration per agent

All four support stdio + HTTP servers; schemas differ:

| | Claude Code | OpenCode | Codex | Antigravity |
|---|---|---|---|---|
| Location | `.mcp.json` (project) / `~/.claude.json` | `opencode.json` `"mcp"` key | `config.toml` `[mcp_servers.<id>]` | `.agents/mcp_config.json` / `~/.gemini/config/mcp_config.json` |
| Format | JSON `mcpServers` | JSON | TOML | JSON `mcpServers` |
| stdio cmd | `command` + `args[]` + `env{}` | `type:"local"`, `command[]` (argv array!), `environment{}` | `command` + `args[]` + `env{}` | `command` + `args[]` + `env{}` |
| HTTP | `url` (+type sse/http) | `type:"remote"`, `url`, `headers` | `url`, `bearer_token_env_var`, `http_headers` | `serverUrl` (NOT `url`) |
| Timeouts | — | `timeout` (ms) | `startup_timeout_sec`=10, `tool_timeout_sec`=60 | hook default 30s |

Notable gotchas: OpenCode takes command as a single argv array; Antigravity requires `serverUrl` (camelCase, rejects legacy `url`/`httpUrl`); Codex per-tool gating via `enabled_tools`/`disabled_tools` applied in that order; Claude plugin bundles put MCP in `.mcp.json` at plugin root referenced by `mcpServers` manifest path.
