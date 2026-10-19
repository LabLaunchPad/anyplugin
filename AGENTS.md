# AGENTS.md — instructions for AI coding agents working in this repo

AnyPlugin compiles one canonical plugin manifest (`anyplugin.plugin.yaml`) into native plugin bundles for Claude Code, OpenCode, Codex CLI, and Antigravity. This file tells you where everything lives and how to verify your work.

## Commands (deterministic)

```bash
pnpm install --frozen-lockfile   # pnpm 11, Node >= 20
pnpm build                       # tsc -b across the workspace (ALSO the typecheck — there is no separate lint)
pnpm test                        # vitest run - the whole workspace (including runtime E2E that spawns runner.js, mcp-server.js, cli/dist/bin.js). Run `pnpm test` for the count; never quote a number in prose, it goes stale.
pnpm clean                       # remove all dist/ output
```

- Run `pnpm build` before `pnpm test`: the CLI E2E suite spawns `cli/dist/bin.js` (it skips silently if dist is missing, so a skip means "build first").
- Single test file: `pnpm vitest run path/to/file.test.ts`; single test: add `-t "name"`.
- On Windows with long repo paths, run tooling through a short junction with `NODE_PRESERVE_SYMLINKS=1`.
- CI matrix: Ubuntu (Node 22 & 24) + Windows (Node 24) for the full suite, plus a Node 20 job exercising the dependency-free runner/MCP runtime from the built artifacts.
- `engines: node >=20` in root `package.json` — the runtime surface (`runner.js`, `mcp-server.js`) must run on Node 20.

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
| Install journal (transactional state, conflict detection, evidence + ledger, schema migration) | `cli/src/journal.ts` |
| Install transaction engine (staging → intent → backup → apply → verify → commit/rollback) | `cli/src/transaction.ts` |
| SafePath boundary (the ONLY way untrusted input becomes a path) | `core/src/fs/safe-path.ts` — spec `CORE-INVARIANTS-V2.md` §1.1 |
| CLI argument contract (the ONLY place argv is parsed) | `cli/src/strict-args.ts` — one strict Zod schema per command |
| Capability matrix (compatibility verdicts; adapters must never guess) | `core/src/capabilities/matrix.ts` — spec §2; UNKNOWN fails closed, UNSUPPORTED = build error |
| CLI entry (commands, flags, --json) | `cli/src/bin.ts` |
| Universal hook runner (self-contained) | `plugins/knowledge/runtime/runner.js` |
| Hook runtime policy (timeout + failure policy; written at build time) | `core/src/events/index.ts` (`renderHookPolicies`) → `hooks/policies.json` |
| MCP server (dependency-free stdio) | `plugins/knowledge/runtime/mcp-server.js` |
| Dependency-free YAML 1.2 core-schema parser (runtime) | `plugins/knowledge/runtime/yaml-lite.js` — must match the `yaml` package (differential test) |
| Event log durability levels (best-effort / process-crash / power-loss) | `packages/worker-runtime/src/log/event-log.ts` (`DurabilityLevel`) |
| Delegation failure taxonomy + circuit breaker (the wrapper's contract) | `packages/worker-runtime/src/telemetry/delegation.ts` |
| Backend registry (declarative, zod-strict, fail-closed on an unknown apiVersion) | `core/src/backends/index.ts` |
| Delegation wrapper (probe, route, safe spawn, telemetry) | `cli/src/delegate.ts` |
| Failure-mode catalogue (what goes wrong, and what the system does) | `docs/FAILURE-MODES.md` |
| Classified backlog (what is still open, and why) | `docs/BACKLOG.md` |
| Decision record (why each choice was made, and what was rejected) | `docs/DECISIONS.md` |
| Personas, intent, and the authority table | `docs/PERSONAS.md` |
| External-claim ledger (every outside fact, with its source and access date) | `docs/EVIDENCE.md` |
| The Agent/Worker SDK (a specification of intent, not this repo's scope) | `docs/agent-sdk/README.md` |
| Document-ownership guard (a document with no owner fails the build) | `core/src/boundaries/doc-ownership.test.ts` |
| Layer stack, dependency direction, "which doc owns what" | `ARCHITECTURE.md` |

## Repo layout

```
core/       @lablaunchpad/core — schema, events, detect, okf, emit helpers, adapter contract,
            capability matrix, tiers, backend registry. Depends on NO workspace package.
adapters/   @lablaunchpad/adapter-{claude,opencode,codex,antigravity} — pure emitters, no side effects
cli/        @lablaunchpad/cli — anyplugin binary: init/detect/build/install/uninstall/intensity/
            okf-validate/okf-reindex/doctor/backends/delegate/run
packages/   @lablaunchpad/worker-runtime — the deterministic kernel: contracts, canonical form,
            ownership, storage, event log, replay, state fold, delegation telemetry.
            Depends on `zod` and NOTHING else in the workspace — not even core.
plugins/    @lablaunchpad/plugin-knowledge — first-party plugin + runtime (runner.js, mcp-server.js,
            yaml-lite.js). The runtime ships NO dependencies: an emitted bundle must run on a
            machine that has Node and nothing else.
knowledge/  this repo's own OKF v0.2 bundle (audited platform intelligence)
templates/  starter template used by `anyplugin init`
docs/       architecture-adjacent docs (FAILURE-MODES.md, BACKLOG.md, ai-native/)
research/   audit working area (clones of official repos) — gitignored
```

**ARCHITECTURE.md owns the layer stack, the dependency direction, and the
"which document owns what" map.** Read it before this file; this file owns the
contracts, not the shape.

## How to add an adapter (recipe)

1. Create `adapters/<agent>/` with `package.json` (`@lablaunchpad/adapter-<agent>`, dep on `@lablaunchpad/core`) and `src/index.ts` exporting `emit<Agent>(plugin: ParsedPlugin, opts: EmitOptions): Promise<EmittedBundle>`.
2. Adapters are PURE: render files into `opts.outDir` via `core/src/emit` helpers; return the `install.actions` plan. Never touch the user's home/project dirs — the CLI executes plans.
3. Register the agent in `core/src/detect/index.ts` (`ALL_AGENTS`, detection fingerprint) and `core/src/events/index.ts` (`NATIVE_EVENT_MAP`).
4. Wire it into `buildAll` in `cli/src/index.ts` and the CLI `--agents` list.
5. Add a conformance test next to the adapter (copy `adapters/claude/src/claude.test.ts` shape) and document the mapping in `knowledge/adapters/event-mapping.md` (the drift test will fail if you forget).

## Hook runtime protocol (what every agent executes)

- Command: `node runner.js <hook-id>`; platform JSON arrives on stdin (snake_case for Claude/Codex, camelCase for Antigravity).
- **Batch mode**: `node runner.js --batch '<json>'` — runs multiple hooks in parallel child processes, returns combined JSON with per-hook results and summary.
- Handler resolution order: `./handlers/<id>.mjs` next to the runner → `../plugin/hooks/<id>.mjs` → `$PLUGIN_ROOT/hooks/<id>.mjs`. Handler files MUST be named `<hook-id>.mjs` and export `async function run(payload)`.
- **Context envelope**: payload includes `__envelope__` (host, cwd, pluginRoot, intensityMode, timestamp) and `RUNNER_CONTEXT` env var is set for child processes.
- Handler returns `HookResult`: `{ block?, reason?, additionalContext?, permissionDecision?, systemMessage?, raw? }`.
- Output translation: `additionalContext` → `hookSpecificOutput.additionalContext` (Claude/Codex/OpenCode) or `injectSteps` (Antigravity). `block` → `decision: "block"` + **exit code 2** (Antigravity: `decision: "deny"`, **exit 0** semantics per its protocol).
- **Failure policy**: manifest-declared `failurePolicy: "blocking"` flips handler-throw to exit 2 (host denied); default `non-blocking` exits 0 with stderr note — never breaks the host agent. Antigravity expresses a blocking failure as `decision: "deny"` with exit 0 (its protocol).
- **Runtime policy file**: the runner is dependency-free and never parses YAML, so the BUILD step writes each hook's `timeoutSec` / `failurePolicy` to `hooks/policies.json` in the bundle (`renderHookPolicies()` in `core/src/events/index.ts`). The runner resolves policy in this order: **payload override → `hooks/policies.json` → default** (non-blocking, no deadline). A malformed policy file is ignored, never fatal.
- **Timeout**: `timeoutSec` is a hard deadline. The runner calls `process.exit` when it fires, which tears down pending handler work — a bare `Promise.race` would leave the handler running and keep the process alive past its deadline.
- **`raw` field precedence**: explicitly set fields (`decision`, `systemMessage`, `additionalContext`, `permissionDecision`) win; `raw` is merged as fallback only for unset keys.
- Host detection: `ANYPLUGIN_HOST` self-marker → `CLAUDECODE` → `CODEX_SANDBOX/CODEX_CI` → `ANTIGRAVITY_AGENT`. Plugin root: `ANYPLUGIN_PLUGIN_ROOT` → `CLAUDE_PLUGIN_ROOT` → `PLUGIN_ROOT` → runner's parent.
- Runner exit codes: 0=success (or a non-blocking failure), 1=runner error, 2=blocked (non-Antigravity) or a blocking-policy failure, 4=invalid input. Code 3 is RESERVED for capability unknown / fail-closed and is not yet emitted; the batch summary counts it as an error.
- **YAML in the runtime**: the MCP server parses frontmatter with `plugins/knowledge/runtime/yaml-lite.js` — a YAML 1.2 core-schema parser with no dependencies. A differential test proves it produces identical results to the `yaml` package for every file of the real knowledge bundle. Do NOT "simplify" it back to a lenient line parser: that silently turns `tags: [a, b]` into a string and drops nested mappings.

## Delegation wrapper (how AnyPlugin fronts other runtimes)

`anyplugin backends list|probe` and `anyplugin delegate` make the CLI a front door to other
runtimes and tools. The contract lives in the kernel; the mechanism lives in the CLI.

- **Registry** (`core/src/backends/index.ts`): a declarative `anyplugin.backends.json`
  (`{ apiVersion: 1, backends: [...] }`). Unknown fields are REJECTED; an unknown
  `apiVersion` is refused WHOLE (never half-read). A capability a backend does not
  declare is `UNKNOWN`, and `UNKNOWN` fails closed — it is excluded from routing.
- **Safe spawn** (`cli/src/delegate.ts`): `spawn` with an argv array and `shell: false`.
  NEVER a shell. A deadline, an output cap, and an environment ALLOWLIST on every attempt.
- **Classification** (`classifyAttempt`): the exit code alone is NEVER the answer. A
  backend can exit 0 after a mid-stream failure, so the exit code is combined with a
  structured error envelope, the timeout signal, and the `committed` flag.
- **Fallback legality**: once output is COMMITTED to the host the chain is closed — another
  backend would splice two answers together and re-run what the first one already did.
- **Two fail-policy axes**: capability → fail CLOSED; health → fail OPEN. They are constants
  (`FAIL_POLICY`), not configuration.
- **Telemetry**: every attempt produces a `DELEGATION_*` event for the worker-runtime log.

The full taxonomy, and the correct behaviour per class, is in `docs/FAILURE-MODES.md`.

## Installer safety rules (do not weaken)

- Destination paths come ONLY from the `TEMPLATES` whitelist in `cli/src/index.ts` plus validated segments (`validatePluginName`, `validateRelPath`, `validateSegment`). Never build paths by token substitution.
- Config edits are marker-delimited (`# BEGIN/END anyplugin:<name>` for TOML, `<!-- anyplugin:<name> begin/end -->` for markdown) and journaled in `.anyplugin-state.json` (pre-install backup + pre/post hashes + owned keys — see `cli/src/journal.ts`). Uninstall restores exact pre-install bytes and MUST abort with a descriptive error when a journaled file changed after install. Install refuses to merge into unparseable JSON; `stripBlock` throws on an unterminated marker block instead of deleting content. `{{PLUGIN_ROOT}}` substitution happens in VALUES only, never in paths.
- Any new install destination requires: a new TEMPLATES entry + tests proving uninstall fully reverses it (including the conflict-abort path).
- Journal enhancements: `generateEvidence()` produces SHA-256 checksums; `appendLedger()` writes append-only `ledger.jsonl` for audit trail.
- **Transactional install (Finding E)**: `executeInstall` runs preflight → stage → intent → backup → apply → verify → commit. The staging + backup scratch space lives in `transactionWorkspaceRoot()` — a SIBLING of the installed root, never a child (the "root" copy destination IS the installed root, so staging inside it would make `copyDir` recurse into its own source). Any failure after staging triggers `restoreFromBackups()` so no partial install survives; the journal is written only after verification passes.
- **Journal schema versioning (Finding D)**: the journal carries `schemaVersion` (currently 1). `migrateJournal()` upgrades legacy journals on read; an unknown FUTURE version fails closed rather than being guessed at. `readJournal()` throws on a corrupt journal — it never falls back to legacy cleanup.

## Symlink containment (F-02/F-03)

- `core/src/emit/index.ts` `copyDir()` rejects symlinks whose resolved targets escape the source root (realpath containment check).
- `plugins/knowledge/runtime/mcp-server.js` `walkMd()` skips symlinks entirely — no external Markdown via symlinks exposed through MCP.

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

## Common test patterns

- E2E tests spawn real processes: `runNode([RUNNER, hookId], { input, env, cwd })` — see `plugins/knowledge/src/e2e.runtime.test.ts`.
- CLI E2E tests require `pnpm build` first (they spawn `cli/dist/bin.js`); they are in `plugins/knowledge/src/e2e.runtime.test.ts` under `describe.skipIf(!existsSync(DIST_BIN))`.
- Hook handler tests: write a temp `.mjs` under `handlers/`, copy `runner.js`, run with `env: { ANYPLUGIN_HOST: "claude-code" }`.
- MCP tests: send JSON-RPC 2.0 over stdin, parse responses from stdout lines.
- One flaky CPU test in `core/src/fs/safe-path.test.ts` uses `toBeGreaterThanOrEqual(0)` with Windows quantum comment — don't tighten.

## Outstanding Audit Findings (Intelligence Amplification Audit — 2026-10-19)

**Reference docs:** `CURRENT_STATE.md`, `ENGINEERING_LEDGER.md`, `CORE-INVARIANTS-V2.md`, `ROADMAP.md`

### P0 — Fix before trusting untrusted plugin inputs or destructive recovery

| ID | Finding | Location | Status |
|---|---|---|---|
| **A** | Hook ID under-validated: schema allows leading `_`/`0-9`, unlimited length. Audit suggests `^[a-z][a-z0-9-]{0,63}$`, uniqueness per manifest, allowlisted event/handler. | `core/src/schema/index.ts:26` (current: `^[a-zA-Z0-9_-]+$`) | **PARTIAL** — regex exists but not strict enough |
| **B** | Symlink escapes in source assets: `copyDir` rejects symlinks (F-02 fix ✅), but manifest path validation is lexical only. | `core/src/emit/index.ts:25-57`, `core/src/schema/index.ts:132-136` | **PARTIAL** — source copy protected, manifest paths not realpath-checked |
| **C** | Installer destination ownership: no pre-install classification of target (absent / same-install-ID / conflicting). Recursive delete on uninstall can remove unmanaged files. | `cli/src/index.ts` (`classifyDestination`, `executeInstall`, `executeUninstall`) | **FIXED** — ABSENT/OWNED/CONFLICTING classification, ULID installation-ID ownership proof, realpath containment, preflight before any mutation, safe uninstall removes only journal-tracked files. Tests: `cli/src/install-ownership-audit.test.ts` |
| **D** | Journal not fully validated: `readJournal` casts JSON without shape/identity check; missing vs corrupt conflated to `null`. | `cli/src/journal.ts` (`migrateJournal`, `readJournal`, `readCurrentWithError`) | **FIXED** — strict Zod schema, `schemaVersion` field, `migrateJournal()` upgrades legacy journals, future versions fail closed, ENOENT vs EACCES/EPERM distinguished. Tests: `cli/src/journal-validation-audit.test.ts`, `cli/src/journal-migration-audit.test.ts` |

### P1 — Reliability and behavioral correctness

| ID | Finding | Location | Status |
|---|---|---|---|
| **E** | Install mutations before journal write: `executeInstall` changes destinations, then writes journal — crash leaves partial install. | `cli/src/transaction.ts` (staging/backup/verify/rollback engine), `cli/src/index.ts` (`executeInstall`) | **FIXED** — transactional pipeline: preflight → stage → intent → backup → apply → verify → commit, with automatic rollback restoring every destination on any failure. Tests: `cli/src/install-transactional-audit.test.ts` |
| **F** | No universal timeout enforcement: `timeoutSec` in manifest but runner doesn't enforce deadline. | `plugins/knowledge/runtime/runner.js` (`runWithDeadline`, `resolvePolicy`), `core/src/events/index.ts` (`renderHookPolicies`) | **FIXED** — the build writes `hooks/policies.json` (the runner never parses YAML); the runner enforces a hard deadline via `process.exit`, and the payload can override it. Tests: `plugins/knowledge/runtime/runner-timeout-audit.test.ts` |
| **G** | Failure policy fail-open: runner exits 0 on handler throw; `failurePolicy: "blocking"` in schema (F-05 fix ✅) but runner doesn't read it. | `plugins/knowledge/runtime/runner.js` (`exitForFailure`) | **FIXED** — "blocking" exits 2 (Antigravity: `decision: "deny"`, exit 0); "non-blocking" keeps exit 0. Tests: `plugins/knowledge/runtime/runner-failure-policy-audit.test.ts` |
| **H** | OpenCode shim collapses multiple hooks per native event: `Object.fromEntries` drops all but last. | `adapters/opencode/src/index.ts` (`renderShim`) | **FIXED** — the map is now event → ORDERED LIST; the shim dispatches every hook and merges results (context concatenated, most restrictive permission decision wins, any block wins). Tests: `adapters/opencode/src/opencode-collapse-audit.test.ts` |
| **I** | MCP server lenient frontmatter parser; `walkMd` skips symlinks (F-03 ✅) but parser isn't canonical YAML. | `plugins/knowledge/runtime/yaml-lite.js`, `plugins/knowledge/runtime/mcp-server.js` (`parseMd`) | **FIXED** — a dependency-free YAML 1.2 core-schema parser; a differential test proves it produces IDENTICAL results to the `yaml` package for every file of the real knowledge bundle. Tests: `plugins/knowledge/runtime/yaml-lite.test.ts`, `plugins/knowledge/runtime/mcp-parser-audit.test.ts` |
| **J** | Worker Runtime replay O(n²) gap detection: `events.some()` in loop. | `packages/worker-runtime/src/log/replay.ts` (`findGaps`) | **FIXED** — single pass over the sorted events. Proven deterministically by a test that passes an array whose `some` throws. Tests: `packages/worker-runtime/src/log/replay-audit.test.ts` |
| **K** | Event log not crash-durable: no `fsync`, append hands bytes to OS only. | `packages/worker-runtime/src/log/event-log.ts` (`DurabilityLevel`) | **FIXED** — durability is an explicit, stated, per-open choice: `best-effort` (default, unchanged fast path), `process-crash` (fsync), `power-loss` (fsync + directory fsync). The frame format is identical at every level. Tests: `packages/worker-runtime/src/log/durability-audit.test.ts` |
| **L** | Single-writer lock stale recovery: no auto-break, no `doctor` diagnostic command. | `cli/src/bin.ts` (`runDoctor`), `packages/worker-runtime/src/log/event-log.ts` | **FIXED** — `anyplugin doctor` decides staleness by the HOLDER'S LIVENESS (pid probe), not by file age; `--fix` releases a stale lock but never an active or unverifiable one. The runtime still never auto-breaks. Tests: `cli/src/doctor-diagnostics.test.ts`, `packages/worker-runtime/src/log/stale-lock-audit.test.ts` |

### P2 — Specification quality and operational polish

- `version` regex in schema not end-anchored: `/^\d+\.\d+\.\d+/` accepts trailing garbage.
- MCP server schema allows inconsistent configs (HTTP without URL, stdio without command).
- Path length checks use JS string `.length` (UTF-16 code units), not UTF-8 bytes.
- Generated files/journals: direct write, not temp+flush+rename for atomicity.
- State docs (`CURRENT_STATE.md`) must distinguish implemented/tested/designed/absent — several "engines" are only schemas.

### Architecture boundaries to preserve (non-negotiable)

From `ROADMAP.md` and `CURRENT_STATE.md`:
- **Worker Runtime** (`packages/worker-runtime/`) must NOT import from `cli/`, `adapters/`, or `core/` (except `zod`). It is the deterministic kernel.
  - Its durability is an explicit, stated choice (`DurabilityLevel`): `best-effort` (default — the F10-measured fast path), `process-crash` (fsync), `power-loss` (fsync + directory fsync). The frame format is identical at every level, so the measurements still describe the code.
- **AnyPlugin** (`core/`, `adapters/`, `cli/`) is the distribution layer — never owns evidence, decisions, experience, dependency graph, invalidation, certificates, or authoritative worker state.
- **Hook runtime** (`plugins/knowledge/runtime/`) stays dependency-light, self-contained; executes one hook or serves OKF via MCP.
- **Dependencies point inward**: CLI/MCP/Adapters → Worker Runtime; never reverse.
- `packages/worker-runtime/` IS a workspace location: `pnpm-workspace.yaml` has the `packages/*` glob, the root `tsconfig.json` references it, and `core/src/boundaries/package-boundary.test.ts` guards the direction mechanically.

### Immediate next actions (from audit priority order)

1. ~~Write failing regression tests for each P0/P1 finding~~ — **DONE** for A, B, C, D, E, F, G, H, I, J, K, L.
2. ~~Stricter Hook ID regex~~ — **DONE** (A).
3. ~~Symlink containment for manifest paths~~ — **DONE** (B).
4. ~~Journal strict schema + corruption recovery~~ — **DONE** (D).
5. ~~Transactional install~~ — **DONE** (E): preflight → stage → intent → backup → apply → verify → commit, with rollback.
6. ~~Runner timeout enforcement~~ — **DONE** (F): `hooks/policies.json` is written at build time; the runner enforces the deadline.
7. ~~Runner failurePolicy~~ — **DONE** (G): "blocking" → exit 2 (Antigravity: `decision: "deny"`).
8. ~~OpenCode shim multi-hook~~ — **DONE** (H): event → ordered hook list, all dispatched, results merged.
9. ~~Replay gap detection~~ — **DONE** (J): single pass; proven by the `some`-throws test.
10. ~~Event log durability~~ — **DONE** (K): explicit `DurabilityLevel` per open.
11. ~~Stale lock diagnostic~~ — **DONE** (L): `anyplugin doctor [--json] [--fix]`.

**All P0 and P1 audit findings are now FIXED.** Remaining work is the P2 polish list below
plus a re-audit of the whole surface.

### P2 — remaining polish (from the audit)

- `version` regex in schema not end-anchored: `/^\d+\.\d+\.\d+/` accepts trailing garbage.
- MCP server schema allows inconsistent configs (HTTP without URL, stdio without command).
- Path length checks use JS string `.length` (UTF-16 code units), not UTF-8 bytes.
- Generated files/journals: direct write, not temp+flush+rename for atomicity.
- State docs (`CURRENT_STATE.md`) must distinguish implemented/tested/designed/absent.