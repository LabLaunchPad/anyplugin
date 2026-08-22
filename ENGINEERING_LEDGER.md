# ENGINEERING_LEDGER.md

AnyPlugin defect-eradication ledger. Protocol: **VERIFY → FIX → ERADICATE THE CLASS → TEST → UPDATE LEDGER.**
Statuses: `[OPEN]` · `[INVESTIGATING]` · `[FIXED]` · `[FIXED & ERADICATED]` · `[SPEC'D — QUEUED PHASE 1]` · `[UNMAPPED]`.

> Evidence basis: this session's independent code review (PR #2 iteration 1), the audit-remediation pass
> (iteration 2), and the CI-runnability pass (iteration 3), all on branch `feat/agentability-fixes`.
> IDs without a mapped audit finding are marked `[UNMAPPED]` rather than invented; the founder should
> attach the source-audit definitions for those rows.

---

## Security (Layer 1: Trust)

### SEC-01 — Arbitrary file load via unvalidated hook id in the universal runner · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (commits `78994ec`, Phase-1 `feat: implement SafePath boundary`)
- **Root Cause Analysis**: `process.argv[2]` was interpolated into `import()` candidate paths without any validation; any string (including traversal sequences) reached module resolution.
- **Fix + Evidence**: hook ids locked to `^[a-zA-Z0-9_-]+$`; invalid ids exit 1 before any path use. E2E test feeds `../../etc/passwd`, `a/b`, `..\evil`, `hook id!` and asserts exit 1 + `invalid hook id` on stderr (CI `runtime-node-20` job re-verifies on a clean machine).
- **Systemic Guardrail (class eradication)**: (1) *identifier-vs-path separation* — free-text ids that become module paths satisfy a strict identifier regex, never string interpolation; (2) the shared **SafePath boundary** (`core/src/fs/safe-path.ts`, spec §1.1) is now the single way untrusted input becomes a path — lexical rejection (traversal/absolute/UNC/drive/NUL/length) + two-sided realpath containment + `SecurityError` with no partial action; proven by a deterministic 10,000-input hostile corpus test (zero escapes) and a real symlink/junction escape test. Consumers: installer plan paths, manifest path fields, MCP bundle resolution. Runner keeps the stricter identifier rule (it selects module names, not paths).

### SEC-02 — (definition pending from source audit) · Severity: TBD
- **Status**: `[UNMAPPED]`
- **Root Cause Analysis**: — (no finding text supplied; not invented).
- **Systemic Guardrail**: —
- **Note**: candidate adjacent area already hardened: installer destinations can only come from the `TEMPLATES` path whitelist + validated segments (`cli/src/index.ts`), never token substitution into paths.

---

## Bugs (correctness / data integrity)

### BUG-01 — Silent data loss in marker stripping (`stripBlock`) · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (commits `223af46`)
- **Root Cause Analysis**: a `begin` marker with a missing `end` marker returned `text.slice(0, b)` — silently deleting everything after the block.
- **Fix + Evidence**: `stripBlock` now throws `corrupted marker block: missing end marker … — refusing to strip`; unit test asserts the throw; install/uninstall propagate the error (no catch swallows it). Byte-exact journal restores make the pre-fix data-loss path unreachable anyway.
- **Systemic Guardrail**: *No Silent Failures* is now a test-enforced invariant — every destructive text transform either proves both markers present or throws; the transactional journal means destructive transforms are no longer the recovery mechanism.

### BUG-02 — `parseArgs` misuse: flags parsed as positionals · Severity: P1
- **Status**: `[FIXED & ERADICATED]` (commits `223af46`, `abe73e2`)
- **Root Cause Analysis**: code destructured only `{ values }` and read raw `argv` slices for positionals, so `okf-validate --json` treated `--json` as the bundle directory.
- **Fix + Evidence**: `positionals` from `parseArgs` used everywhere; E2E tests run `okf-validate --json` and `okf-validate --json knowledge` (flag before/without positional) against the built binary.
- **Systemic Guardrail**: Phase 1 Pattern C (`strict-args.ts`, Zod schema per command) will delete ad-hoc parsing entirely; until then the mixed-args E2E suite blocks regression of the class.

### BUG-03 — (definition pending from source audit) · Severity: TBD
- **Status**: `[UNMAPPED]`

### BUG-04 — `import.meta.dirname` unavailable on Node 20.0–20.10 · Severity: P1
- **Status**: `[FIXED & ERADICATED]` (commit `223af46`)
- **Root Cause Analysis**: `import.meta.dirname` landed in Node 20.11/21.2; engines promise `>=20`.
- **Fix + Evidence**: all source uses replaced with `dirname(fileURLToPath(import.meta.url))`; the CI `runtime-node-20` job executes the built artifacts on Node 20 as the standing guardrail.
- **Systemic Guardrail**: Node-20 runtime job in CI (structural: any future use of too-new APIs in the runtime surface fails a dedicated check, not just review).

### BUG-05 — (definition pending from source audit) · Severity: TBD
- **Status**: `[UNMAPPED]`

---

## Architectural Problems (AP)

### AP-001 — Irreversible, patch-based install/uninstall · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (commit `223af46`)
- **Root Cause Analysis**: uninstall re-derived intent from the emitted patch (key removal, marker strip) instead of recorded pre-state; it could create config files, truncate unparseable JSON to `{}`, and destroy user edits.
- **Fix + Evidence**: transactional journal `.anyplugin-state.json` per installed root — `{ pluginId, version, agent, files: [{ file, kind, preInstallHash, postInstallHash, backupContent, ownedKeys }] }`; uninstall is two-phase (classify all → apply only when clean), restores byte-exact pre-install content, deletes files the install created, and the legacy fallback is write-safe (missing → skip, unparseable → skip, write only on change). 6-test suite: conflict abort ×2, byte-exact restore, dry-run conflict report, reinstall cleanliness, unparseable-merge refusal.
- **Systemic Guardrail**: journal is the single recovery mechanism (destructive re-derivation deleted); conflict-abort + reversibility are mandatory test columns for any new installer destination (AGENTS.md rule, PR template checklist).

