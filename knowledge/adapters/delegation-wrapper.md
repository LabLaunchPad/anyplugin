---
type: Adapter Design
title: The delegation wrapper — AnyPlugin as a front door to other runtimes
description: How `anyplugin delegate` routes work to heterogeneous external runtimes and CLIs, and how the delegation telemetry contract makes those attempts replayable and auditable rather than scattered log lines.
tags: [delegation, wrapper, routing, telemetry, backends, circuit-breaker]
status: stable
generated:
  by: anyplugin/design@0.1.1
  at: 2026-10-20T10:00:00+00:00
sources:
  - resource: https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/
    id: "1"
    title: OpenTelemetry GenAI semantic conventions — attribute registry
  - resource: https://docs.litellm.ai/docs/proxy/health_check_routing
    id: "2"
    title: LiteLLM — health checks and routing
  - resource: https://learn.microsoft.com/en-us/azure/architecture/patterns/circuit-breaker
    id: "3"
    title: Azure Architecture Center — Circuit Breaker pattern
  - resource: https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html
    id: "4"
    title: AWS SDK — retry behaviour (full jitter)
  - resource: https://agentclientprotocol.com/protocol/v1/overview
    id: "5"
    title: Agent Client Protocol
---

# The delegation wrapper

## The problem it solves

A user with four coding agents installed, plus a CLI tool, plus a model API,
has four incompatible front doors. Every one of them has its own flags, its own
output format, its own failure vocabulary, and its own idea of what "the
request failed" means.

A wrapper gives them ONE front door, and records what happened behind it.

## The shape

```
registry (declarative) → probe → route → delegate safely → record telemetry
```

**Identity, capability, and policy are three different things** and live in
three different places. The registry holds identity ("this is `claude`, it is
invoked as `claude --print`") and capability ("it declares `code` as NATIVE").
Policy — order, budgets, failure handling — lives in the wrapper, not in the
data. Conflating them is the most common design mistake in routing systems:
identity changes when the upstream tool changes, policy changes when the
operator changes their mind, and a file that holds both cannot be updated
independently.

## The rules that make it safe

| Rule | Why it exists |
|---|---|
| **Never a shell** | The command and its arguments go to `spawn` as an argv array. A backend argument is data, never syntax. |
| **Never unbounded** | Every attempt has a deadline and an output cap. A backend that produces gigabytes must not be able to exhaust the host. |
| **Never an unbounded environment** | The child gets an allowlist. A blocklist has to anticipate every secret; an allowlist only names the ones that are meant. |
| **Never a silent failure** | Every attempt produces a classified event, including the ones that could not be classified. |
| **Never a fallback after the turn committed** | See below. |

## The exit code is not the answer

At least one major agent CLI exits **0** after a mid-stream provider failure:
the prompt was accepted, then the upstream call failed. A wrapper that
classified on the exit code alone would report that failure as a success.

So classification combines every signal, strongest evidence first:

1. an explicit `failureClass` the wrapper already knows;
2. a **structured error envelope** from the backend's output — the backend knows
   more about its own failure than the wrapper does;
3. the timeout / cancellation signal, which is unambiguous;
4. the exit code, which is the weakest signal because it cannot distinguish
   success from a mid-stream failure reported as exit 0.

## The `committed` flag

A delegated agent turn can mutate the workspace. Once **any** of the turn's
output has been committed to the host:

- switching to a different backend would splice two different answers together,
  and
- it would re-run whatever the first backend had already done.

So the fallback chain is **closed** from the first committed byte. This is the
single most-missed detail in delegation wrappers, and it is cheap to get
right: one boolean on the attempt, checked before the chain advances.

**But one boolean is not enough, and the missing case is the dangerous one.**
A turn can have committed an **effect** — a file written, a request sent, a
card charged — while producing no output at all. Re-running the task would
repeat that effect. So the rule is three clauses, and an **unknown** effect
state closes the chain, because "probably not" is not "no":

```
fallbackLegal(attempt) ⇔ no COMMIT_POINT exists
                        ∧ no output was HANDED TO THE HOST
                        ∧ the effect state is KNOWN and is NONE
```

The three signals are distinct and must stay distinct: *committed to the
host* is irreversible, *produced an answer* is a presentation fact, and
*effect state* is the safety fact. Conflating the first two stops the chain
from ever falling back, because nearly every backend prints something.

## Two fail-policy axes

Capability and health are different questions and get different answers.

| Axis | Question | Unknown state | Behaviour |
|---|---|---|---|
| **Capability** | can this backend do this at all? | `UNKNOWN` | **fail closed** — refuse, do not attempt |
| **Health** | is this backend currently serving? | all unhealthy | **fail open** — attempt anyway, record the outcome |

Failing closed on health takes the system down. Failing open on capability lets
it corrupt things. Conflating the two axes is a bug, and they are constants
rather than configuration precisely so an operator cannot configure the unsafe
combination.

## The circuit breaker

Three states: `closed` (healthy), `open` (failing, no attempts admitted),
`half_open` (exactly **one** trial attempt admitted).

A breaker that lets a burst through "because it is half-open" is not a breaker.
The half-open state claims its trial slot when the cooldown elapses, not when
the attempt is recorded.

**A rate limit is not a health failure.** The backend is alive and asking for
less traffic; counting a 429 against the breaker would send the burst
somewhere else entirely — the opposite of what the backend asked for.

## Where the telemetry goes

The worker-runtime event log, not a log file. That is the whole point: the
delegation becomes framed, hashed, byte-accounted state that `replay` can
recover and that a fold can summarise, rather than lines in a file nobody
can audit.

**What is true today, stated exactly.** The event vocabulary is closed and an
event is produced for every attempt, but the events are **not yet
persisted**: `anyplugin delegate` reports them through `--json` and otherwise
drops them. Persisting them needs the delegation event kinds in the frozen
`EventSchema`, which is a versioned migration (`docs/BACKLOG.md` P1-11,
P1-14). Until that lands, "the telemetry goes to the event log" is the
*intent*, not the behaviour.

The event vocabulary is small and closed: `BACKEND_PROBED`, `ROUTE_SELECTED`,
`FALLBACK_SELECTED`, `DELEGATION_STARTED`, `DELEGATION_SUCCEEDED`,
`DELEGATION_FAILED`, `CIRCUIT_OPENED`, `CIRCUIT_CLOSED`, `CIRCUIT_HALF_OPEN`.

## What it does NOT do

- It does not call a model on the user's behalf by default. A backend is a
  process the user already trusts; the wrapper runs it and observes it.
- It does not retry at more than one layer. Layered retries multiply: five
  layers retrying three times each is 243× the load. The wrapper is the only
  place a retry may live.
- It does not capture prompts or outputs by default. Content capture is an
  explicit opt-in, and the telemetry event carries no content fields at all.
