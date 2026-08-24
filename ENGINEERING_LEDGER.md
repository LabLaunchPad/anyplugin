# ENGINEERING_LEDGER.md

AnyPlugin defect-eradication ledger. Protocol: **VERIFY → FIX → ERADICATE THE CLASS → TEST → UPDATE LEDGER.**
Statuses: `[OPEN]` · `[INVESTIGATING]` · `[FIXED]` · `[FIXED & ERADICATED]` · `[SPEC'D — QUEUED PHASE 1]` · `[UNMAPPED]`.

> Evidence basis: this session's independent code review (PR #2 iteration 1), the audit-remediation pass
> (iteration 2), and the CI-runnability pass (iteration 3), all on branch `feat/agentability-fixes`.
> IDs without a mapped audit finding are marked `[UNMAPPED]` rather than invented; the founder should
> attach the source-audit definitions for those rows.
>
> **Extended (M0–M1, Worker Runtime).** Rows AP-017…AP-020 and the F-series notes below come from the M0
> repository-truth reconnaissance and the M1 kernel review. Findings keep their original `F<n>` ids as
> historical labels and are mapped into this taxonomy by **class**, not one row per finding — several F-ids
> are instances of one class, and one (F9) was a misreport of surfaces this ledger already carried. Where a
> previously recorded conclusion conflicts with new measurement, the conflict is stated and resolved in
> place rather than silently overwritten; see AP-018.

---

## Security (Layer 1: Trust)

### SEC-01 — Arbitrary file load via unvalidated hook id in the universal runner · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (commits `78994ec`, Phase-1 `feat: implement SafePath boundary`)
- **Root Cause Analysis**: `process.argv[2]` was interpolated into `import()` candidate paths without any validation; any string (including traversal sequences) reached module resolution.
- **Fix + Evidence**: hook ids locked to `^[a-zA-Z0-9_-]+$`; invalid ids exit 1 before any path use. E2E test feeds `../../etc/passwd`, `a/b`, `..\evil`, `hook id!` and asserts exit 1 + `invalid hook id` on stderr (CI `runtime-node-20` job re-verifies on a clean machine).
- **Systemic Guardrail (class eradication)**: (1) *identifier-vs-path separation* — free-text ids that become module paths satisfy a strict identifier regex, never string interpolation; (2) the shared **SafePath boundary** (`core/src/fs/safe-path.ts`, spec §1.1) is now the single way untrusted input becomes a path — lexical rejection (traversal/absolute/UNC/drive — including mid-path drive-letter segments /NUL/length) + two-sided realpath containment + `SecurityError` with no partial action; proven by a deterministic 10,000-input hostile corpus test (zero escapes), a real symlink/junction escape test, and (review-hardened) a **dangling-symlink refusal test** — a link whose target is missing is treated as an escape, never as "not existing". Consumers: installer plan paths, manifest path fields, MCP bundle resolution. Runner keeps the stricter identifier rule (it selects module names, not paths).

### SEC-02 — (definition pending from source audit) · Severity: TBD
- **Status**: `[UNMAPPED]`
- **Root Cause Analysis**: — (no finding text supplied; not invented).
- **Systemic Guardrail**: —
- **Note**: candidate adjacent area already hardened: installer destinations can only come from the `TEMPLATES` path whitelist + validated segments (`cli/src/index.ts`), never token substitution into paths.

---

## Bugs (correctness / data integrity)

### BUG-01 — Silent data loss in marker stripping (`stripBlock`) · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (commits `223af46`)
- **Root Cause Analysis**: a `begin` marker with a missing `end` marker returned `text.slice(0, b)` — silently deleting everything after the block.
- **Fix + Evidence**: `stripBlock` now throws `corrupted marker block: missing end marker … — refusing to strip`; unit test asserts the throw; install/uninstall propagate the error (no catch swallows it). Byte-exact journal restores make the pre-fix data-loss path unreachable anyway.
- **Systemic Guardrail**: *No Silent Failures* is now a test-enforced invariant — every destructive text transform either proves both markers present or throws; the transactional journal means destructive transforms are no longer the recovery mechanism.

