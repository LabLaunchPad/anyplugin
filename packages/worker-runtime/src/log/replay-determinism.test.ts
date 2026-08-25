/**
 * GATE 4 — deterministic replay across a PROCESS BOUNDARY.
 *
 * Gate 3 already showed that replaying the same log twice inside one process
 * yields the same state. That is necessary and not sufficient: a second replay
 * in the same process shares module state, lazily-initialized schema objects,
 * warmed caches, and every environment value read at import time. If any of
 * those silently contributed to the result, in-process repetition would agree
 * with itself forever and never reveal it.
 *
 * So the property under test here is stronger, and it is the one the whole
 * runtime rests on:
 *
 *   THE EVENT HISTORY IS THE SOURCE OF TRUTH — not the process that wrote it,
 *   and not the process that read it last.
 *
 * Concretely: identical authoritative history + identical declared inputs must
 * produce an identical canonical state, in a process that shares nothing with
 * the writer.
 *
 * A static audit of the replay path found no clock, no randomness, no locale
 * comparison, no directory enumeration and no module-level mutable state. That
 * audit is useful and is not proof — it only covers what someone thought to
 * look for. These tests cover what nobody thought of, because a second process
 * either agrees or it does not.
 *
 * Comparison is by canonical bytes and content hash, never object identity:
 * two objects can be `deepEqual` and serialize differently, and it is the
 * serialization that certificates will eventually bind.
 *
 * SCOPE — what this gate does NOT establish. Deterministic reconstruction is
 * not durability. These tests prove state can be rebuilt from a log that
 * survived; they say nothing about whether the log survives a crash or power
 * loss. U1 stays UNKNOWN.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONTRACT_VERSION, type WorkerEvent } from "../contracts/index.js";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import { EventLog, LOG_FILENAME } from "./event-log.js";
import { replay, replayDigest } from "./replay.js";
import { foldFromReplay, stateHash } from "./worker-state.js";

/**
 * Spawn-heavy and filesystem-heavy, and it runs concurrently with the rest of
 * the workspace. The default 5s bound is calibrated for unit tests; relying on
 * it here would make the pass a property of runner speed (F17).
 */
vi.setConfig({ testTimeout: 30_000 });

const DIST_DIR = join(import.meta.dirname, "..", "..", "dist", "log");
const distBuilt = existsSync(join(DIST_DIR, "replay.js"));

const roots: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "gate4-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const EVENTS_DIR = `${STORAGE_ROOT_DIRNAME}/events`;
const logDirOf = (root: string) => join(root, EVENTS_DIR);
const logFileOf = (root: string) => join(logDirOf(root), LOG_FILENAME);
const framesOf = (root: string) =>
  readFileSync(logFileOf(root), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);

function transition(n: number, to: string, contract = "WC-alpha"): Omit<WorkerEvent, "sequence"> {
  return {
    id: `EVT-${n}`,
    contractVersion: CONTRACT_VERSION,
    at: "2026-08-24T20:00:00Z",
    actor: "worker-runtime/1.0.0",
    kind: "STATE_TRANSITION",
    subject: contract,
    payload: { to },
  };
}

/**
 * An authoritative history worth comparing: two independent contracts,
 * interleaved, plus an event kind the fold does not interpret. Interleaving
 * matters — it is what makes insertion order into the state map depend on
 * traversal order rather than on the alphabet.
 */
function writeHistory(root: string): void {
  const log = EventLog.open(root);
  try {
    log.append(transition(0, "PLANNING", "WC-beta"));
    log.append(transition(1, "PLANNING", "WC-alpha"));
    log.append({ ...transition(2, "PLANNING", "WC-alpha"), kind: "EVIDENCE_ADDED" });
    log.append(transition(3, "EXECUTING", "WC-alpha"));
    log.append(transition(4, "EXECUTING", "WC-beta"));
    log.append(transition(5, "VERIFYING", "WC-alpha"));
    log.append(transition(6, "COMPLETED", "WC-alpha"));
  } finally {
    log.close();
  }
}

/** What both the in-process and the fresh-process paths report. */
interface Digest {
  stateHash: string;
  replayDigest: string;
  events: number;
  anomalies: number;
  gaps: number[];
}

