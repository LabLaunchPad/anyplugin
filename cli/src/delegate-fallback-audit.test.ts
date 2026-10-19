/**
 * The fallback-chain audit — the double-execution defect (P1-10).
 *
 * ── What this file is ──────────────────────────────────────────────────────
 *
 * `packages/worker-runtime/src/telemetry/delegation.ts` defines the rule
 * "once a turn has committed, the fallback chain is closed", and the follow-on
 * rule "a turn whose effect state is unknown may not be re-run". The rule is
 * sound. The problem was that the only live consumer fed it a CONSTANT.
 *
 * `cli/src/delegate.ts` set `committed: false` at every call site, so
 * `fallbackLegal(false)` was always true, `canFallback` never refused, and the
 * chain never closed. A backend that produced output and then failed was
 * followed by a SECOND backend running the SAME task.
 *
 * That is not a theoretical gap. The host received both answers — `bin.ts`
 * printed every attempt's stdout — and the second backend re-ran whatever
 * side effects the first one had already performed.
 *
 * ── The three signals, kept distinct ───────────────────────────────────────
 *
 * - `committed`      — the host HAS the output. Irreversible. A buffered
 *                      wrapper has not handed anything over, so it is false.
 * - `outputProduced` — the attempt produced an answer. NOT a gate: nearly
 *                      every backend prints something, so gating on it would
 *                      stop the chain from ever falling back.
 * - `effectState`    — whether a side effect may have happened. THIS is the
 *                      gate, and `UNKNOWN` forbids the fallback.
 *
 * ── Why the rule is not merely "too narrow" ────────────────────────────────
 *
 * P1-10 records the rule as ignoring *in-flight effects*. That is true, and
 * it is the DEEPER problem, but it is not the one that was exploitable. The
 * exploitable one was shallower: the rule's existing input was never set to
 * the dangerous value. Narrowing the rule further while leaving the input
 * hard-coded would have changed nothing observable.
 *
 * ── The discipline these tests follow ──────────────────────────────────────
 *
 * A defect that is only described is not a defect that is fixed. Every test
 * here drives a real subprocess against a real directory and asserts on the
 * filesystem, because the harm is a filesystem effect: if the assertion were
 * made on the returned events, a wrapper that lied about its own telemetry
 * would pass.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendCatalog } from "@lablaunchpad/core";
import { delegate } from "./delegate.js";

/**
 * A backend that appends its name to `marker.log` in the working directory,
 * writes a line to stdout, and then fails.
 *
 * The append is the side effect. It is the thing a fallback would duplicate.
 */
const MUTATING_AND_FAILING = (id: string, exitCode: number) => `
import { appendFileSync, writeSync } from "node:fs";
appendFileSync("marker.log", "${id}\\n");
writeSync(1, "PARTIAL ANSWER FROM ${id}\\n");
process.exit(${exitCode});
`;

/** A backend that mutates the workspace and fails SILENTLY — no output at all. */
const MUTATING_AND_FAILING_SILENTLY = (id: string, exitCode: number) => `
import { appendFileSync } from "node:fs";
appendFileSync("marker.log", "${id}\\n");
process.exit(${exitCode});
`;

/** A backend that succeeds after recording its own side effect. */
const MUTATING_AND_SUCCEEDING = (id: string) => `
import { appendFileSync, writeSync } from "node:fs";
appendFileSync("marker.log", "${id}\\n");
writeSync(1, "FULL ANSWER FROM ${id}\\n");
`;

/** Write a script and return a backend spec pointing at it. */
async function scriptBackend(
  dir: string,
  id: string,
  body: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const file = join(dir, `${id}.mjs`);
  await writeFile(file, body, "utf8");
  return {
    id,
    label: id,
    kind: "cli",
    command: process.execPath,
    args: [file],
    capabilities: {},
    domains: [],
    timeoutMs: 5_000,
    enabled: true,
    circuit: { failureThreshold: 3, cooldownMs: 1_000, successThreshold: 1 },
    env: {},
    ...overrides,
  };
}

/** The lines of the marker file — the record of which backends actually ran. */
async function ran(workDir: string): Promise<string[]> {
  const path = join(workDir, "marker.log");
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text.split("\n").filter((l) => l.trim() !== "");
}

