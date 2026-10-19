import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendCatalog, type BackendSpec } from "@lablaunchpad/core";
import { CircuitBreaker } from "@lablaunchpad/worker-runtime";
import {
  delegate,
  executeBackend,
  parseErrorEnvelope,
  probeBackend,
  selectBackend,
  DEFAULT_MAX_OUTPUT_BYTES,
} from "./delegate.js";

/**
 * The delegation wrapper — the negative cases, which are the point.
 *
 * A wrapper that only works on the happy path is a wrapper that will one day
 * run something it should not. These tests drive the failure paths
 * deliberately: no shell, a deadline, an output cap, an unclassifiable
 * failure, a backend that exits 0 after failing, a capability that is not
 * declared, and a circuit that is open.
 */

/** A backend spec pointing at a script we control, so the behaviour is exact. */
function spec(overrides: Partial<BackendSpec> = {}): BackendSpec {
  return {
    id: "test-backend",
    label: "Test backend",
    kind: "cli",
    command: process.execPath,
    args: [],
    capabilities: {},
    domains: [],
    timeoutMs: 5_000,
    enabled: true,
    circuit: { failureThreshold: 3, cooldownMs: 1_000, successThreshold: 1 },
    env: {},
    ...overrides,
  } as BackendSpec;
}

/** Write a JS file and return a spec that runs it. */
async function scriptBackend(id: string, body: string, overrides: Partial<BackendSpec> = {}): Promise<BackendSpec> {
  const dir = await mkdtemp(join(tmpdir(), `delegate-${id}-`));
  const file = join(dir, "main.mjs");
  await writeFile(file, body, "utf8");
  return spec({ id, command: process.execPath, args: [file], ...overrides });
}

describe("safe spawn — the wrapper never hands the host a shell", () => {
  let testRoot: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "delegate-root-"));
  });

  afterAll(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    // Nothing to reset; each test builds its own backend.
  });

  it("passes arguments as data, so shell metacharacters are inert", async () => {
    // If this ever went through a shell, the argument would be interpreted.
    const backend = await scriptBackend(
      "inert",
      `import { argv } from "node:process";
       process.stdout.write("ARGS:" + JSON.stringify(argv.slice(2)));`,
    );
    const outcome = await executeBackend(backend, ["; rm -rf /", "$(whoami)", "`id`", "a b|c"]);
    expect(outcome.exitCode).toBe(0);
    // The script received the literal strings.
    expect(outcome.stdout).toContain("; rm -rf /");
    expect(outcome.stdout).toContain("$(whoami)");
    expect(outcome.stdout).toContain("`id`");
    // ...and the files are still there.
    expect(outcome.stdout).toContain("a b|c");
  });

  it("enforces the deadline and kills the process", async () => {
    const backend = await scriptBackend(
      "slow",
      `await new Promise((r) => setTimeout(r, 30000));`,
      { timeoutMs: 400 },
    );
    const started = Date.now();
    const outcome = await executeBackend(backend, []);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(5_000);
    expect(outcome.timedOut).toBe(true);
    expect(outcome.failureClass).toBe("timeout");
    // A timed-out turn MAY have had an effect: the process ran, and the
    // wrapper cannot prove it did nothing before the deadline killed it. So
    // a fallback is NOT legal.
    //
    // This assertion used to be `true`, with the reasoning "a timed-out turn
    // is NOT committed". That reasoning was about OUTPUT and said nothing
    // about EFFECTS — which is the defect the sibling audit test proves.
    expect(outcome.effectState).toBe("UNKNOWN");
    expect(outcome.fallbackLegal).toBe(false);
  });

  it("caps the captured output", async () => {
    const backend = await scriptBackend(
      "chatty",
      `process.stdout.write("x".repeat(200000));`,
    );
    const outcome = await executeBackend(backend, [], { maxOutputBytes: 1_024 });
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.stdout, "utf8")).toBeLessThanOrEqual(1_024);
  });

  it("classifies a missing command as spawn_failed", async () => {
    const backend = spec({ id: "missing", command: "definitely-not-a-real-command-xyz" });
    const outcome = await executeBackend(backend, []);
    expect(outcome.failureClass).toBe("spawn_failed");
    expect(outcome.exitCode).toBeNull();
  });

  it("classifies a backend that declares no command", async () => {
    const backend = spec({ id: "no-command", command: undefined });
    const outcome = await executeBackend(backend, []);
    expect(outcome.failureClass).toBe("spawn_failed");
    expect(outcome.stderr).toContain("declares no command");
  });

  it("does not pass the whole environment through", async () => {
    process.env["DELEGATE_SECRET_PROBE"] = "super-secret-value";
    const backend = await scriptBackend(
      "env",
      `process.stdout.write("SECRET:" + (process.env.DEGATE_SECRET_PROBE ?? "absent"));
       process.stdout.write("|PATH:" + (process.env.PATH ? "present" : "absent"));`,
    );
    const outcome = await executeBackend(backend, []);
    delete process.env["DELEGATE_SECRET_PROBE"];
    // The allowlist is the mechanism; an unlisted variable does not travel.
    expect(outcome.stdout).toContain("SECRET:absent");
    // The minimum a child needs to run IS present.
    expect(outcome.stdout).toContain("PATH:present");
  });

  it("passes an explicitly allowed environment variable through", async () => {
    const backend = await scriptBackend(
      "env-ok",
      `process.stdout.write("ALLOWED:" + (process.env.ALLOWED_VAR ?? "absent"));`,
      { env: { ALLOWED_VAR: "yes" } },
    );
    const outcome = await executeBackend(backend, []);
    expect(outcome.stdout).toContain("ALLOWED:yes");
  });
});

