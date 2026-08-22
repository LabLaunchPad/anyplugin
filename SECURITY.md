# Security Policy

## Supported versions

AnyPlugin is pre-1.0 (`0.1.x`). Security fixes are applied to the latest `main` only.

## Reporting a vulnerability

Report privately via [GitHub security advisories](https://github.com/LabLaunchPad/anyplugin/security/advisories/new) for this repository. Do not open a public issue describing a vulnerability.

We will acknowledge reports within a few days and keep you informed through a fix and advisory.

## Security model (what we defend against)

AnyPlugin installs files into agent config directories and edits agent config files. The invariants the code must preserve — and that changes must not weaken:

1. **Path safety** — installer destinations come only from a fixed template whitelist plus validated name/path segments (`validatePluginName`, `validateRelPath`, `validateSegment` in `cli/src/index.ts`). Token substitution (`{{PLUGIN_ROOT}}`) is allowed in VALUES, never in paths.
2. **Reversibility** — config edits are marker-delimited blocks; uninstall must restore prior state (tested in `cli/src/cli.test.ts` and `cli/src/scaffold.test.ts`).
3. **Plugin runtime isolation** — hook handler failures are always non-blocking (exit 0); a plugin cannot break the host agent. Blocking (exit 2) is only an explicit handler decision.
4. **Supply-chain minimalism** — three runtime dependencies (yaml, zod, smol-toml); the emitted runner and MCP server are dependency-free. New dependencies require justification.
5. **No secrets in source** — credentials belong in environment variables or secret stores, never as literals in code, examples, or tests.
