# Change Log

## 2026-08-22

- **Rename**: project rebranded from its internal codename to **AnyPlugin** (product) by **Rahul Paul** on behalf of **Lab LaunchPad** (org). Packages now `@lablaunchpad/*`, CLI binary `anyplugin`, manifest `anyplugin.plugin.yaml`, markers `anyplugin:<plugin>`, env `ANYPLUGIN_HOST`/`ANYPLUGIN_OKF_BUNDLE`. Repo: github.com/LabLaunchPad/anyplugin.
- **E2E verified**: AnyPlugin CLI built native bundles for all four agents from plugins/knowledge/plugin; hook runner verified live on Claude Code (additionalContext injection) and Antigravity (camelCase payload); MCP server answered initialize/tools/list/okf_index/okf_read over stdio JSON-RPC.
- Backward-engineering repo audits complete (6 official repos cloned locally under ~/.anyplugin-research/clones): claude-plugins-official, opencode (dev e00890c), codex (~0.147.x), open-knowledge-format (ad30107), antigravity-sdk-python (0.1.14), openai/skills. Corrections applied:
  - [Codex](/agents/codex.md): hooks enabled by DEFAULT (not feature-gated); no CODEX_HOOK_EVENT env (stdin `hook_event_name`); timeout def 600s; plugin install via `codex plugin marketplace add` CLI; 32 KiB AGENTS.md cap is COMBINED; external-agent import protocol exists.
  - [OpenCode](/agents/opencode.md): dev v2 Effect-TS rewrite does not wire v1 hooks (shell.env TODO); skills frontmatter v2 decodes only name/description/slash; adapter emits v1 shim + v2-safe artifacts.
  - [Antigravity](/agents/antigravity.md): SDK has NO file-based config — `.agents/` layout is the IDE/CLI surface; SDK needs code-level injection.
  - [OKF](/formats/okf-v02.md): full validator MUST-fail/MUST-warn/MUST-tolerate matrix extracted from official tests.
  - [SKILL.md](/formats/skill-md.md): cross-vendor `agents/<vendor>.yaml` sidecar convention + OpenAI validation rules.
- Bootstrap bundle from Phase-1 web research (docs + issue trackers). All agent/format concepts created with status `stable` where verified against official docs, `draft` where community-reported only.
- Added [Antigravity](/agents/antigravity.md) detection caution: `ANTIGRAVITY_AGENT` is community-verified, not doc-verified.
- Added [OKF v0.2](/formats/okf-v02.md) spec extraction; noted third-party okf.md/openknowledgeformat.com sites contradict the official SPEC.md on manifests — official repo wins.
