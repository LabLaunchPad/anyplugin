# @lablaunchpad/adapter-opencode

**Emits OpenCode's native artifacts from one canonical plugin.**

Emits OpenCode's native artifacts, including the v2 plugin shim that bridges OpenCode's hooks to the canonical runner.

An adapter is a **pure emitter**: it renders files and returns a plan. It
never touches the user's home directory or project directory — the CLI
executes the plan. That separation is what makes an install reversible and
journaled.

## Install

```bash
npm install @lablaunchpad/adapter-opencode
```

Most people do not install this directly: it is a dependency of
`@lablaunchpad/cli`, which is the supported entry point.

## Licence

MIT
