/**
 * Delegation telemetry — the contract for a wrapper that drives OTHER runtimes.
 *
 * ── Why this lives in the kernel ────────────────────────────────────────────
 *
 * A wrapper that delegates to heterogeneous backends and records what happened
 * is producing authoritative state about executions. If that state lives in
 * ad-hoc log files, it cannot be replayed, its bytes cannot be accounted for,
 * and two components can disagree about what happened without either being
 * detectably wrong. So the telemetry CONTRACT is a kernel concern: it is
 * framed, hashed, replayable and byte-accounted like every other event.
 *
 * The kernel still knows nothing about any agent, any CLI, or AnyPlugin. It
 * knows about backends in the abstract: a backend has an id, it can be
 * attempted, it can fail in a bounded number of recognisable ways.
 *
 * ── The rule that shapes everything here ────────────────────────────────────
 *
 * `resource/telemetry.ts` already established the principle: a quantity is
 * MEASURED, DERIVED, ESTIMATED, ATTESTED, or UNKNOWN, and an UNKNOWN quantity
 * is never defaulted to a number. This module applies the same rule to
 * FAILURES. A failure that cannot be classified is `unknown` — and `unknown`
 * is NOT retryable. Guessing that an unclassified error is "probably a
 * timeout" and retrying it against a second backend is how a wrapper turns one
 * failure into two.
 *
 * ── What this module does NOT do ────────────────────────────────────────────
 *
 * It does not spawn processes, does not read a registry, and does not decide
 * policy. Those belong to the layer ABOVE the kernel (the wrapper). What lives
 * here is the vocabulary, the taxonomy, and the state machine — the parts that
 * must be identical no matter which wrapper uses them.
 */
import { z } from "zod";

/** The kinds of event a delegation layer records. */
export const DELEGATION_EVENT_TYPES = [
  /** A backend was checked for availability. */
  "BACKEND_PROBED",
  /** A backend was chosen for an attempt. */
  "ROUTE_SELECTED",
  /** A different backend was chosen after the previous one failed. */
  "FALLBACK_SELECTED",
  /** An attempt began. */
  "DELEGATION_STARTED",
  /** An attempt completed successfully. */
  "DELEGATION_SUCCEEDED",
  /** An attempt completed unsuccessfully. */
  "DELEGATION_FAILED",
  /** A backend's circuit opened after repeated failures. */
  "CIRCUIT_OPENED",
  /** A backend's circuit closed again after a success. */
  "CIRCUIT_CLOSED",
  /** A backend's circuit entered half-open: one trial attempt is allowed. */
  "CIRCUIT_HALF_OPEN",
] as const;

export type DelegationEventType = (typeof DELEGATION_EVENT_TYPES)[number];

/**
 * The failure taxonomy.
 *
 * Each class names what happened AND what the correct response is. The
 * response is part of the class, not a decision left to each caller: two
 * wrappers that classify the same failure must not disagree about whether to
 * try the next backend.
 */
export const DELEGATION_FAILURE_CLASSES = [
  /** The deadline elapsed before the backend answered. */
  "timeout",
  /** The backend could not be reached (connection refused, host down). */
  "refused",
  /** The backend could not be started at all (missing binary, not executable). */
  "spawn_failed",
  /**
   * The backend ran and failed, and did not say why.
   *
   * This is deliberately NOT `unknown`. We KNOW the backend failed — it ran
   * and returned a non-zero status. What we do not know is the cause, and
   * inventing a cause would be the guess this taxonomy exists to prevent. But
   * "the backend failed" is itself enough to try the next one: the failure
   * is about THIS backend, which is exactly what a fallback is for.
   */
  "backend_failed",
  /** The backend's own upstream is unavailable or erroring. */
  "upstream_unavailable",
  /** Credentials were rejected. */
  "auth",
  /** The account is out of quota or credit. */
  "quota",
  /** The request was rate limited. */
  "rate_limited",
  /** The backend answered with something that does not satisfy its contract. */
  "protocol_violation",
  /** The backend does not declare the capability the request needs. */
  "capability_unknown",
  /** Local state (a journal, a ledger) is damaged. */
  "corrupt_state",
  /** The caller cancelled the request. */
  "cancelled",
  /** The backend produced more output than the wrapper is willing to buffer. */
  "output_truncated",
  /** The failure could not be classified at all. */
  "unknown",
] as const;

