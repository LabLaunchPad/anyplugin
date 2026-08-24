/**
 * F10 measurement harness — the numbers the event-write mechanism was chosen from.
 *
 * This is a script rather than a test on purpose: it MEASURES, it does not
 * assert. `write-contract.test.ts` freezes only what this observed, so no
 * property is ever asserted before it has been seen to hold.
 *
 * Reports per candidate: concurrent multi-process completeness, truncation
 * detection, tamper detection, idempotence, replay determinism, arrival
 * ordering, and append/replay cost at a record size above PIPE_BUF.
 *
 *   pnpm build && node scripts/f10-bench.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIST = new URL("../packages/worker-runtime/dist/log/", import.meta.url);
const { CANDIDATES } = await import(new URL("candidates.js", DIST));
const { PIPE_BUF } = await import(new URL("write-contract.js", DIST));

const WRITERS = 4;
const PER_WRITER = 25;
/** Above PIPE_BUF deliberately: below it, a broken mechanism looks correct. */
const BIG = "x".repeat(PIPE_BUF * 2);

const scratch = [];
function fresh(w) {
  const d = mkdtempSync(join(tmpdir(), "f10-"));
  scratch.push(d);
  w.init(d);
  return d;
}
const rec = (id, pad = "") => ({ id, payload: { n: id, pad } });
const targetOf = (w, dir, id) => (w.id.includes("per-event") ? join(dir, `${id}.event`) : join(dir, "events.log"));

/** Many real processes appending at once. Spawned together, awaited after. */
async function concurrent(w) {
  const dir = fresh(w);
  const child = join(dir, "child.mjs");
  writeFileSync(
    child,
    `import { CANDIDATES } from ${JSON.stringify(new URL("candidates.js", DIST).href)};
const [, , id, dir, idx, count, pad] = process.argv;
const w = CANDIDATES.find((c) => c.id === id);
for (let i = 0; i < Number(count); i += 1) w.append(dir, { id: \`W\${idx}-E\${i}\`, payload: { n: \`W\${idx}-E\${i}\`, pad } });
`,
    "utf8",
  );
  const started = Date.now();
  await Promise.all(
    Array.from({ length: WRITERS }, (_, i) =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, [child, w.id, dir, String(i), String(PER_WRITER), BIG], { stdio: "ignore" });
        p.on("error", reject);
        p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer ${i} exited ${code}`))));
      }),
    ),
  );
  const ms = Date.now() - started;
  const r = w.replay(dir);
  const silentlyWrong = r.committed.filter((c) => c.payload?.n !== c.id || c.payload?.pad !== BIG).length;
  return { committed: r.committed.length, expected: WRITERS * PER_WRITER, anomalies: r.anomalies.length, silentlyWrong, ms };
}

/** The last record is cut off mid-write. */
function truncated(w) {
  const dir = fresh(w);
  for (let i = 0; i < 5; i += 1) w.append(dir, rec(`E-${i}`, BIG));
  const target = targetOf(w, dir, "E-4");
  truncateSync(target, statSync(target).size - 3000);
  const r = w.replay(dir);
  return { detected: r.anomalies.length > 0, survivors: r.committed.length, survivorsDamaged: r.committed.some((c) => c.payload?.pad !== BIG) };
}

/** A byte inside a committed record is changed, leaving it well-formed. */
function tampered(w) {
  const dir = fresh(w);
  for (let i = 0; i < 3; i += 1) w.append(dir, rec(`E-${i}`));
  const target = targetOf(w, dir, "E-1");
  const raw = readFileSync(target, "utf8");
  writeFileSync(target, raw.replace('"n":"E-1"', '"n":"E-9"'), "utf8");
  const r = w.replay(dir);
  return {
    rejected: r.anomalies.some((a) => a.classification === "REJECTED"),
    silentlyAccepted: r.committed.some((c) => c.payload?.n === "E-9"),
  };
}

function duplicate(w) {
  const dir = fresh(w);
  w.append(dir, rec("E-dup"));
  w.append(dir, rec("E-dup"));
  const r = w.replay(dir);
  return { committedCopies: r.committed.filter((c) => c.id === "E-dup").length, refusedAtWrite: r.anomalies.length === 0 };
}

function deterministic(w) {
  const dir = fresh(w);
  for (let i = 0; i < 10; i += 1) w.append(dir, rec(`E-${i}`, i % 2 ? BIG : ""));
  return { identical: JSON.stringify(w.replay(dir)) === JSON.stringify(w.replay(dir)) };
}

function ordering(w) {
  const dir = fresh(w);
  const appended = ["E-3", "E-1", "E-2"];
  for (const id of appended) w.append(dir, rec(id));
  const got = w.replay(dir).committed.map((c) => c.id);
  return { arrivalOrder: got.join(",") === appended.join(","), got: got.join(",") };
}

function cost(w) {
  const dir = fresh(w);
  const N = 300;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) w.append(dir, rec(`E-${i}`, BIG));
  const t1 = process.hrtime.bigint();
  w.replay(dir);
  const t2 = process.hrtime.bigint();
  return { appendUsPerEvent: +(Number(t1 - t0) / 1000 / N).toFixed(1), replayMsFor300: +(Number(t2 - t1) / 1e6).toFixed(1) };
}

const results = [];
for (const w of CANDIDATES) {
  results.push({
    id: w.id,
    mechanism: w.mechanism,
    concurrent: await concurrent(w),
    truncated: truncated(w),
    tampered: tampered(w),
    duplicate: duplicate(w),
    deterministic: deterministic(w),
    ordering: ordering(w),
    cost: cost(w),
  });
}
for (const d of scratch) rmSync(d, { recursive: true, force: true });

console.log(
  JSON.stringify(
    { platform: process.platform, node: process.version, pipeBuf: PIPE_BUF, writers: WRITERS, perWriter: PER_WRITER, recordBytes: BIG.length, results },
    null,
    2,
  ),
);