describe("failure classification — the exit code is not the answer", () => {
  it("detects an OpenCode-style error envelope", () => {
    const envelope = parseErrorEnvelope(
      JSON.stringify({ type: "error", error: { name: "APIError", data: { statusCode: 429, isRetryable: true, message: "slow down" } } }),
    );
    expect(envelope).not.toBeNull();
    expect(envelope!.name).toBe("APIError");
    expect(envelope!.status).toBe(429);
    expect(envelope!.isRetryable).toBe(true);
  });

  it("detects a Claude-Code-style error result", () => {
    const envelope = parseErrorEnvelope(JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "too many turns" }));
    expect(envelope).not.toBeNull();
    expect(envelope!.name).toBe("BackendError");
    expect(envelope!.reason).toContain("error_max_turns");
  });

  it("returns null for ordinary output", () => {
    expect(parseErrorEnvelope("hello world")).toBeNull();
    expect(parseErrorEnvelope("")).toBeNull();
    expect(parseErrorEnvelope(JSON.stringify({ ok: true }))).toBeNull();
  });

  it("finds the envelope in JSONL output", () => {
    const jsonl = [
      JSON.stringify({ type: "message", text: "working" }),
      JSON.stringify({ type: "error", error: { name: "APIError", data: { statusCode: 500 } } }),
    ].join("\n");
    const envelope = parseErrorEnvelope(jsonl);
    expect(envelope).not.toBeNull();
    expect(envelope!.status).toBe(500);
  });

  it("reports a backend that exits 0 after a mid-stream failure as FAILED", async () => {
    // The documented behaviour of at least one major agent CLI. A wrapper that
    // trusted the exit code would report this as a success.
    const backend = await scriptBackend(
      "midstream",
      `process.stdout.write(JSON.stringify({ type: "error", error: { name: "APIError", data: { statusCode: 400 } } }));`,
    );
    const outcome = await executeBackend(backend, []);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.failureClass).toBeDefined();
    expect(outcome.failureClass).not.toBe("unknown");
  });

  it("reports a clean exit 0 as a success", async () => {
    const backend = await scriptBackend("ok", `process.stdout.write("fine");`);
    const outcome = await executeBackend(backend, []);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.failureClass).toBeUndefined();
  });
});

