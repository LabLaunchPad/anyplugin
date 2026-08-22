# Agent-Prism — Agent-Agnostic Plugin Framework (codename, renameable)

Build ONE plugin source tree that compiles/installs into native plugin artifacts for **Claude Code, OpenCode, Codex CLI, and Google Antigravity**, with runtime environment detection (agent, OS, shell, sandbox) and a first-party **OKF v0.2 knowledge layer**. Strategy: adapter framework first (forward eng), official-repo audits second (backward eng, token-efficient), first-party knowledge plugin third, toolkit later — per your "all three, phased" choice.

Key research finding driving the design: all four agents have converged on isomorphic surfaces — **SKILL.md (agentskills.io standard)**, **MCP servers**, **JSON hooks with PreToolUse/PostToolUse/Stop events**, and **AGENTS.md**. Codex even injects `CLAUDE_PLUGIN_ROOT` for Claude-plugin compat. So the universal compile target is: *SKILL.md + command-hooks (stdio JSON) + MCP + markdown*.

---

## 1. Monorepo layout (created in current directory)

```
agent-prism/
├─ core/                    # @agent-prism/core (TypeScript)
│  ├─ src/detect/           # agent + environment detection
│  ├─ src/schema/           # canonical plugin model + Zod validation
│  ├─ src/events/           # canonical event mapping + hook runner protocol
│  └─ src/okf/              # OKF v0.2 read/write/validate/preserve library
├─ adapters/
│  ├─ claude/  opencode/  codex/  antigravity/    # each: emit + install + uninstall
├─ plugins/knowledge/       # first-party OKF knowledge plugin (skills, hooks, MCP)
├─ cli/                     # @agent-prism/cli — install/detect/status/uninstall/audit
├─ knowledge/               # repo's own OKF v0.2 bundle (dogfooded research KB)
│  ├─ index.md              # okf_version: "0.2", progressive-disclosure nav
│  ├─ log.md
│  ├─ agents/{claude-code,opencode,codex,antigravity}.md   # audit findings
│  ├─ formats/{skill-md,mcp,agents-md,okf-v02}.md
│  └─ references/           # mirrored doc excerpts with sources[] provenance
├─ research/
│  ├─ clones/               # shallow clones (gitignored)
│  └─ reports/              # audit outputs feeding knowledge/
└─ templates/               # `prism init` plugin template (prism.plugin.yaml)
```

## 2. Canonical plugin model (write-once source)

`prism.plugin.yaml` — universal manifest: `name, version, description, skills[], commands[], agents[] (subagents), hooks[] (canonical events), mcp.servers{}, knowledge: ./knowledge, capabilities{}`.

**Canonical event mapping** (handlers are always `node dist/hooks/runner.js <id>` — cross-platform stdio JSON; the only contract all four natively support):

| Canonical | Claude Code | OpenCode | Codex | Antigravity |
|---|---|---|---|---|
| session-start | SessionStart | event session.created | SessionStart | PreInvocation |
| before-tool-use | PreToolUse | tool.execute.before | PreToolUse | PreToolUse |
| after-tool-use | PostToolUse | tool.execute.after | PostToolUse | PostToolUse |
| prompt-submit | UserPromptSubmit | chat.message | UserPromptSubmit | PreInvocation |
| turn-stop | Stop/SessionEnd | event session.idle | Stop | Stop |
| permission | PermissionRequest | permission.ask | PermissionRequest | PreToolUse decision |

Adapter emitted artifacts: Claude → `.claude-plugin/plugin.json` + skills/commands/hooks.json/.mcp.json; OpenCode → `.opencode/plugin.ts` shim (spawns same stdio handlers) + commands/agents/skills + opencode.json merge; Codex → `.codex-plugin/plugin.json` + skills/ + hooks.json + config.toml merge (`[mcp_servers]`, `features.hooks=true`); Antigravity → `.agents/{skills,agents,rules,hooks.json,mcp_config.json}` + `plugins/<name>/plugin.json` + GEMINI.md pointer.

## 3. Detection matrix (core/detect)

- **Claude Code**: `CLAUDECODE=1`, `CLAUDE_CODE_SESSION_ID`; `~/.claude/`
- **OpenCode**: no official marker (verified: issue #34065 open) → `OPENCODE*` env vars, server on :4096, `~/.config/opencode/`, `opencode.json`/`.opencode/`; our plugin injects own marker via `shell.env` hook
- **Codex**: `CODEX_SANDBOX`, `CODEX_CI`; `~/.codex/config.toml`
- **Antigravity**: `ANTIGRAVITY_AGENT`; `VSCODE_PID` + `~/.gemini/`; `.agents/` dir
- Environment layer: OS (win32 first-class — Node runner, no bare bash), shell, sandbox mode, network, permission mode → `capabilities{}` gate which features install

## 4. OKF v0.2 knowledge layer

Implemented strictly per official `GoogleCloudPlatform/open-knowledge-format` SPEC.md: `type` required; recommended `title/description/resource/tags`; v0.2 `sources[]` (resource/id/author/usage_count/last_modified), `generated{by,at}`, `verified[] {by,at}` trust tiers, `status/stale_after`, `Attested Computation` concepts; reserved `index.md` (only `okf_version: "0.2"` frontmatter) + `log.md` (newest-first); unknown keys preserved on round-trip; consumers tolerate broken links/missing index. First-party plugin = validator CLI + reader SKILL.md (progressive disclosure) + capture hooks (session-end writes decisions to bundle + log.md) + MCP server (bundle search/read — works in all four agents).

## 5. Execution phases

**Phase 0 — Scaffold**: bun/pnpm workspace, TS strict, vitest; bootstrap `knowledge/` by converting the completed research (all 4 platforms + OKF + detection matrix) into initial OKF concepts with `sources[]` provenance.

**Phase 1 — Backward engineering (token-efficient)**: shallow-clone (`--depth 1`) into `research/clones/`: anthropics/claude-plugins-official, openai/codex (docs/ + sdk/), anomalyco/opencode (packages/plugin, packages/core, docs), google-antigravity/antigravity-sdk-python, GoogleCloudPlatform/open-knowledge-format, openai/skills. Each repo audited by a dedicated Explore subagent with a strict extraction template (manifest schemas, hook/event payload field lists, config keys, install mechanics) — returns structured findings only, never file dumps. Findings written as `knowledge/agents/*.md` concepts (status: draft → stable after doc cross-check) + raw official docs fetched to `references/`. Repos never re-read afterwards.

**Phase 2 — Forward engineering, core + adapters**: core (detect, schema, event runner, OKF lib) → 4 adapters with emit/install/uninstall → conformance tests validating emitted artifacts against official schemas (`opencode.ai/config.json`, Codex config-schema.json, plugin.json/marketplace.json shapes) + fixture hook-payload contract tests per platform.

**Phase 3 — First-party plugin + CLI**: knowledge plugin (validator, reader skill, capture hooks, MCP server); `prism install` (detect agents → emit → install into each agent's real paths on Windows) / `status` / `uninstall` / `update`; end-to-end smoke test against a sandbox project dir per agent.

**Phase 4 — Toolkit + polish**: starter toolkit plugin (git workflow, test orchestration) as second template proving the framework; `prism init` scaffolding; README + marketplace.json so the repo itself is Claude-Code-marketplace-installable.

## 6. Verification

Per-adapter conformance test suites (schema-validate every emitted file), hook round-trip contract tests with real payload fixtures per platform, OKF validator checked against the 4 official sample bundles from the OKF repo, and install/uninstall idempotency tests into temp HOME fixtures. Windows-native: all hook entry points are `node` invocations; no bash-only scripts.