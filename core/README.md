# @lablaunchpad/core

**The distribution layer's core.** Detection, the canonical plugin manifest, the event mapping, the OKF v0.2 library, the capability matrix, and the filesystem safety boundary.

Most people should not install this directly — it is a dependency of `@lablaunchpad/cli`. It is published separately so that adapter authors can use the contract without pulling in the CLI.

## What it owns

- **Detection** — which coding agents are installed, and how.
- **The manifest** — one canonical `anyplugin.plugin.yaml`, compiled into four native bundles.
- **The event map** — the canonical event vocabulary, and what each platform calls it.
- **Capabilities** — whether a target can honour a declared capability. `UNKNOWN` fails closed; `UNSUPPORTED` is a build error.
- **Safe paths** — the only way untrusted input becomes a path.

## Install

```bash
npm install @lablaunchpad/core
```

Sub-path exports are available for the individual modules: `@lablaunchpad/core/detect`, `/schema`, `/events`, `/okf`, `/emit`, `/adapters`.

## Licence

MIT
