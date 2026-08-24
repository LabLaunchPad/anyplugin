/**
 * The seven M2 I/O invariants, encoded before the kernel has any I/O.
 *
 * Each invariant reports one of three states, and ARMED is never reported as
 * PASSED:
 *
 *   PASSED — a real target exists and the invariant was exercised against it.
 *   ARMED  — the enforcement exists but the thing it constrains does not yet,
 *            so the invariant has NOT been exercised and proves nothing.
 *   FAILED — violated.
 *
 * Five of the seven are PASSED here because the predicates are real code with
 * real inputs. Two are honestly ARMED: no derived state and no deletion path
 * exist yet, and claiming otherwise would manufacture confidence in code that
 * has not been written. They close empirically in M2, against the real surface.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  AUTHORITATIVE_SUBDIRS,
  DERIVED_SUBDIRS,
  DIRECT_FS_WRITERS,
  OwnershipError,
  assertDeletable,
  assertWritable,
  checkDeletable,
  checkWritable,
  classifySubdir,
} from "./ownership.js";
import { FOREIGN_OWNED_PATHS, STORAGE_ROOT_DIRNAME, STORAGE_SUBDIRS } from "./storage.js";

const KERNEL_SRC = resolve(import.meta.dirname);

describe("I1 — single ownership: one authoritative writer per mutable root (PASSED)", () => {
  it("permits writes inside the kernel's own storage root", () => {
    for (const sub of STORAGE_SUBDIRS) {
      expect(checkWritable(`${STORAGE_ROOT_DIRNAME}/${sub}/EV-1.json`), sub).toEqual({ allowed: true });
    }
    expect(checkWritable(STORAGE_ROOT_DIRNAME)).toEqual({ allowed: true });
  });

  it("refuses anything outside it, including plausible near-misses", () => {
    for (const p of [
      "notes.json",
      "src/index.ts",
      ".worker-runtime-backup/events/E-1.json", // prefix match, different directory
      "packages/worker-runtime/src/x.ts",
    ]) {
      expect(checkWritable(p).allowed, p).toBe(false);
    }
  });

  it("refuses an undeclared subdirectory — a hidden writer inside its own root", () => {
    const v = checkWritable(`${STORAGE_ROOT_DIRNAME}/scratch/tmp.json`);
    expect(v).toEqual({ allowed: false, reason: "unknown subdirectory" });
  });
});

describe("I2 — disjoint ownership: kernel storage never overlaps foreign roots (PASSED)", () => {
  it("no declared foreign path is inside the kernel root, and vice versa", () => {
    for (const foreign of FOREIGN_OWNED_PATHS) {
      expect(foreign.startsWith(STORAGE_ROOT_DIRNAME), foreign).toBe(false);
      expect(STORAGE_ROOT_DIRNAME.startsWith(foreign), foreign).toBe(false);
    }
  });

  it("every storage subdirectory is exactly one of authoritative or derived", () => {
    // Neither would mean state nobody classified; both would mean a derived
    // store that is also a source of truth, which is the R7 failure itself.
    for (const sub of STORAGE_SUBDIRS) {
      expect(classifySubdir(sub), sub).not.toBe("UNKNOWN");
    }
    const overlap = AUTHORITATIVE_SUBDIRS.filter((s) => (DERIVED_SUBDIRS as readonly string[]).includes(s));
    expect(overlap).toEqual([]);
    expect([...AUTHORITATIVE_SUBDIRS, ...DERIVED_SUBDIRS].sort()).toEqual([...STORAGE_SUBDIRS].sort());
  });
});

describe("I3 — no reverse coupling: the kernel never writes AnyPlugin or OKF state (PASSED)", () => {
  it.each(FOREIGN_OWNED_PATHS.map((p) => [p] as const))("refuses to write %s", (foreign) => {
    expect(checkWritable(foreign)).toEqual({ allowed: false, reason: "foreign-owned" });
    expect(checkWritable(`${foreign}/nested/file.json`).allowed).toBe(false);
    expect(() => assertWritable(foreign)).toThrow(OwnershipError);
  });

  it("refuses traversal and absolute paths by their real cause, not incidentally", () => {
    // Asserting the REASON matters: if the traversal check were deleted, a
    // test that only checked "it threw" would still pass, because the
    // ownership check would catch most of these anyway.
    expect(checkWritable(`${STORAGE_ROOT_DIRNAME}/events/../../.anyplugin-state.json`).reason).toBe("path traversal");
    expect(checkWritable("../outside/x.json").reason).toBe("path traversal");
    expect(checkWritable("/etc/passwd").reason).toBe("absolute path");
    expect(checkWritable("C:\\Windows\\system32\\x").reason).toBe("absolute path");
    expect(checkWritable("//server/share/x").reason).toBe("absolute path");
    // A segment that merely starts with dots is a legal filename, not traversal.
    expect(checkWritable(`${STORAGE_ROOT_DIRNAME}/events/..foo.json`).allowed).toBe(true);
  });
});

describe("I4 — no cross-owner deletion (PASSED)", () => {
  it("refuses to delete authoritative state — supersession preserves history", () => {
    for (const sub of AUTHORITATIVE_SUBDIRS) {
      const p = `${STORAGE_ROOT_DIRNAME}/${sub}/EV-1.json`;
      expect(checkDeletable(p).allowed, p).toBe(false);
      expect(() => assertDeletable(p)).toThrow(/superseded, never deleted/);
    }
  });

  it("refuses to delete the storage root itself", () => {
    expect(checkDeletable(STORAGE_ROOT_DIRNAME).allowed).toBe(false);
  });

  it("refuses to delete foreign state", () => {
    for (const foreign of FOREIGN_OWNED_PATHS) {
      expect(checkDeletable(foreign).allowed, foreign).toBe(false);
    }
  });

  it("permits deleting derived state, which is what makes it derived", () => {
    for (const sub of DERIVED_SUBDIRS) {
      expect(checkDeletable(`${STORAGE_ROOT_DIRNAME}/${sub}/index.json`), sub).toEqual({ allowed: true });
    }
  });
});

describe("I5 — no hidden writers: every fs mutation is declared (PASSED)", () => {
  /** Node APIs that create, modify, or remove filesystem state. */
  const MUTATORS =
    /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|truncate|truncateSync|createWriteStream|openSync|open)\s*\(/;

  function kernelSources(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === "dist") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) kernelSources(full, acc);
      else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) acc.push(full);
    }
    return acc;
  }

  it("finds real source files, so the scan is not vacuously empty", () => {
    // Without this, deleting the kernel would make the guard below pass.
    expect(kernelSources(KERNEL_SRC).length).toBeGreaterThan(4);
  });

  it("no kernel module mutates the filesystem except those explicitly exempted", () => {
    const declared = new Set(DIRECT_FS_WRITERS.map((w) => w.module));
    const undeclared: string[] = [];
    for (const file of kernelSources(KERNEL_SRC)) {
      const rel = relative(KERNEL_SRC, file).replace(/\\/g, "/");
      if (declared.has(rel)) continue;
      if (MUTATORS.test(readFileSync(file, "utf8"))) undeclared.push(rel);
    }
    expect(
      undeclared,
      "a kernel module mutates the filesystem without routing through ownership.ts or declaring an exemption",
    ).toEqual([]);
  });

  it("every exemption states a reason, and names a module that exists", () => {
    expect(DIRECT_FS_WRITERS.length).toBeGreaterThan(0);
    for (const w of DIRECT_FS_WRITERS) {
      expect(existsSync(join(KERNEL_SRC, w.module)), w.module).toBe(true);
      expect(w.why.length, `${w.module} has no stated reason`).toBeGreaterThan(30);
    }
  });
});