export type DelegationFailureClass = (typeof DELEGATION_FAILURE_CLASSES)[number];

/**
 * What a wrapper MUST do when a failure of this class occurs.
 *
 * - `fallback`  — try the next candidate backend; the failure is about THIS
 *                 backend, not about the request.
 * - `retry_after`— the same backend may be retried, but only after a delay
 *                 the backend itself specified.
 * - `report`    — do not retry and do not fall back; the operator must see it.
 * - `abort`     — the whole operation must stop; the local state is suspect.
 */
export const FAILURE_BEHAVIOUR = {
  timeout: "fallback",
  refused: "fallback",
  spawn_failed: "fallback",
  backend_failed: "fallback",
  upstream_unavailable: "fallback",
  auth: "report",
  quota: "report",
  rate_limited: "retry_after",
  protocol_violation: "report",
  capability_unknown: "report",
  corrupt_state: "abort",
  cancelled: "report",
  output_truncated: "report",
  unknown: "report",
} as const satisfies Record<DelegationFailureClass, "fallback" | "retry_after" | "report" | "abort">;

export type FailureBehaviour = (typeof FAILURE_BEHAVIOUR)[DelegationFailureClass];

/** The full specification of one failure class. */
export interface FailureClassSpec {
  readonly class: DelegationFailureClass;
  /** The correct response. */
  readonly behaviour: FailureBehaviour;
  /** Whether ANOTHER backend may be attempted for the same request. */
  readonly mayFallback: boolean;
  /** Whether the SAME backend may be retried (only when the backend said when). */
  readonly mayRetrySame: boolean;
  /** What this class means, in one line. */
  readonly meaning: string;
}

const MEANINGS: Record<DelegationFailureClass, string> = {
  timeout: "the deadline elapsed before the backend answered",
  refused: "the backend could not be reached",
  spawn_failed: "the backend command could not be started",
  backend_failed: "the backend ran and failed without saying why",
  upstream_unavailable: "the backend's own upstream is unavailable",
  auth: "the backend rejected the supplied credentials",
  quota: "the account is out of quota or credit",
  rate_limited: "the backend asked the caller to slow down",
  protocol_violation: "the backend answered with something that violates its contract",
  capability_unknown: "the backend does not declare the required capability",
  corrupt_state: "local state is damaged and cannot be trusted",
  cancelled: "the request was cancelled by the caller",
  output_truncated: "the backend produced more output than the wrapper will buffer",
  unknown: "the failure could not be classified and is therefore not retried",
};


/** The taxonomy, derived once so the two tables can never disagree. */
export const FAILURE_SPECS: readonly FailureClassSpec[] = DELEGATION_FAILURE_CLASSES.map((cls) => {
  const behaviour = FAILURE_BEHAVIOUR[cls];
  return {
    class: cls,
    behaviour,
    mayFallback: behaviour === "fallback",
    mayRetrySame: behaviour === "retry_after",
    meaning: MEANINGS[cls],
  };
});

/** Look up a class specification. */
export function failureSpec(cls: DelegationFailureClass): FailureClassSpec {
  const spec = FAILURE_SPECS.find((s) => s.class === cls);
  if (!spec) throw new Error(`unknown failure class: ${cls}`);
  return spec;
}
/** The set of failures for which another backend may be tried. */
export const FALLBACKABLE_FAILURES: readonly DelegationFailureClass[] = FAILURE_SPECS.filter((s) => s.mayFallback).map((s) => s.class);

/**
 * What a wrapper observed about one attempt.
 *
 * The exit code is only ONE of the signals, and it is the weakest: a
 * documented behaviour of at least one major agent CLI is to exit 0 after a
 * mid-stream provider failure, because the prompt was accepted and only the
 * upstream call failed. A wrapper that classified on exit code alone would
 * report that failure as a success.
 */
