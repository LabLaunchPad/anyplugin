import { describe, it, expect } from "vitest";
import {
  CircuitBreaker,
  DEFAULT_CIRCUIT_POLICY,
  DELEGATION_EVENT_TYPES,
  FAILURE_BEHAVIOUR,
  DELEGATION_FAILURE_CLASSES,
  FAILURE_SPECS,
  FAIL_POLICY,
  FALLBACKABLE_FAILURES,
  canFallback,
  classifyAttempt,
  classifyErrorCode,
  classifyFailure,
  classifyHttpStatus,
  delegationEvent,
  delegationEventId,
  fallbackLegal,
  failureSpec,
  type DelegationFailureClass,
} from "./delegation.js";

/**
 * Delegation telemetry contract — the taxonomy, the classifier, and the
 * circuit breaker.
 *
 * The properties under test are the ones that keep a wrapper honest:
 *   - every failure class has exactly ONE prescribed behaviour
 *   - an unclassifiable failure is NOT retryable (guessing is how one failure
 *     becomes two)
 *   - a rate-limited backend is not treated as a failing one
 *   - half-open permits exactly ONE trial attempt
 */

describe("failure taxonomy", () => {
  it("gives every class exactly one behaviour", () => {
    for (const cls of DELEGATION_FAILURE_CLASSES) {
      expect(FAILURE_BEHAVIOUR[cls]).toBeDefined();
      const spec = failureSpec(cls);
      expect(spec.class).toBe(cls);
      expect(spec.behaviour).toBe(FAILURE_BEHAVIOUR[cls]);
    }
    expect(FAILURE_SPECS).toHaveLength(DELEGATION_FAILURE_CLASSES.length);
  });

  it("lets only genuinely per-backend failures fall back", () => {
    // A credential rejection will fail identically on every backend.
    expect(failureSpec("auth").mayFallback).toBe(false);
    expect(failureSpec("quota").mayFallback).toBe(false);
    expect(failureSpec("protocol_violation").mayFallback).toBe(false);
    expect(failureSpec("capability_unknown").mayFallback).toBe(false);
    // These are about THIS backend, so another one may work.
    expect(failureSpec("timeout").mayFallback).toBe(true);
    expect(failureSpec("refused").mayFallback).toBe(true);
    expect(failureSpec("spawn_failed").mayFallback).toBe(true);
    expect(failureSpec("upstream_unavailable").mayFallback).toBe(true);
  });

  it("never retries an unclassified failure", () => {
    // The decisive property: guessing that an unknown error is "probably a
    // timeout" and retrying it elsewhere multiplies one failure into two.
    expect(failureSpec("unknown").mayFallback).toBe(false);
    expect(failureSpec("unknown").mayRetrySame).toBe(false);
    expect(failureSpec("unknown").behaviour).toBe("report");
  });

  it("only allows a same-backend retry when the backend asked us to wait", () => {
    const retryable = FAILURE_SPECS.filter((s) => s.mayRetrySame);
    expect(retryable.map((s) => s.class)).toEqual(["rate_limited"]);
  });

  it("aborts the whole operation when local state is corrupt", () => {
    expect(failureSpec("corrupt_state").behaviour).toBe("abort");
  });

  it("exposes the fallbackable set consistently", () => {
    const fromSpecs = new Set(FAILURE_SPECS.filter((s) => s.mayFallback).map((s) => s.class));
    expect(new Set(FALLBACKABLE_FAILURES)).toEqual(fromSpecs);
  });
});

