---
type: Agent Platform
title: OpenCode plugin architecture
description: TypeScript plugin API of OpenCode (anomalyco/opencode, formerly sst/opencode) — hook interface, commands, agents, skills compat, config merge chain, and the missing detection marker.
tags: [opencode, typescript, plugin, hooks, config]
status: stable
generated:
  by: agent-prism/research@0.1.0
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://opencode.ai/docs/plugins/
    id: "1"
    title: OpenCode plugins docs
  - resource: https://github.com/anomalyco/opencode
    id: "2"
    title: anomalyco/opencode (packages/plugin/src/index.ts)
  - resource: https://opencode.ai/docs/config/
    id: "3"
    title: OpenCode config docs
  - resource: https://github.com/anomalyco/opencode/issues/34065
    id: "4"
    title: "Issue #34065: OPENCODE=1 env marker request (open)"
---

# OpenCode

> **v2 REWRITE WARNING (verified 2026-08-22 vs dev branch e00890c):** the dev core is an Effect-TS rewrite that only consumes plugin modules exporting default `{id, effect}` or `{id, setup}` (transform-based PluginContext: options/agent/aisdk/catalog/command/integration/plugin/reference/skill — NO chat/tool/permission/shell hooks). The v1 function-plugin API below is what the released product + docs target; the v2 core does not invoke any v1 hooks (`shell.env` is an explicit TODO at packages/core/src/tool/bash.ts:70) and silently drops v1-format plugins. v2 skills decode ONLY frontmatter {name, description, slash} and register only `<config-dir>/skill(s)` + explicit `skills[]` paths — the `.claude/skills` compat dirs exist in v1 only. v2 config top-level keys are plural (`plugins`, `commands`, `agents`, `permissions`); singular v1 keys auto-migrate. npm plugins install via Arborist to `~/.cache/opencode/packages/<name>`. **Adapter strategy: emit BOTH a v1 plugin.ts shim (works on released builds) and v2-safe artifacts (skills via config `skills[]` + commands/agents markdown), so the plugin degrades gracefully across versions.**

## Plugin loading

TypeScript/JavaScript modules from: `.opencode/plugins/` (project), `~/.config/opencode/plugins/` (global), npm packages via config `"plugin": ["pkg" | ["pkg",{options}]]` (auto-installed with Bun to `~/.cache/opencode/node_modules/`). Local deps: `.opencode/package.json` + `bun install` at startup.

Plugin signature: `export const MyPlugin: Plugin = async ({ project, directory, worktree, client, serverUrl, $, experimental_workspace }, options) => ({ ...hooks })`. `client` = `@opencode-ai/sdk`, `$` = Bun shell. Load order: global config → project config → global plugin dir → project plugin dir.

## Hook interface (exact names from packages/plugin/src/index.ts)

- Core: `dispose`, `event` (all events), `config`, `tool` (custom tools map), `auth`, `provider`
- Chat: `chat.message`, `chat.params`, `chat.headers`
- Permissions: `permission.ask`
- Commands: `command.execute.before`
- Tools: `tool.execute.before` (mutate `output.args`; throw to block), `tool.execute.after` (mutate `output.title/output/metadata`), `tool.definition`
- Shell: `shell.env` (inject env into AI + user terminals via `output.env.KEY`)
- Experimental: `experimental.chat.messages.transform`, `experimental.chat.system.transform`, `experimental.provider.small_model`, `experimental.session.compacting`, `experimental.compaction.autocontinue`, `experimental.text.complete`

Events (via `event` hook): `command.executed`, `file.edited`, `file.watcher.updated`, `installation.updated`, `lsp.client.diagnostics`, `lsp.updated`, `message.part.removed/updated`, `message.removed/updated`, `permission.asked/replied`, `server.connected`, `session.created/compacted/deleted/diff/error/idle/status/updated`, `todo.updated`, `shell.env`, `tool.execute.before/after`, `tui.prompt.append`, `tui.command.execute`, `tui.toast.show`.

Custom tools: `tool()` helper from `@opencode-ai/plugin` with Zod schema (`description`, `args`, `execute(args, context)`); plugin tools override built-ins by name.

## Commands (.opencode/commands/*.md)

Frontmatter: `description`, `agent`, `model`, `subtask`. Filename = command name. JSON alt: `"command": {name: {template, description, agent, model, subtask}}`.

## Agents (.opencode/agent/*.md)

Frontmatter: `description` (required), `mode` (primary|subagent|all), `model`, `temperature`, `tools`, `permission` (e.g. `{"edit":"deny","bash":"deny"}`). Body = prompt.

## Skills (Claude-compatible)

Search paths: `.opencode/skills/`, `~/.config/opencode/skills/`, **`.claude/skills/` + `~/.claude/skills/` (Claude compat)**, `.agents/skills/` + `~/.agents/skills/`. Frontmatter honored: `name` (required, `^[a-z0-9]+(-[a-z0-9]+)*$, 1-64 chars, must match dir), `description` (required, 1-1024 chars), `license`, `compatibility`, `metadata`; unknown fields ignored. Disable compat: `OPENCODE_DISABLE_CLAUDE_CODE=1`, `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1`.

## Config (opencode.json/jsonc, $schema https://opencode.ai/config.json)

Merge chain (later overrides): remote `.well-known/opencode` → `~/.config/opencode/opencode.json` → `OPENCODE_CONFIG` env → project `opencode.json` → `.opencode` dirs → `OPENCODE_CONFIG_CONTENT` env → managed → MDM. Configs MERGE, not replace. `OPENCODE_CONFIG_DIR` relocates.

Permissions: `"permission": "*" | {"*":"ask", "bash":"allow"|"ask"|"deny"|{"git *":"allow"}, "edit":{glob}, "webfetch", "glob", "grep", "external_directory":{ "~/projects/**":"allow" }}`. Last matching rule wins, `~`/`$HOME` expanded.

MCP: `"mcp": {name: {"type":"local","command":[...],"environment":{},"cwd","enabled","timeout"} | {"type":"remote","url","headers","enabled"}}`.

Rules: `AGENTS.md` (project root + `~/.config/opencode/AGENTS.md` global); `CLAUDE.md` fallback at both scopes; `instructions: [...]` accepts files/globs/URLs.

## Detection — CRITICAL CAVEAT

**`OPENCODE=1` is NOT implemented** (issue #34065 open; verified in v2 code too). The only child-process marker in v2 code: `OPENCODE_TERMINAL=1` + `TERM=xterm-256color` for PTY terminal sessions (packages/core/src/pty.ts:174) — NOT set for bash-tool children. Bash tool children get the parent env untouched. Use instead: `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT`/`OPENCODE_CONFIG_DIR` or any `OPENCODE_*` override env; server on `localhost:4096` (+`OPENCODE_SERVER`); existence of `~/.config/opencode/`, `opencode.json`, `.opencode/`. On released v1 builds our plugin injects its own marker via the `shell.env` hook; on v2 that hook is unwired — detection falls back to config fingerprints.

## Windows

Native but WSL recommended. Paths stay XDG (`%USERPROFILE%\.config\opencode\`). Default shell win32 = `COMSPEC` (cmd.exe).