function digestInProcess(dir: string): Digest {
  const report = replay(dir);
  return {
    stateHash: stateHash(foldFromReplay(report)),
    replayDigest: replayDigest(report),
    events: report.events.length,
    anomalies: report.anomalies.length,
    gaps: report.gaps,
  };
}

/**
 * Replay in a process that shares nothing with this one.
 *
 * `env` and `cwd` are settable so that environment-derived hidden state shows
 * up as disagreement rather than as a passing test.
 */
function digestInFreshProcess(dir: string, opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Digest {
  const script = join(mkdtempSync(join(tmpdir(), "gate4-child-")), "replay-child.mjs");
  roots.push(join(script, ".."));
  writeFileSync(
    script,
    `import { replay, replayDigest } from ${JSON.stringify(pathToFileURL(join(DIST_DIR, "replay.js")).href)};
import { foldFromReplay, stateHash } from ${JSON.stringify(pathToFileURL(join(DIST_DIR, "worker-state.js")).href)};
const report = replay(process.argv[2]);
process.stdout.write(JSON.stringify({
  stateHash: stateHash(foldFromReplay(report)),
  replayDigest: replayDigest(report),
  events: report.events.length,
  anomalies: report.anomalies.length,
  gaps: report.gaps,
}));
`,
    "utf8",
  );
  const out = spawnSync(process.execPath, [script, dir], {
    encoding: "utf8",
    cwd: opts.cwd ?? tmpdir(),
    env: { ...process.env, ...opts.env },
  });
  expect(out.status, `replay child failed: ${out.stderr}`).toBe(0);
  return JSON.parse(out.stdout) as Digest;
}

it("the Gate 4 harness is not silently skipped in CI", () => {
  // A skipped process-boundary proof that reads as a pass is the exact
  // ARMED-as-PASSED failure these gates exist to prevent.
  if (process.env["CI"]) expect(distBuilt, `built kernel missing at ${DIST_DIR}`).toBe(true);
  else expect(true).toBe(true);
});

describe.skipIf(!distBuilt)("GATE 4 — the event history is the source of truth", () => {
  it("a fresh process reconstructs byte-identical state", () => {
    const root = workspace();
    writeHistory(root);

    const here = digestInProcess(logDirOf(root));
    const there = digestInFreshProcess(logDirOf(root));

    expect(there.stateHash, "a process sharing nothing with the writer must agree").toBe(here.stateHash);
    expect(there.replayDigest).toBe(here.replayDigest);
    expect(here.events).toBe(7);
    expect(here.anomalies).toBe(0);
  });

  it("two independent fresh processes agree with each other", () => {
    // Neither has seen this repository's module state, and neither has seen
    // the other. If any hidden per-process input existed, this is where two
    // cold starts would diverge.
    const root = workspace();
    writeHistory(root);
    expect(digestInFreshProcess(logDirOf(root))).toEqual(digestInFreshProcess(logDirOf(root)));
  });

  it("is independent of the working directory the reader runs from", () => {
    const root = workspace();
    const elsewhere = workspace();
    writeHistory(root);
    expect(digestInFreshProcess(logDirOf(root), { cwd: elsewhere }).stateHash).toBe(
      digestInFreshProcess(logDirOf(root), { cwd: tmpdir() }).stateHash,
    );
  });

  it("is independent of timezone", () => {
    // The events carry offset-bearing timestamps; if any of them were ever
    // re-parsed through a local-time path, TZ would move the result.
    const root = workspace();
    writeHistory(root);
    expect(digestInFreshProcess(logDirOf(root), { env: { TZ: "Asia/Kolkata" } }).stateHash).toBe(
      digestInFreshProcess(logDirOf(root), { env: { TZ: "UTC" } }).stateHash,
    );
  });

  it("is independent of locale", () => {
    // Key ordering in canonicalization and contract ordering in the fold both
    // sort. A locale-aware sort would reorder under a different collation and
    // change the canonical bytes.
    const root = workspace();
    writeHistory(root);
    const de = digestInFreshProcess(logDirOf(root), { env: { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" } });
    const c = digestInFreshProcess(logDirOf(root), { env: { LANG: "C", LC_ALL: "C" } });
    expect(de.stateHash).toBe(c.stateHash);
  });

  it("is independent of where the log lives on disk", () => {
    // Copy the whole authoritative history to an unrelated path. Same bytes,
    // different location: state must not encode its own address.
    const origin = workspace();
    const copy = workspace();
    writeHistory(origin);
    cpSync(logDirOf(origin), logDirOf(copy), { recursive: true });
    expect(digestInFreshProcess(logDirOf(copy)).stateHash).toBe(digestInFreshProcess(logDirOf(origin)).stateHash);
  });

  it("is independent of the process that wrote the log", () => {
    // Two workspaces written by two separate writer processes from the same
    // script must yield the same state, so nothing about the writer's identity
    // (pid, host, claim time) leaks out of writer.lock into the history.
    const a = workspace();
    const b = workspace();
    writeHistory(a);
    writeHistory(b);
    expect(digestInFreshProcess(logDirOf(a)).stateHash).toBe(digestInFreshProcess(logDirOf(b)).stateHash);
  });
});

describe.skipIf(!distBuilt)("GATE 4 — damage replays deterministically too", () => {
  /**
   * A corrupted log must produce the SAME wrong answer every time, in every
   * process. Non-deterministic damage handling would mean two operators
   * recovering the same broken log reach two different conclusions about what
   * survived — which is worse than the damage.
   *
   * Each case must also differ from the clean digest: a mutation that replay
   * cannot distinguish from the original would be a silent-acceptance defect.
   */
  const mutations: [string, (root: string) => void][] = [
    // NOTE: byte reordering is deliberately NOT in this list. It changes the
    // serialization, not the history — `sequence` carries order, file position
    // does not — so replay is *required* to produce the identical result. It
    // has its own test below. Listing it here asserted the opposite and caught
    // a contradiction in this file rather than in the code.
    ["duplicated event", (r) => writeFileSync(logFileOf(r), `${[...framesOf(r), framesOf(r)[2]!].join("\n")}\n`)],
    ["missing event", (r) => writeFileSync(logFileOf(r), `${framesOf(r).filter((_, i) => i !== 3).join("\n")}\n`)],
    [
      "modified payload",
      (r) => writeFileSync(logFileOf(r), readFileSync(logFileOf(r), "utf8").replace('"to":"EXECUTING"', '"to":"BLOCKED"')),
    ],
    [
      "changed sequence number",
      (r) => writeFileSync(logFileOf(r), readFileSync(logFileOf(r), "utf8").replace('"sequence":3', '"sequence":9')),
    ],
    ["truncated final record", (r) => truncateSync(logFileOf(r), statSync(logFileOf(r)).size - 40)],
    ["corrupted frame header", (r) => writeFileSync(logFileOf(r), `${framesOf(r).join("\n")}\nnot-a-frame\n`)],
  ];

  it.each(mutations)("%s: same result in every process, and not the clean result", (_name, mutate) => {
    const clean = workspace();
    writeHistory(clean);
    const cleanDigest = digestInFreshProcess(logDirOf(clean));

    const damaged = workspace();
    writeHistory(damaged);
    mutate(damaged);

    const first = digestInFreshProcess(logDirOf(damaged));
    const second = digestInFreshProcess(logDirOf(damaged));
    const local = digestInProcess(logDirOf(damaged));

    // Deterministic across processes, and consistent with in-process replay.
    expect(first).toEqual(second);
    expect(first.replayDigest).toBe(local.replayDigest);
    expect(first.stateHash).toBe(local.stateHash);

    // And detectably different from an undamaged history.
    expect(
      first.replayDigest,
      "a mutation replay cannot distinguish from the original would be silent acceptance",
    ).not.toBe(cleanDigest.replayDigest);
  });

  it("reordering the bytes does not reorder the recovered state", () => {
    // Order is carried by `sequence`, not by position in the file. Reversing
    // the frames must therefore change nothing about the state, only about the
    // bytes on disk — the one mutation in the list above whose STATE is
    // expected to survive intact.
    const root = workspace();
    writeHistory(root);
    const before = digestInFreshProcess(logDirOf(root)).stateHash;
    writeFileSync(logFileOf(root), `${[...framesOf(root)].reverse().join("\n")}\n`);
    expect(digestInFreshProcess(logDirOf(root)).stateHash).toBe(before);
  });
});
