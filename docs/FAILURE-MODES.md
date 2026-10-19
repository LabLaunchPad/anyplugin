# Failure modes — what goes wrong, and what the system does

The single catalogue of failure classes and the behaviour each one mandates.
Every table row is a contract: the behaviour is not a suggestion, and two
components that classify the same failure must not disagree.

---

## 1. The principle behind the tables

**A failure that cannot be classified is not retried.**

This is the rule the whole catalogue serves, and it is worth stating plainly
because it looks wasteful. A wrapper that guesses "this unrecognised error is
probably a timeout" and retries it against a second backend has not recovered —
it has converted one failure into two, and it has done so without evidence.

So the taxonomy distinguishes three things that are often conflated:

| | Meaning | Example |
|---|---|---|
| **we know it failed** | The failure is real and observed | the backend exited non-zero |
| **we know why** | The cause is identified | the envelope says `statusCode: 429` |
| **we know it is about THIS backend** | Another backend might work | it is unreachable, not your request is malformed |

"Failed" is enough to fall back. "Failed and it is the request's fault" is
not. "Failed and we do not know" is not, either — because a wrapper that
cannot classify a failure cannot promise the next one is different.

---

## 2. Delegation failure classes

`packages/worker-runtime/src/telemetry/delegation.ts` — `DELEGATION_FAILURE_CLASSES`
and `FAILURE_BEHAVIOUR`. The behaviour is a property of the CLASS, so it
cannot be overridden by a caller.

| Class | Meaning | Behaviour | May fall back? | May retry same? |
|---|---|---|---|---|
| `timeout` | the deadline elapsed before the backend answered | `fallback` | yes | no |
| `refused` | the backend could not be reached | `fallback` | yes | no |
| `spawn_failed` | the backend command could not be started (missing, not executable) | `fallback` | yes | no |
| `backend_failed` | the backend ran and failed, and did not say why | `fallback` | yes | no |
| `upstream_unavailable` | the backend's own upstream is down | `fallback` | yes | no |
| `rate_limited` | the backend asked the caller to slow down | `retry_after` | no | **yes**, after the delay it named |
| `auth` | the credentials were rejected | `report` | no | no |
| `quota` | the account is out of credit | `report` | no | no |
| `protocol_violation` | the backend answered with something that violates its contract | `report` | no | no |
| `capability_unknown` | the backend does not declare the required capability | `report` | no | no |
| `output_truncated` | the backend produced more output than the wrapper will buffer | `report` | no | no |
| `cancelled` | the caller cancelled the request | `report` | no | no |
| `corrupt_state` | local state is damaged and cannot be trusted | `abort` | no | no |
| `unknown` | the failure could not be classified | `report` | **no** | no |

Two of these deserve a note:

- **`rate_limited` is not a health failure.** The backend is alive and working
  correctly; it is asking for less traffic. It is therefore the ONE class that
  may be retried against the same backend, and it is explicitly NOT counted
  against the circuit breaker. Tripping the breaker on a 429 would send the
  burst somewhere else entirely — the opposite of what the backend asked for.
- **`corrupt_state` aborts the whole operation.** Everything else is about one
  backend; this is about the local record, and continuing past it would write
  decisions on top of state nobody can trust.

---

## 3. The two fail-policy axes

Capability and health are different questions and get different answers.

| Axis | The question | Unknown state | Behaviour |
|---|---|---|---|
| **Capability** | can this backend do this at all? | `UNKNOWN` | **Fail closed** — refuse; do not attempt |
| **Health** | is this backend currently serving? | every candidate unhealthy | **Fail open** — attempt anyway, record the outcome |
| **Budget** | is there time left? | exhausted | **Fail closed** — stop the chain |
| **Contract** | did the backend obey its contract? | unparseable | **Fail closed for that backend, open across the chain** |

These are constants, not configuration. An operator must not be able to
configure the unsafe combination, and `FAIL_POLICY` in the kernel records them
so the intent is machine-readable.

