# AGENTS.md — instructions for AI coding agents working in this repo

AnyPlugin compiles one canonical plugin manifest (`anyplugin.plugin.yaml`) into native plugin bundles for Claude Code, OpenCode, Codex CLI, and Antigravity. This file tells you where everything lives and how to verify your work.

## Commands (deterministic)

```bash
pnpm install --frozen-lockfile   # pnpm 11, Node >= 20
pnpm build                       # tsc -b across the workspace (ALSO the typecheck — there is no separate lint)
pnpm test                        # vitest run — 86 tests incl. runtime E2E (spawns runner.js, mcp-server.js, cli/dist/bin.js)
pnpm clean                       # remove all dist/ output
```

- Run `pnpm build` before `pnpm test`: the CLI E2E suite spawns `cli/dist/bin.js` (it skips silently if dist is missing, so a skip means "build first").
- On Windows with long repo paths, run tooling through a short junction with `NODE_PRESERVE_SYMLINKS=1`.
- CI (`.github/workflows/ci.yml`): Ubuntu (Node 20 & 24) + Windows (Node 24) — install, build, test, `okf-validate knowledge`, all-four-agents build smoke.

## Where the source of truth lives

| Contract | Location |
| --- | --- |
| Manifest schema (Zod, source of truth) | `core/src/schema/index.ts` — `AnyPluginManifestSchema` |
| Manifest JSON Schema (must stay in sync; guarded by `core/src/schema/schema-sync.test.ts`) | `anyplugin.plugin.schema.json` (repo root) |
| Canonical → native event mapping | `core/src/events/index.ts` — `NATIVE_EVENT_MAP` (docs mirror in `knowledge/adapters/event-mapping.md`, guarded by `core/src/events/event-mapping.test.ts`) |
| Adapter contract (EmitOptions, EmittedBundle, InstallPlan) | `core/src/adapters/index.ts` |
| Agent/environment detection | `core/src/detect/index.ts` |
| OKF v0.2 parse/serialize/validate | `core/src/okf/index.ts` |
| Installer (path whitelist, marker blocks, reversibility) | `cli/src/index.ts` |
| Install journal (transactional state, conflict detection) | `cli/src/journal.ts` |
| CLI entry (commands, flags, --json) | `cli/src/bin.ts` |
| Universal hook runner (self-contained) | `plugins/knowledge/runtime/runner.js` |
| MCP server (dependency-free stdio) | `plugins/knowledge/runtime/mcp-server.js` |

## Repo layout

```
core/       @lablaunchpad/core — schema, events, detect, okf, emit helpers, adapter contract
adapters/   @lablaunchpad/adapter-{claude,opencode,codex,antigravity} — pure emitters, no side effects
cli/        @lablaunchpad/cli — anyplugin binary: init/detect/build/install/uninstall/okf-validate/okf-reindex
plugins/    @lablaunchpad/plugin-knowledge — first-party plugin + runtime (runner.js, mcp-server.js)
knowledge/  this repo's own OKF v0.2 bundle (audited platform intelligence)
templates/  starter template used by `anyplugin init`
research/   audit working area (clones of official repos)
```

## How to add an adapter (recipe)

1. Create `adapters/<agent>/` with `package.json` (`@lablaunchpad/adapter-<agent>`, dep on `@lablaunchpad/core`) and `src/index.ts` exporting `emit<Agent>(plugin: ParsedPlugin, opts: EmitOptions): Promise<EmittedBundle>`.
2. Adapters are PURE: render files into `opts.outDir` via `core/src/emit` helpers; return the `install.actions` plan. Never touch the user's home/project dirs — the CLI executes plans.
3. Register the agent in `core/src/detect/index.ts` (`ALL_AGENTS`, detection fingerprint) and `core/src/events/index.ts` (`NATIVE_EVENT_MAP`).
4. Wire it into `buildAll` in `cli/src/index.ts` and the CLI `--agents` list.
5. Add a conformance test next to the adapter (copy `adapters/claude/src/claude.test.ts` shape) and document the mapping in `knowledge/adapters/event-mapping.md` (the drift test will fail if you forget).

## Hook runtime protocol (what every agent executes)

- Command: `node runner.js <hook-id>`; platform JSON arrives on stdin (snake_case for Claude/Codex, camelCase for Antigravity).
- Handler resolution order: `./handlers/<id>.mjs` next to the runner → `../plugin/hooks/<id>.mjs` → `$PLUGIN_ROOT/hooks/<id>.mjs`. Handler files MUST be named `<hook-id>.mjs` and export `async function run(payload)`.
- Handler returns `HookResult`: `{ block?, reason?, additionalContext?, permissionDecision?, systemMessage?, raw? }`.
- Output translation: `additionalContext` → `hookSpecificOutput.additionalContext` (Claude/Codex/OpenCode) or `injectSteps` (Antigravity). `block` → `decision: "block"` + **exit code 2** (Antigravity: `decision: "deny"`, exit 0 semantics per its protocol).
- Handler or stdin failures are ALWAYS non-blocking (exit 0, stderr note) — a plugin must never break the host agent.
- Host detection: `ANYPLUGIN_HOST` self-marker → `CLAUDECODE` → `CODEX_SANDBOX/CODEX_CI` → `ANTIGRAVITY_AGENT`. Plugin root: `ANYPLUGIN_PLUGIN_ROOT` → `CLAUDE_PLUGIN_ROOT` → `PLUGIN_ROOT` → runner's parent.

## Installer safety rules (do not weaken)

- Destination paths come ONLY from the `TEMPLATES` whitelist in `cli/src/index.ts` plus validated segments (`validatePluginName`, `validateRelPath`, `validateSegment`). Never build paths by token substitution.
- Config edits are marker-delimited (`# BEGIN/END anyplugin:<name>` for TOML, `<!-- anyplugin:<name> begin/end -->` for markdown) and journaled in `.anyplugin-state.json` (pre-install backup + pre/post hashes + owned keys — see `cli/src/journal.ts`). Uninstall restores exact pre-install bytes and MUST abort with a descriptive error when a journaled file changed after install. Install refuses to merge into unparseable JSON; `stripBlock` throws on an unterminated marker block instead of deleting content. `{{PLUGIN_ROOT}}` substitution happens in VALUES only, never in paths.
- Any new install destination requires: a new TEMPLATES entry + tests proving uninstall fully reverses it (including the conflict-abort path).

## Conventions

- Package names: `@lablaunchpad/*`; binary/manifest/env names: `anyplugin*` (`anyplugin.plugin.yaml`, `ANYPLUGIN_HOST`). Never reintroduce the old "prism" naming.
- TypeScript strict; ESM everywhere (`"type": "module"`); no new runtime dependencies without strong justification (currently: yaml, zod, smol-toml).
- Tests live next to sources as `*.test.ts`. Anything a coding agent must rely on (schema, event map, installer reversibility, runtime protocol) has a drift/regression test — keep it that way.
- Knowledge files follow OKF v0.2 (`type`, `generated`, `verified`, `sources`); regenerate indexes with `node cli/dist/bin.js okf-reindex knowledge`.

## Definition of done for any change

1. `pnpm build` clean (tsc is the typecheck).
2. `pnpm test` — all green, including the E2E file (no silent skips).
3. If you touched the manifest schema → update `anyplugin.plugin.schema.json` (sync test enforces).
4. If you touched `NATIVE_EVENT_MAP` → update `knowledge/adapters/event-mapping.md` (drift test enforces).
5. If you added install targets → extend `templates/starter`/fixtures and prove reversibility.
