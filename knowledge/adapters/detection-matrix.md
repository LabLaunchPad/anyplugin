---
type: Adapter Design
title: Agent and environment detection matrix
description: Runtime detection of which coding agent is executing plus environment capabilities (OS, shell, sandbox, network) — primary signals and confidence-ranked fallbacks.
tags: [detection, env-vars, environment, adapters]
status: stable
generated:
  by: anyplugin/design@0.1.1
  at: 2026-08-22T09:30:00+00:00
sources:
  - resource: https://code.claude.com/docs/en/env-vars
    id: "1"
    title: Claude Code env vars
  - resource: https://github.com/anomalyco/opencode/issues/34065
    id: "2"
    title: "OpenCode: no OPENCODE=1 marker (open issue)"
  - resource: https://learn.chatgpt.com/docs/config-file/environment-variables
    id: "3"
    title: Codex environment variables
---

# Detection matrix

## Primary signals (authoritative)

| Agent | Signal | Confidence |
|---|---|---|
| Claude Code | `CLAUDECODE=1` (all spawned processes) | authoritative |
| Codex | `CODEX_SANDBOX` non-empty; `CODEX_CI` | high |
| Antigravity | `ANTIGRAVITY_AGENT` | high (community-verified, not doc-verified) |

## Secondary signals (fingerprints)

- Claude Code: `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_PID`; `~/.claude/`
- OpenCode: **no marker exists** — v1: detect `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` / `OPENCODE_CONFIG_DIR` or any `OPENCODE_*` env override; v2 adds `OPENCODE_TERMINAL=1` for PTY sessions only (not bash children); server on `localhost:4096`; `~/.config/opencode/`, `opencode.json`, `.opencode/`. Our plugin injects `ANYPLUGIN_HOST=opencode` via the `shell.env` hook on released v1 builds so descendants self-identify.
- Codex: `CODEX_SANDBOX_NETWORK_DISABLED`, `CODEX_POWERSHELL_PAYLOAD` (win); `~/.codex/config.toml`
- Antigravity: `VSCODE_PID`/`TERM_PROGRAM=vscode` (fork markers) + `~/.gemini/` or workspace `.agents/`; `agy` on PATH

## Ordering

Evaluate in order claude → codex → antigravity → opencode (three have authoritative/high env markers; OpenCode is inference-based, checked last to avoid false positives). Precedence also set by the `ANYPLUGIN_HOST` self-marker when present.

## Environment capability layer

`detectEnvironment()` returns: os (win32 first-class), shell (COMSPEC/Git Bash/pwsh), sandbox (codex sandbox mode, claude permission_mode), network (`CODEX_SANDBOX_NETWORK_DISABLED`), cwd, git repo presence. Adapters use this to gate `capabilities{}` in the manifest (e.g. skip bash-only scripts on win32; skip MCP registration when no network).
