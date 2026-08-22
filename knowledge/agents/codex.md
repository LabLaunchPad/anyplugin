---
type: Agent Platform
title: OpenAI Codex CLI extensibility
description: Extension surface of OpenAI Codex CLI — config.toml, AGENTS.md precedence, skills, feature-flagged hooks, native plugins, SDKs, detection — as of August 2026.
tags: [codex, openai, rust, config-toml, hooks, skills, mcp]
status: stable
generated:
  by: agent-prism/research@0.1.0
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://learn.chatgpt.com/docs/config-file/config-reference
    id: "1"
    title: "Codex config reference (JSON schema at developers.openai.com/codex/config-schema.json)"
  - resource: https://github.com/openai/codex
    id: "2"
    title: openai/codex repository
  - resource: https://learn.chatgpt.com/docs/build-plugins.md
    id: "3"
    title: Codex build-plugins docs
  - resource: https://learn.chatgpt.com/docs/agent-configuration/agents-md.md
    id: "4"
    title: Codex AGENTS.md docs
---

# Codex CLI

## Config (TOML)

User `~/.codex/config.toml` (Windows `%USERPROFILE%\.codex\`; root via `CODEX_HOME`); project `.codex/config.toml` — trusted projects only, cannot override `model_providers`, auth, `notify`, `profile`, `marketplaces`, `plugins`, `telemetry`. Admin layer `requirements.toml` (`allow_managed_hooks_only = true`). Layer order: requirements → user → profile → project → CLI `-c key=value`.

Key fields: `model`, `model_provider`, `model_reasoning_effort` (minimal|low|medium|high), `model_instructions_file`, `project_doc_fallback_filenames`, `project_doc_max_bytes` (32 KiB), `approval_policy` (string or granular map), `sandbox_mode` (read-only|workspace-write|danger-full-access), `[sandbox_workspace_write] network_access`, `[features]` flags (`hooks`, `remote_plugin`, `skill_install`, `shell_instrumentation`, `unified_exec`), `notify = ["python3","/path/notify.py"]` (payload: type, thread-id, turn-id, cwd, input-messages, last-assistant-message), `[shell_environment_policy]` (inherit all|core|none; default excludes vars matching KEY/SECRET/TOKEN), `[skills.config]` (path, enabled), `[plugins.<name>.mcp_servers.<server>]` overrides, `[agents.<name>]` multi-agent roles.

Profiles: separate files `~/.codex/<profile>.config.toml` selected `--profile <name>`. Since 0.134.0 inline `[profiles.<name>]` no longer read.

## AGENTS.md precedence (exact)

Read once at startup. (1) Global: `$CODEX_HOME/AGENTS.override.md` else `AGENTS.md`, first non-empty only. (2) Project: walk git root → cwd; per directory `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`; one file per dir. (3) Concatenated root-down (deeper wins by position). Empty files skipped; `project_doc_max_bytes` 32 KiB is a COMBINED cap across all discovered files.

## Skills (primary extension mechanism)

agentskills.io standard. Locations: `$CWD/.agents/skills`, `$CWD/../.agents/skills`, `$REPO_ROOT/.agents/skills`, `$HOME/.agents/skills`, `/etc/codex/skills` (admin), SYSTEM bundled. Frontmatter documented: `name`, `description`. Extras: `agents/openai.yaml` (display_name/icon/default_prompt; policy `allow_implicit_invocation` default true; MCP dependencies). Context budget: 2% of window or 8000 chars. Invoke `$skill-name`, `/skills`, or implicit description match. Custom prompts `~/.codex/prompts/*.md` (`description`, `argument-hint`, `$1`-`$9`, `$ARGUMENTS`) are DEPRECATED → migrate to skills.

## Hooks (enabled by DEFAULT since ~0.147; `features.hooks = false` disables; `codex_hooks` deprecated alias)

VERIFIED against repo + docs 2026-08-22 (CLI ~0.147.x). Files: `$CODEX_HOME/hooks.json`, inline `[hooks]` in config.toml, project `.codex/hooks.json` / `.codex/config.toml` (trusted projects only). Hash-based trust via `/hooks` required for non-managed hooks; `--dangerously-bypass-hook-trust` skips. `requirements.toml` may set `allow_managed_hooks_only = true`.

Events (11, exact casing): SessionStart, SessionEnd, SubagentStart, SubagentStop, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, Stop.

Hook shape: `[[hooks.<Event>]]` matcher group `{matcher: str|null, hooks: [...]}` (matcher regex on the GROUP; `"*"`/`""`/null = all). Handler fields: `type` ("command" runs; "prompt"/"agent" parsed but skipped), `command`, `timeout` seconds (def 600; SessionEnd def 1 max 3), `statusMessage`, `additionalContextLimit` (def 2500 tokens; 0 = full), `commandWindows` (alias `command_windows`), `async`. NOT documented: `timeout_sec`, `parallel`, `apply_to_agents`, `exit_on_failure`.

Input: single JSON on stdin — `session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id` + event-specific (`tool_name/tool_input/tool_use_id/tool_response`, `prompt`, `source`, `reason`, `trigger`, `agent_id`, `stop_hook_active`, `last_assistant_message`). **No `CODEX_HOOK_EVENT` env var — event name arrives via stdin JSON.** Exit codes: 0 ok; **2 + stderr = block** (PreToolUse, PostToolUse, UserPromptSubmit, SubagentStop, Stop). stdout JSON: common `{continue, stopReason, systemMessage, suppressOutput}`; SessionStart/SubagentStart `hookSpecificOutput.additionalContext`; PreToolUse `permissionDecision: deny|allow` + `updatedInput`; PermissionRequest `hookSpecificOutput.decision.behavior: allow|deny`; Stop block-reason becomes new user prompt. Max 8 concurrent async hooks; oversize output spills to `<temp>/hook_outputs/<session_id>/<uuid>.txt`.

**Plugin hooks**: `hooks/hooks.json` in plugin root default (overridable via `hooks` key in plugin.json — path/array/inline, must stay inside plugin root). Plugin hook processes get `PLUGIN_ROOT`, `PLUGIN_DATA`, **plus `CLAUDE_PLUGIN_ROOT` + `CLAUDE_PLUGIN_DATA` "for compatibility with existing plugin hooks" — CONFIRMED**. Skipped until trusted.

## Native plugins

Bundle: `.codex-plugin/plugin.json` — fields `name` (kebab), `version`, `description`, `author`, `license`, `homepage`, `default_prompt`, `skills` (relative path e.g. `./skills/`), `mcp_servers`, `hooks` (path/array/inline). Marketplace file `.codex-plugin/marketplace.json`: `{name, owner, metadata, plugins[]: {name, description, version, source: git{url,ref,sha,path} | npm{package,version,registry} | local{path}, numSkills, strict, template}}`.

Install CLI (current — `[[marketplaces]]` TOML key no longer documented): `codex plugin marketplace add <owner/repo|git-url|dir|marketplace.json-url> [--ref]`, `codex plugin add <plugin>@<marketplace>`, `codex plugin list --json` (→ `pluginId, name, marketplaceName, version, installedPath, authPolicy`). Interactive `/plugins`; scaffolding via `$plugin-creator` skill. ChatGPT + Codex share one universal plugin directory.

**Codex can import from other agents**: protocol defines `ExternalAgentConfigMigrationItemType` — detects/imports AGENTS_MD, CONFIG, SKILLS, PLUGINS (`.claude-plugin/marketplace.json` → `.codex-plugin/marketplace.json`), MCP_SERVER_CONFIG, SUBAGENTS, HOOKS, COMMANDS, MEMORY, SESSIONS.

## MCP

`[mcp_servers.<id>]`: stdio `command`, `args`, `env`, `env_vars`, `cwd`; HTTP `url`, `auth` (oauth|chatgpt), `bearer_token_env_var`, `http_headers`; common `startup_timeout_sec` (10), `tool_timeout_sec` (60), `enabled`, `required`, `enabled_tools`, `disabled_tools`. CLI `codex mcp add/list/login`.

## SDKs

TypeScript `@openai/codex-sdk` (`Codex`, `startThread()`, `resumeThread(id)`, `thread.run(prompt)`). Python `openai-codex` (app-server JSON-RPC). `codex mcp-server` runs Codex itself as MCP server.

## Detection

Child-shell env: `CODEX_SANDBOX` (macOS "seatbelt"; non-empty ⇒ inside Codex sandbox), `CODEX_SANDBOX_NETWORK_DISABLED=1`, `CODEX_CI`, `CODEX_POWERSHELL_PAYLOAD` (Windows), `CODEX_MANAGED_BY_NPM/BUN`. Host-side: `CODEX_HOME`, `CODEX_API_KEY`... Filesystem: `~/.codex/` (config.toml, auth.json, sessions/YYYY/MM/DD/rollout-*.jsonl).

## Windows

`[windows]` table, `windows.sandbox = "unelevated"|"elevated"`; install `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`.