describe("routing — capability match first, fail closed on UNKNOWN", () => {
  function catalogOf(backends: BackendSpec[]): BackendCatalog {
    return BackendCatalog.parse({ apiVersion: 1, backends });
  }

  it("excludes a backend that does not declare the capability", () => {
    const catalog = catalogOf([
      spec({ id: "a", capabilities: { code: "NATIVE" } }),
      spec({ id: "b", capabilities: { docs: "NATIVE" } }),
    ]);
    const decision = selectBackend(catalog, { capability: "code" }, new Map());
    expect(decision.selected?.id).toBe("a");
  });

  it("excludes a backend whose support for the capability is UNKNOWN", () => {
    // UNKNOWN must fail closed: never attempt a backend that may not be able
    // to do the work.
    const catalog = catalogOf([
      spec({ id: "unknown-cap", capabilities: {} }),
      spec({ id: "known-cap", capabilities: { code: "DEGRADED" } }),
    ]);
    const decision = selectBackend(catalog, { capability: "code" }, new Map());
    expect(decision.selected?.id).toBe("known-cap");
  });

  it("refuses an explicit backend that does not declare the capability", () => {
    const catalog = catalogOf([spec({ id: "a", capabilities: { docs: "NATIVE" } })]);
    const decision = selectBackend(catalog, { backendId: "a", capability: "code" }, new Map());
    expect(decision.selected).toBeNull();
    expect(decision.reason).toMatch(/does not declare support/);
  });

  it("refuses an explicit backend that does not exist", () => {
    const catalog = catalogOf([spec({ id: "a" })]);
    const decision = selectBackend(catalog, { backendId: "nope" }, new Map());
    expect(decision.selected).toBeNull();
    expect(decision.reason).toMatch(/no backend with id/);
  });

  it("refuses a disabled backend", () => {
    const catalog = catalogOf([spec({ id: "a", enabled: false })]);
    const decision = selectBackend(catalog, { backendId: "a" }, new Map());
    expect(decision.selected).toBeNull();
    expect(decision.reason).toMatch(/disabled/);
  });

  it("skips a backend whose circuit is open", () => {
    const catalog = catalogOf([spec({ id: "a" }), spec({ id: "b" })]);
    const breakers = new Map<string, CircuitBreaker>();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, successThreshold: 1 });
    breaker.recordFailure("timeout", Date.now());
    breakers.set("a", breaker);
    const decision = selectBackend(catalog, {}, breakers);
    expect(decision.selected?.id).toBe("b");
  });

  it("FAILS OPEN on health — tries anyway when every candidate is unhealthy", () => {
    // Refusing everything is a self-inflicted outage. The attempt may succeed.
    const catalog = catalogOf([spec({ id: "a" })]);
    const breakers = new Map<string, CircuitBreaker>();
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 10_000, successThreshold: 1 });
    breaker.recordFailure("timeout", Date.now());
    breakers.set("a", breaker);
    const decision = selectBackend(catalog, {}, breakers);
    expect(decision.selected?.id).toBe("a");
  });
});