export interface AttemptObservation {
  /** The process exit code, or null when the process was killed by a signal. */
  readonly exitCode: number | null;
  /** The signal that killed the process, when one did. */
  readonly signal?: string | null;
  /** Whether the attempt hit its deadline. */
  readonly timedOut?: boolean;
  /** Whether the caller cancelled the attempt. */
  readonly cancelled?: boolean;
  /** A structured error envelope recovered from the backend's output. */
  readonly envelope?: DelegationErrorEnvelope | null;
  /**
   * Whether any of the attempt's output was committed to the host.
   *
   * "Committed to the host" means the host HAS it — a streaming wrapper that
   * forwarded bytes as they arrived. It is NOT the same as "the attempt
   * produced output": a buffered wrapper holds its output until the attempt
   * ends. Only the first is irreversible.
   */
  readonly committed?: boolean;
  /**
   * Whether the attempt produced an answer at all.
   *
   * Not a gate on the fallback — see `fallbackLegal`. It is recorded so the
   * telemetry can distinguish "produced nothing" from "produced something
   * that was discarded", and so a presentation layer knows which attempt's
   * output is the answer.
   */
  readonly outputProduced?: boolean;
}

/**
 * A structured error envelope, as recovered from a backend's output.
 *
 * The shape is the COMMON denominator across the backends worth wrapping:
 * a machine-readable name, an optional HTTP-like status, an optional
 * retryability hint, and an optional provider-specific reason.
 */
export interface DelegationErrorEnvelope {
  /** The error name/type as the backend reported it. */
  readonly name: string;
  /** A provider status code, when the backend reported one. */
  readonly status?: number;
  /** Whether the BACKEND said the failure is retryable. */
  readonly isRetryable?: boolean;
  /** A normalized provider reason (e.g. `quota_exceeded`). */
  readonly reason?: string;
}

/**
 * Classify an attempt from ALL of its signals, not from the exit code alone.
 *
 * Precedence, strongest evidence first:
 *   1. an explicit failureClass the wrapper already knows;
 *   2. a structured error envelope from the backend (it knows more than we do);
 *   3. the timeout / cancellation signal (unambiguous);
 *   4. the exit code (weakest — it cannot distinguish success from a
 *      mid-stream failure that the backend reported with exit 0).
 *
 * The result is a class, and the class carries its behaviour. A caller that
 * disagrees with the classification cannot act differently, because the
 * prescribed behaviour is a property of the class.
 */
export function classifyAttempt(observation: AttemptObservation): DelegationFailureClass {
  if (observation.timedOut) return "timeout";
  if (observation.cancelled) return "cancelled";

  const envelope = observation.envelope;
  if (envelope) {
    // A backend that names its own reason is the most reliable source.
    const reason = envelope.reason?.toLowerCase();
    if (reason) {
      if (reason.includes("quota") || reason.includes("credit") || reason.includes("usage_limit")) return "quota";
      if (reason.includes("rate_limit") || reason.includes("too_many") || reason.includes("overload")) return "rate_limited";
      if (reason.includes("auth") || reason.includes("unauthorized") || reason.includes("forbidden")) return "auth";
      if (reason.includes("timeout") || reason.includes("deadline")) return "timeout";
      if (reason.includes("unavailable") || reason.includes("overloaded")) return "upstream_unavailable";
    }
    if (typeof envelope.status === "number") {
      const byStatus = classifyHttpStatus(envelope.status);
      if (byStatus !== "unknown") return byStatus;
    }
    if (envelope.name) {
      const lower = envelope.name.toLowerCase();
      if (lower.includes("ratelimit") || lower.includes("rate_limit")) return "rate_limited";
      if (lower.includes("auth")) return "auth";
      if (lower.includes("timeout")) return "timeout";
      if (lower.includes("apierror") || lower.includes("api_error")) return "upstream_unavailable";
    }
  }

  const code = observation.exitCode;
  if (code === null) return "unknown";
  if (code === 0) {
    // Exit 0 with no error envelope is a success. The wrapper's caller
    // decides what to do with a success.
    return "unknown";
  }
  // A non-zero exit without an envelope: the backend RAN and FAILED, and did
  // not say why. We know the failure is about this backend, so a fallback is
  // legal — but the cause stays unknown, and no cause is invented.
  if (code === 124) return "timeout"; // the conventional `timeout` exit
  if (code === 126 || code === 127) return "spawn_failed";
  if (code === 137) return "timeout"; // SIGKILL
  return "backend_failed";
}