### AP-002 — Path traversal surface in installer paths · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (Phase-1 `feat: implement SafePath boundary`)
- **Root Cause Analysis**: install plans carry relative paths that become filesystem destinations.
- **Fix + Evidence**: destinations resolve ONLY through the `TEMPLATES` whitelist; every plan-relative source path and name segment now flows through the shared SafePath boundary (`assertSafeRelative` / `resolveAuthorizedPath`) — the local regex locks were **deleted, not duplicated**; copy sources additionally prove containment inside the emitted bundle directory via realpath.
- **Systemic Guardrail**: whitelist-first construction (paths never composed from untrusted text) + the single shared SafePath utility; the 10k hostile corpus and guard tests block the class wholesale.

### AP-003 — (definition pending) · Severity: TBD · **Status**: `[UNMAPPED]`

### AP-004 — OpenCode V2 breaks V1 hook shims · Severity: P1
- **Status**: `[SPEC'D — QUEUED PHASE 1]` (spec `CORE-INVARIANTS-V2.md` §2)
- **Root Cause Analysis**: OpenCode's v2 core dropped the v1 hook API; the adapter emits a v1 TS shim, so plugins silently degrade or break on v2 hosts.
- **Systemic Guardrail (planned)**: 4-state Capability Matrix (`NATIVE | DEGRADED | UNSUPPORTED | UNKNOWN`) with fail-closed `UNKNOWN` and hard build error on `UNSUPPORTED` unless the manifest explicitly accepts degradation. Conformance test must assert V2-native emission.

### AP-005 … AP-006 — (definitions pending) · **Status**: `[UNMAPPED]`

### AP-007 — Semantic loss in canonical event mapping · Severity: P1
- **Status**: `[PARTIALLY ERADICATED]` — documentation drift is `[FIXED & ERADICATED]` (commit `add2868`): the drift guard now checks each native name in the **correct per-agent table column** and requires dropped events to be documented as `—`. True semantic negotiation (which mapping is `DEGRADED` vs `NATIVE`) is `[SPEC'D — QUEUED PHASE 1]` via the Capability Matrix.

### AP-008 — MCP server resolves caller-supplied bundle paths without a boundary · Severity: P1
- **Status**: `[FIXED & ERADICATED]` (Phase-1 `feat: implement SafePath boundary`)
- **Root Cause Analysis**: `resolveBundle` accepted any existing directory from tool args/env/cwd without an authorization boundary.
- **Fix + Evidence**: the dependency-free runtime now carries an inline SafePath guard — a bundle is served only when its realpath equals or lies inside an authorized root (operator-configured `ANYPLUGIN_OKF_BUNDLE`, the plugin's own bundled knowledge, or the working directory). Outside paths are refused, not read.
- **Systemic Guardrail**: authorized-root containment as an inline mirror of `core/src/fs/safe-path.ts` (the runtime ships no workspace deps by design — the two implementations are tied by spec §1.1 and covered by the E2E MCP suite).

### AP-009 — Uninstall destroys user edits made after install · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (commit `223af46`) — see AP-001; the conflict path throws a descriptive abort listing offending files, preserves edits byte-exact, and `--dry-run` surfaces `CONFLICT:` lines without touching anything. (Supersedes the earlier reviewer finding that the json-merge dry-run had false negatives — that code path was replaced wholesale.)

### AP-010 … AP-016 — (definitions pending) · **Status**: `[UNMAPPED]`

---

## Additional classes fixed during the review loop (not in the supplied ID set)

- **CI had never run green** — duplicate pnpm version configuration; pnpm 11.14 incompatible with the advertised Node 20 cell. Fixed: matrix Ubuntu 22/24 + Windows 24 + dedicated `runtime-node-20` job (commits `abe73e2`, `6460c96`, `62e3add`). Guardrail: the green check itself (all 4 checks) + docs state the dev-vs-runtime Node contract.
- **Tests mutated the repo** — dogfood suite regenerated the committed knowledge bundle in place, clobbering the curated root index. Fixed on a temp copy with a survival assertion (commit `259e270`). Guardrail: test asserts the curated index is untouched every run.
- **`regenerateIndexes` never rendered `# Subdirectories`** and skipped dirs containing only subdirs. Fixed + nested-bundle test (commit `78994ec`).

## Phase-1 queue (executes only after founder approval of `CORE-INVARIANTS-V2.md`)

1. ~~`feat: implement SafePath boundary [SEC-01/AP-002/AP-008 eradicated]`~~ — **DONE**: `core/src/fs/safe-path.ts`, 10k-input hostile corpus + symlink-escape tests, runner/MCP/installer/manifest-path validation unified on it.
2. `feat: strict CLI contract [BUG-02 class eradicated]` — `cli/src/strict-args.ts`, per-command Zod schemas, delete raw parseArgs usage.
3. `feat: capability negotiation matrix [AP-004/AP-007 eradicated]` — `core/src/capabilities/matrix.ts`, OpenCode V2 rows with fail-closed UNKNOWN, UNSUPPORTED = build error. (V2-*native emission* stays `[OPEN]` — requires a dedicated OpenCode v2 plugin-API audit; the matrix already kills the silent-breakage class by failing builds loudly.)