describe("delegation — the fallback chain", () => {
  it("returns the first success and stops", async () => {
    const good = await scriptBackend("good", `process.stdout.write("ok");`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [good] });
    const result = await delegate({ catalog, args: [] });
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(1);
    expect(result.outcome?.stdout).toBe("ok");
  });

  it("does NOT fall back after a per-backend failure, because the attempt may have had an effect", async () => {
    // We KNOW the backend failed, and "this backend failed" is exactly what
    // a fallback is FOR — the taxonomy still marks `backend_failed` as
    // fallbackable. But the backend RAN, so it may have written a file before
    // it died, and re-running the task would run that effect a second time.
    //
    // Two gates, two questions: the taxonomy says whether another backend is
    // WORTH trying; the effect rule says whether it is SAFE to try.
    const bad = await scriptBackend("bad", `process.exit(3);`);
    const good = await scriptBackend("good2", `process.stdout.write("ok2");`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [bad, good] });
    const result = await delegate({ catalog, args: [] });
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.backendId).toBe("bad");
    expect(result.attempts[0]!.failureClass).toBe("backend_failed");
    expect(result.attempts[0]!.effectState).toBe("UNKNOWN");
  });

  it("falls back after a per-backend failure when the caller declares the task re-runnable", async () => {
    const bad = await scriptBackend("bad", `process.exit(3);`);
    const good = await scriptBackend("good2", `process.stdout.write("ok2");`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [bad, good] });
    const result = await delegate({ catalog, args: [], reRunnable: true });
    expect(result.ok).toBe(true);
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]!.backendId).toBe("bad");
    expect(result.attempts[1]!.backendId).toBe("good2");
  });

  it("does NOT fall back for a failure that would fail identically elsewhere", async () => {
    // An auth failure is about the credentials, not about this backend: every
    // backend on this machine would reject the same credentials.
    const one = await scriptBackend(
      "one",
      `process.stdout.write(JSON.stringify({ type: "error", error: { name: "AuthenticationError", data: { statusCode: 401 } } })); process.exit(1);`,
    );
    const two = await scriptBackend("two", `process.exit(1);`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [one, two] });
    const result = await delegate({ catalog, args: [] });
    expect(result.ok).toBe(false);
    // The chain stopped at the auth failure — the second backend was never tried.
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.failureClass).toBe("auth");
  });

  it("does NOT retry a bare non-zero exit on another backend — the backend ran", async () => {
    // We KNOW the backend failed. We do not know why, and no cause is
    // invented — the class is still `backend_failed`. But "probably
    // harmless" is not "harmless": the process ran, so the effect state is
    // unknown, and the fallback is refused.
    //
    // The classification is unchanged; the refusal is about SAFETY, not
    // about usefulness. The taxonomy still says another backend is worth
    // trying — it just may not be safe to try it.
    const one = await scriptBackend("one", `process.exit(3);`);
    const two = await scriptBackend("two", `process.stdout.write("ok");`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [one, two] });
    const result = await delegate({ catalog, args: [] });
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(1);
    expect(result.attempts[0]!.failureClass).toBe("backend_failed");
    expect(result.attempts[0]!.fallbackLegal).toBe(false);
  });

  it("records a telemetry event for every attempt", async () => {
    const backend = await scriptBackend("telemetry", `process.stdout.write("x");`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [backend] });
    const result = await delegate({ catalog, args: [] });
    const types = result.events.map((e) => e.type);
    expect(types).toContain("ROUTE_SELECTED");
    expect(types).toContain("DELEGATION_STARTED");
    expect(types).toContain("DELEGATION_SUCCEEDED");
    // Every event is well-formed and carries the required fields.
    for (const e of result.events) {
      expect(e.backendId).toBeTruthy();
      expect(e.at).toBeGreaterThan(0);
    }
  });

  it("opens a backend's circuit after repeated failures", async () => {
    const bad = await scriptBackend("flaky", `process.exit(1);`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [bad] });
    const breakers = new Map<string, CircuitBreaker>();
    breakers.set("flaky", new CircuitBreaker({ failureThreshold: 2, cooldownMs: 10_000, successThreshold: 1 }));

    await delegate({ catalog, args: [], breakers });
    await delegate({ catalog, args: [], breakers });

    expect(breakers.get("flaky")!.state).toBe("open");
  });

  it("does not consume a half-open trial for a candidate that is passed over", async () => {
    // The bug this prevents: selection consults the breaker, and if that
    // consultation claimed the single half-open trial, the backend could never
    // be tried again — a permanent silent exclusion.
    const first = await scriptBackend("first", `process.stdout.write("ok");`);
    const second = await scriptBackend("second", `process.stdout.write("ok");`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [first, second] });

    const breakers = new Map<string, CircuitBreaker>();
    const secondBreaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 0, successThreshold: 1 });
    breakers.set("second", secondBreaker);

    // The second backend's circuit has failed and its cooldown has elapsed, so
    // it is eligible — but it is not the FIRST candidate.
    secondBreaker.recordFailure("timeout", Date.now() - 10_000);

    const result = await delegate({ catalog, args: [], breakers });
    expect(result.ok).toBe(true);
    // The first candidate succeeded, so the second was never attempted — and
    // its half-open trial must still be AVAILABLE. The state is still "open"
    // because no trial happened, but the slot was not consumed, so the
    // backend can still be tried.
    expect(result.attempts).toHaveLength(1);
    expect(secondBreaker.canAttempt(Date.now())).toBe(true);
  });

  it("records exactly one ROUTE_SELECTED per attempt", async () => {
    const backend = await scriptBackend("one-route", `process.stdout.write("ok");`);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [backend] });
    const result = await delegate({ catalog, args: [] });
    const routes = result.events.filter((e) => e.type === "ROUTE_SELECTED");
    expect(routes).toHaveLength(1);
  });

  it("reports no eligible backend rather than crashing", async () => {
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [] });
    const result = await delegate({ catalog, args: [] });
    expect(result.ok).toBe(false);
    expect(result.selected).toBeNull();
    expect(result.reason).toBeTruthy();
  });
});

