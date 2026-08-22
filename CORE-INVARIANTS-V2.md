# AnyPlugin Core Invariants & Minimal Manifest v2 Contract

**Design Specification — Phase 0 (Layer 1: Trust)**
Status: **DRAFT — awaiting founder approval. No implementation is authorized by this document.**
Scope owners: Rahul Paul · Lab LaunchPad. Ledger: `ENGINEERING_LEDGER.md`.

---

## 0. Context & Reading Guide

AnyPlugin's 3-layer architecture:

| Layer | Name | Contents | Status |
|---|---|---|---|
| 1 | **Trust** | SafePath boundary, transactional state, runtime failure policy, permissions | **this spec** |
| 2 | **Portability** | capability negotiation matrix, versioned adapters | §2 (spec'd here, built Phase 1) |
| 3 | **Ecosystem** | registry, simulator, marketplace | **out of scope — deliberately absent** |

This document formalizes what already partially exists (shipped on `feat/agentability-fixes`: hook-id lock, throwing marker strip, transactional journal, dry-run, strict arg parsing, CI matrix) and specifies the missing systemic guardrails (`resolveAuthorizedPath` utility, capability matrix, manifest v2 contract). It contains **no implementation code**; every mechanism is expressed as an invariant, a rule set, and a schema.

**Public API vs Internal State.** Everything a plugin author writes is *Public API* (the manifest, hook handler contract, CLI surface). Everything AnyPlugin manages alone is *Internal State* (journal file, capability matrix data, build report, runner protocol internals). §3.4 draws the line exactly; Internal State may change format at any minor release, Public API may not change semantically within a major.

---

## 1. Layer 1 — Trust Invariants

### 1.1 SafePath Invariant (`resolveAuthorizedPath`)

**Intent.** Any filesystem path derived from untrusted input (hook ids, manifest-declared `skills/commands/agents/hooks/knowledge` paths, MCP `bundle` arguments, install-plan relative paths) must be validated through exactly one function. There is no second way to resolve an untrusted path in the codebase.

**Signature (conceptual).** `resolveAuthorizedPath(authorizedRoot: string, untrustedInput: string) → string` — returns the resolved absolute path, or throws `SecurityError`.

**Input rejection rules (before any filesystem contact).** The untrusted input MUST be rejected if it:

1. is empty, longer than 4096 bytes, or contains a NUL byte;
2. is absolute (`/…`, `\…`, `\\?\…`, UNC `\\server\share`, drive letter `C:` in any position);
3. contains a `..` segment **after** lexical normalization (repeated separators and `.` segments are collapsed first, so `a/./b`, `a//b` are fine, `a/../b` is not);
4. contains backslashes on POSIX (path-separator smuggling);
5. contains a segment longer than 255 bytes or control characters.

**Resolution rules (after lexical acceptance).**

1. Lexically join `authorizedRoot + input` and normalize.
2. `realpath` BOTH the authorized root and the joined candidate (symlinks resolved on both sides — resolving only the candidate is the classic escape bug).
3. Containment: `candidate === realpath(root)` **or** `candidate.startsWith(realpath(root) + pathSeparator)`. On Windows the root comparison is case-insensitive; no case folding is applied to the remainder.
4. If `realpath` fails because the target does not exist, apply containment to the deepest existing ancestor and require the *lexical* remainder to contain no symlinks — i.e. a not-yet-existing path is admissible only inside an already-trusted directory.

**Failure mode.** Throw `SecurityError` with a message that names the rule violated and the authorized root, includes the offending input verbatim, and NEVER performs a partial action. No fallback, no best-effort, no logging-and-continuing. `SecurityError` is a distinct error type (not a generic `Error`) so callers cannot accidentally swallow it.

**Eradication rule.** `runner.js` (handler discovery), `cli/src/index.ts` (install-plan relative paths, plugin-name segments), `mcp-server.js` (`resolveBundle`), and manifest validation (`skills`, `commands`, `agents`, `hooks[].handler`, `knowledge`) are refactored to call this function — their local regex locks are then deleted, not duplicated. Hook ids additionally keep the identifier rule `^[a-zA-Z0-9_-]+$` (they select *module names*, not paths — the stricter class wins). A property-based test fires ≥10,000 generated hostile strings (traversals, absolute forms, symlink farms, unicode look-alikes, Windows/POSIX mixed separators) and asserts zero escapes.

### 1.2 Transactional State Invariant (the install journal)

**Intent.** Install/uninstall is a transaction with recorded pre-state. Recovery never re-derives intent from a patch; it replays recorded state. User edits always win over plugin cleanup.

**Journal location & name.** One file per (agent × plugin) install: `<installedRoot>/.anyplugin-state.json`. It is Internal State.

**Exact schema.**

```yaml
# .anyplugin-state.json  (Internal State, written by install, consumed by uninstall)
installId: 01J…            # ULID — one per install invocation, newest wins
pluginId: my-plugin        # manifest name (kebab-case, validated)
version: 0.2.0             # manifest version at install time
agent: opencode            # claude-code | opencode | codex | antigravity
files:                     # every CONFIG file touched (copies are tracked by root removal)
  - file: /abs/path/opencode.json
    kind: json-merge       # json-merge | marker-toml | marker-md
    beforeHash: sha256:…   # null ⇒ file did not exist before install
    afterHash: sha256:…    # content exactly as this install left it
    ownership:             # what AnyPlugin claims inside this file
      keys: [skills, mcp]  # json-merge: top-level keys owned
      markers: [anyplugin:my-plugin]  # marker kinds: begin/end block ids
    backup: |              # exact pre-install bytes; null ⇒ did not exist
      { "existing": true }
```

**Rules.**

1. **Before-write capture.** The pre-write content (or its absence) is captured BEFORE any mutation; `afterHash` is computed from a read-back after the write. A journal entry without both hashes is invalid and must fail the install.
2. **Conflict detection (uninstall).** For each entry: current content hash `== afterHash` → *untouched*, restore `backup` (or delete the file if `backup` is null). Hash `== beforeHash` → *already restored* by the user, do nothing. Anything else → **`ConflictError`** naming every conflicted file, abort the WHOLE uninstall before any mutation (two-phase: classify all, then apply), and preserve the file byte-exact.
3. **Reinstall.** Re-installing over its own markers records the *stripped* file as the new before-state, so an install→install→uninstall cycle restores the original — stale markers can never resurrect.
4. **Write-safety.** Uninstall never creates a file, never truncates, never reformats an unchanged file. Install refuses to merge into unparseable JSON (loud failure) rather than replacing it with `{}`.
5. **Marker integrity.** Stripping a marker block requires both markers; an unterminated block throws (BUG-01 invariant: no silent deletion).

**What already exists vs this spec.** The shipped journal has `pluginId/version/agent/files[{file,kind,preInstallHash,postInstallHash,backupContent,ownedKeys}]` and full conflict-abort semantics. Delta to implement in Phase 1: add `installId` (ULID), rename hash/ownership fields to the schema above, split `kind` into the three explicit marker/merge kinds. Behavior deltas: none.

### 1.3 Runtime Failure Invariant (hook failure policy)

**Intent.** A failing hook must never break the host agent (availability), and must never be mistaken for a successful decision (truthfulness). These are separate channels.

**Default policy: `non-blocking` (unchanged from v1).**

| Outcome | Exit code | Stdout | Stderr (mandatory) |
|---|---|---|---|
| Handler returned a result | 0 (or 2 when `block: true`) | platform-translated JSON | — |
| Handler threw / returned garbage | **0** | empty | `anyplugin runner <hook-id> failed: <message>` |
| Protocol violation (invalid hook id, unreadable mandate) | **1** | empty | `anyplugin runner: <rule violated>` |

**Invariants.**

1. **Exit 0 means "host may proceed" — never "handler succeeded".** Success/failure of the handler itself is observable only on the stderr diagnostic channel, which is mandatory, greppable, and prefix-stable. A host or wrapper that needs certainty parses stderr presence, not the exit code.
2. **No false-positive blocking.** Only an explicit `block: true` decision may produce exit 2; every internal error path yields exit 0 (non-blocking) — a crashed hook can never accidentally deny a tool call.
3. **Optional strictness.** `runtime.failurePolicy: blocking` (manifest v2, §3) flips handler-throw to exit 2 with reason `hook failed` — for plugins whose contract is "fail closed" (guards, policy checks). Default stays non-blocking.
4. **Timeout is a failure, not a success.** Adapter-emitted hook timeouts (e.g. Antigravity ≤30s) count as handler failure under the active policy.

---

## 2. Layer 2 — Semantic Invariants (Capability Negotiation Matrix)

### 2.1 The four support states

| State | Meaning | Compiler behavior |
|---|---|---|
| `NATIVE` | Target agent (at the declared variant/version) executes the canonical capability with full semantics | emit normally |
| `DEGRADED` | Executable, but with documented semantic loss (e.g. event folds into another, no exit-2 blocking, camelCase translation) | emit the documented fallback **+ emit a build warning + record it in the build report** |
| `UNSUPPORTED` | No faithful representation exists on that target | **hard build error** — never emit broken/degraded-silent output |
| `UNKNOWN` | The matrix has no data for (agent, variant, capability) | **fail closed: treated as `UNSUPPORTED`** — hard build error with a distinct message ("pin the target variant or extend the matrix") |

### 2.2 The two non-negotiable rules

1. **UNKNOWN fails closed.** It is illegal for the compiler to map `UNKNOWN` to any emitting behavior. There is no "assume supported" path. This kills the entire class of silent-portability bugs (AP-004/AP-007).
2. **UNSUPPORTED is a build error, not a runtime surprise.** If a plugin requires a capability the target marks `UNSUPPORTED`, `anyplugin build` fails for that target with the plugin's requirement and the offending capability named. The plugin author decides at build time: drop the requirement, drop the target, or accept `DEGRADED` where the matrix offers it.

### 2.3 Matrix data model (Internal State)

The matrix is authored data, keyed `(agent, variant, capability) → state + rationale + audit source`:

| Agent | Variant | Capability | State | Rationale (audit-backed) |
|---|---|---|---|---|
| opencode | v1 | `hooks.*` (in-process TS) | NATIVE via shim | v1 plugin API |
| opencode | v2 | `hooks.*` | **UNSUPPORTED** | v2 core dropped v1 hooks — V2-native emission required, no shim |
| antigravity | current | `hooks.session-end` | UNSUPPORTED | 5-event protocol, folds into PreInvocation (`DEGRADED` for `session-start`/`prompt-submit`) |
| claude-code | latest | `hooks.*` (7 canonical) | NATIVE | 33-event superset |
| codex | ≥0.147 | `hooks.*` | NATIVE | hooks on by default, Claude-plugin-compatible |

Capabilities are expressed as namespaced requirement strings (`hooks.session-end`, `mcp.stdio`, `mcp.http`, `skills`, `commands`, `agents.subagent`). Matrix rows MUST cite their OKF knowledge source — the drift-guard test family extends to this table.

**OpenCode V2 consequence (AP-004 eradication).** The OpenCode adapter gains variant detection and a V2 emission path (native module surface). The conformance test suite asserts V2-native output for a V2-declared target and asserts a hard error when a hooks-requiring plugin targets V2 without V2-native support for that hook. Emitting a V1 shim for a V2 target becomes an unrepresentable state.

---

## 3. Minimal Manifest v2 Contract

### 3.1 Design rule

v2 = **the v1 payload fields, unchanged** (`name`, `version`, `description`, `displayName`, `author`, `homepage`, `license`, `keywords`, `skills`, `commands`, `agents`, `hooks`, `mcp`, `knowledge`, free-form `extra` preserved) **plus exactly the fields below** — nothing more. No Layer-3 features. Every new field cites the invariant that justifies it.

### 3.2 New fields (complete list)

| Field | Category | Justifying invariant |
|---|---|---|
| `schemaVersion: 2` | Versioning | makes contract explicit; gates validation rules (absent ⇒ v1) |
| `targets[]` | Target Agents | §2 — capability negotiation needs a declared target set with variant pinning |
| `permissions[]` | Layer 1 Permissions | §1.1/§3 — install & runtime actions require declared, user-visible consent |
| `requires[]` | Layer 2 Capabilities | §2.2 — UNSUPPORTED/UNKNOWN must be decidable per plugin |
| `runtime.failurePolicy` | Layer 1 Runtime Policy | §1.3 — fail-open (default) vs fail-closed must be explicit when non-default |
| `runtime.hookTimeoutSec` | Layer 1 Runtime Policy | §1.3.4 — timeout is policy, clamped by per-agent ceilings (e.g. Antigravity 30) |

**Permissions vocabulary (closed set, four values):** `config-write` (journal-tracked config edits — §1.2), `process` (spawning the runner/MCP runtime — §1.3), `network` (MCP `http` transport), `decisions` (hook may block tools / answer permission requests — exit-2 semantics, §1.3.2). Undeclared permission ⇒ the corresponding manifest section is a **validation error** (e.g. `mcp.servers[*].transport: http` without `network`). The installer surfaces the permission list to the user before apply; `--dry-run` prints it under `REQUIRES PERMISSIONS:`.

### 3.3 Complete valid v2 manifest (example)

```yaml
# anyplugin.plugin.yaml — Manifest v2
schemaVersion: 2

# ── Identity (unchanged from v1) ─────────────────────────────
name: guard-kit
version: 1.2.0
description: Tool guards + shared project knowledge for every coding agent.
displayName: Guard Kit
author: { name: Rahul Paul, url: https://github.com/LabLaunchPad }
license: MIT
keywords: [guard, policy]

# ── Target agents (NEW — §2 capability negotiation) ──────────
targets:
  - agent: claude-code        # variant omitted ⇒ "latest", matrix-pinned
  - agent: opencode
    variant: v2               # pins the matrix rows consulted at build time
  - agent: codex              # ≥0.147 semantics
  - agent: antigravity

# ── Permissions (NEW — closed set, Layer 1) ──────────────────
permissions: [config-write, process, decisions]   # no `network`: stdio MCP only

# ── Capability requirements (NEW — §2.2) ─────────────────────
requires: [hooks.before-tool-use, hooks.permission-request, mcp.stdio, skills]

# ── Runtime policies (NEW — Layer 1) ─────────────────────────
runtime:
  failurePolicy: blocking     # guards must fail closed (§1.3.3); default: non-blocking
  hookTimeoutSec: 20          # clamped to agent ceilings (Antigravity ≤ 30)

# ── Payload (v1 fields, unchanged) ───────────────────────────
skills: ["./skills/policy-pack"]
commands: ["./commands/why-blocked.md"]
agents: ["./agents/policy-curator.md"]
hooks:
  - id: guard-bash
    event: before-tool-use
    handler: ./hooks/guard-bash.mjs   # SafePath-validated relative path (§1.1)
    match: Bash
mcp:
  servers:
    policy-index:
      transport: stdio
      command: node
      args: ["{{PLUGIN_ROOT}}/mcp/server.js"]
knowledge: ./knowledge
```

Build-time behavior of this example: targeting `opencode@v2` with `requires: [hooks.*]` is a **hard error** under today's matrix (V2 hooks UNSUPPORTED) until the V2-native path lands; targeting `antigravity` degrades `permission-request` → PreToolUse decision with a warning; `session-end` is not required, so its UNSUPPORTED state on Antigravity is irrelevant (requirements drive negotiation, not the full event list).

### 3.4 Public API vs Internal State

| Surface | Visibility | Stability |
|---|---|---|
| `anyplugin.plugin.yaml` (v1 + v2 fields) | **Public API** | semantic stability within a major |
| Hook handler contract (`run(payload) → HookResult`, §1.3 table) | **Public API** | additive only |
| CLI commands/flags (`--json`, `--dry-run`, …) | **Public API** | additive only |
| `.anyplugin-state.json` journal | Internal State | format may evolve; upgrades automatic |
| Capability matrix data + build report | Internal State | regenerated; cited to OKF sources |
| Runner protocol internals (stdin shapes, env markers, exit-code table) | Internal State, *documented* (AGENTS.md) | changes require matrix + knowledge updates |
| `ENGINEERING_LEDGER.md`, knowledge bundle | Internal State (repo) | — |

---

## 4. Migration Strategy (no test-suite breakage)

1. **Additive schema, version-gated.** `schemaVersion` absent ⇒ v1, validated exactly as today (all 86 tests keep passing untouched). Present ⇒ v2 rules apply (permissions coverage, requires/targets coherence).
2. **Matrix seeded before enforcement.** The matrix ships fully populated for all four current agents from the audited OKF bundle — at rollout no existing build path is `UNKNOWN`, so v1 plugins compile byte-identically. Fail-closed `UNKNOWN` only guards *future* agents/variants.
3. **Default targets = today's four agents.** Omitting `targets` in v1 mode preserves current behavior (build all four, warnings for known degradations). v2 mode requires explicit targets.
4. **Journal upgrade is mechanical.** Existing `.anyplugin-state.json` files gain `installId` and renamed fields on next install over the same plugin; an uninstall encountering a pre-v2 journal uses today's conflict logic unchanged (the legacy fallback already ships).
5. **Adapter transition, one at a time.** Phase 1 order: SafePath utility (pure refactor, zero behavior change) → strict-args wrapper → capability matrix with claude/codex/antigravity rows (no-ops for current output) → OpenCode V2 emission + conformance tests → manifest v2 validation. Each step is an atomic commit with its ledger row moved to `[FIXED & ERADICATED]` only when its eradication test lands.
6. **Escape hatch.** If any step regresses the suite, the step is reverted independently — no step depends on a later one.

---

## 5. Approval gate

Founder marks this document APPROVED (or amends sections). On approval, Phase 1 executes the queued commits exactly as listed in `ENGINEERING_LEDGER.md` §"Phase-1 queue", in TDD order (failing SafePath/ledger/matrix tests first). Until then: **no implementation from this document.**