describe("failure classification", () => {
  it("prefers an explicit failureClass on the error", () => {
    const err = Object.assign(new Error("x"), { failureClass: "quota", code: "ECONNREFUSED" });
    expect(classifyFailure(err)).toBe("quota");
  });

  it("classifies Node error codes", () => {
    expect(classifyErrorCode("ETIMEDOUT")).toBe("timeout");
    expect(classifyErrorCode("ECONNREFUSED")).toBe("refused");
    expect(classifyErrorCode("ENOENT")).toBe("spawn_failed");
    expect(classifyErrorCode("EACCES")).toBe("spawn_failed");
    expect(classifyErrorCode("ECONNRESET")).toBe("upstream_unavailable");
    expect(classifyErrorCode("SOMETHING_NEW")).toBe("unknown");
  });

  it("classifies HTTP statuses", () => {
    expect(classifyHttpStatus(401)).toBe("auth");
    expect(classifyHttpStatus(403)).toBe("auth");
    expect(classifyHttpStatus(402)).toBe("quota");
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(408)).toBe("timeout");
    expect(classifyHttpStatus(504)).toBe("timeout");
    expect(classifyHttpStatus(503)).toBe("upstream_unavailable");
    expect(classifyHttpStatus(400)).toBe("protocol_violation");
  });

  it("classifies an unrecognised error as unknown, not as a guess", () => {
    expect(classifyFailure(new Error("who knows"))).toBe("unknown");
    expect(classifyFailure("a string")).toBe("unknown");
    expect(classifyFailure(undefined)).toBe("unknown");
    expect(classifyFailure({ code: "WAT" })).toBe("unknown");
  });

  it("classifies a timeout-named error", () => {
    const err = new Error("timed out");
    err.name = "TimeoutError";
    expect(classifyFailure(err)).toBe("timeout");
  });

  it("classifies an abort as cancelled", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(classifyFailure(err)).toBe("cancelled");
  });

  it("prefers an HTTP status over a generic code when both are present", () => {
    const err = Object.assign(new Error("x"), { status: 429, code: "ECONNRESET" });
    expect(classifyFailure(err)).toBe("rate_limited");
  });

  it("rejects an invalid explicit failureClass rather than trusting it", () => {
    const err = Object.assign(new Error("x"), { failureClass: "totally-made-up" });
    expect(classifyFailure(err)).toBe("unknown");
  });

  it("classifies every class the taxonomy declares", () => {
    // Round-trip: every declared class is one the classifier can produce.
    const produced = new Set<DelegationFailureClass>();
    for (const cls of DELEGATION_FAILURE_CLASSES) {
      produced.add(classifyFailure(Object.assign(new Error("x"), { failureClass: cls })));
    }
    expect(produced.size).toBe(DELEGATION_FAILURE_CLASSES.length);
  });
});

describe("circuit breaker", () => {
  it("starts closed and allows attempts", () => {
    const cb = new CircuitBreaker();
    expect(cb.state).toBe("closed");
    expect(cb.canAttempt(0)).toBe(true);
  });

  it("opens after the failure threshold", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, successThreshold: 1 });
    cb.recordFailure("timeout", 0);
    cb.recordFailure("timeout", 0);
    expect(cb.state).toBe("closed");
    cb.recordFailure("timeout", 0);
    expect(cb.state).toBe("open");
    expect(cb.canAttempt(500)).toBe(false);
  });

  it("enters half-open after the cooldown and allows exactly ONE trial", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, successThreshold: 1 });
    cb.recordFailure("timeout", 0);
    expect(cb.state).toBe("open");
    expect(cb.canAttempt(999)).toBe(false);
    expect(cb.canAttempt(1000)).toBe(true);
    expect(cb.state).toBe("half_open");
    // A burst must not slip through "because it is half-open".
    expect(cb.canAttempt(1000)).toBe(false);
  });

  it("closes after a successful half-open trial", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, successThreshold: 1 });
    cb.recordFailure("timeout", 0);
    cb.canAttempt(1000);
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.consecutiveFailures).toBe(0);
  });

  it("reopens immediately when the half-open trial fails", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, successThreshold: 1 });
    cb.recordFailure("timeout", 0);
    cb.canAttempt(1000);
    cb.recordFailure("timeout", 1000);
    expect(cb.state).toBe("open");
    expect(cb.canAttempt(1001)).toBe(false);
  });

  it("needs several half-open successes to close when the policy says so", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, successThreshold: 2 });
    cb.recordFailure("timeout", 0);
    cb.canAttempt(1000);
    cb.recordSuccess();
    expect(cb.state).toBe("half_open");
    cb.canAttempt(1001);
    cb.recordSuccess();
    expect(cb.state).toBe("closed");
  });

  it("does NOT count a rate limit against the backend's health", () => {
    // A rate-limited backend is alive and asking for less traffic. Tripping
    // the breaker here would send the burst somewhere else entirely.
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1000, successThreshold: 1 });
    cb.recordFailure("rate_limited", 0);
    cb.recordFailure("rate_limited", 0);
    expect(cb.state).toBe("closed");
    expect(cb.consecutiveFailures).toBe(0);
  });

  it("does not count a cancellation against the backend's health", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, successThreshold: 1 });
    cb.recordFailure("cancelled", 0);
    expect(cb.state).toBe("closed");
  });

  it("isRefusing is read-only and does not claim the half-open trial", () => {
    // The bug this prevents: a caller that merely ASKS whether a backend is
    // reachable must not consume the single half-open trial. If it did, a
    // candidate that was considered and passed over could never be tried.
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, successThreshold: 1 });
    cb.recordFailure("timeout", 0);
    expect(cb.isRefusing(0)).toBe(true);
    expect(cb.isRefusing(1000)).toBe(false); // the cooldown has elapsed
    // The state is still OPEN — asking did not transition it.
    expect(cb.state).toBe("open");
    // And the trial slot was NOT claimed.
    expect(cb.canAttempt(1000)).toBe(true);
    expect(cb.state).toBe("half_open");
  });

  it("isRefusing reports half-open as refusing while a trial is in flight", () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1000, successThreshold: 1 });
    cb.recordFailure("timeout", 0);
    cb.canAttempt(1000); // claims the trial
    expect(cb.isRefusing(1000)).toBe(true);
  });

  it("resets the failure count on success", () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000, successThreshold: 1 });
    cb.recordFailure("timeout", 0);
    cb.recordFailure("timeout", 0);
    cb.recordSuccess();
    expect(cb.consecutiveFailures).toBe(0);
    expect(cb.state).toBe("closed");
  });

  it("rejects an impossible policy", () => {
    expect(() => new CircuitBreaker({ failureThreshold: 0, cooldownMs: 1, successThreshold: 1 })).toThrow();
    expect(() => new CircuitBreaker({ failureThreshold: 1, cooldownMs: -1, successThreshold: 1 })).toThrow();
    expect(() => new CircuitBreaker({ failureThreshold: 1, cooldownMs: 1, successThreshold: 0 })).toThrow();
  });

  it("has a sane default policy", () => {
    expect(DEFAULT_CIRCUIT_POLICY.failureThreshold).toBeGreaterThan(0);
    expect(DEFAULT_CIRCUIT_POLICY.cooldownMs).toBeGreaterThan(0);
    expect(DEFAULT_CIRCUIT_POLICY.successThreshold).toBeGreaterThan(0);
  });
});

