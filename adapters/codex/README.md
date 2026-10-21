# @lablaunchpad/adapter-codex

**Emits Codex CLI's native artifacts from one canonical plugin.**

Emits Codex CLI's native artifacts: the agent configuration, the skills, and the hook wiring the canonical runner.

An adapter is a **pure emitter**: it renders files and returns a plan. It
never touches the user's home directory or project directory — the CLI
executes the plan. That separation is what makes an install reversible and
journaled.

## Install

```bash
npm install @lablaunchpad/adapter-codex
```

Most people do not install this directly: it is a dependency of
`@lablaunchpad/cli`, which is the supported entry point.

## Licence

MIT