### BUG-02 — `parseArgs` misuse: flags parsed as positionals · Severity: P1
- **Status**: `[FIXED & ERADICATED]` (commits `223af46`, Phase-1 `feat: strict CLI contract`)
- **Root Cause Analysis**: code destructured only `{ values }` and read raw `argv` slices for positionals, so `okf-validate --json` treated `--json` as the bundle directory.
- **Fix + Evidence**: positional parsing fixed first (mixed-args E2E); Phase 1 replaced ALL raw parsing with `cli/src/strict-args.ts` — one strict Zod schema per command (flags AND positionals), unknown flags and command-inappropriate flags are hard errors, `bin.ts` no longer calls `parseArgs` at all.
- **Systemic Guardrail**: the contract lives in one module — a new flag must be added to a command's schema or every use of it fails; **positionals are part of the contract** (review-hardened): every command except `okf-validate`/`okf-reindex` rejects positional arguments outright, and the okf commands accept at most one — silent no-ops like `build my-plugin` are impossible. 9-case suite covers typo'd flags, misplaced flags, missing required flags, unknown commands, and positional misuse.

### BUG-03 — (definition pending from source audit) · Severity: TBD
- **Status**: `[UNMAPPED]`

### BUG-04 — `import.meta.dirname` unavailable on Node 20.0–20.10 · Severity: P1
- **Status**: `[FIXED & ERADICATED]` (commit `223af46`)
- **Root Cause Analysis**: `import.meta.dirname` landed in Node 20.11/21.2; engines promise `>=20`.
- **Fix + Evidence**: all source uses replaced with `dirname(fileURLToPath(import.meta.url))`; the CI `runtime-node-20` job executes the built artifacts on Node 20 as the standing guardrail.
- **Systemic Guardrail**: Node-20 runtime job in CI (structural: any future use of too-new APIs in the runtime surface fails a dedicated check, not just review).

### BUG-05 — (definition pending from source audit) · Severity: TBD
- **Status**: `[UNMAPPED]`

---

## Architectural Problems (AP)

### AP-001 — Irreversible, patch-based install/uninstall · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (commit `223af46`)
- **Root Cause Analysis**: uninstall re-derived intent from the emitted patch (key removal, marker strip) instead of recorded pre-state; it could create config files, truncate unparseable JSON to `{}`, and destroy user edits.
- **Fix + Evidence**: transactional journal `.anyplugin-state.json` per installed root — `{ pluginId, version, agent, files: [{ file, kind, preInstallHash, postInstallHash, backupContent, ownedKeys }] }`; uninstall is two-phase (classify all → apply only when clean), restores byte-exact pre-install content, deletes files the install created, and the legacy fallback is write-safe (missing → skip, unparseable → skip, write only on change). 6-test suite: conflict abort ×2, byte-exact restore, dry-run conflict report, reinstall cleanliness, unparseable-merge refusal.
- **Systemic Guardrail**: journal is the single recovery mechanism (destructive re-derivation deleted); conflict-abort + reversibility are mandatory test columns for any new installer destination (AGENTS.md rule, PR template checklist).

### AP-002 — Path traversal surface in installer paths · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (Phase-1 `feat: implement SafePath boundary`)
- **Root Cause Analysis**: install plans carry relative paths that become filesystem destinations.
- **Fix + Evidence**: destinations resolve ONLY through the `TEMPLATES` whitelist; every plan-relative source path and name segment now flows through the shared SafePath boundary (`assertSafeRelative` / `resolveAuthorizedPath`) — the local regex locks were **deleted, not duplicated**; copy sources additionally prove containment inside the emitted bundle directory via realpath.
- **Systemic Guardrail**: whitelist-first construction (paths never composed from untrusted text) + the single shared SafePath utility; the 10k hostile corpus and guard tests block the class wholesale.

### AP-003 — (definition pending) · Severity: TBD · **Status**: `[UNMAPPED]`