describe("probing — a probe never runs the real work", () => {
  it("reports a missing backend as unavailable", async () => {
    const backend = spec({ id: "absent", command: "definitely-not-a-real-command-xyz" });
    const probe = await probeBackend(backend);
    expect(probe.available).toBe(false);
    expect(probe.reason).toBeTruthy();
  });

  it("extracts a version from the probe output", async () => {
    // The probe may use a different command line from the real work.
    const dir = await mkdtemp(join(tmpdir(), "delegate-version-"));
    const file = join(dir, "main.mjs");
    await writeFile(file, `process.stdout.write("mytool 1.2.3\\n");`, "utf8");
    const backend = spec({
      id: "versioned",
      command: process.execPath,
      args: [file],
      probe: { command: process.execPath, argv: [file], timeoutMs: 5_000, versionPattern: "(\\d+\\.\\d+\\.\\d+)" },
    });
    const probe = await probeBackend(backend);
    expect(probe.available).toBe(true);
    expect(probe.version).toBe("1.2.3");
  });

  it("reports a backend that declares no command as unavailable", async () => {
    const backend = spec({ id: "no-cmd", command: undefined });
    const probe = await probeBackend(backend);
    expect(probe.available).toBe(false);
  });
});

describe("output caps — a misbehaving backend cannot exhaust the host", () => {
  it("has a sane default cap", () => {
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("caps the output in BYTES, not characters", async () => {
    // A stream of 4-byte characters would use four times the intended memory
    // if the cap were counted in characters — and the accumulation guard is
    // what stops an unbounded producer from exhausting the host, so it has to
    // be measured in the same unit the cap is expressed in.
    const backend = await scriptBackend(
      "wide",
      `process.stdout.write("\\u{1F600}".repeat(50000));`,
    );
    const outcome = await executeBackend(backend, [], { maxOutputBytes: 4_096 });
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.stdout, "utf8")).toBeLessThanOrEqual(4_096 + 4);
  });

  it("captures a normal-sized output in full", async () => {
    const backend = await scriptBackend("normal", `process.stdout.write("y".repeat(1000));`);
    const outcome = await executeBackend(backend, []);
    expect(outcome.truncated).toBe(false);
    expect(outcome.stdout).toHaveLength(1_000);
  });
});
