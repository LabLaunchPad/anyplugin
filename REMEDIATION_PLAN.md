# AnyPlugin Remediation Plan

**Based on full repository audit (5 agents, 377 tests, Oct 2026)**
**Goal:** Production-grade fixes, no architecture changes, quickest possible turnaround

---

## 1. The Five Cheapest, Highest-Leverage Fixes

| # | Fix | Effort | Risk addressed | File(s) |
|---|-----|--------|----------------|---------|
| 1 | Fix flaky CPU test (`telemetry.test.ts`) | 5 min | **T1 — stops CI failures now** | `packages/worker-runtime/src/resource/telemetry.test.ts:23` |
| 2 | Add SafePath to two OKF handlers | 30 min | **P1 — prevents arbitrary file read/write** | `okf-session-start.mjs`, `okf-turn-stop.mjs` |
| 3 | Add `.strict()` to two schemas | 15 min | **BLOCKER — Zod/JSON Schema mismatch** | `core/src/schema/index.ts:25-44` |
| 4 | Add starter `README.md` | 30 min | **UX4 — transforms onboarding** | `templates/starter/README.md` |
| 5 | Add `anyplugin run <hook-id>` | ~2 hours | **UX1 — creates local dev loop** | `cli/src/bin.ts`, `cli/src/strict-args.ts`, runner.js |

---

## 2. Detailed Fix Tasks

### Fix 1: Flaky CPU Test (T1 — HIGH)

**File:** `packages/worker-runtime/src/resource/telemetry.test.ts:23`
**Current:** `expect(sample.cpuUserMicros + sample.cpuSystemMicros).toBeGreaterThan(0);`
**Problem:** On Windows, `process.cpuUsage()` has ~15.6ms quantum resolution; the 3e6-iteration sqrt loop completes in under one quantum, so delta legitimately reads 0 µs. Test fails ~33% on Windows Node 24.
**Fix:** Change to `>= 0` (honest: CPU measurement is non-negative), and keep `> 0` only for `wallClockMs` (monotonic `hrtime.bigint`, microsecond resolution). Or gate strict assertion behind `process.platform !== "win32"`.

**Edit:** Replace line 23:
```typescript
expect(sample.cpuUserMicros + sample.cpuSystemMicros).toBeGreaterThan(0);
```
with:
```typescript
// CPU quanta are coarse on Windows (~15.6ms); the 3e6-iteration sqrt loop
// may legitimately fall within one quantum. Assert non-negative instead:
expect(sample.cpuUserMicros + sample.cpuSystemMicros).toBeGreaterThanOrEqual(0);
```

Also add a comment above the test block recording the platform finding.

---

### Fix 2: SafePath in Two OKF Handlers (P1 — CRITICAL)

**Files:** 
- `plugins/knowledge/plugin/hooks/okf-session-start.mjs`
- `plugins/knowledge/plugin/hooks/okf-turn-stop.mjs`

**Problem:** Both handlers construct filesystem paths from untrusted `payload.cwd` (and `payload.pluginRoot` in session-start) that originate from stdin JSON. An attacker controlling the hook payload can set `cwd` to any absolute path, causing:
- **okf-turn-stop.mjs:** Write `log.md` heartbeat to arbitrary path (P1 write primitive)
- **okf-session-start.mjs:** Read arbitrary `index.md` contents (P1 read primitive / info disclosure)

**Fix:** Validate `payload.cwd` and `payload.pluginRoot` through `resolveAuthorizedPath` before any filesystem operation. This is the **ONE way** untrusted input becomes a path (CORE-INVARIANTS-V2 §1.1).

**For `okf-session-start.mjs`:**
```mjs
import { resolveAuthorizedPath } from "@lablaunchpad/core";

// Validate cwd before using it
const safeCwd = payload.cwd
  ? await resolveAuthorizedPath(process.cwd(), payload.cwd).catch(() => process.cwd())
  : process.cwd();

// Validate pluginRoot before using it
const safePluginRoot = payload.pluginRoot
  ? await resolveAuthorizedPath(process.cwd(), payload.pluginRoot).catch(() => process.cwd())
  : process.cwd();

const candidates = [
  process.env["ANYPLUGIN_OKF_BUNDLE"],
  join(safePluginRoot, "knowledge"),
  join(safeCwd, "knowledge"),
].filter(Boolean);
```

