# Security Policy

**Status:** ACTIVE — this is the repository's security policy in force. The
failure catalogue it draws on is `docs/FAILURE-MODES.md`; the trust model it
is consistent with is `docs/agent-sdk/trust.md`.

## 1. Supported versions

AnyPlugin is pre-1.0 (`0.1.x`). Security fixes are applied to the latest `main` only.

## 2. Reporting a vulnerability

Report privately via [GitHub security advisories](https://github.com/LabLaunchPad/anyplugin/security/advisories/new) for this repository. Do not open a public issue describing a vulnerability.

We will acknowledge reports within a few days and keep you informed through a fix and advisory.

## 3. Security model (what we defend against)

AnyPlugin installs files into agent config directories and edits agent config files. The invariants the code must preserve — and that changes must not weaken:

1. **Path safety** — installer destinations come only from a fixed template whitelist plus validated name/path segments (`validatePluginName`, `validateRelPath`, `validateSegment` in `cli/src/index.ts`). Token substitution (`{{PLUGIN_ROOT}}`) is allowed in VALUES, never in paths.
2. **Reversibility** — config edits are marker-delimited blocks; uninstall must restore prior state (tested in `cli/src/cli.test.ts` and `cli/src/scaffold.test.ts`).
3. **Plugin runtime isolation** - a hook handler failure exits 0 with a stderr note by default; a plugin cannot break the host agent. The single exception is an explicit opt-in: a hook declared `failurePolicy: "blocking"` in the manifest, whose failures exit 2 (the host is denied). The plugin author asks for that; the platform never infers it.
4. **Supply-chain minimalism** — three runtime dependencies (yaml, zod, smol-toml); the emitted runner and MCP server are dependency-free. New dependencies require justification.
5. **No secrets in source** — credentials belong in environment variables or secret stores, never as literals in code, examples, or tests.