/**
 * Is a failed attempt safe to fall back from?
 *
 * The effect state is a REQUIRED argument, not an optional one. A caller that
 * cannot say what state the attempt's effects are in must say `unknown`, and
 * `unknown` forbids the fallback. Making it optional would let a caller
 * forget it — and a forgotten effect state is precisely the defect this
 * module exists to prevent.
 */
export function canFallback(
  observation: AttemptObservation,
  failureClass: DelegationFailureClass,
  effect: EffectState,
): boolean {
  if (!failureSpec(failureClass).mayFallback) return false;
  // A committed turn is terminal: another backend would splice two answers
  // together and re-run whatever the first one already did.
  return fallbackLegal({
    committed: observation.committed ?? false,
    outputProduced: observation.outputProduced ?? false,
    effect,
  });
}

/**
 * Classify an arbitrary error into the taxonomy.
 *
 * The classification is driven by EVIDENCE, never by guesswork:
 *   - an explicit `failureClass` on the error wins (the wrapper knows more
 *     than the generic classifier does);
 *   - otherwise the Node error `code` decides;
 *   - otherwise an HTTP status decides, when the error carries one;
 *   - otherwise it is `unknown`, which is NOT retryable.
 *
 * `unknown` is the important case. An unrecognised error is a bug in the
 * wrapper or an undocumented backend behaviour, and retrying it against
 * another backend would multiply one failure into several.
 */
export function classifyFailure(err: unknown): DelegationFailureClass {
  if (err && typeof err === "object") {
    const e = err as { failureClass?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; name?: unknown };
    if (typeof e.failureClass === "string" && (DELEGATION_FAILURE_CLASSES as readonly string[]).includes(e.failureClass)) {
      return e.failureClass as DelegationFailureClass;
    }
    const status = typeof e.status === "number" ? e.status : typeof e.statusCode === "number" ? e.statusCode : undefined;
    if (status !== undefined) return classifyHttpStatus(status);
    const code = typeof e.code === "string" ? e.code : undefined;
    if (code) return classifyErrorCode(code);
    if (e.name === "TimeoutError") return "timeout";
    if (e.name === "AbortError") return "cancelled";
  }
  return "unknown";
}

/** Map an HTTP status onto the taxonomy. */
export function classifyHttpStatus(status: number): DelegationFailureClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 413) return "quota";
  if (status === 429) return "rate_limited";
  if (status === 408 || status === 504) return "timeout";
  if (status >= 500) return "upstream_unavailable";
  if (status >= 400) return "protocol_violation";
  return "unknown";
}

/** Map a Node error `code` onto the taxonomy. */
export function classifyErrorCode(code: string): DelegationFailureClass {
  switch (code) {
    case "ETIMEDOUT":
    case "ESOCKETTIMEDOUT":
    case "ERR_SOCKET_CONNECTION_TIMEOUT":
      return "timeout";
    case "ECONNREFUSED":
    case "ENETUNREACH":
    case "EHOSTUNREACH":
    case "EAI_AGAIN":
      return "refused";
    case "ENOENT":
    case "EACCES":
    case "EPERM":
    case "ENOEXEC":
    case "EISDIR":
    case "ENOTDIR":
      return "spawn_failed";
    case "ECONNRESET":
    case "EPIPE":
      return "upstream_unavailable";
    case "ENOMEM":
    case "EMFILE":
    case "ENFILE":
      return "unknown";
    default:
      return "unknown";
  }
}

/** The circuit breaker's three states. */
export const CIRCUIT_STATES = ["closed", "open", "half_open"] as const;
export type CircuitState = (typeof CIRCUIT_STATES)[number];

/** When a circuit opens, and how it recovers. */
export interface CircuitPolicy {
  /** Consecutive failures needed to open the circuit. */
  readonly failureThreshold: number;
  /** How long the circuit stays open before a trial attempt is allowed. */
  readonly cooldownMs: number;
  /** Consecutive half-open successes needed to close the circuit. */
  readonly successThreshold: number;
}

/** The default circuit policy: open fast, recover slowly. */
export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = {
  failureThreshold: 3,
  cooldownMs: 30_000,
  successThreshold: 1,
};

