/**
 * The delegation wrapper — the layer that makes AnyPlugin a FRONT DOOR to
 * other runtimes and tools.
 *
 * ── What this is ───────────────────────────────────────────────────────────
 *
 * The wrapper does four things, in this order:
 *
 *   1. PROBE   — is the backend present, and what version is it? Probing
 *                never runs the real work.
 *   2. ROUTE   — pick a backend: capability match first (fail closed on
 *                UNKNOWN), then circuit health, then registry order.
 *   3. DELEGATE — run it safely: no shell, an argv array, a deadline, an
 *                output cap, an environment allowlist.
 *   4. RECORD  — write a telemetry event into the worker-runtime event log,
 *                so the delegation is replayable and byte-accounted rather
 *                than scattered across ad-hoc log files.
 *
 * ── The rules that make it safe ─────────────────────────────────────────────
 *
 *   - NEVER a shell. The command and its arguments are passed as an argv
 *     array to `spawn`, so a backend argument can never be interpreted as
 *     shell syntax. This is the single most important line in this file.
 *   - NEVER an unbounded run. Every attempt has a deadline and an output
 *     cap. A backend that produces gigabytes must not be able to exhaust the
 *     host's memory.
 *   - NEVER an unbounded environment. The child gets an explicit allowlist,
 *     because a blocklist has to anticipate every secret.
 *   - NEVER a silent failure. Every attempt produces a telemetry event with a
 *     classified failure, even when the failure could not be classified — an
 *     unclassified failure is recorded as `unknown`, not dropped.
 *   - NEVER a fallback after the turn committed. See `fallbackLegal`.
 */
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { access, stat } from "node:fs/promises";
import {
  type BackendCatalog,
  type BackendSpec,
  backendSupport,
} from "@lablaunchpad/core";
import {
  CircuitBreaker,
  canFallback,
  classifyAttempt,
  delegationEvent,
  delegationEventId,
  type DelegationErrorEnvelope,
  type DelegationEvent,
  type DelegationFailureClass,
} from "@lablaunchpad/worker-runtime";

/** The result of probing a backend for availability. */
export interface ProbeResult {
  readonly backendId: string;
  /** Whether the backend could be started at all. */
  readonly available: boolean;
  /** The version string, when the probe produced one. */
  readonly version?: string;
  /** Why the probe failed, when it did. */
  readonly reason?: string;
  /** How long the probe took, in milliseconds. */
  readonly durationMs: number;
}

/** The result of one delegated attempt. */
export interface DelegationOutcome {
  readonly backendId: string;
  /** 1-based attempt number within the delegation. */
  readonly attempt: number;
  /** The process exit code, or null when the process was killed. */
  readonly exitCode: number | null;
  /** Whether the attempt met its deadline. */
  readonly timedOut: boolean;
  /** Whether the attempt was cancelled. */
  readonly cancelled: boolean;
  /** Captured stdout, possibly truncated. */
  readonly stdout: string;
  /** Captured stderr, possibly truncated. */
  readonly stderr: string;
  /** Whether output was truncated by the cap. */
  readonly truncated: boolean;
  /** How long the attempt took, in milliseconds. */
  readonly durationMs: number;
  /** The classified failure, when the attempt failed. */
  readonly failureClass?: DelegationFailureClass;
  /** Whether a fallback is still legal. */
  readonly fallbackLegal: boolean;
  /** The structured error envelope recovered from the output, when there was one. */
  readonly envelope?: DelegationErrorEnvelope | null;
  /** The telemetry events produced by this attempt. */
  readonly events: DelegationEvent[];
}

/** Options for one delegated attempt. */
export interface ExecuteOptions {
  /** The deadline for the attempt, in milliseconds. */
  readonly timeoutMs?: number;
  /** Maximum bytes captured per stream. */
  readonly maxOutputBytes?: number;
  /** The working directory for the child. */
  readonly cwd?: string;
  /** Extra environment variables (merged over the backend's allowlist). */
  readonly env?: Record<string, string>;
  /** Abort the attempt from the outside. */
  readonly signal?: AbortSignal;
  /** 1-based attempt number, for the telemetry. */
  readonly attempt?: number;
}

/** Defaults that keep a misbehaving backend from harming the host. */
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576; // 1 MiB per stream

