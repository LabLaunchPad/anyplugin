# Ponytail Patterns — adoption record (evidence-based)

Source: `DietrichGebert/ponytail` (MIT), verified against its repo and OpenCode's official docs on 2026-08-22.

| # | Pattern | Verdict | Evidence / rationale |
|---|---|---|---|
| 1 | Instruction-Tier Fallback | **ADOPTED** | ponytail ships instruction-only adapters (Cursor, Windsurf, Cline, Aider…). Implemented: `generateInstructionTier` (`core/src/tiers/`) + `install --tier instruction` — a marked `AGENTS.md` section via the SAME journal machinery (byte-exact restore, conflict-abort). |
| 2 | Cross-Agent Runtime Bridge | **ALREADY OWNED** | our `runner.js` is that bridge (hookSpecificOutput / injectSteps / permission translations, E2E-tested per platform). Not duplicated into core — the emitted runtime must stay dependency-free. |
| 3 | Simple State Flag | **ADOPTED (runtime only)** | `.anyplugin-mode` in the plugin root: runtime intensity state that travels with installs. It does NOT replace the transactional journal (install/uninstall rollback stays journaled) — two different concerns, both kept. |
| 4 | Behavioral Ladder | **ADOPTED** | `ladder: string[]` in the manifest (schema + JSON Schema + instruction tier render), "stop at the first rung that holds". |
| 5 | Intensity Levels | **ADOPTED** | `intensity: {conservative, balanced, aggressive}` manifest descriptions + `anyplugin intensity --mode X` CLI + runner exposes `payload.intensityMode`. |
| 6 | Benchmarking | **DEFERRED (honestly)** | ponytail's benchmarks run headless agents (n=4 medians, real API cost). A harness without real runs would fabricate numbers — deferred until a benchmark budget exists. No results claimed. |
| 7 | Single Source of Truth | **ALREADY OWNED** | SKILL.md skills are already the behavioral contract shipped to every agent. |

## OpenCode V2 (AP-004) — evidence outcome

Official plugin docs (verified 2026-08): the plugin API is hook-based (`tool.execute.before/after`, `session.created`, `session.idle`, `permission.asked`, `experimental.*`), **no v1/v2 split is documented**, and `experimental.chat.system.transform` does not exist anywhere in the official API. Actions taken from that evidence:

- `permission.ask` → **`permission.asked`** (docs name) across map, adapter shim, tests, knowledge docs.
- `prompt-submit` → **UNSUPPORTED** for OpenCode (fail-closed): the only prior mapping (`chat.message`) is undocumented; `message.*` events are post-hoc updates, not a prompt hook.
- The matrix keeps `opencode@v2` hooks UNSUPPORTED — not because v2 dropped hooks (unverifiable), but because no versioned API contract exists to target; `UNKNOWN`/unversioned fails closed per spec §2.2.
