---
type: Agent Platform
title: Claude Code plugin architecture
description: Complete extension surface of Anthropic Claude Code — plugin manifest, skills, hooks, marketplaces, settings precedence, detection — as of August 2026.
tags: [claude-code, anthropic, plugin, hooks, skills, mcp]
status: stable
generated:
  by: anyplugin/research@0.1.1
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://code.claude.com/docs/en/plugins-reference
    id: "1"
    title: Claude Code plugins reference
  - resource: https://code.claude.com/docs/en/hooks
    id: "2"
    title: Claude Code hooks reference
  - resource: https://code.claude.com/docs/en/env-vars
    id: "3"
    title: Claude Code environment variables
  - resource: https://code.claude.com/docs/en/plugin-marketplaces
    id: "4"
    title: Claude Code plugin marketplaces
---

# Claude Code

## Plugin bundle layout

Directory with optional `.claude-plugin/plugin.json` manifest. Components live in plugin root (NOT inside `.claude-plugin/`): `skills/<name>/SKILL.md`, `commands/*.md`, `agents/*.md`, `workflows/`, `output-styles/`, `themes/`, `hooks/hooks.json`, `.mcp.json`, `.lsp.json`, `monitors/monitors.json`, `bin/` (prepended to Bash PATH), `settings.json` (only `agent` + `subagentStatusLine` keys).

## plugin.json schema (only `name` required; unknown top-level fields ignored)

- Identity: `name` (kebab-case, required), `displayName`, `version` (semver, pins updates), `description`, `author {name,email?,url?}`, `homepage`, `repository`, `license`, `keywords[]`, `metadata{}` (free-form, never read), `$schema`, `defaultEnabled`
- Component paths (string|array, relative, `./` prefix): `skills`, `commands`, `agents`, `workflows`, `outputStyles`, `hooks`, `mcpServers`, `lspServers`, `experimental.themes`, `experimental.monitors`
- `userConfig`: prompted at enable; `{type: string|number|boolean|directory|file, title, description, sensitive?, required?, default?, multiple?, min?, max?}`; substituted as `${user_config.KEY}`, exported to hooks as `CLAUDE_PLUGIN_OPTION_<KEY>`
- `channels[{server,userConfig}]`, `dependencies["helper-lib" | {name, version}]`

## Plugin env vars

`${CLAUDE_PLUGIN_ROOT}` (install dir), `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/{id}/`, survives updates), `${CLAUDE_PROJECT_DIR}`.

## Skills

`SKILL.md` per agentskills.io. Frontmatter (all optional): `name`, `description`, `when_to_use`, `argument-hint`, `disable-model-invocation`, `allowed-tools`, `disallowed-tools`, `model` (or `inherit`), `context: fork`. description+when_to_use truncated at 1536 chars in listing. Body supports `` !`command` `` dynamic injection, `@file`, `${CLAUDE_PROJECT_DIR}`, `${CLAUDE_SESSION_ID}`.

## Subagents (agents/*.md)

Frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `skills`, `memory`, `background`, `isolation: worktree`. Plugin agents FORBIDDEN: `hooks`, `mcpServers`, `permissionMode` (security). Namespaced `plugin-name:agent-name`.

## Hooks — 33 events

SessionStart, Setup, UserPromptSubmit, UserPromptExpansion, PreToolUse, PermissionRequest, PermissionDenied, PostToolUse, PostToolUseFailure, PostToolBatch, Notification, MessageDisplay, SubagentStart, SubagentStop, TaskCreated, TaskCompleted, Stop, StopFailure, TeammateIdle, InstructionsLoaded, ConfigChange, CwdChanged, DirectoryAdded, FileChanged, WorktreeCreate, WorktreeRemove, PreCompact, PostCompact, Elicitation, ElicitationResult, SessionEnd.

Config shape: `hooks → event → [{matcher?, hooks: [{type: command|http|mcp_tool|prompt|agent, command|url|..., timeout?, async?, asyncRewake?, if?}]}]`.

stdin JSON: `session_id`, `transcript_path`, `cwd`, `permission_mode` (default|plan|acceptEdits|auto|dontAsk|bypassPermissions), `hook_event_name`, + event-specific (`tool_name`, `tool_input`, `tool_response`, `prompt`, `source`, `stop_hook_active`...).

Exit codes: 0 ok; **2 = blocking** (stderr → model; blocks for PreToolUse/UserPromptSubmit/Stop family); other non-zero = non-blocking.

stdout JSON controls: `continue`, `stopReason`, `suppressOutput`, `systemMessage`, `decision: block + reason`, `hookSpecificOutput: {permissionDecision: allow|deny|ask|defer, permissionDecisionReason, updatedInput}` (PreToolUse), `additionalContext` (SessionStart/UserPromptSubmit/Stop), `retry`, `displayContent`.

## marketplace.json

At `.claude-plugin/marketplace.json`. Fields: `$schema`, `name`, `description`, `owner{name,email}`, `plugins[]`, `renames{}`, `metadata.pluginRoot`. Plugin entries: `name`, `description`, `author`, `category`, `version`, `homepage`, `defaultEnabled`, `icon`, `strict`, `source`. Sources: `"./plugins/x"`, `{source: github, repo}`, `{source: url, url, ref?, sha?}`, `{source: git-subdir, url, path, ref?, sha?}` (sparse), `command`, npm. `sha` beats `ref`.

## Settings precedence (high→low)

Managed (MDM) → CLI args → `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`. Windows user settings: `%USERPROFILE%\.claude\settings.json`. MCP: `~/.claude.json` (user), `.mcp.json` (project), `claude mcp add`. CLAUDE.md: `./CLAUDE.md` > `~/.claude/CLAUDE.md`, `@import` supported.

## Install/distribution

`/plugin marketplace add owner/repo`, `/plugin install name@marketplace`, `claude plugin init/validate/list/enable/disable/uninstall`. Cache `~/.claude/plugins/cache`. Node deps auto-install from lockfiles (bun.lock > npm-shrinkwrap > package-lock; frozen, --ignore-scripts, 60s).

## Detection (see [detection matrix](/adapters/detection-matrix.md))

`CLAUDECODE=1` in ALL spawned subprocesses — primary signal. `CLAUDE_CODE_CHILD_SESSION=1` (Bash/hooks only, not MCP/IDE). `CLAUDE_CODE_SESSION_ID`. `CLAUDE_PID` (v2.1.214+). `CLAUDE_CODE_ENTRYPOINT` undocumented — treat as legacy.
