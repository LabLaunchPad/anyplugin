# Changelog

All notable changes to AnyPlugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- `anyplugin init --name NAME [--dir DIR]` — scaffold a new canonical plugin from `templates/starter` (validated kebab-case name, refuses existing targets).
- `--json` machine-readable output for every CLI command (detect, build, install, uninstall, okf-validate, okf-reindex, init).
- `uninstall --dry-run` — report what would be cleaned without touching anything.
- `anyplugin.plugin.schema.json` — JSON Schema (draft-07) for the canonical manifest, kept in sync with the Zod source of truth by `core/src/schema/schema-sync.test.ts`.
- `AGENTS.md` — repo map, source-of-truth table, hook runtime protocol, adapter recipe, and definition of done for AI coding agents.
- Runtime E2E tests: spawn the real `runner.js` (Claude/Codex/Antigravity translation, blocking exit 2, non-blocking failure, turn-stop heartbeat) and `mcp-server.js` (initialize/tools/list/tools/call over stdio), plus CLI `--json` and field-level manifest error checks.
- Event-mapping drift guard: `core/src/events/event-mapping.test.ts` fails if `knowledge/adapters/event-mapping.md` lags `NATIVE_EVENT_MAP`.
- Community files: CONTRIBUTING.md, SECURITY.md, this changelog, CODEOWNERS, dependabot config, issue templates.

### Fixed

- Removed the last "prism" naming traces from source: schema error messages now say `anyplugin.plugin.{yaml,yml,json}`; exported schema types renamed `PrismPluginSchema`/`PrismPlugin`/`PrismPluginInput` → `AnyPluginManifestSchema`/`AnyPluginManifest`/`AnyPluginManifestInput`; stale comments updated in `core/src/adapters/index.ts` and `plugins/knowledge/runtime/mcp-server.js`.
- README quickstart previously showed `npx anyplugin` (unpublished) — now uses the real `node cli/dist/bin.js` path and marks npm distribution as planned.

## [0.1.1] — 2026-08-22

### Added

- Rebrand to AnyPlugin (Rahul Paul · Lab LaunchPad): `@lablaunchpad/*` packages, `anyplugin` binary/manifests/env vars, full purge of the previous project name.
- Four adapters (Claude Code, OpenCode, Codex CLI, Antigravity) emitting native bundles from one `anyplugin.plugin.yaml`.
- Universal hook runtime (`node runner.js <hook-id>` stdio JSON) with platform output translation and non-blocking failure semantics.
- Runtime agent/environment detection (`ANYPLUGIN_HOST` + fingerprints) and installed-agent discovery.
- Reversible, whitelisted installer with marker-based config merges (`install`/`uninstall`/`install --dry-run`).
- OKF v0.2 knowledge layer: validator (`okf-validate`), index regenerator (`okf-reindex`), first-party `anyplugin-knowledge` plugin (okf-reader skill, curator subagent, session hooks, dependency-free MCP server with `okf_index`/`okf_read`/`okf_search`).
- Claude Code marketplace descriptor (`.claude-plugin/marketplace.json`); CI on Ubuntu (Node 20/24) and Windows (Node 24).
