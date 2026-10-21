# @lablaunchpad/adapter-claude

**Emits Claude Code's native artifacts from one canonical plugin.**

Emits Claude Code's native artifacts: a `.claude-plugin/plugin.json` manifest, the skill and command directories, and the hook wiring the canonical runner.

An adapter is a **pure emitter**: it renders files and returns a plan. It
never touches the user's home directory or project directory — the CLI
executes the plan. That separation is what makes an install reversible and
journaled.

## Install

```bash
npm install @lablaunchpad/adapter-claude
```

Most people do not install this directly: it is a dependency of
`@lablaunchpad/cli`, which is the supported entry point.

## Licence

MIT
