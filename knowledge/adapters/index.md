# Adapter Design

* [Agent and environment detection matrix](detection-matrix.md) - Runtime detection of which coding agent is executing plus environment capabilities (OS, shell, sandbox, network) — primary signals and confidence-ranked fallbacks.
* [Canonical event mapping](event-mapping.md) - Mapping of AnyPlugin canonical hook events to the native hook/event names of Claude Code, OpenCode, Codex, and Antigravity, plus payload translation notes.
* [The delegation wrapper — AnyPlugin as a front door to other runtimes](delegation-wrapper.md) - How `anyplugin delegate` routes work to heterogeneous external runtimes and CLIs, and how the delegation telemetry contract makes those attempts replayable and auditable rather than scattered log lines.

# Reference

* [Failure-mode catalogue — what goes wrong and what the system does](failure-modes.md) - The single catalogue of failure classes across the install, runtime, delegation, and kernel paths, with the behaviour each class mandates. A failure that cannot be classified is never retried.