/**
 * Recover a structured error envelope from a backend's output.
 *
 * Backends report failures in incompatible shapes, and several of them exit 0
 * after a failure. The envelope is what makes the failure classifiable at all,
 * so the parser looks for the common shapes and gives up cleanly when it
 * finds none.
 *
 * The shapes handled, in the order they are tried:
 *   - an OpenCode-style error event: `{"type":"error","error":{"name":…,"data":{…}}}`
 *   - a Claude-Code-style result: `{"is_error":true,"subtype":…,"result":…}`
 *   - a bare `{"error":{…}}` object
 */
export function parseErrorEnvelope(output: string): DelegationErrorEnvelope | null {
  const text = output.trim();
  if (text === "") return null;

  // The output may be JSONL; the last non-empty line is the most recent event.
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const candidates = lines.length > 0 ? lines.slice().reverse() : [text];

  for (const line of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const obj = parsed as Record<string, unknown>;

    // OpenCode: { type: "error", error: { name, data: { statusCode, isRetryable, message } } }
    if (obj["type"] === "error" && obj["error"] && typeof obj["error"] === "object") {
      const err = obj["error"] as Record<string, unknown>;
      const data = (err["data"] ?? {}) as Record<string, unknown>;
      const status = typeof data["statusCode"] === "number" ? data["statusCode"] : undefined;
      return {
        name: typeof err["name"] === "string" ? err["name"] : "Error",
        ...(status !== undefined ? { status } : {}),
        ...(typeof data["isRetryable"] === "boolean" ? { isRetryable: data["isRetryable"] } : {}),
        ...(typeof data["message"] === "string" ? { reason: data["message"] } : {}),
      };
    }

    // Claude Code: { is_error: true, subtype: "error_max_turns", result: "…" }
    if (obj["is_error"] === true) {
      const subtype = typeof obj["subtype"] === "string" ? obj["subtype"] : undefined;
      const result = typeof obj["result"] === "string" ? obj["result"].slice(0, 200) : undefined;
      return {
        name: "BackendError",
        // The subtype is the machine-readable cause, so it wins over the
        // free-text result. The result is only a fallback.
        ...(subtype ? { reason: subtype } : result ? { reason: result } : {}),
      };
    }

    // Bare { error: { … } }
    if (obj["error"] && typeof obj["error"] === "object") {
      const err = obj["error"] as Record<string, unknown>;
      return {
        name: typeof err["name"] === "string" ? err["name"] : "Error",
        ...(typeof err["statusCode"] === "number" ? { status: err["statusCode"] } : {}),
        ...(typeof err["isRetryable"] === "boolean" ? { isRetryable: err["isRetryable"] } : {}),
        ...(typeof err["message"] === "string" ? { reason: err["message"] } : {}),
      };
    }
  }
  return null;
}