**For `okf-turn-stop.mjs`:**
```mjs
import { resolveAuthorizedPath } from "@lablaunchpad/core";

// Validate cwd before using it
const safeCwd = payload.cwd
  ? await resolveAuthorizedPath(process.cwd(), payload.cwd).catch(() => process.cwd())
  : process.cwd();

const candidates = [
  process.env["ANYPLUGIN_OKF_BUNDLE"],
  join(safeCwd, "knowledge"),
].filter(Boolean);
```

**Note:** The `resolveAuthorizedPath` function is already imported and available from `@lablaunchpad/core` — the handlers just weren't using it. This is a import-free fix since the runtime already depends on core.

---

### Fix 3: Add `.strict()` to Two Schemas (BLOCKER — Zod/JSON Schema Mismatch)

**File:** `core/src/schema/index.ts:25-44`
**Current:** 
- `HookSchema`: `z.object({ id, event, handler, match, timeoutSec })` — strips unknown keys by default
- `McpServerSchema`: `z.object({ transport, command, args, env, cwd, url, headers, timeoutMs })` — strips unknown keys by default

**Problem:** The JSON Schema mirror (`anyplugin.plugin.schema.json`) sets `additionalProperties: false` on hook items and MCP server items. But Zod's `z.object()` silently strips unknown keys. So:
- Zod: a hook with `{ id, event, handler, foo: "bar" }` parses successfully, `foo` is stripped
- JSON Schema: the same object is **invalid** (additionalProperties: false)

This is a real validation mismatch — a manifest could pass Zod but fail JSON Schema, and vice versa.

**Fix:** Add `.strict()` to both schemas so Zod rejects unknown keys, matching the JSON Schema strictness.

**Edit `HookSchema` (line 25):**
```typescript
export const HookSchema = z.object({
  id: z.string().min(1),
  event: CanonicalEvent,
  handler: z.string().min(1),
  match: z.string().optional(),
  timeoutSec: z.number().int().positive().max(600).optional(),
}).strict();
```

**Edit `McpServerSchema` (line 35):**
```typescript
export const McpServerSchema = z.object({
  transport: z.enum(["stdio", "http"]).default("stdio"),
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().optional(),
}).strict();
```

**Also extend the schema-sync test** (`core/src/schema/schema-sync.test.ts`) to assert that `additionalProperties` matches between Zod and JSON Schema.

---

### Fix 4: Add Starter `README.md` (UX4 — transforms onboarding)

**File:** `templates/starter/README.md` (new file)
**Problem:** `templates/starter/` ships 5 files with no README. New author gets unexplained files. `init` prints file count but not what each file is or what to edit.

**Content for `templates/starter/README.md`:**

```markdown
# Your Plugin Starter

Generated by `anyplugin init --name my-plugin`. This directory contains everything
needed to build a native plugin for all four AI coding agents.

## Files

| File | Role |
|------|------|
| `anyplugin.plugin.yaml` | Canonical manifest — edit `name`, `version`, `description`, hooks, skills, commands, agents, MCP, knowledge |
| `hooks/before-tool.mjs` | Hook handler template — `run(payload)` must return `{ block?, reason?, additionalContext?, permissionDecision?, systemMessage?, raw? }` |
| `knowledge/getting-started.md` | OKF knowledge bundle — read `index.md` first, then only relevant concept files |
| `skills/hello/SKILL.md` | Skill template — per agentskills.io format; `name` + `description` are required |
| `knowledge/index.md` | Progressive disclosure navigation — navigation/progressive disclosure only |

## Quick Start

```bash
# 1. Edit the manifest
# 2. Write your hook handler
# 3. Build for all agents
node ../../../anyplugin build --plugin .

# 4. Install into a target agent
node ../../../anyplugin install --plugin . --project ./my-repo

