# Agent-Prism

**One plugin source → native installs for Claude Code, OpenCode, Codex CLI, and Google Antigravity — with an OKF v0.2 knowledge layer and runtime environment detection.**

Agent-Prism is a TypeScript monorepo that lets you author a plugin once (`prism.plugin.yaml` + skills + hooks + MCP + an OKF knowledge bundle) and compile it into each coding agent's *native* extension format: a `.claude-plugin` bundle, an OpenCode TypeScript plugin + `.opencode/` artifacts, a `.codex-plugin` bundle with `config.toml` merge, and an Antigravity `.agents/plugins/` tree.

The research that drove every adapter decision lives in this repo as a conformant OKF v0.2 bundle: [`knowledge/`](knowledge/index.md) — audited against the official plugin repositories (anthropics/claude-plugins-official, openai/codex, anomalyco/opencode, google-antigravity SDK, GoogleCloudPlatform/open-knowledge-format, openai/skills).

## Layout

```
core/                   @agent-prism/core — detection, canonical schema, event mapping,
                        OKF v0.2 parse/validate/regenerate library, emit helpers
adapters/<agent>/       one pure emitter per agent: render native bundle + install plan
plugins/knowledge/      first-party plugin: OKF knowledge layer
  plugin/               canonical source (also natively Claude-installable)
  runtime/              self-contained hook runner + dependency-free MCP server
cli/                    `prism` — detect / build / install / uninstall / okf-validate
knowledge/              this repo's own OKF v0.2 bundle (backward-engineering findings)
templates/starter/      canonical plugin template for `prism init`-style scaffolding
```

## Quick start

```bash
pnpm install && pnpm build && pnpm test

# what is installed on this machine?
npx prism detect

# build all four native bundles for the first-party knowledge plugin
npx prism build --plugin plugins/knowledge/plugin \
  --runner plugins/knowledge/runtime/runner.js \
  --mcp-runtime plugins/knowledge/runtime

# install into every detected agent (home + project locations), then reverse cleanly
npx prism install --plugin plugins/knowledge/plugin --project /path/to/repo
npx prism uninstall --plugin plugins/knowledge/plugin --project /path/to/repo

# OKF conformance
npx prism okf-validate knowledge      # → CONFORMANT with OKF v0.2
npx prism okf-reindex knowledge       # regenerate per-dir index.md files
```

Claude Code users can also add this repo directly as a marketplace (the canonical
plugin dir doubles as a native `.claude-plugin` bundle):

```
/plugin marketplace add <this-repo>
/plugin install agent-prism-knowledge@agent-prism
```

## The canonical manifest

```yaml
# prism.plugin.yaml
name: my-plugin                 # kebab-case
version: 1.0.0
description: What it does
skills: ["./skills/my-skill"]   # SKILL.md dirs (agentskills.io format)
commands: ["./commands/foo.md"] # markdown commands
agents: ["./agents/bar.md"]     # subagents (Claude-compatible frontmatter)
hooks:
  - id: guard-bash
    event: before-tool-use      # canonical events, see below
    handler: ./hooks/guard.mjs  # export async function run(payload)
    match: Bash                 # tool matcher
mcp:
  servers:
    my-server:
      transport: stdio
      command: node
      args: ["{{PLUGIN_ROOT}}/mcp/server.js"]
knowledge: ./knowledge          # OKF v0.2 bundle shipped with the plugin
```

Canonical hook events: `session-start`, `before-tool-use`, `after-tool-use`,
`prompt-submit`, `turn-stop`, `session-end`, `permission-request`. Handlers are
executed by ONE process — `node runner.js <hook-id>` reading platform JSON on
stdin — on every agent. Claude Code, Codex, and Antigravity call command hooks
natively; the OpenCode adapter ships a TypeScript shim that spawns the same
runner. Platform output translation (blocking exit codes, `hookSpecificOutput`,
`permissionDecision`, Antigravity `injectSteps`) lives in the runner and in
`@agent-prism/core`'s event layer.

## What each adapter emits