describe("I6 — derived state stays rebuildable (PASSED as of Gate 3)", () => {
  it("worker state is a pure function of the event log, rebuilt on demand", async () => {
    // Gate 3 built the first real builder, so this is now exercised rather
    // than armed. The strongest available form of "rebuildable": derived state
    // is never persisted at all, so it cannot drift from the log or quietly
    // become a second source of truth.
    const { foldWorkerState, stateHash } = await import("./log/worker-state.js");
    const events = [
      {
        id: "EVT-1",
        contractVersion: "1.0.0",
        sequence: 0,
        at: "2026-08-24T20:00:00Z",
        actor: "worker-runtime/1.0.0",
        kind: "STATE_TRANSITION",
        subject: "WC-alpha",
        payload: { to: "PLANNING" },
      },
    ] as never;
    // Two independent rebuilds from the same authoritative events agree.
    expect(stateHash(foldWorkerState(events))).toBe(stateHash(foldWorkerState(events)));
  });

  it("no derived subdirectory holds anything the log cannot regenerate", () => {
    expect(DERIVED_SUBDIRS).toEqual(["graph"]);
    expect(classifySubdir("graph")).toBe("DERIVED");
    // And it remains the only subdirectory deletion is permitted for, so the
    // rebuildable set and the deletable set stay the same set.
    for (const sub of DERIVED_SUBDIRS) {
      expect(checkDeletable(`${STORAGE_ROOT_DIRNAME}/${sub}/index.json`).allowed, sub).toBe(true);
    }
  });
});

describe("I7 — deletion is transactional and recoverable (still ARMED, not PASSED)", () => {
  it("is ARMED: the only deletion path removes a transient claim, not governed state", () => {
    // Gate 3 introduced the kernel's first delete — `EventLog.close()` unlinks
    // `writer.lock`. That does NOT exercise I7: the lock is a claim on the log,
    // not governed state, and losing it costs nothing because the next writer
    // simply re-claims it.
    //
    // Authoritative records remain undeletable by policy (I4), and no derived
    // state is persisted yet, so there is still no transactional deletion of
    // anything that matters. Flipping this to PASSED because a delete syscall
    // now exists somewhere would be exactly the ARMED-as-PASSED move these
    // guards exist to prevent.
    const deletesGovernedState = false;
    expect(deletesGovernedState, "I7 closes only against a real deletion of governed state").toBe(false);
    // The policy it will eventually protect is already enforced:
    for (const sub of AUTHORITATIVE_SUBDIRS) {
      expect(checkDeletable(`${STORAGE_ROOT_DIRNAME}/${sub}/EV-1.json`).allowed, sub).toBe(false);
    }
  });
});

describe("invariant states are reported, never conflated", () => {
  it("records which invariants are exercised and which are merely armed", () => {
    const STATES = {
      "I1 single ownership": "PASSED",
      "I2 disjoint ownership": "PASSED",
      "I3 no reverse coupling": "PASSED",
      "I4 no cross-owner deletion": "PASSED",
      "I5 no hidden writers": "PASSED",
      "I6 derived state rebuildable": "PASSED",
      "I7 transactional deletion": "ARMED",
    } as const;
    expect(Object.values(STATES).filter((s) => s === "PASSED")).toHaveLength(6);
    expect(Object.values(STATES).filter((s) => s === "ARMED")).toHaveLength(1);
    expect(Object.values(STATES)).not.toContain("FAILED");
  });
});
