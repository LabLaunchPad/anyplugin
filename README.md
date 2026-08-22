# AnyPlugin

[![CI](https://github.com/LabLaunchPad/anyplugin/actions/workflows/ci.yml/badge.svg)](https://github.com/LabLaunchPad/anyplugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](package.json)

**AnyPlugin is the agent-agnostic plugin framework: write your plugin once, install it natively into every AI coding agent — Claude Code, OpenCode, Codex CLI, and Google Antigravity.**

> Every agent has plugin dev. AnyPlugin makes it agent-agnostic.

Each of the four major agents ships its own plugin system, manifest format, hook protocol, and config layout. Today you either pick one agent — shrinking your audience by 75% — or maintain four diverging codebases. AnyPlugin compiles **one canonical plugin** (`anyplugin.plugin.yaml` + skills + hooks + MCP + an OKF knowledge bundle) into each agent's **native** format, with fully reversible installs and a shared, vendor-neutral knowledge layer on top.

*By **Rahul Paul** on behalf of **[Lab LaunchPad](https://github.com/LabLaunchPad)** — MIT licensed.*

## Highlights

- **Write once, run in four agents** — one source compiles to a `.claude-plugin` bundle, an OpenCode TypeScript plugin + config, a `.codex-plugin` bundle with `config.toml` merge, and an Antigravity `.agents/` tree. [→ What each adapter emits](#what-each-adapter-emits)
- **One hook runtime everywhere** — every agent executes the identical `node runner.js <hook-id>` process; platform translation (blocking exit codes, permission decisions, context injection) is handled for you. [→ Canonical hooks](#the-canonical-manifest)
- **Reversible, whitelisted installs** — copied dirs are removed, TOML/AGENTS.md blocks stripped via markers, JSON merges key-reverted; destination paths come only from a fixed template whitelist. [→ Install safety](#install-safety)
- **Shared OKF v0.2 knowledge** — Google's Open Knowledge Format bundle with trust tiers, staleness, and provenance, readable by all four agents via skill + MCP tools. [→ Knowledge layer](#the-okf-v02-knowledge-layer)
- **Environment-adaptive** — runtime detection of agent, OS, shell, sandbox, and network gates what installs and what runs. [→ Detection](#platform-intelligence)
- **Zero-dependency emitted runtime** — the shipped hook runner and MCP server are self-contained; nothing extra to install inside any agent.
- **Built on verified platform intelligence** — every adapter decision is backed by a conformant OKF bundle of audited facts from the six official plugin sources. [→ `knowledge/`](knowledge/index.md)
- **Conformance-tested** — 53 tests: per-adapter conformance suites, install/uninstall reversibility, OKF validator dogfooded on this repo's own bundle.

## Install

```bash
git clone https://github.com/LabLaunchPad/anyplugin
cd anyplugin
pnpm install && pnpm build
```

Once published to npm (see [roadmap](#roadmap)), the one-liner will be `npx anyplugin@latest`.

## Quickstart

```bash
# What's on this machine?
npx anyplugin detect
# running agent : claude-code (authoritative) via CLAUDECODE=1
# installed     : claude-code, codex, opencode, antigravity

# Build the bundled knowledge plugin for all four agents
node cli/dist/bin.js build --plugin plugins/knowledge/plugin \
  --runner plugins/knowledge/runtime/runner.js \
  --mcp-runtime plugins/knowledge/runtime

# Install into every detected agent, then reverse cleanly
node cli/dist/bin.js install --plugin plugins/knowledge/plugin --project /path/to/repo
node cli/dist/bin.js uninstall --plugin plugins/knowledge/plugin --project /path/to/repo

# Validate an OKF knowledge bundle
node cli/dist/bin.js okf-validate knowledge
# 2 issue(s), 0 error(s) — bundle CONFORMANT with OKF v0.2
```

Claude Code users can skip building entirely — this repo is itself a plugin marketplace:

```
/plugin marketplace add LabLaunchPad/anyplugin
/plugin install anyplugin-knowledge@anyplugin
```

## Supported agents

| Agent | What AnyPlugin emits | Install target |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json`, skills, commands, agents, `hooks/hooks.json`, `.mcp.json` | `~/.claude/plugins/<name>` |
| OpenCode | `plugin.ts` (v1 hook shim), skills, commands, agents, `opencode.json` merge | `.opencode/plugins/<name>` |
| Codex CLI | `.codex-plugin/plugin.json`, skills, `hooks/hooks.json`, `[mcp_servers]` TOML, `AGENTS.md` pointer | `~/.codex/plugins/<name>` |
| Antigravity | `plugins/<name>/{plugin.json, skills, agents, hooks.json, mcp_config.json}` | `<project>/.agents/plugins/<name>` |

## The canonical manifest

One YAML is the entire per-agent surface:

```yaml
# anyplugin.plugin.yaml
name: my-plugin            # kebab-case
version: 1.0.0
description: What it does
skills: ["./skills/my-skill"]    # SKILL.md dirs (agentskills.io format)
commands: ["./commands/foo.md"]  # markdown commands
agents: ["./agents/bar.md"]      # subagents
hooks:
  - id: guard-bash
    event: before-tool-use       # canonical events
    handler: ./hooks/guard.mjs   # export async function run(payload)
    match: Bash
mcp:
  servers:
    my-server: { transport: stdio, command: node, args: ["{{PLUGIN_ROOT}}/mcp/server.js"] }
knowledge: ./knowledge           # OKF v0.2 bundle shipped with the plugin
```

Canonical events: `session-start` · `before-tool-use` · `after-tool-use` · `prompt-submit` · `turn-stop` · `session-end` · `permission-request`. Handlers run as one cross-platform process on every agent; Claude Code, Codex, and Antigravity call command hooks natively, and the OpenCode adapter ships a shim that spawns the same runner.

<details>
<summary><strong>What each adapter emits (full detail)</strong></summary>

| Agent | Artifacts | Notes |
| --- | --- | --- |
| Claude Code | manifest, `skills/`, `commands/`, `agents/`, `hooks/hooks.json` with `${CLAUDE_PLUGIN_ROOT}` | unknown manifest fields tolerated by Claude Code |
| OpenCode | `plugin.ts` v1 shim + v2-safe skills/commands/agents + `opencode.json` merge (`mcp` with argv-array commands, `skills[]` paths) | v2-safe because OpenCode's dev core dropped v1 hooks |
| Codex | `.codex-plugin/plugin.json` (`skills: ./skills/`), `hooks/hooks.json` (hooks on by default since ~0.147), `config.append.toml` `[mcp_servers]`, `AGENTS.md` pointer | Codex injects `CLAUDE_PLUGIN_ROOT` for plugin hooks — same runner works unchanged |
| Antigravity | `plugin.json`, skills, agents, `hooks.json` (≤30s timeouts, camelCase JSON), `mcp_config.json` (`serverUrl` for HTTP), knowledge | `.agents/` file layout is the IDE surface; SDK is code-only |

</details>

## The OKF v0.2 knowledge layer

The first-party plugin gives every agent the same project knowledge:

- **`okf-reader` skill** — progressive disclosure: read `index.md`, then only relevant concepts; frontmatter trust signals (`status`, `stale_after`, `verified` tiers, `sources[]` provenance) tell the agent how much to trust each file.
- **Capture hooks** — `session-start` injects a bundle pointer into the session; `turn-stop` maintains a `log.md` heartbeat.
- **Curator subagent** — bulk capture and cleanup with strict OKF authoring rules.
- **MCP server** — `okf_index` / `okf_read` / `okf_search`, dependency-free stdio JSON-RPC.
- **Validator** — implements the official conformance matrix (MUST-fail / MUST-warn / MUST-tolerate, unknown keys preserved on round-trip); this repo's own bundle is validated in CI.

## Platform intelligence

Adapter behavior is grounded in audited facts (Aug 2026) from `anthropics/claude-plugins-official`, `openai/codex`, `anomalyco/opencode`, the Antigravity SDK, `GoogleCloudPlatform/open-knowledge-format`, and `openai/skills` — all captured with provenance in [`knowledge/`](knowledge/index.md). Load-bearing findings: all four agents converged on SKILL.md + MCP + JSON command hooks + AGENTS.md; Codex hooks are on by default and Claude-plugin-compatible; OpenCode has no runtime marker and its v2 core dropped v1 hooks; Antigravity's IDE consumes `.agents/` files with a 5-event camelCase hook protocol.

## Install safety

Install plans are pure data: destinations come from a fixed whitelist of path templates plus validated name segments — never token substitution into paths. Config edits are marker-delimited (`# BEGIN anyplugin:<plugin>` / HTML comments) and `uninstall` fully reverses them. Hook failures always exit non-blocking so a plugin can never break your agent mid-session.

## Repository layout

```
core/        @lablaunchpad/core — detection, canonical schema, event mapping, OKF v0.2 library
adapters/    one pure emitter per agent (claude, opencode, codex, antigravity)
plugins/     first-party knowledge plugin (canonical source + self-contained runtime)
cli/         anyplugin — detect / build / install / uninstall / okf-validate / okf-reindex
knowledge/   this repo's own OKF bundle — the audited platform intelligence
templates/   starter template for new plugins
```

## Roadmap

- [ ] npm publish — `anyplugin` CLI + `@lablaunchpad/*` packages
- [ ] `anyplugin init` — scaffold a new plugin from `templates/starter`
- [ ] `anyplugin status` / `doctor` — installed-plugin report, agent trust diagnostics
- [ ] Toolkit plugins — git workflow, test orchestration as second-party examples
- [ ] Import path — convert an existing Claude Code plugin to the canonical manifest
- [ ] Codex marketplace emission, per-agent capability gating, HTTP-MCP auth fields
- [ ] Logo, demo GIF, docs site, i18n

## Contributing

Issues and PRs are welcome at [LabLaunchPad/anyplugin](https://github.com/LabLaunchPad/anyplugin). Development:

```bash
pnpm install && pnpm build && pnpm test
```

Windows note: with long repo paths, run tooling through a short junction with `NODE_PRESERVE_SYMLINKS=1` (esbuild quirk).

## License

[MIT](LICENSE) © 2026 Rahul Paul · [Lab LaunchPad](https://github.com/LabLaunchPad)