| Agent | Artifacts | Install target |
|---|---|---|
| Claude Code | `.claude-plugin/plugin.json`, `skills/`, `commands/`, `agents/`, `hooks/hooks.json` (`${CLAUDE_PLUGIN_ROOT}`), `.mcp.json` | `~/.claude/plugins/<name>` + `/plugin` enable |
| OpenCode | `plugin.ts` (v1 hook shim), `skills/`, `commands/`, `agent/`, `opencode.json` merge (mcp + v2 `skills[]` paths) | `.opencode/plugins/<name>` + project config |
| Codex | `.codex-plugin/plugin.json`, `skills/`, `hooks/hooks.json` (hooks on by default; `CLAUDE_PLUGIN_ROOT` injected for plugin hooks), `config.append.toml` `[mcp_servers]`, `AGENTS.md` pointer | `~/.codex/plugins/<name>` + `config.toml` merge |
| Antigravity | `plugins/<name>/{plugin.json, skills/, agents/, hooks.json (≤30s, camelCase), mcp_config.json (serverUrl for HTTP), knowledge/}` | `<project>/.agents/plugins/<name>` + `.agents/mcp_config.json` merge |

Install/uninstall is fully reversible: copied directories are removed, TOML/AGENTS.md
blocks are stripped via `agent-prism` markers, and JSON merges are key-reverted.
All installer paths are constructed from a fixed whitelist of destination
templates plus validated name segments (no token substitution into paths).

## OKF v0.2 knowledge layer

The first-party plugin gives every agent the same project knowledge:

- **Reader skill** (`okf-reader`) — progressive disclosure: read `index.md`, then only
  relevant concepts; trust frontmatter (`status`, `stale_after`, `verified` tiers,
  `sources[]` provenance) tells the agent how much to trust each file.
- **Capture hooks** — `session-start` injects a bundle pointer; `turn-stop` maintains
  a `log.md` heartbeat.
- **Curator subagent** — bulk capture/cleanup with strict OKF authoring rules.
- **MCP server** (`okf_index` / `okf_read` / `okf_search`) — dependency-free stdio
  JSON-RPC; works in all four agents.
- **Validator** — implements the official conformance matrix (MUST-fail on missing
  `type`/unparseable frontmatter; MUST-warn on malformed trust fields, legacy
  v0.1 constructs; MUST tolerate unknown types/keys — preserved on round-trip).
  This repo's own `knowledge/` bundle is validated in CI as a dogfood test.

## Platform intelligence (backward-engineered, 2026-08)

Key verified facts baked into the adapters (full detail + provenance in
[`knowledge/`](knowledge/index.md)):

- All four agents converged on **SKILL.md (agentskills.io)**, **MCP**, **JSON command
  hooks**, and **AGENTS.md** — the universal compile target.
- Claude Code: `CLAUDECODE=1` is the authoritative marker; 33 hook events; unknown
  manifest fields ignored (we exploit this for cross-metadata).
- Codex ~0.147: hooks **enabled by default**; plugin hook processes receive
  `CLAUDE_PLUGIN_ROOT`/`CLAUDE_PLUGIN_DATA` for Claude-plugin compat; AGENTS.md
  32 KiB cap is combined across files; `codex plugin marketplace add` CLI.
- OpenCode: **no runtime marker exists** (issue #34065) — detection via `OPENCODE_*`
  env/config fingerprints; the dev-branch v2 core no longer wires v1 hooks, so the
  adapter emits a v1 shim **and** v2-safe skills/config artifacts.
- Antigravity: `.agents/` file layout is the IDE surface (the Python SDK is
  code-only, no file config); 5 hook events with camelCase JSON; HTTP MCP must use
  `serverUrl`; hook timeouts capped at 30s.

## Development

```bash
pnpm build    # tsc -b (project references across all packages)
pnpm test     # vitest — unit + per-adapter conformance + install/uninstall reversibility
```

Note for Windows users with long repo paths: run tooling through a short junction
(e.g. `C:\apr`) with `NODE_PRESERVE_SYMLINKS=1` for esbuild-based tools.

## Status

Phases complete: scaffold, backward-engineering audits, core library, four adapters,
first-party OKF knowledge plugin, CLI, end-to-end smoke (live runner on Claude Code +
Antigravity payloads, MCP protocol round-trip, four-agent build/install/uninstall).
Roadmap: toolkit plugins (git workflow, test orchestration) as additional templates,
`prism init` scaffolding command, published packages.