describe("the fallback chain — a failed attempt must not be re-run", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "delegate-fallback-"));
  });

  afterEach(async () => {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("does not run a second backend after the first one had an effect", async () => {
    // Alpha mutates the workspace and fails. Beta would mutate it again.
    // The attempt's effect state is UNKNOWN — the backend ran — so the
    // fallback is refused.
    const alpha = await scriptBackend(workDir, "alpha", MUTATING_AND_FAILING_SILENTLY("alpha", 1));
    const beta = await scriptBackend(workDir, "beta", MUTATING_AND_SUCCEEDING("beta"));
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [alpha, beta] });

    const result = await delegate({ catalog, cwd: workDir, args: [] });

    expect(
      await ran(workDir),
      "the task ran more than once — the side effect was duplicated",
    ).toEqual(["alpha"]);
    expect(result.attempts.length, "the second backend must not have run").toBe(1);
    expect(result.attempts[0]?.effectState, "the backend ran, so its effect state is unknown").toBe("UNKNOWN");
  });

  it("does not re-run the task when the first backend timed out after writing", async () => {
    // The timeout case is the one the existing test asserted the opposite of.
    // A timed-out turn is NOT necessarily uncommitted: the backend may have
    // written files before the deadline killed it.
    const alpha = await scriptBackend(
      workDir,
      "alpha",
      `
import { appendFileSync } from "node:fs";
appendFileSync("marker.log", "alpha\\n");
setTimeout(() => {}, 60_000);
`,
      { timeoutMs: 400 },
    );
    const beta = await scriptBackend(workDir, "beta", MUTATING_AND_SUCCEEDING("beta"));
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [alpha, beta] });

    const result = await delegate({ catalog, cwd: workDir, args: [] });

    expect(result.attempts[0]?.timedOut, "the first attempt must have timed out").toBe(true);
    expect(
      await ran(workDir),
      "a timed-out backend had already written to the workspace, and the task was run again",
    ).toEqual(["alpha"]);
  });

  it("still falls back when the first backend could not be started at all", async () => {
    // The fix must not disable the fallback entirely — that would be a
    // different bug. A backend whose command does not exist provably did
    // nothing: the process never ran. That is the case a fallback exists for.
    const alpha = await scriptBackend(workDir, "alpha", "", {
      command: "definitely-not-a-real-command-xyz",
      args: [],
    });
    const beta = await scriptBackend(workDir, "beta", MUTATING_AND_SUCCEEDING("beta"));
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [alpha, beta] });

    const result = await delegate({ catalog, cwd: workDir, args: [] });

    expect(result.attempts[0]?.failureClass, "a missing command is a spawn failure").toBe("spawn_failed");
    expect(result.attempts[0]?.effectState, "a process that never ran provably had no effect").toBe("NONE");
    expect(result.attempts.length, "a backend that never ran must still fall back").toBe(2);
    expect(result.ok, "the second backend should have succeeded").toBe(true);
  });

  it("falls back when the caller asserts the task is safe to repeat", async () => {
    // The escape hatch. `--re-runnable` is an assertion by the caller that
    // repeating the task is safe — it is not a proof by the wrapper — and it
    // restores the old behaviour deliberately rather than by default.
    const alpha = await scriptBackend(workDir, "alpha", MUTATING_AND_FAILING_SILENTLY("alpha", 1));
    const beta = await scriptBackend(workDir, "beta", MUTATING_AND_SUCCEEDING("beta"));
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [alpha, beta] });

    const result = await delegate({ catalog, cwd: workDir, args: [], reRunnable: true });

    expect(result.attempts.length, "an explicitly re-runnable task must still fall back").toBe(2);
    expect(result.ok, "the second backend should have succeeded").toBe(true);
  });

  it("records that the first attempt produced output, so the presentation layer can withhold it", async () => {
    // `outputProduced` is not a gate on the fallback — it is the fact the
    // presentation layer uses to decide which attempt's stdout is the
    // ANSWER. `bin.ts` sends only the answer attempt's stdout to stdout, and
    // every earlier attempt's output to stderr as diagnostics.
    const alpha = await scriptBackend(workDir, "alpha", MUTATING_AND_FAILING("alpha", 1));
    const beta = await scriptBackend(workDir, "beta", MUTATING_AND_SUCCEEDING("beta"));
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [alpha, beta] });

    const result = await delegate({ catalog, cwd: workDir, args: [], reRunnable: true });

    expect(result.attempts[0]?.outputProduced, "the first attempt did produce output").toBe(true);
    expect(result.attempts[0]?.committed, "the host has not been handed it — the CLI buffers").toBe(false);
    expect(result.attempts.length, "a re-runnable task may still fall back").toBe(2);
  });

  it("refuses to fall back and says why, in the failure reason", async () => {
    // A refusal the operator cannot act on is a refusal they will work around
    // by guessing. The reason must name the cause and the way out.
    const alpha = await scriptBackend(workDir, "alpha", MUTATING_AND_FAILING_SILENTLY("alpha", 1));
    const beta = await scriptBackend(workDir, "beta", MUTATING_AND_SUCCEEDING("beta"));
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [alpha, beta] });

    const result = await delegate({ catalog, cwd: workDir, args: [] });

    expect(result.attempts.length, "the second backend must not have run").toBe(1);
    expect(result.reason, "the reason must explain the refusal and the way out").toContain("--re-runnable");
  });

  it("reports an exit-0 backend that carries an error envelope as a FAILURE", async () => {
    // A backend that fails mid-stream and still exits 0 must not be reported
    // as a success. The envelope cannot be classified into a specific class
    // here, and the answer is NOT "no class" — it is `unknown`, which is a
    // real class whose behaviour is `report`.
    const alpha = await scriptBackend(
      workDir,
      "alpha",
      `
import { writeSync } from "node:fs";
writeSync(1, JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "stopped" }));
`,
    );
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [alpha] });

    const result = await delegate({ catalog, cwd: workDir, args: [] });

    expect(result.ok, "a backend that reported an error must not be a success").toBe(false);
    expect(result.attempts[0]?.failureClass, "an unclassifiable failure is `unknown`, not `success`").toBe("unknown");
  });
});
