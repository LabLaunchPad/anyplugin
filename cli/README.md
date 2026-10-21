# @lablaunchpad/cli

**One plugin, four native agents.** Write a plugin once; install it natively into Claude Code, OpenCode, Codex CLI, and Antigravity — reversibly, with a journal that proves what was changed and restores it byte-for-byte on uninstall.

## Install

```bash
npx anyplugin init
npx anyplugin detect
npx anyplugin build --plugin ./my-plugin
npx anyplugin install --plugin ./my-plugin
```

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
