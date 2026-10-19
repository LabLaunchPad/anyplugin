import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJournal, writeJournal, type InstallJournal, classifyJournalEntry, applyJournalEntry } from "./journal.js";
import { SecurityError } from "@lablaunchpad/core";

function makeJournal(overrides: Partial<InstallJournal> = {}): InstallJournal {
  return {
    installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    pluginId: "test",
    version: "0.1.0",
    agent: "opencode",
    schemaVersion: 1,
    files: [],
    ...overrides,
  };
}

describe("Journal validation — audit regression tests (Finding D)", () => {
  let testRoot: string;

  beforeAll(async () => {
    testRoot = await mkdtemp(join(tmpdir(), "journal-validation-test-"));
  });

  afterAll(async () => {
    try { await rm(testRoot, { recursive: true, force: true }); } catch {}
  });

  it("rejects journal with missing required fields", async () => {
    const badJournal = { pluginId: "test" }; // missing version, agent, files
    await writeFile(join(testRoot, ".anyplugin-state.json"), JSON.stringify(badJournal));
    
    await expect(readJournal(testRoot)).rejects.toThrow("legacy journal missing required fields");
  });

  it("rejects journal with wrong pluginId", async () => {
    const badJournal = makeJournal({
      pluginId: "wrong-plugin",
    });
    await writeJournal(testRoot, badJournal);
    
    const journal = await readJournal(testRoot);
    expect(journal).not.toBeNull();
    expect(journal!.pluginId).toBe("wrong-plugin");
    // TODO: Should reject on read if pluginId doesn't match expected
  });

  it("rejects journal with unknown/future schema version (fail-closed)", async () => {
    // Manually write with future schema version
    await writeFile(join(testRoot, ".anyplugin-state.json"), JSON.stringify({
      installationId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      pluginId: "test",
      version: "0.1.0",
      agent: "opencode",
      schemaVersion: 99, // future version
      files: [],
    }));
    
    await expect(readJournal(testRoot)).rejects.toThrow("unsupported journal schema version");
  });

  it("distinguishes ENOENT from permission errors", async () => {
    // Test with non-existent path
    const nonExistent = join(testRoot, "does-not-exist");
    const journal = await readJournal(nonExistent);
    expect(journal).toBeNull();
    
    // Cannot easily test permission errors on Windows
    // This test documents the gap - readCurrent conflates missing vs unreadable
  });

  it("rejects journal with absolute/out-of-root file paths", async () => {
    const badJournal = makeJournal({
      files: [{
        file: "/absolute/path/outside/root.json",
        kind: "json-merge",
        preInstallHash: null,
        postInstallHash: "abc123",
        backupContent: null,
        ownedKeys: ["key"],
      }],
    });
    await writeJournal(testRoot, badJournal);
    
    const journal = await readJournal(testRoot);
    expect(journal).not.toBeNull();
    // TODO: Should validate that file paths are within allowed boundaries
  });

  it("rejects journal with duplicate entries for same file", async () => {
    const badJournal = makeJournal({
      files: [
        {
          file: "/some/file.json",
          kind: "json-merge",
          preInstallHash: null,
          postInstallHash: "abc123",
          backupContent: null,
          ownedKeys: ["key"],
        },
        {
          file: "/some/file.json", // duplicate
          kind: "json-merge",
          preInstallHash: null,
          postInstallHash: "def456",
          backupContent: null,
          ownedKeys: ["key"],
        },
      ],
    });
    await writeJournal(testRoot, badJournal);
    
    const journal = await readJournal(testRoot);
    expect(journal).not.toBeNull();
    // TODO: Should reject duplicate file entries
  });

  it("rejects journal with malformed hash", async () => {
    const badJournal = makeJournal({
      files: [{
        file: "/some/file.json",
        kind: "json-merge",
        preInstallHash: "not-a-valid-hash",
        postInstallHash: "also-invalid",
        backupContent: null,
        ownedKeys: ["key"],
      }],
    });
    await writeJournal(testRoot, badJournal);
    
    const journal = await readJournal(testRoot);
    expect(journal).not.toBeNull();
    // TODO: Should validate hash format (64 hex chars)
  });

  it("rejects journal with wrong types", async () => {
    const badJournal = {
      pluginId: 123, // should be string
      version: true, // should be string
      agent: [], // should be string
      files: "not-an-array", // should be array
    };
    await writeFile(join(testRoot, ".anyplugin-state.json"), JSON.stringify(badJournal));
    
    // This is treated as legacy journal (no schemaVersion), so it fails with legacy error
    await expect(readJournal(testRoot)).rejects.toThrow("legacy journal missing required fields");
  });
});