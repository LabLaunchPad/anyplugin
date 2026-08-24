# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

AnyPlugin compiles one canonical plugin manifest (`anyplugin.plugin.yaml`) into native plugin bundles for four AI coding agents: Claude Code, OpenCode, Codex CLI, and Antigravity. A pnpm workspace, TypeScript strict, ESM throughout.

**`AGENTS.md` is the primary reference for this repo** — repo map, source-of-truth table, hook runtime protocol, and the recipe for adding a new adapter. Read it before making non-trivial changes; this file only adds pointers and things not already there.

## Commands

```bash
pnpm install --frozen-lockfile   # pnpm 11 (needs Node >=22.13 to run itself)
pnpm build                       # tsc -b across the workspace — this IS the typecheck, no separate lint step
pnpm test                        # vitest run — includes runtime E2E (spawns runner.js, mcp-server.js, cli/dist/bin.js)
pnpm clean                       # remove all dist/ output
```

- **Always `pnpm build` before `pnpm test`.** The CLI E2E suite spawns `cli/dist/bin.js` and skips silently if `dist/` is missing — a skip means "you forgot to build."
- Single test file: `pnpm vitest run path/to/file.test.ts`; single test: add `-t "name"`.
- Windows with long repo paths: run tooling through a short junction with `NODE_PRESERVE_SYMLINKS=1`.
- CI matrix: Ubuntu (Node 22 & 24) + Windows (Node 24) for the full suite, plus a dedicated Node 20 job that exercises only the dependency-free runtime (`runner.js`, `mcp-server.js`) with plain `node` — that's the actual surface the `engines: node >=20` promise covers.

## Architecture

```
anyplugin.plugin.yaml ──▶ adapters ──▶ 4 native bundles ──▶ install ──▶ fully reversible
```

- **`core/src/schema/`** — canonical manifest Zod schema (`AnyPluginManifestSchema`). The JSON Schema mirror at repo root (`anyplugin.plugin.schema.json`) must stay in sync — a test enforces this.
- **`core/src/events/`** — canonical → native event mapping (`NATIVE_EVENT_MAP`). Canonical events: `session-start`, `before-tool-use`, `after-tool-use`, `prompt-submit`, `turn-stop`, `session-end`, `permission-request`. Docs mirror in `knowledge/adapters/event-mapping.md` is guarded by a drift test.
- **`core/src/detect/`** — agent/environment detection via env fingerprints (`ANYPLUGIN_HOST`, `CLAUDECODE`, `CODEX_SANDBOX`, `ANTIGRAVITY_AGENT`, `OPENCODE_*`).
- **`core/src/okf/`** — OKF v0.2 (Open Knowledge Format) parse/serialize/validate library.
- **`core/src/fs/safe-path.ts`** — the SINGLE way untrusted input becomes a filesystem path (`resolveAuthorizedPath`). Spec: `CORE-INVARIANTS-V2.md` §1.1. Never bypass this with ad hoc path joining/regex checks.
- **`adapters/<agent>/src/`** — one *pure* emitter per agent (`emit<Agent>(plugin, opts) → EmittedBundle`). No side effects, no touching the user's home/project dirs — they only render into `opts.outDir` and return an install plan; the CLI executes it.
- **`cli/src/bin.ts`** — CLI entry (`init`, `detect`, `build`, `install`, `uninstall`, `intensity`, `okf-validate`, `okf-reindex`).
- **`cli/src/strict-args.ts`** — the ONLY place argv is parsed; one strict Zod schema per command.
- **`cli/src/index.ts`** — build orchestration + installer (`TEMPLATES` path whitelist, marker-delimited config merges).
- **`cli/src/journal.ts`** — transactional install state (`.anyplugin-state.json`): pre-install backups, SHA-256 hashes, conflict detection so uninstall aborts rather than clobbers a user's post-install edits.
- **`plugins/knowledge/`** — first-party plugin source plus its self-contained runtime (`runner.js` hook runner, `mcp-server.js`), which every installed agent executes identically via `node runner.js <hook-id>` with JSON on stdin.
- **`knowledge/`** — this repo's own OKF bundle (audited facts about the four agents' plugin systems).
- **`templates/starter/`** — what `anyplugin init` scaffolds.

## Non-negotiable invariants (don't weaken without reading the spec)

- **SafePath**: any path derived from untrusted input (hook ids, manifest paths, MCP bundle args, install-plan relative paths) goes through `resolveAuthorizedPath` — never a second, ad hoc validation path. Hook ids additionally must match `^[a-zA-Z0-9_-]+$`.
- **Installer**: destination paths come ONLY from the `TEMPLATES` whitelist plus validated segments — never token substitution into paths. A new install destination requires a new TEMPLATES entry AND a test proving uninstall fully reverses it (including the conflict-abort path).
- **Runtime failures are always non-blocking**: a plugin hook or stdin failure must exit 0 with a stderr note — it must never break the host agent.
- Full detail: `CORE-INVARIANTS-V2.md` (design spec) and `ENGINEERING_LEDGER.md` (defect-eradication history, VERIFY → FIX → ERADICATE THE CLASS → TEST → UPDATE LEDGER).

## Conventions

- Package names: `@lablaunchpad/*`. Binary/manifest/env names: `anyplugin*`. Never reintroduce the old "prism" naming anywhere.
- No new runtime dependencies without strong justification (currently: `yaml`, `zod`, `smol-toml`).
- Tests live next to sources as `*.test.ts`. Anything a coding agent must rely on (schema, event map, installer reversibility, runtime protocol) needs a drift/regression test.

## Definition of done for any change

1. `pnpm build` clean.
2. `pnpm test` all green, no silently-skipped E2E.
3. Touched the manifest schema → update `anyplugin.plugin.schema.json` (sync test enforces).
4. Touched `NATIVE_EVENT_MAP` → update `knowledge/adapters/event-mapping.md` (drift test enforces).
5. Added install targets → extend `templates/starter`/fixtures and prove reversibility.