---

## 4. The exit code is not the answer

A documented behaviour of at least one major agent CLI is to **exit 0 after a
mid-stream provider failure** — the prompt was accepted, then the upstream
call failed. A wrapper that classified on exit code alone would report that
failure as a success.

So classification combines every signal, strongest first:

1. an explicit `failureClass` the wrapper already knows;
2. a **structured error envelope** recovered from the backend's output — the
   backend knows more than the wrapper does;
3. the timeout / cancellation signal (unambiguous);
4. the exit code (weakest — it cannot distinguish success from a mid-stream
   failure reported as exit 0).

The envelope shapes the parser understands are in `cli/src/delegate.ts`
(`parseErrorEnvelope`): an OpenCode-style `{"type":"error","error":{…}}`
event, a Claude-Code-style `{"is_error":true,"subtype":…}` result, and a bare
`{"error":{…}}` object.

---

## 5. Fallback legality: the `committed` flag

A delegated agent turn can mutate the workspace. Once **any** of the turn's
output has been committed to the host:

- switching to a different backend would splice two different answers
  together, and
- it would re-run whatever the first backend had already done.

So the chain is **closed** from the first committed byte. `fallbackLegal()` in
the kernel encodes this, and the `committed` field is on every telemetry
event so the log distinguishes "fell back safely" from "failed after commit".

This is the single most-missed detail in delegation wrappers, and it is
cheap to get right: it is one boolean.

---

## 6. Circuit breaker

| State | Meaning | Admitted attempts |
|---|---|---|
| `closed` | healthy | all |
| `open` | failing | none, until the cooldown elapses |
| `half_open` | trial | **exactly one** |

A breaker that lets a burst through "because it is half-open" is not a
breaker. The half-open state claims its trial slot at the moment the cooldown
elapses, not at the moment the attempt is recorded.

**Rate limits and cancellations do not count against the breaker.** A
rate-limited backend is alive; a cancelled request was the caller's doing.

The breaker is deliberately free of I/O and of wall-clock reads — the caller
supplies `now` — so every transition is testable without waiting.

---

## 7. Install-time failures

| Failure | What the installer does | Why |
|---|---|---|
| The destination already exists with unmanaged content | **Refuse** the install | A matching plugin name is not ownership. Ownership is proven by an installation ID plus the managed-file hashes. |
| The destination is owned by another installation | **Refuse** the install | Two installs of the same plugin would race for the same files. |
| A destination path escapes the authorized root (symlink, junction, reparse point) | **Refuse** with a `SecurityError` | The path is not the one the user thinks it is. |
| A JSON config is unparseable | **Refuse** the merge, leave the file alone | Replacing it with `{}` would destroy the user's configuration. |
| A marker block is unterminated | **Throw** | Stripping it would silently delete everything after it. |
| A failure during the mutation phase | **Roll back** every destination from its backup | A partial install is worse than no install: the user cannot tell what state they are in. |
| A post-mutation hash does not match | **Roll back** and abort | The write did not land as intended. |
| The journal is corrupt | **Throw** — never fall back to legacy cleanup | The journal is the only record of which bytes the plugin owns. Guessing would delete user data. |
| A journaled file was edited after the install | **Abort the whole uninstall** before any mutation | The user's edit wins over the plugin's cleanup. |

The install pipeline is transactional:
`preflight → stage → intent → backup → apply → verify → commit`.
Any failure after `stage` restores every destination.

---

## 8. Runtime (hook) failures

