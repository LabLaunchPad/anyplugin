/**
 * Deterministic replay across a PROCESS BOUNDARY.
 *
 * Replaying the same log twice inside one process is necessary and not
 * sufficient: a second replay in the same process shares module state,
 * lazily-initialized schema objects, warmed caches, and every environment
 * value read at import time. If any of those silently contributed to the
 * result, in-process repetition would agree with itself forever and never
 * reveal it.
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
 * This is the same class as F16 (a harness that could not observe the
 * property it was cited for). Reading the replay path finds no clock, no
 * randomness, no locale comparison, no directory enumeration and no
 * module-level mutable state — but reading is useful and is not proof: it
 * only covers what someone thought to look for. These tests cover what
 * nobody thought of, because a second process either agrees or it does not.
 *
 * Comparison is by canonical bytes and content hash, never object identity:
 * two objects can be `deepEqual` and serialize differently, and it is the
 * serialization that certificates bind.
 *
 * SCOPE — what this does NOT establish. Deterministic reconstruction is not
 * durability. These tests prove state can be rebuilt from a log that
 * survived; they say nothing about whether the log survives a crash or power
 * loss. That stays UNKNOWN, and nothing here settles it.
 */
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { STORAGE_ROOT_DIRNAME } from "../storage.js";
import { LOG_FILENAME } from "./event-log.js";
import { replay, replayDigest } from "./replay.js";
import { foldFromReplay, stateHash, stateJson } from "./worker-state.js";

/**
 * Spawn-heavy and filesystem-heavy, and it runs concurrently with the rest of
 * the workspace. The default 5s bound is calibrated for unit tests; relying on
 * it here would make the pass a property of runner speed (F17).
 *
 * The bound is 120s, not the 30s the lighter suites use, and the reason is
 * measured: one test here took 59.7s against a 30s limit on a loaded machine
 * and failed on the timeout while the code was correct. This suite spawns
 * dozens of child Node processes, so it competes with every other
 * process-spawning suite for the same cores. `write-contract.test.ts` already
 * uses 120s here for the same reason.
 */
vi.setConfig({ testTimeout: 120_000 });

// `dirname(fileURLToPath(import.meta.url))`, NOT `import.meta.dirname`:
// the latter landed in Node 20.11 and `engines` promises >=20, so it is
// undefined on 20.0-20.10. BUG-04 in the ledger records that class as fixed
// and eradicated, and the Node-20 CI job is the standing guardrail.
const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "log");
const distBuilt = existsSync(join(DIST_DIR, "replay.js"));