describe("attempt classification — never trust the exit code alone", () => {
  it("reports a mid-stream failure that the backend exited 0 on", () => {
    // The observed behaviour of at least one major agent CLI: the prompt was
    // accepted, the upstream call failed, and the process still exited 0.
    // A wrapper that classified on exit code alone would call this a success.
    const cls = classifyAttempt({
      exitCode: 0,
      envelope: { name: "APIError", status: 400, isRetryable: false },
    });
    expect(cls).not.toBe("unknown");
    expect(cls).toBe("protocol_violation");
  });

  it("prefers the backend's own error envelope over the exit code", () => {
    expect(
      classifyAttempt({ exitCode: 1, envelope: { name: "RateLimitError", status: 429 } }),
    ).toBe("rate_limited");
  });

  it("uses a normalized provider reason when there is one", () => {
    expect(classifyAttempt({ exitCode: 1, envelope: { name: "X", reason: "quota_exceeded" } })).toBe("quota");
    expect(classifyAttempt({ exitCode: 1, envelope: { name: "X", reason: "usage_limit_reached" } })).toBe("quota");
    expect(classifyAttempt({ exitCode: 1, envelope: { name: "X", reason: "rate_limited" } })).toBe("rate_limited");
    expect(classifyAttempt({ exitCode: 1, envelope: { name: "X", reason: "overloaded" } })).toBe("rate_limited");
  });

  it("lets the timeout signal outrank everything else", () => {
    expect(
      classifyAttempt({ exitCode: 0, timedOut: true, envelope: { name: "APIError", status: 500 } }),
    ).toBe("timeout");
  });

  it("reports a cancellation as cancelled", () => {
    expect(classifyAttempt({ exitCode: 1, cancelled: true })).toBe("cancelled");
  });

  it("treats a non-zero exit without an envelope as a backend failure, not a guess", () => {
    // The exit code says SOMETHING went wrong but not what. We do NOT invent a
    // cause — but we DO know the backend failed, and "this backend failed" is
    // exactly what a fallback is for. `unknown` would mean "we cannot even
    // tell that a failure occurred", which is not true here.
    expect(classifyAttempt({ exitCode: 1 })).toBe("backend_failed");
    expect(classifyAttempt({ exitCode: 2 })).toBe("backend_failed");
    // And a backend failure IS fallback-able.
    expect(failureSpec("backend_failed").mayFallback).toBe(true);
    // ...while a genuinely unclassifiable failure is not.
    expect(failureSpec("unknown").mayFallback).toBe(false);
  });

  it("recognises the conventional timeout and spawn exit codes", () => {
    expect(classifyAttempt({ exitCode: 124 })).toBe("timeout");
    expect(classifyAttempt({ exitCode: 126 })).toBe("spawn_failed");
    expect(classifyAttempt({ exitCode: 127 })).toBe("spawn_failed");
    expect(classifyAttempt({ exitCode: 137 })).toBe("timeout");
  });
});