| Failure | Exit code | Behaviour |
|---|---|---|
| The handler returned a result | 0 | Success. |
| The handler returned `block: true` | 2 (Antigravity: `decision: "deny"`, exit 0) | The host is denied. |
| The handler threw, `failurePolicy: "non-blocking"` (default) | 0, with a stderr note | The host continues. A plugin must not break the host. |
| The handler threw, `failurePolicy: "blocking"` | 2 (Antigravity: `decision: "deny"`, exit 0) | The host is denied — the plugin asked for that. |
| The handler exceeded `timeoutSec` | as above | The runner calls `process.exit`, which tears down pending handler work. A bare `Promise.race` would leave the handler running. |
| The handler could not be imported | as above | Same policy as a throw. |
| The stdin was not JSON | 0, with a stderr note | The runner never breaks the host over its own parse failure. |
| The hook id is invalid | 1 | A protocol violation by the caller, not the handler. |

**The policy file.** `timeoutSec` and `failurePolicy` live in the manifest, but
the runner is dependency-free and never parses YAML. The BUILD step writes them
to `hooks/policies.json` in the bundle, and the runner reads that. The
resolution order is **payload override → `hooks/policies.json` → default**. A
malformed policy file is ignored, never fatal: a broken policy must not take
the host agent down with it.

---

## 9. Kernel (event log) failures

| Failure | What replay does | Why |
|---|---|---|
| A truncated final record | `INCOMPLETE` | A write that did not finish. |
| A frame whose length disagrees with its header | `INCOMPLETE` (short) / `REJECTED` (long) | The two mean different things. |
| A record whose content hash disagrees | `REJECTED` | Bytes that were changed. |
| A well-formed frame carrying something that is not an Event | `REJECTED` | Replay must not invent a valid event from an invalid one. |
| The same sequence twice | `REJECTED` — "duplicate sequence, broken writer" | A duplicate is a writer defect, not loss. |
| A missing sequence | Reported as a **gap** | A gap means loss. |
| Bytes after the highest recovered sequence | **Not** reported as a gap | They are indistinguishable from events that were never written; reporting them would invent losses. |

Gaps and duplicates are reported **separately**, because they demand different
responses: a gap means the state is incomplete; a duplicate means the writer
is wrong and more damage is likely.

---

## 10. Exit codes at a glance

| Code | Runner | `anyplugin delegate` |
|---|---|---|
| 0 | success (or a non-blocking failure) | success |
| 1 | runner error | internal error |
| 2 | blocked / a blocking-policy failure | — |
| 3 | — | *reserved for capability unknown* |
| 4 | invalid input | invalid input |
| 69 | — | no backend could serve the request (sysexits `EX_UNAVAILABLE`) |

---

## 11. Where each rule is enforced

| Rule | Enforced by | Test |
|---|---|---|
| The failure taxonomy and its behaviours | `packages/worker-runtime/src/telemetry/delegation.ts` | `delegation.test.ts` |
| Classification ignores a bare exit code | `classifyAttempt()` | `delegation.test.ts`, `cli/src/delegate.test.ts` |
| Fallback is illegal after a commit | `fallbackLegal()` / `canFallback()` | `delegation.test.ts` |
| Half-open admits exactly one trial | `CircuitBreaker.canAttempt()` | `delegation.test.ts` |
| The two fail-policy axes | `FAIL_POLICY` | `delegation.test.ts` |
| Never a shell | `cli/src/delegate.ts` (`spawn`, `shell: false`) | `cli/src/delegate.test.ts` |
| A deadline and an output cap | `cli/src/delegate.ts` | `cli/src/delegate.test.ts` |
| The environment is an allowlist | `childEnv()` | `cli/src/delegate.test.ts` |
| Install rollback | `cli/src/transaction.ts` | `cli/src/install-transactional-audit.test.ts` |
| The journal is never guessed at | `cli/src/journal.ts` | `cli/src/journal-validation-audit.test.ts`, `cli/src/journal-migration-audit.test.ts` |
| The runtime policy file | `core/src/events/index.ts` | `plugins/knowledge/runtime/runner-*-audit.test.ts` |
| Replay accounts for every byte | `packages/worker-runtime/src/log/replay.ts` | `packages/worker-runtime/src/log/*.test.ts` |
