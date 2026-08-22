# Contributing to AnyPlugin

Thanks for contributing! AnyPlugin is an agent-agnostic plugin framework: one canonical manifest compiled into native plugin bundles for Claude Code, OpenCode, Codex CLI, and Antigravity.

AI coding agents: read [`AGENTS.md`](AGENTS.md) first — it contains the repo map, source-of-truth table, and definition of done.

## Setup

- Node.js >= 20 and pnpm 11 (`corepack enable` or `npm i -g pnpm`)
- Windows with long paths: run tooling through a short junction with `NODE_PRESERVE_SYMLINKS=1`

```bash
git clone https://github.com/LabLaunchPad/anyplugin
cd anyplugin
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

`pnpm build` (tsc) is also the typecheck — there is no separate lint step. CI runs the same matrix on every PR: Ubuntu (Node 20 & 24) and Windows (Node 24).

## What we look for in PRs

1. `pnpm build` and `pnpm test` pass locally (75 tests, including runtime E2E that spawns the real runner and MCP server).
2. Schema changes update `anyplugin.plugin.schema.json` (a sync test enforces this).
3. Event-mapping changes update `knowledge/adapters/event-mapping.md` (a drift test enforces this).
4. New installer destinations are whitelisted templates with tests proving uninstall fully reverses them.
5. No new runtime dependencies without justification in the PR description.
6. Never reintroduce the old "prism" naming in code, docs, or identifiers.

## Adding a new agent adapter

See the recipe in [`AGENTS.md`](AGENTS.md#how-to-add-an-agent-recipe). The short version: adapters are pure emitters that render a native bundle and return an install plan; detection and event mapping live in core; the CLI executes plans.

## Reporting bugs / proposing features

Open an issue using the bug or feature template. For security issues, see [`SECURITY.md`](SECURITY.md) — do not open public issues for vulnerabilities.