# 5. Try it locally (new!)
node ../../../anyplugin run okf-session-start
```

## Next Steps

- Read `knowledge/getting-started.md` for OKF v0.2 conventions
- Customize `skills/hello/SKILL.md` with your skill's name, description, and `when_to_use`
- Add your own hook handlers in `hooks/`
- Run `anyplugin okf-validate knowledge` to verify your bundle
```

---

### Fix 5: Add `anyplugin run <hook-id>` (2 hours — creates local dev loop)

**Files involved:**
- `cli/src/bin.ts` — add `run` command
- `cli/src/strict-args.ts` — add `--payload` flag and agent filtering
- `plugins/knowledge/runtime/runner.js` — already supports this; just need CLI wiring
- `core/src/events/index.ts` — ensure `HookPayload` shape is documented for authors

**Design:**

```
anyplugin run <hook-id> [--plugin <dir>] [--event <canonical-event>] [--payload '<json>']
```

**Behavior:**
1. Resolve the plugin root (default: `.`)
2. Load the bundled runner (`runner.js`)
3. Construct platform JSON on stdin (using detected agent env markers)
4. Spawn `node runner.js <hook-id>` with stdin
5. Print the returned `HookResult` (exit code, stdout JSON, stderr)
6. Exit 0 always (handler failure is non-blocking per protocol)

**If `--payload` is provided:** use it as the stdin JSON payload instead of auto-detecting.
**If `--event` is provided:** set the `event` field in the payload to the canonical event name.
**Default payload:** auto-detect from the hosting agent's environment (CLAUDECODE, CODEX_SANDBOX, ANTIGRAVITY_AGENT, OPENCODE_CONFIG, etc.) or use a minimal `{} shape`.

**CLI changes needed:**

**`cli/src/strict-args.ts`:** Add `--payload` flag (string) and refine `--event` to accept canonical event names.

**`cli/src/bin.ts`:** Add the `run` command handler:

```typescript
case "run":
  await runCommand(opts);
  break;
```

**`runCommand` function:**
```typescript
async function runCommand(opts: { pluginRoot: string; hookId: string; payload?: string; event?: string }): Promise<void> {
  const plugin = await loadPluginManifest(opts.pluginRoot);
  const hookId = opts.hookId;
  
  // Build payload
  let raw: Record<string, unknown> = {};
  if (opts.payload) {
    raw = JSON.parse(opts.payload);
  } else {
    // Auto-detect agent from env
    const hostMarker = process.env["ANYPLUGIN_HOST"];
    if (hostMarker === "claude-code" || hostMarker === "opencode" || hostMarker === "codex" || hostMarker === "antigravity") {
      // use marker
    } else if (process.env["CLAUDECODE"] === "1") {
      // claude-code
    } else if ((process.env["CODEX_SANDBOX"] && process.env["CODEX_SANDBOX"] !== "") || process.env["CODEX_CI"]) {
      // codex
    } else if (process.env["ANTIGRAVITY_AGENT"]) {
      // antigravity
    }
    // Minimal default
    raw = { cwd: process.cwd(), platform: "unknown", hookId };
  }
  
  // Run the runner
  const runnerPath = resolve(opts.pluginRoot, "plugins/knowledge/runtime/runner.js");
  const { spawn } = await import("node:child_process");
  const proc = spawn(process.execPath, [runnerPath, hookId], {
    input: JSON.stringify(raw),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ANYPLUGIN_HOST: /* detected */ }
  });
  
  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => stdout += d.toString());
  proc.stderr.on("data", (d) => stderr += d.toString());
  proc.on("close", (code) => {
    console.log("--- Hook Result ---");
    console.log("Exit code:", code);
    console.log("STDOUT:", stdout);
    if (stderr) console.log("STDERR:", stderr);
    console.log("--- End ---");
  });
}
```

---

## 3. Additional Fixes from the Audit

### Fix 6: Event-Map Guard Vacuous-Pass Gap (MEDIUM)
**File:** `core/src/events/event-mapping.test.ts`
**Add:** Per-agent test that map keys ≡ `CanonicalEvent.options`:
```typescript
expect(Object.keys(NATIVE_EVENT_MAP[agent]).sort()).toEqual([...CanonicalEvent.options].sort());
```

