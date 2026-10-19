---
type: Reference
title: Failure-mode catalogue — what goes wrong and what the system does
description: The single catalogue of failure classes across the install, runtime, delegation, and kernel paths, with the behaviour each class mandates. A failure that cannot be classified is never retried.
tags: [failure-modes, error-handling, taxonomy, fail-closed, rollback, telemetry]
status: stable
generated:
  by: anyplugin/design@0.1.1
  at: 2026-10-20T10:00:00+00:00
sources:
  - resource: https://cwe.mitre.org/data/definitions/367.html
    id: "1"
    title: CWE-367 — Time-of-check Time-of-use (TOCTOU) Race Condition
  - resource: https://man.openbsd.org/sysexits
    id: "2"
    title: sysexits — conventional exit codes
  - resource: https://github.com/ossf/fuzz-introspector
    id: "3"
    title: OpenSSF — fuzzing and negative testing practice
---

# Failure-mode catalogue

The full table lives in `docs/FAILURE-MODES.md`. This concept records the
*shape* of the catalogue and the reasoning that produced it, so the reasoning
survives even if the table is reorganised.

## The governing idea

**A failure that cannot be classified is not retried.**

This looks wasteful, and it is deliberate. A wrapper that guesses "this
unrecognised error is probably a timeout" and retries it against a second
backend has not recovered — it has converted one failure into two, without
evidence. Guessing a failure mode is how a single bad turn becomes a cascade.

## Three things that are often conflated

| | Meaning | Example |
|---|---|---|
| **we know it failed** | the failure is real and observed | the backend exited non-zero |
| **we know why** | the cause is identified | the envelope says `statusCode: 429` |
| **we know it is about THIS backend** | another backend might work | it is unreachable, not your request is malformed |

"Failed" is enough to fall back. "Failed and it is the request's fault" is
not. "Failed and we do not know" is not either — a wrapper that cannot
classify a failure cannot promise the next one is different.

## The four classes of entry

A backlog entry is one of:

| Class | Meaning | Definition of done |
|---|---|---|
| **BUG** | the code does something other than what the contract says | a regression test exists that fails without the fix |
| **ERROR** | an error is produced where none should be, or is produced wrongly | the error is correct, specific, and actionable |
| **BEHAVIOUR** | intentional but surprising, undocumented, or inconsistent with a sibling | it is documented in one place and a test pins it |
| **GODEL** | documented, deliberate, and not changing now | it says so, findably |
| **DEBT** | structural, not a defect | scheduled |
| **GAP** | something missing the product needs | scoped and owned |

The class matters because it changes what "done" means. A BUG needs a test. A
BEHAVIOUR needs a document and a test. A GAP needs a scope and an owner.

## Negative cases are the point

A wrapper that only works on the happy path is a wrapper that will one day
run something it should not. The negative cases that matter most, in the order
they have bitten:

1. **The output was already committed.** A fallback then splices two answers
   and re-runs side effects. Guarded by the `committed` flag.
2. **The exit code says success but the work failed.** A backend can exit 0
   after a mid-stream failure. Guarded by parsing the error envelope.
3. **The destination already exists and is not ours.** A matching plugin name
   is not ownership. Guarded by the installation-ID ownership proof.
4. **The journal is corrupt.** It is the only record of which bytes the
   plugin owns, so it is never guessed at. Guarded by failing closed.
5. **The path escapes the authorized root.** A symlink, a junction, a
   reparse point. Guarded by realpath containment.
6. **The write landed but is not what was intended.** Guarded by the
   post-mutation hash verification, and by rolling back.
7. **The failure is about the request, not the backend.** Auth and quota fail
   identically everywhere. Guarded by the class taxonomy, which says whether
   falling back is even legal.

## The rule that makes the catalogue growable

A new failure class may not be added without saying what the system DOES about
it. A taxonomy that lists causes without prescribing responses is a list of
excuses, not a contract.

That is why `DELEGATION_FAILURE_CLASSES` in
`packages/worker-runtime/src/telemetry/delegation.ts` pairs every class with
exactly one behaviour — `fallback`, `retry_after`, `report`, or `abort` — and
why the behaviour is a property of the CLASS rather than a decision left to
each caller. Two components that classify the same failure cannot disagree,
because neither of them gets to choose.