### AP-004 — OpenCode V2 breaks V1 hook shims · Severity: P1
- **Status**: `[FIXED & ERADICATED]` for the silent-breakage class (Phase-1 `feat: capability negotiation matrix`); **V2-native emission remains `[OPEN]`** — requires a dedicated OpenCode v2 plugin-API audit before native emission can be written without inventing syntax.
- **Root Cause Analysis**: OpenCode's v2 core dropped the v1 hook API; the adapter emitted a v1 TS shim unconditionally, so plugins targeting v2 hosts silently degraded or broke.
- **Fix + Evidence**: `core/src/capabilities/matrix.ts` — 4-state negotiation (`NATIVE | DEGRADED | UNSUPPORTED | UNKNOWN`), `UNKNOWN` fails closed, `UNSUPPORTED` is a **hard build error** with the offending capability and rationale named. `buildAll` derives required capabilities from the manifest and gates every target/variant (tests: hooks→`opencode@v2` rejects; `session-end`→antigravity rejects; unknown variant rejects; DEGRADED emits build warnings, e.g. commands omitted on codex/antigravity).
- **Systemic Guardrail**: compatibility verdicts are authored data in one matrix (every row cites its audited rationale); adapters can no longer silently drop or break capabilities — a new agent/variant must be added to the matrix or every build for it fails closed.

### AP-005 … AP-006 — (definitions pending) · **Status**: `[UNMAPPED]`

### AP-007 — Semantic loss in canonical event mapping · Severity: P1
- **Status**: `[FIXED & ERADICATED]` — documentation drift (commit `add2868`: per-agent-column drift guard) and silent semantic loss (Phase-1 capability matrix: DEGRADED folds now emit build warnings; UNSUPPORTED folds are build errors).

