# Changelog

All notable changes to AnyPlugin are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **Ponytail patterns (evidence-based adoption, `docs/PATTERNS.md`)**: manifest `ladder[]` + `intensity{}` (schema + JSON Schema, sync-tested); instruction-tier fallback — `install --tier instruction` injects the plugin contract as a marked, journaled `AGENTS.md` section (byte-exact uninstall, conflict-abort); runtime mode flag `.anyplugin-mode` + `anyplugin intensity --mode conservative|balanced|aggressive`, read by the runner as `payload.intensityMode`. The transactional journal is unchanged and remains the install/uninstall authority.
- **Capability negotiation matrix** (`core/src/capabilities/matrix.ts`, spec §2): four support states (`NATIVE`, `DEGRADED`, `UNSUPPORTED`, `UNKNOWN`); `buildAll` derives a manifest's required capabilities and gates every target — `UNSUPPORTED` and `UNKNOWN` are hard build errors (fail closed), `DEGRADED` emits the documented fallback plus a build warning. Kills silent capability drops (e.g. commands omitted on Codex/Antigravity now warn; OpenCode v2-with-hooks now fails loudly instead of shipping a broken v1 shim; `session-end` on Antigravity is a build error). Per-agent variant pinning via `buildAll({ variants })`.
- **Strict CLI contract** (`cli/src/strict-args.ts`): every command parses through one strict Zod schema — flags AND positionals; unknown flags, typo'd flags, flags meaningless for the command, and positional arguments on commands that take none are hard errors with field-level messages. `bin.ts` no longer parses raw argv. (zod becomes a direct dependency of the CLI package; it was already in the graph via core.)
- **SafePath boundary** (`core/src/fs/safe-path.ts`, spec `CORE-INVARIANTS-V2.md` §1.1): the single way untrusted input becomes a filesystem path — lexical rejection (traversal, absolute/UNC/drive forms, NUL, oversized segments) plus two-sided realpath containment, throwing `SecurityError` with no partial action. Verified by a deterministic 10,000-input hostile corpus (zero escapes) and a real symlink/junction escape test. Installer plan paths, manifest path fields, and the MCP server's bundle resolution all flow through it (the MCP runtime carries an inline mirror because it ships dependency-free); the old scattered regex locks were deleted.
- **Transactional install journal** — every config edit records pre-install backup, pre/post SHA-256 hashes, and owned keys in `.anyplugin-state.json` inside the installed plugin root. `uninstall` restores exact pre-install bytes and **aborts with a descriptive error instead of overwriting** when a config was modified after install; `uninstall --dry-run` reports conflicts without touching anything. Reinstall→uninstall cycles never resurrect stale marker blocks.
- `anyplugin init --name NAME [--dir DIR]` — scaffold a new canonical plugin from `templates/starter` (validated kebab-case name, refuses existing targets).
- `--json` machine-readable output for every CLI command (detect, build, install, uninstall, okf-validate, okf-reindex, init).
- `uninstall --dry-run` — report what would be cleaned without touching anything; dry runs build bundles into a throwaway temp dir (never the plugin directory).
- `anyplugin.plugin.schema.json` — JSON Schema (draft-07) for the canonical manifest, kept in sync with the Zod source of truth by `core/src/schema/schema-sync.test.ts`.
- `AGENTS.md` — repo map, source-of-truth table, hook runtime protocol, adapter recipe, and definition of done for AI coding agents.
- Runtime E2E tests: spawn the real `runner.js` (Claude/Codex/Antigravity translation, blocking exit 2, non-blocking failure, turn-stop heartbeat, hostile hook-id rejection) and `mcp-server.js` (initialize/tools/list/tools/call over stdio), plus CLI `--json` and field-level manifest error checks.
- Event-mapping drift guard: `core/src/events/event-mapping.test.ts` fails if `knowledge/adapters/event-mapping.md` lags `NATIVE_EVENT_MAP` (per-agent column precision).
- Community files: CONTRIBUTING.md (incl. the PR review loop), SECURITY.md, this changelog, pull request template, CODEOWNERS, dependabot config, issue templates.

### Fixed

- **Security**: the hook runner validates the hook id (`^[a-zA-Z0-9_-]+$`) before any module resolution — traversal ids like `../../etc/passwd` exit 1 immediately.
- **Data loss**: `stripBlock` now throws on a begin marker with no end marker instead of silently deleting everything after it; backup restores are byte-exact.
- `okf-validate`/`okf-reindex` read the positional from parsed argv — flags like `--json` no longer break the default-directory mode.
- Node 20.0–20.10 compatibility: `import.meta.dirname` replaced with `dirname(fileURLToPath(import.meta.url))`.
- `regenerateIndexes` now discovers subdirectories from the whole bundle (the `# Subdirectories` section previously never rendered) and writes an index for dirs containing only subdirectories.
- `uninstall` (legacy path) can no longer create config files or truncate unparseable ones to `{}`; `install` refuses to merge into unparseable JSON configs.
- **Fixed**: CI had never run green — `pnpm/action-setup` errored on duplicate pnpm versions (input + `packageManager` field), and pnpm 11.14 cannot run on the advertised Node 20 cell (requires ≥ 22.13). Matrix is now Ubuntu (Node 22 & 24) + Windows (Node 24), plus a dedicated Node 20 job that verifies the dependency-free hook runner and MCP server with plain `node`. Also: esbuild build-script allowance uses the real pnpm key (`onlyBuiltDependencies`), replacing a leftover placeholder.
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
