# @lablaunchpad/adapter-antigravity

**Emits Antigravity's native artifacts from one canonical plugin.**

Emits Antigravity's native artifacts, including the inject-steps translation that carries a hook's context into an Antigravity session.

An adapter is a **pure emitter**: it renders files and returns a plan. It
never touches the user's home directory or project directory — the CLI
executes the plan. That separation is what makes an install reversible and
journaled.

## Install

```bash
npm install @lablaunchpad/adapter-antigravity
```

Most people do not install this directly: it is a dependency of
`@lablaunchpad/cli`, which is the supported entry point.

## Licence

MIT