/**
 * A circuit breaker for ONE backend.
 *
 * Classic three-state breaker, with one deliberate choice: the half-open state
 * permits exactly ONE trial attempt. A breaker that lets a burst through
 * "because it is half-open" is not a breaker.
 *
 * The state machine is deliberately free of I/O and of wall-clock reads: the
 * caller supplies `now`. That makes every transition testable without waiting,
 * and it keeps the kernel deterministic.
 */
export class CircuitBreaker {
  #state: CircuitState = "closed";
  #failures = 0;
  #halfOpenSuccesses = 0;
  #openedAt = 0;
  #trialInFlight = false;
  readonly #policy: CircuitPolicy;

  constructor(policy: CircuitPolicy = DEFAULT_CIRCUIT_POLICY) {
    if (policy.failureThreshold < 1) throw new Error("circuit failureThreshold must be >= 1");
    if (policy.cooldownMs < 0) throw new Error("circuit cooldownMs must be >= 0");
    if (policy.successThreshold < 1) throw new Error("circuit successThreshold must be >= 1");
    this.#policy = policy;
  }

  get state(): CircuitState {
    return this.#state;
  }

  /** Consecutive failures since the last success. */
  get consecutiveFailures(): number {
    return this.#failures;
  }

  get policy(): CircuitPolicy {
    return this.#policy;
  }