describe("fallback legality", () => {
  it("allows a fallback only when the effect state is KNOWN to be none", () => {
    expect(fallbackLegal({ effect: "NONE" })).toBe(true);
    expect(canFallback({ exitCode: 1 }, "timeout", "NONE")).toBe(true);
  });

  it("forbids a fallback when the effect state is UNKNOWN", () => {
    // The backend ran. It may have written a file, sent a request, or charged
    // a card before it failed, and the wrapper cannot tell which. "Probably
    // not" is not "no", so the fallback is refused.
    //
    // This is the clause D-013 leaves implicit: "no EFFECT in {IN_FLIGHT,
    // COMMITTED}" silently treats `unknown` as `none`.
    expect(fallbackLegal({ effect: "UNKNOWN" })).toBe(false);
    expect(canFallback({ exitCode: 1 }, "timeout", "UNKNOWN")).toBe(false);
  });

  it("forbids a fallback for an effect that is in flight or committed", () => {
    expect(fallbackLegal({ effect: "IN_FLIGHT" })).toBe(false);
    expect(fallbackLegal({ effect: "COMMITTED" })).toBe(false);
  });

  it("forbids a fallback once the turn has committed output", () => {
    // A committed turn is terminal: another backend would splice two answers
    // together and re-run whatever the first one already did.
    expect(fallbackLegal({ effect: "NONE", committed: true })).toBe(false);
    expect(canFallback({ exitCode: 1, committed: true }, "timeout", "NONE")).toBe(false);
  });

  it("forbids a fallback when a commit point exists", () => {
    expect(fallbackLegal({ effect: "NONE", commitPoint: true })).toBe(false);
  });

  it("never falls back for a failure that is not about this backend", () => {
    expect(canFallback({ exitCode: 1 }, "auth", "NONE")).toBe(false);
    expect(canFallback({ exitCode: 1 }, "quota", "NONE")).toBe(false);
    expect(canFallback({ exitCode: 1 }, "unknown", "NONE")).toBe(false);
  });
});

describe("the two fail-policy axes", () => {
  it("fails CLOSED on an unknown capability", () => {
    expect(FAIL_POLICY.onCapabilityUnknown).toBe("fail_closed");
  });

  it("fails OPEN on health — refusing everything is a self-inflicted outage", () => {
    expect(FAIL_POLICY.onAllBackendsUnhealthy).toBe("fail_open");
  });

  it("fails CLOSED when the deadline budget is exhausted", () => {
    expect(FAIL_POLICY.onBudgetExhausted).toBe("fail_closed");
  });
});

describe("delegation events", () => {
  const base = {
    type: "DELEGATION_STARTED" as const,
    backendId: "claude",
    attempt: 1,
    at: 1_700_000_000_000,
  };

  it("accepts a well-formed event", () => {
    const e = delegationEvent(base);
    expect(e.backendId).toBe("claude");
    expect(e.attempt).toBe(1);
  });

  it("rejects an unknown event type", () => {
    expect(() => delegationEvent({ ...base, type: "MADE_UP" })).toThrow(/invalid delegation event/);
  });

  it("rejects a negative attempt number", () => {
    expect(() => delegationEvent({ ...base, attempt: 0 })).toThrow(/invalid delegation event/);
  });

  it("rejects a failure class outside the taxonomy", () => {
    expect(() => delegationEvent({ ...base, failureClass: "nope" })).toThrow(/invalid delegation event/);
  });

  it("gives every event type a distinct name", () => {
    expect(new Set(DELEGATION_EVENT_TYPES).size).toBe(DELEGATION_EVENT_TYPES.length);
  });

  it("produces a stable id so re-appending is idempotent", () => {
    const e = delegationEvent(base);
    expect(delegationEventId(e)).toBe(delegationEventId(e));
    expect(delegationEventId(e)).not.toBe(delegationEventId({ ...e, attempt: 2 }));
  });
});
