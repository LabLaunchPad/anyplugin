/**
 * The chain-wide budget audit.
 *
 * ── What this is for ───────────────────────────────────────────────────────
 *
 * `FAIL_POLICY.onBudgetExhausted` says *"An exhausted deadline ends the
 * chain — continuing guarantees lateness"*, and it had **no consumer**: the
 * constant declared a policy the chain did not implement. The chain's only
 * bound was the per-attempt timeout, so the worst case was
 * *candidates × timeout* — unbounded from the caller's point of view, and
 * invisible in the telemetry.
 *
 * The budget is **chain-wide**, and it bounds the per-attempt timeout too:
 * an attempt may not overrun the deadline the whole chain is racing.
 *
 * The budget is **opt-in**, and that is a deliberate choice: a budget the
 * caller did not ask for is a budget the caller did not choose, and
 * `--timeout` already means "per attempt" to anyone who has read the help.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackendCatalog } from "@lablaunchpad/core";
import { delegate } from "./delegate.js";

/** A backend that succeeds immediately. */
const SUCCEEDS = `process.stdout.write("ok");`;

/** A backend that sleeps for a long time, so it consumes the budget. */
const SLEEPS = `
setTimeout(() => { process.stdout.write("late"); }, 60_000);
`;

/** A backend that fails, silently, without touching the workspace. */
const FAILS = `process.exit(1);`;

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

describe("the chain-wide budget", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "delegate-budget-"));
  });

  afterEach(async () => {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  it("ends the chain when the budget is exhausted, and says so", async () => {
    const slow = await scriptBackend(workDir, "slow", SLEEPS);
    const next = await scriptBackend(workDir, "next", SUCCEEDS);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [slow, next] });

    const result = await delegate({
      catalog,
      cwd: workDir,
      args: [],
      budgetMs: 400,
      reRunnable: true,
    });

    expect(result.ok, "the chain must not succeed after its budget is gone").toBe(false);
    expect(result.attempts.length, "the second backend must not have run").toBe(1);
    expect(result.reason, "the reason must name the budget").toMatch(/budget/i);
  });

  it("emits a BUDGET_EXHAUSTED event", async () => {
    const slow = await scriptBackend(workDir, "slow", SLEEPS);
    const next = await scriptBackend(workDir, "next", SUCCEEDS);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [slow, next] });

    const result = await delegate({
      catalog,
      cwd: workDir,
      args: [],
      budgetMs: 400,
      reRunnable: true,
    });

    const exhausted = result.events.filter((e) => e.type === "BUDGET_EXHAUSTED");
    expect(exhausted.length, "the budget exhaustion must be in the telemetry").toBe(1);
  });

  it("bounds the per-attempt timeout by the remaining budget", async () => {
    // The attempt must not be allowed to outlive the chain's deadline. A
    // backend that sleeps for a minute must be killed by the budget, not by
    // the per-attempt timeout of five seconds.
    const slow = await scriptBackend(workDir, "slow", SLEEPS, { timeoutMs: 60_000 });
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [slow] });

    const started = Date.now();
    const result = await delegate({
      catalog,
      cwd: workDir,
      args: [],
      budgetMs: 500,
      reRunnable: true,
    });
    const elapsed = Date.now() - started;

    expect(result.attempts[0]?.timedOut, "the attempt must have been killed").toBe(true);
    expect(elapsed, "the attempt must not have outlived the budget").toBeLessThan(5_000);
  });

  it("ends the chain when the attempt budget is exhausted", async () => {
    const first = await scriptBackend(workDir, "first", FAILS);
    const second = await scriptBackend(workDir, "second", FAILS);
    const third = await scriptBackend(workDir, "third", SUCCEEDS);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [first, second, third] });

    const result = await delegate({
      catalog,
      cwd: workDir,
      args: [],
      maxAttempts: 2,
      reRunnable: true,
    });

    expect(result.attempts.length, "the chain must stop at the attempt budget").toBe(2);
    expect(result.ok).toBe(false);
    expect(result.reason, "the reason must name the attempt budget").toMatch(/attempt budget/i);
    expect(result.events.some((e) => e.type === "BUDGET_EXHAUSTED")).toBe(true);
  });

  it("leaves the chain unbounded when no budget is given", async () => {
    // The current behaviour, preserved: a budget the caller did not ask for
    // is a budget the caller did not choose. The bound is opt-in, and the
    // help says so.
    const first = await scriptBackend(workDir, "first", FAILS);
    const second = await scriptBackend(workDir, "second", SUCCEEDS);
    const catalog = BackendCatalog.parse({ apiVersion: 1, backends: [first, second] });

    const result = await delegate({ catalog, cwd: workDir, args: [], reRunnable: true });

    expect(result.attempts.length, "without a budget the chain walks every candidate").toBe(2);
    expect(result.ok).toBe(true);
  });
});