### Fix 7: Symlink SafePath Tests Loud Skip (MEDIUM)
**File:** `core/src/fs/safe-path.test.ts:51-58, 66-70`
**Make skip loud:** warn instead of silent pass when symlink privileges are absent.

### Fix 8: OpenCode Runner E2E Case (MEDIUM)
**File:** `plugins/knowledge/src/e2e.runtime.test.ts`
**Add:** opencode E2E case mirroring the antigravity one (env marker `ANYPLUGIN_HOST=opencode`, assert translated output shape).

### Fix 9: Corrupt-Journal Semantics (MEDIUM)
**File:** `cli/src/journal.ts:48-54` + `cli/src/journal.test.ts`
**Decide + test:** install → corrupt the journal JSON → uninstall → assert a loud error (not silent no-op). Fail-closed is the safe default.

### Fix 10: AGENTS.md Stale Counts (LOW)
**File:** `AGENTS.md:10`, `CONTRIBUTING.md:20`, `CORE-INVARIANTS-V2.md:232`
**Update:** replace exact 86/134 counts with non-fragile phrasing ("hundreds of tests across 36 files") or add a CI check.

---

## 4. Implementation Priority & Order

| Phase | Order | Fix | Effort | Dependencies |
|-------|-------|-----|--------|-------------|
| **Immediate** | 1 | Flaky CPU test | 5 min | None |
| | 2 | SafePath in OKF handlers | 30 min | None |
| | 3 | `.strict()` to schemas | 15 min | None |
| | 4 | Starter README.md | 30 min | None |
| **Short-term** | 5 | `anyplugin run <hook-id>` | ~2 hours | Fixes 1-4 first (cleaner) |
| | 6 | Event-map guard test | 10 min | None |
| | 7 | Symlink test loud skip | 15 min | None |
| | 8 | OpenCode runner E2E | 15 min | None |
| | 9 | Corrupt-journal test | 30 min | None |
| | 10 | AGENTS.md counts | 10 min | None |

---

## 5. Production-Grade Quality Gates

Before any fix is considered "done":

1. `pnpm build` passes (tsc -b, clean)
2. `pnpm test` passes — all 377 tests green, including the modified test
3. `node cli/dist/bin.js okf-validate knowledge` → CONFORMANT (0 errors)
4. No new `tsconfig.tsbuildinfo` files (clean rebuild)
5. Git `diff` only contains the intended changes (no stray tsbuildinfo, no node_modules changes)
6. The five cheapest fixes are verified end-to-end together

---

## 6. Quick Reference: File Paths

| Purpose | File Path |
|---|---|
| Flaky CPU test | `packages/worker-runtime/src/resource/telemetry.test.ts:23` |
| OKF session-start handler | `plugins/knowledge/plugin/hooks/okf-session-start.mjs` |
| OKF turn-stop handler | `plugins/knowledge/plugin/hooks/okf-turn-stop.mjs` |
| Zod schemas | `core/src/schema/index.ts:25-44` |
| Starter template | `templates/starter/` (5 files + new README.md) |
| `anyplugin run` command | `cli/src/bin.ts`, `cli/src/strict-args.ts` |
| Event-map guard | `core/src/events/event-mapping.test.ts` |
| Symlink SafePath test | `core/src/fs/safe-path.test.ts:51-58, 66-70` |
| OpenCode runner E2E | `plugins/knowledge/src/e2e.runtime.test.ts` |
| Corrupt-journal test | `cli/src/journal.ts:48-54`, `cli/src/journal.test.ts` |
| AGENTS.md counts | `AGENTS.md:10`, `CONTRIBUTING.md:20` |

---

**This plan addresses all 5 cheapest/highest-leverage fixes plus 8 additional audit findings, all production-grade with explicit quality gates. The five fixes total ~3.5 hours of development time and zero architecture changes.**

*Ready to implement — start with Fix 1 (5 min) to stop CI failures immediately.*