### AP-008 — MCP server resolves caller-supplied bundle paths without a boundary · Severity: P1
- **Status**: `[FIXED & ERADICATED]` (Phase-1 `feat: implement SafePath boundary`)
- **Root Cause Analysis**: `resolveBundle` accepted any existing directory from tool args/env/cwd without an authorization boundary.
- **Fix + Evidence**: the dependency-free runtime now carries an inline SafePath guard — a bundle is served only when its realpath equals or lies inside an authorized root (operator-configured `ANYPLUGIN_OKF_BUNDLE`, the plugin's own bundled knowledge, or the working directory). Outside paths are refused, not read.
- **Systemic Guardrail**: authorized-root containment as an inline mirror of `core/src/fs/safe-path.ts` (the runtime ships no workspace deps by design — the two implementations are tied by spec §1.1 and covered by the E2E MCP suite).

### AP-009 — Uninstall destroys user edits made after install · Severity: P0
- **Status**: `[FIXED & ERADICATED]` (commit `223af46`) — see AP-001; the conflict path throws a descriptive abort listing offending files, preserves edits byte-exact, and `--dry-run` surfaces `CONFLICT:` lines without touching anything. (Supersedes the earlier reviewer finding that the json-merge dry-run had false negatives — that code path was replaced wholesale.)

### AP-010 … AP-016 — (definitions pending) · **Status**: `[UNMAPPED]`

### AP-017 — Canonical↔native hook translation layer is unverified end-to-end · Severity: P1
- **Status**: `[OPEN]` — gates M11.
- **Root Cause Analysis**: the translation between canonical events and each agent's native protocol is implemented **twice** (in `core/src/events/` and again in the dependency-free `runner.js`) and is covered by no shared conformance test. Four independently-found findings are instances of this one class, which is why they are recorded here together rather than as four bugs:
  - **F1** — `adapters/opencode/src/index.ts:183` parses hook stdout only `if (result.code === 0 …)`, but a `block: true` result exits **2** (`runner.js:175`), so the canonical block channel is a no-op on OpenCode while the matrix marks those hooks `NATIVE`. Scope precisely: permission *denial* still works via the separate `permissionDecision` channel (`:205-210`), which exits 0 — M7 must not rebuild a channel that already functions.
  - **F2** — the OpenCode bridge is keyed by **native** name (`:142`), so `turn-stop` and `session-end` both map to `session.idle` and one hook is silently dropped, last-wins.
  - **F4** — `core/src/events/index.ts:121` early-returns on `result.raw`, discarding every other field, while `runner.js:160-170` merges raw and then applies `block` *after* it. Two precedence rules for one protocol. The payload diverges in both directions: the runner omits `event`/`nativeEvent` that `HookPayload` declares required, and adds `hookId`/`pluginRoot`/`intensityMode` that it does not declare.
  - **F8** — `runner.js:175` is `process.exit(result.block ? 2 : 0)` with no platform branch, while `AGENTS.md:62` documents exit-0 semantics for Antigravity — and the lines immediately above it *do* branch on platform for the payload shape. Either the runner is wrong or the documentation is; **one of the two must change**, and which is a source-of-truth decision, not a patch.
- **Relationship to AP-007**: AP-007 is marked `[FIXED & ERADICATED]` for the two mechanisms it named — documentation drift and DEGRADED/UNSUPPORTED capability folds. These four instances run through a **different** mechanism (the output-protocol and event-name translation itself) that the eradication did not cover. The class is therefore wider than AP-007's remedy, which is recorded here rather than by weakening AP-007's status.
- **Systemic Guardrail (required, not yet built)**: one shared conformance suite that both implementations must pass, so a protocol can no longer be implemented twice with two precedence rules. A one-sided patch to either implementation does not close this.

### AP-018 — Non-atomic whole-file rewrite · Severity: P1
- **Status**: `[OPEN]` for the three AnyPlugin instances; `[FIXED & ERADICATED]` for the Worker Runtime event log (see below).
- **Root Cause Analysis**: unlocked `readFileSync` → mutate → `writeFileSync` on a shared file. Concurrent writers overwrite each other, and a process that dies mid-write leaves a file that is neither the old content nor the new one, with nothing recorded that can detect which. Three instances, named so that a fix cannot land on the copy and ship the original (**F3**):
  1. `plugins/knowledge/plugin/hooks/okf-turn-stop.mjs:21-36` — the hook, the only one currently wired to an agent.
  2. `core/src/okf/index.ts:431-451` — `appendLog()`, the identical routine exported as public `core` API. It has no callers, which is the only reason it has not bitten yet.
  3. `core/src/okf/index.ts:350-424` — `regenerateIndexes()`, a second non-atomic whole-file rewrite.
- **CONTRADICTION RESOLVED — the originally prescribed remedy was wrong.** `ROADMAP.md` F3 concluded *"the event log must not copy this pattern — it requires atomic `O_APPEND` single writes"*, and the M2 acceptance row required *"atomic append"*. Measurement contradicts the prescription: **POSIX bounds `O_APPEND` write atomicity at `PIPE_BUF` (4096 bytes) and Windows guarantees no equivalent at all**, so "atomic `O_APPEND`" is not a property that can be relied on for records of arbitrary size on the platforms this repo tests. Written as specified, M2 would have inherited the very class F3 identified, while believing itself immune. Resolved through this ledger's protocol: the finding stands, the remedy is replaced.
- **Fix + Evidence (kernel surface)**: `EVENT_WRITE_CONTRACT v1` (`packages/worker-runtime/src/log/write-contract.ts`) states five observable guarantees and deliberately never uses the word *atomic* as a primitive — it conflates six properties (write atomicity, durability, ordering, concurrency, corruption detection, recovery) and a mechanism routinely satisfies one while violating its neighbour. Five candidate mechanisms were implemented and measured (`scripts/f10-bench.mjs`, `log/write-contract.test.ts`) across the full CI matrix. The decisive result: plain append **silently accepted** a tampered record — well-formed, parseable, correct length, and not what was written — because the information needed to detect it was never recorded. Checksummed framing converts every failure into a *detected* failure instead. Under a deliberately racy writer the framed mechanism lost 18 of 100 concurrent events, **detected all 18 and silently accepted none**, with byte accounting intact.
- **Systemic Guardrail (class eradication, kernel surface)**: the contract is executable, so a future mechanism change must satisfy the same conformance suite; candidate A's defect is **pinned by an assertion rather than deleted**, so it stands as the answer the next time someone proposes appending to a file. Concurrent-append survival above `PIPE_BUF` is recorded per platform and **not asserted** — generalizing an observation into a guarantee is the failure this harness exists to prevent.
- **Remaining work**: the three AnyPlugin instances above are untouched. They are not fixed by the kernel's contract and must not be reported as such.
- **F16 — the same class in the sequence allocator (found Gate 3, closed Gate 3).** `EventSchema.sequence` is specified as *"Monotonic per log; gaps mean loss, duplicates mean a broken writer."* Allocating a gapless monotonic sequence across concurrent writers means reading the current maximum and then writing — **this class again, one layer above the bytes**, in an allocator that did not exist and that the frozen contract mandates. The F10 harness could not have caught it: its records were `{id, payload}`, so its clean concurrency numbers proved *set completeness*, never *sequence monotonicity*. Two different properties; only the first had been measured.
  - **Resolution**: invariant I1 (single ownership) and `sequence` together settle the design — the log has exactly one writer, the sequence is an in-process counter, and correctness follows by construction rather than from a lock. Concurrent writing is therefore **not a supported mode but an error to refuse**: `EventLog.open` claims `writer.lock` with `openSync(..., "wx")` and a second writer — in-process or in a separate process — is rejected. A stale lock is reported and **never auto-broken**, because from inside the process a stale lock and a live second writer are indistinguishable, and breaking it to find out produces exactly the two-writer state the lock prevents.
  - **Guardrail**: replay reports sequence **gaps** and **duplicates** as distinct named anomalies, because the contract distinguishes them and they demand different responses — a gap means state is incomplete, a duplicate means the writer itself is wrong. A rejected append does not increment the counter, so a failed write cannot manufacture a gap; and a damaged tail cannot raise the resume point, so corruption cannot become a permanent gap. All three guards were negative-tested: removing the exclusive claim, the hash check, or the transition check each fails exactly the tests asserting it.

### AP-019 — `runtime.failurePolicy` is specified but does not exist, and three documents disagree · Severity: P2
- **Status**: `[OPEN]` — gates M7a.
- **Root Cause Analysis** (**F7**): `CORE-INVARIANTS-V2.md` §1.3.3 defines `failurePolicy: blocking`; grep finds **zero occurrences outside that document** — no schema field, no implementation, no test. Meanwhile the runtime's actual behaviour is that hook failures are always non-blocking. Either the spec describes an unbuilt feature, or a distinct mechanism is intended over *concern outcomes* (a verification returned FAIL) rather than over *handler throws* — in which case the "extension, not invention" framing is wrong and M7a is new design.
- **Systemic Guardrail (required, not yet built)**: a specified-but-absent field is invisible to every test in the repository. The class is *specification that no test can falsify*; the remedy is that a normative field either exists in the schema or is removed from the spec.

### AP-020 — Representation ambiguity in content-addressed integrity · Severity: P0
- **Status**: `[FIXED & ERADICATED]`
- **Root Cause Analysis**: the class is **one logical value with two byte representations (or two logical values with one)**. Anything content-addressed inherits it: a differing representation yields a false positive in tamper detection, and a shared representation yields a false *negative*, which is strictly worse — the ledger then asserts something that never happened. Three instances, the second and third found by deliberately applying the first's class to code already declared frozen:
  - **F13** — a CRLF checkout changed generated-schema bytes, so the hashes recorded in the M1 report were platform-dependent, contradicting the determinism that report claimed. Found by Windows CI; not reproducible locally.
  - **F14** — NFC and NFD forms of one string hashed differently. Not hypothetical: macOS normalizes filenames toward NFD while Linux stores NFC, so one record captured on two machines produced two hashes.
  - **F15** — integers beyond ±(2^53−1) collapse as f64, so `9007199254740993` and `9007199254740992` produced **one** hash. A collision, i.e. a false negative in tamper detection.
- **Fix + Evidence**: `.gitattributes` pins `text=auto eol=lf` (0 CRLF files across all tracked files, verified via `git ls-files --eol`); `canonical.ts` normalizes strings **and keys** to NFC and rejects keys that collide after normalization rather than silently merging or dropping one; unsafe integers are refused rather than hashed, with an error naming the offending path. `canonical-contract.test.ts` carries frozen golden vectors that run on every CI matrix cell, so platform- and version-independence is demonstrated rather than asserted.
- **Systemic Guardrail (class eradication)**: canonicalization is treated as a **security primitive, not a serialization helper**, and the governing question for every accepted value is not "is this valid JSON?" but *"can two materially different semantic values collapse into the same canonical representation?"* — if yes, the value is refused. The canonicalizer rejects, rather than coerces, everything `JSON.stringify` would silently corrupt (NaN→null, undefined array elements→null, engine-dependent `Date`). A known caveat is pinned by its own tripwire test: canonicalization does **not** normalize path semantics, so any future record that stores a path must POSIX-normalize before hashing. No frozen contract stores one today.

### F9 — capability truth · **not a new finding**
Recorded as a **correction**, because it was initially reported as five undiscovered defects. The ledger already documented both live surfaces, with named remediations:
- `codex@>=0.147` `mcp.http` is `UNKNOWN` and therefore fails closed — see *Additional classes* below, where it is recorded as **intentional per spec §2.2**, remediated by auditing the codex TOML http shape and filling the matrix row.
- OpenCode v2-native emission is already `[OPEN]` under **AP-004**, pending a v2 plugin-API audit.

**Scope decision for M2**: M2 is a local event log and requires neither MCP nor OpenCode hooks, so neither surface gates it. This narrows what M2 depends on; it does **not** resolve either surface. `UNKNOWN` stays `UNKNOWN` — it is not converted to `UNSUPPORTED` to make a gate green.

### F5 / F6 — hard capability limits, **not defects**
Recorded so their absence from the defect rows is not mistaken for an oversight. `session-end` is `UNSUPPORTED` on Antigravity (`matrix.ts:100`) and `opencode@v2` marks every hook `UNSUPPORTED` (`matrix.ts:82`), leaving only `skills` and `knowledge` `NATIVE`. These are **confirmations of AP-004's capability matrix working as designed** — the matrix exists precisely so a missing capability fails loudly instead of degrading silently. They constrain what may be built; they are never "satisfied," so they can never be closed.

### F10 / F11 / F12 — questions about code that did not exist
F10 (mutation protocol), F11 (write audit) and F12 (delete audit) asked what happens when the kernel writes and deletes. At M1 the kernel did neither — no `node:fs` import anywhere in kernel source — so they could not be closed against it. Absence of I/O is **not** evidence that future I/O is safe; it means the audit runs against the real M2 surface.
- **F10** is answered by AP-018's kernel row above.
- **F11/F12** are answered by the seven ownership invariants (`packages/worker-runtime/src/ownership.ts`, `ownership.test.ts`), established **before** the kernel had any I/O — a boundary added after the code it constrains has to argue with existing call sites, and it loses. Five are `PASSED` (single ownership, disjoint ownership, no reverse coupling, no cross-owner deletion, no hidden writers). Two are honestly `ARMED` and close empirically in M2: derived-state rebuildability (no builder and no records exist, so no rebuild has ever run) and transactional deletion (the policy is exercised, the crash-recovery mechanism is not). **ARMED is never reported as PASSED.**

---

## Additional classes fixed during the review loop (not in the supplied ID set)

- **CI had never run green** — duplicate pnpm version configuration; pnpm 11.14 incompatible with the advertised Node 20 cell. Fixed: matrix Ubuntu 22/24 + Windows 24 + dedicated `runtime-node-20` job (commits `abe73e2`, `6460c96`, `62e3add`). Guardrail: the green check itself (all 4 checks) + docs state the dev-vs-runtime Node contract.
- **Tests mutated the repo** — dogfood suite regenerated the committed knowledge bundle in place, clobbering the curated root index. Fixed on a temp copy with a survival assertion (commit `259e270`). Guardrail: test asserts the curated index is untouched every run.
- **`regenerateIndexes` never rendered `# Subdirectories`** and skipped dirs containing only subdirs. Fixed + nested-bundle test (commit `78994ec`).
- **F18 — a harness that cannot observe the property it appears to test.** Gate 3 asserted deterministic replay by replaying twice *inside one process*. That is necessary and structurally insufficient: a second in-process replay shares module state, lazily-initialized schema objects and every value read at import time, so any of those could contribute to the result and the test would agree with itself forever. **Measured, not argued:** injecting `process.pid` into `stateHash` left all **32 in-process tests green** while failing **13 of 15** fresh-process tests. The in-process suite was blind to a dependency that makes state unreconstructible by anyone else. **Class — this is F16 again.** There, the F10 harness carried no `sequence`, so its clean concurrency numbers proved *set completeness* while appearing to prove *ordering*. Both are the same defect: **a harness whose construction excludes the very failure it is cited as evidence against.** The generalized guard is to ask, of any test offered as evidence, *what would have to be true for this to pass while the property is false* — and if that state is reachable, the harness is not evidence. Closed by `log/replay-determinism.test.ts`, which crosses a real process boundary and additionally varies cwd, `TZ`, and locale so environment-derived hidden state surfaces as disagreement rather than as a pass. Gate 4 evidence: two independent fresh processes, a copied workspace, and two separately-written workspaces all agree by content hash; seven mutations each replay identically across processes and differ from the clean digest. **Deterministic reconstruction is not durability** — U1 stays `UNKNOWN`.
- **F17 — a test whose pass depends on runner speed.** Two CLI suites doing full four-agent install/uninstall cycles relied on vitest's default 5s bound. They passed on a quiet Windows runner and **timed out on a loaded one**, so the pass was a property of machine speed rather than of the code. The trigger was Gate 3 adding two process-spawning test files: vitest runs test FILES concurrently, and on Windows spawn plus filesystem work is several times costlier than on Linux — total suite time went from 22.7s to 87.4s, and the two slowest fs-heavy tests crossed the default. They had passed on the previous head by scheduling luck. **Class:** the repository had already solved this once — `plugins/knowledge/src/e2e.runtime.test.ts` carries an explicit 30s bound on all 19 of its tests — but the remedy was applied to that one instance and never generalized, leaving every other slow suite latent. Fixed by stating the bound explicitly in the five CLI suites that run install/build cycles (`vi.setConfig({ testTimeout: 30_000 })`), matching the existing convention. **No assertion changed**: a timeout is a liveness bound, not a correctness claim, and a genuine hang still fails. Verified non-vacuous by setting the bound to 1ms, which failed all six tests in the file, then restoring it.
- **Known fail-closed surface (intentional, per spec §2.2)**: `codex@>=0.147` `mcp.http` is `UNKNOWN` in the capability matrix, so a plugin declaring an HTTP MCP server hard-fails for the codex target even though an http emission path exists — audit the codex TOML http shape and fill the matrix row to change this.

## Phase-1 queue (executes only after founder approval of `CORE-INVARIANTS-V2.md`)

1. ~~`feat: implement SafePath boundary [SEC-01/AP-002/AP-008 eradicated]`~~ — **DONE**: `core/src/fs/safe-path.ts`, 10k-input hostile corpus + symlink-escape tests, runner/MCP/installer/manifest-path validation unified on it.
2. ~~`feat: strict CLI contract [BUG-02 class eradicated]`~~ — **DONE**: `cli/src/strict-args.ts`, per-command Zod schemas, `bin.ts` no longer parses raw argv (zod added as a direct cli dependency — already in the graph via core).
3. ~~`feat: capability negotiation matrix [AP-004/AP-007 eradicated]`~~ — **DONE**: `core/src/capabilities/matrix.ts` (4 states, fail-closed UNKNOWN, UNSUPPORTED = build error, DEGRADED = warning), buildAll gate with per-agent variant pinning. **Open sub-item**: OpenCode V2-native emission (`[OPEN]` — needs a v2 plugin-API audit; the matrix already makes v2-with-hooks a loud build failure instead of silent breakage).
