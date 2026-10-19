# Implementation Plan & Record — the audit remediation

**Status: COMPLETE.** All P0 and P1 audit findings (A–L) are fixed, the
delegation wrapper is shipped, and the repository's documentation gaps are
closed.

| Gate | Result |
|---|---|
| `pnpm build` | Clean |
| `pnpm test` | 643 passed, 6 skipped (58 files) — the 6 skips are the pre-existing Windows symlink tests |
| `okf-validate knowledge` | CONFORMANT (0 errors) |
| `anyplugin doctor` | Working, incl. `--fix` |
| Architecture boundary | `core` is a leaf; the kernel depends on nothing workspace-internal — both guarded mechanically |

---

## 1. The findings

| ID | Class | What it was | Where it lives now |
|---|---|---|---|
| A | BUG | Hook id accepted leading `_`/`0-9`, unbounded length | `core/src/schema/index.ts` — `^[a-z][a-z0-9-]{0,63}$` |
| B | BUG | Manifest paths validated lexically only | `core/src/schema/index.ts` — realpath containment |
| C | BUG | No destination-ownership classification | `cli/src/index.ts` — ABSENT/OWNED/CONFLICTING, ULID ownership proof |
| D | BUG | Journal cast, not validated; missing ≅ corrupt | `cli/src/journal.ts` — strict schema, `schemaVersion`, `migrateJournal()` |
| E | BUG | Install mutated before the journal was written | `cli/src/transaction.ts` — stage → intent → backup → apply → verify → commit |
| F | BUG | `timeoutSec` declared, never enforced | `plugins/knowledge/runtime/runner.js` — hard deadline |
| G | BUG | `failurePolicy` declared, never read | `plugins/knowledge/runtime/runner.js` — "blocking" exits 2 |
| H | BUG | The OpenCode shim dropped every hook but the last | `adapters/opencode/src/index.ts` — event → ordered list |
| I | BUG | The MCP frontmatter parser was not YAML | `plugins/knowledge/runtime/yaml-lite.js` — YAML 1.2 core schema |
| J | BUG | Replay gap detection was O(n²) | `packages/worker-runtime/src/log/replay.ts` — single pass |
| K | BEHAVIOUR | Event-log durability was unstated | `packages/worker-runtime/src/log/event-log.ts` — `DurabilityLevel` |
| L | GAP | No diagnostic for a stale writer lock | `cli/src/bin.ts` — `anyplugin doctor`, liveness-based |

Plus the defects the independent review of this branch found: the OpenCode
shim discarding a blocking denial, the YAML parser's remaining divergences, a
failed rollback destroying the user's backups, uninstall trusting the
journal's paths, `doctor --fix` deleting crash-recovery material, and the
delegation deadline being a lie. All are recorded in `docs/BACKLOG.md` with
their classifications.

---

## 2. The new capability: the delegation wrapper

`anyplugin delegate` and `anyplugin backends` make the CLI a front door to
other runtimes and tools.

```
registry (declarative) → probe → route → delegate safely → record telemetry
```

**The contract lives in the kernel** (`packages/worker-runtime/src/telemetry/delegation.ts`),
**the mechanism in the CLI** (`cli/src/delegate.ts`). That split keeps the
architecture boundary: the kernel knows about backends in the abstract and
nothing about any agent.

| Piece | What it guarantees |
|---|---|
| The registry | Unknown fields rejected; an unknown `apiVersion` refused whole; a capability a backend does not declare is `UNKNOWN`, and `UNKNOWN` fails closed |
| Safe spawn | Never a shell; always a deadline and an output cap; always an environment allowlist |
| Classification | The exit code is never the answer — it is combined with a structured error envelope, the timeout signal, and the `committed` flag |
| Fallback | Closed once the turn has committed; an unclassifiable failure is never retried |
| Two fail axes | Capability fails closed; health fails open. Constants, not configuration |
| Telemetry | Every attempt produces a classified event for the worker-runtime log |

---

## 3. The documentation that was missing

| Artifact | What it owns |
|---|---|
| `ARCHITECTURE.md` | The layer stack (Mermaid), the dependency direction, the package map, what the Worker Runtime is FOR, and "which document owns what" |
| `docs/FAILURE-MODES.md` | Every failure class and the behaviour it MANDATES |
| `docs/BACKLOG.md` | Every known issue, classified and severity-rated, with a "correct behaviour today" column |
| `docs/SESSION-LEARNINGS.md` | What the last 48 engineering sessions established, and how they failed |
| `knowledge/adapters/delegation-wrapper.md` | The OKF concept for the wrapper |
| `knowledge/adapters/failure-modes.md` | The OKF concept for the failure-mode reasoning |

---

## 4. What is still open

The P2 polish list, plus three genuine gaps the review surfaced, are in
`docs/BACKLOG.md`. The three that matter:

| ID | Gap |
|---|---|
| P1-7 | **No crash recovery.** The install writes `install_intent.json` and the backups, but nothing reads them. A process killed between `apply` and `commit` leaves the host mutated with no journal. `doctor` now PRESERVES the backups so a recovery tool can use them. |
| P1-8 | The circuit breaker has no live consumer in the CLI (it is stateless per invocation). |
| P1-9 | `copyDir`'s symlink containment now has a test, but the Windows leg of the *manifest* symlink audit still skips (a junction-based substitute is the fix). |

---

## 5. How the work was done

| Phase | Method |
|---|---|
| Discovery | The live session store was queried directly (`node:sqlite`) for the last 10 AnyPlugin sessions and 38 adjacent ones, with their tool-error records intact. |
| Research | External patterns were checked against primary sources — OTel GenAI semconv, LiteLLM/Portkey routing and health, the Azure circuit-breaker pattern, AWS retry behaviour, GeoLibre/kroma registry patterns, ACP, and the Agent Client Protocol. |
| Implementation | Contract-first, in the layer that owns the contract. |
| Review | An independent adversarial review of the whole diff, which found 4 BLOCKERs and 7 MAJORs. |
| Iteration | The BLOCKERs and the data-destroying MAJORs were fixed; the rest were classified into the backlog with an honest scope note in the docs. |
