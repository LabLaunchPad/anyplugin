---
type: Agent Platform
title: Google Antigravity extensibility
description: Extension surface of Google Antigravity 2.0 — .agents/ layout, rules/workflows, skills, custom agents, hooks.json, mcp_config.json, native plugins, permissions, SDK, detection, ToS caution — as of August 2026.
tags: [antigravity, google, gemini, agents-dir, hooks, mcp]
status: stable
generated:
  by: agent-prism/research@0.1.0
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://antigravity.google/docs/
    id: "1"
    title: Antigravity official docs (155 pages)
  - resource: https://github.com/google-antigravity/antigravity-sdk-python
    id: "2"
    title: antigravity-sdk-python
  - resource: https://antigravity.google/docs/plugins/
    id: "3"
    title: Antigravity plugins docs
  - resource: https://antigravity.google/docs/hooks/
    id: "4"
    title: Antigravity hooks docs
---

# Antigravity (Google)

## Instruction files

Global: `~/.gemini/GEMINI.md` (official). Workspace: `GEMINI.md` OR `AGENTS.md` at root (both auto-parsed; precedence between them undocumented; community reports AGENTS.md wins — unconfirmed). Rules: `.agents/rules/*.md` (legacy `.agent/rules/` supported), 12,000-char limit per file; activation types: Manual (@mention), Always On, Model Decision, Glob (`src/**/*.ts`); `@file` refs allowed. Workflows: markdown invoked as `/workflow-name`, global + workspace, 12k limit, can chain.

## Skills

`.agents/skills/<name>/SKILL.md` (workspace; legacy `.agent/skills`), `~/.gemini/config/skills/` (global). agentskills.io format: `name` (defaults to dir), `description` (required); optional `scripts/`, `examples/`, `resources/`. Progressive disclosure.

## Custom agents

`.agents/agents/<name>.md` (or `<name>/agent.md`), `~/.gemini/config/agents/` (global), `plugins/<p>/agents/`. Frontmatter: `name`, `description` (both required), `tools` (view_file, grep_search, run_command...), `mainAgent` (default true), `subagent` (default true), `model` (inherit|flash|pro), `commandExecutionPolicy` (off|auto|eager|sandbox), `mcpServers`, `skills`, `plugins`. Body = system prompt. Invoked via `invoke_subagent`/`define_subagent`; workspace modes inherit|branch|share. Built-ins: research, browser, self.

## MCP (JSON, not TOML)

Global `~/.gemini/config/mcp_config.json`; workspace `.agents/mcp_config.json` (plural `.agents`). Schema: top-level `mcpServers`; per server stdio `command`+`args`+`env`+`cwd` OR HTTP `serverUrl` (legacy `url`/`httpUrl` NOT supported), `headers`, `authProviderType` ("google_credentials" = ADC), `oauth {clientId, clientSecret}`, `disabled`, `disabledTools`. OAuth redirect `https://antigravity.google/oauth-callback`; tokens `~/.gemini/antigravity/mcp_oauth_tokens.json`. Permission patterns: `mcp(server/tool)`, `mcp(server/*)`, `mcp(*)`.

## Hooks

`.agents/hooks.json` (workspace) or `~/.gemini/config/hooks.json` (global). Events (5): PreToolUse, PostToolUse (both `matcher` regex + `hooks[]`), PreInvocation, PostInvocation, Stop. Handler: `{"type":"command" (only type), "command", "timeout": secs (default 30), "enabled"}`. JSON stdin/stdout **camelCase**: `conversationId`, `workspacePaths`, `transcriptPath`, `artifactDirectoryPath`, `modelName`. PreToolUse out: `decision` = allow|deny|ask|force_ask|deny_unless_prior_grant + `reason` + `permissionOverrides` (`["command(npm test)"]`). PostInvocation out: `injectSteps` (toolCall/userMessage/ephemeralMessage) + `terminationBehavior`. Stop out: `{"decision":"continue"}` re-enters loop. Transcript: `~/.gemini/antigravity[-cli]/brain/<id>/.system_generated/logs/transcript.jsonl`.

## Native plugins

`plugins/<name>/` containing `plugin.json` (only documented field `name`, defaults to dir name) + optional `mcp_config.json`, `hooks.json`, `skills/<n>/SKILL.md`, `rules/<n>.md`. Install: workspace `.agents/plugins/` (or `_agents/plugins/`) or global `~/.gemini/config/plugins/`; auto-scanned; components namespaced. No open marketplace — Google bundles via Customizations panel.

## Permissions

`action(target)` rules, Deny > Ask > Allow. Actions: `read_file`, `write_file` (path|dir|*), `read_url(domain)`, `execute_url(domain)`, `command(prefix|regex|*)` (anchored token regex, e.g. `command(npm run (build|lint|test))`), `unsandboxed(...)`, `mcp(...)`. Defaults: workspace read/write allowed, rest Ask. Windows paths normalized (drive letters stripped, backslashes → `/`).

## SDK (verified against antigravity-sdk-python 0.1.14 source, 2026-08-22)

`pip google-antigravity`. Exports `Agent`, `AgentConfig`, `LocalAgentConfig`, `LiteRTAgentConfig`, `LocalOpenAIAgentConfig`, `ToolContext` + types. Runtime is a pre-compiled Go binary `localharness` shipped in wheels; config passed as protobuf over WebSocket (`ws://localhost:<port>/`, `x-goog-api-key`). **The SDK reads/writes NO `.agents/` files** — mcp_servers, tools, hooks, subagents, policies are Python objects; skills passed as absolute `skills_paths`; default `policies=policy.confirm_run_command()`; default model `gemini-3.7-flash`. Policy targets are plain tool names + `server/tool`/`server/*` (no `command(npm test)` DSL — arg matching via Python predicates); precedence Specific Deny > Specific Ask > Specific Allow > Wildcard Deny > Ask > Allow. Hook classes (in-process Python): OnSessionStart/End, PreTurn, PostTurn, PreToolCallDecide, PostToolCall, OnToolError, OnInteraction, OnCompaction. Env: `GEMINI_API_KEY`, `GOOGLE_GENAI_USE_VERTEXAI`/`GOOGLE_GENAI_USE_ENTERPRISE` + `GOOGLE_CLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`, `ANTIGRAVITY_HARNESS_PATH`. App data `~/.gemini/antigravity` (artifacts under `brain/<conversation_id>/`).

**Adapter implication**: the file-based `.agents/` layout documented above is the IDE/CLI surface; SDK users need code-level injection. Install adapter targets the IDE/CLI files.

## Detection

`ANTIGRAVITY_AGENT` (community-verified, not in official docs). VS Code fork markers: `TERM_PROGRAM=vscode`, `VSCODE_PID`, `VSCODE_CWD`. Fingerprints: `~/.gemini/`, `.agents/` in workspace, `agy` binary.

## CAUTION

Antigravity FAQ: using third-party software to drive Antigravity (they name Claude Code, OpenClaw, OpenCode) violates ToS. Integrate ONLY via documented files/skills/MCP/hooks. VS Code extension API access inside the IDE: NOT confirmed.
