# @lablaunchpad/cli

**One plugin, four native agents.** Write a plugin once; install it natively into Claude Code, OpenCode, Codex CLI, and Antigravity — reversibly, with a journal that proves what was changed and restores it byte-for-byte on uninstall.

## Install and run

This package's name is `@lablaunchpad/cli`. It is not published as
`anyplugin` — that name is not on the registry, so `npx anyplugin` is a
404.

```bash
npx @lablaunchpad/cli init
npx @lablaunchpad/cli detect
npx @lablaunchpad/cli build --plugin ./my-plugin
npx @lablaunchpad/cli install --plugin ./my-plugin
```

Or install it and use the `anyplugin` command it provides:

```bash
npm install @lablaunchpad/cli
npx anyplugin detect
```

The second form works because the package installs a binary named
`anyplugin`. The first form works because `npx` runs the package's binary
directly.

## The commands

| Command | What it does |
| --- | --- |
| `init` | scaffold a plugin |
| `detect` | report which agents are installed |
| `build` | compile one manifest into native bundles |
| `install` | install natively, journaled and reversible |
| `uninstall` | restore the exact pre-install bytes |
| `intensity` | set the plugin's intensity mode |
| `doctor` | diagnose the runtime |
| `okf-validate` | validate an OKF v0.2 knowledge bundle |

## The guarantees

- An install is **journaled**. An uninstall restores the exact bytes that were there before, and **aborts** rather than overwrite a file you edited after the install.
- A target that cannot honour a declared capability is a **build error**, not a runtime surprise.
- A hook failure exits 0 with a stderr note by default. The single exception is an explicit `failurePolicy: "blocking"` that the **plugin author** opted into — never the platform inferring it.

## Licence

MIT
