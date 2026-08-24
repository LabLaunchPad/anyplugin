---
type: Adapter Design
title: Canonical event mapping
description: Mapping of AnyPlugin canonical hook events to the native hook/event names of Claude Code, OpenCode, Codex, and Antigravity, plus payload translation notes.
tags: [hooks, events, mapping, adapters]
status: stable
generated:
  by: anyplugin/design@0.1.1
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://code.claude.com/docs/en/hooks
    id: "1"
    title: Claude Code hooks
  - resource: https://github.com/anomalyco/opencode
    id: "2"
    title: OpenCode plugin API
  - resource: https://learn.chatgpt.com/docs/hooks.md
    id: "3"
    title: Codex hooks
  - resource: https://antigravity.google/docs/hooks/
    id: "4"
    title: Antigravity hooks
---

# Canonical event mapping

Canonical handlers are ALWAYS `node <dist>/hooks/runner.js <handler-id>` reading platform JSON on stdin, writing platform-appropriate JSON/exit codes. Claude Code, Codex, and Antigravity call command hooks natively; the OpenCode TS plugin shim spawns the identical runner as a child process — one execution model everywhere.

| Canonical | Claude Code | OpenCode | Codex | Antigravity |
|---|---|---|---|---|
| session-start | SessionStart | event `session.created` | SessionStart | PreInvocation |
| before-tool-use | PreToolUse | `tool.execute.before` | PreToolUse | PreToolUse |
| after-tool-use | PostToolUse | `tool.execute.after` | PostToolUse | PostToolUse |
| prompt-submit | UserPromptSubmit | — | UserPromptSubmit | PreInvocation |
| turn-stop | Stop / SessionEnd | event `session.idle` | Stop | Stop |
| permission-request | PermissionRequest | `permission.asked` | PermissionRequest | PreToolUse decision |
| session-end | SessionEnd | event `session.idle` (fallback) | SessionEnd | — |

## Payload translation notes

- Claude Code stdin: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`.
- Codex stdin: same common shape (`session_id, transcript_path, cwd, hook_event_name, model, permission_mode, turn_id`) — event name via stdin JSON, NO env var; hooks enabled by default; exit 2 + stderr = block; PreToolUse out `permissionDecision: deny|allow` + `updatedInput`; timeout default 600s (SessionEnd 1-3s).
- Antigravity stdin is **camelCase** (`conversationId`, `transcriptPath`, `modelName`); PreToolUse out `decision` supports `allow|deny|ask|force_ask|deny_unless_prior_grant`; PostInvocation out supports `injectSteps` + `terminationBehavior`.
- OpenCode hooks are in-process TS: `tool.execute.before` mutates `output.args` (throw to block); `chat.message` receives message object; `permission.ask` mutates status. The shim maps these to the canonical runner protocol and back.

## Feature gating

Canonical events with no native equivalent are dropped per-adapter at emit time (e.g. Antigravity lacks SessionStart → fold into PreInvocation). Codex hooks are on by default (no config change needed); Codex plugin bundles get hooks auto-registered from `hooks/hooks.json` in plugin root; plugin hook processes receive `PLUGIN_ROOT`/`PLUGIN_DATA` AND `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` — so a single runner can locate its plugin dir on both Claude and Codex via the same env var. OpenCode has no command-hook surface at all — the TS shim bridges by spawning the runner for mapped hook types (v1) or via skill/command artifacts only (v2-safe).