  /**
   * Is the circuit currently REFUSING attempts?
   *
   * Read-only, and deliberately separate from `canAttempt`. `canAttempt` has a
   * side effect — when the cooldown has elapsed it moves the circuit to
   * half-open and CLAIMS the single trial slot. A caller that merely wants to
   * know whether a backend is reachable must not claim that slot, or the
   * backend can never be tried again: the slot stays claimed by a candidate
   * that was considered and passed over.
   */
  isRefusing(now: number): boolean {
    if (this.#state === "closed") return false;
    if (this.#state === "open") return now - this.#openedAt < this.#policy.cooldownMs;
    // half_open: a trial is in flight (or was claimed), so refuse.
    return this.#trialInFlight;
  }

  /**
   * May an attempt be made right now?
   *
   * `now` is supplied by the caller so the state machine stays deterministic
   * and testable without sleeping. Call this at the moment an attempt is
   * actually made, not when a candidate is merely being considered.
   */
  canAttempt(now: number): boolean {
    if (this.#state === "closed") return true;
    if (this.#state === "open") {
      if (now - this.#openedAt >= this.#policy.cooldownMs) {
        this.#state = "half_open";
        this.#halfOpenSuccesses = 0;
        // This call IS the trial attempt, so the slot is claimed here. Without
        // this, the next caller would see half_open with a free slot and a
        // whole burst would slip through "because it is half-open".
        this.#trialInFlight = true;
        return true;
      }
      return false;
    }
    // half_open: exactly one trial at a time.
    if (this.#trialInFlight) return false;
    this.#trialInFlight = true;
    return true;
  }

  /** Record a successful attempt. */
  recordSuccess(): void {
    this.#trialInFlight = false;
    if (this.#state === "half_open") {
      this.#halfOpenSuccesses += 1;
      if (this.#halfOpenSuccesses >= this.#policy.successThreshold) {
        this.#state = "closed";
        this.#failures = 0;
        this.#halfOpenSuccesses = 0;
      }
      return;
    }
    this.#state = "closed";
    this.#failures = 0;
  }

  /**
   * Record a failed attempt.
   *
   * Only failures that are worth counting open the circuit. A `rate_limited`
   * response means the backend is ALIVE and working correctly — it is asking
   * for less traffic, not failing. Counting it would trip the breaker during
   * exactly the burst the backend is asking to smooth out, and the fallback
   * would send the traffic somewhere else entirely.
   */
  recordFailure(failureClass: DelegationFailureClass, now: number): void {
    this.#trialInFlight = false;
    if (failureClass === "rate_limited" || failureClass === "cancelled") {
      // Not the backend's fault; it does not count against its health.
      return;
    }
    if (this.#state === "half_open") {
      // The trial attempt failed: straight back to open.
      this.#state = "open";
      this.#openedAt = now;
      this.#failures = this.#policy.failureThreshold;
      this.#halfOpenSuccesses = 0;
      return;
    }
    this.#failures += 1;
    if (this.#failures >= this.#policy.failureThreshold) {
      this.#state = "open";
      this.#openedAt = now;
    }
  }

  /** Force the circuit closed (an operator action, e.g. after a fix). */
  reset(): void {
    this.#state = "closed";
    this.#failures = 0;
    this.#halfOpenSuccesses = 0;
    this.#trialInFlight = false;
  }
}

/**
 * The two-axis fail policy.
 *
 * These are CONSTANTS, not configuration. An operator must not be able to
 * configure the unsafe combination, and the two axes are genuinely different
 * questions:
 *
 *   CAPABILITY — "can this backend do this at all?" An unknown answer must
 *   FAIL CLOSED: refuse, do not attempt. A wrong attempt can corrupt the
 *   user's workspace. This mirrors `core/src/capabilities/matrix.ts`, where
 *   UNKNOWN forces callers to fail closed.
 *
 *   HEALTH — "is this backend currently serving?" When every candidate is
 *   unhealthy, the correct behaviour is FAIL OPEN: attempt anyway and record
 *   the outcome. Refusing everything is a self-inflicted outage, and the
 *   attempt may well succeed. Every mature router does this.
 *
 * Conflating the two axes is the bug: fail-closed on health takes the system
 * down, fail-open on capability lets it corrupt things.
 */
export const FAIL_POLICY = {
  /** An unknown capability is refused, never attempted. */
  onCapabilityUnknown: "fail_closed",
  /** When no healthy candidate remains, the chain still tries. */
  onAllBackendsUnhealthy: "fail_open",
  /** An exhausted deadline ends the chain — continuing guarantees lateness. */
  onBudgetExhausted: "fail_closed",
  /** A contract violation fails closed for THAT backend, open across the chain. */
  onContractViolation: "fail_closed_per_backend",
} as const;

/**
 * The state of any EFFECT an attempt may have started.
 *
 * - `NONE`      — provably no effect was started.
 * - `IN_FLIGHT` — an effect was started and may have partially executed.
 * - `COMMITTED` — an effect completed.
 * - `UNKNOWN`   — it is NOT known whether an effect was started.
 *
 * `UNKNOWN` is a first-class value, not an omission. It is the value a
 * wrapper must use when it cannot observe effects — which is most wrappers,
 * most of the time. Treating it as `NONE` would be a guess, and this module
 * exists to prevent exactly that kind of guess.
 */
export const EFFECT_STATES = ["NONE", "IN_FLIGHT", "COMMITTED", "UNKNOWN"] as const;
export type EffectState = (typeof EFFECT_STATES)[number];

/** The state of one attempt, for the fallback decision. */
export interface FallbackState {
  /**
   * Whether the attempt's output was HANDED TO THE HOST.
   *
   * This is not "the attempt produced output". A buffered wrapper holds its
   * output until the attempt ends and the host has received nothing; a
   * streaming wrapper has already forwarded it and cannot take it back. Only
   * the second is irreversible, and only the second is terminal.
   */
  readonly committed?: boolean;
  /**
   * Whether the attempt produced an answer at all.
   *
   * Recorded for the telemetry, and used by the PRESENTATION layer to decide
   * which attempt's output is the answer. It is deliberately NOT a gate on
   * the fallback: almost every backend prints something, so gating on it
   * would make the chain refuse to fall back for nearly every real backend
   * and would leave the escape hatch unusable.
   */
  readonly outputProduced?: boolean;
  /** The state of any effect the attempt may have started. REQUIRED. */
  readonly effect: EffectState;
  /** Whether a commit point exists for this turn. */
  readonly commitPoint?: boolean;
}

/**
 * Whether a fallback is still legal.
 *
 *   fallbackLegal(attempt) ⇔ no COMMIT_POINT exists
 *                        ∧ no output was handed to the host
 *                        ∧ the effect state is KNOWN and is `NONE`
 *
 * ── The third clause is the one that is easy to get wrong ──────────────────
 *
 * D-013 states the rule as "no EFFECT in {IN_FLIGHT, COMMITTED}", which
 * silently treats `UNKNOWN` as `NONE`. But an effect whose state is unknown
 * may have partially executed, and re-running the task would execute it a
 * second time. So `UNKNOWN` forbids the fallback.
 *
 * This is the SAME rule this repository applies everywhere else: a capability
 * that is unknown fails closed, a quantity that is unknown is never defaulted
 * to a number, and a failure that cannot be classified is not retried. The
 * fallback decision is a SAFETY question, not a health question — `FAIL_POLICY`
 * fails OPEN on health precisely because failing closed there would be a
 * self-inflicted outage, and this is not that axis. Re-running a task that may
 * already have paid a payment or written a file is exactly the "a wrong
 * attempt can corrupt the user's workspace" case the capability axis exists
 * for.
 *
 * ── Why the OUTPUT clause is about commitment, not production ──────────────
 *
 * "The attempt produced an answer" and "the host has the answer" are
 * different facts, and conflating them breaks the escape hatch: nearly every
 * backend prints something, so a rule that refuses the fallback whenever
 * anything was printed would stop the chain from ever falling back. The
 * harm of two answers is a PRESENTATION problem, and it is solved where it
 * belongs: a wrapper presents exactly one attempt's output as the answer and
 * the rest as diagnostics.
 */
export function fallbackLegal(state: FallbackState): boolean {
  if (state.commitPoint) return false;
  if (state.committed) return false;
  return state.effect === "NONE";
}

/** A delegation telemetry event. */
export const DelegationEventSchema = z.object({
  /** Event kind. */
  type: z.enum(DELEGATION_EVENT_TYPES),
  /** The backend this event is about. */
  backendId: z.string().min(1),
  /** The capability the request needed, when one was specified. */
  capability: z.string().optional(),
  /** The domain the request belonged to, when one was specified. */
  domain: z.string().optional(),
  /** 1-based attempt number within this delegation. */
  attempt: z.number().int().positive().default(1),
  /** Wall-clock duration of the attempt, in milliseconds. */
  durationMs: z.number().int().nonnegative().optional(),
  /** The process exit code, when the backend ran. */
  exitCode: z.number().int().nullable().optional(),
  /**
   * Whether any of the attempt's output was already committed to the host.
   * A failure after this point is TERMINAL: falling back is illegal.
   */
  committed: z.boolean().default(false),
  /**
   * Whether the attempt produced an answer at all.
   *
   * Distinct from `committed`: an attempt can produce output that the host
   * never receives, because a failed attempt's output is diagnostics.
   */
  outputProduced: z.boolean().default(false),
  /**
   * The effect state the wrapper could establish for this attempt.
   *
   * `UNKNOWN` is the normal value, and it is why a fallback is usually
   * refused: the backend ran, and the wrapper cannot prove it did nothing.
   */
  effectState: z.enum(EFFECT_STATES).optional(),
  /** The failure class, on a failed event. */
  failureClass: z.enum(DELEGATION_FAILURE_CLASSES).optional(),
  /** The class's prescribed behaviour, recorded so a reader need not look it up. */
  failureBehaviour: z.enum(["fallback", "retry_after", "report", "abort"]).optional(),
  /** Milliseconds the backend asked the caller to wait, for `rate_limited`. */
  retryAfterMs: z.number().int().nonnegative().optional(),
  /** The circuit state of the backend after this event. */
  circuitState: z.enum(CIRCUIT_STATES).optional(),
  /**
   * Whether the backend itself declared the failure retryable. The backend
   * knows more than the wrapper does, so it may override the default policy.
   */
  backendDeclaredRetryable: z.boolean().optional(),
  /** Epoch milliseconds when the event was produced. */
  at: z.number().int().nonnegative(),
});
export type DelegationEvent = z.infer<typeof DelegationEventSchema>;

/** Build a validated delegation event. Throws on an invalid event. */
export function delegationEvent(event: unknown): DelegationEvent {
  const parsed = DelegationEventSchema.safeParse(event);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid delegation event: ${issues}`);
  }
  return parsed.data;
}

/**
 * A stable id for a delegation event, so re-appending the same event is
 * idempotent (guarantee G5 of the write contract).
 */
export function delegationEventId(event: DelegationEvent): string {
  return `DEL-${event.type}-${event.backendId}-${event.at}-${event.attempt}`;
}
