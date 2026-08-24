/**
 * Storage-ownership tests.
 *
 * These run inside the kernel package and import ONLY from this package —
 * no agent, no adapter, no AnyPlugin, no installed tooling. That is itself
 * part of what is being asserted: the kernel's suite must be executable in
 * isolation (ROADMAP.md §2, M11 acceptance).
 */
import { describe, expect, it } from "vitest";
import {
  FOREIGN_OWNED_PATHS,
  STORAGE_ROOT_DIRNAME,
  STORAGE_SUBDIRS,
  isForeignOwned,
  isKernelOwned,
} from "./storage.js";
import { RUNTIME_VERSION } from "./index.js";

describe("kernel storage ownership", () => {
  it("claims its own root and everything beneath it", () => {
    expect(isKernelOwned(STORAGE_ROOT_DIRNAME)).toBe(true);
    for (const sub of STORAGE_SUBDIRS) {
      expect(isKernelOwned(`${STORAGE_ROOT_DIRNAME}/${sub}`)).toBe(true);
      expect(isKernelOwned(`${STORAGE_ROOT_DIRNAME}/${sub}/0001.json`)).toBe(true);
    }
  });

  it("does not claim look-alike siblings", () => {
    // A prefix match without the separator would wrongly claim these.
    expect(isKernelOwned(`${STORAGE_ROOT_DIRNAME}-backup`)).toBe(false);
    expect(isKernelOwned(`${STORAGE_ROOT_DIRNAME}x/events`)).toBe(false);
    expect(isKernelOwned("worker-runtime")).toBe(false);
  });

  it("normalizes separators and leading ./ before deciding ownership", () => {
    expect(isKernelOwned(`./${STORAGE_ROOT_DIRNAME}/events`)).toBe(true);
    expect(isKernelOwned(`${STORAGE_ROOT_DIRNAME}\\events\\0001.json`)).toBe(true);
  });

  it("recognises paths owned by other components", () => {
    for (const owned of FOREIGN_OWNED_PATHS) {
      expect(isForeignOwned(owned), owned).toBe(true);
      expect(isForeignOwned(`${owned}/nested/file.json`), owned).toBe(true);
    }
  });

  it("keeps kernel-owned and foreign-owned strictly disjoint", () => {
    // The single-ownership invariant: no path may be claimed by both. If this
    // ever fails, two writers share one store and the invalidation graph can
    // no longer trust its own inputs.
    const probes = [
      STORAGE_ROOT_DIRNAME,
      ...STORAGE_SUBDIRS.map((s) => `${STORAGE_ROOT_DIRNAME}/${s}`),
      ...FOREIGN_OWNED_PATHS,
      ...FOREIGN_OWNED_PATHS.map((p) => `${p}/deep/file.json`),
    ];
    for (const probe of probes) {
      expect(isKernelOwned(probe) && isForeignOwned(probe), `${probe} is claimed by both owners`).toBe(false);
    }
  });

  it("does not name its storage root under AnyPlugin's directory", () => {
    // `.anyplugin/instruction` is a real install destination, so a sibling
    // under `.anyplugin/` would sit one careless TEMPLATES entry away from
    // being reverted or deleted on uninstall.
    expect(STORAGE_ROOT_DIRNAME.startsWith(".anyplugin")).toBe(false);
    expect(isForeignOwned(STORAGE_ROOT_DIRNAME)).toBe(false);
  });

  it("exposes a runtime version without importing anything outside this package", () => {
    expect(RUNTIME_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
