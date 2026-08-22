# AnyPlugin

[![CI](https://github.com/LabLaunchPad/anyplugin/actions/workflows/ci.yml/badge.svg)](https://github.com/LabLaunchPad/anyplugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green.svg)](./package.json)

**Write one plugin, install it natively into every AI coding agent — Claude Code, OpenCode, Codex CLI, and Google Antigravity.**

Each agent ships its own plugin system: different manifests, hook protocols, and config layouts. AnyPlugin compiles a single canonical plugin into each agent's **native** format, runs the same hook code everywhere, and installs and uninstalls cleanly.

```
anyplugin.plugin.yaml ──▶ adapters ──▶ 4 native bundles ──▶ install ──▶ fully reversible
   (skills · hooks ·         (claude ·     .claude-plugin/     marker-based
    agents · MCP ·           opencode ·    plugin.ts + json     config merges +
    OKF knowledge)           codex ·       config.toml ...      whitelisted paths
                             antigravity)
```

*By **Rahul Paul** on behalf of **[Lab LaunchPad](https://github.com/LabLaunchPad)** — MIT licensed.*

## Install

Requires Node ≥ 20 and pnpm 11. The CLI is not yet on npm (see [Roadmap](#roadmap)) — install from source:

```bash
git clone https://github.com/LabLaunchPad/anyplugin
cd anyplugin
pnpm install && pnpm build
```

All commands below run as `node cli/dist/bin.js <command>` from the repo root. Once published, this becomes `npx anyplugin@latest <command>`.

## Quickstart

```bash
# Scaffold your own plugin from the starter template
node cli/dist/bin.js init --name my-first-plugin
# scaffolded my-first-plugin → ./my-first-plugin (5 files)

# What am I running in, and what's installed on this machine?
node cli/dist/bin.js detect
# running agent : claude-code (authoritative) via CLAUDECODE=1
# installed     : claude-code, codex, opencode, antigravity

# Build any canonical plugin for all four agents
node cli/dist/bin.js build --plugin my-first-plugin \
  --runner plugins/knowledge/runtime/runner.js

# Preview an install without touching anything
node cli/dist/bin.js install --plugin my-first-plugin \
  --project /path/to/your/repo --dry-run

# Install into every agent's native location, then reverse it cleanly
node cli/dist/bin.js install --plugin my-first-plugin --project /path/to/your/repo
node cli/dist/bin.js uninstall --plugin my-first-plugin --project /path/to/your/repo

# Validate an OKF v0.2 knowledge bundle
node cli/dist/bin.js okf-validate knowledge
# ... bundle CONFORMANT with OKF v0.2
```

Every command also takes `--json` for machine-readable output (for scripts, CI, and coding agents).

Claude Code users can skip building entirely — this repo is itself a plugin marketplace:

```
/plugin marketplace add LabLaunchPad/anyplugin
/plugin install anyplugin-knowledge@anyplugin
```

## How it works

The lifecycle of a plugin, end to end:

1. **Manifest** — `anyplugin init --name my-plugin` scaffolds a starter, or you author one `anyplugin.plugin.yaml` declaring skills, commands, subagents, hooks, MCP servers, and an OKF knowledge directory. One file is the entire per-agent surface. A JSON Schema ([`anyplugin.plugin.schema.json`](anyplugin.plugin.schema.json), kept in sync with the Zod source by tests) enables editor validation.
2. **Adapters** — `build` compiles the manifest through four pure adapters, each emitting that agent's native artifacts (see table below). Translation of event names, config formats, and path tokens is handled here.
3. **Universal runtime** — every agent executes the identical `node runner.js <hook-id>` process with JSON on stdin. Handlers are named `<hook-id>.mjs` and export `run(payload)`; platform differences (blocking exit codes, context injection, permission decisions) are translated per agent.
4. **Detection** — the CLI and runtime detect the hosting agent from environment fingerprints (`ANYPLUGIN_HOST` self-marker, `CLAUDECODE`, `CODEX_SANDBOX`, `ANTIGRAVITY_AGENT`, `OPENCODE_*`), plus OS, shell, sandbox, and network status.
5. **Install / uninstall** — `install` copies each bundle to the agent's native location and merges config via marker-delimited blocks, recording a per-file state journal; `uninstall` restores the exact pre-install bytes and aborts (rather than overwrites) if a config changed after install. Both `install --dry-run` and `uninstall --dry-run` preview without writing.

### The canonical manifest

```yaml
# anyplugin.plugin.yaml
name: my-plugin                 # kebab-case (validated)
version: 0.1.0
description: What it does
skills: ["./skills/my-skill"]   # SKILL.md dirs (agentskills.io format)
commands: ["./commands/foo.md"] # markdown commands
agents: ["./agents/bar.md"]     # subagents
hooks:
  - id: guard-bash
    event: before-tool-use      # canonical event (below)
    handler: ./hooks/guard-bash.mjs   # must match the hook id
    match: Bash                 # optional tool-name matcher
mcp:
  servers:
    my-server:
      transport: stdio
      command: node
      args: ["{{PLUGIN_ROOT}}/mcp/server.js"]
knowledge: ./knowledge          # optional OKF v0.2 bundle
```

Canonical events: `session-start` · `before-tool-use` · `after-tool-use` · `prompt-submit` · `turn-stop` · `session-end` · `permission-request`. Claude Code, Codex, and Antigravity call command hooks natively; the OpenCode adapter ships a TypeScript shim that spawns the same runner.

A working example lives at [`plugins/knowledge/plugin/anyplugin.plugin.yaml`](plugins/knowledge/plugin/anyplugin.plugin.yaml); `anyplugin init` scaffolds a minimal starter from [`templates/starter/`](templates/starter/).

### Supported agents

| Agent | What AnyPlugin emits | Install target |
| --- | --- | --- |
| Claude Code | `.claude-plugin/plugin.json`, skills, commands, agents, `hooks/hooks.json`, `.mcp.json` | `~/.claude/plugins/<name>` |
| OpenCode | `plugin.ts` (v1 hook shim), skills, commands, agents, `opencode.json` merge | `<project>/.opencode/plugins/<name>` |
| Codex CLI | `.codex-plugin/plugin.json`, skills, `hooks/hooks.json`, `[mcp_servers]` TOML merge, `AGENTS.md` pointer | `~/.codex/plugins/<name>` |
| Antigravity | `plugins/<name>/{plugin.json, skills, agents, hooks.json, mcp_config.json}` | `<project>/.agents/plugins/<name>` |

<details>
<summary><strong>Adapter notes (audited Aug 2026)</strong></summary>

| Agent | Notes |
| --- | --- |
| Claude Code | 33 hook events; `${CLAUDE_PLUGIN_ROOT}` substituted for `{{PLUGIN_ROOT}}`; unknown manifest fields tolerated |
| OpenCode | v1 TS plugin API; skills also load via config `skills[]` paths (v2-safe, since the dev v2 core dropped v1 hooks); no runtime marker exists |
| Codex | hooks on by default since ~0.147 and Claude-plugin-compatible (`CLAUDE_PLUGIN_ROOT` injected); trust via `/hooks` |
| Antigravity | 5-event camelCase JSON protocol, ≤30s hook timeout; `.agents/` files are the IDE surface |

Full per-event mapping: [`knowledge/adapters/event-mapping.md`](knowledge/adapters/event-mapping.md) (source of truth in code: `core/src/events/index.ts`).

</details>

## The OKF v0.2 knowledge layer

The first-party plugin (`anyplugin-knowledge`) gives every agent the same project knowledge in Google's Open Knowledge Format:

- **`okf-reader` skill** — progressive disclosure: read `index.md`, then only relevant concepts; frontmatter trust signals (`status`, `stale_after`, `verified` tiers, `sources[]` provenance) tell the agent how much to trust each file.
- **Capture hooks** — `session-start` injects a bundle pointer into the session; `turn-stop` maintains a `log.md` heartbeat.
- **Curator subagent** — bulk capture and cleanup with strict OKF authoring rules.
- **MCP server** — `okf_index` / `okf_read` / `okf_search` tools over dependency-free stdio JSON-RPC.
- **Validator** — implements the official OKF conformance matrix (MUST-fail / warn / tolerate; unknown keys preserved on round-trip). This repo's own bundle is validated in CI.

Browse the bundle: [`knowledge/`](knowledge/index.md) — audited facts about all four agents' plugin systems, with provenance and trust tiers.

## Install safety

- Install plans are pure data: destination paths come from a fixed whitelist of path templates plus validated name segments — never token substitution into paths.
- Every config edit is **journaled** (`.anyplugin-state.json` inside the installed plugin root) with pre-install backups and SHA-256 hashes. `uninstall` restores the exact pre-install bytes — and if you edited a config after install, it **aborts with a descriptive error instead of overwriting your edits**.
- Config edits are marker-delimited (`# BEGIN anyplugin:<plugin>` / `# END anyplugin:<plugin>` in TOML, HTML comments in markdown) so they stay readable and diffable; install refuses to merge into unparseable JSON.
- `install --dry-run` and `uninstall --dry-run` preview every change without writing — dry runs build into a throwaway temp directory, never your plugin directory.
- Hook failures always exit non-blocking, so a plugin can't break your agent mid-session.

## Development

```bash
pnpm install --frozen-lockfile   # install (pnpm 11, Node >= 20)
pnpm build                       # tsc -b across the workspace
pnpm test                        # vitest run — 86 tests incl. runtime E2E
pnpm clean                       # remove all dist/ output
```

CI (`.github/workflows/ci.yml`) runs on Ubuntu (Node 20 & 24) and Windows (Node 24): install, build, tests (including E2E that spawns the real hook runner and MCP server), OKF conformance validation, and an all-four-agents build smoke.

Coding agents: [`AGENTS.md`](AGENTS.md) has the full repo map, source-of-truth table, hook runtime protocol, and the recipe for adding a new agent adapter.

### Repository map

| Path | Package | What lives there |
| --- | --- | --- |
| `core/src/schema/` | `@lablaunchpad/core` | canonical manifest Zod schema (`anyplugin.plugin.yaml`) |
| `core/src/events/` | `@lablaunchpad/core` | canonical → native event mapping (`NATIVE_EVENT_MAP`) |
| `core/src/detect/` | `@lablaunchpad/core` | agent/environment detection |
| `core/src/okf/` | `@lablaunchpad/core` | OKF v0.2 parse/serialize/validate library |
| `core/src/adapters/` | `@lablaunchpad/core` | adapter contract types (`EmitOptions`, `InstallPlan`) |
| `adapters/<agent>/src/` | `@lablaunchpad/adapter-*` | one pure emitter per agent |
| `cli/src/bin.ts` | `@lablaunchpad/cli` | CLI entry (detect/build/install/uninstall/okf-*) |
| `cli/src/index.ts` | `@lablaunchpad/cli` | build orchestration + safe installer/uninstaller |
| `plugins/knowledge/` | `@lablaunchpad/plugin-knowledge` | canonical plugin source + self-contained runtime (`runner.js`, `mcp-server.js`) |
| `knowledge/` | — | this repo's own OKF bundle (audited platform intelligence) |
| `templates/starter/` | — | minimal starter plugin |
| `research/` | — | audit working area |

Windows note: with long repo paths, run tooling through a short junction with `NODE_PRESERVE_SYMLINKS=1` (esbuild quirk).

## Roadmap

Planned — not yet implemented:

- [ ] npm publish — `anyplugin` CLI + `@lablaunchpad/*` packages
- [x] `anyplugin init` — scaffold a new plugin from `templates/starter`
- [ ] `anyplugin status` / `doctor` — installed-plugin report, agent trust diagnostics
- [ ] Toolkit plugins — git workflow, test orchestration as second-party examples
- [ ] Import path — convert an existing Claude Code plugin to the canonical manifest
- [ ] Codex marketplace emission, per-agent capability gating, HTTP-MCP auth fields
- [ ] Logo, demo GIF, docs site, i18n

## Contributing

Issues and PRs are welcome at [LabLaunchPad/anyplugin](https://github.com/LabLaunchPad/anyplugin). See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and PR expectations, and [AGENTS.md](AGENTS.md) for the full repo map (written for AI coding agents, useful for humans too).

## License

[MIT](LICENSE) © 2026 Rahul Paul · [Lab LaunchPad](https://github.com/LabLaunchPad)