const roots: string[] = [];
function workspace(): string {
  const d = mkdtempSync(join(tmpdir(), "replay-determinism-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});
afterAll(() => {
  rmSync(CHILD_DIR, { recursive: true, force: true });
});

const EVENTS_DIR = `${STORAGE_ROOT_DIRNAME}/events`;
const logDirOf = (root: string) => join(root, EVENTS_DIR);
const logFileOf = (root: string) => join(logDirOf(root), LOG_FILENAME);
const framesOf = (root: string) =>
  readFileSync(logFileOf(root), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);

/**
 * The child process's script, written once for the whole file.
 *
 * It imports the BUILT kernel, so the child exercises the same code the
 * publisher would ship — not the sources, and not a copy of the logic.
 */
const CHILD_DIR = mkdtempSync(join(tmpdir(), "replay-child-"));
/**
 * The child scripts, written ONCE for the whole file.
 *
 * They import the BUILT kernel, so the children exercise the same code the
 * publisher would ship — not the sources, and not a copy of the logic. The
 * in-process half of every comparison below therefore runs the SOURCE while
 * the fresh-process half runs the BUILD. If the two ever disagree, the first
 * thing to check is whether the build is stale: `pnpm build`.
 */
const CHILD_SCRIPT = join(CHILD_DIR, "replay-child.mjs");
const WRITER_SCRIPT = join(CHILD_DIR, "replay-writer-child.mjs");
const POISON_SCRIPT = join(CHILD_DIR, "replay-poison-child.mjs");
const REPLAY_URL = JSON.stringify(pathToFileURL(join(DIST_DIR, "replay.js")).href);
const STATE_URL = JSON.stringify(pathToFileURL(join(DIST_DIR, "worker-state.js")).href);
const EVENTLOG_URL = JSON.stringify(pathToFileURL(join(DIST_DIR, "event-log.js")).href);
// canonical.js sits beside log/ in dist/, not inside it.
const CANONICAL_URL = JSON.stringify(pathToFileURL(join(DIST_DIR, "..", "canonical.js")).href);
// contracts/ lives at dist/contracts, not dist/log/contracts — the writer child
// imports the BUILT kernel, and a bad import path here is a test failure that
// reads as "the kernel is non-deterministic" rather than as a typo.
const CONTRACT_URL = JSON.stringify(pathToFileURL(join(DIST_DIR, "..", "contracts", "primitives.js")).href);

/**
 * The history, written ONCE and read by BOTH the writer child and the
 * in-process path.
 *
 * It lives in a file rather than in either script's source so the two cannot
 * drift: a writer child and an in-process writer that disagreed about the
 * event sequence would make every comparison below a comparison of two
 * different histories, and every one of them would still pass.
 *
 * The contract ids are `WC-I` and `WC-i` — differing only in CASE, and
 * ordered differently by code units than by collation. That is the point: a
 * locale-aware sort would order them the other way round, so the locale
 * assertion below can actually fail. With ids that every collation agrees on
 * (`WC-alpha`/`WC-beta`), the assertion could not fail for the reason it
 * claims, which is the F16 class this file exists to catch.
 */
const HISTORY_FILE = join(CHILD_DIR, "history.json");
writeFileSync(
  HISTORY_FILE,
  JSON.stringify([
    { id: "EVT-0", to: "PLANNING", contract: "WC-I" },
    { id: "EVT-1", to: "PLANNING", contract: "WC-i" },
    { id: "EVT-2", to: "PLANNING", contract: "WC-i", kind: "EVIDENCE_ADDED" },
    { id: "EVT-3", to: "EXECUTING", contract: "WC-i" },
    { id: "EVT-4", to: "EXECUTING", contract: "WC-I" },
    { id: "EVT-5", to: "VERIFYING", contract: "WC-i" },
    { id: "EVT-6", to: "COMPLETED", contract: "WC-i" },
  ]),
  "utf8",
);
// The history file's PATH, quoted as a JS string literal for the child
// script. It is a plain path, not a `file://` URL: `readFileSync` treats a
// URL string as a relative path and would look for a file named "file:".
const HISTORY_PATH = JSON.stringify(HISTORY_FILE);

writeFileSync(
  CHILD_SCRIPT,
  `import { replay, replayDigest } from ${REPLAY_URL};
import { foldFromReplay, stateHash, stateJson } from ${STATE_URL};
const report = replay(process.argv[2]);
const folded = foldFromReplay(report);
process.stdout.write(JSON.stringify({
  stateJson: stateJson(folded),
  stateHash: stateHash(folded),
  replayDigest: replayDigest(report),
  events: report.events.length,
  anomalies: report.anomalies.length,
  gaps: report.gaps,
}));
`,
  "utf8",
);

/**
 * The writer child. "Independent of the process that wrote the log" is only
 * meaningful if a DIFFERENT process actually wrote it — two workspaces written
 * by the same in-process call share this process's module state and prove
 * nothing about the writer's identity leaking out of writer.lock.
 */
writeFileSync(
  WRITER_SCRIPT,
  `import { readFileSync } from "node:fs";
import { EventLog } from ${EVENTLOG_URL};
import { CONTRACT_VERSION } from ${CONTRACT_URL};
const history = JSON.parse(readFileSync(${HISTORY_PATH}, "utf8"));
const log = EventLog.open(process.argv[2]);
try {
  for (const h of history) {
    log.append({
      id: h.id,
      contractVersion: CONTRACT_VERSION,
      at: "2026-08-24T20:00:00Z",
      actor: "worker-runtime/1.0.0",
      kind: h.kind ?? "STATE_TRANSITION",
      subject: h.contract,
      payload: { to: h.to },
    });
  }
} finally {
  log.close();
}
`,
  "utf8",
);

/**
 * The poison child. Step 8 of PROVE_REPLAY_DETERMINISM, executed HERE rather
 * than in a separate script.
 *
 * The poison goes into the HASH, not into the reported string. Appending
 * "|pid=..." to the digest would make two poisoned children differ by
 * string concatenation no matter what the kernel does — a test that cannot
 * fail for the reason it claims, which is the class this whole file exists
 * to catch.
 *
 * So the poison child asks the KERNEL's own hashing function for a digest of
 * a payload that carries a process-local value, exactly as a kernel that
 * leaked its pid into the hash would produce. It uses the kernel's
 * `contentHash` and the kernel's `stateJson` of the real folded state, so:
 *
 *   - two fresh processes must disagree (the harness catches the leak), and
 *   - the digest changes if the kernel's hashing changes, so the tripwire
 *     tracks the kernel rather than the test.
 *
 * The real evidence that the KERNEL leaks nothing is the external script
 * `prove-harness-fails.mjs`, which poisons the kernel's own `stateHash` and
 * shows the suite go red. This is the always-on tripwire that runs on every
 * CI cell.
 */
writeFileSync(
  POISON_SCRIPT,
  `import { replay, replayDigest } from ${REPLAY_URL};
import { foldFromReplay, stateHash, stateJson } from ${STATE_URL};
import { contentHash } from ${CANONICAL_URL};
const report = replay(process.argv[2]);
const folded = foldFromReplay(report);
// A kernel that leaked a process-local value into its hash would produce
// this. The value is INSIDE the hashed payload, so the difference is the
// kernel's hashing talking, not string concatenation.
process.stdout.write(JSON.stringify({
  stateHash: contentHash({ pid: process.pid, state: stateJson(folded) }),
  stateHashClean: stateHash(folded),
  replayDigest: replayDigest(report),
}));
`,
  "utf8",
);

/**
 * An authoritative history worth comparing: two independent contracts,
 * interleaved, plus an event kind the fold does not interpret. Interleaving
 * matters — it is what makes insertion order into the state map depend on
 * traversal order rather than on the alphabet.
 *
 * Written by a CHILD PROCESS. "Independent of the process that wrote the log"
 * is only meaningful if a different process actually wrote it; writing from
 * in-process would share this process's module state and prove nothing about
 * the writer's identity leaking out of writer.lock.
 */
function writeHistory(root: string): void {
  const out = spawnSync(process.execPath, [WRITER_SCRIPT, root], { encoding: "utf8" });
  expect(out.status, `writer child failed: ${out.stderr}`).toBe(0);
}

/** What both the in-process and the fresh-process paths report. */
interface Digest {
  /** Canonical folded-state BYTES. */
  stateJson: string;
  /** Content hash of the same state. */
  stateHash: string;
  /**
   * The CLEAN kernel's hash of the same state. Only the poison child reports
   * it, and it is what proves the poisoned digest differs because of the
   * injected value and not because the kernel is simply different.
   */
  stateHashClean?: string;
  replayDigest: string;
  events: number;
  anomalies: number;
  gaps: number[];
}

function digestInProcess(dir: string): Digest {
  const report = replay(dir);
  const folded = foldFromReplay(report);
  return {
    stateJson: stateJson(folded),
    stateHash: stateHash(folded),
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
 *
 * The child script is written ONCE, not once per spawn: a fresh script file
 * per spawn is a fresh file for the operating system's scanner to look at,
 * and on Windows that dominated the runtime of this file. The point of the
 * child is the fresh PROCESS, not the fresh script.
 */
function digestInFreshProcess(dir: string, opts: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Digest {
  const out = spawnSync(process.execPath, [CHILD_SCRIPT, dir], {
    encoding: "utf8",
    cwd: opts.cwd ?? tmpdir(),
    env: { ...process.env, ...opts.env },
  });
  expect(out.status, `replay child failed: ${out.stderr}`).toBe(0);
  return JSON.parse(out.stdout) as Digest;
}

/**
 * A child whose digest carries a process-local value, hashed by the KERNEL's
 * own `contentHash`. Step 8 of PROVE_REPLAY_DETERMINISM, run HERE rather than
 * in a separate script: the point is that a leaking reader disagrees with a
 * second fresh process, so the cross-process comparison is comparing two
 * genuinely different strings. If it were comparing identical strings it
 * would prove nothing at all.
 */
function digestInPoisonedProcess(dir: string): Digest {
  const out = spawnSync(process.execPath, [POISON_SCRIPT, dir], { encoding: "utf8" });
  expect(out.status, `poison child failed: ${out.stderr}`).toBe(0);
  return JSON.parse(out.stdout) as Digest;
}

it("the process-boundary harness is not silently skipped in CI", () => {
  // A skipped process-boundary proof that reads as a pass is the exact
  // ARMED-as-PASSED failure these proofs exist to prevent.
  if (process.env["CI"]) expect(distBuilt, `built kernel missing at ${DIST_DIR}`).toBe(true);
  else expect(true).toBe(true);
});

// When the built kernel is absent the whole describe block is skipped, and a
// skip that reads as a pass is the failure these proofs exist to prevent. Say
// so out loud rather than leaving it to be inferred from the summary line.
if (!distBuilt) console.log("[ARMED] replay-determinism proof: built kernel missing at %s — the process-boundary tests are skipped, not passed. Run `pnpm build`.", DIST_DIR);

describe.skipIf(!distBuilt)("the event history is the source of truth", () => {
  it("a fresh process reconstructs byte-identical state", () => {
    const root = workspace();
    writeHistory(root);

    const here = digestInProcess(logDirOf(root));
    const there = digestInFreshProcess(logDirOf(root));

    // The in-process path reads the SOURCE and the fresh-process path reads the
    // BUILD. If this ever fails, the first thing to check is not the kernel —
    // it is whether the build is stale: `pnpm build`.
    //
    // Canonical BYTES first, then the hash of them: two objects can be
    // deepEqual and serialize differently, and it is the serialization that
    // certificates bind.
    expect(there.stateJson, "a process sharing nothing with the writer must agree").toBe(here.stateJson);
    expect(there.stateHash).toBe(here.stateHash);
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
    expect(digestInFreshProcess(logDirOf(root), { cwd: elsewhere }).stateJson).toBe(
      digestInFreshProcess(logDirOf(root), { cwd: tmpdir() }).stateJson,
    );
  });

  it("is independent of timezone", () => {
    // The events carry a UTC designator; if any of them were ever re-parsed
    // through a local-time path, TZ would move the result.
    const root = workspace();
    writeHistory(root);
    expect(digestInFreshProcess(logDirOf(root), { env: { TZ: "Asia/Kolkata" } }).stateJson).toBe(
      digestInFreshProcess(logDirOf(root), { env: { TZ: "UTC" } }).stateJson,
    );
  });

  it("orders contracts by code unit, not by collation", () => {
    // THE locale-independence assertion, stated so it can FAIL.
    //
    // Comparing two children under different LANG settings does NOT establish
    // this: on Windows the OS decides Node's default collation and LANG is
    // ignored, so both children sort identically and the comparison is
    // between two copies of the same thing. (It was measured: the digest
    // stayed identical under a locale-aware sort, because both sides moved
    // together.) That is the F16 class this file exists to catch, wearing a
    // different hat.
    //
    // What IS observable on every platform is the ORDER itself. The contract
    // ids are `WC-I` and `WC-i`, which differ only in case: code units order
    // `WC-I` before `WC-i`, while every collation this runtime can be given
    // (en-GB, de-DE, tr-TR) orders them the other way round. So the canonical
    // bytes carry the answer, and asserting the order asserts the property.
    //
    // The digest is compared across the two locales as well — that part is
    // corroboration, not the proof.
    const root = workspace();
    writeHistory(root);
    const digest = digestInFreshProcess(logDirOf(root));

    const upper = digest.stateJson.indexOf('"contractId":"WC-I"');
    const lower = digest.stateJson.indexOf('"contractId":"WC-i"');
    expect(upper, "both contract ids must be present in the canonical state").toBeGreaterThanOrEqual(0);
    expect(lower, "both contract ids must be present in the canonical state").toBeGreaterThanOrEqual(0);
    expect(
      upper,
      "contracts must be ordered by UTF-16 code unit; a collation-aware sort would put WC-i first",
    ).toBeLessThan(lower);

    // Corroboration: the same bytes under a different declared locale.
    const de = digestInFreshProcess(logDirOf(root), { env: { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8" } });
    const c = digestInFreshProcess(logDirOf(root), { env: { LANG: "C", LC_ALL: "C" } });
    expect(de.stateJson).toBe(c.stateJson);
    expect(de.stateHash).toBe(c.stateHash);
  });

  it("is independent of where the log lives on disk", () => {
    // Copy the whole authoritative history to an unrelated path. Same bytes,
    // different location: state must not encode its own address.
    const origin = workspace();
    const copy = workspace();
    writeHistory(origin);
    cpSync(logDirOf(origin), logDirOf(copy), { recursive: true });
    expect(digestInFreshProcess(logDirOf(copy)).stateJson).toBe(digestInFreshProcess(logDirOf(origin)).stateJson);
  });

  it("is independent of the process that wrote the log", () => {
    // Two workspaces written by two separate writer processes from the same
    // script must yield the same state, so nothing about the writer's identity
    // (pid, host, claim time) leaks out of writer.lock into the history.
    const a = workspace();
    const b = workspace();
    writeHistory(a);
    writeHistory(b);
    expect(digestInFreshProcess(logDirOf(a)).stateJson).toBe(digestInFreshProcess(logDirOf(b)).stateJson);
  });

  /**
   * Step 8 of PROVE_REPLAY_DETERMINISM, executed rather than merely described.
   *
   * Two children whose digest carries a PROCESS-LOCAL value must DISAGREE, and
   * the positive comparison the rest of this file uses must REJECT them. That
   * is the exact shape of the property being claimed — "two independent fresh
   * processes agree" — and it is what proves the harness can fail. Comparing a
   * poisoned reader against a clean one would only show that the poison
   * changed a value; it would never show that the cross-process EQUALITY can
   * be broken.
   *
   * The digest is produced by the KERNEL's own `contentHash` over a payload
   * carrying the process-local value, so the difference is the kernel's
   * hashing talking. If the kernel's hashing ever stopped covering its
   * payload, this test would go red — which is the point of putting the
   * poison there rather than in the reported string.
   *
   * The poison is in the READER's digest, not in the log: the log is byte
   * identical between the two spawns, so any divergence is a property of the
   * reporting process and not of the history.
   */
  it("the harness itself is negative-tested: a leaking reader cannot be equal", () => {
    const root = workspace();
    writeHistory(root);

    const first = digestInPoisonedProcess(logDirOf(root));
    const second = digestInPoisonedProcess(logDirOf(root));

    // The log is untouched between the two reads, so the replay digest — which
    // covers the recovered events and the anomalies — must still match. Only
    // the state hash carries the injected value.
    expect(first.replayDigest, "the log is untouched; only the reader is poisoned").toBe(second.replayDigest);
    expect(first.stateHash, "a process-local value must show up as disagreement").not.toBe(second.stateHash);

    // And the comparison the positive test relies on must actually reject.
    expect(() => expect(first).toEqual(second)).toThrow();

    // The poisoned digest must ALSO differ from the clean kernel's digest —
    // otherwise "the two poisoned readers disagree" could be satisfied by
    // two readers that are both simply wrong. The poison child reports the
    // clean kernel's own hash alongside the poisoned one, so the comparison
    // is against the SAME kernel, not against a second reading.
    const clean = digestInFreshProcess(logDirOf(root));
    expect(first.stateHashClean, "the poisoned reader must also report the clean kernel's hash").toBe(clean.stateHash);
    expect(first.stateHash, "a poisoned reader must not agree with a clean one").not.toBe(clean.stateHash);
  });
});

describe.skipIf(!distBuilt)("damage replays deterministically too", () => {
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
    // a contradiction in the test file rather than in the code.
    ["duplicated event", (r) => writeFileSync(logFileOf(r), `${[...framesOf(r), framesOf(r)[2]!].join("\n")}\n`)],
    ["missing event", (r) => writeFileSync(logFileOf(r), `${framesOf(r).filter((_, i) => i !== 3).join("\n")}\n`)],
    [
      // Same LENGTH as the original on purpose. "EXECUTING" -> "BLOCKED" is
      // two characters shorter, so replay catches it at the length check and
      // never consults the content hash — which is the tamper-detection path
      // this case is named for. "EXECUTION" is the same length as
      // "EXECUTING", so the frame is well-formed and only the hash can
      // reject it.
      "modified payload",
      (r) => writeFileSync(logFileOf(r), readFileSync(logFileOf(r), "utf8").replace('"to":"EXECUTING"', '"to":"EXECUTION"')),
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
    expect(first.stateJson).toBe(local.stateJson);
    expect(first.stateHash).toBe(local.stateHash);

    // And detectably different from an undamaged history.
    //
    // The REPLAY digest is the right thing to compare, not the state hash.
    // TWO of the six mutations leave the folded STATE byte-identical to the
    // clean one, and that is correct kernel behaviour — the damage is
    // REPORTED, not silently applied to the state:
    //
    //   - "duplicated event": the copy is rejected as a broken writer and the
    //     surviving events are unchanged, so the state is identical.
    //   - "corrupted frame header": the seven real frames are all committed
    //     and the junk line is classified INCOMPLETE, so the state is
    //     identical.
    //
    // What differs in both cases is the CLASSIFICATION of the damage, and the
    // replay digest covers exactly that — it spans the recovered events, the
    // anomalies and the gap list. Comparing state hashes here would fail on
    // those two cases for a reason that has nothing to do with determinism.
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
    const before = digestInFreshProcess(logDirOf(root)).stateJson;
    writeFileSync(logFileOf(root), `${[...framesOf(root)].reverse().join("\n")}\n`);
    expect(digestInFreshProcess(logDirOf(root)).stateJson).toBe(before);
  });
});