/** Build the child's environment from an allowlist. */
function childEnv(spec: BackendSpec, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  // The minimum a child needs to run at all.
  for (const key of ["PATH", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE", "LANG"]) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(spec.env)) {
    // The registry is the user's own file, so it MAY set a variable the
    // allowlist already provides — that is the point of naming it explicitly.
    env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

/** Cap a captured stream, reporting whether it was cut. */
function cap(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return { text, truncated: false };
  return { text: Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8"), truncated: true };
}

/**
 * Cap a stream as it arrives, counting BYTES.
 *
 * Counting characters would let a stream of 4-byte characters use four times
 * the intended memory, and the accumulation guard below is what stops an
 * unbounded producer from exhausting the host — so it has to be measured in
 * the same unit the cap is expressed in.
 */
function byteCappedAppend(current: string, chunk: Buffer, maxBytes: number): { text: string; truncated: boolean } {
  const currentBytes = Buffer.byteLength(current, "utf8");
  if (currentBytes >= maxBytes) return { text: current, truncated: true };
  const room = maxBytes - currentBytes;
  if (chunk.byteLength <= room) return { text: current + chunk.toString("utf8"), truncated: false };
  // A chunk that straddles the boundary is cut on a byte boundary. Cutting
  // mid-codepoint would leave a replacement character, which is fine for
  // diagnostics but must not be mistaken for the backend's actual output.
  return { text: current + chunk.subarray(0, room).toString("utf8"), truncated: true };
}

/**
 * Run one backend safely.
 *
 * The command is NEVER passed through a shell. A backend argument is data,
 * not syntax — so a prompt containing `; rm -rf /` is a prompt, not a command.
 */
export async function executeBackend(
  spec: BackendSpec,
  args: string[] = [],
  opts: ExecuteOptions = {},
): Promise<DelegationOutcome> {
  const timeoutMs = opts.timeoutMs ?? spec.timeoutMs;
  const maxBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const attempt = opts.attempt ?? 1;
  const started = Date.now();
  const events: DelegationEvent[] = [];

  if (!spec.command) {
    const failureClass: DelegationFailureClass = "spawn_failed";
    const event = delegationEvent({
      type: "DELEGATION_FAILED",
      backendId: spec.id,
      attempt,
      durationMs: 0,
      exitCode: null,
      committed: false,
      failureClass,
      failureBehaviour: "fallback",
      at: started,
    });
    events.push(event);
    return {
      backendId: spec.id,
      attempt,
      exitCode: null,
      timedOut: false,
      cancelled: false,
      stdout: "",
      stderr: `backend "${spec.id}" declares no command`,
      truncated: false,
      durationMs: 0,
      failureClass,
      fallbackLegal: true,
      envelope: null,
      events,
    };
  }

  const startEvent = delegationEvent({
    type: "DELEGATION_STARTED",
    backendId: spec.id,
    attempt,
    at: started,
  });
  events.push(startEvent);

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    cancelled: boolean;
    stdoutTruncated: boolean;
    stderrTruncated: boolean;
    spawnError?: NodeJS.ErrnoException;
  }>((resolvePromise) => {
    const child = spawn(spec.command!, [...spec.args, ...args], {
      // NEVER a shell: the argv array is passed to the OS unchanged.
      shell: false,
      cwd: opts.cwd,
      env: childEnv(spec, opts.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timedOut = false;
    let cancelled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // Kill the whole tree on Windows, where a signal is not delivered the
      // way it is on POSIX. SIGKILL is the strongest portable option.
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, timeoutMs);

    const onAbort = () => {
      cancelled = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener("abort", onAbort, { once: true });
    }

    const settle = (value: Parameters<typeof resolvePromise>[0]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise(value);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      const next = byteCappedAppend(stdout, chunk, maxBytes);
      stdout = next.text;
      stdoutTruncated = stdoutTruncated || next.truncated;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const next = byteCappedAppend(stderr, chunk, maxBytes);
      stderr = next.text;
      stderrTruncated = stderrTruncated || next.truncated;
    });
    child.on("error", (err: NodeJS.ErrnoException) => {
      settle({ code: null, signal: null, stdout, stderr, timedOut, cancelled, stdoutTruncated, stderrTruncated, spawnError: err });
    });
    child.on("close", (code, signal) => {
      settle({ code, signal, stdout, stderr, timedOut, cancelled, stdoutTruncated, stderrTruncated });
    });
  });

  const durationMs = Date.now() - started;
  // The streams were already capped as they arrived, in BYTES. The final cap
  // is a belt-and-braces check for anything that slipped through.
  const outCap = cap(result.stdout, maxBytes);
  const errCap = cap(result.stderr, maxBytes);
  const truncated = outCap.truncated || errCap.truncated || result.stdoutTruncated || result.stderrTruncated;

  // A spawn error is its own observation: the process never ran.
  const observation = result.spawnError
    ? { exitCode: null as number | null, spawnError: result.spawnError }
    : {
        exitCode: result.code,
        signal: result.signal,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        envelope: parseErrorEnvelope(`${outCap.text}\n${errCap.text}`),
        committed: false,
      };

  let failureClass: DelegationFailureClass | undefined;
  if (result.spawnError) {
    failureClass = classifySpawnError(result.spawnError);
  } else if (result.timedOut) {
    failureClass = "timeout";
  } else if (result.cancelled) {
    failureClass = "cancelled";
  } else if (result.code !== 0) {
    failureClass = classifyAttempt(observation);
  } else {
    // Exit 0: a success, UNLESS the output carries an error envelope. A
    // backend that fails mid-stream and still exits 0 must not be reported
    // as a success.
    const envelope = observation.envelope ?? null;
    if (envelope) {
      const cls = classifyAttempt({ ...observation, envelope });
      if (cls !== "unknown") failureClass = cls;
    }
  }

  const fallbackOk = failureClass ? canFallback(observation, failureClass) : true;

  if (failureClass) {
    events.push(
      delegationEvent({
        type: "DELEGATION_FAILED",
        backendId: spec.id,
        attempt,
        durationMs,
        exitCode: result.code,
        committed: false,
        failureClass,
        ...(failureClass === "rate_limited" ? { retryAfterMs: 0 } : {}),
        at: started + durationMs,
      }),
    );
  } else {
    events.push(
      delegationEvent({
        type: "DELEGATION_SUCCEEDED",
        backendId: spec.id,
        attempt,
        durationMs,
        exitCode: result.code,
        committed: false,
        at: started + durationMs,
      }),
    );
  }

  return {
    backendId: spec.id,
    attempt,
    exitCode: result.code,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    stdout: outCap.text,
    stderr: errCap.text,
    truncated,
    durationMs,
    ...(failureClass ? { failureClass } : {}),
    fallbackLegal: fallbackOk,
    envelope: observation.envelope ?? null,
    events,
  };
}

/** Classify a failure that happened before the process could run. */
function classifySpawnError(err: NodeJS.ErrnoException): DelegationFailureClass {
  switch (err.code) {
    case "ENOENT":
    case "EACCES":
    case "EPERM":
    case "ENOEXEC":
      return "spawn_failed";
    case "ETIMEDOUT":
      return "timeout";
    default:
      return "spawn_failed";
  }
}

/**
 * Probe a backend for availability.
 *
 * Probing MUST NOT run the real work: a probe that triggers a model call
 * costs money and takes time. It asks the backend to identify itself and
 * reports what it found.
 */
export async function probeBackend(spec: BackendSpec, opts: { timeoutMs?: number } = {}): Promise<ProbeResult> {
  const started = Date.now();
  if (!spec.command) {
    return { backendId: spec.id, available: false, reason: "backend declares no command", durationMs: 0 };
  }
  const probeArgv = spec.probe?.argv ?? ["--version"];
  const timeoutMs = opts.timeoutMs ?? spec.probe?.timeoutMs ?? 5_000;

  // The probe may use a DIFFERENT command line from the real work, so the
  // backend's own default args are replaced, not appended to.
  const probeSpec: BackendSpec = {
    ...spec,
    command: spec.probe?.command ?? spec.command,
    args: [],
    timeoutMs,
  };

  const outcome = await executeBackend(probeSpec, probeArgv, {
    timeoutMs,
    maxOutputBytes: 64 * 1024,
  });

  if (outcome.exitCode !== 0) {
    return {
      backendId: spec.id,
      available: false,
      reason: outcome.failureClass ? `probe failed (${outcome.failureClass})` : `probe exited ${outcome.exitCode}`,
      durationMs: outcome.durationMs,
    };
  }

  const output = `${outcome.stdout}\n${outcome.stderr}`.trim();
  let version: string | undefined;
  if (spec.probe?.versionPattern) {
    try {
      const m = new RegExp(spec.probe.versionPattern).exec(output);
      if (m?.[1]) version = m[1];
      else if (m?.[0]) version = m[0];
    } catch {
      version = undefined;
    }
  } else if (output) {
    version = output.split(/\r?\n/)[0]?.trim();
  }

  return {
    backendId: spec.id,
    available: true,
    ...(version ? { version } : {}),
    durationMs: outcome.durationMs,
  };
}

/** The routing request. */
export interface RouteRequest {
  /** The capability the work needs. A backend with UNKNOWN support is excluded. */
  readonly capability?: string;
  /** The domain the work belongs to. */
  readonly domain?: string;
  /** An explicitly chosen backend id. It still has to exist and be enabled. */
  readonly backendId?: string;
}

/** The outcome of a routing decision. */
export interface RouteDecision {
  /** The chosen backend, or null when nothing was eligible. */
  readonly selected: BackendSpec | null;
  /** Every candidate considered, in order. */
  readonly candidates: BackendSpec[];
  /** Why nothing was selected, when nothing was. */
  readonly reason?: string;
  /** The events produced by the decision. */
  readonly events: DelegationEvent[];
}

/**
 * Choose a backend.
 *
 * Precedence, in this order:
 *   1. an explicit backend id (it must still exist and be enabled);
 *   2. capability match — a backend whose support for the capability is
 *      UNKNOWN or UNSUPPORTED is EXCLUDED, because UNKNOWN must fail closed;
 *   3. domain match;
 *   4. circuit health — an OPEN circuit is skipped, but if EVERY candidate is
 *      unhealthy the chain still tries them (fail OPEN on health).
 *
 * The fail-open-on-health rule is the difference between a wrapper that
 * degrades and a wrapper that takes the system down.
 */
export function selectBackend(
  catalog: BackendCatalog,
  request: RouteRequest,
  breakers: Map<string, CircuitBreaker>,
  now: number = Date.now(),
): RouteDecision {
  const events: DelegationEvent[] = [];

  if (request.backendId) {
    const explicit = catalog.get(request.backendId);
    if (!explicit) {
      return { selected: null, candidates: [], reason: `no backend with id "${request.backendId}"`, events };
    }
    if (!explicit.enabled) {
      return { selected: null, candidates: [], reason: `backend "${request.backendId}" is disabled`, events };
    }
    if (request.capability) {
      const support = backendSupport(explicit, request.capability);
      if (support === "UNKNOWN" || support === "UNSUPPORTED") {
        // Fail CLOSED on capability: never attempt a backend that may not be
        // able to do the work.
        return {
          selected: null,
          candidates: [],
          reason: `backend "${request.backendId}" does not declare support for capability "${request.capability}" (${support})`,
          events,
        };
      }
    }
    events.push(
      delegationEvent({
        type: "ROUTE_SELECTED",
        backendId: explicit.id,
        ...(request.capability ? { capability: request.capability } : {}),
        ...(request.domain ? { domain: request.domain } : {}),
        attempt: 1,
        at: now,
      }),
    );
    return { selected: explicit, candidates: [explicit], events };
  }

  let candidates = catalog.candidates(request.capability, request.domain);
  if (candidates.length === 0) {
    return {
      selected: null,
      candidates: [],
      reason: request.capability
        ? `no enabled backend declares support for capability "${request.capability}"`
        : "no enabled backend matches",
      events,
    };
  }

  // Health filter, remembering the excluded ones so an all-unhealthy chain
  // can still try them.
  //
  // `isRefusing` is READ-ONLY. `canAttempt` has a side effect — it claims the
  // half-open trial slot — and calling it here would claim the slot for a
  // candidate that may never be attempted, leaving that backend permanently
  // untried. The slot is claimed in `delegate()`, at the moment of the attempt.
  const healthy: BackendSpec[] = [];
  const unhealthy: BackendSpec[] = [];
  for (const candidate of candidates) {
    const breaker = breakers.get(candidate.id);
    if (breaker && breaker.isRefusing(now)) {
      unhealthy.push(candidate);
      events.push(
        delegationEvent({
          type: "CIRCUIT_OPENED",
          backendId: candidate.id,
          attempt: 1,
          circuitState: breaker.state,
          at: now,
        }),
      );
      continue;
    }
    healthy.push(candidate);
  }

  // FAIL OPEN on health: if every candidate is unhealthy, try them anyway.
  const finalCandidates = healthy.length > 0 ? healthy : candidates;
  const selected = finalCandidates[0] ?? null;
  if (!selected) {
    return { selected: null, candidates: [], reason: "no eligible backend", events };
  }

  events.push(
    delegationEvent({
      type: "ROUTE_SELECTED",
      backendId: selected.id,
      ...(request.capability ? { capability: request.capability } : {}),
      ...(request.domain ? { domain: request.domain } : {}),
      attempt: 1,
      at: now,
    }),
  );
  return { selected, candidates: finalCandidates, events };
}

/** The result of a whole delegation (one request, possibly several attempts). */
export interface DelegationResult {
  /** The attempt that produced the answer, or null when every attempt failed. */
  readonly outcome: DelegationOutcome | null;
  /** Every attempt made, in order. */
  readonly attempts: DelegationOutcome[];
  /** The selected backend, when one was chosen. */
  readonly selected: BackendSpec | null;
  /** Why no backend was selected, when none was. */
  readonly reason?: string;
  /** Every telemetry event the delegation produced. */
  readonly events: DelegationEvent[];
  /** Whether the delegation succeeded. */
  readonly ok: boolean;
}

/** Options for a whole delegation. */
export interface DelegateOptions extends ExecuteOptions {
  /** The routing request. */
  readonly request?: RouteRequest;
  /** The arguments passed to the backend. */
  readonly args?: string[];
  /** The breakers, keyed by backend id. */
  readonly breakers?: Map<string, CircuitBreaker>;
  /** The catalog to route against. */
  readonly catalog: BackendCatalog;
}

/**
 * Delegate a request, walking the fallback chain.
 *
 * The chain stops at the first success. It also stops — deliberately — when a
 * failure is one that another backend would fail identically (auth, quota), or
 * when the turn has already committed output.
 */
export async function delegate(opts: DelegateOptions): Promise<DelegationResult> {
  const breakers = opts.breakers ?? new Map<string, CircuitBreaker>();
  const decision = selectBackend(opts.catalog, opts.request ?? {}, breakers);
  const events: DelegationEvent[] = [...decision.events];

  if (!decision.selected) {
    return { outcome: null, attempts: [], selected: null, reason: decision.reason, events, ok: false };
  }

  const attempts: DelegationOutcome[] = [];
  let attemptNumber = 1;

  for (const candidate of decision.candidates) {
    // `selectBackend` already recorded the selection of the FIRST candidate.
    // Recording it again here would double-count it in the telemetry, so only
    // a genuine move to another backend emits an event.
    if (candidate !== decision.candidates[0]) {
      events.push(
        delegationEvent({
          type: "FALLBACK_SELECTED",
          backendId: candidate.id,
          ...(opts.request?.capability ? { capability: opts.request.capability } : {}),
          ...(opts.request?.domain ? { domain: opts.request.domain } : {}),
          attempt: attemptNumber,
          at: Date.now(),
        }),
      );
    }

    // Claim the circuit's trial slot at the moment of the actual attempt.
    // `selectBackend` deliberately did NOT claim it (see the note there): a
    // candidate that is considered and passed over must not consume the one
    // half-open trial the backend is allowed.
    const breaker = breakers.get(candidate.id);
    if (breaker) {
      const now = Date.now();
      if (!breaker.canAttempt(now)) {
        // The circuit closed between the selection and this attempt. Skip the
        // candidate rather than running a backend the circuit is refusing.
        events.push(
          delegationEvent({
            type: "CIRCUIT_OPENED",
            backendId: candidate.id,
            attempt: attemptNumber,
            circuitState: breaker.state,
            at: now,
          }),
        );
        continue;
      }
    }

    const outcome = await executeBackend(candidate, opts.args ?? [], { ...opts, attempt: attemptNumber });
    attempts.push(outcome);
    events.push(...outcome.events);

    if (breaker) {
      if (outcome.failureClass) {
        const before = breaker.state;
        breaker.recordFailure(outcome.failureClass, Date.now());
        if (breaker.state !== before) {
          events.push(
            delegationEvent({
              type: breaker.state === "open" ? "CIRCUIT_OPENED" : "CIRCUIT_CLOSED",
              backendId: candidate.id,
              attempt: attemptNumber,
              circuitState: breaker.state,
              at: Date.now(),
            }),
          );
        }
      } else {
        const before = breaker.state;
        breaker.recordSuccess();
        if (breaker.state !== before) {
          events.push(
            delegationEvent({
              type: "CIRCUIT_CLOSED",
              backendId: candidate.id,
              attempt: attemptNumber,
              circuitState: breaker.state,
              at: Date.now(),
            }),
          );
        }
      }
    }

    if (!outcome.failureClass) {
      return { outcome, attempts, selected: candidate, events, ok: true };
    }

    // The chain stops when falling back is not allowed or not useful.
    if (!outcome.fallbackLegal) break;
    if (candidate !== decision.candidates[decision.candidates.length - 1]) {
      events.push(
        delegationEvent({
          type: "FALLBACK_SELECTED",
          backendId: candidate.id,
          attempt: attemptNumber,
          failureClass: outcome.failureClass,
          at: Date.now(),
        }),
      );
    }
    attemptNumber += 1;
  }

  const last = attempts[attempts.length - 1];
  return {
    outcome: last ?? null,
    attempts,
    selected: decision.selected,
    ...(last?.failureClass ? { reason: `every candidate failed (last: ${last.failureClass})` } : { reason: "every candidate failed" }),
    events,
    ok: false,
  };
}

/** Serialize delegation events for the worker-runtime event log. */
export function toLogRecords(events: DelegationEvent[]): Array<{ id: string; payload: unknown }> {
  return events.map((e) => ({ id: delegationEventId(e), payload: e }));
}

/** Where the wrapper writes its telemetry, relative to a workspace root. */
export function telemetryRelPath(): string {
  return ".worker-runtime/events";
}

/** Resolve the workspace root for telemetry, honouring an override. */
export function resolveTelemetryRoot(projectDir: string, override?: string): string {
  return override ? resolve(override) : resolve(join(projectDir, ".worker-runtime"));
}

/** Does a path exist and is it a file? Used by probes that resolve a command. */
export async function isExecutableFile(path: string): Promise<boolean> {
  try {
    await access(path);
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
